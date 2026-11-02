// M01-J04 acceptance 1, 2, 3, 4, 5, 8, 9: the watcher and index.reconcile() seen through the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ARRIVAL, ARRIVAL_REL, BOOK, GRAFTING, GRAFTING_REL,
  abs, breakScene, countReconciles, flatScenes, idsOf, plain, rowsOf, setup, sha256, stateOf, waitFor,
} from './watch-helpers.mjs';

const STRAY_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0030-stray.md';

test('1. external valid edit: new text served, new word searchable, state fresh', async (t) => {
  const { root, repo } = await setup(t);
  const file = abs(root, ARRIVAL_REL);
  const before = await fs.readFile(file, 'utf8');
  assert.equal(rowsOf(await repo.search('zephyrquill', { bookId: BOOK })).length, 0, 'word absent before the edit');

  await fs.writeFile(file, `${before.trimEnd()}\n\nA zephyrquill drifted across the jetty.\n`);

  await waitFor(async () => rowsOf(plain(await repo.search('zephyrquill', { bookId: BOOK }))).some((r) => r.id === ARRIVAL), {
    what: 'search to find the externally added word',
  });
  const scene = await repo.getScene(BOOK, ARRIVAL);
  assert.ok(scene.body.includes('A zephyrquill drifted across the jetty.'));
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh' });
});

test('1b. an external edit to a non-manuscript file (codex entry) is searchable too', async (t) => {
  const { root, repo } = await setup(t);
  const rel = 'codex/lore/saltmarks.md';
  const text = await fs.readFile(abs(root, rel), 'utf8');
  await fs.writeFile(abs(root, rel), `${text.trimEnd()}\n\nThe marks gleam with quasarwort.\n`);
  await waitFor(async () => rowsOf(plain(await repo.search('quasarwort', { bookId: BOOK }))).length > 0, { what: 'entry edit indexed' });
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh' });
});

test('2. external rename keeps id and position, updates the path', async (t) => {
  const { root, repo } = await setup(t);
  const before = flatScenes(await repo.getBook(BOOK));
  const idx = before.findIndex((s) => s.id === ARRIVAL);
  const to = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival-at-the-rows.md';

  await fs.rename(abs(root, ARRIVAL_REL), abs(root, to));

  await waitFor(
    async () => (await stateOf(repo)) === 'fresh' && flatScenes(await repo.getBook(BOOK)).find((s) => s.id === ARRIVAL)?.path === to,
    { what: 'index to show the new path' },
  );
  const after = flatScenes(await repo.getBook(BOOK));
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((s) => s.id), before.map((s) => s.id), 'same order');
  assert.equal(after[idx].id, ARRIVAL);
  assert.equal(after[idx].position, before[idx].position);
  assert.equal((await repo.getScene(BOOK, ARRIVAL)).path, to);
  const diags = await repo.getDiagnostics(BOOK);
  assert.deepEqual(diags.filter((d) => d.code === 'W202'), [], 'prefix still matches, so no W202');
});

test('2b. external rename that breaks the sequence prefix shows W202 and is not auto-fixed', async (t) => {
  const { root, repo } = await setup(t);
  const to = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0015-arrival.md';
  await fs.rename(abs(root, ARRIVAL_REL), abs(root, to));

  await waitFor(async () => (await repo.getDiagnostics(BOOK)).some((d) => d.code === 'W202' && d.file === to), { what: 'W202 for the renamed file' });
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'a warning does not make the book invalid' });
  await assert.rejects(fs.access(abs(root, ARRIVAL_REL)), 'old path not recreated');
  await fs.access(abs(root, to));
  const s = flatScenes(await repo.getBook(BOOK)).find((x) => x.id === ARRIVAL);
  assert.equal(s.path, to);
});

