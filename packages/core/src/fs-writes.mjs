// FsRepository write methods. No filesystem access here: every change goes through
// @storyforge/store (the single writer) or @storyforge/manuscript (which uses the store).
import path from 'node:path';
import { validate } from '@storyforge/format';
import { insertScene } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/** Byte offset just past the closing front-matter `---` line (and its terminator), or -1. */
export function frontMatterEnd(buf) {
  let pos = buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const lineAt = (start) => {
    let nl = buf.indexOf(0x0a, start);
    const next = nl < 0 ? buf.length : nl + 1;
    const end = nl < 0 ? buf.length : nl;
    const text = buf.subarray(start, end).toString('latin1').replace(/\r$/, '');
    return { text, next };
  };
  const first = lineAt(pos);
  if (first.text !== '---' || pos >= buf.length) return -1;
  pos = first.next;
  while (pos < buf.length) {
    const line = lineAt(pos);
    if (line.text === '---') return line.next;
    pos = line.next;
  }
  return -1;
}

const errKey = (d) => `${d.code}\0${d.file}\0${d.location}`;

/**
 * @param {{ root: string, getScene: (bookId: string, sceneId: string) => Promise<any>,
 *           afterWrite?: (bookPath: string) => void }} deps  `afterWrite` runs after every successful change
 */
export function createWriteMethods({ root, getScene, afterWrite = () => {} }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));
  const toLibRel = (book, p) => (book.path === '' ? p : `${book.path}/${p}`);
  const toBookRel = (book, p) => (book.path === '' ? p : p.startsWith(`${book.path}/`) ? p.slice(book.path.length + 1) : null);

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, diagnostics: result.diagnostics } : null;
  }

  /** The conflict result: the scene as it is on disk now (null if it is not a live scene). */
  async function conflict(r, bookId, sceneId) {
    const current = sceneId ? await getScene(bookId, sceneId) : null;
    return { ok: false, code: 'CONFLICT', current, ...(r.current ? { current_sha256: r.current.sha256 } : {}) };
  }

  /**
   * Run one store move (archive or restore), then undo it if the library gained a validation error.
   * @param {string} bookId
   * @param {{ op: string, bookRel: (book: any) => string | null, sceneId?: string,
   *           call: (tx: any, rel: string) => Promise<any> }} p
   */
  async function guardedMove(bookId, { op, bookRel, sceneId, call }) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const { book, diagnostics: before } = found;
    const rel = bookRel(book);
    if (rel === null) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(book));
    const known = new Set(before.filter((d) => d.severity === 'error').map(errKey));
    const r = await store.batch(op, { bookId, path: toLibRel(book, rel) }, (tx) => call(tx, rel), {
      verify: async () => {
        const after = (await validate(root)).diagnostics;
        const fresh = after.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
        if (fresh.length) {
          const err = new Error('the change would introduce new errors');
          /** @type {any} */ (err).diagnostics = fresh;
          throw err;
        }
      },
    });
    if (r.ok) {
      afterWrite(book.path);
      return { ok: true, code: 'OK', path: toLibRel(book, r.value.path), sha256: r.value.sha256 };
    }
    if (r.code === 'CONFLICT') return conflict(r, bookId, sceneId);
    if (r.code === 'ROLLED_BACK') {
      return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [], ...(r.rollbackErrors ? { rollbackErrors: r.rollbackErrors } : {}) });
    }
    return fail(r.code, r.message ? { message: r.message } : {});
  }

  return {
    async updateSceneBody(bookId, sceneId, body, { baseSha256 } = {}) {
      if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
      const found = await findBook(bookId);
      const entry = found?.book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!found || !entry) return fail('NOT_FOUND');
      const rel = toBookRel(found.book, entry.path);
      if (rel === null) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      const cur = await store.read(rel);
      if (!cur) return fail('NOT_FOUND');
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
      const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
      const r = await store.write(rel, next, { baseSha256 });
      if (r.ok) {
        afterWrite(found.book.path);
        return { ok: true, code: 'OK', sha256: r.sha256 };
      }
      if (r.code === 'CONFLICT') return conflict(r, bookId, sceneId);
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    async createScene(bookId, args = {}) {
      const found = await findBook(bookId);
      if (!found) return fail('NOT_FOUND');
      const { chapter, act, after, title, slug, body } = args ?? {};
      const r = await insertScene(bookRootOf(found.book), { chapter, act, after, title, slug, body });
      if (!r.ok) return r;
      afterWrite(found.book.path);
      return { ...r, path: toLibRel(found.book, r.path) };
    },

    async archiveScene(bookId, sceneId, { baseSha256 } = {}) {
      const found = await findBook(bookId);
      const entry = found?.book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!found || !entry) return fail('NOT_FOUND');
      return guardedMove(bookId, {
        op: 'archiveScene',
        bookRel: (book) => toBookRel(book, entry.path),
        sceneId,
        call: (tx, rel) => tx.archive(rel, { baseSha256 }),
      });
    },

    restoreScene(bookId, archivedPath, { baseSha256 } = {}) {
      return guardedMove(bookId, {
        op: 'restoreScene',
        bookRel: (book) => (typeof archivedPath === 'string' ? toBookRel(book, archivedPath) : null),
        call: (tx, rel) => tx.restore(rel, { baseSha256 }),
      });
    },

    async recover() {
      const result = await validate(root);
      const report = { completed: [], rolledBack: [], needsAttention: [] };
      const seen = new Set();
      // the library folder has a journal of its own (a new book that was being put in place)
      if (!result.books.some((/** @type {any} */ b) => b.path === '')) {
        seen.add('');
        const r = await (await openStore(root, { recover: false })).recover();
        for (const key of /** @type {const} */ (['completed', 'rolledBack', 'needsAttention'])) {
          for (const item of r[key]) report[key].push({ ...item, book: '' });
        }
      }
      for (const book of result.books) {
        if (seen.has(book.path)) continue;
        seen.add(book.path);
        const store = await openStore(bookRootOf(book), { recover: false });
        const r = await store.recover();
        for (const key of /** @type {const} */ (['completed', 'rolledBack', 'needsAttention'])) {
          for (const item of r[key]) report[key].push({ ...item, book: book.path });
        }
      }
      return report;
    },
  };
}
