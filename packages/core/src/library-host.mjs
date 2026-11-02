// The library host: the one library a server process is serving right now, and how to switch to another.
// It owns the current repository and the library lock, and the per-user "recent libraries" list.
// Switching (contract M02-J03 section 3) takes the new folder's lock first and opens the new repository next;
// only when both work does it close the old repository and release the old lock. If anything fails the old
// library stays open and the new lock is released, so there is never a half-switched state.
// No filesystem access here: folder checks live in fs-repository.mjs, writes in @storyforge/store.
import path from 'node:path';
import { acquireLock, readUserConfig, releaseLock, releaseLockSync, writeUserConfig } from '@storyforge/store';
import { LOCK_FILE } from './config.mjs';
import { checkLibraryFolder, createFsRepository, folderExists } from './fs-repository.mjs';

export const RECENT_FILE = 'recent.json';
export const MAX_RECENT = 8;

const sameFolder = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * @param {{
 *   repository: import('./repository.mjs').FileRepository & { root?: string },
 *   libraryRoot?: string,
 *   holdsLock?: boolean,
 *   port?: number | null,
 *   repoOptions?: object,
 *   createRepository?: (root: string, options?: object) => import('./repository.mjs').FileRepository,
 * }} p
 *   `repository` is the library already open. `holdsLock`: this process already holds that library's lock
 *   (the host releases it when it moves on). `port` goes into the locks it takes. `repoOptions` are passed to
 *   every repository the host opens (tests turn watching off).
 */
export function createLibraryHost({ repository, libraryRoot, holdsLock = false, port = null, repoOptions = {}, createRepository = createFsRepository }) {
  let current = repository;
  let root = path.resolve(libraryRoot ?? /** @type {any} */ (repository).root);
  let lockHeld = holdsLock;
  let listenPort = port;
  /** Serialises open() calls so two switches never interleave. */
  let busy = Promise.resolve();

  const lockPathOf = (dir) => path.join(dir, LOCK_FILE);

  async function readRecent() {
    const data = await readUserConfig(RECENT_FILE);
    const list = Array.isArray(data?.paths) ? data.paths : [];
    return list.filter((p) => typeof p === 'string' && path.isAbsolute(p));
  }

  async function saveRecent(paths) {
    try {
      await writeUserConfig(RECENT_FILE, { version: 1, paths });
      return true;
    } catch {
      return false; // a settings folder that cannot be written must not stop anyone from reading
    }
  }

  const host = {
    /** The repository for the library being served now. */
    get repository() {
      return current;
    },
    get root() {
      return root;
    },
    get lockPath() {
      return lockHeld ? lockPathOf(root) : null;
    },
    /** The port the server really listens on, for the lock files of libraries opened later. @param {number | null} p */
    setPort(p) {
      listenPort = p;
    },

    /** Put `dir` at the front of the recent list (newest first, no duplicates, at most 8). @param {string} dir */
    async remember(dir) {
      const abs = path.resolve(dir);
      const rest = (await readRecent()).filter((p) => !sameFolder(p, abs));
      return saveRecent([abs, ...rest].slice(0, MAX_RECENT));
    },

    /** The recent libraries, newest first: [{ path, name, exists, current }]. */
    async recent() {
      const paths = await readRecent();
      return Promise.all(
        paths.slice(0, MAX_RECENT).map(async (p) => ({
          path: p,
          name: path.basename(p) || p,
          exists: await folderExists(p),
          current: sameFolder(p, root),
        })),
      );
    },

    /** Drop one path from the list. Not being listed is fine. @param {string} dir */
    async removeRecent(dir) {
      const abs = path.resolve(dir);
      return saveRecent((await readRecent()).filter((p) => !sameFolder(p, abs)));
    },

    /**
     * Switch to another library folder.
     * @param {unknown} input
     * @returns {Promise<{ ok: true, library: any, recover: any, lock: string } | { ok: false, code: string, message: string, holder?: object | null }>}
     */
    open(input) {
      const run = busy.then(() => doOpen(input));
      busy = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    /** Stop serving: close the repository and release the lock. */
    async close() {
      await current.close().catch(() => {});
      if (lockHeld) await releaseLock(lockPathOf(root)).catch(() => {});
      lockHeld = false;
    },

    /** For a process 'exit' handler, where nothing async can run. */
    releaseSync() {
      if (lockHeld) releaseLockSync(lockPathOf(root));
      lockHeld = false;
    },
  };

  async function doOpen(input) {
    const checked = await checkLibraryFolder(input);
    if (!checked.ok) return checked;
    const target = checked.path;

    if (sameFolder(target, root)) {
      await host.remember(target);
      return { ok: true, library: await current.libraryInfo(), recover: null, lock: lockHeld ? 'held' : 'none' };
    }

    const lockPath = lockPathOf(target);
    let lock;
    try {
      lock = await acquireLock(lockPath, { port: listenPort });
    } catch (e) {
      return { ok: false, code: 'OPEN_FAILED', message: `Could not open that folder: ${e instanceof Error ? e.message : e}` };
    }
    if (!lock.ok) {
      return { ok: false, code: 'LOCKED', message: 'Another StoryForge window is using that folder.', holder: lock.holder };
    }

    let next;
    let recover;
    let library;
    try {
      next = createRepository(target, repoOptions);
      recover = await next.recover();
      library = await next.libraryInfo();
    } catch (e) {
      await next?.close().catch(() => {});
      await releaseLock(lockPath).catch(() => {});
      return { ok: false, code: 'OPEN_FAILED', message: `Could not open that folder: ${e instanceof Error ? e.message : e}` };
    }

    // switched: from here the old library is only cleaned up
    const old = current;
    const oldLockPath = lockPathOf(root);
    const hadLock = lockHeld;
    current = next;
    root = target;
    lockHeld = true;
    await old.close().catch(() => {});
    if (hadLock) await releaseLock(oldLockPath).catch(() => {});
    await host.remember(target);
    // Indexes are built in the background; reads answer from the files until they are ready.
    next.ensureIndexes().catch(() => {});
    return { ok: true, library, recover, lock: lock.lock };
  }

  return host;
}
