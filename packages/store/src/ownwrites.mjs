// The store's "last-op set": root-relative paths the store itself wrote recently, so a watcher can tell
// the app's own writes from external edits. In memory, per process, keyed by the resolved book root.
import path from 'node:path';

export const OWN_WRITE_WINDOW_MS = 2000;
const KEEP_MS = 10_000;

/** @type {Map<string, Map<string, number>>} root -> rel -> last time (ms) the store touched it */
const recent = new Map();

/** @param {string} root @param {string[]} rels */
export function markOwn(root, rels) {
  const key = path.resolve(root);
  let m = recent.get(key);
  if (!m) {
    m = new Map();
    recent.set(key, m);
  }
  const now = Date.now();
  for (const [rel, t] of m) if (now - t > KEEP_MS) m.delete(rel);
  for (const rel of rels) m.set(rel, now);
}

/** True if the store wrote `rel` (root-relative, forward slashes) within the last `windowMs`. */
export function isOwn(root, rel, windowMs = OWN_WRITE_WINDOW_MS) {
  const t = recent.get(path.resolve(root))?.get(rel);
  return t !== undefined && Date.now() - t <= windowMs;
}
