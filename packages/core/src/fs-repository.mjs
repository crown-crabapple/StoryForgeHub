// FsRepository: the only core module that reads project files. Reads only; caches nothing.
// Every change goes through fs-writes.mjs -> @storyforge/store.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { discover, escapesRoot, isFile, validate } from '@storyforge/format';
import { bookFacts } from '@storyforge/index';
import { applyRepair, planRepair } from '@storyforge/manuscript';
import { listTemplates } from '@storyforge/templates';
import { createBookMethod } from './create-book.mjs';
import { createIndexManager } from './index-manager.mjs';
import { createWatcher } from './watcher.mjs';
import { createWriteMethods } from './fs-writes.mjs';
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
 *   `debounceMs` and `maxWaitMs`. Call `close()` to stop the watchers and timers.
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
      await watcher.ready;
      watcher.close();
    },

    async getDiagnostics(bookId) {
      const result = await validate(root);
      if (bookId === undefined) return result.diagnostics;
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      return book ? forBook(result.diagnostics, book.path) : [];
    },
  };
  // Act titles come from act.md (the index only knows labels); the tree shows "label + title".
  const getBookRaw = repository.getBook;
  repository.getBook = async (bookId) => {
    const detail = await getBookRaw(bookId);
    if (!detail) return detail;
    for (const act of detail.acts) {
      const first = act.chapters[0]?.scenes[0]?.path;
      const segs = typeof first === 'string' ? first.split('/') : [];
      const at = segs.indexOf('manuscript');
      let title = null;
      if (at >= 0 && segs.length > at + 2) {
        const inBook = segs.slice(0, at + 2).join('/');
        const rel = detail.path && !inBook.startsWith(`${detail.path}/`) ? `${detail.path}/${inBook}` : inBook;
        const fm = (await readParsed(abs(`${rel}/act.md`)))?.fm;
        if (fm && fm.act === act.act) title = str(fm.title);
      }
      act.title = title;
    }
    return detail;
  };
  Object.assign(repository, createWriteMethods({ root, getScene: (b, s) => repository.getScene(b, s), afterWrite: (p) => manager.afterWrite(p), reconcile: (p) => manager.reconcile(p, 'write', { full: true }) }));
  return repository;
}
