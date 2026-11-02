import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createFsRepository } from '../../core/src/index.mjs';
import {
  SALT_BOOK, SALT_LOWTIDE_ID, copyFixture, dbPathOf, openFor, plain,
} from './helpers.mjs';

const SCENES = ['scene_01S50000000000000000000001', SALT_LOWTIDE_ID, 'scene_01S50000000000000000000009'];

async function readAll(repo) {
  return {
    book: plain(await repo.getBook(SALT_BOOK)),
    books: plain(await repo.listBooks()),
    scenes: plain(await Promise.all(SCENES.map((s) => repo.getScene(SALT_BOOK, s)))),
  };
}

test('reads while a rebuild runs (no index yet) are correct and never throw INDEX_NOT_READY', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const reference = await readAll(createFsRepository(await copyFixture('valid/salt-orchard')));
  const repo = createFsRepository(root);

  const rebuild = repo.rebuildIndex(SALT_BOOK);
  const during = [];
  for (let i = 0; i < 5; i++) during.push(readAll(repo));
  const results = await Promise.all(during); // any rejection (incl. INDEX_NOT_READY) fails here
  for (const r of results) assert.deepEqual(r, reference);

  const done = await rebuild;
  assert.notEqual(done?.ok, false, JSON.stringify(done));
  assert.deepEqual(await readAll(repo), reference, 'same answers once the index is fresh');
});

test('reads while a rebuild replaces an existing index are correct', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const reference = await readAll(repo);
  const bytesBefore = await fs.readFile(dbPathOf(root));

  const rebuild = repo.rebuildIndex(SALT_BOOK);
  const results = await Promise.all([readAll(repo), readAll(repo), readAll(repo)]);
  for (const r of results) assert.deepEqual(r, reference);
  await rebuild;

  // the file was replaced atomically: it is a complete SQLite database before and after
  const bytesAfter = await fs.readFile(dbPathOf(root));
  assert.equal(bytesBefore.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.equal(bytesAfter.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.deepEqual(await readAll(repo), reference);
});

test('a read during a rebuild after an external edit returns the edited text', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const idxFile = (await fs.readdir(root + '/manuscript/act-02-high-water/ch-003-the-wall')).find((f) => f.startsWith('0010'));
  const file = `${root}/manuscript/act-02-high-water/ch-003-the-wall/${idxFile}`;
  await fs.appendFile(file, '\nexternal edit during rebuild marker\n');

  const rebuild = repo.rebuildIndex(SALT_BOOK);
  const scene = await repo.getScene(SALT_BOOK, SALT_LOWTIDE_ID);
  assert.ok(scene.body.includes('external edit during rebuild marker'));
  await rebuild;
  assert.ok((await repo.getScene(SALT_BOOK, SALT_LOWTIDE_ID)).body.includes('external edit during rebuild marker'));
});

test('idx.status() reports "building" while a rebuild is in flight', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { idx } = await openFor(root);
  let settled = false;
  const p = idx.rebuild().finally(() => { settled = true; });
  const st = plain(await idx.status());
  if (!settled) assert.equal(st.state, 'building');
  await p;
  assert.equal((await idx.status()).state, 'fresh');
});

test('concurrent rebuild() calls share one build and both succeed with the same counts', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { idx } = await openFor(root);
  const [a, b, c] = await Promise.all([idx.rebuild(), idx.rebuild(), idx.rebuild()]);
  for (const r of [a, b, c]) assert.equal(r.ok, true);
  assert.deepEqual(plain(b.counts), plain(a.counts));
  assert.deepEqual(plain(c.counts), plain(a.counts));
  assert.equal((await idx.status()).state, 'fresh');
});

test('a reader opening index.sqlite while rebuilds repeat never sees a partial database', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { idx, dbPath } = await openFor(root);
  await idx.rebuild();
  const { DatabaseSync } = await import('node:sqlite');
  let stop = false;
  const writer = (async () => {
    while (!stop) await idx.rebuild();
  })();
  try {
    for (let i = 0; i < 25; i++) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const n = db.prepare('SELECT count(*) AS n FROM scenes').get().n;
        assert.equal(n, 7);
      } finally {
        db.close();
      }
    }
  } finally {
    stop = true;
    await writer;
  }
});
