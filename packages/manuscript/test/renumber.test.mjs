// Acceptance 5 (renumber).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { renumberChapter } from '../src/index.mjs';
import {
  CH2, CH3, FERRY, GRAFTING, P, SALT, SALT_ORDER,
  addScene, bodies, cleanup, copyFixture, diagnosticsOf, diffSnap, edit, errorsOf, orderIds, orderRows, rename, snapshot, trashFiles,
} from './helpers.mjs';

after(cleanup);

const EXTRA = 'scene_01S50000000000000000000011';

/** chapter 2 prepared as sequences 10, 15, 35 with matching filenames. */
function prepared() {
  const dir = copyFixture(SALT);
  edit(dir, P.GRAFTING, (t) => t.replace(/^sequence: 20$/m, 'sequence: 15'));
  rename(dir, P.GRAFTING, `${CH2}/0015-the-grafting.md`);
  addScene(dir, `${CH2}/0035-extra.md`, { id: EXTRA, act: 1, chapter: 2, sequence: 35, title: 'Extra', body: 'Extra prose.\n' });
  return dir;
}

describe('renumberChapter (acceptance 5)', () => {
  it('10, 15, 35 -> 10, 20, 30 with matching filenames and identical bodies; second run is a no-op', async () => {
    const dir = prepared();
    assert.deepEqual((await orderRows(dir)).filter((s) => s.chapter === 2).map((s) => s.sequence), [10, 15, 35]);
    assert.deepEqual(await diagnosticsOf(dir), []);
    const before = snapshot(dir);
    const bodiesBefore = bodies(dir);
    const orderBefore = await orderIds(dir);

    const r = await renumberChapter(dir, 2);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');
    assert.ok(r.changes.length >= 2);

    const rows = (await orderRows(dir)).filter((s) => s.chapter === 2);
    assert.deepEqual(rows.map((s) => s.id), [FERRY, GRAFTING, EXTRA]);
    assert.deepEqual(rows.map((s) => s.sequence), [10, 20, 30]);
    assert.deepEqual(rows.map((s) => s.path), [`${CH2}/0010-ferry.md`, `${CH2}/0020-the-grafting.md`, `${CH2}/0030-extra.md`]);
    assert.deepEqual(await orderIds(dir), orderBefore, 'global order unchanged');
    assert.deepEqual(bodies(dir), bodiesBefore);
    assert.deepEqual(diffSnap(before, snapshot(dir)), {
      added: [`${CH2}/0020-the-grafting.md`, `${CH2}/0030-extra.md`],
      removed: [`${CH2}/0015-the-grafting.md`, `${CH2}/0035-extra.md`],
      changed: [],
    });
    assert.ok(trashFiles(dir).some((f) => f.endsWith(`${CH2}/0015-the-grafting.md`)));
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await diagnosticsOf(dir), []);

    // second run: nothing to do
    const mid = snapshot(dir);
    const r2 = await renumberChapter(dir, 2);
    assert.equal(r2.ok, true);
    assert.equal(r2.code, 'OK');
    assert.deepEqual(r2.changes, []);
    assert.deepEqual(diffSnap(mid, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  it('is a no-op on an already-renumbered chapter of the untouched fixture', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await renumberChapter(dir, 3);
    assert.equal(r.code, 'OK');
    assert.deepEqual(r.changes, []);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  it('honours a custom step (4-digit zero padding)', async () => {
    const dir = copyFixture(SALT);
    const bodiesBefore = bodies(dir);
    const r = await renumberChapter(dir, 3, { step: 100 });
    assert.equal(r.code, 'OK', JSON.stringify(r));
    assert.deepEqual((await orderRows(dir)).filter((s) => s.chapter === 3).map((s) => [s.sequence, s.path]), [
      [100, `${CH3}/0100-low-tide.md`],
      [200, `${CH3}/0200-the-wall.md`],
    ]);
    assert.deepEqual(await orderIds(dir), SALT_ORDER);
    assert.deepEqual(bodies(dir), bodiesBefore);
  });
});
