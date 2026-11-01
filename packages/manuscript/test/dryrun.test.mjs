// Contract rule 7: every operation has { dryRun: true } that returns planned changes and writes nothing.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { applyRepair, insertScene, moveScene, planRepair, renumberChapter } from '../src/index.mjs';
import { ARRIVAL, CH2, KEY, LOWTIDE, P, SALT, addScene, cleanup, copyFixture, diffSnap, edit, rename, snapshot } from './helpers.mjs';

after(cleanup);

async function dry(dir, fn) {
  const before = snapshot(dir);
  const r = await fn();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');
  assert.ok(Array.isArray(r.changes) && r.changes.length > 0, 'planned changes are returned');
  assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] }, 'nothing written, not even trash or temp files');
  return r;
}

describe('dryRun', () => {
  it('insertScene', async () => {
    const dir = copyFixture(SALT);
    await dry(dir, () => insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'N', slug: 'n', body: 'b\n', dryRun: true }));
  });

  it('moveScene', async () => {
    const dir = copyFixture(SALT);
    await dry(dir, () => moveScene(dir, KEY, { chapter: 3, after: LOWTIDE, dryRun: true }));
  });

  it('renumberChapter', async () => {
    const dir = copyFixture(SALT);
    edit(dir, P.GRAFTING, (t) => t.replace(/^sequence: 20$/m, 'sequence: 15'));
    rename(dir, P.GRAFTING, `${CH2}/0015-the-grafting.md`);
    addScene(dir, `${CH2}/0035-extra.md`, { id: 'scene_01S50000000000000000000011', act: 1, chapter: 2, sequence: 35 });
    await dry(dir, () => renumberChapter(dir, 2, { dryRun: true }));
  });

  it('applyRepair', async () => {
    const dir = copyFixture('valid/spec-example');
    const { actions } = await planRepair(dir);
    await dry(dir, () => applyRepair(dir, actions, { dryRun: true }));
  });

  it('a dry run predicts what the real run does', async () => {
    const dir = copyFixture(SALT);
    const planned = await moveScene(dir, KEY, { chapter: 3, after: LOWTIDE, dryRun: true });
    const before = snapshot(dir);
    const real = await moveScene(dir, KEY, { chapter: 3, after: LOWTIDE });
    assert.equal(real.code, 'OK');
    assert.deepEqual(
      planned.changes.map(({ from, to }) => ({ from, to })),
      real.changes.map(({ from, to }) => ({ from, to })),
    );
    const d = diffSnap(before, snapshot(dir));
    assert.deepEqual(d.added, planned.changes.map((c) => c.to));
    assert.deepEqual(d.removed, planned.changes.map((c) => c.from));
  });
});
