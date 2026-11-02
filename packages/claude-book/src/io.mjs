// The one module of this package that touches the filesystem. Reads are free; every write is checked to
// land inside the work folder (<framework>/.work/<work-id>/) or, for the style checker's own report, to be
// a read. Nothing here ever writes into a book folder.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Thrown for usage and I/O problems; the CLI maps it to exit code 2. */
export class UsageError extends Error {}

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

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Replace <work>/context/ entirely. The only delete the adapter performs. */
  resetContext() {
    const ctx = this.abs('context');
    fs.rmSync(ctx, { recursive: true, force: true });
    fs.mkdirSync(ctx, { recursive: true });
  }

  /** @param {string} rel @param {string} text */
  write(rel, text) {
    const target = this.abs(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    this.written.push(rel);
  }

  /** Copy a file into the work folder. @param {string} from absolute source @param {string} rel */
  copyIn(from, rel) {
    const target = this.abs(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    this.written.push(rel);
  }
}
