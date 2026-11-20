// Writes for files and folders that are not part of any book's journaled tree: a backup restored into a new folder, and an export or
// backup file written where the user asked. Nothing here touches a book that already exists.
import crypto from 'node:crypto';
import { mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { notifyWrite } from './write-hooks.mjs';
import { currentActor } from './actor.mjs';
import { fsyncDir, kindOf, moveFile, sha256, writeSynced } from './atomic.mjs';
import { makeOpId } from './journal.mjs';
import { sinkFor } from './sink.mjs';

/**
 * Create `targetDir` (absent, or an existing empty folder) holding exactly the files `produce()` yields, all or nothing: the files are written
 * into a hidden temp folder next to the target, which is then renamed into place (or, for an existing empty folder, its contents are moved in).
 * On any failure the temp folder is removed and the error is rethrown; `targetDir` is then as it was (absent, or empty).
 * `produce` is called once and must yield [relative path, bytes] pairs whose paths the caller has already made safe (forward slashes, no `..`).
 * When `targetDir` lies inside a library with a database attached, the files go to the database first, in ONE applyOp (each with before_sha256 null; a CONFLICT is
 * TARGET_NOT_EMPTY), then to disk; if the disk step fails the database side is undone (H0 section 2.0 "Write path").
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
  const covered = sinkFor(target);
  /** @type {{ path: string, before_sha256: null, bytes: Buffer }[]} */
  let dbFiles = [];
  let dbOpId = '';
  if (covered) {
    const entries = [...produce()];
    if (entries.length > 0) {
      dbOpId = makeOpId();
      dbFiles = entries.map(([rel, bytes]) => ({ path: covered.lib(rel), before_sha256: null, bytes }));
      const r = await covered.sink.applyOp({ opId: dbOpId, op: 'writeNewTree', args: { target: covered.lib('') }, actor: currentActor() ?? null, files: dbFiles });
      if (!r?.ok) {
        if (r?.code === 'CONFLICT') return { ok: false, code: 'TARGET_NOT_EMPTY' };
        throw new Error(`database write refused: ${r?.code ?? 'unknown'}${r?.message ? ` (${r.message})` : ''}`);
      }
    }
    const written = entries;
    produce = () => written;
  }
  try {
    const out = await writeNewTreeDisk(target, parent, produce);
    if (dbFiles.length > 0 && !out.ok) await undoDb(covered, dbOpId, dbFiles);
    else if (dbFiles.length > 0) await covered?.sink.afterDisk?.({ opId: dbOpId, op: 'writeNewTree', paths: dbFiles.map((f) => f.path) });
    return out;
  } catch (e) {
    if (dbFiles.length > 0) await undoDb(covered, dbOpId, dbFiles).catch(() => {});
    throw e;
  }
}

/** Take a writeNewTree batch back out of the database. @param {any} covered @param {string} opId @param {{ path: string, bytes: Buffer }[]} files */
async function undoDb(covered, opId, files) {
  const r = await covered.sink.applyOp({
    opId: `${opId}-rb`,
    op: 'rollback',
    args: { undoes: opId },
    actor: currentActor() ?? null,
    files: files.map((f) => ({ path: f.path, before_sha256: sha256(f.bytes), bytes: null })),
  });
  if (!r?.ok) throw new Error(`database undo refused: ${r?.code ?? 'unknown'}`);
}

async function writeNewTreeDisk(target, parent, produce) {
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
