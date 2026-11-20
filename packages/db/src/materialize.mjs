// Make an on-disk folder match the database exactly (H0 §2.0 "the on-disk copy"). Writes what is missing or different, removes what the
// database does not have, and leaves every `.storyforge/` cache alone except `.storyforge/revisions/`, which is restored from the database.
// Sanctioned filesystem reader and writer (see eslint.config.mjs). Every file is written atomically (temporary file, then rename).
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './document-store.mjs';

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([a-z]{1,20})/;

/** @param {string} a @param {string} b */
const join = (a, b) => (a ? `${a}/${b}` : b);
const abs = (dir, rel) => path.join(dir, ...rel.split('/').filter(Boolean));

/** Write bytes atomically: a temporary file next to the target, then a rename. @param {string} target @param {Buffer} bytes */
async function atomicWrite(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.sf-tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * What is on disk below `dir`: files (relative path to sha256, '' for a non-file such as a symlink) and folders. `.storyforge/` is not
 * entered, except `.storyforge/revisions/`. Symlinks are never followed.
 * @param {string} dir
 * @param {{ topLevelOnly?: boolean }} [o]
 */
async function scan(dir, { topLevelOnly = false } = {}) {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  /** @param {string} rel @param {boolean} inRevisions */
  async function visit(rel, inRevisions) {
    let entries;
    try {
      entries = await readdir(abs(dir, rel), { withFileTypes: true });
    } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const childRel = join(rel, e.name);
      if (e.name.startsWith('.') && !inRevisions && !(e.name === '.storyforge' && e.isDirectory() && !e.isSymbolicLink())) continue; // dot-entries are never ours
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (topLevelOnly) continue;
        if (e.name === '.storyforge') {
          await visitRevisionsRoot(childRel);
        } else {
          dirs.add(childRel);
          await visit(childRel, inRevisions);
        }
      } else if (e.isFile()) {
        files.set(childRel, sha256(await readFile(abs(dir, childRel))));
      } else {
        files.set(childRel, ''); // a symlink or other special file: replaced if the database has the path, else removed
      }
    }
  }
  /** @param {string} storyforgeRel */
  async function visitRevisionsRoot(storyforgeRel) {
    const rel = `${storyforgeRel}/revisions`;
    const st = await lstat(abs(dir, rel)).catch(() => null);
    if (st?.isDirectory()) await visit(rel, true);
  }
  await visit('', false);
  return { files, dirs };
}

