// moveBookToSeries: a standalone book moves into an existing series in one folder rename; every id stays,
// series_number is set at the new place, refusals write nothing, and a running watcher does not block the move.
//
// The library is a copy of the `valid/covers` fixture: series harbour-lights (books 1 and 2), standalone
// books north-road (book_...11, scenes ...13 and ...14) and lost-cover, among others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';
import { waitFor } from './watch-helpers.mjs';

const COVERS = 'valid/covers';
const NORTH = 'book_01V30000000000000000000011';
const SCENE_A = 'scene_01V30000000000000000000013';
const SERIES = 'harbour-lights';
const exists = (p) => fs.stat(p).then(() => true, () => false);
const codes = (diags) => diags.map((d) => `${d.severity}:${d.code}`).sort();

async function setup(t, opts = { watch: false }) {
  const root = await copyFixture(COVERS);
  const repo = createFsRepository(root, opts);
  t.after(async () => {
    await repo.close();
  });
  assert.equal(typeof repo.moveBookToSeries, 'function', 'implementation missing: repository.moveBookToSeries');
  return { root, repo };
}

const seriesNumberOf = async (root, rel) => {
  const text = await fs.readFile(path.join(root, ...rel.split('/'), 'book.md'), 'utf8');
  return text.replace(/\r\n/g, '\n').match(/^series_number: (.*)$/m)?.[1];
};

test('moves a standalone book into the series: path, series_number = max + 1, ids unchanged', async (t) => {
  const { root, repo } = await setup(t);
  const diagsBefore = await repo.getDiagnostics(NORTH);
  const sceneBefore = await repo.getScene(NORTH, SCENE_A);
  assert.ok(sceneBefore);
  const filesBefore = Object.keys(await snapshot(path.join(root, 'north-road'), { skipStoryforge: true }));

  const r = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bookId, NORTH);
  assert.equal(r.path, `${SERIES}/north-road`);
  assert.equal(r.from, 'north-road');
  assert.equal(r.seriesSlug, SERIES);
  assert.equal(r.seriesNumber, 3, 'max(1, 2) + 1');
  assert.equal(r.warning, undefined);

  assert.equal(await exists(path.join(root, 'north-road')), false, 'old place gone');
  assert.equal(await seriesNumberOf(root, `${SERIES}/north-road`), '3');
  const bookMd = await fs.readFile(path.join(root, SERIES, 'north-road', 'book.md'), 'utf8');
  assert.match(bookMd, new RegExp(`^id: ${NORTH}$`, 'm'), 'book id unchanged');
  assert.match(bookMd, /^title: North Road$/m, 'rest of book.md untouched');
  assert.match(bookMd, /^word_target: 60000$/m);

  // same files at the new place
  assert.deepEqual(Object.keys(await snapshot(path.join(root, SERIES, 'north-road'), { skipStoryforge: true })), filesBefore);

  // the repository sees the book at the new place, in the series
  const book = await repo.getBook(NORTH);
  assert.ok(book, 'getBook by the same id');
  assert.equal(book.id, NORTH);
  assert.equal(book.path, `${SERIES}/north-road`);
  assert.equal(book.series, SERIES);
  assert.equal(book.series_number, 3);
  const listed = (await repo.listBooks()).filter((b) => b.id === NORTH);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, `${SERIES}/north-road`);
  assert.equal(listed[0].series, SERIES);
  assert.equal(listed[0].series_number, 3);
  const info = await repo.libraryInfo();
  assert.ok(info.series.find((s) => s.slug === SERIES).book_ids.includes(NORTH));

  // scenes still readable by id, same content
  const sceneAfter = await repo.getScene(NORTH, SCENE_A);
  assert.ok(sceneAfter, 'scene readable by its id');
  assert.equal(sceneAfter.id, SCENE_A);
  assert.equal(sceneAfter.body, sceneBefore.body);
  assert.equal(sceneAfter.sha256, sceneBefore.sha256);

  // no new diagnostics
  assert.deepEqual(codes(await repo.getDiagnostics(NORTH)), codes(diagsBefore));
  assert.equal((await repo.getDiagnostics()).filter((d) => d.severity === 'error').length, 0);
});

test('an explicit seriesNumber is honoured, including one below the max', async (t) => {
  const { root, repo } = await setup(t);
  const r = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES, seriesNumber: 7 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seriesNumber, 7);
  assert.equal(await seriesNumberOf(root, `${SERIES}/north-road`), '7');
  assert.equal((await repo.getBook(NORTH)).series_number, 7);
});

test('auto number follows the new max when a second book joins', async (t) => {
  const { root, repo } = await setup(t);
  assert.equal((await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES, seriesNumber: 9 })).ok, true);
  const lost = (await repo.listBooks()).find((b) => b.path === 'lost-cover');
  assert.ok(lost);
  const r = await repo.moveBookToSeries(lost.id, { seriesSlug: SERIES });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seriesNumber, 10);
  assert.equal(await seriesNumberOf(root, `${SERIES}/lost-cover`), '10');
});

