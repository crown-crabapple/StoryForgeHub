// Throwaway files outside any book (the operating system's temp folder), for libraries that can only hand data over through
// a file path, such as SQLite's VACUUM INTO on Node 22 (no DatabaseSync#serialize). Kept here so every file write stays in
// @storyforge/store (the single-writer rule).
import { mkdtempSync, rmSync } from 'node:fs';
import fsp, { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Run `fn` with the path of a file that does not exist yet, in a new private folder under the temp folder, and remove the
 * folder and whatever `fn` left in it afterwards, also when `fn` throws. Synchronous, for synchronous callers.
 * @template T @param {string} name the file name (no folders) @param {(file: string) => T} fn @returns {T}
 */
export function withScratchFile(name, fn) {
  if (typeof name !== 'string' || name === '' || name !== path.basename(name) || name.startsWith('.')) throw new Error('withScratchFile: name must be a plain file name');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'storyforge-scratch-'));
  try {
    return fn(path.join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const plainName = (name) => typeof name === 'string' && name !== '' && name === path.basename(name) && !name.startsWith('.') && !name.includes('/') && !name.includes(String.fromCharCode(92)) && !name.includes(String.fromCharCode(0));

/**
 * Run async `fn` with a private scratch folder under the temp folder and remove it when `fn` settles (resolves, throws or is
 * cancelled by rejecting). `dir.write(name, bytes)` and `dir.read(name, { maxBytes })` take plain file names only (no folders,
 * no leading dot); `dir.path(name)` gives the absolute path of such a file, `dir.root` the folder itself.
 * `read` throws (code TOO_LARGE) when the file is longer than `maxBytes` and (code ENOENT) when it does not exist.
 * @template T @param {string} prefix plain name used as the folder name prefix
 * @param {(dir: { root: string, path: (name: string) => string, write: (name: string, bytes: Uint8Array | string) => Promise<void>, read: (name: string, options?: { maxBytes?: number }) => Promise<Buffer> }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withScratchDir(prefix, fn) {
  if (!plainName(prefix)) throw new Error('withScratchDir: prefix must be a plain file name');
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const at = (name) => {
    if (!plainName(name)) throw new Error('withScratchDir: name must be a plain file name');
    return path.join(root, name);
  };
  const dir = {
    root,
    path: at,
    async write(name, bytes) {
      await fsp.writeFile(at(name), bytes);
    },
    async read(name, { maxBytes = Infinity } = {}) {
      const file = at(name);
      const size = (await fsp.stat(file)).size;
      if (size > maxBytes) throw Object.assign(new Error(`${name} is larger than ${maxBytes} bytes`), { code: 'TOO_LARGE' });
      return fsp.readFile(file);
    },
  };
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
