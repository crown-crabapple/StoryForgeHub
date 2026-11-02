import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validate } from '../../format/src/index.mjs';
import { openStore } from '../src/index.mjs';
import { copyFixture, readOrNull, sha256, snapshot } from './helpers.mjs';

const SCENE_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const SCENE_ID = 'scene_01S50000000000000000000002';
const ARCHIVED_REL = `archive/${SCENE_REL}`;

const orderIds = async (root) => (await validate(root)).books[0].order.map((s) => s.id);
const excluded = async (root) => (await validate(root)).books[0].excluded;

test('archive moves the scene under archive/ byte-identical and never deletes', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const original = await readOrNull(path.join(root, SCENE_REL));
  const orderBefore = await orderIds(root);
  assert.ok(orderBefore.includes(SCENE_ID));
  const before = await snapshot(root);

  const cur = await store.read(SCENE_REL);
  assert.equal(cur.sha256, sha256(original));
  const r = await store.archive(SCENE_REL, { baseSha256: cur.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));

  // Byte-identical under archive/, gone from the live path.
  const archived = await readOrNull(path.join(root, ARCHIVED_REL));
  assert.ok(archived, 'archived file exists');
  assert.equal(Buffer.compare(archived, original), 0);
  assert.equal(await readOrNull(path.join(root, SCENE_REL)), null);

  // Nothing else went missing or changed outside .storyforge and the two paths.
  const after = await snapshot(root);
  for (const [rel, sha] of Object.entries(before)) {
    if (rel.startsWith('.storyforge/') || rel === SCENE_REL) continue;
    assert.equal(after[rel], sha, `${rel} must be unchanged`);
  }

  // validate: excluded from the order, reported as archived.
  const orderDuring = await orderIds(root);
  assert.ok(!orderDuring.includes(SCENE_ID));
  assert.deepEqual(orderDuring, orderBefore.filter((id) => id !== SCENE_ID));
  const ex = (await excluded(root)).find((e) => e.id === SCENE_ID);
  assert.equal(ex?.reason, 'archived');
  assert.equal(ex?.path, ARCHIVED_REL);

  // The old file is also kept in the trash (never deleted).
  assert.ok(
    Object.entries(after).some(([rel, sha]) => rel.startsWith('.storyforge/trash/') && rel.endsWith(SCENE_REL) && sha === sha256(original)),
    'trash holds the original bytes',
  );
});

test('restore brings the scene back byte-identical and order is restored', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const original = await readOrNull(path.join(root, SCENE_REL));
  const orderBefore = await orderIds(root);

  const a = await store.archive(SCENE_REL, { baseSha256: sha256(original) });
  assert.equal(a.ok, true, JSON.stringify(a));
  const arch = await store.read(ARCHIVED_REL);
  assert.equal(arch.sha256, sha256(original));

  const r = await store.restore(ARCHIVED_REL, { baseSha256: arch.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));

  const back = await readOrNull(path.join(root, SCENE_REL));
  assert.ok(back);
  assert.equal(Buffer.compare(back, original), 0);
  assert.equal(await readOrNull(path.join(root, ARCHIVED_REL)), null);
  assert.deepEqual(await orderIds(root), orderBefore);
});

test('restore refuses with EXISTS when the live path is taken, and loses nothing', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const original = await readOrNull(path.join(root, SCENE_REL));
  const a = await store.archive(SCENE_REL, { baseSha256: sha256(original) });
  assert.equal(a.ok, true, JSON.stringify(a));

  const blocker = Buffer.from('someone else lives here now\n');
  const c = await store.create(SCENE_REL, blocker);
  assert.equal(c.ok, true, JSON.stringify(c));

  const r = await store.restore(ARCHIVED_REL, { baseSha256: sha256(original) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXISTS');
  assert.equal(Buffer.compare(await readOrNull(path.join(root, SCENE_REL)), blocker), 0);
  assert.equal(Buffer.compare(await readOrNull(path.join(root, ARCHIVED_REL)), original), 0);
});

test('archive of a missing file fails NOT_FOUND', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const before = await snapshot(root);
  const r = await store.archive('manuscript/nope.md', { baseSha256: sha256(Buffer.from('x')) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
  const after = await snapshot(root);
  for (const [rel, sha] of Object.entries(before)) {
    if (!rel.startsWith('.storyforge/')) assert.equal(after[rel], sha);
  }
});
