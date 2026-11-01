// Acceptance 8: no operation ever discards prose. Every body that existed before still exists
// byte-for-byte somewhere in the book or its .storyforge/trash/.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { applyRepair, insertScene, moveScene, planRepair, rebuildIndex, renumberChapter } from '../src/index.mjs';
import { ARRIVAL, FERRY, GRAFTING, KEY, LOWTIDE, SALT, WALL, allBodyHashes, cleanup, copyFixture, edit, P, rename } from './helpers.mjs';

after(cleanup);

function assertNoProseLost(dir, originals, label) {
  const now = allBodyHashes(dir);
  const lost = [...originals].filter((h) => !now.has(h));
  assert.deepEqual(lost, [], `${label}: ${lost.length} original bodies are gone`);
}

describe('never discards prose (acceptance 8)', () => {
  it('a sequence of insert/move/renumber/rebuild on salt-orchard loses nothing after each step', async () => {
    const dir = copyFixture(SALT);
    const originals = allBodyHashes(dir);
    assert.ok(originals.size >= 7);

    const steps = [
      ['insert after', () => insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'N1', slug: 'n1', body: 'n1\n' })],
      ['insert start', () => insertScene(dir, { chapter: 1, after: null, title: 'N2', slug: 'n2', body: 'n2\n' })],
      ['move cross-chapter', () => moveScene(dir, KEY, { chapter: 3, after: LOWTIDE })],
      ['move to first', () => moveScene(dir, GRAFTING, { chapter: 2, after: null })],
      ['move to last', () => moveScene(dir, FERRY, { chapter: 3, after: WALL })],
      ['renumber ch1', () => renumberChapter(dir, 1)],
      ['renumber ch3', () => renumberChapter(dir, 3, { step: 7 })],
      ['rebuild index', () => rebuildIndex(dir)],
    ];
    for (const [label, run] of steps) {
      const r = await run();
      assert.equal(r.code, 'OK', `${label}: ${JSON.stringify(r)}`);
      assertNoProseLost(dir, originals, label);
    }
  });

  it('a no-gap insert (renumber + insert in one op) loses nothing', async () => {
    const dir = copyFixture(SALT);
    edit(dir, P.GRAFTING, (t) => t.replace(/^sequence: 20$/m, 'sequence: 11'));
    rename(dir, P.GRAFTING, 'manuscript/act-01-low-water/ch-002-the-grafting/0011-the-grafting.md');
    const originals = allBodyHashes(dir);
    const r = await insertScene(dir, { chapter: 2, after: FERRY, title: 'M', slug: 'm', body: 'm\n' });
    assert.equal(r.code, 'OK');
    assertNoProseLost(dir, originals, 'no-gap insert');
  });

  it('repair of W201/W202 loses nothing', async () => {
    const dir = copyFixture('valid/spec-example');
    const originals = allBodyHashes(dir);
    const r = await applyRepair(dir, (await planRepair(dir)).actions);
    assert.equal(r.code, 'OK');
    assertNoProseLost(dir, originals, 'spec-example repair');
  });

  it('repair of E204 loses nothing', async () => {
    const dir = copyFixture('invalid/E204-duplicate-sequence');
    const originals = allBodyHashes(dir);
    const r = await applyRepair(dir, (await planRepair(dir)).actions);
    assert.equal(r.code, 'OK');
    assertNoProseLost(dir, originals, 'E204 repair');
  });
});
