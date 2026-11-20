// The Phase 1 document store (H0 §2.0): every library file, the change log, restore points and the shared-mode files.
// `applyOp` is the one write path for library files. It runs in a single transaction and checks every path's current sha256
// against what the caller saw, so a write either lands whole, with its change-log row and trash copies, or not at all.
import { createHash } from 'node:crypto';
import { parseText } from '@storyforge/format';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buf = (v) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v));
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/** A write whose base no longer matches the database. */
export class ConflictError extends Error {
  /** @param {string} path @param {string | null} current */
  constructor(path, current) {
    super(`conflict on ${path}`);
    this.code = 'CONFLICT';
    this.path = path;
    this.current_sha256 = current;
  }
}

/** Library paths: relative, forward slashes, no '.', '..' or empty segments, never under .storyforge/. A folder marker ends in '/'. @param {unknown} p */
export function checkPath(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return segs[0].toLowerCase() !== '.storyforge';
}

/**
 * Columns derived from a Markdown file's front matter, for querying. Never fails: an unparsable file just has none.
 * @param {string} path @param {Buffer} bytes
 * @returns {{ schema: string | null, doc_id: string | null, front_matter: string | null }}
 */
export function derive(path, bytes) {
  const none = { schema: null, doc_id: null, front_matter: null };
  if (!path.endsWith('.md')) return none;
  try {
    const parsed = parseText(bytes.toString('utf8'));
    if (parsed.status !== 'ok' || !parsed.fm || typeof parsed.fm !== 'object') return none;
    const fm = parsed.fm;
    return {
      schema: typeof fm.schema === 'string' ? fm.schema : null,
      doc_id: typeof fm.id === 'string' ? fm.id : null,
      front_matter: JSON.stringify(fm),
    };
  } catch {
    return none;
  }
}

/**
 * @param {import('./connection.mjs').Database} db
 * @param {string} libraryId
 */
