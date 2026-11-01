// Acceptance 1 (rebuild proof) and 11 (index is not authoritative).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { rebuildIndex, readIndex, insertScene } from '../src/index.mjs';
import {
  ARRIVAL, KEY, SALT, SALT_ORDER, VARIANT, cleanup, copyFixture, diffSnap, orderIds, orderRows, sha256, snapshot, write,
} from './helpers.mjs';

after(cleanup);

const project = (scenes) =>
  scenes.map(({ id, position, act, chapter, sequence, path: p, sha256: h }) => ({ id, position, act, chapter, sequence, path: p, sha256: h }));

describe('rebuildIndex', () => {
  it('index survives deletion of all of .storyforge/ and rebuilds identically (acceptance 1)', async () => {
    const dir = copyFixture(SALT);
    const r1 = await rebuildIndex(dir);
    assert.equal(r1.ok, true);
    assert.equal(r1.code, 'OK');
    const idx1 = await readIndex(dir);
    assert.equal(idx1.schema, 'storyforge.index/v1');
    assert.equal(typeof idx1.built_at, 'string');
    assert.deepEqual(idx1.scenes.map((s) => [s.id, s.position]), SALT_ORDER.map((id, i) => [id, i + 1]));
    const list1 = project(idx1.scenes);

    fs.rmSync(path.join(dir, '.storyforge'), { recursive: true, force: true });
    assert.equal(await readIndex(dir), null, 'readIndex returns null when the index is missing');

    const r2 = await rebuildIndex(dir);
    assert.equal(r2.ok, true);
    const list2 = project((await readIndex(dir)).scenes);
    assert.deepEqual(list2, list1);

    // equals validate() order
    const rows = await orderRows(dir);
    assert.deepEqual(
      list2.map(({ sha256: _h, ...rest }) => rest),
      rows.map(({ id, position, act, chapter, sequence, path: p }) => ({ id, position, act, chapter, sequence, path: p })),
    );
    // each sha256 is the hash of the scene file's bytes
    for (const s of list2) assert.equal(s.sha256, sha256(fs.readFileSync(path.join(dir, ...s.path.split('/')))));
  });

  it('writes only .storyforge/index.json', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    await rebuildIndex(dir);
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: ['.storyforge/index.json'], removed: [], changed: [] });
  });

  it('readIndex returns null for a corrupt index', async () => {
    const dir = copyFixture(SALT);
    write(dir, '.storyforge/index.json', '{ not json');
    assert.equal(await readIndex(dir), null);
  });

  it('excludes variants and archived scenes', async () => {
    const dir = copyFixture(SALT);
    await rebuildIndex(dir);
    const ids = (await readIndex(dir)).scenes.map((s) => s.id);
    assert.equal(ids.length, 7);
    assert.ok(!ids.includes(VARIANT));
    assert.ok(!ids.includes('scene_01S50000000000000000000007'));
  });
});

describe('index is not authoritative (acceptance 11)', () => {
  it('a deliberately wrong (reversed) index.json does not change validate order or operations', async () => {
    const dir = copyFixture(SALT);
    const reversed = SALT_ORDER.slice().reverse().map((id, i) => ({
      position: i + 1, id, act: 9, chapter: 9, sequence: 9, path: 'nowhere.md', sha256: '0'.repeat(64),
    }));
    write(dir, '.storyforge/index.json', JSON.stringify({ schema: 'storyforge.index/v1', built_at: 'x', scenes: reversed }));
    assert.deepEqual(await orderIds(dir), SALT_ORDER);

    // an operation must not consult the index: new scene lands right after ARRIVAL
    const r = await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'N', slug: 'n', body: 'B\n' });
    assert.equal(r.code, 'OK');
    const ids = await orderIds(dir);
    assert.deepEqual(ids.filter((i) => SALT_ORDER.includes(i)), SALT_ORDER);
    assert.equal(ids.indexOf(ARRIVAL) + 2, ids.indexOf(KEY));

    // rebuild replaces the bad index with the truth
    await rebuildIndex(dir);
    assert.deepEqual((await readIndex(dir)).scenes.map((s) => s.id), ids);
  });
});
