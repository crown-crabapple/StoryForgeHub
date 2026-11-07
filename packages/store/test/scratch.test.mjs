// withScratchFile (a throwaway file outside any book, for SQLite's VACUUM INTO on Node 22) and store.removeEmptyDir (a folder an
// operation emptied). Both exist so no package outside @storyforge/store writes or deletes files (single-writer.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore, withScratchFile } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

test('withScratchFile gives a fresh path under the temp folder and removes its folder afterwards', () => {
  let seen;
  const out = withScratchFile('index.sqlite', (file) => {
    seen = file;
    assert.equal(existsSync(file), false);
    assert.ok(file.startsWith(os.tmpdir()));
    assert.equal(path.basename(file), 'index.sqlite');
    writeFileSync(file, 'x');
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(existsSync(path.dirname(seen)), false);
});

test('withScratchFile cleans up when the callback throws, and refuses a name with folders', () => {
  let seen;
  assert.throws(() =>
    withScratchFile('a.bin', (file) => {
      seen = file;
      writeFileSync(file, 'x');
      throw new Error('boom');
    }),
  /boom/);
  assert.equal(existsSync(path.dirname(seen)), false);
  for (const bad of ['', '../x', 'a/b', '.hidden']) assert.throws(() => withScratchFile(bad, () => null), /plain file name/);
});

test('removeEmptyDir removes an empty folder and nothing else', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  await fs.mkdir(path.join(root, 'manuscript', 'act-01-low-water', 'ch-009-empty'));
  assert.equal(await store.removeEmptyDir('manuscript/act-01-low-water/ch-009-empty'), true);
  assert.equal(existsSync(path.join(root, 'manuscript', 'act-01-low-water', 'ch-009-empty')), false);

  // a folder with files, a file, the root, .storyforge and a path outside the book are all left alone
  assert.equal(await store.removeEmptyDir('manuscript/act-01-low-water/ch-001-the-drowned-rows'), false);
  assert.equal(await store.removeEmptyDir('manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md'), false);
  assert.equal(await store.removeEmptyDir(''), false);
  await fs.mkdir(path.join(root, '.storyforge', 'empty'), { recursive: true });
  assert.equal(await store.removeEmptyDir('.storyforge/empty'), false);
  assert.equal(await store.removeEmptyDir('../outside'), false);
  assert.ok(existsSync(path.join(root, 'manuscript', 'act-01-low-water', 'ch-001-the-drowned-rows', '0010-arrival.md')));
  assert.ok(existsSync(path.join(root, '.storyforge', 'empty')));
});
