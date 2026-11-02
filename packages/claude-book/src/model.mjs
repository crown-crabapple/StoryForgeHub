// A read-only view of one StoryForge v2 book, narrowed to what the context pack needs. Built on the
// format package's validator output (documents + section 4.2 scene order). Never writes.
import path from 'node:path';
import { validate, extractDocs, ID_PREFIX_RE } from '@storyforge/format';
import { UsageError, isFileSync, mtimeIso } from './io.mjs';

/** @typedef {import('@storyforge/format').Doc} Doc */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Remove HTML comments (also multi-line) and collapse the blank lines they leave. @param {string} text */
export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** @param {string} bookRoot @returns {Promise<ReturnType<typeof makeModel>>} */
export async function loadModel(bookRoot) {
  const root = path.resolve(bookRoot);
  if (!isFileSync(path.join(root, 'book.md'))) throw new UsageError(`not a book folder (no book.md): ${bookRoot}`);
  const result = await validate(root);
  const book = result.books.find((b) => b.path === '');
  if (!book) throw new UsageError(`cannot read the book at ${bookRoot}`);
  return makeModel(root, book, extractDocs(result, ''));
}

/**
 * @param {string} root
 * @param {{order: {position:number, id:string, chapter:number, path:string}[]}} book
 * @param {Doc[]} allDocs
 */
function makeModel(root, book, allDocs) {
  const live = allDocs.filter((d) => !d.archived);
  const bookDoc = allDocs.find((d) => d.rel === 'book.md' && d.kind === 'book');
  if (!bookDoc) throw new UsageError('book.md could not be read (see sf-validate)');

  /** @type {Map<string, Doc>} */
  const byId = new Map();
  for (const d of live) if (typeof d.fm.id === 'string' && !byId.has(d.fm.id)) byId.set(d.fm.id, d);

  /** @type {Map<string, Doc>} `${kind}:${slug}` */
  const bySlug = new Map();
  /** @type {Map<string, Doc>} */
  const byPrev = new Map();
  for (const d of live) {
    if (!['entry', 'thread', 'event'].includes(d.kind) || typeof d.fm.slug !== 'string') continue;
    if (!bySlug.has(`${d.kind}:${d.fm.slug}`)) bySlug.set(`${d.kind}:${d.fm.slug}`, d);
    for (const p of Array.isArray(d.fm.previous_slugs) ? d.fm.previous_slugs : []) {
      if (typeof p === 'string' && !byPrev.has(`${d.kind}:${p}`)) byPrev.set(`${d.kind}:${p}`, d);
    }
  }

  /**
   * Resolve a slug or id to a live document. `kinds` is tried in order.
   * @param {unknown} target @param {string[]} kinds @returns {Doc|null}
   */
  function find(target, kinds) {
    if (typeof target !== 'string') return null;
    const t = target.trim();
    if (t === '') return null;
    if (ID_PREFIX_RE.test(t)) {
      const d = byId.get(t);
      return d && kinds.includes(d.kind) ? d : null;
    }
    for (const map of [bySlug, byPrev]) for (const k of kinds) if (map.has(`${k}:${t}`)) return map.get(`${k}:${t}`);
    return null;
  }

  // scenes in book order (canonical only)
  const byFile = new Map(live.map((d) => [d.file, d]));
  /** @type {{doc: Doc, position: number, chapter: number}[]} */
  const scenes = [];
  for (const s of book.order) {
    const d = byFile.get(s.path);
    if (d && d.kind === 'scene') scenes.push({ doc: d, position: s.position, chapter: s.chapter });
  }
  const sceneOf = new Map(scenes.map((s) => [s.doc, s]));

  const entries = live.filter((d) => d.kind === 'entry' && typeof d.fm.slug === 'string');
  const threads = live.filter((d) => d.kind === 'thread' && typeof d.fm.slug === 'string');
  const events = live
    .filter((d) => d.kind === 'event' && typeof d.fm.slug === 'string' && typeof d.fm.order === 'number' && Number.isFinite(d.fm.order))
    .sort((a, b) => a.fm.order - b.fm.order || cmp(String(a.fm.id), String(b.fm.id)));

  /** Scenes of an event: its `scenes` list plus the scenes whose `events` names it. @param {Doc} e */
  function eventScenes(e) {
    const out = new Set();
    for (const id of Array.isArray(e.fm.scenes) ? e.fm.scenes : []) {
      const d = find(id, ['scene']);
      if (d && sceneOf.has(d)) out.add(sceneOf.get(d));
    }
    for (const s of scenes) {
      const evs = Array.isArray(s.doc.fm.events) ? s.doc.fm.events : [];
      if (evs.some((x) => find(x, ['event']) === e)) out.add(s);
    }
    return [...out].sort((a, b) => a.position - b.position);
  }

  /** The chapter of an event's lowest-position scene, or null when it is unplaced. @param {Doc} e */
  const narrativeChapter = (e) => eventScenes(e)[0]?.chapter ?? null;

  /** Slug or id -> display name for entries, threads and events. @param {string} target */
  function nameOf(target) {
    const d = find(target, ['entry', 'thread', 'event']);
    return d ? String(d.fm.name ?? d.fm.title ?? d.fm.slug) : null;
  }

  /**
   * Prose for a reader: comments stripped, [[slug|label]] and [[slug]] become the label or the name, and
   * [text](target) becomes text.
   * @param {string} body
   */
  function prose(body) {
    return stripComments(body)
      .replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner) => {
        const bar = inner.indexOf('|');
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim().replace(/#.*$/, '');
        const label = bar < 0 ? '' : inner.slice(bar + 1).trim();
        return label || nameOf(target) || target;
      })
      .replace(/(?<!!)\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_m, text) => text);
  }

  const mtimeOf = (d) => mtimeIso(path.join(root, ...d.rel.split('/')));

  return {
    root, bookDoc, docs: allDocs, live, scenes, sceneOf, entries, threads, events, find, eventScenes, narrativeChapter, nameOf, prose, mtimeOf,
    /** @param {number} n scenes of chapter n, in order */
    chapterScenes: (n) => scenes.filter((s) => s.chapter === n),
  };
}

/** @typedef {Awaited<ReturnType<typeof loadModel>>} Model */
