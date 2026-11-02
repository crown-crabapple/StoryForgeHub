// FsRepository: the only core module that reads project files. Reads only; caches nothing.
// Every change goes through fs-writes.mjs -> @storyforge/store.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { discover, escapesRoot, extractDocs, isFile, loadDoc, validate, walkMarkdown } from '@storyforge/format';
import { bookFacts, buildGraph, subGraph } from '@storyforge/index';
import { MAX_ATTACHMENT_BYTES, applyRepair, planRepair } from '@storyforge/manuscript';
import { listTemplates } from '@storyforge/templates';
import { createBookMethod } from './create-book.mjs';
import { createActivity } from './activity.mjs';
import { createIndexManager } from './index-manager.mjs';
import { createWatcher } from './watcher.mjs';
import { createWriteMethods } from './fs-writes.mjs';
import { createTimelineReads } from './fs-timeline.mjs';
import { countWords } from './word-count.mjs';

/** @typedef {import('./repository.mjs').FileRepository} FileRepository */
/** @typedef {import('./repository.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./repository.mjs').BookSummary} BookSummary */
/** @typedef {import('./repository.mjs').BookDetail} BookDetail */
/** @typedef {import('./repository.mjs').SceneSummary} SceneSummary */

/**
 * Split a file into parsed front matter and the raw body that follows it.
 * The body is returned byte-for-byte (no line-ending changes).
 * @param {string} text
 * @returns {{ fm: Record<string, any>, body: string }}
 */
function splitFile(text) {
  const t = text.startsWith('﻿') ? text.slice(1) : text;
  const firstEnd = t.indexOf('\n');
  if (firstEnd < 0 || t.slice(0, firstEnd).replace(/\r$/, '') !== '---') return { fm: {}, body: t };
  let pos = firstEnd + 1;
  while (pos <= t.length) {
    const e = t.indexOf('\n', pos);
    const lineEnd = e < 0 ? t.length : e;
    if (t.slice(pos, lineEnd).replace(/\r$/, '') === '---') {
      const yamlText = t.slice(firstEnd + 1, pos);
      let fm = {};
      try {
        const v = parse(yamlText, { version: '1.2', schema: 'core' });
        if (v && typeof v === 'object' && !Array.isArray(v)) fm = v;
      } catch {
        fm = {};
      }
      return { fm, body: e < 0 ? '' : t.slice(e + 1) };
    }
    if (e < 0) break;
    pos = e + 1;
  }
  return { fm: {}, body: t };
}

