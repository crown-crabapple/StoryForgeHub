// M05-J06 section 3 ("Fix from M05-J05"): ledger.md status is computed as of the target chapter.
//   payoff after chapter n -> status open; setup after chapter n -> the thread is omitted.
// salt-orchard: brass-key is set up in scene 03 (chapter 1) and paid off in scene 09 (chapter 3).
// Contract: docs/contracts/M05-J06-author-check-suggest.md section 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseConcatenatedJson, put, read } from './helpers.mjs';
import { setup } from './author-helpers.mjs';

const THREAD = 'planning/threads/brass-key.md';
const WALL = 'scene_01S50000000000000000000009';

function ledger(fw) {
  const f = `${fw}/.work/salt-orchard/context/ledger.md`;
  return fs.existsSync(f) ? parseConcatenatedJson(fs.readFileSync(f, 'utf8')) : [];
}
const key = (items) => items.find((i) => i.slug === 'brass-key');

test('payoff after the target chapter: chapter 1 and 2 show brass-key open with no payoff; chapter 3 shows it paid-off in 3', () => {
  for (const n of [1, 2]) {
    const { fw, go } = setup();
    assert.equal(go('context', { chapter: n }).status, 0);
    const k = key(ledger(fw));
    assert.ok(k, `brass-key in the chapter ${n} ledger`);
    assert.equal(k.status, 'open', `chapter ${n}`);
    assert.equal(String(k.planted_in), '1');
    assert.equal(String(k.payoff_in ?? ''), '', `chapter ${n}: the later payoff is not shown`);
  }
  const { fw, go } = setup();
  assert.equal(go('context', { chapter: 3 }).status, 0);
  const k = key(ledger(fw));
  assert.equal(k.status, 'paid-off');
  assert.equal(String(k.payoff_in), '3');
});

test('setup after the target chapter: the thread is omitted from that chapter ledger', () => {
  const { book, fw, go } = setup();
  const text = read(book, THREAD).replace(/^setup: .*$/m, `setup: [${WALL}]`);
  assert.ok(text.includes(WALL));
  put(book, THREAD, text);
  assert.equal(go('context', { chapter: 1 }).status, 0);
  assert.equal(key(ledger(fw)), undefined, 'a thread planted in chapter 3 is not in the chapter 1 ledger');
  assert.equal(go('context', { chapter: 3 }).status, 0);
  assert.ok(key(ledger(fw)), 'it appears once the target chapter reaches its setup');
});
