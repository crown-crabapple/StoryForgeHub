// moveChapter: a whole chapter into another act (or elsewhere in its own act). salt-orchard has act 1 = chapters 0, 1, 2 and
// act 2 = chapter 3. Book order follows chapter numbers and an act may not come after a later act (E206), so the chapter
// keeps its number when that fits its new place; otherwise a book numbered without gaps is renumbered in the new order (so it stays
// without gaps), and a book that already has gaps gives the chapter a free number when there is one.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as M from '../src/index.mjs';
import {
  ARRIVAL, CH1, CH2, CH3, FERRY, GRAFTING, KEY, LOWTIDE, PROLOGUE, SALT, VARIANT, WALL,
  allBodyHashes, cleanup, copyFixture, diagnosticsOf, diffSnap, errorsOf, exists, orderIds, orderRows, read, snapshot,
} from './helpers.mjs';

after(cleanup);

const NOTHING = { added: [], removed: [], changed: [] };
const A2 = 'manuscript/act-02-high-water';
const rowOf = async (dir, id) => (await orderRows(dir)).find((r) => r.id === id);

async function assertClean(dir) {
  assert.deepEqual(await errorsOf(dir), []);
  const w201 = (await diagnosticsOf(dir)).filter((d) => d.code === 'W201' || d.code === 'W202');
  assert.deepEqual(w201, [], 'folders agree with the act and chapter numbers');
}

describe('moveChapter', () => {
  it('to the start of a later act: same number, new act, folder moves; order unchanged', async () => {
    const dir = copyFixture(SALT);
    const order = await orderIds(dir);
    const bodies = allBodyHashes(dir);
    const r = await M.moveChapter(dir, 2, { act: 2, after: null });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mapping, {});
    assert.equal(r.chapter, 2);
    assert.ok(exists(dir, `${A2}/ch-002-the-grafting/chapter.md`));
    assert.ok(!exists(dir, CH2), 'the emptied folder is removed');
    for (const id of [FERRY, GRAFTING]) {
      const row = await rowOf(dir, id);
      assert.equal(row.act, 2);
      assert.equal(row.chapter, 2);
    }
    assert.deepEqual(await orderIds(dir), order);
    assert.deepEqual(allBodyHashes(dir), bodies);
    await assertClean(dir);
  });

  it('to the end of a later act: the book stays numbered without gaps, files and chapter.md follow', async () => {
    const dir = copyFixture(SALT);
    const r = await M.moveChapter(dir, 2, { act: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mapping, { 2: 3, 3: 2 });
    assert.ok(exists(dir, `${A2}/ch-003-the-grafting/0010-ferry.md`));
    assert.match(read(dir, `${A2}/ch-003-the-grafting/chapter.md`), /^chapter: 3$/m);
    assert.ok(exists(dir, `${A2}/ch-002-the-wall/0010-low-tide.md`));
    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, KEY, LOWTIDE, WALL, FERRY, GRAFTING]);
    assert.equal((await rowOf(dir, FERRY)).act, 2);
    await assertClean(dir);
  });

  it('a chapter with a variant: the variant moves with it and its act and chapter lines follow', async () => {
    const dir = copyFixture(SALT);
    const r = await M.moveChapter(dir, 1, { act: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mapping, { 1: 3, 2: 1, 3: 2 });
    const alt = read(dir, `${A2}/ch-003-the-drowned-rows/0020-the-key-alt.md`);
    assert.match(alt, /^act: 2$/m);
    assert.match(alt, /^chapter: 3$/m);
    assert.ok(!exists(dir, `${CH1}/0020-the-key-alt.md`));
    assert.ok(alt.includes(`variant_of: ${KEY}`));
    assert.ok(VARIANT);
    await assertClean(dir);
  });

  it('into an earlier act with no free number: every chapter is renumbered in the new order', async () => {
    const dir = copyFixture(SALT);
    const r = await M.moveChapter(dir, 3, { act: 1, after: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mapping, { 3: 1, 1: 2, 2: 3 });
    assert.deepEqual(await orderIds(dir), [PROLOGUE, LOWTIDE, WALL, ARRIVAL, KEY, FERRY, GRAFTING]);
    assert.ok(exists(dir, 'manuscript/act-01-low-water/ch-001-the-wall/0010-low-tide.md'));
    assert.ok(exists(dir, 'manuscript/act-01-low-water/ch-002-the-drowned-rows/0010-arrival.md'));
    assert.ok(exists(dir, 'manuscript/act-01-low-water/ch-003-the-grafting/0010-ferry.md'));
    assert.ok(exists(dir, `${A2}/act.md`), 'the emptied act keeps its act.md');
    await assertClean(dir);
  });

  it('one by one into a later act (as when splitting a book into acts): numbers stay 0..N with no gaps', async () => {
    const dir = copyFixture(SALT);
    // chapter 1 then chapter 2 to the end of act 2: the old rule gave 4 and 5 and left 1 and 2 empty
    assert.equal((await M.moveChapter(dir, 1, { act: 2 })).ok, true);
    const r = await M.moveChapter(dir, 1, { act: 2 }); // the old chapter 2 is now chapter 1
    assert.equal(r.ok, true, JSON.stringify(r));
    const nums = [...new Set((await orderRows(dir)).map((row) => row.chapter))];
    assert.deepEqual(nums, [0, 1, 2, 3]);
    assert.deepEqual(await orderIds(dir), [PROLOGUE, LOWTIDE, WALL, ARRIVAL, KEY, FERRY, GRAFTING]);
    await assertClean(dir);
  });

  it('a book that already has gaps keeps them: the chapter takes a free number and nothing else is renumbered', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await M.renumberChapters(dir, { step: 10 })).ok, true); // 0, 10, 20, 30
    const r = await M.moveChapter(dir, 20, { act: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.mapping, { 20: 31 });
    await assertClean(dir);
  });

  it('back into its own place is a no-op (nothing written)', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await M.moveChapter(dir, 2, { act: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.changes, []);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING);
  });

  it('a dry run lists the changes and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await M.moveChapter(dir, 2, { act: 2, dryRun: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.dryRun, true);
    assert.ok(r.changes.some((c) => c.to === `${A2}/ch-003-the-grafting/0010-ferry.md`));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING);
  });

  const refusals = [
    ['an unknown chapter', 42, { act: 2 }, 'REFUSED_UNKNOWN_CHAPTER'],
    ['an unknown act', 2, { act: 9 }, 'REFUSED_UNKNOWN_ACT'],
    ['an anchor chapter in another act', 2, { act: 2, after: 1 }, 'REFUSED_BAD_ANCHOR'],
    ['after itself', 2, { act: 1, after: 2 }, 'REFUSED_BAD_ANCHOR'],
    ['a bad act', 2, { act: -1 }, 'REFUSED_BAD_ARGS'],
  ];
  for (const [name, chapter, args, code] of refusals) {
    it(`refuses ${name}; nothing is written`, async () => {
      const dir = copyFixture(SALT);
      const before = snapshot(dir);
      const r = await M.moveChapter(dir, chapter, args);
      assert.equal(r.ok, false);
      assert.equal(r.code, code, JSON.stringify(r));
      assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING);
    });
  }

  it('restoreOp puts every file back byte-for-byte', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await M.moveChapter(dir, 3, { act: 1, after: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const u = await M.restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NOTHING);
    assert.ok(exists(dir, `${CH3}/0010-low-tide.md`));
  });
});
