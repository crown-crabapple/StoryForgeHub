// M01-J04 acceptance 11: a symlink that leaves the book root is refused by the store and never indexed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../../core/src/index.mjs';
import { openStore } from '../src/index.mjs';
import { copyFixture, sha256, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const repos = [];
after(async () => {
  for (const r of repos) await r.close?.();
});

async function outsideDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-outside-'));
  await fs.writeFile(path.join(dir, 'secret.md'), 'OUTSIDE secret bytes\n');
  await fs.writeFile(
    path.join(dir, '0099-outside.md'),
    '---\nschema: storyforge.scene/v1\nid: scene_01S5000000000000000000009Z\ntitle: Outside\nact: 1\nchapter: 1\nsequence: 99\n---\nOUTSIDE zorblax words\n',
  );
  return dir;
}

/** Create a symlink; returns null on success or a reason string if the OS refuses. */
async function tryLink(target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return null;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOSYS') return `${e.code}: cannot create symlinks on this machine`;
    throw e;
  }
}

test('symlinked directory: write/create/move through it are refused OUTSIDE_ROOT and nothing outside changes', async (t) => {
  const root = await copyFixture('valid/salt-orchard');
  const out = await outsideDir();
  const reason = await tryLink(out, path.join(root, 'research', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  if (reason) return t.skip(reason);
  const outBefore = await snapshot(out);
  const store = await openStore(root);

  const secret = await fs.readFile(path.join(out, 'secret.md'));
  const w = await store.write('research/escape/secret.md', Buffer.from('PWNED\n'), { baseSha256: sha256(secret) });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'OUTSIDE_ROOT');

  const c = await store.create('research/escape/new.md', Buffer.from('new\n'));
  assert.equal(c.ok, false);
  assert.equal(c.code, 'OUTSIDE_ROOT');

  const m = await store.move('research/tidal-ranges.md', 'research/escape/moved.md', {
    baseSha256: sha256(await fs.readFile(path.join(root, 'research', 'tidal-ranges.md'))),
  });
  assert.equal(m.ok, false);
  assert.equal(m.code, 'OUTSIDE_ROOT');
  await fs.access(path.join(root, 'research', 'tidal-ranges.md'));

  assert.deepEqual(await snapshot(out), outBefore, 'the outside directory is untouched');
});

test('symlinked file: write is refused OUTSIDE_ROOT and the target is unchanged', async (t) => {
  const root = await copyFixture('valid/salt-orchard');
  const out = await outsideDir();
  const reason = await tryLink(path.join(out, 'secret.md'), path.join(root, 'research', 'link.md'), 'file');
  if (reason) return t.skip(reason);
  const store = await openStore(root);
  const secret = await fs.readFile(path.join(out, 'secret.md'));

  const w = await store.write('research/link.md', Buffer.from('PWNED\n'), { baseSha256: sha256(secret) });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'OUTSIDE_ROOT');
  assert.deepEqual(await fs.readFile(path.join(out, 'secret.md')), secret);
});

test('symlinked directory under manuscript/ is not validated or indexed', async (t) => {
  const root = await copyFixture('valid/salt-orchard');
  const out = await outsideDir();
  const reason = await tryLink(out, path.join(root, 'manuscript', 'act-01-low-water', 'ch-009-escape'), process.platform === 'win32' ? 'junction' : 'dir');
  if (reason) return t.skip(reason);

  const result = await validate(root);
  const book = result.books.find((b) => b.id === BOOK);
  assert.equal(book.order.length, 7, 'scene count unchanged');
  assert.ok(!book.order.some((s) => s.path.includes('ch-009-escape')));
  assert.ok(!result.diagnostics.some((d) => d.file.includes('ch-009-escape')), 'no diagnostics about the linked directory');

  const repo = createFsRepository(root, { watch: false });
  repos.push(repo);
  await repo.rebuildIndex(BOOK);
  const detail = await repo.getBook(BOOK);
  assert.equal(detail.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).length, 7);
  const hits = await repo.search('zorblax', { bookId: BOOK });
  const rows = Array.isArray(hits) ? hits : hits?.results ?? [];
  assert.deepEqual(rows, [], 'content behind the link is not searchable');
});
