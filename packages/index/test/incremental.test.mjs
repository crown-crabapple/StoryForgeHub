import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../../core/src/index.mjs';
import {
  PLANTED, SALT_ARRIVAL, SALT_ARRIVAL_ID, SALT_BOOK, SALT_LOWTIDE, copyFixture, dumpTables, openFor, plain, plantSearchWords,
} from './helpers.mjs';

const abs = (root, rel) => path.join(root, ...rel.split('/'));

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  await plantSearchWords(root);
  const ctx = await openFor(root);
  const r = await ctx.idx.rebuild();
  assert.equal(r.ok, true);
  return { root, ...ctx };
}

/** refresh(), dump; then full rebuild(), dump; they must be identical. Returns the refreshed dump. */
async function refreshEqualsRebuild({ idx, dbPath }) {
  const r = await idx.refresh();
  assert.notEqual(r?.ok, false, JSON.stringify(r));
  assert.equal((await idx.status()).state, 'fresh', 'fresh after refresh');
  const refreshed = dumpTables(dbPath);
  const searchesAfterRefresh = plain(await idx.query.search('orchard'));
  const full = await idx.rebuild();
  assert.equal(full.ok, true);
  const rebuilt = dumpTables(dbPath);
  assert.deepEqual(refreshed, rebuilt);
  assert.deepEqual(searchesAfterRefresh, plain(await idx.query.search('orchard')));
  return refreshed;
}

test('refresh with nothing changed equals a rebuild and changes nothing', async () => {
  const ctx = await setup();
  const before = dumpTables(ctx.dbPath);
  const after = await refreshEqualsRebuild(ctx);
  assert.deepEqual(after, before);
});

test('editing a body: refresh equals rebuild, search and mentions follow the edit', async () => {
  const ctx = await setup();
  const file = abs(ctx.root, SALT_LOWTIDE);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${text}\nMare shouted about the fresh uniquewordalpha. MARE shouted again.\n`, 'utf8');
  assert.equal((await ctx.idx.status()).state, 'stale');

  const dump = await refreshEqualsRebuild(ctx);
  assert.ok((await ctx.idx.query.search('uniquewordalpha')).length === 1);
  const rows = plain(await ctx.idx.query.mentions({ sceneId: 'scene_01S50000000000000000000008' }));
  const maren = rows.find((r) => r.entry_id === 'entry_01S5000000000000000000000G');
  assert.ok(maren && maren.count >= 2, `alias mentions counted case-insensitively: ${JSON.stringify(rows)}`);
  assert.ok(dump.files.some((r) => r.includes('0010-low-tide.md')));
});

test('removing planted text from a body drops it from search after refresh', async () => {
  const ctx = await setup();
  assert.ok((await ctx.idx.query.search('isle')).length > 0);
  const file = abs(ctx.root, SALT_ARRIVAL);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('The Ísle keeper hummed a tune.', 'The keeper hummed a tune.'), 'utf8');
  await refreshEqualsRebuild(ctx);
  assert.deepEqual(plain(await ctx.idx.query.search('isle')), []);
  assert.ok((await ctx.idx.query.search(PLANTED.japanese)).some((r) => r.id === SALT_ARRIVAL_ID), 'untouched text still indexed');
});

test('adding a scene through createScene: refresh equals rebuild', async () => {
  const ctx = await setup();
  const repo = createFsRepository(ctx.root);
  const before = plain(await ctx.idx.query.scenes());
  const r = await repo.createScene(SALT_BOOK, { act: 1, chapter: 1, after: null, slug: 'brand-new-scene', title: 'Brand New Scene', body: 'A scene about uniquewordbeta.\n' });
  assert.equal(r.ok, true, JSON.stringify(r));
  await refreshEqualsRebuild(ctx);
  const after = plain(await ctx.idx.query.scenes());
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((s) => s.id === r.id && s.title === 'Brand New Scene'));
  assert.ok((await ctx.idx.query.search('uniquewordbeta')).some((x) => x.id === r.id));
});

test('adding and deleting plain files externally: refresh equals rebuild', async () => {
  const ctx = await setup();
  await fs.writeFile(abs(ctx.root, 'research/new-note.md'), '# A fresh note\n\nuniquewordgamma lives here.\n', 'utf8');
  const st = plain(await ctx.idx.status());
  assert.equal(st.state, 'stale');
  assert.ok(st.stale_paths.includes('research/new-note.md'));
  await refreshEqualsRebuild(ctx);

  await fs.rm(abs(ctx.root, 'research/new-note.md'));
  assert.equal((await ctx.idx.status()).state, 'stale');
  await refreshEqualsRebuild(ctx);
  assert.deepEqual(plain(await ctx.idx.query.search('uniquewordgamma')), []);
});

test('archiving a scene: refresh equals rebuild and the scene leaves the order', async () => {
  const ctx = await setup();
  const repo = createFsRepository(ctx.root);
  const scene = await repo.getScene(SALT_BOOK, SALT_ARRIVAL_ID);
  const r = await repo.archiveScene(SALT_BOOK, SALT_ARRIVAL_ID, { baseSha256: scene.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));
  await refreshEqualsRebuild(ctx);
  const scenes = plain(await ctx.idx.query.scenes());
  assert.ok(!scenes.some((s) => s.id === SALT_ARRIVAL_ID));
  const excluded = plain(await ctx.idx.query.excluded());
  assert.ok(excluded.some((e) => e.id === SALT_ARRIVAL_ID && e.reason === 'archived'));
});

test('renaming an entry slug with previous_slugs: refresh equals rebuild and old links resolve via previous_slug', async () => {
  const ctx = await setup();
  const rel = 'codex/characters/pell.md';
  const file = abs(ctx.root, rel);
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /^slug: pell$/m);
  await fs.writeFile(file, text.replace(/^slug: pell$/m, 'slug: pell-the-caretaker\nprevious_slugs: [pell]'), 'utf8');

  await refreshEqualsRebuild(ctx);
  const links = plain(await ctx.idx.query.links({ resolution: 'previous_slug' }));
  assert.ok(links.length > 0, 'the [[pell]] links now resolve through previous_slugs');
  const diags = plain(await ctx.idx.query.diagnostics());
  assert.ok(diags.some((d) => d.code === 'W301'));
  assert.equal(links.length, diags.filter((d) => d.code === 'W301').length);
});

test('a refresh after several mixed edits equals a rebuild', async () => {
  const ctx = await setup();
  const f1 = abs(ctx.root, SALT_LOWTIDE);
  await fs.appendFile(f1, '\nextra line uniquewordzeta\n');
  await fs.writeFile(abs(ctx.root, 'research/second-note.md'), 'second note body\n');
  await fs.rm(abs(ctx.root, 'research/tidal-ranges.md'));
  await refreshEqualsRebuild(ctx);
});
