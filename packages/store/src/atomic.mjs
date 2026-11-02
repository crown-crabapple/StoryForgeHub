// Low-level file operations: hashing, fsync'd writes, atomic replace, directory creation.
import crypto from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** @param {Buffer} buf */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Absolute path for a root-relative, forward-slash path. */
export const absOf = (root, rel) => path.join(root, ...rel.split('/'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** File bytes, or null if the path is absent (or not a regular file). */
export async function readOrNull(file) {
  try {
    return await readFile(file);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || e?.code === 'EISDIR') return null;
    throw e;
  }
}

/** @returns {Promise<'file'|'dir'|null>} */
export async function kindOf(file) {
  try {
    const s = await stat(file);
    return s.isDirectory() ? 'dir' : 'file';
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;
  }
}

/** Move with a short retry for transient Windows sharing errors (replaces an existing file). */
export async function moveFile(from, to) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (i < 4 && (e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES')) {
        await sleep(25 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

/** Create/overwrite `file` with `bytes` and fsync it. */
export async function writeSynced(file, bytes) {
  const fh = await open(file, 'w');
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** fsync a directory where the platform allows it; silently skipped on Windows. */
export async function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // not supported here; best effort
  }
}

/** mkdir -p that records which directories it had to create (outermost first). */
export async function mkdirTracked(dir, created) {
  const missing = [];
  for (let d = dir; (await kindOf(d)) === null; d = path.dirname(d)) missing.unshift(d);
  await mkdir(dir, { recursive: true });
  if (created) created.push(...missing);
}

/** `<dir>/.<name>.sf-tmp` for an absolute path. */
export const tmpOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.sf-tmp`);

/** Write tmp, fsync, move over the target, fsync the directory. */
export async function atomicWrite(target, bytes, created) {
  await mkdirTracked(path.dirname(target), created);
  const tmp = tmpOf(target);
  await writeSynced(tmp, bytes);
  await moveFile(tmp, target);
  await fsyncDir(path.dirname(target));
}
