// Helpers for the Phase 1 database-backed server tests (not a test file): import a fixture into a PGlite folder database, then run a personal-mode server in this
// process over `startDatabaseMode` (apps/server/src/db-serve.mjs), the same startup `serve --database` uses. Because the database is in this process, a test
// can read it while the server runs (a PGlite folder cannot be opened by two processes).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStore, importLibrary, migrate, openDatabase } from '../../../packages/db/src/index.mjs';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { startDatabaseMode } from '../src/db-serve.mjs';
import { asMember, asPlugin } from './plugin-helpers.mjs';
import { FIXTURES, close, listen } from './helpers.mjs';

export const HOSTED = path.join(FIXTURES, 'hosted-import');
export const BOOK = 'book_01S5000000000000000000000A';
export const SCENE = 'scene_01S50000000000000000000002';
/** Library-relative folder of the salt-orchard book inside the hosted-import fixture, and its arrival scene. */
export const BOOK_DIR = 'saltmarsh/salt-orchard';
export const SCENE_PATH = `${BOOK_DIR}/manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md`;

const live = [];
/** Stop every server this module started and remove its temp folders (call from `after`). */
export async function closeAll() {
  for (const fn of live.splice(0).reverse()) await fn();
}

/** A fresh temp folder, removed by closeAll. */
export async function tempDir(prefix = 'sf-dbstart-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  live.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fresh `pglite:<folder>` URL in a temp folder. */
export async function freshDatabaseUrl() {
  return `pglite:${path.join(await tempDir('sf-pg-'), 'data')}`;
}

/** Migrate the database at `url` and import the library in `source` (default: the hosted-import fixture) into it; closes the database again. */
export async function importInto(url, { source = HOSTED, libraryId = 'main' } = {}) {
  const db = await openDatabase(url);
  try {
    await migrate(db);
    const store = createDocumentStore(db, libraryId);
    await store.ensureLibrary();
    const r = await importLibrary({ store, source, dryRun: false });
    if (r.ok === false) throw new Error(`import failed: ${r.code} ${r.message ?? ''}`);
    return r;
  } finally {
    await db.close();
  }
}

/** Every file below `root` as relative path -> bytes, skipping dot-entries (caches, the lock, the marker) and the root's `.storyforge`. */
export async function diskFiles(root) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  async function visit(rel) {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(r);
      else out.set(r, await fs.readFile(path.join(root, r)));
    }
  }
  await visit('');
  return out;
}

/**
 * A personal-mode server over a database library. `copy` is the on-disk copy folder (default: a new empty temp folder).
 * @param {{ url: string, libraryId?: string, copy?: string, sharedDir?: string | null, watch?: boolean, profile?: string }} o
 * @returns the server, its port, the database store, the copy folder, the log lines the database mode printed, and `stop()`
 */
export async function bootDb({ url, libraryId = 'main', copy, sharedDir = null, watch = false, profile } = {}) {
  const config = await tempDir('sf-dbstart-config-');
  Object.assign(process.env, { APPDATA: path.join(config, 'AppData'), XDG_CONFIG_HOME: path.join(config, 'xdg') });
  const root = copy ?? (await tempDir('sf-dbstart-copy-'));
  /** @type {string[]} */
  const logs = [];
  const mode = await startDatabaseMode({ url, libraryId, libraryRoot: root, sharedDir, log: (l) => logs.push(l) });
  const repository = createFsRepository(root, { ...(watch ? { debounceMs: 40, maxWaitMs: 150, pollMs: 0 } : { watch: false, pollMs: 0 }), onOutsideChange: mode.onOutsideChange });
  const server = createServer({ repository, profile: profile ?? `dbstart-${process.hrtime.bigint()}`, database: mode.status });
  const port = await listen(server);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await close(server);
    await repository.close?.();
    await mode.close();
  };
  live.push(stop);
  return {
    root, port, server, repository, store: mode.store, db: mode.db, logs, stop, shared: sharedDir,
    member: (method, p, body) => asMember(port, method, p, body),
    plugin: (token, method, p, o) => asPlugin(port, token, method, p, o),
    async grant({ plugin = 'word-frequency', permissions = ['read'], books = 'all' } = {}) {
      const r = await asMember(port, 'POST', '/api/plugins/grants', { plugin, permissions, books });
      if (r.status !== 201) throw new Error(`grant failed: ${r.status} ${r.text}`);
      return r.json;
    },
  };
}
