// The database sink registry (H0 §2.0 "Write path"). `packages/store` never imports a database: the host injects an object with the
// document-store method shapes (`applyOp`, `listFiles`, `readFile`, `putRevision`, `deleteRevisions`, `writeShared`, `appendSharedLine`, `readShared`)
// and every write the store makes under an attached library folder lands in it first, then on disk. Nothing attached: nothing changes.
//
// Optional sink methods the store calls when present: `afterDisk({ opId, op, paths })` once a write is fully on disk (the test adapter
// checks database == disk there), and `listFiles({ prefix })` may use its argument to prepare a listing (the real document store ignores it).
import path from 'node:path';

// Kept on globalThis so two copies of this module (a path spelled two ways, a harness importing it from elsewhere) share one registry.
/** @type {{ libraries: Map<string, any>, sharedDirs: Map<string, any> }} */
const registry = (globalThis[Symbol.for('storyforge.store.sinks')] ??= { libraries: new Map(), sharedDirs: new Map() });
const { libraries, sharedDirs } = registry;

const key = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const slashes = (p) => p.split(path.sep).join('/');

/** @param {string} libraryRoot @param {object} sink */
export function attachDatabase(libraryRoot, sink) {
  libraries.set(key(libraryRoot), { root: path.resolve(libraryRoot), sink });
}

/** @param {string} libraryRoot */
export function detachDatabase(libraryRoot) {
  libraries.delete(key(libraryRoot));
}

/** @param {string} sharedDir @param {object} sink */
export function attachSharedDatabase(sharedDir, sink) {
  sharedDirs.set(key(sharedDir), sink);
}

/** @param {string} sharedDir */
export function detachSharedDatabase(sharedDir) {
  sharedDirs.delete(key(sharedDir));
}

/** The sink for a shared-data folder, or null. @param {string} dir */
export function sharedSinkFor(dir) {
  return sharedDirs.get(key(dir)) ?? null;
}

/**
 * The sink covering the store root `root` (the deepest attached library folder that contains it), with the mapping from
 * root-relative paths to library-relative ones. Null when none is attached.
 * @param {string} root absolute store root (a book root or the library root)
 * @returns {{ sink: any, bookPath: string, lib: (rel: string) => string, rel: (libPath: string) => string | null } | null}
 */
export function sinkFor(root) {
  if (libraries.size === 0) return null;
  const abs = path.resolve(root);
  let best = null;
  for (const entry of libraries.values()) {
    const r = path.relative(entry.root, abs);
    if (r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) continue;
    if (!best || entry.root.length > best.entry.root.length) best = { entry, r: slashes(r) };
  }
  if (!best) return null;
  const bookPath = best.r;
  const lib = (rel) => (bookPath === '' ? rel : rel === '' ? bookPath : `${bookPath}/${rel}`);
  const back = (libPath) => (bookPath === '' ? libPath : libPath.startsWith(`${bookPath}/`) ? libPath.slice(bookPath.length + 1) : null);
  return { sink: best.entry.sink, bookPath, lib, rel: back };
}