/** @param {string} file @returns {Promise<{ fm: Record<string, any>, body: string, sha256: string } | null>} */
async function readParsed(file) {
  try {
    const bytes = await readFile(file);
    return { ...splitFile(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' ? v : null);
/** @param {unknown} v @returns {number | null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** @param {string} a @param {string} b */
const BUILTIN_TYPES = ['character', 'location', 'faction', 'object', 'lore'];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const noop = () => {};
/** Largest cover image the library will describe or serve. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/** @param {string} dir @param {string} base @returns {boolean} true when dir is base or inside it */
function isInside(dir, base) {
  const rel = path.relative(base, dir);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Can this folder be opened as the library? Read-only checks, in the order of the M02-J03 contract:
 * an absolute path to an existing folder (not inside a .storyforge/ folder) that is a book, or has a book
 * within two levels. Failures are { ok: false, code: 'NOT_FOUND' | 'NOT_A_FOLDER' | 'NO_BOOKS', message }.
 * @param {unknown} input
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: 'NOT_FOUND' | 'NOT_A_FOLDER' | 'NO_BOOKS', message: string }>}
 */
export async function checkLibraryFolder(input) {
  const bad = (code, message) => ({ ok: false, code, message });
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '' || !path.isAbsolute(raw)) {
    return bad('NOT_FOUND', 'Type the full path of the folder, for example C:\\Books or /home/me/books.');
  }
  const p = path.resolve(raw);
  if (p.split(path.sep).some((part) => part.toLowerCase() === '.storyforge')) {
    return bad('NOT_A_FOLDER', 'That path is inside a StoryForge working folder. Choose the folder that holds your books.');
  }
  let st;
  try {
    st = await stat(p);
  } catch {
    return bad('NOT_FOUND', 'That folder was not found.');
  }
  if (!st.isDirectory()) return bad('NOT_A_FOLDER', 'That path is a file, not a folder.');
  if (await isFile(path.join(p, 'book.md'))) return { ok: true, path: p };
  try {
    const found = await discover(p, (await isFile(path.join(p, 'series.md'))) ? 'series' : 'library', noop);
    if (found.books.length > 0) return { ok: true, path: p };
  } catch {
    // an unreadable folder has no books we can use
  }
  return bad('NO_BOOKS', 'That folder has no books in it.');
}

/** True if `p` is an existing folder (used to flag recent libraries that have gone). @param {string} p */
export async function folderExists(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Markdown as plain words: links and comments reduced to their text, emphasis marks dropped, whitespace collapsed. @param {string} md */
function plainText(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[([^\]\n|]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `##` sections of an entry body: [{ heading, text }] with plain text of at most 600 characters (`markdown: true` adds the raw section text as `markdown`, up to 6000). @param {string} body @param {{ markdown?: boolean }} [opts] */
export function entrySections(body, { markdown = false } = {}) {
  /** @type {{ heading: string, text: string, markdown?: string }[]} */
  const out = [];
  /** @type {{ heading: string, lines: string[] } | null} */
  let cur = null;
  let fence = null;
  const section = (c) => ({
    heading: c.heading,
    text: plainText(c.lines.join('\n')).slice(0, 600),
    ...(markdown ? { markdown: c.lines.join('\n').replace(/\r$/gm, '').trim().slice(0, 6000) } : {}),
  });
  for (const line of body.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/.exec(line);
    if (h && h[1].length <= 2) {
      if (cur && cur.heading !== null) out.push(section(cur));
      cur = h[1].length === 2 ? { heading: plainText(h[2]), lines: [] } : null;
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push(section(cur));
  return out;
}

/** Manuscript-structure errors (E1xx/E2xx under manuscript/), as the manuscript contract's rule 5 defines them. */
const isStructureError = (d) => d.severity === 'error' && /^E[12]\d\d$/.test(d.code) && d.file.startsWith('manuscript/');
const problemOf = (d) => ({ code: d.code, message: d.message });

/** Plain-words explanation of a file the repair cannot fix. */
function explain(d) {
  const what = d.code === 'E100' ? 'its front matter cannot be read' : d.code === 'E101' ? 'it uses a YAML feature StoryForge does not allow' : 'a front-matter field is wrong';
  return `${d.file}: ${what} (${d.message}). StoryForge will not change this file for you; fix this file by hand.`;
}

/**
 * @param {string} libraryRoot
 * @param {import('./watcher.mjs').WatchOptions & { watcher?: import('./watcher.mjs').WatchOptions }} [options]
 *   Watching is on by default. Tests can pass `{ watch: false | 'fail', pollMs }` (also accepted under `watcher`),
 *   `debounceMs` and `maxWaitMs`. Call `close()` to stop the watchers and timers (and write the pending writing log).
 *   `clock: () => number | Date` is the time used for the writing log's dates, revision stamps and snapshot timing;
 *   `activityFlushMs` (default 60 000) is how often the writing log is flushed.
 * @returns {FileRepository}
 */
export function createFsRepository(libraryRoot, options = {}) {
  const root = path.resolve(libraryRoot);
  const manager = createIndexManager(root);
  const watcher = createWatcher({ root, manager, options: { ...options, ...(options.watcher ?? {}) } });
  watcher.start();

  /** The questions createBook asks about the library (reads only). @type {import('./create-book.mjs').CreateProbe} */
  const createProbe = {
    async libraryKind() {
      if (await isFile(path.join(root, 'book.md'))) return 'book';
      return (await isFile(path.join(root, 'series.md'))) ? 'series' : 'library';
    },
    async bookSlugs() {
      return (await validate(root)).books.map((/** @type {any} */ b) => b.slug).filter((/** @type {unknown} */ x) => typeof x === 'string');
    },
    async penNameSlugs() {
      const names = (await readParsed(path.join(root, 'library.md')))?.fm.pen_names;
      return Array.isArray(names) ? names.map((n) => n?.slug).filter((x) => typeof x === 'string') : [];
    },
    async findSeries(seriesSlug) {
      let entries;
      try {
        entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => cmp(a.name, b.name));
      } catch {
        return null;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const dirAbs = path.join(root, e.name);
        const isDir = e.isDirectory() || (e.isSymbolicLink() && (await stat(dirAbs).then((x) => x.isDirectory(), () => false)));
        if (!isDir || (await readParsed(path.join(dirAbs, 'series.md')))?.fm.slug !== seriesSlug) continue;
        const real = await realpath(dirAbs).then(async (r) => isInside(r, await realpath(root)), () => false);
        const usedNumbers = [];
        for (const b of (await discover(root, 'library', noop)).books) {
          if (b.seriesPath !== e.name) continue;
          const n = num((await readParsed(path.join(root, ...b.path.split('/'), 'book.md')))?.fm.series_number);
          if (n !== null) usedNumbers.push(n);
        }
        return { dir: e.name, usedNumbers, real };
      }
      return null;
    },
    async exists(relDir) {
      return lstat(abs(relDir)).then(() => true, () => false);
    },
  };
  /** @param {string} rel */
  const abs = (rel) => path.join(root, ...rel.split('/').filter(Boolean));

  /** @param {Diagnostic[]} diagnostics @param {string} bookPath */
  function forBook(diagnostics, bookPath) {
    if (bookPath === '') return diagnostics;
    return diagnostics.filter((d) => d.file === bookPath || d.file.startsWith(`${bookPath}/`));
  }

  /**
   * Scene summaries (and file contents) for scenes of a book, in the order given.
   * @param {any[]} order
   */
  async function loadScenes(order) {
    return Promise.all(
      order.map(async (s) => {
        const parsed = await readParsed(abs(s.path));
        const body = parsed ? parsed.body : '';
        const fm = parsed ? parsed.fm : {};
        const sha256 = parsed ? parsed.sha256 : null;
        /** @type {SceneSummary} */
        const summary = {
          id: s.id,
          title: s.title,
          position: s.position,
          act: s.act,
          chapter: s.chapter,
          sequence: s.sequence,
          status: str(fm.status),
          pov: str(fm.pov),
          word_count: countWords(body),
          path: s.path,
        };
        return { summary, fm, body, sha256 };
      }),
    );
  }

  /**
   * @param {any} book @param {Diagnostic[]} diagnostics
   * @param {{ summary: SceneSummary }[]} scenes
   * @returns {Promise<BookSummary>}
   */
  async function summarise(book, diagnostics, scenes) {
    const bookFile = book.path ? `${book.path}/book.md` : 'book.md';
    const parsed = await readParsed(abs(bookFile));
    const fm = parsed ? parsed.fm : {};
    const own = forBook(diagnostics, book.path);
    const { seriesFm, libraryFm } = await contextFms(book.path, book.series !== null);
    const facts = bookFacts({ fm, body: parsed ? parsed.body : '', seriesFm, libraryFm });
    return finishSummary({
      facts: true,
      id: book.id,
      slug: book.slug,
      title: book.title,
      series: book.series,
      series_number: num(fm.series_number),
      status: str(fm.status),
      path: book.path,
      scene_count: scenes.length,
      word_count: scenes.reduce((n, s) => n + s.summary.word_count, 0),
      error_count: own.filter((d) => d.severity === 'error').length,
      warning_count: own.filter((d) => d.severity === 'warning').length,
      ...facts,
      invalid: own.some((d) => isStructureError({ ...d, file: book.path ? d.file.slice(book.path.length + 1) : d.file })),
    }, book.path);
  }

  /** @param {{ file?: string, contentType?: string }} c */
  async function readCover(c) {
    const bytes = await readFile(/** @type {string} */ (c.file));
    return { bytes, contentType: /** @type {string} */ (c.contentType), sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** { error: 'too_large' } when the cover is a contained, supported image over the size cap; else null. */
  async function oversized(bookPath, cover) {
    try {
      const norm = path.posix.normalize(cover.replace(/\\/g, '/'));
      const real = await realpath(path.join(abs(bookPath), ...norm.split('/')));
      if (!isInside(real, await realpath(path.join(abs(bookPath), 'assets')))) return null;
      return (await stat(real)).size > MAX_COVER_BYTES ? { error: 'too_large' } : null;
    } catch {
      return null;
    }
  }

  /** Every series of the library: [{ slug, title, status, book_ids }] by series slug, books by series_number. */
  async function seriesList() {
    let series;
    try {
      if (await readParsed(abs('book.md'))) return [];
      const isSeriesRoot = (await readParsed(abs('series.md'))) !== null;
      series = isSeriesRoot ? [''] : (await discover(root, 'library', noop)).series;
    } catch {
      return [];
    }
    const books = await repository.listBooks();
    const out = [];
    for (const dir of series) {
      const fm = (await readParsed(abs(dir ? `${dir}/series.md` : 'series.md')))?.fm;
      if (!fm || typeof fm.slug !== 'string') continue;
      out.push({
        slug: fm.slug,
        title: str(fm.title),
        status: str(fm.status),
        book_ids: books.filter((b) => b.series === fm.slug).map((b) => b.id),
      });
    }
    return out.sort((a, b) => cmp(a.slug, b.slug));
  }

  /** Front matter of a book's series.md (if it is in a series) and of library.md (when the root is a library). */
  async function contextFms(bookPath, inSeries) {
    const fmOf = async (rel) => (await readParsed(abs(rel)))?.fm ?? null;
    const segs = bookPath === '' ? [] : bookPath.split('/');
    const seriesFm = inSeries && segs.length > 0 ? await fmOf([...segs.slice(0, -1), 'series.md'].join('/')) : null;
    const rootIsLibrary = bookPath !== '' && !(await readParsed(abs('series.md')));
    return { seriesFm, libraryFm: rootIsLibrary ? await fmOf('library.md') : null };
  }

  /** @type {Map<string, { size: number, mtimeMs: number, sha256: string }>} real image path -> its hash at that size and mtime */
  const coverHashes = new Map();

  /**
   * What a book's `cover` field points at. Containment is checked on the real path (symlinks included).
   * @param {string} bookPath @param {string | null} cover raw field
   * @returns {Promise<{ state: 'image' | 'none' | 'missing' | 'unsupported' | 'outside', file?: string, contentType?: string, size?: number, mtimeMs?: number }>}
   */
  async function resolveCover(bookPath, cover) {
    if (cover === null || cover.trim() === '') return { state: 'none' };
    const slashed = cover.replace(/\\/g, '/');
    const norm = path.posix.normalize(slashed);
    if (escapesRoot(cover) || !norm.startsWith('assets/') || norm === 'assets/' || slashed.split('/').some((x) => x.startsWith('.'))) return { state: 'outside' };
    const contentType = COVER_TYPES[path.posix.extname(norm).toLowerCase()];
    if (!contentType) return { state: 'unsupported' };
    const bookRoot = abs(bookPath);
    const file = path.join(bookRoot, ...norm.split('/'));
    try {
      const real = await realpath(file);
      const assetsReal = await realpath(path.join(bookRoot, 'assets'));
      if (!isInside(real, assetsReal)) return { state: 'outside' };
      const st = await stat(real);
      if (!st.isFile()) return { state: 'missing' };
      if (st.size > MAX_COVER_BYTES) return { state: 'unsupported' };
      return { state: 'image', file: real, contentType, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { state: 'missing' };
    }
  }

  /** sha256 of a resolved cover image (cached by size and mtime). @param {{ file?: string, size?: number, mtimeMs?: number }} c */
  async function coverSha(c) {
    const hit = coverHashes.get(/** @type {string} */ (c.file));
    if (hit && hit.size === c.size && hit.mtimeMs === c.mtimeMs) return hit.sha256;
    const sha256 = createHash('sha256').update(await readFile(/** @type {string} */ (c.file))).digest('hex');
    coverHashes.set(/** @type {string} */ (c.file), { size: /** @type {number} */ (c.size), mtimeMs: /** @type {number} */ (c.mtimeMs), sha256 });
    return sha256;
  }

  /**
   * The summary as the API returns it: the raw `cover` field becomes cover_state / cover_url, and the
   * internal markers (`facts`, `invalid`) become `index_state` ('invalid' or 'ok').
   * @param {any} s @param {string} bookPath
   * @returns {Promise<BookSummary>}
   */
  async function finishSummary(s, bookPath) {
    const { invalid, cover } = s;
    const rest = { ...s };
    for (const k of ['facts', 'invalid', 'cover']) delete rest[k];
    const c = await resolveCover(bookPath, cover ?? null);
    const cover_url = c.state === 'image' ? `/api/books/${encodeURIComponent(s.id)}/cover?v=${(await coverSha(c)).slice(0, 8)}` : null;
    return { ...rest, cover_state: c.state, cover_url, index_state: invalid ? 'invalid' : 'ok' };
  }

  /** Books in a series first (by series slug, number, title); standalone books last. */
  /** @param {BookSummary} a @param {BookSummary} b */
  function compareBooks(a, b) {
    if ((a.series === null) !== (b.series === null)) return a.series === null ? 1 : -1;
    const bySeries = cmp(a.series ?? '', b.series ?? '');
    if (bySeries) return bySeries;
    const na = a.series_number ?? Infinity;
    const nb = b.series_number ?? Infinity;
    if (na !== nb) return na < nb ? -1 : 1;
    return cmp(a.title ?? '', b.title ?? '');
  }

  /** Every book's summary from its fresh index, or null if any book has to be answered from the files. */
  async function listFromIndex() {
    let paths;
    try {
      paths = await manager.bookPaths();
    } catch {
      return null;
    }
    const hits = await Promise.all(paths.map((p) => manager.tryRead(p, (_q, s, inv) => (s.facts ? { ...s, invalid: inv.invalid } : null))));
    paths.forEach((p, i) => {
      if (hits[i] !== null && hits[i]?.value === null) rebuildOldIndex(p);
    });
    if (hits.some((h) => h === null || h.value === null)) return null;
    const out = await Promise.all(hits.map((h, i) => finishSummary(/** @type {any} */ (h).value, paths[i])));
    return out.filter((b) => b.id).sort(compareBooks);
  }

  /** @type {Set<string>} */
  const rebuilding = new Set();
  /** An index built before the display facts existed: rebuild it once, in the background. @param {string} bookPath */
  function rebuildOldIndex(bookPath) {
    if (rebuilding.has(bookPath)) return;
    rebuilding.add(bookPath);
    manager.reconcile(bookPath, 'read', { full: true }).finally(() => rebuilding.delete(bookPath));
  }

  /**
   * @param {any} q index queries @param {BookSummary} summary @param {string} bookPath
   * @param {{ invalid: boolean, invalid_paths: string[] }} [inv] the invalid marker of the projection being read
   */
  function bookDetailFromIndex(q, summary, bookPath, inv) {
    const prefix = bookPath === '' ? '' : `${bookPath}/`;
    const diagnostics = inv?.invalid ? q.diagnostics() : [];
    const problems = new Map();
    for (const d of diagnostics) if (isStructureError(d) && !problems.has(d.file)) problems.set(d.file, problemOf(d));
    /** @type {BookDetail['acts']} */
    const acts = [];
    for (const c of q.chapters()) {
      let act = acts.find((a) => a.act === c.act);
      if (!act) {
        act = { act: c.act, label: c.act_label, chapters: [] };
        acts.push(act);
      }
      act.chapters.push({ chapter: c.chapter, label: c.label, title: c.title, scenes: [] });
    }
    for (const s of q.scenes()) {
      const act = /** @type {any} */ (acts.find((a) => a.act === s.act));
      act.chapters.find((/** @type {any} */ c) => c.chapter === s.chapter).scenes.push({ ...s, path: prefix + s.path, ...(problems.has(s.path) ? { problem: problems.get(s.path) } : {}) });
    }
    const excluded = q.excluded().map((/** @type {any} */ e) => ({ ...e, path: prefix + e.path }));
    if (!inv?.invalid) return { ...summary, acts, excluded };
    // Last valid structure, plus what is wrong now. Files the structure does not know are "unplaced".
    const placed = new Set([...q.scenes().map((/** @type {any} */ x) => x.path), ...q.excluded().map((/** @type {any} */ x) => x.path)]);
    const unplaced = [...problems]
      .filter(([file]) => !placed.has(file) && !/\/(act|chapter)\.md$/.test(file))
      .map(([file, problem]) => ({ path: prefix + file, problem }));
    return {
      ...summary,
      acts,
      excluded,
      index_state: 'invalid',
      invalid_paths: inv.invalid_paths.map((/** @type {string} */ f) => prefix + f),
      diagnostics: diagnostics.map((/** @type {any} */ d) => ({ ...d, file: prefix + d.file })),
      unplaced,
    };
  }

  /** The book (as validate() sees it) with this id, or null. */
  /** The graph and the scene order of a book: from the index when it is readable, else from the files. Null for an unknown book. */
  async function graphOf(bookId, known) {
    try {
      const hit = await manager.query(bookId, (x) => ({ graph: x.graph(), scenes: x.scenes() }));
      if (hit === null) return null;
      return { graph: hit.graph, scenes: new Map(hit.scenes.map((s) => [s.id, { title: s.title, position: s.position }])) };
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'INDEX_NOT_READY') throw e;
    }
    const result = known ?? (await validate(root));
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    return {
      graph: buildGraph(result, undefined, book.path),
      scenes: new Map(book.order.map((/** @type {any} */ s) => [s.id, { title: s.title, position: s.position }])),
    };
  }

  async function bookById(bookId) {
    return (await validate(root)).books.find((/** @type {any} */ b) => b.id === bookId) ?? null;
  }

  /**
   * A scene the validator no longer lists (its file cannot be parsed) but the last valid projection knows:
   * the current file bytes, raw, with the problem. Null if the index does not know the scene or the file is gone.
   * @param {any} book @param {Diagnostic[]} diagnostics @param {string} sceneId
   */
  async function rawScene(book, diagnostics, sceneId) {
    let row;
    try {
      row = await manager.query(book.id, (q, prefix) => {
        const r = q.scenes().find((/** @type {any} */ x) => x.id === sceneId);
        return r ? { ...r, path: prefix + r.path } : null;
      });
    } catch {
      return null;
    }
    if (!row) return null;
    let bytes;
    try {
      bytes = await readFile(abs(row.path));
    } catch {
      return null;
    }
    const text = bytes.toString('utf8');
    const diag = diagnostics.find((d) => d.file === row.path && isStructureError(d));
    return {
      ...row,
      word_count: countWords(text),
      front_matter: {},
      body: text,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      raw: true,
      ...(diag ? { problem: problemOf(diag) } : {}),
    };
  }

  const activity = createActivity({
    rootOf: (bookPath) => abs(bookPath),
    async readGoal(bookPath) {
      const goal = (await readParsed(abs(bookPath ? `${bookPath}/book.md` : 'book.md')))?.fm.daily_word_goal;
      return Number.isInteger(goal) && goal >= 1 ? goal : null;
    },
    afterWrite: (bookPath) => manager.afterWrite(bookPath),
    now: options.clock,
    flushMs: options.activityFlushMs,
  });

  /** @type {FileRepository} */
  const repository = {
    root,

    async libraryInfo() {
      const result = await validate(root);
      const lib = await readParsed(path.join(root, 'library.md'));
      const penNames = Array.isArray(lib?.fm.pen_names)
        ? lib.fm.pen_names.filter((n) => typeof n?.slug === 'string').map((n) => ({ name: str(n.name) ?? n.slug, slug: n.slug }))
        : [];
      return { root, title: lib ? str(lib.fm.title) : null, diagnostics: result.diagnostics, series: await seriesList(), pen_names: penNames };
    },

    async getCover(bookId) {
      if (typeof bookId !== 'string') return null;
      let bookPath;
      try {
        bookPath = await manager.pathOf(bookId);
      } catch {
        return null;
      }
      if (bookPath === null) return null;
      const fm = (await readParsed(abs(bookPath ? `${bookPath}/book.md` : 'book.md')))?.fm;
      if (!fm || fm.id !== bookId) return null;
      const c = await resolveCover(bookPath, str(fm.cover));
      if (c.state === 'image') return readCover(c);
      // an image over the cap is described as unsupported, but the route still says why
      const big = c.state === 'unsupported' && typeof fm.cover === 'string' && COVER_TYPES[path.posix.extname(fm.cover.replace(/\\/g, '/')).toLowerCase()];
      return big ? await oversized(bookPath, fm.cover) : null;
    },

    async listBooks() {
      const indexed = await listFromIndex();
      if (indexed) return indexed;
      const result = await validate(root);
      const books = result.books.filter((/** @type {any} */ b) => b.id);
      const out = await Promise.all(
        books.map(async (/** @type {any} */ b) => summarise(b, result.diagnostics, await loadScenes(b.order))),
      );
      for (const b of out) manager.warm(b.path, b.id);
      return out.sort(compareBooks);
    },

    async getBook(bookId) {
      const known = manager.knownPath(bookId);
      if (known !== undefined) {
        const hit = await manager.tryRead(known, (q, s, inv) => {
          if (s.id !== bookId) return null;
          return s.facts ? { detail: bookDetailFromIndex(q, s, known, inv), invalid: inv.invalid } : 'old';
        });
        if (hit && hit.value === 'old') rebuildOldIndex(known);
        else if (hit && hit.value) {
          const { detail, invalid } = /** @type {any} */ (hit.value);
          return finishSummary({ ...detail, invalid }, known);
        }
      }
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      manager.warm(book.path, book.id);
      const scenes = await loadScenes(book.order);
      const summary = await summarise(book, result.diagnostics, scenes);

      /** @type {BookDetail['acts']} */
      const acts = [];
      for (let i = 0; i < book.order.length; i++) {
        const s = book.order[i];
        let act = acts.find((a) => a.act === s.act);
        if (!act) {
          act = { act: s.act, label: s.act_label, chapters: [] };
          acts.push(act);
        }
        let chapter = act.chapters.find((c) => c.chapter === s.chapter);
        if (!chapter) {
          const dir = path.posix.dirname(s.path);
          let title = null;
          if (path.posix.basename(dir).startsWith('ch-')) {
            const ch = await readParsed(abs(`${dir}/chapter.md`));
            title = ch ? str(ch.fm.title) : null;
          }
          chapter = { chapter: s.chapter, label: s.chapter_label, title, scenes: [] };
          act.chapters.push(chapter);
        }
        chapter.scenes.push(scenes[i].summary);
      }
      return { ...summary, acts, excluded: book.excluded };
    },

    async getScene(bookId, sceneId) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const entry = book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!entry) return rawScene(book, result.diagnostics, sceneId);
      const [{ summary, fm, body, sha256 }] = await loadScenes([entry]);
      return { ...summary, front_matter: fm, body, sha256 };
    },

    async getRawFile(bookId, relPath) {
      const book = await bookById(bookId);
      if (!book || typeof relPath !== 'string') return null;
      const segs = relPath.split('/');
      if (!/\.md$/i.test(relPath) || relPath.includes('\\') || segs.some((x) => x === '' || x === '.' || x === '..' || x.startsWith('.'))) return null;
      const bookRoot = book.path === '' ? root : abs(book.path);
      const file = path.join(bookRoot, ...segs);
      const libRel = book.path ? `${book.path}/${relPath}` : relPath;
      try {
        const [realRoot, real] = await Promise.all([realpath(bookRoot), realpath(file)]);
        const rel = path.relative(realRoot, real);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
        const bytes = await readFile(file);
        const diag = (await validate(root)).diagnostics.find((d) => d.file === libRel && isStructureError(d));
        return {
          path: libRel,
          body: bytes.toString('utf8'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ...(diag ? { problem: problemOf(diag) } : {}),
        };
      } catch {
        return null;
      }
    },

    async search(q, { bookId, kinds, limit } = {}) {
      return typeof q === 'string' ? manager.search(q, { bookId, kinds, limit }) : [];
    },

    getBacklinks(bookId, id) {
      return manager.query(bookId, (x, prefix) => x.backlinks(id).map((/** @type {any} */ b) => ({ ...b, src_path: prefix + b.src_path })));
    },

    getMentions(bookId, { entryId, sceneId } = {}) {
      return manager.query(bookId, (x) => x.mentions({ entryId, sceneId }));
    },

    async getObjects(bookId, kinds) {
      const wanted = Array.isArray(kinds) && kinds.length > 0 ? kinds : ['entry', 'thread', 'event'];
      try {
        const rows = await manager.query(bookId, (x) => x.objects(wanted));
        if (rows === null) return null;
        return rows;
      } catch (e) {
        if (/** @type {any} */ (e)?.code !== 'INDEX_NOT_READY') throw e;
      }
      // no usable index yet: read the files
      const book = await bookById(bookId);
      if (!book) return null;
      const bookRoot = book.path === '' ? root : abs(book.path);
      const out = [];
      for (const rel of await walkMarkdown(bookRoot)) {
        const { doc } = await loadDoc(path.join(bookRoot, ...rel.split('/')), rel, rel, noop);
        if (!doc || doc.archived || !wanted.includes(doc.kind) || typeof doc.fm.id !== 'string') continue;
        out.push({ id: doc.fm.id, kind: doc.kind, slug: str(doc.fm.slug), title: str(doc.fm.title) ?? str(doc.fm.name), type: str(doc.fm.type) });
      }
      const key = (o) => (o.title ?? '').toLowerCase();
      return out.sort((a, b) => cmp(a.kind, b.kind) || cmp(key(a), key(b)) || cmp(a.id, b.id));
    },

    indexStatus: (bookId) => manager.status(bookId),
    rebuildIndex: (bookId) => manager.rebuild(bookId),
    ensureIndexes: () => manager.ensure(),

    async getStatus() {
      const states = /** @type {any[]} */ (await manager.status());
      return {
        watch: watcher.status(),
        books: states.map((st) => ({
          book_id: st.book_id,
          path: st.path,
          title: st.title,
          index: st.state,
          invalid_paths: (st.invalid_paths ?? []).map((/** @type {string} */ f) => (st.path ? `${st.path}/${f}` : f)),
          errors: st.errors,
          warnings: st.warnings,
          last_reconciled_at: st.last_reconciled_at,
        })),
      };
    },

    async planRepair(bookId) {
      const book = await bookById(bookId);
      if (!book) return null;
      const plan = await planRepair(book.path === '' ? root : abs(book.path));
      if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, actions: [], unrepairable: [] };
      return {
        ok: true,
        code: 'OK',
        actions: plan.actions,
        unrepairable: plan.unrepairable.map((/** @type {any} */ d) => ({ ...d, explanation: explain(d) })),
      };
    },

    /** Read-only repair plan of every book (for the CLI): [{ book_id, path, title, ...plan }]. */
    async repairPlans() {
      const out = [];
      for (const book of (await validate(root)).books.filter((/** @type {any} */ b) => b.id)) {
        const plan = await repository.planRepair(book.id);
        if (plan) out.push({ book_id: book.id, path: book.path, title: book.title, ...plan });
      }
      return out;
    },

    async applyRepair(bookId, actions) {
      const book = await bookById(bookId);
      if (!book) return { ok: false, code: 'NOT_FOUND' };
      const r = await applyRepair(book.path === '' ? root : abs(book.path), actions);
      if (r.ok) await manager.reconcile(book.path, 'repair', { full: true });
      return r;
    },

    listTemplates: () => listTemplates(),

    /** Create a book from a template: see create-book.mjs. Resolves with { ok, bookId, path } or { ok: false, code, field, message }. */
    createBook: createBookMethod({
      root,
      probe: createProbe,
      async afterCreate(bookPath, bookId) {
        if (bookId) manager.learn(bookPath, bookId);
        await manager.reconcile(bookPath, 'create');
        await watcher.rescan();
      },
    }),

    async close() {
      await activity.close().catch(() => {});
      await watcher.ready;
      watcher.close();
    },

    /**
     * The book graph { nodes, edges } (contract M04-J01 section 3), from the index when it is readable, else from the files.
     * `node` narrows to that node and its neighbours, `kinds` to edge kinds. Null for an unknown book or node.
     * @param {string} bookId @param {{ node?: string, kinds?: string[] }} [opts]
     */
    async getGraph(bookId, opts = {}) {
      const g = await graphOf(bookId);
      return g ? subGraph(g.graph, opts) : null;
    },

    /**
     * Codex types of the book: the five built-in types, every custom type that has entries or a codex/_types file.
     * [{ type, name, plural, fields, description, builtin, defined, count }] or null for an unknown book.
     */
    async getCodexTypes(bookId) {
      const book = await bookById(bookId);
      if (!book) return null;
      const bookRoot = book.path === '' ? root : abs(book.path);
      /** @type {Map<string, any>} */
      const defs = new Map();
      /** @type {Map<string, number>} */
      const counts = new Map();
      for (const rel of await walkMarkdown(bookRoot)) {
        if (!rel.startsWith('codex/')) continue;
        const { doc } = await loadDoc(path.join(bookRoot, ...rel.split('/')), rel, rel, noop);
        if (!doc || doc.archived) continue;
        if (doc.kind === 'codex-type' && typeof doc.fm.type === 'string' && /^[a-z]+$/.test(doc.fm.type) && !defs.has(doc.fm.type)) defs.set(doc.fm.type, doc);
        else if (doc.kind === 'entry' && typeof doc.fm.type === 'string') counts.set(doc.fm.type, (counts.get(doc.fm.type) ?? 0) + 1);
      }
      const types = [...new Set([...BUILTIN_TYPES, ...[...defs.keys(), ...counts.keys()].sort()])];
      return types.map((type) => {
        const doc = defs.get(type);
        const fallback = type.charAt(0).toUpperCase() + type.slice(1);
        const name = str(doc?.fm.name) ?? fallback;
        return {
          type,
          name,
          plural: str(doc?.fm.plural) ?? (type === 'lore' ? name : `${name}s`),
          fields: Array.isArray(doc?.fm.fields) ? doc.fm.fields.filter((f) => typeof f === 'string') : [],
          description: doc ? doc.body.trim() : '',
          builtin: BUILTIN_TYPES.includes(type),
          defined: doc !== undefined,
          count: counts.get(type) ?? 0,
        };
      });
    },

    /**
     * An entry for the scene rail's preview: { id, slug, name, type, status, fields, sections: [{ heading, text }],
     * appears_in: [{ scene_id, title, position, rel, kind }], related: [{ id, name, as, direction }] } or null.
     * `ref` is the entry id or slug.
     */
    async getEntry(bookId, ref) {
      const book = await bookById(bookId);
      if (!book || typeof ref !== 'string' || ref === '') return null;
      const bookRoot = book.path === '' ? root : abs(book.path);
      for (const rel of await walkMarkdown(bookRoot)) {
        const { doc } = await loadDoc(path.join(bookRoot, ...rel.split('/')), rel, rel, noop);
        if (!doc || doc.kind !== 'entry' || doc.archived || (doc.fm.id !== ref && doc.fm.slug !== ref)) continue;
        const id = str(doc.fm.id);
        const links = id ? await graphOf(bookId) : null;
        const appearsIn = [];
        const related = [];
        if (links) {
          const nameOf = new Map(links.graph.nodes.map((n) => [n.id, n.name]));
          for (const e of links.graph.edges) {
            const scene = links.scenes.get(e.from);
            if (e.to === id && scene) appearsIn.push({ scene_id: e.from, title: scene.title, position: scene.position, rel: e.rel, kind: e.kind });
            if (e.rel !== 'related') continue;
            if (e.from === id) related.push({ id: e.to, name: nameOf.get(e.to) ?? null, as: e.label ?? null, direction: 'out' });
            else if (e.to === id) related.push({ id: e.from, name: nameOf.get(e.from) ?? null, as: e.label ?? null, direction: 'in' });
          }
          appearsIn.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'explicit' ? -1 : 1) || a.position - b.position);
        }
        const file = await readParsed(path.join(bookRoot, ...rel.split('/')));
        return {
          id,
          slug: str(doc.fm.slug),
          path: doc.file,
          sha256: file?.sha256 ?? null,
          body: file?.body ?? doc.body,
          name: str(doc.fm.name),
          type: str(doc.fm.type),
          status: str(doc.fm.status),
          fields: doc.fm.fields && typeof doc.fm.fields === 'object' && !Array.isArray(doc.fm.fields) ? doc.fm.fields : {},
          sections: entrySections(doc.body),
          appears_in: appearsIn,
          related,
        };
      }
      return null;
    },

    /**
     * Every codex entry of the book (archived ones too, flagged), for the Codex page: cards and inspector in one answer. Read from the
     * files (the graph from the index when it is readable, else from the files), so the answer is the same with or without an index.
     * { entries: [{ id, slug, type, name, status, role, aliases, fields, image, image_url, first_appearance, path, archived, updated_at,
     *   sections: [{ heading, text, markdown }], appears_in: [{ scene_id, title, position, rel, kind }], related: [{ id, name, as, direction }],
     *   problems: [{ code, severity, location, message }] }], chapters: [{ chapter, label, scene_ids }] } or null for an unknown book.
     * `appears_in` has one row per scene (explicit when any explicit edge exists), explicit first, then manuscript order.
     */
    async listCodexEntries(bookId) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const g = await graphOf(bookId, result);
      const scenes = new Map(book.order.map((/** @type {any} */ s) => [s.id, s]));
      const nameOf = new Map((g?.graph.nodes ?? []).map((n) => [n.id, n.name]));
      const edges = g?.graph.edges ?? [];
      const chapters = [];
      for (const s of book.order) {
        let c = chapters.find((x) => x.chapter === s.chapter);
        if (!c) chapters.push((c = { chapter: s.chapter, label: s.chapter_label, scene_ids: [] }));
        c.scene_ids.push(s.id);
      }
      chapters.sort((a, b) => a.chapter - b.chapter);
      const entries = [];
      for (const doc of extractDocs(result, book.path)) {
        if (doc.kind !== 'entry' || typeof doc.fm.id !== 'string') continue;
        const id = doc.fm.id;
        /** @type {Map<string, any>} */
        const byScene = new Map();
        const related = [];
        if (!doc.archived) {
          for (const e of edges) {
            const scene = e.to === id ? scenes.get(e.from) : null;
            if (scene) {
              const row = byScene.get(scene.id) ?? { scene_id: scene.id, title: scene.title, position: scene.position, rel: e.rel, kind: e.kind };
              if (e.kind === 'explicit' && row.kind !== 'explicit') Object.assign(row, { rel: e.rel, kind: 'explicit' });
              byScene.set(scene.id, row);
            }
            if (e.rel !== 'related') continue;
            if (e.from === id) related.push({ id: e.to, name: nameOf.get(e.to) ?? null, as: e.label ?? null, direction: 'out' });
            else if (e.to === id) related.push({ id: e.from, name: nameOf.get(e.from) ?? null, as: e.label ?? null, direction: 'in' });
          }
        }
        const appearsIn = [...byScene.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'explicit' ? -1 : 1) || a.position - b.position);
        const image = str(doc.fm.image);
        const c = await resolveCover(book.path, image);
        const st = await stat(abs(doc.file)).catch(() => null);
        entries.push({
          id,
          slug: str(doc.fm.slug),
          type: str(doc.fm.type),
          name: str(doc.fm.name),
          status: str(doc.fm.status),
          role: str(doc.fm.role),
          aliases: Array.isArray(doc.fm.aliases) ? doc.fm.aliases.filter((a) => typeof a === 'string') : [],
          fields: doc.fm.fields && typeof doc.fm.fields === 'object' && !Array.isArray(doc.fm.fields) ? doc.fm.fields : {},
          image,
          image_url: c.state === 'image' ? `/api/books/${encodeURIComponent(bookId)}/entries/${encodeURIComponent(id)}/image?v=${(await coverSha(c)).slice(0, 8)}` : null,
          first_appearance: str(doc.fm.first_appearance),
          path: doc.file,
          archived: doc.archived,
          updated_at: st ? new Date(st.mtimeMs).toISOString() : null,
          sections: entrySections(doc.body, { markdown: true }),
          appears_in: appearsIn,
          related,
          problems: result.diagnostics.filter((d) => d.file === doc.file && (d.severity === 'error' || d.severity === 'warning')).map((d) => ({ code: d.code, severity: d.severity, location: d.location, message: d.message })),
        });
      }
      entries.sort((a, b) => cmp((a.name ?? '').toLowerCase(), (b.name ?? '').toLowerCase()) || cmp(a.id, b.id));
      return { entries, chapters };
    },

    /**
     * Everything the Board, Outline, Threads and Matrix views draw, read from the files (the same answer with or without an index):
     * { threads: [{ id, slug, title, kind, status, setup, develop, payoff, characters, path, sha256, previous_slugs, problems }],
     *   scenes: [{ id, title, position, act, chapter, sequence, status, pov, summary, plot_threads, word_count, path, sha256 }] }.
     * `setup`, `develop` and `payoff` hold the scene ids that resolve to a live scene, in file order; `plot_threads` of a scene holds the ids of the threads it
     * names (by id, slug or previous slug; a name nothing resolves is left out). Scenes are in book order. Threads are by title. Null for an unknown book.
     */
    async listThreads(bookId) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const loaded = await loadScenes(book.order);
      const sceneIds = new Set(book.order.map((/** @type {any} */ s) => s.id));
      const docs = extractDocs(result, book.path).filter((d) => d.kind === 'thread' && !d.archived && typeof d.fm.id === 'string');
      const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      const threads = [];
      for (const doc of docs) {
        const file = await readParsed(abs(doc.file));
        threads.push({
          id: doc.fm.id,
          slug: str(doc.fm.slug),
          title: str(doc.fm.title),
          kind: str(doc.fm.kind),
          status: str(doc.fm.status),
          setup: ids(doc.fm.setup).filter((x) => sceneIds.has(x)),
          develop: ids(doc.fm.develop).filter((x) => sceneIds.has(x)),
          payoff: ids(doc.fm.payoff).filter((x) => sceneIds.has(x)),
          characters: ids(doc.fm.characters),
          previous_slugs: ids(doc.fm.previous_slugs),
          path: doc.file,
          sha256: file?.sha256 ?? null,
          problems: result.diagnostics.filter((d) => d.file === doc.file && (d.severity === 'error' || d.severity === 'warning')).map((d) => ({ code: d.code, severity: d.severity, location: d.location, message: d.message })),
        });
      }
      threads.sort((a, b) => cmp((a.title ?? '').toLowerCase(), (b.title ?? '').toLowerCase()) || cmp(a.id, b.id));
      const threadOf = (ref) => threads.find((t) => t.id === ref || t.slug === ref) ?? threads.find((t) => t.previous_slugs.includes(ref)) ?? null;
      const scenes = loaded.map(({ summary, fm, sha256 }) => ({
        ...summary,
        summary: str(fm.summary) ?? '',
        plot_threads: [...new Set(ids(fm.plot_threads).map((ref) => threadOf(ref)?.id).filter((x) => typeof x === 'string'))],
        sha256,
      }));
      return { threads, scenes };
    },

    /** One thread with its text: the thread of `listThreads` plus `body` (the text after the front matter, exactly as on disk). `ref` is the id or slug. Null if there is none. */
    async getThread(bookId, ref) {
      if (typeof ref !== 'string' || ref === '') return null;
      const all = await repository.listThreads(bookId);
      const thread = all?.threads.find((t) => t.id === ref || t.slug === ref);
      if (!thread) return null;
      const file = await readParsed(abs(thread.path));
      return file ? { ...thread, body: file.body, sha256: file.sha256 } : null;
    },

    /** The image an entry's `image` field points at (only a supported image under assets/ is ever served), like getCover. Null if there is none; `{ error: 'too_large' }` for an image over the size cap (as for covers). */
    async getEntryImage(bookId, ref) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book || typeof ref !== 'string') return null;
      const doc = extractDocs(result, book.path).find((d) => d.kind === 'entry' && (d.fm.id === ref || (!d.archived && d.fm.slug === ref)));
      if (!doc) return null;
      const c = await resolveCover(book.path, str(doc.fm.image));
      if (c.state === 'image') return readCover(c);
      // same rule as the cover: a supported image over the size cap is reported as too_large
      const image = str(doc.fm.image);
      const big = c.state === 'unsupported' && image !== null && COVER_TYPES[path.posix.extname(image.replace(/\\/g, '/')).toLowerCase()];
      return big ? await oversized(book.path, image) : null;
    },

    async getDiagnostics(bookId) {
      const result = await validate(root);
      if (bookId === undefined) return result.diagnostics;
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      return book ? forBook(result.diagnostics, book.path) : [];
    },
  };
  // Act titles and scene-less acts / chapters come from act.md / chapter.md (FORMAT-v1 4.5: metadata without
  // scenes is shown empty). Added here, after either read path, so the index and the files agree.
  const getBookRaw = repository.getBook;
  repository.getBook = async (bookId) => {
    const detail = await getBookRaw(bookId);
    if (!detail) return detail;
    const manuscript = detail.path ? `${detail.path}/manuscript` : 'manuscript';
    const metaActs = new Map();
    /** @type {{ n: number, act: number | null, label: string | null, title: string | null }[]} */
    const metaChapters = [];
    const dirs = async (rel) => {
      try {
        return (await readdir(abs(rel), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
      } catch {
        return [];
      }
    };
    for (const a of await dirs(manuscript)) {
      const actFm = (await readParsed(abs(`${manuscript}/${a}/act.md`)))?.fm;
      const folderAct = /^act-(\d+)(?:-|$)/.exec(a);
      const actNum = Number.isInteger(actFm?.act) && actFm.act >= 0 ? actFm.act : folderAct ? Number(folderAct[1]) : null;
      if (actFm && Number.isInteger(actFm.act) && actFm.act >= 0 && !metaActs.has(actFm.act)) metaActs.set(actFm.act, str(actFm.title));
      for (const c of await dirs(`${manuscript}/${a}`)) {
        const fm = (await readParsed(abs(`${manuscript}/${a}/${c}/chapter.md`)))?.fm;
        if (fm && Number.isInteger(fm.chapter) && fm.chapter >= 0 && !metaChapters.some((m) => m.n === fm.chapter)) {
          metaChapters.push({ n: fm.chapter, act: actNum, label: str(fm.label) || null, title: str(fm.title) });
        }
      }
    }
    const actLabel = (n) => (n === 0 ? 'Front Matter' : `Act ${n}`);
    const chapterLabel = (n) => (n === 0 ? 'Prologue' : `Chapter ${n}`);
    for (const [n, title] of metaActs) {
      if (!detail.acts.some((a) => a.act === n)) detail.acts.push({ act: n, label: actLabel(n), chapters: [], title });
    }
    for (const act of detail.acts) act.title = metaActs.get(act.act) ?? null;
    for (const m of metaChapters) {
      if (detail.acts.some((a) => a.chapters.some((c) => c.chapter === m.n)) || m.act === null) continue;
      let act = detail.acts.find((a) => a.act === m.act);
      if (!act) {
        act = { act: m.act, label: actLabel(m.act), chapters: [], title: metaActs.get(m.act) ?? null };
        detail.acts.push(act);
      }
      act.chapters.push({ chapter: m.n, label: m.label ?? chapterLabel(m.n), title: m.title, scenes: [] });
    }
    detail.acts.sort((a, b) => a.act - b.act);
    for (const act of detail.acts) act.chapters.sort((a, b) => a.chapter - b.chapter);
    return detail;
  };
  Object.assign(repository, createTimelineReads({
    root,
    bookPathOf: (bookId) => manager.pathOf(bookId),
    async readFileAt(libRel) {
      try {
        const [bytes, st] = await Promise.all([readFile(abs(libRel)), stat(abs(libRel))]);
        return { bytes, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
    /** A file under the book's assets/ folder: its real path must stay inside the real assets/ folder (symlinks included), be a regular file, and be at most 25 MB. */
    async readAssetFile(bookPath, segs) {
      try {
        const real = await realpath(path.join(abs(bookPath), ...segs));
        const assets = await realpath(path.join(abs(bookPath), 'assets'));
        const rel = path.relative(assets, real);
        if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
        const st = await stat(real);
        if (!st.isFile()) return null;
        if (st.size > MAX_ATTACHMENT_BYTES) return { error: 'too_large' };
        return { bytes: await readFile(real) };
      } catch {
        return null;
      }
    },
  }));
  Object.assign(repository, createWriteMethods({ root, getScene: (b, s) => repository.getScene(b, s), afterWrite: (p) => manager.afterWrite(p), reconcile: (p) => manager.reconcile(p, 'write', { full: true }), activity, now: options.clock }));
  return repository;
}
