// openIndex(bookRoot, { store }): status, build, refresh and read access for one book's index.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex } from './build.mjs';
import { makeQueries } from './queries.mjs';
import { INDEX_FILE, SCHEMA_VERSION } from './schema.mjs';

const notReady = (state) => Object.assign(new Error(`index is not ready (${state})`), { code: 'INDEX_NOT_READY', state });

/** Every .md file below dir, as forward-slash relative paths (dot entries skipped, symlinks not followed). */
function listMarkdown(dir) {
  const out = [];
  const visit = (rel) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(child);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(child);
    }
  };
  visit('');
  return out;
}

/**
 * @param {string} bookRoot
 * @param {{ store: { writeMeta: Function }, libraryRoot?: string }} options
 *   `libraryRoot`: when the book sits inside a library, validation runs over the whole library (series
 *   and cross-book diagnostics) and only this book's part is kept.
 */
export function openIndex(bookRoot, { store, libraryRoot } = /** @type {any} */ ({})) {
  if (!store || typeof store.writeMeta !== 'function') throw new TypeError('openIndex needs { store } from @storyforge/store');
  const root = path.resolve(bookRoot);
  const validateRoot = libraryRoot ? path.resolve(libraryRoot) : root;
  const bookPath = path.relative(validateRoot, root).split(path.sep).join('/');
  const dbFile = path.join(root, '.storyforge', INDEX_FILE);
  /** @type {Map<string, any>} per-file parse cache, so refresh() re-reads only what changed */
  const cache = new Map();
  /** @type {Promise<any> | null} */
  let inflight = null;
  /** @type {Promise<any> | null} */
  let queued = null;

  function openDb() {
    try {
      statSync(dbFile);
    } catch {
      return null;
    }
    return new DatabaseSync(dbFile, { readOnly: true });
  }

  /** The index as it stands against the files, ignoring any build in progress. @param {DatabaseSync | null} db */
  function inspect(db) {
    const base = { built_at: null, schema_version: null, file_count: 0, stale_paths: [] };
    if (!db) return { ...base, state: 'missing' };
    let rows;
    try {
      const meta = new Map(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
      rows = db.prepare('SELECT path, sha256, size, mtime_ms FROM files').all();
      Object.assign(base, {
        built_at: meta.get('built_at') ?? null,
        schema_version: meta.has('schema_version') ? Number(meta.get('schema_version')) : null,
        file_count: rows.length,
      });
    } catch {
      return { ...base, state: 'error' };
    }
    if (base.schema_version !== SCHEMA_VERSION) return { ...base, state: 'stale' };
    const known = new Map(rows.map((r) => [r.path, r]));
    const stale = [];
    let onDisk;
    try {
      onDisk = listMarkdown(root);
    } catch {
      return { ...base, state: 'stale' };
    }
    for (const rel of onDisk) {
      const row = known.get(rel);
      if (!row) {
        stale.push(rel);
        continue;
      }
      known.delete(rel);
      try {
        const abs = path.join(root, ...rel.split('/'));
        const st = statSync(abs);
        if (st.size === row.size && st.mtimeMs === row.mtime_ms) continue;
        if (createHash('sha256').update(readFileSync(abs)).digest('hex') !== row.sha256) stale.push(rel);
      } catch {
        stale.push(rel);
      }
    }
    for (const rel of known.keys()) stale.push(rel);
    stale.sort();
    return { ...base, state: stale.length ? 'stale' : 'fresh', stale_paths: stale };
  }

  function status() {
    let db;
    try {
      db = openDb();
    } catch {
      return { built_at: null, schema_version: null, file_count: 0, stale_paths: [], state: inflight ? 'building' : 'error' };
    }
    try {
      const s = inspect(db);
      return inflight ? { ...s, state: 'building' } : s;
    } finally {
      db?.close();
    }
  }

  /**
   * Run `fn` with the query helpers over a read-only handle (closed afterwards). Throws INDEX_NOT_READY
   * unless the index is fresh. A build in progress does not matter: the old index keeps serving.
   * `allowStale` also serves an index that is readable but out of date (used for search, which has no
   * file-based fallback).
   * @template T
   * @param {(q: ReturnType<typeof makeQueries>) => T} fn
   * @param {{ allowStale?: boolean }} [opts]
   * @returns {T}
   */
  function read(fn, { allowStale = false } = {}) {
    let db;
    try {
      db = openDb();
    } catch {
      throw notReady('error');
    }
    try {
      const s = inspect(db);
      const usable = s.state === 'fresh' || (allowStale && s.state === 'stale' && s.schema_version === SCHEMA_VERSION);
      if (!usable) throw notReady(s.state);
      return fn(makeQueries(/** @type {DatabaseSync} */ (db)));
    } catch (e) {
      if (e?.code === 'INDEX_NOT_READY') throw e;
      throw Object.assign(notReady('error'), { cause: e });
    } finally {
      db?.close();
    }
  }

  async function run(full) {
    const t0 = performance.now();
    try {
      if (full) cache.clear();
      const { bytes, counts } = await buildIndex({ bookRoot: root, validateRoot, bookPath, cache });
      const w = await store.writeMeta(INDEX_FILE, bytes);
      if (!w?.ok) throw Object.assign(new Error(`could not save the index (${w?.code})`), { code: w?.code ?? 'WRITE_FAILED' });
      return { ok: true, ms: performance.now() - t0, counts };
    } catch (e) {
      return { ok: false, ms: performance.now() - t0, code: e?.code ?? 'ERROR', message: String(e?.message ?? e) };
    }
  }

  function start(full) {
    inflight = run(full).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const QUERY_NAMES = ['bookId', 'bookSummary', 'scenes', 'excluded', 'chapters', 'links', 'backlinks', 'mentions', 'diagnostics', 'counts', 'search'];
  const query = Object.fromEntries(QUERY_NAMES.map((name) => [name, (...args) => read((q) => q[name](...args))]));

  return {
    root,
    status,
    read,
    query,
    /** Full rebuild from the files. Concurrent calls share the build already running. */
    rebuild() {
      return inflight ?? start(true);
    },
    /** Incremental: re-reads only files that changed. The result equals a full rebuild. */
    refresh() {
      if (!inflight) return start(false);
      queued ??= inflight.then(() => {
        queued = null;
        return start(false);
      });
      return queued;
    },
  };
}
