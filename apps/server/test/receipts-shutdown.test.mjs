// M05-J07 follow-up: author saves that were not flushed yet are recorded as author.edit when the server stops gracefully (repository.close() is what
// main.mjs's stop() runs through host.close(), before it releases the lock), so a restart never mistakes them for outside changes.
// Windows cannot deliver a catchable SIGTERM to a child process, so this drives the graceful stop programmatically (the same close() path) in-process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { ARRIVAL, ARRIVAL_PATH, chainOf, checkChain, readReceipts } from './receipts-helpers.mjs';
import { BOOK, freshLibrary } from './ai-helpers.mjs';
import { readBytes } from './suggest-helpers.mjs';

test('two saved edits, graceful stop, restart: the change is an author.edit receipt, not external.change', async () => {
  const library = await freshLibrary();
  const opts = { watch: false, pollMs: 0 };
  const repo = createFsRepository(library, opts);
  let scene = await repo.getScene(BOOK, ARRIVAL);
  for (const tail of ['First added line.', 'Second added line.']) {
    const r = await repo.updateSceneBody(BOOK, ARRIVAL, `${scene.body}\n\n${tail}`, { baseSha256: scene.sha256 });
    assert.equal(r.ok, true);
    scene = await repo.getScene(BOOK, ARRIVAL);
  }
  const before = chainOf(await readReceipts(library), ARRIVAL).map((r) => r.fm.operation);
  assert.deepEqual(before, ['baseline'], 'saves alone only wrote the baseline');

  await repo.close(); // the graceful stop

  const final = await readBytes(library, ARRIVAL_PATH);
  const repo2 = createFsRepository(library, { watch: true, pollMs: 0 }); // restart with the watcher (catch-up marks changed scenes)
  await repo2.getScene(BOOK, ARRIVAL);
  await repo2.flushReceipts(BOOK, ARRIVAL);
  const chain = chainOf(await readReceipts(library), ARRIVAL);
  await repo2.close();
  assert.deepEqual(chain.map((r) => r.fm.operation), ['baseline', 'author.edit']);
  assert.equal(chain.at(-1).fm.actor, 'author');
  assert.deepEqual(await checkChain(library, { [ARRIVAL]: final }), []);
});

test('an outside write right after a server save (no waiting) is external.change; our save stays author.edit', async () => {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const library = await freshLibrary();
  const repo = createFsRepository(library, { watch: false, pollMs: 0 });
  const scene = await repo.getScene(BOOK, ARRIVAL);
  const r = await repo.updateSceneBody(BOOK, ARRIVAL, `${scene.body}\n\nOur own line.`, { baseSha256: scene.sha256 });
  assert.equal(r.ok, true);
  const file = path.join(library, ...ARRIVAL_PATH.split('/'));
  const mine = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, `${mine}\nAn outside line.\n`); // inside the own-write suppression window
  const f = await repo.flushReceipts(BOOK, ARRIVAL);
  assert.equal(f.ok, true);
  const chain = chainOf(await readReceipts(library), ARRIVAL);
  assert.deepEqual(chain.map((x) => x.fm.operation), ['baseline', 'author.edit', 'external.change']);
  assert.ok(chain[2].body.includes('An outside line.') && !chain[1].body.includes('An outside line.'));
  const final = await readBytes(library, ARRIVAL_PATH);
  assert.deepEqual(await checkChain(library, { [ARRIVAL]: final }), []);
  const v = await repo.verifyReceipts(BOOK);
  assert.equal(v.ok, true);
  await repo.close();
});
