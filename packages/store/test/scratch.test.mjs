// withScratchFile (a throwaway file outside any book, for SQLite's VACUUM INTO on Node 22) and store.removeEmptyDir (a folder an
// operation emptied). Both exist so no package outside @storyforge/store writes or deletes files (single-writer.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore, withScratchDir, withScratchFile } from '../src/index.mjs';
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

test('withScratchDir gives a private folder with write/read/path and removes it when the callback resolves', async () => {
  let root;
  const out = await withScratchDir('sf-test', async (dir) => {
    root = dir.root;
    assert.ok(root.startsWith(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sf-test-'));
    assert.equal(dir.path('book.epub'), path.join(root, 'book.epub'));
    await dir.write('book.epub', Buffer.from('hello'));
    await dir.write('note.txt', 'text');
    assert.equal((await dir.read('book.epub')).toString(), 'hello');
    assert.equal((await dir.read('note.txt', { maxBytes: 4 })).toString(), 'text');
    assert.ok(existsSync(root));
    return 7;
  });
  assert.equal(out, 7);
  assert.equal(existsSync(root), false);
});

test('withScratchDir read refuses a file over maxBytes and reports a missing file', async () => {
  await withScratchDir('sf-test', async (dir) => {
    await dir.write('big.bin', Buffer.alloc(11));
    await assert.rejects(() => dir.read('big.bin', { maxBytes: 10 }), { code: 'TOO_LARGE' });
    assert.equal((await dir.read('big.bin', { maxBytes: 11 })).length, 11);
    await assert.rejects(() => dir.read('missing.bin'), { code: 'ENOENT' });
  });
});

test('withScratchDir removes the folder when the callback throws', async () => {
  let root;
  await assert.rejects(
    withScratchDir('sf-test', async (dir) => {
      root = dir.root;
      await dir.write('a.bin', 'x');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(existsSync(root), false);
});

test('withScratchDir removes the folder when the work is cancelled (abort rejects the callback)', async () => {
  let root;
  const ac = new AbortController();
  const run = withScratchDir('sf-test', async (dir) => {
    root = dir.root;
    await dir.write('a.bin', 'x');
    await new Promise((resolve, reject) => {
      ac.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      setImmediate(() => ac.abort());
    });
  });
  await assert.rejects(run, /cancelled/);
  assert.equal(existsSync(root), false);
});

test('withScratchDir refuses folder names in the prefix and in file names', async () => {
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 5]) {
    await assert.rejects(withScratchDir(bad, async () => null), /plain file name/);
  }
  await withScratchDir('sf-test', async (dir) => {
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'sub/../x']) {
      assert.throws(() => dir.path(bad), /plain file name/);
      await assert.rejects(dir.write(bad, 'x'), /plain file name/);
      await assert.rejects(dir.read(bad), /plain file name/);
    }
  });
});
