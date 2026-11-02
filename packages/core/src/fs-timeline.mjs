// FsRepository reads for the Timeline, Notes and attachments (M04-J04). Reads only (the writes are in fs-writes.mjs): every answer is built from the
// files through validate(), so it is the same with or without an index, and an edit made outside the app shows up on the next read.
// An event or note file that cannot be read any more (E100 / E101 ...) is not in validate()'s documents: the last good version of it is kept here, in memory,
// and reported as `stale` next to the problem, so the pages keep showing the last valid projection (as the manuscript does for scenes).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { ATTACHMENT_TYPES } from '@storyforge/manuscript';
import { frontMatterEnd } from './fs-writes.mjs';

const str = (v) => (typeof v === 'string' ? v : null);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NAMED = ['entry', 'thread', 'event'];
const UNREADABLE = new Set(['E006', 'E100', 'E101']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/** The author notes (`<!-- note: ... -->`) of a body with their 1-based line: fenced and inline code is skipped. @param {string} body @returns {{ text: string, line: number }[]} */
export function sceneNotesOf(body) {
  const masked = [];
  let fence = null;
  for (const line of body.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      masked.push(' '.repeat(line.length));
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      masked.push(' '.repeat(line.length));
    } else masked.push(line);
  }
  const text = masked.join('\n').replace(INLINE_CODE_RE, (s) => s.replace(/[^\n]/g, ' '));
  const out = [];
  for (const m of text.matchAll(/<!--\s*note:\s*([\s\S]*?)\s*-->/gi)) {
    const line = 1 + (text.slice(0, m.index).match(/\n/g)?.length ?? 0);
    out.push({ text: body.slice(m.index, m.index + m[0].length).replace(/^<!--\s*note:\s*/i, '').replace(/\s*-->$/, '').replace(/\s+/g, ' ').trim(), line });
  }
  return out;
}