/** The `index.json` of one scene's restore points, in the format packages/store reads: entries oldest first. */
function indexFor(rows) {
  const entries = rows
    .map((r) => {
      const m = r.meta && typeof r.meta === 'object' ? r.meta : {};
      const s = STAMP_RE.exec(r.file);
      const at = typeof m.at === 'string' ? m.at : s ? `${s[1]}-${s[2]}-${s[3]}T${s[4]}:${s[5]}:${s[6]}.000Z` : new Date(0).toISOString();
      /** @type {Record<string, unknown>} */
      const e = { file: r.file, at, reason: typeof m.reason === 'string' ? m.reason : (s?.[7] ?? 'manual'), sha256: sha256(r.bytes), words: Number.isInteger(m.words) ? m.words : 0 };
      if (typeof m.label === 'string' && m.label.trim() !== '') e.label = m.label;
      return e;
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  return Buffer.from(`${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * Bring `dir` to exactly the state `desired` describes.
 * @param {string} dir
 * @param {{ files: Map<string, Buffer | (() => Promise<Buffer>)>, sha: Map<string, string>, markers: Set<string>, }} desired
 * @param {{ topLevelOnly?: boolean }} [o]
 */
async function reconcile(dir, desired, o) {
  await mkdir(dir, { recursive: true });
  const have = await scan(dir, o);
  let written = 0;
  let removed = 0;
  let unchanged = 0;
  const rm = async (rel) => {
    await unlink(abs(dir, rel)).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    have.files.delete(rel);
    removed++;
  };

  // a file where a folder belongs (a parent of a wanted path, or a wanted empty folder)
  const wantedDirs = new Set(desired.markers);
  for (const rel of desired.sha.keys()) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) wantedDirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of wantedDirs) if (have.files.has(d)) await rm(d);
  // a folder where a file belongs: clear it out
  for (const rel of desired.sha.keys()) {
    if (!have.dirs.has(rel)) continue;
    for (const f of [...have.files.keys()].filter((x) => x.startsWith(`${rel}/`))) await rm(f);
    for (const d of [...have.dirs].filter((x) => x === rel || x.startsWith(`${rel}/`)).sort((a, b) => b.length - a.length)) {
      await rmdir(abs(dir, d)).catch(() => {});
      have.dirs.delete(d);
    }
  }

  for (const [rel, want] of [...desired.sha].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (have.files.get(rel) === want) {
      unchanged++;
      continue;
    }
    const src = desired.files.get(rel);
    const bytes = typeof src === 'function' ? await src() : src;
    if (!bytes) continue;
    await atomicWrite(abs(dir, rel), bytes);
    written++;
  }
  for (const rel of [...have.files.keys()].sort()) if (!desired.sha.has(rel)) await rm(rel);

  if (o?.topLevelOnly) return { written, removed, unchanged };
  for (const m of [...desired.markers].sort()) {
    if (!(await lstat(abs(dir, m)).catch(() => null))) {
      await mkdir(abs(dir, m), { recursive: true });
      written++;
    }
  }
  // stale, empty folders, deepest first (a folder that still holds anything, such as a .storyforge cache, stays)
  for (const rel of [...have.dirs].sort((a, b) => b.length - a.length)) {
    if (wantedDirs.has(rel)) continue;
    try {
      await rmdir(abs(dir, rel));
      removed++;
    } catch (e) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT', 'EPERM', 'EBUSY'].includes(/** @type {any} */ (e).code)) throw e;
    }
  }
  return { written, removed, unchanged };
}

/**
 * Make `dir` match the library in `store` exactly, and `sharedDir` match the shared-mode documents of `sharedStore` (default: `store`).
 * Counts: `written` and `unchanged` count files (and new empty folders), `removed` counts files and folders.
 * @param {{ store: ReturnType<typeof import('./document-store.mjs').createDocumentStore>, dir?: string, sharedStore?: ReturnType<typeof import('./document-store.mjs').createDocumentStore>, sharedDir?: string }} o
 * @returns {Promise<{ written: number, removed: number, unchanged: number, shared?: { written: number, removed: number, unchanged: number } }>}
 */
export async function materialize({ store, dir, sharedStore, sharedDir }) {
  const root = dir ? path.resolve(dir) : null; // without `dir` only the shared documents are materialized (the shared-mode CLIs)
  /** @type {Map<string, Buffer | (() => Promise<Buffer>)>} */
  const files = new Map();
  /** @type {Map<string, string>} */
  const sha = new Map();
  /** @type {Set<string>} */
  const markers = new Set();
  for (const f of await store.listFiles()) {
    if (f.path.endsWith('/')) {
      markers.add(f.path.slice(0, -1));
    } else {
      sha.set(f.path, f.sha256 ?? '');
      files.set(f.path, async () => {
        const r = await store.readFile(f.path);
        if (!r) throw new Error(`${f.path} vanished from the database while materializing`);
        return r.bytes;
      });
    }
  }
  /** @type {Map<string, any[]>} */
  const scenes = new Map();
  for (const r of await store.listRevisions()) {
    const k = `${r.book_path}\0${r.scene_id}`;
    if (!scenes.has(k)) scenes.set(k, []);
    scenes.get(k)?.push(r);
    const rel = `${join(r.book_path, '.storyforge')}/revisions/${r.scene_id}/${r.file}`;
    files.set(rel, r.bytes);
    sha.set(rel, sha256(r.bytes));
  }
  for (const [k, rows] of scenes) {
    const [bookPath, sceneId] = k.split('\0');
    const rel = `${join(bookPath, '.storyforge')}/revisions/${sceneId}/index.json`;
    const bytes = indexFor(rows);
    files.set(rel, bytes);
    sha.set(rel, sha256(bytes));
  }
  const result = root ? await reconcile(root, { files, sha, markers }) : { written: 0, removed: 0, unchanged: 0 };

  if (sharedDir) {
    const from = sharedStore ?? store;
    /** @type {Map<string, Buffer>} */
    const docs = new Map();
    for (const name of await from.listShared()) {
      const bytes = await from.readShared(name);
      if (bytes) docs.set(name, bytes);
      else {
        const lines = await from.readSharedLines(name);
        docs.set(name, Buffer.from(lines.length ? `${lines.join('\n')}\n` : ''));
      }
    }
    const shaMap = new Map([...docs].map(([n, b]) => [n, sha256(b)]));
    result.shared = await reconcile(path.resolve(sharedDir), { files: docs, sha: shaMap, markers: new Set() }, { topLevelOnly: true });
  }
  return result;
}

/**
 * Before the shared-data folder is made to match the database: refuse when the database holds no shared documents but the folder holds
 * files. Those are real accounts, invites and an audit log that were never imported, and materializing would delete them.
 * @param {{ dir: string, store: { listShared: () => Promise<string[]> } }} o
 * @returns {Promise<{ ok: true } | { ok: false, code: 'SHARED_NOT_IMPORTED', files: string[] }>}
 */
export async function claimSharedDir({ dir, store }) {
  if ((await store.listShared()).length > 0) return { ok: true };
  let names = [];
  try {
    names = (await readdir(path.resolve(dir), { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  return names.length ? { ok: false, code: 'SHARED_NOT_IMPORTED', files: names.sort() } : { ok: true };
}

/**
 * Claim `dir` as the on-disk copy of library `libraryId`: refuse a folder that is the copy of another library, or that holds files (anything not
 * starting with a dot) but no marker (a real Markdown library must never be overwritten); otherwise write or refresh the marker
 * `<dir>/.storyforge/db-copy.json` (`{ library_id, database }`, the database URL already redacted). Creates `dir` if it is missing.
 * @param {{ dir: string, libraryId: string, database: string }} o
 * @returns {Promise<{ ok: true } | { ok: false, code: 'OTHER_LIBRARY', library_id: unknown } | { ok: false, code: 'NOT_A_COPY' }>}
 */
export async function claimCopy({ dir, libraryId, database }) {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });
  const markerPath = path.join(root, '.storyforge', 'db-copy.json');
  /** @type {any} */
  let marker = null;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  if (marker && typeof marker === 'object' && typeof marker.library_id === 'string') {
    if (marker.library_id !== libraryId) return { ok: false, code: 'OTHER_LIBRARY', library_id: marker.library_id };
  } else {
    marker = null;
    if ((await readdir(root)).some((n) => !n.startsWith('.'))) return { ok: false, code: 'NOT_A_COPY' };
  }
  if (!marker || marker.database !== database) await atomicWrite(markerPath, Buffer.from(`${JSON.stringify({ library_id: libraryId, database }, null, 2)}\n`));
  return { ok: true };
}