test('3. external invalidation: invalid state, last good structure kept, raw file untouched', async (t) => {
  const { root, repo } = await setup(t);
  const orderBefore = idsOf(await repo.getBook(BOOK));
  assert.equal(orderBefore.length, 7);
  const sceneBefore = await repo.getScene(BOOK, GRAFTING);
  const broken = await breakScene(root, GRAFTING_REL);

  const st = await waitFor(async () => {
    const s = await repo.indexStatus(BOOK);
    return s.state === 'invalid' && s;
  }, { what: 'state invalid' });
  assert.ok(st.invalid_paths.includes(GRAFTING_REL), `invalid_paths lists the file: ${JSON.stringify(st.invalid_paths)}`);

  const diags = await repo.getDiagnostics(BOOK);
  assert.ok(diags.some((d) => d.code === 'E100' && d.file === GRAFTING_REL), 'E100 for the broken file');

  const book = await repo.getBook(BOOK);
  assert.equal(book.index_state, 'invalid');
  assert.ok(book.invalid_paths.includes(GRAFTING_REL));
  assert.deepEqual(idsOf(book), orderBefore, 'all 7 scenes, old order');
  const scenes = flatScenes(book);
  const bad = scenes.find((s) => s.id === GRAFTING);
  assert.equal(typeof bad.problem?.code, 'string');
  assert.equal(typeof bad.problem?.message, 'string');
  assert.deepEqual(scenes.filter((s) => s.id !== GRAFTING && s.problem), [], 'no other scene has a problem');

  const raw = await repo.getScene(BOOK, GRAFTING);
  assert.ok(raw, 'getScene never returns null for a file that exists');
  assert.equal(raw.sha256, sha256(broken), 'sha256 is of the current (broken) bytes');
  assert.ok(raw.problem, 'problem reported for unparseable scene');
  assert.ok(broken.toString('utf8').endsWith(raw.body), 'body is raw bytes taken from the file');
  assert.ok(raw.body.includes(sceneBefore.body.trim().split('\n')[0]), 'raw prose present');

  assert.deepEqual(await fs.readFile(abs(root, GRAFTING_REL)), broken, 'file is byte-identical to what the editor wrote');
  const hits = rowsOf(plain(await repo.search('jetty', { bookId: BOOK })));
  assert.ok(hits.some((r) => r.id === ARRIVAL), 'search still answers from the last good projection');
});

test('4. new broken file under manuscript/ is listed as unplaced and the book is invalid', async (t) => {
  const { root, repo } = await setup(t);
  await fs.writeFile(abs(root, STRAY_REL), '---\nschema: storyforge.scene/v1\nid: scene_01S5000000000000000000000Z\ntitle: [unclosed\n---\nstray words\n');

  await waitFor(async () => (await stateOf(repo)) === 'invalid', { what: 'state invalid' });
  const book = await repo.getBook(BOOK);
  const hit = book.unplaced?.find((u) => u.path === STRAY_REL);
  assert.ok(hit, `unplaced lists the new file: ${JSON.stringify(book.unplaced)}`);
  assert.ok(hit.problem, 'with a problem');
  assert.equal(idsOf(book).length, 7, 'placed scenes unchanged');
  assert.ok((await repo.indexStatus(BOOK)).invalid_paths.includes(STRAY_REL));
});

test('5. fixing the YAML externally returns to fresh with the original order', async (t) => {
  const { root, repo } = await setup(t);
  const orderBefore = idsOf(await repo.getBook(BOOK));
  const original = await fs.readFile(abs(root, GRAFTING_REL));
  await breakScene(root, GRAFTING_REL);
  await waitFor(async () => (await stateOf(repo)) === 'invalid', { what: 'state invalid' });

  await fs.writeFile(abs(root, GRAFTING_REL), original);

  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh again' });
  const st = await repo.indexStatus(BOOK);
  assert.deepEqual(st.invalid_paths ?? [], []);
  const book = await repo.getBook(BOOK);
  assert.deepEqual(idsOf(book), orderBefore);
  assert.notEqual(book.index_state, 'invalid');
  assert.deepEqual(flatScenes(book).filter((s) => s.problem), []);
  assert.deepEqual(book.unplaced ?? [], []);
});

