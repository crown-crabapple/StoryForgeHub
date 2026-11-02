// Trash layout: .storyforge/trash/<opId>/<rel>. Nothing in the trash is ever deleted.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { absOf, fsyncDir, moveFile, writeSynced } from './atomic.mjs';

export const trashDir = (root, opId) => path.join(root, '.storyforge', 'trash', opId);

/** Absolute trash location for `rel`; `sub` is an optional subfolder ('rolled-back', 'unfinished'). */
export const trashPath = (root, opId, rel, sub) =>
  path.join(trashDir(root, opId), ...(sub ? [sub] : []), ...rel.split('/'));

/** Save `bytes` as the trashed copy of `rel` (fsync'd). */
export async function copyToTrash(root, opId, rel, bytes, sub) {
  const dest = trashPath(root, opId, rel, sub);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeSynced(dest, bytes);
}

/** Move an existing project path into the trash (replaces an identical earlier copy). */
export async function moveToTrash(root, opId, rel, sub) {
  const dest = trashPath(root, opId, rel, sub);
  await mkdir(path.dirname(dest), { recursive: true });
  await moveFile(absOf(root, rel), dest);
  await fsyncDir(path.dirname(dest));
}

/** Move any absolute file (e.g. a leftover tmp) into the trash under `rel`. */
export async function moveAbsToTrash(root, opId, fileAbs, rel, sub) {
  const dest = trashPath(root, opId, rel, sub);
  await mkdir(path.dirname(dest), { recursive: true });
  await moveFile(fileAbs, dest);
}
