// Acceptance 9: a post-write validation failure rolls the book back byte-for-byte.
// Uses __testHooks.afterWrite (assigned a function) to corrupt a file the operation just wrote.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, after, describe, it } from 'node:test';
import { __testHooks, insertScene, moveScene, renumberChapter } from '../src/index.mjs';
import { ARRIVAL, KEY, LOWTIDE, SALT, bodies, cleanup, copyFixture, diffSnap, errorsOf, orderIds, snapshot, trashFiles } from './helpers.mjs';

after(cleanup);
afterEach(() => {
  __testHooks.afterWrite = null;
});

const BAD = '---\nschema: storyforge.scene/v1\nid: scene_broken\n'; // unterminated front matter -> E100

function corrupt(dir, rel) {
  __testHooks.afterWrite = async () => {
    fs.writeFileSync(path.join(dir, ...rel.split('/')), BAD);
  };
}

describe('rollback (acceptance 9)', () => {
  it('moveScene: corrupted result -> ROLLED_BACK and the book is byte-identical (trash aside)', async () => {
    const dir = copyFixture(SALT);
    const args = { chapter: 3, after: LOWTIDE };
    const planned = await moveScene(dir, KEY, { ...args, dryRun: true });
    assert.equal(planned.code, 'OK', JSON.stringify(planned));
    const target = planned.changes[0].to;
    assert.ok(target);

    const before = snapshot(dir);
    const orderBefore = await orderIds(dir);
    const bodiesBefore = bodies(dir);
    corrupt(dir, target);
    const r = await moveScene(dir, KEY, args);
    __testHooks.afterWrite = null;

    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLLED_BACK', JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [] });
    assert.deepEqual(await orderIds(dir), orderBefore);
    assert.deepEqual(bodies(dir), bodiesBefore);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('insertScene: corrupted new file -> ROLLED_BACK, created file removed, book identical', async () => {
    const dir = copyFixture(SALT);
    const args = { chapter: 1, after: ARRIVAL, title: 'N', slug: 'n', body: 'b\n' };
    const planned = await insertScene(dir, { ...args, dryRun: true });
    const target = planned.changes[0].to;
    assert.ok(target);

    const before = snapshot(dir);
    corrupt(dir, target);
    const r = await insertScene(dir, args);
    __testHooks.afterWrite = null;

    assert.equal(r.code, 'ROLLED_BACK', JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [] });
  });

  it('renumberChapter: corrupted result -> ROLLED_BACK and nothing left behind', async () => {
    const dir = copyFixture(SALT);
    const planned = await renumberChapter(dir, 3, { step: 100, dryRun: true });
    assert.ok(planned.changes.length > 0);
    const target = planned.changes[0].to;

    const before = snapshot(dir);
    corrupt(dir, target);
    const r = await renumberChapter(dir, 3, { step: 100 });
    __testHooks.afterWrite = null;

    assert.equal(r.code, 'ROLLED_BACK', JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [] });
  });

  it('a rolled-back op leaves its prior versions in trash (nothing is ever deleted)', async () => {
    const dir = copyFixture(SALT);
    const args = { chapter: 3, after: LOWTIDE };
    const target = (await moveScene(dir, KEY, { ...args, dryRun: true })).changes[0].to;
    const trashBefore = trashFiles(dir);
    corrupt(dir, target);
    await moveScene(dir, KEY, args);
    __testHooks.afterWrite = null;
    for (const f of trashBefore) assert.ok(trashFiles(dir).includes(f));
  });
});
