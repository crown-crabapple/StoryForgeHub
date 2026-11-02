// M01-J04 acceptance 7: with fs.watch unavailable the repository falls back to polling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createServer } from '../../../apps/server/src/server.mjs';
import { ARRIVAL, ARRIVAL_REL, BOOK, abs, plain, rowsOf, setup, stateOf, waitFor } from './watch-helpers.mjs';

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('7. watch forced to fail: an external edit is still picked up by polling; status reports mode poll with a reason', async (t) => {
  const { root, repo } = await setup(t, { opts: { watch: 'fail', pollMs: 200, debounceMs: 50 } });
  const server = createServer({ repository: repo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  });
  const { port } = server.address();

  const file = abs(root, ARRIVAL_REL);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${text.trimEnd()}\n\nA pollonly marker: glimmerthorn.\n`);

  await waitFor(async () => rowsOf(plain(await repo.search('glimmerthorn', { bookId: BOOK }))).some((r) => r.id === ARRIVAL), {
    what: 'poll to pick up the external edit',
  });
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh' });

  const r = await getJson(port, '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.watch.mode, 'poll');
  assert.equal(typeof r.json.watch.reason, 'string');
  assert.ok(r.json.watch.reason.length > 0, 'a non-empty reason');
});

test('7b. polling also picks up an external invalidation', async (t) => {
  const { root, repo } = await setup(t, { opts: { watch: 'fail', pollMs: 200, debounceMs: 50 } });
  const rel = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0030-stray.md';
  await fs.writeFile(abs(root, rel), '---\nid: [nope\n---\nx\n');
  await waitFor(async () => (await stateOf(repo)) === 'invalid', { what: 'poll to mark the book invalid' });
});
