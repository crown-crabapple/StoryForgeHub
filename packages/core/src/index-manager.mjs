// Per-book indexes for FsRepository. Reads use a book's index only when it is fresh; otherwise the
// repository answers from the files and a refresh runs in the background. No filesystem access here.
import path from 'node:path';
import { discover, isFile, validate } from '@storyforge/format';
import { openIndex } from '@storyforge/index';
import { openStore } from '@storyforge/store';
import { __hooks } from './hooks.mjs';

const noop = () => {};
const notReady = (state) => Object.assign(new Error(`index is not ready (${state})`), { code: 'INDEX_NOT_READY', state });

/** True when the index is fresh (a build in progress does not matter). */
function isFresh(idx) {
  try {
    idx.read(() => true);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} root absolute library (or book) root */
export function createIndexManager(root, { readValidate = () => validate(root) } = {}) {
  /** @type {Map<string, Promise<{ bookPath: string, idx: ReturnType<typeof openIndex> }>>} */
  const entries = new Map();
  /** @type {Map<string, string>} book id -> book path, learned from indexes and from validate() */
  const idToPath = new Map();

  const bookRootOf = (bookPath) => (bookPath === '' ? root : path.join(root, ...bookPath.split('/')));
  const prefixOf = (bookPath) => (bookPath === '' ? '' : `${bookPath}/`);

  /** Book folders, found by a directory scan only (no parsing). */
  async function bookPaths() {
    if (await isFile(path.join(root, 'book.md'))) return [''];
    const mode = (await isFile(path.join(root, 'series.md'))) ? 'series' : 'library';
    const found = await discover(root, mode, noop);
    return found.books.map((b) => b.path).sort();
  }

  function entryFor(bookPath) {
    let p = entries.get(bookPath);
    if (!p) {
      p = openStore(bookRootOf(bookPath), { recover: false }).then((store) => ({
        bookPath,
        store,
        idx: openIndex(bookRootOf(bookPath), { store, libraryRoot: root }),
      }));
      p.catch(() => entries.delete(bookPath));
      entries.set(bookPath, p);
    }
    return p;
  }

  function learn(bookPath, bookId) {
    if (bookId) idToPath.set(bookId, bookPath);
  }

  const idOf = (bookPath) => {
    for (const [id, p] of idToPath) if (p === bookPath) return id;
    return null;
  };

  /** @type {Map<string, string>} book path -> when this process last finished a reconcile */
  const lastReconciled = new Map();
  /** @type {Map<string, number>} book path -> writes whose own reconcile has not started yet */
  const pendingWrites = new Map();

  /**
   * The one way the repository brings an index up to date (never refresh()/rebuild() directly: those would
   * replace the last valid projection of an invalid book). Counted by `__hooks.onReconcile`.
   * @param {{ idx: ReturnType<typeof openIndex> }} entry
   * @param {string} bookPath
   * @param {string} reason
   * @param {{ full?: boolean }} [opts]
   */
  function reconcileEntry(entry, bookPath, reason, opts) {
    const p = reconcileNow(entry, bookPath, reason, opts);
    inflight.add(p);
    const done = () => inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Reconciles still running (background refreshes included); close() waits for them so no index file stays open. @type {Set<Promise<any>>} */
  const inflight = new Set();

  /** @param {{ idx: ReturnType<typeof openIndex> }} entry @param {string} bookPath @param {string} reason @param {{ full?: boolean }} [opts] */
  async function reconcileNow(entry, bookPath, reason, opts) {
    try {
      __hooks.onReconcile?.({ bookPath, reason });
    } catch {
      // a test hook must not break a reconcile
    }
    const r = await entry.idx.reconcile(opts);
    lastReconciled.set(bookPath, new Date().toISOString());
    if (r.ok) learn(bookPath, readableId(entry.idx));
    return r;
  }

  /** Start a background reconcile unless a build is already running or a write's own reconcile is coming. Never throws. */
  function refreshSoon(entry, reason = 'read') {
    if (entry.idx.status().state === 'building' || (pendingWrites.get(entry.bookPath) ?? 0) > 0) return;
    reconcileEntry(entry, entry.bookPath, reason).catch(noop);
  }

  /** The folder of a book id; asks validate() once if the id has not been seen. @returns {Promise<string | null>} */
  async function pathOf(bookId) {
    if (idToPath.has(bookId)) return /** @type {string} */ (idToPath.get(bookId));
    const result = await readValidate();
    for (const b of result.books) if (b.id) idToPath.set(b.id, b.path);
    return idToPath.get(bookId) ?? null;
  }

  /** Book id of an index that is readable at all (fresh or not), else null. */
  function readableId(idx) {
    try {
      return idx.read((q) => q.bookId(), { allowStale: true });
    } catch {
      return null;
    }
  }

  return {
    bookPaths,
    learn,
    /** Drop everything held for a book folder that moved away (its open store, id, timings), once its reconciles are done. @param {string} bookPath */
    async forget(bookPath) {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
      entries.delete(bookPath);
      lastReconciled.delete(bookPath);
      pendingWrites.delete(bookPath);
      for (const [id, p] of [...idToPath]) if (p === bookPath) idToPath.delete(id);
    },
    pathOf,
    /** Resolves once no reconcile is running (including ones that start while waiting). Never throws. */
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    /** The folder of a book id seen before, without any lookup. @param {string} bookId */
    knownPath: (bookId) => idToPath.get(bookId),

    /**
     * Run `fn(queries, summary)` against the book's index if it is fresh. Returns `{ value }`, or null
     * (and starts a background refresh) when the caller must answer from the files.
     */
    async tryRead(bookPath, fn) {
      const entry = await entryFor(bookPath);
      try {
        return {
          value: entry.idx.read((q) => {
            const summary = q.bookSummary();
            if (summary.path !== bookPath) throw notReady('other-context');
            learn(bookPath, summary.id);
            return fn(q, summary, q.invalidInfo());
          }),
        };
      } catch (e) {
        if (e?.code !== 'INDEX_NOT_READY') throw e;
        if (e.state === 'other-context') reconcileEntry(entry, bookPath, 'read').catch(noop);
        else refreshSoon(entry);
        return null;
      }
    },

    /** Called after a successful write: reconcile that book's index in the background (the watcher ignores our own writes). */
    afterWrite(bookPath) {
      pendingWrites.set(bookPath, (pendingWrites.get(bookPath) ?? 0) + 1);
      const done = () => pendingWrites.set(bookPath, Math.max(0, (pendingWrites.get(bookPath) ?? 1) - 1));
      entryFor(bookPath).then(
        (e) => {
          done();
          return reconcileEntry(e, bookPath, 'write').catch(noop);
        },
        done,
      );
    },

    /** Reconcile one book now (watcher, poll, series/library change). Resolves with the result; never throws. */
    async reconcile(bookPath, reason = 'watch', opts) {
      try {
        return await reconcileEntry(await entryFor(bookPath), bookPath, reason, opts);
      } catch (e) {
        return { ok: false, code: e?.code ?? 'ERROR', message: String(e?.message ?? e) };
      }
    },

    /** The book's store (opened without a recovery pass). */
    storeFor: async (bookPath) => (await entryFor(bookPath)).store,
    /** Index state of one book without touching anything else. */
    indexStateOf: async (bookPath) => (await entryFor(bookPath)).idx.status(),
    bookRootOf,
    lastReconciledAt: (bookPath) => lastReconciled.get(bookPath) ?? null,

    /** The files path answered for this book: make sure its index gets built. */
    warm(bookPath, bookId) {
      learn(bookPath, bookId);
      entryFor(bookPath).then((e) => {
        if (!isFresh(e.idx)) refreshSoon(e, 'read');
      }, noop);
    },

    async status(bookId) {
      const one = async (bookPath) => {
        const { idx } = await entryFor(bookPath);
        const st = idx.status();
        return { ...st, book_id: idOf(bookPath) ?? st.book_id, path: bookPath, last_reconciled_at: lastReconciled.get(bookPath) ?? st.built_at };
      };
      if (bookId !== undefined) {
        const p = await pathOf(bookId);
        return p === null ? null : one(p);
      }
      return Promise.all((await bookPaths()).map(one));
    },

    /** Rebuild one book (by id) or every book. Resolves when the builds are done. */
    async rebuild(bookId) {
      let paths;
      if (bookId !== undefined) {
        const p = await pathOf(bookId);
        if (p === null) return { ok: false, code: 'NOT_FOUND', books: [] };
        paths = [p];
      } else {
        paths = await bookPaths();
      }
      const books = [];
      for (const bookPath of paths) {
        const entry = await entryFor(bookPath);
        const r = await reconcileEntry(entry, bookPath, 'rebuild', { full: true });
        books.push({ book_id: idOf(bookPath), path: bookPath, ...r });
      }
      return { ok: books.every((b) => b.ok), books };
    },

    /** Build or refresh every index that is not fresh. Resolves when done. */
    async ensure() {
      const books = [];
      for (const bookPath of await bookPaths()) {
        const entry = await entryFor(bookPath);
        const { idx } = entry;
        const r = isFresh(idx) ? { ok: true, skipped: true } : await reconcileEntry(entry, bookPath, 'ensure');
        learn(bookPath, readableId(idx));
        books.push({ book_id: idOf(bookPath), path: bookPath, ...r });
      }
      return { ok: books.every((b) => b.ok), books };
    },

    /**
     * Search the books' indexes. A readable but out-of-date index still answers (there are no files to
     * search instead); a missing or unreadable one is skipped and rebuilt in the background.
     */
    async search(q, { bookId, kinds, limit = 20 } = {}) {
      let paths;
      if (bookId !== undefined) {
        const p = await pathOf(bookId);
        if (p === null) return [];
        paths = [p];
      } else {
        paths = await bookPaths();
      }
      const lists = [];
      for (const bookPath of paths) {
        const entry = await entryFor(bookPath);
        try {
          const prefix = prefixOf(bookPath);
          lists.push(
            entry.idx.read((x) => {
              const id = x.bookId();
              learn(bookPath, id);
              return x.search(q, { kinds, limit }).map((h) => ({ book_id: id, ...h, path: h.path === null ? null : prefix + h.path }));
            }, { allowStale: true }),
          );
          if (entry.idx.status().state === 'stale') refreshSoon(entry);
        } catch (e) {
          if (e?.code !== 'INDEX_NOT_READY') throw e;
          refreshSoon(entry);
        }
      }
      // interleave the books' ranked lists, best first within each
      const out = [];
      for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
        for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]);
      }
      return out;
    },

    /** Run `fn(queries, pathPrefix)` on a book's index (stale allowed). Null for an unknown book; throws INDEX_NOT_READY. */
    async query(bookId, fn) {
      const bookPath = await pathOf(bookId);
      if (bookPath === null) return null;
      const entry = await entryFor(bookPath);
      try {
        const value = entry.idx.read((q) => fn(q, prefixOf(bookPath)), { allowStale: true });
        if (entry.idx.status().state === 'stale') refreshSoon(entry);
        return value;
      } catch (e) {
        if (e?.code === 'INDEX_NOT_READY') refreshSoon(entry);
        throw e;
      }
    },
  };
}
