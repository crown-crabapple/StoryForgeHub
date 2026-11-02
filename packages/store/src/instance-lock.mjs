// Single-instance lock: one exclusive-create file holding { pid, hostname, started_at, port }.
// A lock whose process is gone (or, from another host, older than 24 h) is taken over.
import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';

const STALE_OTHER_HOST_MS = 24 * 60 * 60 * 1000;
const STALE_UNREADABLE_MS = 60 * 1000;

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e)?.code === 'EPERM';
  }
}

/** @param {string} file @returns {Promise<{ text: string, info: any } | null>} null = file absent */
async function readLock(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const info = JSON.parse(text);
    return { text, info: info && typeof info === 'object' ? info : undefined };
  } catch {
    return { text, info: undefined };
  }
}

/** Why an existing lock may be replaced, or null if it must be respected. */
async function takeoverReason(file, held) {
  if (held.info) {
    const info = held.info;
    if (info.hostname === os.hostname()) return pidAlive(info.pid) ? null : 'holder process is gone';
    const started = Date.parse(info.started_at);
    return Number.isFinite(started) && Date.now() - started > STALE_OTHER_HOST_MS ? 'lock from another host is older than 24 hours' : null;
  }
  try {
    return Date.now() - (await stat(file)).mtimeMs > STALE_UNREADABLE_MS ? 'lock file is unreadable and old' : null;
  } catch {
    return 'lock file vanished';
  }
}

/**
 * Take the lock at `absPath`.
 * @param {string} absPath absolute path of the lock file
 * @param {{ pid?: number, hostname?: string, started_at?: string, port?: number | null }} [info]
 * @returns {Promise<{ ok: true, lock: 'held' | 'taken-over', info: object, previous?: object } | { ok: false, code: 'LOCKED', holder: object | null }>}
 */
export async function acquireLock(absPath, info = {}) {
  const mine = {
    pid: info.pid ?? process.pid,
    hostname: info.hostname ?? os.hostname(),
    started_at: info.started_at ?? new Date().toISOString(),
    port: info.port ?? null,
  };
  let previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fh = await open(absPath, 'wx');
      try {
        await fh.writeFile(`${JSON.stringify(mine)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return previous ? { ok: true, lock: 'taken-over', info: mine, previous } : { ok: true, lock: 'held', info: mine };
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'EEXIST') throw e;
    }
    const held = await readLock(absPath);
    if (held === null) continue; // released between our create and our read
    if (!(await takeoverReason(absPath, held))) return { ok: false, code: 'LOCKED', holder: held.info ?? null };
    // Remove only the stale lock we looked at (not one somebody created in the meantime).
    const again = await readLock(absPath);
    if (again && again.text === held.text) {
      try {
        await unlink(absPath);
      } catch (e) {
        if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
      }
      previous = held.info ?? previous;
    }
  }
  return { ok: false, code: 'LOCKED', holder: (await readLock(absPath))?.info ?? null };
}

/**
 * Remove the lock if it is ours (same pid). Never removes another instance's lock.
 * @param {string} absPath
 * @param {{ pid?: number }} [info]
 * @returns {Promise<{ ok: boolean, released: boolean }>}
 */
export async function releaseLock(absPath, info = {}) {
  const pid = info.pid ?? process.pid;
  const held = await readLock(absPath);
  if (held === null) return { ok: true, released: false };
  if (held.info?.pid !== pid) return { ok: true, released: false };
  try {
    await unlink(absPath);
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
  }
  return { ok: true, released: true };
}

/**
 * Rewrite our own lock with changed fields (the server learns its real port only after it is listening).
 * Does nothing if the lock is not ours.
 * @param {string} absPath
 * @param {{ pid?: number, port?: number | null }} patch `pid` identifies the owner (default: this process)
 */
export async function updateLock(absPath, patch = {}) {
  const held = await readLock(absPath);
  const pid = patch.pid ?? process.pid;
  if (!held?.info || held.info.pid !== pid) return { ok: false };
  const next = { ...held.info, ...(patch.port !== undefined ? { port: patch.port } : {}) };
  const tmp = `${absPath}.sf-tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(`${JSON.stringify(next)}
`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, absPath);
  return { ok: true, info: next };
}

/** Synchronous releaseLock, for a process 'exit' handler (where nothing async can run). */
export function releaseLockSync(absPath, info = {}) {
  const pid = info.pid ?? process.pid;
  try {
    if (JSON.parse(readFileSync(absPath, 'utf8'))?.pid !== pid) return { ok: true, released: false };
    unlinkSync(absPath);
    return { ok: true, released: true };
  } catch {
    return { ok: true, released: false };
  }
}