export function createDocumentStore(db, libraryId) {
  if (typeof libraryId !== 'string' || !libraryId) throw new Error('libraryId is required');
  const L = libraryId;

  return {
    db,
    libraryId: L,

    /** Create the library row if it is missing. */
    async ensureLibrary(name = L) {
      await db.query('INSERT INTO library (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [L, name]);
    },

    /** True when the library holds no file rows at all (an import target must be empty). */
    async isEmpty() {
      const r = await db.query('SELECT 1 FROM library_file WHERE library_id = $1 LIMIT 1', [L]);
      return r.rows.length === 0;
    },

    /**
     * Apply one write operation.
     * `files`: each path's state as the caller saw it (`before_sha256`, null = "must not exist") and its new bytes (null = remove).
     * `dirs`: empty-folder markers to add or remove (paths ending in '/'); no base check.
     * @param {{ opId: string, op: string, args?: any, actor?: any,
     *   files: { path: string, before_sha256: string | null, bytes: Buffer | null }[],
     *   dirs?: { add?: string[], remove?: string[] } }} change
     * @returns {Promise<{ ok: true } | { ok: false, code: 'CONFLICT', path: string, current_sha256: string | null } | { ok: false, code: 'BAD_ARGS', message: string }>}
     */
    async applyOp({ opId, op, args = null, actor = null, files, dirs = {} }) {
      if (typeof opId !== 'string' || !opId || typeof op !== 'string' || !op) return { ok: false, code: 'BAD_ARGS', message: 'opId and op are required' };
      if (!Array.isArray(files)) return { ok: false, code: 'BAD_ARGS', message: 'files must be an array' };
      const seen = new Set();
      for (const f of files) {
        if (!checkPath(f.path) || f.path.endsWith('/')) return { ok: false, code: 'BAD_ARGS', message: `bad path ${JSON.stringify(f.path)}` };
        if (seen.has(f.path)) return { ok: false, code: 'BAD_ARGS', message: `path ${f.path} appears twice` };
        seen.add(f.path);
        if (f.bytes !== null && !Buffer.isBuffer(f.bytes)) return { ok: false, code: 'BAD_ARGS', message: 'bytes must be a Buffer or null' };
      }
      for (const d of [...(dirs.add ?? []), ...(dirs.remove ?? [])]) {
        if (!checkPath(d) || !d.endsWith('/')) return { ok: false, code: 'BAD_ARGS', message: `bad folder ${JSON.stringify(d)}` };
      }
      try {
        await db.transaction(async (tx) => {
          const changed = [];
          for (const f of files) {
            const cur = (await tx.query('SELECT sha256, bytes FROM library_file WHERE library_id = $1 AND path = $2 FOR UPDATE', [L, f.path])).rows[0];
            const curSha = cur?.sha256 ?? null;
            if (curSha !== (f.before_sha256 ?? null)) throw new ConflictError(f.path, curSha);
            changed.push({ f, curBytes: buf(cur?.bytes) });
          }
          const log = changed.map(({ f }) => ({ path: f.path, before_sha256: f.before_sha256 ?? null, after_sha256: f.bytes ? sha256(f.bytes) : null }));
          await tx.query('INSERT INTO library_op (op_id, library_id, op, args, actor, files) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)', [
            opId, L, op, json(args), json(actor), JSON.stringify(log),
          ]);
          for (const { f, curBytes } of changed) {
            if (curBytes) await tx.query('INSERT INTO library_trash (op_id, path, bytes) VALUES ($1, $2, $3)', [opId, f.path, curBytes]);
            if (f.bytes === null) {
              await tx.query('DELETE FROM library_file WHERE library_id = $1 AND path = $2', [L, f.path]);
            } else {
              const d = derive(f.path, f.bytes);
              await tx.query(
                `INSERT INTO library_file (library_id, path, bytes, sha256, size, schema, doc_id, front_matter, updated_at, updated_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9::jsonb)
                 ON CONFLICT (library_id, path) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
                   schema = EXCLUDED.schema, doc_id = EXCLUDED.doc_id, front_matter = EXCLUDED.front_matter,
                   updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
                [L, f.path, f.bytes, sha256(f.bytes), f.bytes.length, d.schema, d.doc_id, d.front_matter, json(actor)],
              );
              // a folder that now holds a file is no longer an empty-folder marker
              const parts = f.path.split('/');
              for (let i = parts.length - 1; i > 0; i--) {
                await tx.query('DELETE FROM library_file WHERE library_id = $1 AND path = $2', [L, `${parts.slice(0, i).join('/')}/`]);
              }
            }
          }
          for (const d of dirs.add ?? []) {
            const inside = await tx.query('SELECT 1 FROM library_file WHERE library_id = $1 AND path LIKE $2 AND path <> $3 LIMIT 1', [L, `${likeEscape(d)}%`, d]);
            if (inside.rows.length === 0) {
              await tx.query('INSERT INTO library_file (library_id, path, bytes, sha256, size) VALUES ($1, $2, NULL, NULL, 0) ON CONFLICT (library_id, path) DO NOTHING', [L, d]);
            }
          }
          for (const d of dirs.remove ?? []) await tx.query('DELETE FROM library_file WHERE library_id = $1 AND path = $2', [L, d]);
        });
      } catch (e) {
        if (e instanceof ConflictError) return { ok: false, code: 'CONFLICT', path: e.path, current_sha256: e.current_sha256 };
        throw e;
      }
      return { ok: true };
    },

    /** Every file row (and folder marker) without bytes, sorted by path. @returns {Promise<{ path: string, sha256: string | null, size: number }[]>} */
    async listFiles() {
      return (await db.query('SELECT path, sha256, size FROM library_file WHERE library_id = $1 ORDER BY path', [L])).rows;
    },

    /** Bytes and sha256 of one file, or null. @param {string} path */
    async readFile(path) {
      const r = (await db.query('SELECT bytes, sha256 FROM library_file WHERE library_id = $1 AND path = $2 AND bytes IS NOT NULL', [L, path])).rows[0];
      return r ? { bytes: buf(r.bytes), sha256: r.sha256 } : null;
    },

    /** The change log, newest first. @param {{ limit?: number }} [o] */
    async listOps({ limit = 100 } = {}) {
      return (await db.query('SELECT op_id, op, args, actor, at, files FROM library_op WHERE library_id = $1 ORDER BY at DESC, op_id DESC LIMIT $2', [L, limit])).rows;
    },

    /** A trash copy: the bytes `opId` replaced or removed at `path`, or null. */
    async readTrash(opId, path) {
      const r = (await db.query('SELECT t.bytes FROM library_trash t JOIN library_op o ON o.op_id = t.op_id WHERE o.library_id = $1 AND t.op_id = $2 AND t.path = $3', [L, opId, path])).rows[0];
      return r ? buf(r.bytes) : null;
    },

    // ---- restore points
    async putRevision(bookPath, sceneId, file, bytes, meta = null) {
      await db.query(
        `INSERT INTO scene_revision (library_id, book_path, scene_id, file, bytes, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (library_id, book_path, scene_id, file) DO UPDATE SET bytes = EXCLUDED.bytes, meta = EXCLUDED.meta`,
        [L, bookPath, sceneId, file, bytes, json(meta)],
      );
    },
    async deleteRevisions(bookPath, sceneId, files) {
      if (!files.length) return;
      await db.query('DELETE FROM scene_revision WHERE library_id = $1 AND book_path = $2 AND scene_id = $3 AND file = ANY($4::text[])', [L, bookPath, sceneId, files]);
    },
    /** @returns {Promise<{ book_path: string, scene_id: string, file: string, bytes: Buffer, meta: any }[]>} */
    async listRevisions({ bookPath, sceneId } = {}) {
      const r = await db.query(
        `SELECT book_path, scene_id, file, bytes, meta FROM scene_revision WHERE library_id = $1
           AND ($2::text IS NULL OR book_path = $2) AND ($3::text IS NULL OR scene_id = $3) ORDER BY book_path, scene_id, file`,
        [L, bookPath ?? null, sceneId ?? null],
      );
      return r.rows.map((x) => ({ ...x, bytes: buf(x.bytes) }));
    },

    // ---- shared-mode files
    async readShared(name) {
      const r = (await db.query('SELECT bytes FROM shared_doc WHERE library_id = $1 AND name = $2', [L, name])).rows[0];
      return r ? buf(r.bytes) : null;
    },
    async writeShared(name, bytes) {
      await db.query(
        'INSERT INTO shared_doc (library_id, name, bytes, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (library_id, name) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = now()',
        [L, name, bytes],
      );
    },
    /** Remove a shared document (the undo of a first-ever write). */
    async deleteShared(name) {
      await db.query('DELETE FROM shared_doc WHERE library_id = $1 AND name = $2', [L, name]);
    },
    /** Append one line to a log; seq is assigned in order. @returns {Promise<number>} the line's seq (for `deleteSharedLine`) */
    async appendSharedLine(name, line) {
      return db.transaction(async (tx) => {
        const r = await tx.query('SELECT coalesce(max(seq), 0) + 1 AS next FROM shared_line WHERE library_id = $1 AND name = $2', [L, name]);
        const seq = Number(r.rows[0].next);
        await tx.query('INSERT INTO shared_line (library_id, name, seq, line) VALUES ($1, $2, $3, $4)', [L, name, seq, line]);
        return seq;
      });
    },
    /** Remove one appended line (the undo of an append whose disk step failed). */
    async deleteSharedLine(name, seq) {
      await db.query('DELETE FROM shared_line WHERE library_id = $1 AND name = $2 AND seq = $3', [L, name, seq]);
    },
    /** @returns {Promise<string[]>} */
    async readSharedLines(name) {
      return (await db.query('SELECT line FROM shared_line WHERE library_id = $1 AND name = $2 ORDER BY seq', [L, name])).rows.map((r) => r.line);
    },
    /** @returns {Promise<string[]>} names of the stored shared documents and logs */
    async listShared() {
      const docs = (await db.query('SELECT name FROM shared_doc WHERE library_id = $1', [L])).rows.map((r) => r.name);
      const logs = (await db.query('SELECT DISTINCT name FROM shared_line WHERE library_id = $1', [L])).rows.map((r) => r.name);
      return [...new Set([...docs, ...logs])].sort();
    },

    // ---- import receipts
    async addImportReceipt({ id, sourcePath, fingerprint, report }) {
      await db.query('INSERT INTO import_receipt (id, library_id, source_path, fingerprint, report) VALUES ($1, $2, $3, $4, $5::jsonb)', [id, L, sourcePath, fingerprint, JSON.stringify(report)]);
    },
    async findImportReceipt(fingerprint) {
      return (await db.query('SELECT id, source_path, fingerprint, at, report FROM import_receipt WHERE library_id = $1 AND fingerprint = $2 ORDER BY at DESC LIMIT 1', [L, fingerprint])).rows[0] ?? null;
    },
  };
}

/** Escape LIKE wildcards in a literal prefix. @param {string} s */
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
