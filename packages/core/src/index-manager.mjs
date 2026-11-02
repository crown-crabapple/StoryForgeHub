// Per-book indexes for FsRepository. Reads use a book's index only when it is fresh; otherwise the
// repository answers from the files and a refresh runs in the background. No filesystem access here.
import path from 'node:path';
import { discover, isFile, validate } from '@storyforge/format';
import { openIndex } from '@storyforge/index';
import { openStore } from '@storyforge/store';

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
export function createIndexManager(root) {
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

  /** Start a background refresh unless a build is already running. Never throws. */
  function refreshSoon({ idx }) {
    if (idx.status().state === 'building') return;
    idx.refresh().catch(noop);
  }

  /** The folder of a book id; asks validate() once if the id has not been seen. @returns {Promise<string | null>} */
  async function pathOf(bookId) {
    if (idToPath.has(bookId)) return /** @type {string} */ (idToPath.get(bookId));
    const result = await validate(root);
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
    pathOf,
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
            return fn(q, summary);
          }),
        };
      } catch (e) {
        if (e?.code !== 'INDEX_NOT_READY') throw e;
        if (e.state === 'other-context') entry.idx.refresh().catch(noop);
        else refreshSoon(entry);
        return null;
      }
    },

    /** Called after a successful write: refresh that book's index in the background. */
    afterWrite(bookPath) {
      entryFor(bookPath).then((e) => e.idx.refresh().catch(noop), noop);
    },

    /** The files path answered for this book: make sure its index gets built. */
    warm(bookPath, bookId) {
      learn(bookPath, bookId);
      entryFor(bookPath).then((e) => {
        if (!isFresh(e.idx)) refreshSoon(e);
      }, noop);
    },

    async status(bookId) {
      const one = async (bookPath) => {
        const { idx } = await entryFor(bookPath);
        return { book_id: idOf(bookPath), path: bookPath, ...idx.status() };
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
        const { idx } = await entryFor(bookPath);
        const r = await idx.rebuild();
        if (r.ok) learn(bookPath, readableId(idx));
        books.push({ book_id: idOf(bookPath), path: bookPath, ...r });
      }
      return { ok: books.every((b) => b.ok), books };
    },

    /** Build or refresh every index that is not fresh. Resolves when done. */
    async ensure() {
      const books = [];
      for (const bookPath of await bookPaths()) {
        const { idx } = await entryFor(bookPath);
        const r = isFresh(idx) ? { ok: true, skipped: true } : await idx.refresh();
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
