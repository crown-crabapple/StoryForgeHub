// Link and reference resolution (spec 1.8): front-matter references, body links, citations.
// Emits E103 (body paths), E301, E302, W301, W302, W303, I402.
import path from 'node:path';
import { exists } from './fs.mjs';
import { ID_PREFIX_RE } from './ids.mjs';
import { escapesRoot } from './schema.mjs';

/** @typedef {import('./load.mjs').Doc} Doc */

const ENTRY = ['entry'];
const NAMED = ['entry', 'thread', 'event'];

/**
 * Front-matter reference fields per kind: field, kinds a target may have (null = any), scalar or list.
 * @type {Record<string, {field:string, kinds:string[]|null, list:boolean}[]>}
 */
const REFERENCES = {
  scene: [
    { field: 'pov', kinds: ENTRY, list: false },
    { field: 'characters', kinds: ENTRY, list: true },
    { field: 'locations', kinds: ENTRY, list: true },
    { field: 'plot_threads', kinds: ['thread'], list: true },
    { field: 'events', kinds: ['event'], list: true },
    { field: 'variant_of', kinds: ['scene'], list: false },
  ],
  entry: [{ field: 'first_appearance', kinds: ['scene'], list: false }],
  thread: [
    { field: 'setup', kinds: ['scene'], list: true },
    { field: 'payoff', kinds: ['scene'], list: true },
    { field: 'characters', kinds: ENTRY, list: true },
  ],
  event: [
    { field: 'scenes', kinds: ['scene'], list: true },
    { field: 'characters', kinds: ENTRY, list: true },
    { field: 'locations', kinds: ENTRY, list: true },
  ],
  research: [{ field: 'links', kinds: null, list: true }],
};

const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g;
const CITE_RE = /\[@([^\]\s]+)\](?!\()/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * Yield [lineNumber, text] for body lines outside fenced code, with inline code blanked.
 * @param {string} body
 * @param {number} startLine
 */
export function* proseLines(body, startLine) {
  let fence = null; // { ch, len }
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    yield [startLine + i, line.replace(INLINE_CODE_RE, (s) => ' '.repeat(s.length))];
  }
}

