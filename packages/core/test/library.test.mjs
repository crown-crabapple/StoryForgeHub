// M02-J02 acceptance 1-3: library fields, index == files for the covers fixture, and no dependence on SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { FIXTURES, copyFixture } from './helpers.mjs';

const ID = {
  'first-light': 'book_01V30000000000000000000003',
  'second-light': 'book_01V30000000000000000000007',
  'north-road': 'book_01V30000000000000000000011',
  'old-draft': 'book_01V30000000000000000000015',
  'lost-cover': 'book_01V30000000000000000000019',
  'svg-cover': 'book_01V30000000000000000000023',
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const COVERS = 'valid/covers';

const bySlug = (list) => Object.fromEntries(list.map((b) => [b.slug, b]));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function removeStoryforgeDirs(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === '.storyforge') await fs.rm(full, { recursive: true, force: true });
    else await removeStoryforgeDirs(full);
  }
}

test('covers: fixture lists six books with the J02 fields', async () => {
  const repo = createFsRepository(await copyFixture(COVERS));
  const list = plain(await repo.listBooks());
  assert.equal(list.length, 6);
  const b = bySlug(list);
  for (const [slug, id] of Object.entries(ID)) assert.equal(b[slug].id, id);

  const first = b['first-light'];
  assert.equal(first.title, 'First Light');
  assert.equal(first.subtitle, 'The Beacon Is Lit');
  assert.equal(first.pen_name, 'r-fenwick');
  assert.equal(first.pen_name_display, 'R. Fenwick');
  assert.deepEqual(first.genre, ['mystery', 'coastal']);
  assert.equal(first.word_target, 90000);
  assert.equal(first.language, 'en');
  assert.equal(first.series_title, 'Harbour Lights');
  assert.equal(first.archived, false);
  assert.equal(first.cover_color, null);
  assert.equal(first.cover_state, 'image');
  const png = await fs.readFile(path.join(FIXTURES, COVERS, 'harbour-lights/first-light/assets/cover.png'));
  assert.equal(first.cover_url, `/api/books/${ID['first-light']}/cover?v=${sha(png).slice(0, 8)}`);
  assert.equal(first.blurb, 'The beacon was lit at dusk.'); // first paragraph only
  assert.ok(['ok', 'invalid'].includes(first.index_state));

  const second = b['second-light'];
  assert.equal(second.cover_color, '#2F4A3A');
  assert.equal(second.cover_state, 'none');
  assert.equal(second.cover_url, null);
  assert.equal(second.series_title, 'Harbour Lights');
  assert.equal(second.pen_name_display, 'R. Fenwick');
  assert.equal(second.blurb, 'The fog rolled in.');

  const north = b['north-road'];
  assert.equal(north.status, 'revising');
  assert.equal(north.word_target, 60000);
  assert.equal(north.pen_name_display, 'A. Marsh');
  assert.equal(north.series_title, null);
  assert.equal(north.cover_state, 'none');
  assert.equal(north.cover_url, null);
  assert.equal(north.cover_color, null);
  assert.equal(north.archived, false);

  assert.equal(b['old-draft'].archived, true);
  assert.equal(b['old-draft'].status, 'archived');
  assert.equal(b['old-draft'].pen_name_display, null);
  assert.equal(b['lost-cover'].cover_state, 'missing');
  assert.equal(b['lost-cover'].cover_url, null);
  assert.equal(b['svg-cover'].cover_state, 'unsupported');
  assert.equal(b['svg-cover'].cover_url, null);
  for (const [slug, x] of Object.entries(b)) {
    if (slug !== 'old-draft') assert.equal(x.archived, false, slug);
  }
});

