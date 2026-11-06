import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';

// `unlink` / `unlinkSync` as whole words: words like "unlinked" (Story Planner counts) are not file calls.
const WRITE_CALLS = /writeFile|appendFile|rename\(|copyFile|\bunlink(?:Sync)?\b|rmSync|rmdir|\brm\(|mkdir|createWriteStream/;
const EXT = /\.(mjs|js|jsx)$/;
const STORE_SRC = path.join(REPO_ROOT, 'packages', 'store', 'src');

async function listDirs(parent) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (EXT.test(e.name)) out.push(full);
  }
  return out;
}

async function sourceFiles() {
  const roots = [path.join(REPO_ROOT, 'scripts')];
  for (const group of ['packages', 'apps']) {
    for (const pkg of await listDirs(path.join(REPO_ROOT, group))) roots.push(path.join(pkg, 'src'));
  }
  const files = [];
  for (const r of roots) await walk(r, files);
  return files.filter((f) => !f.startsWith(STORE_SRC + path.sep));
}

test('no file write/rename/delete/mkdir call exists outside packages/store/src', async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 10, `scanned a plausible number of files (${files.length})`);
  const offenders = [];
  for (const f of files) {
    const lines = (await fs.readFile(f, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (WRITE_CALLS.test(line)) offenders.push(`${path.relative(REPO_ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the scan covers the known source trees', async () => {
  const rel = (await sourceFiles()).map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  for (const expected of [
    'packages/core/src/fs-repository.mjs',
    'packages/manuscript/src/commit.mjs',
    'apps/server/src/server.mjs',
  ]) {
    assert.ok(rel.includes(expected), `${expected} is scanned`);
  }
  assert.ok(rel.every((r) => !r.startsWith('packages/store/src/')));
});

test('packages/core/src/fs-repository.mjs has no write calls', async () => {
  const text = await fs.readFile(path.join(REPO_ROOT, 'packages/core/src/fs-repository.mjs'), 'utf8');
  assert.doesNotMatch(text, WRITE_CALLS);
  assert.doesNotMatch(text, /writeFile|rename|copyFile|unlink|\brm\b/);
});
