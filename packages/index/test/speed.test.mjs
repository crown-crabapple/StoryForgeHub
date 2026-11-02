import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFsRepository } from '../../core/src/index.mjs';
import { SALT_BOOK, copyFixture } from './helpers.mjs';

test('getBook on salt-orchard with a fresh index: median of 20 calls under 50 ms', async (t) => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const st = await repo.indexStatus(SALT_BOOK);
  assert.equal(st.state, 'fresh');

  for (let i = 0; i < 3; i++) await repo.getBook(SALT_BOOK); // warm-up
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const book = await repo.getBook(SALT_BOOK);
    times.push(performance.now() - start);
    assert.equal(book.id, SALT_BOOK);
  }
  times.sort((a, b) => a - b);
  const median = (times[9] + times[10]) / 2;
  t.diagnostic(`getBook median over 20 calls: ${median.toFixed(2)} ms (min ${times[0].toFixed(2)}, max ${times[19].toFixed(2)})`);
  assert.ok(median < 50, `median ${median.toFixed(2)} ms must be under 50 ms`);
});
