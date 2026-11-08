// FsRepository workspace docs (M12 W2): planning/workspace/*.md, planning/state/chapter-NN/*.md and planning/development/*.md, the generic `doc` kind. Reads come from the
// validated documents and the files on every call (nothing is kept in the index), so a doc edited outside the app shows up on the next read. Writes go through
// @storyforge/manuscript (the store: sha-checked, lockable, one opId each so Undo works). No filesystem access here: `readFileAt` is what fs-repository.mjs passes in.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { appendWorkspaceDoc, archiveWorkspaceDoc, isWorkspaceAddress, lockWorkspaceDocs, restoreWorkspaceDoc, saveWorkspaceDoc, setupWorkspace, workspaceInfo } from '@storyforge/manuscript';
import { frontMatterEnd } from './fs-writes.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const ADDRESS_OF_RE = /^planning\/(.+)\.md$/;

/**
 * @param {{ root: string, readValidate?: () => Promise<any>, readFileAt: (libRel: string) => Promise<{ bytes: Buffer, mtimeMs: number } | null>, afterWrite?: (bookPath: string) => void }} deps
 */
export function createWorkspaceMethods({ root, readValidate = () => validate(root), readFileAt, afterWrite = () => {} }) {
  async function load(bookId) {
    const result = await readValidate();
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    return { result, book, prefix: book.path ? `${book.path}/` : '', bookRoot: book.path === '' ? root : path.join(root, ...book.path.split('/')) };
  }

  /** Every workspace doc of the book (live and archived) as rows, sorted by address. */
  async function rowsOf(ctx) {
    const rows = [];
    for (const d of extractDocs(ctx.result, ctx.book.path)) {
      if (d.kind !== 'doc') continue;
      const m = ADDRESS_OF_RE.exec(d.rel.replace(/^archive\//, ''));
      if (!m || !isWorkspaceAddress(m[1])) continue;
      const f = await readFileAt(`${ctx.prefix}${d.rel}`);
      if (!f) continue;
      const end = frontMatterEnd(f.bytes);
      const info = workspaceInfo(m[1]);
      rows.push({
        archived: d.archived === true,
        bytes: f.bytes,
        end,
        row: {
          path: m[1],
          title: typeof d.fm.title === 'string' ? d.fm.title : m[1],
          workspace: info.workspace,
          chapter: info.chapter,
          locked: d.fm.locked === true,
          sha256: sha(f.bytes),
          updated_at: new Date(f.mtimeMs).toISOString(),
        },
      });
    }
    return rows.sort((a, b) => (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0));
  }

  const run = async (bookId, call, args) => {
    const ctx = await load(bookId);
    if (!ctx) return fail('NOT_FOUND');
    const r = await call(ctx.bookRoot, args);
    if (r.ok && !r.dryRun && r.changes?.length) afterWrite(ctx.book.path);
    return r;
  };

  return {
    /** GET /api/books/:b/workspace/docs: { docs: [{ path, title, workspace, chapter, locked, sha256, updated_at }], archived: [same] }. Null when there is no such book. */
    async listWorkspaceDocs(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const rows = await rowsOf(ctx);
      return { docs: rows.filter((r) => !r.archived).map((r) => r.row), archived: rows.filter((r) => r.archived).map((r) => r.row) };
    },

    /** One live doc: { path, title, workspace, chapter, locked, sha256, body } (body exactly as on disk, sha256 of the whole file). Null when there is no such book or doc. */
    async getWorkspaceDoc(bookId, addr) {
      if (!isWorkspaceAddress(addr)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      const hit = (await rowsOf(ctx)).find((r) => !r.archived && r.row.path === addr);
      if (!hit) return null;
      const row = { path: hit.row.path, title: hit.row.title, workspace: hit.row.workspace, chapter: hit.row.chapter, locked: hit.row.locked, sha256: hit.row.sha256 };
      return { ...row, body: hit.bytes.subarray(hit.end < 0 ? 0 : hit.end).toString('utf8') };
    },

    /** Create or update a doc. CONFLICT carries `current: { sha256, body }`; a locked doc is LOCKED. */
    saveWorkspaceDoc: (bookId, args) => run(bookId, saveWorkspaceDoc, args),
    /** Append a block (creates the doc when missing). */
    appendWorkspaceDoc: (bookId, args) => run(bookId, appendWorkspaceDoc, args),
    /** Lock or unlock one doc (`path`) or a state/chapter-NN folder (`prefix`). */
    lockWorkspaceDocs: (bookId, args) => run(bookId, lockWorkspaceDocs, args),
    archiveWorkspaceDoc: (bookId, args) => run(bookId, archiveWorkspaceDoc, args),
    restoreWorkspaceDoc: (bookId, args) => run(bookId, restoreWorkspaceDoc, args),
    /** Create the starter docs that do not exist yet. */
    setupWorkspace: (bookId, args) => run(bookId, setupWorkspace, args),
  };
}
