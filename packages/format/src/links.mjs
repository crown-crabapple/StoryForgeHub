// Link and reference resolution (spec 1.8): front-matter references, body links, citations.
// Emits E103 (body paths), E301, E302, E303, W301, W302, W303, W305, I402, and records every explicit reference
// as a link record (see extractLinks in index.mjs), so nothing else has to resolve links again.
import path from 'node:path';
import { exists, mapLimit, getReadConcurrency } from './fs.mjs';
import { ID_PREFIX_RE } from './ids.mjs';
import { escapesRoot } from './schema.mjs';

/** @typedef {import('./load.mjs').Doc} Doc */

export const ENTRY = ['entry'];
export const NAMED = ['entry', 'thread', 'event'];

/**
 * Front-matter reference fields per kind: field, kinds a target may have (null = any), scalar or list.
 * @type {Record<string, {field:string, kinds:string[]|null, list:boolean}[]>}
 */
export const REFERENCES = {
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
    { field: 'develop', kinds: ['scene'], list: true },
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

/** Event `state` links (spec 6.2): which entry `type` each slug / value must have, per `event` word. */
const STATE_TYPES = {
  died: { slug: ['character'] }, revived: { slug: ['character'] },
  destroyed: { slug: null }, lost: { slug: null }, found: { slug: null },
  holder: { slug: ['object'], value: ['character'] },
  location: { slug: ['character', 'object'], value: ['location'] },
  learns: { slug: ['character'] }, knows: { slug: ['character'] },
};

export const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g;
export const CITE_RE = /\[@([^\]\s]+)\](?!\()/g;
export const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
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
 * One explicit reference and what it resolved to. `resolution`: ok, previous_slug, archived, wrong_kind,
 * broken, cross_book (a cross-book link the validation root cannot see, I402). `src_path` is relative to the
 * book root (to the validated root for a shared entry). A cross-book link that resolved also carries
 * `target_owner` ({ kind, id, slug, title, path } of the book or series that owns the target, path relative
 * to the validated root), `target_title` and `target_file` (the target's file, relative to the validated root).
 * @typedef {{ src_id: string|null, src_path: string, location: string, raw: string,
 *             target_id: string|null, target_kind: string|null, resolution: string,
 *             target_owner?: { kind: 'book'|'series', id: string|null, slug: string, title: string|null, path: string },
 *             target_title?: string|null, target_file?: string }} LinkRecord
 */

/**
 * The lookup tables of one set of documents (a book's own, or a series' shared entries).
 * @typedef {{ byId: Map<string, Doc>, bySlug: Map<string, Doc[]>, byPrev: Map<string, Doc[]> }} Namespace
 */

/** @param {Doc[]} docs @param {{ entriesOnly?: boolean }} [opts] @returns {Namespace} */
export function makeNamespace(docs, { entriesOnly = false } = {}) {
  /** @type {Namespace} */
  const ns = { byId: new Map(), bySlug: new Map(), byPrev: new Map() };
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  for (const d of docs) {
    if (!d.kind) continue;
    if (typeof d.fm.id === 'string' && !ns.byId.has(d.fm.id)) ns.byId.set(d.fm.id, d);
    if (entriesOnly ? d.kind === 'entry' : NAMED.includes(d.kind)) {
      if (typeof d.fm.slug === 'string') push(ns.bySlug, d.fm.slug, d);
      if (Array.isArray(d.fm.previous_slugs)) for (const p of d.fm.previous_slugs) if (typeof p === 'string') push(ns.byPrev, p, d);
    }
  }
  return ns;
}

/**
 * Resolution steps 1 to 4 (spec 1.8) over layered namespaces: the book's own first, the series' shared entries
 * after it (step 3a). A live match in any layer beats an archived one.
 * @param {Namespace[]} layers @param {string} target @param {Map<string, Doc>|null} [libIds] library-wide IDs (for shared entries)
 * @returns {{doc: Doc, viaPrevious: boolean}|null}
 */
export function findTarget(layers, target, libIds = null) {
  if (ID_PREFIX_RE.test(target)) {
    for (const ns of layers) {
      const d = ns.byId.get(target);
      if (d) return { doc: d, viaPrevious: false };
    }
    const d = libIds?.get(target);
    return d ? { doc: d, viaPrevious: false } : null;
  }
  for (const wantLive of [true, false]) {
    for (const ns of layers) {
      for (const [map, viaPrevious] of [[ns.bySlug, false], [ns.byPrev, true]]) {
        const list = map.get(target) ?? [];
        const hit = wantLive ? list.find((d) => !d.archived) : list[0];
        if (hit) return { doc: hit, viaPrevious };
      }
    }
  }
  return null;
}

/**
 * What a validation can see of other books, for cross-book links (spec 2). `complete` is true only when the root is
 * a library: an unknown prefix is then E303, otherwise I402. `layers` are [own, shared]; `series` is the owner
 * of the shared layer.
 * @typedef {{ kind: 'book'|'series', slug: string, id: string|null, title: string|null, path: string, layers: Namespace[],
 *             series: { kind: 'series', slug: string, id: string|null, title: string|null, path: string }|null }} CrossTarget
 * @typedef {{ complete: boolean, books: Map<string, CrossTarget>, series: Map<string, CrossTarget> }} CrossWorld
 */

/**
 * How a set of documents sees the world.
 * @typedef {{ shared?: Namespace|null, sharedMode?: boolean, libIds?: Map<string, Doc>|null, cross?: CrossWorld|null }} ResolveContext
 */

const idOf = (doc) => (typeof doc.fm.id === 'string' ? doc.fm.id : null);

/**
 * @param {Doc[]} docs documents of one book
 * @param {string} bookDir absolute book directory (read-only existence checks)
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @returns {Promise<{eventScenes: Map<Doc, Set<Doc>>, links: LinkRecord[]}>}
 */
export async function resolveLinks(docs, bookDir, add, context = {}) {
  const { shared = null, sharedMode = false, libIds = null, cross = null } = context;
  const local = makeNamespace(docs, { entriesOnly: sharedMode });
  const layers = shared ? [local, shared] : [local];
  /** @type {Map<string, Doc[]>} */
  const byCite = new Map();
  /** @type {Map<string, Doc>} */
  const byRel = new Map();
  /** @type {LinkRecord[]} */
  const links = [];
  const record = (src, location, raw, targetId, targetKind, resolution) =>
    links.push({ src_id: idOf(src), src_path: sharedMode ? src.file : src.rel, location, raw, target_id: targetId, target_kind: targetKind, resolution });
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  // Look up every linked file's presence concurrently up front; checkFileLink then reads the answers (same results, same order).
  /** @type {Map<string, boolean>} */
  const present = new Map();
  {
    /** @type {Set<string>} */
    const wanted = new Set();
    for (const d of docs) {
      for (const [, text] of proseLines(d.body, d.bodyStartLine)) {
        for (const m of text.matchAll(MDLINK_RE)) {
          const r = fileLinkStat(d, m[3]);
          if (r) wanted.add(r.resolved);
        }
      }
    }
    const list = [...wanted];
    const found = await mapLimit(list, getReadConcurrency(), (rel) => exists(path.join(bookDir, ...rel.split('/'))));
    list.forEach((rel, i) => present.set(rel, found[i]));
  }

  for (const d of docs) {
    if (!d.kind) continue;
    byRel.set(d.rel, d);
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
    return findTarget(layers, target, sharedMode ? libIds : null);
  }

  /**
   * `[[<book-or-series-slug>:<target>]]` (spec 2). Bodies and entry fields only.
   * @param {Doc} src @param {string} location @param {string} target
   * @returns {Doc|null}
   */
  function resolveCross(src, location, target) {
    const at = target.indexOf(':');
    const prefix = target.slice(0, at).trim();
    const rest = target.slice(at + 1).trim();
    const other = cross ? (cross.books.get(prefix) ?? cross.series.get(prefix)) : null;
    if (!cross || (!other && !cross.complete)) {
      add('I402', src.file, location, `cross-book link not checked: ${target}`);
      record(src, location, target, null, null, 'cross_book');
      return null;
    }
    const hit = other && rest !== '' ? findTarget(other.layers, rest, null) : null;
    if (!other || !hit) {
      add('E303', src.file, location, other ? `cross-book link target not found: ${target}` : `cross-book link target not found: no book or series named ${prefix}`);
      record(src, location, target, null, null, 'broken');
      return null;
    }
    if (hit.viaPrevious) add('W301', src.file, location, `${target} resolved only via previous_slugs`);
    if (hit.doc.archived) add('W303', src.file, location, `${target} points into archive/`);
    const id = idOf(hit.doc);
    const owner = other.layers[0].byId.get(id ?? '') === hit.doc ? other : (other.series ?? other);
    links.push({
      src_id: idOf(src), src_path: sharedMode ? src.file : src.rel, location, raw: target, target_id: id, target_kind: hit.doc.kind,
      resolution: hit.doc.archived ? 'archived' : hit.viaPrevious ? 'previous_slug' : 'ok',
      target_owner: { kind: owner.kind, id: owner.id, slug: owner.slug, title: owner.title, path: owner.path },
      target_title: typeof hit.doc.fm.title === 'string' ? hit.doc.fm.title : typeof hit.doc.fm.name === 'string' ? hit.doc.fm.name : null,
      target_file: hit.doc.file,
    });
    return hit.doc;
  }

  /**
   * @param {Doc} src @param {string} location @param {string} raw
   * @param {string[]|null} kinds allowed target kinds
   * @param {boolean} [allowCross] true for body links and entry `fields` values
   * @returns {Doc|null} resolved target, if any
   */
  function resolveTarget(src, location, raw, kinds, allowCross = false) {
    const target = raw.trim();
    if (target === '') return null;
    if (target.includes(':')) {
      if (allowCross) return resolveCross(src, location, target);
      add('E302', src.file, location, `cross-book links are only allowed in bodies and entry fields, not in references: ${target}`);
      record(src, location, target, null, null, 'wrong_kind');
      return null;
    }
    const hit = lookup(target);
    if (!hit) {
      add('E301', src.file, location, `cannot resolve ${target}`);
      record(src, location, target, null, null, 'broken');
      return null;
    }
    if (hit.viaPrevious) add('W301', src.file, location, `${target} resolved only via previous_slugs`);
    if (hit.doc.archived) add('W303', src.file, location, `${target} points into archive/`);
    const wrongKind = kinds && !kinds.includes(hit.doc.kind);
    if (wrongKind) add('E302', src.file, location, `${target} is a ${hit.doc.kind}, expected ${kinds.join(' or ')}`);
    const resolution = wrongKind ? 'wrong_kind' : hit.doc.archived ? 'archived' : hit.viaPrevious ? 'previous_slug' : 'ok';
    record(src, location, target, idOf(hit.doc), hit.doc.kind, resolution);
    return hit.doc;
  }

  /** @param {Doc} src @param {string} location @param {string} key */
  function resolveCite(src, location, key) {
    const list = byCite.get(key);
    if (!list) {
      add('E301', src.file, location, `cannot resolve citation ${key}`);
      record(src, location, key, null, null, 'broken');
      return;
    }
    const live = list.find((d) => !d.archived);
    if (!live) add('W303', src.file, location, `citation ${key} points into archive/`);
    record(src, location, key, idOf(live ?? list[0]), 'source', live ? 'ok' : 'archived');
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
    if (d.kind === 'event' && Array.isArray(fm.state)) {
      fm.state.forEach((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const types = Object.hasOwn(STATE_TYPES, item.event) ? STATE_TYPES[item.event] : null;
        /** @param {string} part @param {any} raw @param {string[]|null|undefined} allowed */
        const check = (part, raw, allowed) => {
          if (typeof raw !== 'string' || raw === '') return;
          const location = `state[${i}].${part}`;
          const target = resolveTarget(d, location, raw, ENTRY);
          if (target && target.kind === 'entry' && allowed && !allowed.includes(target.fm.type)) {
            add('E302', d.file, location, `${raw} is a ${target.fm.type}, expected ${allowed.join(' or ')}`);
          }
        };
        check('slug', item.slug, types?.slug);
        if (types?.value) check('value', item.value, types.value);
      });
    }
    if (d.kind === 'entry' && Array.isArray(fm.related)) {
      fm.related.forEach((r, i) => {
        if (!r || typeof r !== 'object' || typeof r.to !== 'string') return;
        const target = resolveTarget(d, `related[${i}].to`, r.to, NAMED);
        if (target === d) add('W305', d.file, `related[${i}].to`, 'related points at the entry itself');
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
    if (d.kind === 'thread' && fm.status === 'planted' && !(Array.isArray(fm.setup) && fm.setup.length > 0)) {
      add('W306', d.file, 'status', 'thread is planted but has no setup scenes');
    }
    if (d.kind === 'thread' && fm.status === 'developed' && !(Array.isArray(fm.develop) && fm.develop.length > 0)) {
      add('W306', d.file, 'status', 'thread is developed but has no develop scenes');
    }
    if (d.kind === 'entry' && fm.fields && typeof fm.fields === 'object' && !Array.isArray(fm.fields)) {
      for (const [label, value] of Object.entries(fm.fields)) {
        if (typeof value !== 'string') continue;
        for (const m of value.matchAll(WIKI_RE)) resolveTarget(d, `fields.${label}`, m[1].split('|')[0], null, true);
      }
    }

    // body links
    for (const [lineNo, text] of proseLines(d.body, d.bodyStartLine)) {
      const location = `line ${lineNo}`;
      for (const m of text.matchAll(WIKI_RE)) resolveTarget(d, location, m[1].split('|')[0], null, true);
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
    // an absolute local path (a drive letter, a UNC path, file://) can never work on another machine (M04-J04)
    if (/^[A-Za-z]:([\\/]|$)/.test(t) || /^file:/i.test(t) || t.startsWith('\\\\')) {
      add('E103', src.file, location, `absolute local path: ${t}`);
      record(src, location, rawTarget.trim(), null, 'file', 'broken');
      return;
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
      record(src, location, rawTarget.trim(), null, 'file', 'broken');
      return;
    }
    if (resolved.startsWith('.storyforge/') || resolved === '.storyforge') return;
    const isPresent = present.get(resolved) ?? (await exists(path.join(bookDir, ...resolved.split('/'))));
    if (!isPresent) {
      add('E301', src.file, location, `file not found: ${t}`);
    } else if (resolved.startsWith('archive/')) {
      add('W303', src.file, location, `link points into archive/: ${t}`);
    }
    const doc = byRel.get(resolved);
    record(src, location, rawTarget.trim(), doc ? idOf(doc) : null, doc ? doc.kind : 'file',
      !isPresent ? 'broken' : resolved.startsWith('archive/') ? 'archived' : 'ok');
  }

  return { eventScenes, links };
}

/**
 * The book-relative path checkFileLink will stat for a markdown link target, or null when it never stats
 * (absolute / escaping / external / anchor-only / .storyforge). Mirrors the early exits of checkFileLink.
 * @param {Doc} src @param {string} rawTarget @returns {{resolved: string} | null}
 */
function fileLinkStat(src, rawTarget) {
  let t = rawTarget.trim();
  if (t.startsWith('<')) {
    const end = t.indexOf('>');
    t = end > 0 ? t.slice(1, end) : t.slice(1);
  } else {
    t = t.split(/\s+/)[0];
  }
  if (/^[A-Za-z]:([\\/]|$)/.test(t) || /^file:/i.test(t) || t.startsWith('\\\\')) return null;
  if (t === '' || t.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return null;
  t = t.split('#')[0].split('?')[0];
  if (t === '') return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep the raw text
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(src.rel), t));
  if (t.startsWith('/') || escapesRoot(path.posix.join(path.posix.dirname(src.rel), t))) return null;
  if (resolved.startsWith('.storyforge/') || resolved === '.storyforge') return null;
  return { resolved };
}
