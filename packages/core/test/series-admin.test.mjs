// setBookTitle and createSeries on a copy of the `valid/covers` fixture (series harbour-lights; standalone books north-road, lost-cover, ...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const NORTH = 'book_01V30000000000000000000011';

async function setup(t) {
  const root = await copyFixture('valid/covers');
  const repo = createFsRepository(root, { watch: false });
  t.after(async () => {
    await repo.close();
  });
  return { root, repo };
}
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');

test('setBookTitle changes only the title line; folder and slug stay', async (t) => {
  const { root, repo } = await setup(t);
  const before = await read(root, 'north-road/book.md');
  const r = await repo.setBookTitle(NORTH, '  The Long Road  ');
  assert.deepEqual(r, { ok: true, code: 'OK', title: 'The Long Road' });
  const after = await read(root, 'north-road/book.md');
  assert.equal(after, before.replace('title: North Road', 'title: The Long Road'));
  assert.match(after, /^slug: north-road$/m);
  assert.equal((await repo.listBooks()).find((b) => b.id === NORTH).title, 'The Long Road');
  assert.equal((await repo.listBooks()).find((b) => b.id === NORTH).path, 'north-road');
  assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.file.startsWith('north-road')), []);
});

test('setBookTitle: same title is unchanged; titles with a colon or quotes are written safely', async (t) => {
  const { root, repo } = await setup(t);
  const same = await repo.setBookTitle(NORTH, 'North Road');
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  await repo.setBookTitle(NORTH, 'Part 1: The Road');
  assert.match(await read(root, 'north-road/book.md'), /^title: "Part 1: The Road"$/m);
  for (const title of ['Part 1: The Road', 'He said "go" # now', "It's a 'road'", '- dash', 'yes']) {
    const r = await repo.setBookTitle(NORTH, title);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await repo.listBooks()).find((b) => b.id === NORTH).title, title);
    assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.file.startsWith('north-road')), [], title);
  }
});

test('setBookTitle refuses bad titles with BAD_TITLE on field title and writes nothing', async (t) => {
  const { root, repo } = await setup(t);
  const before = await read(root, 'north-road/book.md');
  for (const bad of ['', '   ', 'x'.repeat(121), 'two\nlines', 'tab\there', 42, null, undefined]) {
    const r = await repo.setBookTitle(NORTH, bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_TITLE');
    assert.equal(r.field, 'title');
  }
  assert.equal(await read(root, 'north-road/book.md'), before);
});

test('setBookTitle: stale base sha256 is a CONFLICT, a current one works, an unknown book is NOT_FOUND', async (t) => {
  const { root, repo } = await setup(t);
  const stale = await repo.setBookTitle(NORTH, 'New Name', { baseSha256: 'a'.repeat(64) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'CONFLICT');
  assert.match(await read(root, 'north-road/book.md'), /^title: North Road$/m);
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(await fs.readFile(path.join(root, 'north-road', 'book.md'))).digest('hex');
  assert.equal((await repo.setBookTitle(NORTH, 'New Name', { baseSha256: sha })).ok, true);
  const gone = await repo.setBookTitle('book_01V3000000000000000000ZZZZ', 'Whatever');
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'NOT_FOUND');
});

test('createSeries makes a valid series folder the library lists', async (t) => {
  const { root, repo } = await setup(t);
  const r = await repo.createSeries({ title: 'The Tide: Book Cycle' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.slug, 'the-tide-book-cycle');
  assert.equal(r.path, 'the-tide-book-cycle');
  assert.match(r.seriesId, /^series_[0-9A-HJKMNP-TV-Z]{26}$/);
  const text = await read(root, 'the-tide-book-cycle/series.md');
  assert.match(text, new RegExp(`^id: ${r.seriesId}$`, 'm'));
  assert.match(text, /^status: active$/m);
  assert.deepEqual((await validate(root)).diagnostics, []);
  const info = await repo.libraryInfo();
  const s = info.series.find((x) => x.slug === 'the-tide-book-cycle');
  assert.deepEqual({ ...s }, { slug: 'the-tide-book-cycle', title: 'The Tide: Book Cycle', status: 'active', book_ids: [] });
});

test('createSeries honours slug and status, and a book can then be created in and moved into the new series', async (t) => {
  const { root, repo } = await setup(t);
  const r = await repo.createSeries({ title: 'Salt Trilogy', slug: 'salt', status: 'planned' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(await read(root, 'salt/series.md'), /^status: planned$/m);

  const made = await repo.createBook({ title: 'Salt One', template: 'blank', seriesSlug: 'salt' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.path, 'salt/salt-one');

  const moved = await repo.moveBookToSeries(NORTH, { seriesSlug: 'salt' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.path, 'salt/north-road');
  assert.equal(moved.seriesNumber, 2);
  const info = await repo.libraryInfo();
  assert.equal(info.series.find((x) => x.slug === 'salt').book_ids.length, 2);
});

test('createSeries refusals: SLUG_TAKEN (book or series), FOLDER_EXISTS, BAD_TITLE, BAD_SLUG, bad status, OUTSIDE_ROOT', async (t) => {
  const { root, repo } = await setup(t);
  const code = async (input) => {
    const r = await repo.createSeries(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    return [r.code, r.field];
  };
  assert.deepEqual(await code({ title: 'North Road' }), ['SLUG_TAKEN', 'slug']);
  assert.deepEqual(await code({ title: 'Anything', slug: 'harbour-lights' }), ['SLUG_TAKEN', 'slug']);
  await fs.mkdir(path.join(root, 'plain-folder'));
  assert.deepEqual(await code({ title: 'Plain', slug: 'plain-folder' }), ['FOLDER_EXISTS', 'slug']);
  assert.deepEqual(await code({ title: '' }), ['BAD_TITLE', 'title']);
  assert.deepEqual(await code({ title: 'a\nb' }), ['BAD_TITLE', 'title']);
  assert.deepEqual(await code({ title: 'x'.repeat(121) }), ['BAD_TITLE', 'title']);
  assert.deepEqual(await code({ title: 'Ok', slug: 'Bad Slug' }), ['BAD_SLUG', 'slug']);
  assert.deepEqual(await code({ title: 'Ok', slug: 'a'.repeat(61) }), ['BAD_SLUG', 'slug']);
  assert.deepEqual(await code({ title: '!!!' }), ['BAD_SLUG', 'slug']);
  assert.deepEqual(await code({ title: 'Ok', status: 'finished' }), ['BAD_STATUS', 'status']);
  assert.equal((await repo.createSeries(null)).code, 'BAD_TITLE');
  assert.equal((await validate(root)).diagnostics.length, 0, 'refusals leave a valid library');
});

test('createSeries is refused outside a library folder', async (t) => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { watch: false });
  t.after(async () => {
    await repo.close();
  });
  const r = await repo.createSeries({ title: 'Nope' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OUTSIDE_ROOT');
});
