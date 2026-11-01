// Read-only filesystem helpers. Dot-entries (including .storyforge/) are never visited.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** @param {string} p */
export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p */
export async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
export async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Non-dot sub-directories of a directory (symlinks are not followed), sorted by name.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(byCodePoint);
}

/**
 * Every `.md` file below dir (non-dot, symlinks not followed), as paths relative to dir
 * with forward slashes, sorted.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function walkMarkdown(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function visit(rel) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(childRel);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(childRel);
    }
  }
  await visit('');
  return out.sort(byCodePoint);
}

/** @param {string} p */
export async function readText(p) {
  return readFile(p, 'utf8');
}

/** @param {string} a @param {string} b */
export function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
