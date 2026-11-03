// Writes for files and folders that are not part of any book's journaled tree: a backup restored into a new folder, and an export or
// backup file written where the user asked. Nothing here touches a book that already exists.
import crypto from 'node:crypto';
import { mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { notifyWrite } from './write-hooks.mjs';
import { fsyncDir, kindOf, moveFile, writeSynced } from './atomic.mjs';

/**
 * Create `targetDir` (absent, or an existing empty folder) holding exactly the files `produce()` yields, all or nothing: the files are written
 * into a hidden temp folder next to the target, which is then renamed into place (or, for an existing empty folder, its contents are moved in).
 * On any failure the temp folder is removed and the error is rethrown; `targetDir` is then as it was (absent, or empty).
 * `produce` is called once and must yield [relative path, bytes] pairs whose paths the caller has already made safe (forward slashes, no `..`).
 * @param {string} targetDir
 * @param {() => Iterable<[string, Buffer]>} produce
 * @returns {Promise<{ ok: true, files: number } | { ok: false, code: 'TARGET_NOT_EMPTY' }>}
 */
export async function writeNewTree(targetDir, produce) {
  try {
    return await writeNewTreeInner(targetDir, produce);
  } finally {
    notifyWrite(targetDir);
  }
}

async function writeNewTreeInner(targetDir, produce) {
  const target = path.resolve(targetDir);
  const parent = path.dirname(target);
  const existing = await kindOf(target);
  if (existing === 'file' || (existing === 'dir' && (await readdir(target)).length > 0)) return { ok: false, code: 'TARGET_NOT_EMPTY' };
  await mkdir(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(target)}.restore-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await mkdir(temp);
    let files = 0;
    for (const [rel, bytes] of produce()) {
      const dest = path.join(temp, ...rel.split('/'));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeSynced(dest, bytes);
      files += 1;
    }
    await fsyncDir(temp);
    const now = await kindOf(target);
    if (now === null) {
      await moveFile(temp, target);
    } else if (now === 'dir' && (await readdir(target)).length === 0) {
      for (const name of await readdir(temp)) await rename(path.join(temp, name), path.join(target, name));
      await rmdir(temp);
    } else {
      await rm(temp, { recursive: true, force: true });
      return { ok: false, code: 'TARGET_NOT_EMPTY' };
    }
    await fsyncDir(parent);
    return { ok: true, files };
  } catch (e) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Write one new file at `file` (its folder must exist). Without `force` an existing file is never replaced.
 * @param {string} file @param {Buffer} bytes @param {{ force?: boolean }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, code: 'EXISTS' }>}
 */
export async function writeOutFile(file, bytes, { force = false } = {}) {
  let fh;
  try {
    fh = await open(file, force ? 'w' : 'wx');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'EEXIST') return { ok: false, code: 'EXISTS' };
    throw e;
  }
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { ok: true };
}

/**
 * Write one file (replacing any existing one), creating its folders. For derived files outside every book, such as the Claude-Book adapter's
 * work folder; the caller has already checked that `file` lies inside the folder it owns.
 * @param {string} file @param {Buffer | string} bytes
 * @returns {Promise<void>}
 */
export async function writeWorkFile(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeSynced(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
}

/**
 * Replace the folder `dir` with a new one holding exactly the files `produce()` yields: the new tree is written beside it and swapped in,
 * and the old folder (if any) is removed. `produce` yields [relative path, bytes] pairs the caller has already made safe. The caller owns
 * `dir` (a derived, rebuilt folder); nothing else is touched.
 * @param {string} dir @param {Iterable<[string, Buffer | string]>} files
 * @returns {Promise<void>}
 */
export async function replaceWorkDir(dir, files) {
  const target = path.resolve(dir);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(target)}.new-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await mkdir(temp);
    for (const [rel, bytes] of files) await writeWorkFile(path.join(temp, ...rel.split('/')), bytes);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
