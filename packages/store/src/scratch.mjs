// Throwaway files outside any book (the operating system's temp folder), for libraries that can only hand data over through
// a file path, such as SQLite's VACUUM INTO on Node 22 (no DatabaseSync#serialize). Kept here so every file write stays in
// @storyforge/store (the single-writer rule).
import { mkdtempSync, rmSync } from 'node:fs';
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
