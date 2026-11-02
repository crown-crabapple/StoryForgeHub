import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../format/fixtures');

/** Copy a fixture (e.g. 'valid/salt-orchard') into a fresh temp dir; returns its path. */
export async function copyFixture(rel) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-core-'));
  const dest = path.join(base, path.basename(rel));
  await fs.cp(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}

/** sha256 of every file (and directory name) under root, keyed by relative path. */
export async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[rel + '/'] = 'dir';
        await walk(full);
      } else {
        out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    }
  }
  await walk(root);
  return out;
}

export async function readExpected(rel) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, rel, 'expected.json'), 'utf8'));
}