/**
 * @param {Doc[]} docs documents of one book
 * @param {string} bookDir absolute book directory (read-only existence checks)
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export async function resolveLinks(docs, bookDir, add) {
  /** @type {Map<string, Doc>} */
  const byId = new Map();
  /** @type {Map<string, Doc[]>} */
  const bySlug = new Map();
  /** @type {Map<string, Doc[]>} */
  const byPrev = new Map();
  /** @type {Map<string, Doc[]>} */
  const byCite = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  for (const d of docs) {
    if (!d.kind) continue;
    if (typeof d.fm.id === 'string' && !byId.has(d.fm.id)) byId.set(d.fm.id, d);
    if (NAMED.includes(d.kind)) {
      if (typeof d.fm.slug === 'string') push(bySlug, d.fm.slug, d);
      if (Array.isArray(d.fm.previous_slugs)) {
        for (const p of d.fm.previous_slugs) if (typeof p === 'string') push(byPrev, p, d);
      }
    }
    if (d.kind === 'source' && typeof d.fm.cite_key === 'string') push(byCite, d.fm.cite_key, d);
  }

  /** @type {Map<Doc, Set<Doc>>} event -> scenes that reference it or that it references */
  const eventScenes = new Map();
  const link = (event, scene) => {
    if (!eventScenes.has(event)) eventScenes.set(event, new Set());
    eventScenes.get(event).add(scene);
  };

  /** @param {string} target @returns {{doc:Doc, viaPrevious:boolean}|null} */
  function lookup(target) {
    if (ID_PREFIX_RE.test(target)) {
      const d = byId.get(target);
      return d ? { doc: d, viaPrevious: false } : null;
    }
    for (const [map, viaPrevious] of [[bySlug, false], [byPrev, true]]) {
      const live = (map.get(target) ?? []).find((d) => !d.archived);
      if (live) return { doc: live, viaPrevious };
    }
    for (const [map, viaPrevious] of [[bySlug, false], [byPrev, true]]) {
      const any = (map.get(target) ?? [])[0];
      if (any) return { doc: any, viaPrevious };
    }
    return null;
  }

  /**
   * @param {Doc} src @param {string} location @param {string} raw
   * @param {string[]|null} kinds allowed target kinds
   * @returns {Doc|null} resolved target, if any
   */
  function resolveTarget(src, location, raw, kinds) {
    const target = raw.trim();
    if (target === '') return null;
    if (target.includes(':')) {
      add('I402', src.file, location, `cross-book link not checked: ${target}`);
      return null;
    }
    const hit = lookup(target);
    if (!hit) {
      add('E301', src.file, location, `cannot resolve ${target}`);
      return null;
    }
    if (hit.viaPrevious) add('W301', src.file, location, `${target} resolved only via previous_slugs`);
    if (hit.doc.archived) add('W303', src.file, location, `${target} points into archive/`);
    if (kinds && !kinds.includes(hit.doc.kind)) {
      add('E302', src.file, location, `${target} is a ${hit.doc.kind}, expected ${kinds.join(' or ')}`);
      return hit.doc;
    }
    return hit.doc;
  }

  /** @param {Doc} src @param {string} location @param {string} key */
  function resolveCite(src, location, key) {
    const list = byCite.get(key);
    if (!list) {
      add('E301', src.file, location, `cannot resolve citation ${key}`);
      return;
    }
    if (!list.some((d) => !d.archived)) add('W303', src.file, location, `citation ${key} points into archive/`);
  }

  for (const d of docs) {
    if (!d.kind) continue; // plain notes are never scanned
    const { fm } = d;

    for (const ref of REFERENCES[d.kind] ?? []) {
      const value = fm[ref.field];
      const items = ref.list ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
      items.forEach((item, i) => {
        if (typeof item !== 'string') return;
        const location = ref.list ? `${ref.field}[${i}]` : ref.field;
        const target = resolveTarget(d, location, item, ref.kinds);
        if (!target) return;
        if (d.kind === 'scene' && ref.field === 'events' && target.kind === 'event') link(target, d);
        if (d.kind === 'event' && ref.field === 'scenes' && target.kind === 'scene') link(d, target);
      });
    }
    if (d.kind === 'entry' && Array.isArray(fm.related)) {
      fm.related.forEach((r, i) => {
        if (r && typeof r === 'object' && typeof r.to === 'string') resolveTarget(d, `related[${i}].to`, r.to, NAMED);
      });
    }
    if (d.kind === 'research' && Array.isArray(fm.sources)) {
      fm.sources.forEach((s, i) => {
        if (typeof s === 'string') resolveCite(d, `sources[${i}]`, s);
      });
    }
    if (d.kind === 'thread' && fm.status === 'paid' && !(Array.isArray(fm.payoff) && fm.payoff.length > 0)) {
      add('W302', d.file, 'payoff', 'thread is paid but has no payoff');
    }
    if (d.kind === 'entry' && fm.fields && typeof fm.fields === 'object' && !Array.isArray(fm.fields)) {
      for (const [label, value] of Object.entries(fm.fields)) {
        if (typeof value !== 'string') continue;
        for (const m of value.matchAll(WIKI_RE)) resolveTarget(d, `fields.${label}`, m[1].split('|')[0], null);
      }
    }

    // body links
    for (const [lineNo, text] of proseLines(d.body, d.bodyStartLine)) {
      const location = `line ${lineNo}`;
      for (const m of text.matchAll(WIKI_RE)) resolveTarget(d, location, m[1].split('|')[0], null);
      for (const m of text.matchAll(CITE_RE)) resolveCite(d, location, m[1]);
      for (const m of text.matchAll(MDLINK_RE)) await checkFileLink(d, location, m[3]);
    }
  }

  /** @param {Doc} src @param {string} location @param {string} rawTarget */
  async function checkFileLink(src, location, rawTarget) {
    let t = rawTarget.trim();
    if (t.startsWith('<')) {
      const end = t.indexOf('>');
      t = end > 0 ? t.slice(1, end) : t.slice(1);
    } else {
      t = t.split(/\s+/)[0];
    }
    if (t === '' || t.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return;
    t = t.split('#')[0].split('?')[0];
    if (t === '') return;
    try {
      t = decodeURIComponent(t);
    } catch {
      // keep the raw text
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(src.rel), t));
    if (t.startsWith('/') || escapesRoot(path.posix.join(path.posix.dirname(src.rel), t))) {
      add('E103', src.file, location, `path escapes the book root: ${t}`);
      return;
    }
    if (resolved.startsWith('.storyforge/') || resolved === '.storyforge') return;
    if (!(await exists(path.join(bookDir, ...resolved.split('/'))))) {
      add('E301', src.file, location, `file not found: ${t}`);
    } else if (resolved.startsWith('archive/')) {
      add('W303', src.file, location, `link points into archive/: ${t}`);
    }
  }

  return { eventScenes };
}
