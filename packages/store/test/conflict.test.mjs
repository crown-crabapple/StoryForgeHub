import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../src/index.mjs';
import { copyFixture, readOrNull, sha256, snapshot } from './helpers.mjs';

const REL = 'research/tidal-ranges.md';

/** Snapshot of project files only (the .storyforge bookkeeping may legitimately change). */
async function projectSnap(root) {
  const s = await snapshot(root);
  for (const k of Object.keys(s)) if (k.startsWith('.storyforge/')) delete s[k];
  return s;
}

/** Open a store, then change REL behind its back. Returns sha of the version the author "saw" and of the new one. */
async function staleSetup() {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const seen = await store.read(REL);
  const external = Buffer.from('edited in another editor\n');
  await fs.writeFile(path.join(root, REL), external);
  return { root, store, shaA: seen.sha256, shaB: sha256(external), external };
}

function assertConflict(r, ctx) {
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.equal(r.current.sha256, ctx.shaB);
  assert.equal(Buffer.compare(Buffer.from(r.current.bytes), ctx.external), 0);
}

test('write with a stale baseSha256 returns CONFLICT with current and writes nothing', async () => {
  const ctx = await staleSetup();
  const before = await projectSnap(ctx.root);
  const r = await ctx.store.write(REL, Buffer.from('mine\n'), { baseSha256: ctx.shaA });
  assertConflict(r, ctx);
  assert.deepEqual(await projectSnap(ctx.root), before);
});

test('move with a stale baseSha256 returns CONFLICT and moves nothing', async () => {
  const ctx = await staleSetup();
  const before = await projectSnap(ctx.root);
  const r = await ctx.store.move(REL, 'research/elsewhere.md', { baseSha256: ctx.shaA });
  assertConflict(r, ctx);
  assert.deepEqual(await projectSnap(ctx.root), before);
});

test('archive with a stale baseSha256 returns CONFLICT and archives nothing', async () => {
  const ctx = await staleSetup();
  const before = await projectSnap(ctx.root);
  const r = await ctx.store.archive(REL, { baseSha256: ctx.shaA });
  assertConflict(r, ctx);
  assert.deepEqual(await projectSnap(ctx.root), before);
  assert.equal(await readOrNull(path.join(ctx.root, 'archive', REL)), null);
});

test('baseSha256 null on an existing file is a CONFLICT', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const cur = await store.read(REL);
  const before = await projectSnap(root);
  const r = await store.write(REL, Buffer.from('mine\n'), { baseSha256: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.equal(r.current.sha256, cur.sha256);
  assert.deepEqual(await projectSnap(root), before);
});

test('baseSha256 null on a missing file creates it', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const r = await store.write('research/fresh.md', Buffer.from('fresh\n'), { baseSha256: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await readOrNull(path.join(root, 'research/fresh.md'))).toString(), 'fresh\n');
});

test('write with the correct baseSha256 succeeds and the file holds exactly the new bytes', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const cur = await store.read(REL);
  const next = Buffer.from('v2 é\r\nline\n');
  const r = await store.write(REL, next, { baseSha256: cur.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(Buffer.compare(await readOrNull(path.join(root, REL)), next), 0);
  assert.equal((await store.read(REL)).sha256, sha256(next));
});

test('create on an existing path fails EXISTS and leaves it untouched', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const before = await projectSnap(root);
  const r = await store.create(REL, Buffer.from('x'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXISTS');
  assert.deepEqual(await projectSnap(root), before);
});

test('move onto an existing path fails EXISTS', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const cur = await store.read(REL);
  const before = await projectSnap(root);
  const r = await store.move(REL, 'research/sources/admiralty-tables.md', { baseSha256: cur.sha256 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXISTS');
  assert.deepEqual(await projectSnap(root), before);
});

test('move of a missing file fails NOT_FOUND; read of a missing file is null', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  assert.equal(await store.read('research/missing.md'), null);
  const r = await store.move('research/missing.md', 'research/other.md', { baseSha256: sha256(Buffer.from('x')) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

const BAD_PATHS = ['../x', 'research/../../x', '.storyforge/x', '.storyforge/journal/evil.json'];

for (const bad of BAD_PATHS) {
  test(`OUTSIDE_ROOT for ${bad} on create, write, move (both ends) and archive`, async () => {
    const root = await copyFixture('valid/salt-orchard');
    const store = await openStore(root);
    const cur = await store.read(REL);
    const before = await projectSnap(root);
    const bytes = Buffer.from('x');

    const results = [
      await store.create(bad, bytes),
      await store.write(bad, bytes, { baseSha256: null }),
      await store.move(REL, bad, { baseSha256: cur.sha256 }),
      await store.move(bad, 'research/y.md', { baseSha256: cur.sha256 }),
      await store.archive(bad, { baseSha256: cur.sha256 }),
    ];
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'OUTSIDE_ROOT');
    }
    assert.deepEqual(await projectSnap(root), before);
    // Nothing was written next to the book root either.
    assert.equal(await readOrNull(path.join(path.dirname(root), 'x')), null);
  });
}
