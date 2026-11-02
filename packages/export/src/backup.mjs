// Portable backup (a zip of the book folder) and restore into a new folder.
//
// Zip layout: every file of the book except `.storyforge/**` and (unless asked) `provenance/**`, stored as `<book folder name>/<path>`,
// byte for byte. The manifest is the zip comment: { "storyforge_backup": 1, "book_id", "files": <count>, "sha256": <hash> } where the hash is
// the SHA-256 of the text lines `<path relative to the book>\t<sha256 of the file>\n`, sorted by path (code point order).
//
// Restore refuses the whole archive before writing a single byte (every check below runs first), then writes into a hidden temp folder
// beside the target and renames it into place (writeNewTree in @storyforge/store, the only package that writes files).
import crypto from 'node:crypto';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadDoc, validate } from '@storyforge/format';
import { writeNewTree, writeOutFile } from '@storyforge/store';
import { ExportError } from './text.mjs';
import { ZipError, ZipTooManyError, listZip, readEntry, writeZip } from './zip.mjs';

export const DEFAULT_RESTORE_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

/** Thrown when a backup cannot be restored. `code`: RESTORE_TARGET_NOT_EMPTY, RESTORE_UNSAFE_ENTRY, RESTORE_LIMIT_EXCEEDED, RESTORE_UNSUPPORTED, BACKUP_CORRUPT. */
export class RestoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {{ rel: string, hash: string }[]} list */
function manifestHash(list) {
  const lines = [...list].sort((a, b) => byCodePoint(a.rel, b.rel)).map((f) => `${f.rel}\t${f.hash}\n`);
  return sha256(lines.join(''));
}

// ----------------------------------------------------------------------------------------------- backup

/**
 * @param {string} dir @param {string} rel @param {(rel: string) => boolean} skip @param {string[]} out
 */
async function walkFiles(dir, rel, skip, out) {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (skip(childRel)) continue;
    if (e.isDirectory()) await walkFiles(dir, childRel, skip, out);
    else if (e.isFile()) out.push(childRel);
  }
}