test('cover_state "outside": path escaping the book, or not under assets/', async () => {
  const root = await copyFixture(COVERS);
  const edit = async (rel, from, to) => {
    const f = path.join(root, rel, 'book.md');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(from, to));
  };
  await edit('north-road', 'profile: fiction', 'profile: fiction\ncover: ../sibling.png');
  await fs.writeFile(path.join(root, 'old-draft', 'cover.png'), 'not under assets');
  await edit('old-draft', 'profile: fiction', 'profile: fiction\ncover: cover.png');
  const b = bySlug(plain(await createFsRepository(root).listBooks()));
  assert.equal(b['north-road'].cover_state, 'outside');
  assert.equal(b['north-road'].cover_url, null);
  assert.equal(b['old-draft'].cover_state, 'outside');
  assert.equal(b['old-draft'].cover_url, null);
});

test('libraryInfo lists series with title, status and book ids in series_number order', async () => {
  const info = plain(await createFsRepository(await copyFixture(COVERS)).libraryInfo());
  assert.deepEqual(info.series, [
    { slug: 'harbour-lights', title: 'Harbour Lights', status: 'active', book_ids: [ID['first-light'], ID['second-light']] },
  ]);
  assert.deepEqual(info.diagnostics, []);
});

test('getCover: bytes + type + sha256 for an image cover, null for every other state and unknown ids', async () => {
  const repo = createFsRepository(await copyFixture(COVERS));
  const png = await fs.readFile(path.join(FIXTURES, COVERS, 'harbour-lights/first-light/assets/cover.png'));
  const c = await repo.getCover(ID['first-light']);
  assert.ok(c);
  assert.ok(Buffer.from(c.bytes).equals(png));
  assert.equal(c.contentType, 'image/png');
  assert.equal(c.sha256, sha(png));
  for (const slug of ['second-light', 'north-road', 'old-draft', 'lost-cover', 'svg-cover']) {
    assert.equal(await repo.getCover(ID[slug]), null, slug);
  }
  assert.equal(await repo.getCover('book_00000000000000000000000000'), null);
  assert.equal(await repo.getCover('../../etc/passwd'), null);
});

test('covers: index == files (listBooks, libraryInfo, getBook deep-equal)', async () => {
  const filesRoot = await copyFixture(COVERS);
  const indexRoot = await copyFixture(COVERS);
  const filesRepo = createFsRepository(filesRoot);
  const fromFiles = plain(await filesRepo.listBooks());
  const infoFiles = plain(await filesRepo.libraryInfo());
  const booksFiles = [];
  for (const x of fromFiles) booksFiles.push(plain(await filesRepo.getBook(x.id)));

  const repo = createFsRepository(indexRoot);
  await repo.rebuildIndex();
  for (const x of fromFiles) assert.equal(plain(await repo.indexStatus(x.id)).state, 'fresh', x.id);
  assert.deepEqual(plain(await repo.listBooks()), fromFiles);
  assert.deepEqual(plain(await repo.libraryInfo()), { ...infoFiles, root: indexRoot });
  for (let i = 0; i < fromFiles.length; i++) assert.deepEqual(plain(await repo.getBook(fromFiles[i].id)), booksFiles[i]);
});

test('covers: deleting every .storyforge/ changes nothing in listBooks, libraryInfo or getCover', async () => {
  const root = await copyFixture(COVERS);
  const repo = createFsRepository(root);
  await repo.rebuildIndex();
  const before = {
    list: plain(await repo.listBooks()),
    info: plain(await repo.libraryInfo()),
    cover: await repo.getCover(ID['first-light']),
  };
  assert.equal(before.list.length, 6);
  await removeStoryforgeDirs(root);
  await assert.rejects(fs.access(path.join(root, '.storyforge')));

  const after = createFsRepository(root);
  assert.deepEqual(plain(await after.listBooks()), before.list);
  assert.deepEqual(plain(await after.libraryInfo()), before.info);
  const cover = await after.getCover(ID['first-light']);
  assert.equal(cover.sha256, before.cover.sha256);
  assert.ok(Buffer.from(cover.bytes).equals(Buffer.from(before.cover.bytes)));
});
