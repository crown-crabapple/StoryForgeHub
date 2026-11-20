// The database -> FORMAT-v1 Markdown folder (H0 §5 "Export"). The library files are written exactly as stored, restore points go back to
// `<book>/.storyforge/revisions/<scene>/` with a regenerated index.json, and shared-mode documents go to an optional second folder.
// Sanctioned filesystem reader (see eslint.config.mjs); the writing is done by materialize.mjs.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { materialize } from './materialize.mjs';

/** @param {string} dir @returns {Promise<boolean>} true when the folder does not exist or holds nothing */
async function isEmptyOrMissing(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return true;
    throw e;
  }
}

/**
 * Write the whole library to `out` (and the shared-mode documents to `sharedOut`). Refused when a target folder exists and is not empty.
 * @param {{ store: ReturnType<typeof import('./document-store.mjs').createDocumentStore>, out: string, sharedOut?: string }} o
 * @returns {Promise<{ ok: true, files: number, empty_folders: number, revisions: number, shared_documents: number } | { ok: false, code: 'OUT_NOT_EMPTY', path: string }>}
 */
export async function exportLibrary({ store, out, sharedOut }) {
  const dir = path.resolve(out);
  if (!(await isEmptyOrMissing(dir))) return { ok: false, code: 'OUT_NOT_EMPTY', path: dir };
  if (sharedOut && !(await isEmptyOrMissing(path.resolve(sharedOut)))) return { ok: false, code: 'OUT_NOT_EMPTY', path: path.resolve(sharedOut) };
  const rows = await store.listFiles();
  const revisions = await store.listRevisions();
  const r = await materialize({ store, dir, sharedDir: sharedOut });
  return {
    ok: true,
    files: rows.filter((f) => !f.path.endsWith('/')).length,
    empty_folders: rows.filter((f) => f.path.endsWith('/')).length,
    revisions: revisions.length,
    shared_documents: r.shared ? r.shared.written : 0,
  };
}
