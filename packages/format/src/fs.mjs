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

/**
 * Markdown files of a series folder that belong to its shared world: everything below `codex/` and `archive/`
 * (paths relative to the series folder, forward slashes, sorted). Other series-level folders are ignored.
 * @param {string} seriesDir
 * @returns {Promise<string[]>}
 */
export async function walkSharedMarkdown(seriesDir) {
  /** @type {string[]} */
  const out = [];
  for (const sub of ['codex', 'archive']) {
    if (!(await isDirectory(path.join(seriesDir, sub)))) continue;
    for (const rel of await walkMarkdown(path.join(seriesDir, sub))) out.push(`${sub}/${rel}`);
  }
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

let readConcurrency = 24;
/** Concurrent file reads in flight at once during validate(). */
export const getReadConcurrency = () => readConcurrency;
/** Test hook: 1 gives the one-by-one order, to prove the concurrent path gives identical output. */
export function setReadConcurrency(n) {
  readConcurrency = n;
}

/**
 * Run `fn` over `items` with at most `n` in flight; results come back in the order of `items`.
 * @template T, R
 * @param {T[]} items @param {number} n @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, n, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * loadDoc-style calls run concurrently, but their diagnostics are replayed into `add` in the order of `items`,
 * so the Collector sees exactly the sequence a one-by-one loop would have produced.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, bufferedAdd: (...a: any[]) => void) => Promise<R>} fn
 * @param {(...a: any[]) => void} add
 * @returns {Promise<R[]>}
 */
export async function mapOrdered(items, fn, add) {
  const bufs = items.map(() => /** @type {any[][]} */ ([]));
  const results = await mapLimit(items, getReadConcurrency(), (item, i) => fn(item, (...a) => bufs[i].push(a)));
  for (const b of bufs) for (const a of b) add(...a);
  return results;
}
