// The one module of this package that touches the filesystem. Reads are free; every write is checked to
// land inside the work folder (<framework>/.work/<work-id>/) or, for the style checker's own report, to be
// a read. The only book writes (M05-J06) are the last two functions: new files under <book>/suggestions/ and
// `publish`'s replace; both go through @storyforge/store.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, replaceWorkDir, writeWorkFile } from '@storyforge/store';

/** Thrown for usage and I/O problems; the CLI maps it to exit code 2. */
export class UsageError extends Error {}

/** Thrown when a command refuses to act (stale hash, missing --confirm, failed check); the CLI maps it to exit code 1. */
export class RefusedError extends Error {}

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export const isFileSync = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
export const isDirSync = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const readText = (p) => fs.readFileSync(p, 'utf8');
export const readBytes = (p) => fs.readFileSync(p);
export const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const mtimeIso = (p) => fs.statSync(p).mtime.toISOString();
export const mtimeMs = (p) => fs.statSync(p).mtimeMs;

/** Names in a folder (files only), sorted; [] if it does not exist. @param {string} dir */
export function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** A writer bound to one work folder. Every path is relative to it and must stay inside it. */
export class WorkDir {
  /** @param {string} dir absolute path of <framework>/.work/<work-id> */
  constructor(dir) {
    this.dir = path.resolve(dir);
    /** @type {string[]} forward-slash paths relative to the work dir, in write order */
    this.written = [];
  }

  /** @param {string} rel @returns {string} */
  abs(rel) {
    const target = path.resolve(this.dir, ...rel.split('/'));
    if (!inside(this.dir, target)) throw new UsageError(`refusing to write outside the work folder: ${rel}`);
    return target;
  }

  /**
   * Replace <work>/context/ entirely with `files` (paths relative to <work>/, all under context/).
   * @param {Map<string, string>} files
   */
  async replaceContext(files) {
    const entries = [];
    for (const [rel, text] of files) {
      this.abs(rel);
      if (!rel.startsWith('context/')) throw new UsageError(`not a context file: ${rel}`);
      entries.push([rel.slice('context/'.length), text]);
      this.written.push(rel);
    }
    await replaceWorkDir(this.abs('context'), entries);
  }

  /** @param {string} rel @param {string} text */
  async write(rel, text) {
    await writeWorkFile(this.abs(rel), text);
    this.written.push(rel);
  }

  /** Copy a file into the work folder. @param {string} from absolute source @param {string} rel */
  async copyIn(from, rel) {
    await writeWorkFile(this.abs(rel), fs.readFileSync(from));
    this.written.push(rel);
  }
}

/**
 * Create new files under <book>/suggestions/ in one store batch (all or none). Never touches an existing file.
 * @param {string} bookRoot @param {{ rel: string, bytes: Buffer }[]} files
 */
export async function createSuggestionFiles(bookRoot, files) {
  for (const f of files) {
    if (!/^suggestions\/[^/]+(\/[^/]+)*\.md$/.test(f.rel)) throw new UsageError(`not a suggestion path: ${f.rel}`);
  }
  const store = await openStore(bookRoot);
  // Names carry a one-second timestamp: a taken name gets -2, -3 … (f.rel is updated so callers print the real path).
  const taken = new Set();
  for (const f of files) {
    const first = f.rel;
    for (let n = 2; taken.has(f.rel) || (await store.exists(f.rel)); n++) f.rel = first.replace(/\.md$/, `-${n}.md`);
    taken.add(f.rel);
  }
  const r = await store.batch('claude-book.suggest', { files: files.map((f) => f.rel) }, async (tx) => {
    for (const f of files) await tx.create(f.rel, f.bytes);
  });
  if (!r.ok) throw new Error(`could not create the suggestion file(s): ${r.code}${r.message ? ` (${r.message})` : ''}`);
}

/**
 * Replace one existing file through the store, only if its bytes still hash to `baseSha256`.
 * @param {string} bookRoot @param {string} rel @param {Buffer} bytes @param {string} baseSha256
 * @returns {Promise<{ ok: true, sha256: string } | { ok: false, code: string }>}
 */
export async function replaceBookFile(bookRoot, rel, bytes, baseSha256) {
  const store = await openStore(bookRoot);
  const r = await store.write(rel, bytes, { baseSha256 });
  return r.ok ? { ok: true, sha256: r.sha256 } : { ok: false, code: r.code };
}
