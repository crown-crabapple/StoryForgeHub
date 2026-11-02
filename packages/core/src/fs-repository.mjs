// FsRepository: the only core module that reads project files. Reads only; caches nothing.
// Every change goes through fs-writes.mjs -> @storyforge/store.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { validate } from '@storyforge/format';
import { applyRepair, planRepair } from '@storyforge/manuscript';
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
    return {
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
    };
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
    const hits = await Promise.all(paths.map((p) => manager.tryRead(p, (_q, s) => s)));
    if (hits.some((h) => h === null)) return null;
    return hits
      .map((h) => /** @type {{ value: BookSummary }} */ (h).value)
      .filter((b) => b.id)
      .sort(compareBooks);
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
    async libraryInfo() {
      const result = await validate(root);
      const lib = await readParsed(path.join(root, 'library.md'));
      return { root, title: lib ? str(lib.fm.title) : null, diagnostics: result.diagnostics };
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
        const hit = await manager.tryRead(known, (q, s, inv) => (s.id === bookId ? bookDetailFromIndex(q, s, known, inv) : null));
        if (hit && hit.value) return hit.value;
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
  Object.assign(repository, createWriteMethods({ root, getScene: (b, s) => repository.getScene(b, s), afterWrite: (p) => manager.afterWrite(p) }));
  return repository;
}
