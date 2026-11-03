// Shared-mode data files (M07-J03): small JSON files in the shared-data folder, which is never inside a library. Atomic replace under the folder's
// root lock; the folder is created owner-only (0700) and files owner-read/write (0600) where the OS supports modes.
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomic.mjs';
import { withRootLock } from './lock.mjs';

const NAME_RE = /^[a-z][a-z0-9-]*\.(json|jsonl)$/;

/** @param {string} dir @param {string} name */
function fileOf(dir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TypeError(`bad shared-data file name: ${name}`);
  return path.join(path.resolve(dir), name);
}

/**
 * @param {string} dir the shared-data folder
 * @param {string} name e.g. `users.json`
 * @returns {Promise<{ state: 'missing' } | { state: 'corrupt', message: string } | { state: 'ok', value: any }>}
 */
export async function readSharedJson(dir, name) {
  let text;
  try {
    text = await readFile(fileOf(dir, name), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt', message: String(/** @type {any} */ (e)?.message ?? e) };
  }
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch {
    return { state: 'corrupt', message: `${name} is not valid JSON` };
  }
}

/** @param {string} dir */
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {});
}

/**
 * Atomically replace `name` in the shared-data folder with `value` as JSON.
 * @param {string} dir @param {string} name @param {unknown} value
 */
export async function writeSharedJson(dir, name, value) {
  const file = fileOf(dir, name);
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError('value is not serialisable');
  await ensureDir(path.dirname(file));
  await withRootLock(path.dirname(file), () => atomicWrite(file, Buffer.from(`${text}\n`, 'utf8')));
  if (process.platform !== 'win32') await chmod(file, 0o600).catch(() => {});
}

/**
 * Append one line to a JSON-lines file (the audit log) and fsync it before returning. A crash can leave at most a partial LAST line, which has no
 * trailing newline; readers must report it (the audit verifier does) rather than trust it.
 * @param {string} dir @param {string} name @param {string} line one JSON value, no newline
 */
export async function appendSharedLine(dir, name, line) {
  const file = fileOf(dir, name);
  if (line.includes('\n')) throw new TypeError('a line must not contain a newline');
  await ensureDir(path.dirname(file));
  await withRootLock(path.dirname(file), async () => {
    const fh = await open(file, 'a', 0o600);
    try {
      await fh.write(`${line}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

/**
 * The raw text of a JSON-lines file, so a reader can tell whether the last line ended with a newline. Missing → ''.
 * @param {string} dir @param {string} name
 * @returns {Promise<string>}
 */
export async function readSharedText(dir, name) {
  try {
    return await readFile(fileOf(dir, name), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return '';
    throw e;
  }
}