/** @param {Date | number | string | undefined} now */
function stamp(now) {
  const d = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new ExportError('BAD_OPTION', 'now is not a date');
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * @param {string} bookRoot
 * @param {{ includeProvenance?: boolean, now?: Date | number | string }} [options]
 * @returns {Promise<{ bytes: Buffer, filename: string, files: number }>}
 */
export async function createBackup(bookRoot, { includeProvenance = false, now } = {}) {
  const root = path.resolve(bookRoot);
  const { doc } = await loadDoc(path.join(root, 'book.md'), 'book.md', 'book.md', () => {});
  if (!doc || doc.kind !== 'book') throw new ExportError('NOT_A_BOOK', `no readable book.md in ${root}`);
  const folder = path.basename(root);
  /** @type {string[]} */
  const rels = [];
  await walkFiles(root, '', (rel) => rel === '.storyforge' || (!includeProvenance && rel === 'provenance'), rels);
  rels.sort(byCodePoint);
  const list = [];
  const entries = [];
  for (const rel of rels) {
    const data = await readFile(path.join(root, ...rel.split('/')));
    list.push({ rel, hash: sha256(data) });
    entries.push({ name: `${folder}/${rel}`, data });
  }
  const manifest = {
    storyforge_backup: 1,
    book_id: typeof doc.fm.id === 'string' ? doc.fm.id : null,
    files: rels.length,
    sha256: manifestHash(list),
  };
  const slug = typeof doc.fm.slug === 'string' && doc.fm.slug !== '' ? doc.fm.slug : folder;
  return { bytes: writeZip(entries, { comment: JSON.stringify(manifest) }), filename: `${slug}-backup-${stamp(now)}.zip`, files: rels.length };
}

// ----------------------------------------------------------------------------------------------- restore

/** The manifest JSON in the zip comment, or null when there is none. @param {string} comment @returns {any} */
function parseManifest(comment) {
  try {
    return JSON.parse(comment);
  } catch {
    return null;
  }
}

/** Why an entry name is unsafe, or null. @param {string} name @param {string} targetDir */
function unsafeName(name, targetDir) {
  if (name === '') return 'empty name';
  if (name.includes('\0')) return 'NUL in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter';
  const segs = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  for (const s of segs) {
    if (s === '' || s === '.') return 'empty or "." segment';
    if (s === '..') return '".." segment';
    if (s.includes(':')) return 'colon in name';
    if (/[. ]$/.test(s)) return 'segment ends with a dot or space';
  }
  const resolved = path.resolve(targetDir, ...segs);
  const rel = path.relative(path.resolve(targetDir), resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return 'resolves outside the target';
  return null;
}

/** @param {string} dir @returns {Promise<boolean>} true when the directory is missing or empty; false for a non-empty directory or any file */
async function targetIsFree(dir) {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * @param {Buffer} zipBytes
 * @param {string} targetDir must be absent or an empty folder; receives the book folder's contents (no `.storyforge/`)
 * @param {{ limits?: Partial<typeof DEFAULT_RESTORE_LIMITS> }} [options] limits are injectable for tests
 * @returns {Promise<{ bookRoot: string, files: number, bookId: string | null, diagnostics: object[] }>}
 * @throws {RestoreError}
 */
export async function restoreBackup(zipBytes, targetDir, { limits = {} } = {}) {
  const lim = { ...DEFAULT_RESTORE_LIMITS, ...limits };
  const target = path.resolve(targetDir);

  if (!(await targetIsFree(target))) throw new RestoreError('RESTORE_TARGET_NOT_EMPTY', `${target} already exists and is not empty`);

  // ---- 1. read the archive's table of contents
  let listing;
  try {
    listing = listZip(zipBytes, { maxEntries: lim.maxEntries });
  } catch (e) {
    if (e instanceof ZipTooManyError) throw new RestoreError('RESTORE_LIMIT_EXCEEDED', `the archive has more than ${lim.maxEntries} entries`);
    if (e instanceof ZipError) throw new RestoreError('BACKUP_CORRUPT', e.message);
    throw e;
  }
  const { entries, comment } = listing;

  // ---- 2. refuse unsafe or oversized entries (names, links, duplicates, methods, sizes)
  const seen = new Set();
  let total = 0;
  for (const e of entries) {
    const bad = unsafeName(e.name, target);
    if (bad) throw new RestoreError('RESTORE_UNSAFE_ENTRY', `unsafe entry name "${e.name}": ${bad}`);
    const key = e.name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new RestoreError('RESTORE_UNSAFE_ENTRY', `duplicate entry name: ${e.name}`);
    seen.add(key);
    const mode = (e.externalAttributes >>> 16) & 0o170000;
    if (mode === 0o120000) throw new RestoreError('RESTORE_UNSAFE_ENTRY', `symbolic link entry: ${e.name}`);
    if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) throw new RestoreError('RESTORE_UNSAFE_ENTRY', `special file entry: ${e.name}`);
    if (e.method !== 0 && e.method !== 8) throw new RestoreError('RESTORE_UNSUPPORTED', `unsupported compression method ${e.method}: ${e.name}`);
    if (e.flags & 1) throw new RestoreError('RESTORE_UNSUPPORTED', `encrypted entry: ${e.name}`);
    if (e.size > lim.maxEntryBytes) throw new RestoreError('RESTORE_LIMIT_EXCEEDED', `entry larger than ${lim.maxEntryBytes} bytes: ${e.name}`);
    total += e.size;
    if (total > lim.maxTotalBytes) throw new RestoreError('RESTORE_LIMIT_EXCEEDED', `the archive expands to more than ${lim.maxTotalBytes} bytes`);
  }
  const files = entries.filter((e) => !e.name.endsWith('/'));
  // one book folder: every entry is inside the same first-level folder, and no file is also a folder
  const prefixes = new Set(entries.map((e) => e.name.split('/')[0]));
  if (prefixes.size !== 1 || entries.some((e) => !e.name.includes('/'))) throw new RestoreError('BACKUP_CORRUPT', 'the archive does not hold exactly one book folder');
  const prefix = [...prefixes][0];
  const rels = files.map((e) => e.name.slice(prefix.length + 1));
  for (const rel of rels) {
    if (rel === '') throw new RestoreError('BACKUP_CORRUPT', 'the archive names the book folder as a file');
    if (rel.split('/')[0].toLowerCase() === '.storyforge') throw new RestoreError('RESTORE_UNSAFE_ENTRY', `a backup never contains .storyforge/: ${rel}`);
  }
  const dirs = new Set(rels.flatMap((rel) => rel.split('/').slice(0, -1).map((_s, i, a) => a.slice(0, i + 1).join('/').toLowerCase())));
  for (const rel of rels) if (dirs.has(rel.toLowerCase())) throw new RestoreError('BACKUP_CORRUPT', `${rel} is both a file and a folder`);

  // ---- 3. verify the manifest against the real bytes (inflates every file once and discards it)
  const manifest = parseManifest(comment);
  if (!manifest || manifest.storyforge_backup !== 1 || typeof manifest.sha256 !== 'string' || !Number.isInteger(manifest.files)) {
    throw new RestoreError('BACKUP_CORRUPT', 'the archive has no StoryForge backup manifest');
  }
  if (manifest.files !== files.length) throw new RestoreError('BACKUP_CORRUPT', `the manifest lists ${manifest.files} files but the archive holds ${files.length}`);
  const hashes = [];
  try {
    files.forEach((e, i) => hashes.push({ rel: rels[i], hash: sha256(readEntry(zipBytes, e)) }));
  } catch (e) {
    if (e instanceof ZipError) throw new RestoreError('BACKUP_CORRUPT', e.message);
    throw e;
  }
  if (manifestHash(hashes) !== manifest.sha256) throw new RestoreError('BACKUP_CORRUPT', 'the manifest hash does not match the files (the backup is damaged or was changed)');

  // ---- 4. only now write: temp folder beside the target, then rename
  /** @returns {Generator<[string, Buffer]>} */
  function* produce() {
    for (let i = 0; i < files.length; i++) yield [rels[i], readEntry(zipBytes, files[i])];
  }
  let written;
  try {
    written = await writeNewTree(target, produce);
  } catch (e) {
    if (e instanceof ZipError) throw new RestoreError('BACKUP_CORRUPT', e.message);
    throw e;
  }
  if (!written.ok) throw new RestoreError('RESTORE_TARGET_NOT_EMPTY', `${target} already exists and is not empty`);

  const { diagnostics } = await validate(target);
  return { bookRoot: target, files: written.files, bookId: typeof manifest.book_id === 'string' ? manifest.book_id : null, diagnostics };
}

// ----------------------------------------------------------------------------------------------- files (CLI)

/** Restore from a zip file on disk. @param {string} zipPath @param {string} targetDir @param {Parameters<typeof restoreBackup>[2]} [options] */
export async function restoreBackupFile(zipPath, targetDir, options) {
  return restoreBackup(await readFile(zipPath), targetDir, options);
}

/**
 * Write an export or backup to `outPath`. Refuses to replace an existing file unless `force`, and refuses any path inside the book folder.
 * @param {string} outPath @param {Buffer} bytes @param {{ bookRoot: string, force?: boolean }} options
 */
export async function writeOutput(outPath, bytes, { bookRoot, force = false }) {
  const out = path.resolve(outPath);
  const realBook = await realpath(path.resolve(bookRoot));
  let realDir;
  try {
    realDir = await realpath(path.dirname(out));
  } catch {
    throw new ExportError('OUT_NO_FOLDER', `the folder for ${out} does not exist`);
  }
  const rel = path.relative(realBook, path.join(realDir, path.basename(out)));
  const inside = !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  if (inside) throw new ExportError('OUT_INSIDE_BOOK', `${out} is inside the book folder; choose a path outside it`);
  // an existing symlink at the target could lead into the book
  try {
    await readlink(out);
    throw new ExportError('OUT_EXISTS', `${out} is a link; remove it first`);
  } catch (e) {
    if (e instanceof ExportError) throw e;
  }
  const r = await writeOutFile(out, bytes, { force });
  if (!r.ok) throw new ExportError('OUT_EXISTS', `${out} already exists (use --force to replace it)`);
  return out;
}
