// Acceptance 7 (repair).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { applyRepair, planRepair } from '../src/index.mjs';
import { bodies, cleanup, copyFixture, diagnosticsOf, diffSnap, errorsOf, orderIds, snapshot, trashFiles } from './helpers.mjs';

after(cleanup);

const SPEC = 'valid/spec-example';
const FERRY_FROM = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-ferry.md';
const KEY_FROM = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0015-the-key.md';
// ferry is chapter 2 (W201): no ch-002 folder and no chapter.md for it -> bare `ch-002`.
const FERRY_TO = 'manuscript/act-01-low-water/ch-002/0010-ferry.md';
const KEY_TO = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md';

const byFrom = (a, b) => (a.from < b.from ? -1 : 1);

describe('repair: spec-example (W201 + W202)', () => {
  it('planRepair proposes exactly the two renames and writes nothing', async () => {
    const dir = copyFixture(SPEC);
    const before = snapshot(dir);
    const plan = await planRepair(dir);
    assert.deepEqual(plan.unrepairable, []);
    assert.deepEqual(
      plan.actions.map(({ kind, from, to }) => ({ kind, from, to })).sort(byFrom),
      [
        { kind: 'rename', from: FERRY_FROM, to: FERRY_TO },
        { kind: 'rename', from: KEY_FROM, to: KEY_TO },
      ],
    );
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  it('applyRepair clears W201/W202, keeps order and bodies, and keeps old files in trash', async () => {
    const dir = copyFixture(SPEC);
    const orderBefore = await orderIds(dir);
    const bodiesBefore = bodies(dir);
    const before = snapshot(dir);
    const { actions } = await planRepair(dir);

    const r = await applyRepair(dir, actions);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');

    const diags = await diagnosticsOf(dir);
    assert.deepEqual(diags.filter((d) => d.code === 'W201' || d.code === 'W202'), []);
    assert.deepEqual(await orderIds(dir), orderBefore);
    assert.deepEqual(bodies(dir), bodiesBefore);
    assert.deepEqual(diffSnap(before, snapshot(dir)), {
      added: [KEY_TO, FERRY_TO].sort(),
      removed: [FERRY_FROM, KEY_FROM].sort(),
      changed: [],
    });
    const trash = trashFiles(dir);
    assert.ok(trash.some((f) => f.endsWith(`/${FERRY_FROM}`)));
    assert.ok(trash.some((f) => f.endsWith(`/${KEY_FROM}`)));
  });

  it('applies only the actions it is given', async () => {
    const dir = copyFixture(SPEC);
    const { actions } = await planRepair(dir);
    const onlyKey = actions.filter((a) => a.from === KEY_FROM);
    assert.equal(onlyKey.length, 1);
    const r = await applyRepair(dir, onlyKey);
    assert.equal(r.code, 'OK', JSON.stringify(r));
    const codes = (await diagnosticsOf(dir)).map((d) => d.code);
    assert.ok(!codes.includes('W202'));
    assert.ok(codes.includes('W201'), 'the ferry was not in the action list so is still misfiled');
  });

  it('a second plan after repair is empty', async () => {
    const dir = copyFixture(SPEC);
    await applyRepair(dir, (await planRepair(dir)).actions);
    const plan = await planRepair(dir);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.unrepairable, []);
  });
});

describe('repair: E204 duplicate sequence', () => {
  const E204 = 'invalid/E204-duplicate-sequence';

  it('plans exactly one renumber action for chapter 1', async () => {
    const dir = copyFixture(E204);
    const plan = await planRepair(dir);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].kind, 'renumber');
    assert.equal(plan.actions[0].chapter, 1);
    assert.deepEqual(plan.unrepairable, []);
  });

  it('apply removes E204 and keeps the pre-repair display order and bodies', async () => {
    const dir = copyFixture(E204);
    const orderBefore = await orderIds(dir);
    assert.equal(orderBefore.length, 2);
    const bodiesBefore = bodies(dir);
    const { actions } = await planRepair(dir);
    const r = await applyRepair(dir, actions);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');
    assert.deepEqual((await diagnosticsOf(dir)).filter((d) => d.code === 'E204'), []);
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await orderIds(dir), orderBefore);
    assert.deepEqual(bodies(dir), bodiesBefore);
  });
});

describe('repair: E100 bad front matter', () => {
  it('lists the file as unrepairable and proposes no actions; apply is refused and writes nothing', async () => {
    const dir = copyFixture('invalid/E100-bad-yaml');
    const before = snapshot(dir);
    const plan = await planRepair(dir);
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.unrepairable.length, 1);
    assert.equal(plan.unrepairable[0].code, 'E100');
    assert.equal(plan.unrepairable[0].file, 'manuscript/act-01-one/ch-001-one/0020-b.md');
    // rule 5: E100 is an error on a manuscript file, so even an empty apply is refused
    const r = await applyRepair(dir, plan.actions);
    assert.equal(r.code, 'REFUSED_INVALID_BOOK');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });
});
