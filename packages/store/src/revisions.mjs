// Local revision snapshots: .storyforge/revisions/<scene-id>/<YYYYMMDDTHHMMSSZ>-<reason>.md plus index.json.
// Safety copies on this machine (FORMAT-v1 section 9). Written atomically, never deleted: a pruned snapshot
// is moved into the trash. Called from store.mjs under the root lock.
import path from 'node:path';
import { atomicWrite, kindOf, readOrNull, sha256 } from './atomic.mjs';
import { escapesRoot } from './contain.mjs';
import { makeOpId } from './journal.mjs';
import { moveAbsToTrash } from './trash.mjs';

const SCENE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const REASON_RE = /^[a-z]{1,20}$/;
export const REVISION_FILE_RE = /^\d{8}T\d{6}Z-[a-z]{1,20}(-\d{1,4})?\.md$/;

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

export const revisionDirRel = (sceneId) => `.storyforge/revisions/${sceneId}`;

/** @param {string} root @param {string} sceneId */
async function usableDir(root, sceneId) {
  if (typeof sceneId !== 'string' || !SCENE_ID_RE.test(sceneId)) return null;
  const rel = revisionDirRel(sceneId);
  if (await escapesRoot(root, rel)) return null;
  return path.join(root, '.storyforge', 'revisions', sceneId);
}

/** `YYYYMMDDTHHMMSSZ` (UTC) @param {Date} d */
export const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Index entries as stored (oldest first); a missing or unreadable index is []. */
async function readIndex(dir) {
  const bytes = await readOrNull(path.join(dir, 'index.json'));
  if (!bytes) return [];
  try {
    const v = JSON.parse(bytes.toString('utf8'));
    return Array.isArray(v) ? v.filter((e) => e && typeof e.file === 'string' && REVISION_FILE_RE.test(e.file)) : [];
  } catch {
    return [];
  }
}

const writeIndex = (dir, entries) => atomicWrite(path.join(dir, 'index.json'), Buffer.from(`${JSON.stringify(entries, null, 2)}\n`));

/** @returns {Promise<object[]|null>} entries, newest first (null: not a usable scene id) */
export async function listRevisions(root, sceneId) {
  const dir = await usableDir(root, sceneId);
  if (!dir) return null;
  const entries = await readIndex(dir);
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.file < b.file ? 1 : -1));
}

/** @returns {Promise<Buffer|null>} */
export async function readRevision(root, sceneId, file) {
  const dir = await usableDir(root, sceneId);
  if (!dir || typeof file !== 'string' || !REVISION_FILE_RE.test(file)) return null;
  return readOrNull(path.join(dir, file));
}

/**
 * Save a snapshot. Identical to the newest snapshot (same sha256): nothing is stored (`stored: false`, the existing entry returned).
 * @param {string} root
 * @param {string} sceneId
 * @param {Buffer} bytes the whole scene file
 * @param {{ reason: string, at?: Date | string | number, label?: string, words?: number }} meta
 */
export async function saveRevision(root, sceneId, bytes, meta) {
  const dir = await usableDir(root, sceneId);
  if (!dir) return fail('OUTSIDE_ROOT');
  if (!Buffer.isBuffer(bytes)) return fail('BAD_ARGS', { message: 'bytes must be a Buffer' });
  if (!meta || typeof meta.reason !== 'string' || !REASON_RE.test(meta.reason)) return fail('BAD_ARGS', { message: 'reason must be a lower-case word' });
  const at = new Date(meta.at ?? Date.now());
  if (Number.isNaN(at.getTime())) return fail('BAD_ARGS', { message: 'at is not a date' });
  const entries = await readIndex(dir);
  const sha = sha256(bytes);
  const newest = [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (newest && newest.sha256 === sha && (await kindOf(path.join(dir, newest.file))) === 'file') {
    return { ok: true, code: 'OK', stored: false, entry: newest };
  }
  const base = `${stampOf(at)}-${meta.reason}`;
  let file = `${base}.md`;
  for (let n = 2; entries.some((e) => e.file === file) || (await kindOf(path.join(dir, file))) !== null; n++) file = `${base}-${n}.md`;
  /** @type {Record<string, unknown>} */
  const entry = { file, at: at.toISOString(), reason: meta.reason, sha256: sha, words: Number.isInteger(meta.words) ? meta.words : 0 };
  if (typeof meta.label === 'string' && meta.label.trim() !== '') entry.label = meta.label.trim();
  await atomicWrite(path.join(dir, file), bytes);
  await writeIndex(dir, [...entries, entry]);
  return { ok: true, code: 'OK', stored: true, entry };
}

/**
 * Prune: move the named snapshots into `.storyforge/trash/<opId>/revisions/<scene-id>/` and drop them from the index.
 * @param {string} root @param {string} sceneId @param {string[]} files
 */
export async function pruneRevisions(root, sceneId, files) {
  const dir = await usableDir(root, sceneId);
  if (!dir) return fail('OUTSIDE_ROOT');
  const entries = await readIndex(dir);
  const drop = new Set(files.filter((f) => typeof f === 'string' && REVISION_FILE_RE.test(f) && entries.some((e) => e.file === f)));
  if (drop.size === 0) return { ok: true, code: 'OK', opId: null, pruned: [] };
  const opId = makeOpId();
  for (const f of drop) {
    if ((await kindOf(path.join(dir, f))) === 'file') await moveAbsToTrash(root, opId, path.join(dir, f), `revisions/${sceneId}/${f}`);
  }
  await writeIndex(dir, entries.filter((e) => !drop.has(e.file)));
  return { ok: true, code: 'OK', opId, pruned: [...drop] };
}
