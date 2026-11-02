// M05-J07 acceptance 6: a fault injected between the target write and the receipt write (store `__faults`) rolls BOTH back: the scene, the suggestion,
// the receipt and the content objects are byte-identical afterwards, and the same action without the fault then lands target and receipt together.
// In-process (the fault switch lives in the store module the repository uses); HTTP for everything else.
// Contract: docs/contracts/M05-J07-receipts.md section 3 ("same batch as the target write") and 8.6.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { __faults } from '../../../packages/store/src/index.mjs';
import { ARRIVAL, ARRIVAL_PATH, RCPT, bytesUnder, chainOf, checkChain, listFiles, opOf, readReceipts, sha, splitLines } from './receipts-helpers.mjs';
import { BOOK, closeAll, freshBook, send } from './move-helpers.mjs';
import { NEW, SUG_ID, readBytes, withSuggestion } from './suggest-helpers.mjs';
import { request } from './helpers.mjs';
import path from 'node:path';

after(async () => {
  __faults.at = null;
  await closeAll();
});

const WATCHED = ['provenance', 'suggestions', 'manuscript'];
const decide = (port, hunk, decision = 'accept') => send(port, 'POST', `/api/books/${BOOK}/suggestions/${SUG_ID}/hunks/${hunk}`, { body: { decision } });

for (const point of ['after-tmp', 'after-rename', 'before-done']) {
  test(`fault at ${point} during Accept: scene, suggestion, receipts and objects are all rolled back; the retry writes target + receipt together`, async () => {
    const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
    assert.equal((await request(port, 'GET', `/api/books/${BOOK}/scenes/${ARRIVAL}`)).status, 200); // opened: baseline
    const flushed = await send(port, 'POST', RCPT.flush(), { body: { sceneId: ARRIVAL } });
    assert.ok(flushed.status < 300, flushed.text);
    const original = await readBytes(root, ARRIVAL_PATH);
    const provFiles = await listFiles(path.join(root, 'provenance'));
    assert.ok(provFiles.length > 0, 'precondition: the baseline exists');
    const frozen = await bytesUnder(root, WATCHED);

    __faults.at = point;
    let r;
    try {
      r = await decide(port, 'h2');
    } finally {
      __faults.at = null;
    }
    assert.ok(r.status >= 400, `the injected fault surfaces as an error, got ${r.status}`);
    assert.deepEqual(await bytesUnder(root, WATCHED), frozen, 'target, suggestion and provenance/ all exactly as before');
    assert.deepEqual(await listFiles(path.join(root, 'provenance')), provFiles, 'no receipt and no object were left behind');
    assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(original));
    assert.deepEqual(await checkChain(root, { [ARRIVAL]: original }), [], 'the chain is still whole and the scene still matches its last receipt');

    // the same action without the fault: both land
    const ok = await decide(port, 'h2');
    assert.equal(ok.status, 200, ok.text);
    const after = await readBytes(root, ARRIVAL_PATH);
    assert.ok(!after.equals(original));
    assert.equal(splitLines(after)[16], NEW[17]);
    const chain = chainOf(await readReceipts(root), ARRIVAL);
    assert.equal(chain.at(-1).fm.operation, 'suggestion.accept');
    assert.equal(chain.at(-1).fm.before_sha256, sha(original));
    assert.equal(chain.at(-1).fm.after_sha256, sha(after), 'the receipt names exactly the bytes that landed');
    assert.deepEqual(await checkChain(root, { [ARRIVAL]: after }), []);
    assert.equal(opOf(chain.at(-1).fm), 'suggestion.accept');
  });
}

test('fault during the author flush (receipt only): no half receipt, no orphan object, and a later flush still records the author edit', async () => {
  const { root, port } = await freshBook('valid/salt-orchard');
  const scene = (await request(port, 'GET', `/api/books/${BOOK}/scenes/${ARRIVAL}`)).json;
  const put = await send(port, 'PUT', RCPT.body(ARRIVAL), { body: { body: `${scene.body}\n\nAn extra line.`, base_sha256: scene.sha256 } });
  assert.equal(put.status, 200, put.text);
  const frozen = await bytesUnder(root, ['provenance']);
  const files = await listFiles(path.join(root, 'provenance'));
  __faults.at = 'after-tmp';
  let r;
  try {
    r = await send(port, 'POST', RCPT.flush(), { body: { sceneId: ARRIVAL } });
  } finally {
    __faults.at = null;
  }
  assert.ok(r.status >= 400, `got ${r.status}`);
  assert.deepEqual(await bytesUnder(root, ['provenance']), frozen);
  assert.deepEqual(await listFiles(path.join(root, 'provenance')), files);
  const bytes = await readBytes(root, ARRIVAL_PATH);
  assert.ok(bytes.toString('utf8').endsWith('An extra line.'), 'the author\'s own save is never lost');
  const ok = await send(port, 'POST', RCPT.flush(), { body: { sceneId: ARRIVAL } });
  assert.ok(ok.status < 300, ok.text);
  const chain = chainOf(await readReceipts(root), ARRIVAL);
  assert.equal(chain.at(-1).fm.operation, 'author.edit');
  assert.equal(chain.at(-1).fm.after_sha256, sha(bytes));
  assert.deepEqual(await checkChain(root, { [ARRIVAL]: bytes }), []);
});
