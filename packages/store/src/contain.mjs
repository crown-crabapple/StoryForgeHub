// Realpath containment: does a root-relative path, after following symlinks, still lead inside the root?
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/** Real path of `abs`, or of its nearest existing ancestor plus the missing tail. null = a dangling link. */
async function realOfExisting(abs) {
  const tail = [];
  for (let cur = abs; ; ) {
    try {
      const r = await realpath(cur);
      return tail.length ? path.join(r, ...tail) : r;
    } catch (e) {
      if (!MISSING.has(/** @type {any} */ (e)?.code)) throw e;
    }
    try {
      await lstat(cur);
      return null; // it exists but cannot be resolved: a dangling symlink
    } catch (e) {
      if (!MISSING.has(/** @type {any} */ (e)?.code)) throw e;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/** @param {string} root @param {string} real */
function inside(root, real) {
  const rel = path.relative(root, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * True if `rel` (already syntactically valid) resolves outside `root` once symlinks are followed.
 * @param {string} root absolute book root
 * @param {string} rel root-relative, forward slashes ('' is the root itself)
 */
export async function escapesRoot(root, rel) {
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return false; // no root yet: nothing to escape through
  }
  const abs = rel === '' ? root : path.join(root, ...rel.split('/'));
  const real = await realOfExisting(abs);
  return real === null || !inside(realRoot, real);
}