test('5b. removing a broken new file clears invalid', async (t) => {
  const { root, repo } = await setup(t);
  await fs.writeFile(abs(root, STRAY_REL), '---\nid: [nope\n---\nx\n');
  await waitFor(async () => (await stateOf(repo)) === 'invalid', { what: 'state invalid' });
  await fs.rm(abs(root, STRAY_REL));
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh after removal' });
  assert.deepEqual((await repo.getBook(BOOK)).unplaced ?? [], []);
});

test('app writes while invalid: updateSceneBody on a valid scene is still allowed', async (t) => {
  const { root, repo } = await setup(t);
  await breakScene(root, GRAFTING_REL);
  await waitFor(async () => (await stateOf(repo)) === 'invalid', { what: 'state invalid' });
  const cur = await repo.getScene(BOOK, ARRIVAL);
  const r = await repo.updateSceneBody(BOOK, ARRIVAL, 'Written while invalid.\n', { baseSha256: cur.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((await fs.readFile(abs(root, ARRIVAL_REL), 'utf8')).endsWith('Written while invalid.\n'));
});

test('8. an app write triggers exactly one reconcile (own writes are not re-processed)', async (t) => {
  const counter = countReconciles(t);
  const { repo } = await setup(t);
  // let any startup events drain, then count only what the write causes
  await new Promise((r) => setTimeout(r, 400));
  counter.reset();
  const cur = await repo.getScene(BOOK, ARRIVAL);
  const r = await repo.updateSceneBody(BOOK, ARRIVAL, 'Own write marker nebulaflint.\n', { baseSha256: cur.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));

  await waitFor(async () => counter.count() >= 1 && rowsOf(plain(await repo.search('nebulaflint', { bookId: BOOK }))).length > 0, {
    what: 'the write to be indexed',
  });
  // negative assertion: allow the debounce window (50 ms) plus slack for a double-process to show up
  await new Promise((r2) => setTimeout(r2, 800));
  assert.equal(counter.count(), 1, `exactly one reconcile for one app write: ${JSON.stringify(counter.calls())}`);
});

test('8b. an external write is counted by the hook (the counter is live)', async (t) => {
  const counter = countReconciles(t);
  const { root, repo } = await setup(t);
  assert.ok(repo);
  await new Promise((r) => setTimeout(r, 400));
  counter.reset();
  const text = await fs.readFile(abs(root, ARRIVAL_REL), 'utf8');
  await fs.writeFile(abs(root, ARRIVAL_REL), `${text}\nexternal ionbramble\n`);
  await waitFor(() => counter.count() >= 1, { what: 'a reconcile after an external edit' });
});

test('9. series.md edits reach listBooks of the affected books only', async (t) => {
  const { root, repo } = await setup(t, { fixture: 'valid/library', wait: false });
  const before = plain(await repo.listBooks());
  assert.equal(before.filter((b) => b.series === 'tidewater').length, 2, 'two tidewater books');
  await waitFor(async () => {
    const s = plain(await repo.indexStatus());
    const list = Array.isArray(s) ? s : s?.books ?? [s];
    return list.length > 0 && list.every((b) => b.state === 'fresh');
  }, { what: 'all book indexes fresh' });

  const file = path.join(root, 'tidewater', 'series.md');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('slug: tidewater'));
  await fs.writeFile(file, text.replace('slug: tidewater', 'slug: tidewater-revised'));

  await waitFor(async () => plain(await repo.listBooks()).filter((b) => b.series === 'tidewater-revised').length === 2, {
    what: 'both series books to show the new series slug',
  });
  const after = plain(await repo.listBooks());
  assert.equal(
    after.filter((b) => b.series === null).length,
    before.filter((b) => b.series === null).length,
    'standalone books unaffected',
  );
});
