// Shared test helpers: an in-memory migrated database, a temp copy of the hosted-import fixture, and a hash of a whole folder.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocumentStore, migrate, openDatabase } from '../src/index.mjs';

export const FIXTURE = fileURLToPath(new URL('../../format/fixtures/hosted-import/', import.meta.url));
export const expected = JSON.parse(await readFile(path.join(FIXTURE, 'expected-import.json'), 'utf8'));

/** @returns {Promise<{ db: any, store: any, close: () => Promise<void> }>} */
export async function openStore(libraryId = 'main') {
  const db = await openDatabase('pglite:memory');
  await migrate(db);
  const store = createDocumentStore(db, libraryId);
  await store.ensureLibrary();
  return { db, store, close: () => db.close() };
}

/** @param {string} prefix */
export const tempDir = (prefix = 'sf-db-test-') => mkdtemp(path.join(os.tmpdir(), prefix));
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

/** A temp copy of the fixture. Returns the library folder and its shared-data folder (inside the copy). */
export async function copyFixture() {
  const dir = await tempDir();
  await cp(FIXTURE, dir, { recursive: true });
  return { dir, sharedData: path.join(dir, 'shared-data') };
}

/** Every file and folder below `dir` (dot-entries included): relative path -> sha256 of the bytes ('dir' for a folder). */
export async function hashTree(dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  async function visit(rel) {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.set(`${r}/`, 'dir');
        await visit(r);
      } else {
        out.set(r, createHash('sha256').update(await readFile(path.join(dir, r))).digest('hex'));
      }
    }
  }
  await visit('');
  return out;
}

/** Row counts of every table the importer can write. */
export async function countRows(db) {
  const out = {};
  for (const t of ['library_file', 'library_op', 'library_trash', 'scene_revision', 'shared_doc', 'shared_line', 'import_receipt']) {
    out[t] = Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

/** path -> sha256 for every file row (folder markers as 'dir'). */
export async function fileSet(store) {
  return Object.fromEntries((await store.listFiles()).map((f) => [f.path, f.sha256 ?? 'dir']));
}
