// M05-J07 contract 2(c): leaving a scene (another one opened, the editor closed) or hiding the page asks the server to record the author's saved changes.
// Model level: flushOnLeave sends exactly the flush request, never throws, never waits; pagehide uses keepalive.
import assert from 'node:assert/strict';
import test from 'node:test';
import { flushOnLeave } from '../src/receipts/model.js';

test('flushOnLeave posts { sceneId } to the receipts flush route with the write-guard header', () => {
  const calls = [];
  flushOnLeave('book_X', 'scene_Y', { fetchImpl: (url, init) => (calls.push([url, init]), Promise.resolve({})) });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, '/api/books/book_X/receipts/flush');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-storyforge'], '1');
  assert.deepEqual(JSON.parse(init.body), { sceneId: 'scene_Y' });
  assert.equal(init.keepalive, undefined);
});

test('pagehide: keepalive; a failing or throwing fetch never surfaces', async () => {
  const seen = [];
  flushOnLeave('b', 's', { keepalive: true, fetchImpl: (u, i) => (seen.push(i), Promise.reject(new Error('offline'))) });
  assert.equal(seen[0].keepalive, true);
  assert.doesNotThrow(() => flushOnLeave('b', 's', { fetchImpl: () => { throw new Error('boom'); } }));
  await new Promise((r) => setImmediate(r));
});
