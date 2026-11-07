// The canonical view of one book: what the format validator read, narrowed to the inputs the rules may use,
// plus exact source locations. Nothing here writes, and `.storyforge/` is never read (the format package skips it).
import path from 'node:path';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';
import { extractDocs, extractLinks, readText, validate } from '@storyforge/format';

/** @typedef {import('@storyforge/format').Doc} Doc */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const UNREADABLE = new Set(['E006', 'E100', 'E101']);

/** @param {string} s */
const clip = (s) => (s.length <= 160 ? s : `${s.slice(0, 159)}…`);

/**
 * @typedef {{ role: 'canon'|'text'|'event'|'thread'|'note'|'plan', kind: 'entry'|'scene'|'event'|'thread'|'research'|'structure'|'clue', id: string,
 *   file: string, heading: string, location: string, line: number, range: {from:number,to:number}|null, excerpt: string }} Source
 */

/**
 * @param {string} bookRoot
 */
export async function loadModel(bookRoot) {
  const root = path.resolve(bookRoot);
  const result = await validate(root);
  const book = result.books.find((b) => b.path === '') ?? null;
  /** @type {Doc[]} */
  const docs = book ? extractDocs(result, '') : [];
  const links = book ? extractLinks(result, '') : [];

  const skipped = [
    ...new Set(
      result.diagnostics
        .filter((d) => UNREADABLE.has(d.code) || (d.code === 'E102' && d.location === 'schema'))
        .map((d) => d.file),
    ),
  ].sort(cmp);

  /** @type {Map<string, Doc>} */
  const byId = new Map();
  for (const d of docs) if (typeof d.fm.id === 'string' && !byId.has(d.fm.id)) byId.set(d.fm.id, d);
  const live = docs.filter((d) => !d.archived);

  /** @type {Map<string, any>} */
  const linkIndex = new Map();
  for (const l of links) if (l.src_id) linkIndex.set(`${l.src_id}\0${l.location}`, l);

  /** @param {Doc} src @param {string} location @returns {Doc|null} */
  const ref = (src, location) => {
    const l = linkIndex.get(`${src.fm.id}\0${location}`);
    if (!l || !l.target_id || (l.resolution !== 'ok' && l.resolution !== 'previous_slug')) return null;
    const d = byId.get(l.target_id);
    return d && !d.archived ? d : null;
  };
  /** Resolved targets of a list field, with the item index. @param {Doc} src @param {string} field @returns {{doc: Doc, index: number}[]} */
  const refs = (src, field) => {
    const v = src.fm[field];
    if (!Array.isArray(v)) return [];
    /** @type {{doc: Doc, index: number}[]} */
    const out = [];
    v.forEach((_, i) => {
      const d = ref(src, `${field}[${i}]`);
      if (d) out.push({ doc: d, index: i });
    });
    return out;
  };

  // scenes in section 4.2 order, canonical only (the validator leaves variants, archived and misplaced scenes out of `order`)
  const byFile = new Map(live.map((d) => [d.file, d]));
  /** @type {{doc: Doc, position: number}[]} */
  const scenes = [];
  for (const s of book?.order ?? []) {
    const d = byFile.get(s.path);
    if (d && d.kind === 'scene') scenes.push({ doc: d, position: s.position });
  }
  /** @type {Map<Doc, number>} */
  const positionOf = new Map(scenes.map((s) => [s.doc, s.position]));

  const events = live
    .filter((d) => d.kind === 'event' && typeof d.fm.id === 'string' && typeof d.fm.order === 'number' && Number.isFinite(d.fm.order))
    .sort((a, b) => a.fm.order - b.fm.order || cmp(a.fm.id, b.fm.id));

  /** @type {Map<Doc, {doc: Doc, position: number}[]>} an event's scenes: its `scenes` list plus the scenes that name it */
  const eventScenes = new Map(events.map((e) => [e, []]));
  for (const s of scenes) {
    for (const { doc: e } of refs(s.doc, 'events')) eventScenes.get(e)?.push(s);
  }
  for (const e of events) {
    const mine = eventScenes.get(e);
    for (const { doc: sd } of refs(e, 'scenes')) {
      const s = scenes.find((x) => x.doc === sd);
      if (s && !mine.includes(s)) mine.push(s);
    }
    mine.sort((a, b) => a.position - b.position);
  }

  /** @type {Map<string, Promise<any>>} */
  const parsedFiles = new Map();
  /** Front matter with source positions, parsed again here only to find lines and columns. @param {Doc} d */
  const frontMatter = (d) => {
    if (!parsedFiles.has(d.file)) {
      parsedFiles.set(d.file, (async () => {
        const text = (await readText(path.join(root, ...d.rel.split('/')))).replace(/^\uFEFF/u, '');
        const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
        let close = lines.findIndex((l, i) => i > 0 && l === '---');
        if (lines[0] !== '---' || close < 0) close = 0;
        const lc = new LineCounter();
        const doc = parseDocument(lines.slice(1, close).join('\n'), { version: '1.2', schema: 'core', lineCounter: lc });
        return { lines, lc, doc };
      })());
    }
    return parsedFiles.get(d.file);
  };

  /**
   * Where a front-matter value sits: the 1-based file line, the column range of the `key: value` pair (or the list
   * item) on that line, and that text.
   * @param {Doc} d @param {(string|number)[]} yamlPath
   * @returns {Promise<{line:number, range:{from:number,to:number}|null, excerpt:string}>}
   */
  async function frontMatterAt(d, yamlPath) {
    const { lines, lc, doc } = await frontMatter(d);
    let start = null;
    let end = null;
    const parent = yamlPath.length > 1 ? doc.getIn(yamlPath.slice(0, -1), true) : doc.contents;
    const last = yamlPath[yamlPath.length - 1];
    if (isMap(parent) && typeof last === 'string') {
      const pair = parent.items.find((p) => isScalar(p.key) && String(p.key.value) === last);
      if (pair?.key?.range) {
        start = pair.key.range[0];
        end = pair.value?.range ? pair.value.range[1] : pair.key.range[1];
      }
    } else {
      const node = doc.getIn(yamlPath, true);
      if (node?.range) [start, end] = [node.range[0], node.range[1]];
    }
    if (start === null) return { line: 1, range: null, excerpt: clip((lines[0] ?? '').trim()) };
    const p = lc.linePos(start);
    const fileLine = p.line + 1;
    const text = lines[fileLine - 1] ?? '';
    const from = p.col - 1;
    let to = text.length;
    if (end !== null) {
      const q = lc.linePos(end);
      if (q.line === p.line) to = q.col - 1;
    }
    to = Math.max(from, Math.min(to, text.replace(/\s+$/, '').length));
    return { line: fileLine, range: { from, to }, excerpt: clip(text.slice(from, to).trim() || text.trim()) };
  }

  /** @param {Doc} d @returns {string} the name a person would use for the file */
  const headingOf = (d) => String(d.fm.name ?? d.fm.title ?? d.fm.slug ?? d.rel);

  /**
   * A source that points into a document's front matter.
   * @param {Doc} d @param {Source['role']} role @param {Source['kind']} kind @param {string} location validator-style location
   * @param {(string|number)[]} yamlPath
   * @returns {Promise<Source>}
   */
  async function fmSource(d, role, kind, location, yamlPath) {
    const at = await frontMatterAt(d, yamlPath);
    return { role, kind, id: d.fm.id, file: d.file, heading: headingOf(d), location, line: at.line, range: at.range, excerpt: at.excerpt };
  }

  /**
   * A source that points at a line of a document's body. `from`/`to` are 0-based columns on that line.
   * @param {Doc} d @param {Source['role']} role @param {Source['kind']} kind @param {number} line 1-based file line
   * @param {number} from @param {number} to @param {string} excerpt
   * @returns {Source}
   */
  function bodySource(d, role, kind, line, from, to, excerpt) {
    let heading = headingOf(d);
    if (kind !== 'scene') {
      const lines = d.body.split('\n');
      for (let i = Math.min(line - d.bodyStartLine, lines.length - 1); i >= 0; i--) {
        const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
        if (m) {
          heading = `${heading} › ${m[1]}`;
          break;
        }
      }
    }
    return { role, kind, id: d.fm.id, file: d.file, heading, location: `line ${line}`, line, range: { from, to }, excerpt: clip(excerpt) };
  }

  return {
    root, skipped, docs: live, scenes, positionOf, events, eventScenes, ref, refs, frontMatterAt, fmSource, bodySource,
    entries: live.filter((d) => d.kind === 'entry' && typeof d.fm.id === 'string'),
    threads: live.filter((d) => d.kind === 'thread' && typeof d.fm.id === 'string'),
    links: live.filter((d) => d.kind === 'link'),
    structures: live.filter((d) => d.kind === 'structure' && typeof d.fm.id === 'string'),
    clues: live.filter((d) => d.kind === 'clue' && typeof d.fm.id === 'string'),
    research: live.filter((d) => d.kind === 'research' && d.fm.canon === true && typeof d.fm.id === 'string'),
    exceptions: live.filter((d) => d.kind === 'continuity-exception' && typeof d.fm.fingerprint === 'string').sort((a, b) => cmp(a.file, b.file)),
    codexTypes: live.filter((d) => d.kind === 'codex-type'),
  };
}

/** @typedef {Awaited<ReturnType<typeof loadModel>>} Model */