/** Markdown as plain words for a short excerpt. @param {string} md */
function excerptOf(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[([^\]\n|]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_`~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * @param {{ root: string,
 *   readFileAt: (libRel: string) => Promise<{ bytes: Buffer, mtimeMs: number } | null>,
 *   readAssetFile: (bookPath: string, segs: string[]) => Promise<{ bytes: Buffer } | { error: 'too_large' } | null>,
 *   bookPathOf: (bookId: string) => Promise<string | null> }} deps the file reads come from fs-repository.mjs, the one core module that reads files
 *   (`readAssetFile` resolves the real path, keeps it inside the real assets/ folder and enforces the size cap)
 */
export function createTimelineReads({ root, readFileAt, readAssetFile, bookPathOf }) {
  /** @type {Map<string, any>} `${bookId}\0${file}` -> the last good event / note of that file */
  const lastGood = new Map();

  async function load(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    return { result, book, docs: extractDocs(result, book.path), prefix: book.path ? `${book.path}/` : '' };
  }

  const problemsOf = (result, file) => result.diagnostics.filter((d) => d.file === file && (d.severity === 'error' || d.severity === 'warning')).map((d) => ({ code: d.code, severity: d.severity, location: d.location, message: d.message }));

  async function fileInfo(doc) {
    const f = await readFileAt(doc.file);
    return f ? { sha256: sha(f.bytes), updated_at: new Date(f.mtimeMs).toISOString(), bytes: f.bytes } : { sha256: null, updated_at: null, bytes: null };
  }

  /** Merge the last good version of every file that cannot be read now. @param {string} bookId @param {any[]} fresh @param {any[]} unreadable [{ path, code, message }] */
  function withStale(bookId, fresh, unreadable, within) {
    const key = (file) => `${bookId}\0${file}`;
    const seen = new Set(fresh.map((x) => x.path));
    for (const x of fresh) lastGood.set(key(x.path), x);
    const out = [...fresh];
    for (const k of [...lastGood.keys()]) {
      const [b, file] = k.split('\0');
      if (b !== bookId || !within(file) || seen.has(file)) continue;
      const bad = unreadable.find((u) => u.path === file);
      if (!bad) {
        lastGood.delete(k);
        continue;
      }
      out.push({ ...lastGood.get(k), stale: true, problems: [{ code: bad.code, severity: 'error', location: '', message: bad.message }] });
    }
    return out;
  }

  /** Files under a folder that validate() could not read: [{ path, code, message }]. */
  const unreadableIn = (ctx, within, docs) => {
    const have = new Set(docs.map((d) => d.file));
    const out = [];
    for (const d of ctx.result.diagnostics) {
      if (d.severity !== 'error' || have.has(d.file) || !within(d.file)) continue;
      const unreadable = UNREADABLE.has(d.code) || d.location === 'schema';
      if (unreadable && !out.some((u) => u.path === d.file)) out.push({ path: d.file, code: d.code, message: d.message });
    }
    return out;
  }

  async function readEvents(ctx) {
    const { result, book, docs, prefix } = ctx;
    const liveScenes = new Map(book.order.map((/** @type {any} */ s) => [s.id, s]));
    const sceneDocs = docs.filter((d) => d.kind === 'scene' && typeof d.fm.id === 'string');
    const eventDocs = docs.filter((d) => d.kind === 'event' && !d.archived && typeof d.fm.id === 'string');
    const byName = new Map();
    for (const e of eventDocs) for (const n of [e.fm.id, e.fm.slug, ...strs(e.fm.previous_slugs)]) if (typeof n === 'string' && !byName.has(n)) byName.set(n, e);
    /** @type {Map<string, Map<string, { event: boolean, scene: boolean }>>} */
    const sides = new Map();
    const note = (eventId, sceneId, side) => {
      if (!sides.has(eventId)) sides.set(eventId, new Map());
      const m = sides.get(eventId);
      m.set(sceneId, { ...(m.get(sceneId) ?? { event: false, scene: false }), [side]: true });
    };
    for (const e of eventDocs) for (const s of strs(e.fm.scenes)) note(e.fm.id, s, 'event');
    for (const s of sceneDocs) {
      for (const ref of strs(s.fm.events)) {
        const e = byName.get(ref);
        if (e) note(e.fm.id, s.fm.id, 'scene');
      }
    }
    const sceneRow = (id, side) => {
      const live = liveScenes.get(id);
      const doc = sceneDocs.find((d) => d.fm.id === id);
      const state = live ? 'live' : doc ? (doc.archived ? 'archived' : typeof doc.fm.variant_of === 'string' ? 'variant' : 'missing') : 'missing';
      return {
        id,
        state,
        side: side.event && side.scene ? 'both' : side.event ? 'event' : 'scene',
        title: live ? live.title : str(doc?.fm.title),
        position: live ? live.position : null,
        act: live ? live.act : null,
        act_label: live ? (live.act_label ?? null) : null,
        chapter: live ? live.chapter : null,
        chapter_label: live ? (live.chapter_label ?? null) : null,
      };
    };
    const events = [];
    for (const doc of eventDocs) {
      const info = await fileInfo(doc);
      const rows = [...(sides.get(doc.fm.id) ?? new Map())].map(([id, side]) => sceneRow(id, side));
      rows.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || cmp(a.id, b.id));
      events.push({
        id: doc.fm.id,
        slug: str(doc.fm.slug),
        title: str(doc.fm.title),
        order: typeof doc.fm.order === 'number' && Number.isFinite(doc.fm.order) ? doc.fm.order : null,
        when: str(doc.fm.when),
        date: typeof doc.fm.date === 'string' ? doc.fm.date : typeof doc.fm.date === 'number' ? String(doc.fm.date) : '',
        characters: strs(doc.fm.characters),
        locations: strs(doc.fm.locations),
        scenes: rows,
        previous_slugs: strs(doc.fm.previous_slugs),
        path: doc.file,
        rel: doc.rel,
        sha256: info.sha256,
        updated_at: info.updated_at,
        problems: problemsOf(result, doc.file),
      });
    }
    const within = (file) => file.startsWith(`${prefix}planning/timeline/`) && !file.startsWith(`${prefix}archive/`);
    const unreadable = unreadableIn(ctx, within, docs);
    const merged = withStale(book.id, events, unreadable, within);
    merged.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || cmp(a.id, b.id));
    return { events: merged, unreadable, liveScenes };
  }

  const reads = {
    /**
     * Everything the Timeline page draws (the projections themselves are computed by the page from this):
     * { events: [{ id, slug, title, order, when, date, characters, locations, scenes: [{ id, state: 'live' | 'archived' | 'variant' | 'missing', side: 'event' | 'scene' | 'both',
     *   title, position, act, act_label, chapter, chapter_label }], previous_slugs, path, sha256, updated_at, problems, stale? }] (by order, then id; the union of the event's
     *   `scenes` list and the scenes whose `events` name it), archived: [{ id, slug, title, path }], scenes: [live scenes in book order], entries: [{ id, slug, name, type }],
     *   threads: [{ id, slug, title, setup, develop, payoff }], unreadable: [{ path, code, message }] }. Null for an unknown book.
     */
    async getTimeline(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const { docs, book, prefix } = ctx;
      const { events, unreadable } = await readEvents(ctx);
      return {
        events,
        archived: docs.filter((d) => d.kind === 'event' && d.archived && typeof d.fm.id === 'string').map((d) => ({ id: d.fm.id, slug: str(d.fm.slug), title: str(d.fm.title), path: d.file })),
        scenes: book.order.map((/** @type {any} */ s) => ({ id: s.id, title: s.title, position: s.position, act: s.act, act_label: s.act_label ?? null, chapter: s.chapter, chapter_label: s.chapter_label ?? null })),
        entries: docs.filter((d) => d.kind === 'entry' && !d.archived && typeof d.fm.id === 'string').map((d) => ({ id: d.fm.id, slug: str(d.fm.slug), name: str(d.fm.name), type: str(d.fm.type) })),
        threads: docs.filter((d) => d.kind === 'thread' && !d.archived && typeof d.fm.id === 'string').map((d) => ({ id: d.fm.id, slug: str(d.fm.slug), title: str(d.fm.title), setup: strs(d.fm.setup), develop: strs(d.fm.develop), payoff: strs(d.fm.payoff) })),
        unreadable,
        prefix,
      };
    },

    /** One event (as in getTimeline) with `body` (the text after the front matter, exactly as on disk). `ref`: id or slug. Null if there is none. */
    async getEvent(bookId, ref) {
      if (typeof ref !== 'string' || ref === '') return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      const { events } = await readEvents(ctx);
      const event = events.find((e) => e.id === ref || e.slug === ref);
      if (!event) return null;
      const f = await readFileAt(event.path);
      if (!f) return null;
      const end = frontMatterEnd(f.bytes);
      return { ...event, sha256: sha(f.bytes), body: f.bytes.subarray(end < 0 ? 0 : end).toString('utf8') };
    },

    /**
     * Every research note, planning doc and source of the book (archived ones flagged), for the Notes page:
     * { notes: [{ id, kind: 'research' | 'doc' | 'source', title, path, tags, canon, locked, cite_key, source: { type, author, year, publisher, url, accessed, locator },
     *   sources: [{ cite_key, id, title, state }], links: [{ ref, id, kind, slug, name, state: 'ok' | 'archived' | 'broken' }], excerpt, archived, sha256, updated_at, problems, stale? }],
     *   tags: [{ tag, count }] (live research notes), objects: [{ id, kind, slug, name }] }. Planning docs are the documents under planning/ (not threads or events).
     */
    async listNotes(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const { result, docs, prefix } = ctx;
      const named = docs.filter((d) => NAMED.includes(d.kind) && typeof d.fm.id === 'string');
      const sourceDocs = docs.filter((d) => d.kind === 'source' && typeof d.fm.cite_key === 'string');
      const resolveLink = (ref) => {
        const hit = (pool) => pool.find((d) => d.fm.id === ref || d.fm.slug === ref) ?? pool.find((d) => strs(d.fm.previous_slugs).includes(ref));
        const d = hit(named.filter((x) => !x.archived)) ?? hit(named.filter((x) => x.archived));
        return d
          ? { ref, id: d.fm.id, kind: d.kind, slug: str(d.fm.slug), name: str(d.fm.name) ?? str(d.fm.title), state: d.archived ? 'archived' : 'ok' }
          : { ref, id: null, kind: null, slug: null, name: null, state: 'broken' };
      };
      const noteDocs = docs.filter((d) => ['research', 'source'].includes(d.kind) || (d.kind === 'doc' && d.rel.replace(/^archive\//, '').startsWith('planning/')));
      const notes = [];
      for (const doc of noteDocs) {
        if (typeof doc.fm.id !== 'string') continue;
        const info = await fileInfo(doc);
        const end = info.bytes ? frontMatterEnd(info.bytes) : -1;
        const body = info.bytes ? info.bytes.subarray(end < 0 ? 0 : end).toString('utf8') : '';
        notes.push({
          id: doc.fm.id,
          kind: doc.kind,
          title: str(doc.fm.title),
          path: doc.file,
          rel: doc.rel,
          tags: strs(doc.fm.tags),
          canon: doc.fm.canon === true,
          locked: doc.fm.locked === true,
          cite_key: str(doc.fm.cite_key),
          source: Object.fromEntries(['type', 'author', 'year', 'publisher', 'url', 'accessed', 'locator'].map((k) => [k, doc.fm[k] === undefined || doc.fm[k] === null ? '' : String(doc.fm[k])])),
          sources: strs(doc.fm.sources).map((c) => {
            const s = sourceDocs.find((x) => x.fm.cite_key === c && !x.archived) ?? sourceDocs.find((x) => x.fm.cite_key === c);
            return { cite_key: c, id: s ? str(s.fm.id) : null, title: s ? str(s.fm.title) : null, state: s ? (s.archived ? 'archived' : 'ok') : 'broken' };
          }),
          links: strs(doc.fm.links).map(resolveLink),
          excerpt: excerptOf(body),
          archived: doc.archived,
          sha256: info.sha256,
          updated_at: info.updated_at,
          problems: problemsOf(result, doc.file),
        });
      }
      const within = (file) => (file.startsWith(`${prefix}research/`) || file.startsWith(`${prefix}planning/`) || file.startsWith(`${prefix}archive/research/`) || file.startsWith(`${prefix}archive/planning/`)) && !file.startsWith(`${prefix}planning/threads/`) && !file.startsWith(`${prefix}planning/timeline/`);
      const unreadable = unreadableIn(ctx, within, docs);
      const merged = withStale(ctx.book.id, notes, unreadable, within);
      merged.sort((a, b) => cmp((a.title ?? '').toLowerCase(), (b.title ?? '').toLowerCase()) || cmp(a.id, b.id));
      const counts = new Map();
      for (const n of merged) if (n.kind === 'research' && !n.archived) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      return {
        notes: merged,
        tags: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || cmp(a.tag, b.tag)),
        objects: named.filter((d) => !d.archived).map((d) => ({ id: d.fm.id, kind: d.kind, slug: str(d.fm.slug), name: str(d.fm.name) ?? str(d.fm.title) })),
        unreadable,
      };
    },

    /** One note (as in listNotes) with `body` and `sha256` exactly as on disk. `id`: the note id. Null if there is none. */
    async getNote(bookId, id) {
      if (typeof id !== 'string' || id === '') return null;
      const list = await reads.listNotes(bookId);
      const note = list?.notes.find((n) => n.id === id);
      if (!note) return null;
      const f = await readFileAt(note.path);
      if (!f) return null;
      const end = frontMatterEnd(f.bytes);
      return { ...note, sha256: sha(f.bytes), body: f.bytes.subarray(end < 0 ? 0 : end).toString('utf8') };
    },

    /** Every author note of the manuscript: { scenes: [{ id, title, position, act, act_label, chapter, chapter_label, path, notes: [{ text, line }] }] } for the scenes that have notes, in book order. */
    async getSceneNotes(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const scenes = [];
      for (const s of ctx.book.order) {
        const f = await readFileAt(s.path);
        if (!f) continue;
        const end = frontMatterEnd(f.bytes);
        const notes = sceneNotesOf(f.bytes.subarray(end < 0 ? 0 : end).toString('utf8'));
        if (notes.length > 0) scenes.push({ id: s.id, title: s.title, position: s.position, act: s.act, act_label: s.act_label ?? null, chapter: s.chapter, chapter_label: s.chapter_label ?? null, path: s.path, notes });
      }
      return { scenes };
    },

    /**
     * An attachment: the bytes of a file under the book's assets/ whose extension is on the allowlist (never SVG, never anything else). `relPath` is book-relative with
     * forward slashes. The real path must stay inside the real assets/ folder (symlinks included). Null for everything else; { error: 'too_large' } over 25 MB.
     * Result: { bytes, contentType, inline, name, sha256 }.
     */
    async getAttachment(bookId, relPath) {
      if (typeof relPath !== 'string' || relPath === '' || relPath.length > 300) return null;
      const segs = relPath.split('/');
      if (relPath.includes('\\') || relPath.includes('\0') || segs[0] !== 'assets' || segs.length < 2 || segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
      const type = ATTACHMENT_TYPES[path.posix.extname(relPath).toLowerCase()];
      if (!type) return null;
      const bookPath = await bookPathOf(bookId); // the folder of the book (no full validation per file: a note may show many images)
      if (bookPath === null) return null;
      const file = await readAssetFile(bookPath, segs);
      if (!file) return null;
      if ('error' in file) return file;
      return { bytes: file.bytes, contentType: type.type, inline: type.inline, name: segs[segs.length - 1], sha256: sha(file.bytes) };
    },
  };
  return reads;
}