test('a number already used in the series, or an invalid number, is refused with SERIES_NUMBER_TAKEN and nothing moves', async (t) => {
  const { root, repo } = await setup(t);
  const before = await snapshot(root, { skipStoryforge: true });
  for (const seriesNumber of [2, 1, 0, -1, 1.5, '2', NaN, 1e12]) {
    const r = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES, seriesNumber });
    assert.equal(r.ok, false, `seriesNumber ${String(seriesNumber)} must be refused`);
    assert.equal(r.code, 'SERIES_NUMBER_TAKEN', `seriesNumber ${String(seriesNumber)}`);
    assert.equal(r.field, 'seriesNumber');
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before, 'nothing moved or written');
  assert.equal((await repo.getBook(NORTH)).path, 'north-road');
});

test('a book already in a series -> ALREADY_IN_SERIES, nothing moves', async (t) => {
  const { root, repo } = await setup(t);
  const first = (await repo.listBooks()).find((b) => b.path === `${SERIES}/first-light`);
  assert.ok(first);
  const before = await snapshot(root, { skipStoryforge: true });
  const r = await repo.moveBookToSeries(first.id, { seriesSlug: SERIES });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALREADY_IN_SERIES');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('an unknown book (or a non-string id) -> NOT_FOUND, nothing moves', async (t) => {
  const { root, repo } = await setup(t);
  const before = await snapshot(root, { skipStoryforge: true });
  for (const id of ['book_01V3000000000000000000ZZZZ', '', undefined, null, 42]) {
    const r = await repo.moveBookToSeries(id, { seriesSlug: SERIES });
    assert.equal(r.ok, false, String(id));
    assert.equal(r.code, 'NOT_FOUND', String(id));
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('an unknown, missing or empty series -> NO_SUCH_SERIES, nothing moves', async (t) => {
  const { root, repo } = await setup(t);
  const before = await snapshot(root, { skipStoryforge: true });
  for (const input of [{ seriesSlug: 'no-such-series' }, {}, { seriesSlug: '' }, { seriesSlug: 7 }, undefined, null]) {
    const r = await repo.moveBookToSeries(NORTH, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.code, 'NO_SUCH_SERIES', JSON.stringify(input));
    assert.equal(r.field, 'seriesSlug');
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('a folder of the same name already in the series -> FOLDER_EXISTS, nothing moves', async (t) => {
  const { root, repo } = await setup(t);
  await fs.mkdir(path.join(root, SERIES, 'north-road'));
  const before = await snapshot(root, { skipStoryforge: true });
  const r = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FOLDER_EXISTS');
  assert.equal(r.field, 'seriesSlug');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
  assert.equal(await exists(path.join(root, 'north-road', 'book.md')), true);
});

test('after the move, writes through the repository land at the new path and nothing reappears at the old one', async (t) => {
  const { root, repo } = await setup(t);
  const m = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES });
  assert.equal(m.ok, true, JSON.stringify(m));

  const g = await repo.setDailyGoal(NORTH, 750);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.match(await fs.readFile(path.join(root, SERIES, 'north-road', 'book.md'), 'utf8'), /^daily_word_goal: 750$/m);
  assert.match(await fs.readFile(path.join(root, SERIES, 'north-road', 'book.md'), 'utf8'), /^series_number: 3$/m, 'series_number kept');

  const scene = await repo.getScene(NORTH, SCENE_A);
  const w = await repo.updateSceneBody(NORTH, SCENE_A, 'Changed after the move.\n', { baseSha256: scene.sha256 });
  assert.equal(w.ok, true, JSON.stringify(w));
  const sceneFile = path.join(root, SERIES, 'north-road', 'manuscript', 'act-01-one', 'ch-001-one', '0010-a.md');
  assert.match(await fs.readFile(sceneFile, 'utf8'), /Changed after the move\./);
  assert.match((await repo.getScene(NORTH, SCENE_A)).body, /Changed after the move\./);

  assert.equal(await exists(path.join(root, 'north-road')), false, 'nothing recreated at the old path');
  assert.equal((await repo.getBook(NORTH)).path, `${SERIES}/north-road`);
});

test('with the watcher running the move succeeds, and the repository keeps working at the new place', async (t) => {
  const { root, repo } = await setup(t, { debounceMs: 50, pollMs: 60000 });
  await repo.rebuildIndex();
  await waitFor(async () => (await repo.indexStatus(NORTH)).state === 'fresh', { what: 'initial fresh index' });

  const r = await repo.moveBookToSeries(NORTH, { seriesSlug: SERIES });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warning, undefined);
  assert.equal(await exists(path.join(root, 'north-road')), false);
  assert.equal(await seriesNumberOf(root, `${SERIES}/north-road`), '3');

  await waitFor(async () => (await repo.indexStatus(NORTH)).state === 'fresh', { what: 'fresh index at the new place' });
  assert.equal((await repo.getBook(NORTH)).path, `${SERIES}/north-road`);

  // the watcher watches the new folder: an outside edit there is noticed
  const sceneFile = path.join(root, SERIES, 'north-road', 'manuscript', 'act-01-one', 'ch-001-one', '0010-a.md');
  const text = await fs.readFile(sceneFile, 'utf8');
  await fs.writeFile(sceneFile, text.replace('A synthetic line', 'An outside edit, a synthetic line'));
  await waitFor(async () => /outside edit/.test((await repo.getScene(NORTH, SCENE_A)).body), { what: 'outside edit visible' });

  const g = await repo.setDailyGoal(NORTH, 500);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(await exists(path.join(root, 'north-road')), false, 'nothing recreated at the old path');
});
