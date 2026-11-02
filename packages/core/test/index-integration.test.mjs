import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const SALT_BOOK = 'book_01S5000000000000000000000A';
const LOWTIDE = 'scene_01S50000000000000000000008';
const ARRIVAL = 'scene_01S50000000000000000000002';
const MAREN = 'entry_01S5000000000000000000000G';
const PORT_ALDINE = 'entry_01S5000000000000000000000N';
const TOBIN = 'entry_01S5000000000000000000000J';
const plain = (v) => JSON.parse(JSON.stringify(v));
const rowsOf = (v) => (Array.isArray(v) ? v : v?.results ?? v?.rows ?? []);

/** Poll until `fn` returns truthy (bounded; the index refreshes in the background). */
async function waitFor(fn, what, attempts = 320) {
  for (let i = 0; i < attempts; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`gave up waiting for ${what}`);
}

for (const fixture of ['valid/salt-orchard', 'valid/library', 'valid/spec-example']) {
  test(`${fixture}: listBooks and getBook from a fresh index deep-equal the file-backed answers`, async () => {
    // Copy A is only ever read before any index exists (file path); copy B is rebuilt first.
    const filesRoot = await copyFixture(fixture);
    const indexRoot = await copyFixture(fixture);
    const filesRepo = createFsRepository(filesRoot);
    const fromFilesList = plain(await filesRepo.listBooks());
    const fromFilesBooks = [];
    for (const b of fromFilesList) fromFilesBooks.push(plain(await filesRepo.getBook(b.id)));

    const repo = createFsRepository(indexRoot);
    await repo.rebuildIndex();
    for (const b of fromFilesList) {
      const st = plain(await repo.indexStatus(b.id));
      assert.equal(st.state, 'fresh', `${b.id} index is fresh`);
    }
    assert.deepEqual(plain(await repo.listBooks()), fromFilesList);
    for (let i = 0; i < fromFilesList.length; i++) {
      assert.deepEqual(plain(await repo.getBook(fromFilesList[i].id)), fromFilesBooks[i]);
    }
    assert.equal(await repo.getBook('book_00000000000000000000000000'), null);
  });
}

test('search through the repository finds scenes and entries, with diacritics folded', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const rows = rowsOf(plain(await repo.search('cafe', { bookId: SALT_BOOK })));
  const hit = rows.find((r) => r.id === LOWTIDE);
  assert.ok(hit, `Low Tide scene found: ${JSON.stringify(rows)}`);
  assert.equal(hit.kind, 'scene');
  assert.equal(hit.title, 'Low Tide');
  assert.ok(hit.path.endsWith('0010-low-tide.md'));

  const entriesOnly = rowsOf(plain(await repo.search('cafe', { bookId: SALT_BOOK, kinds: ['entry'] })));
  assert.ok(entriesOnly.length > 0 && entriesOnly.every((r) => r.kind === 'entry'), 'port-aldine entry mentions the café');
  assert.ok(!entriesOnly.some((r) => r.id === LOWTIDE));

  assert.equal(rowsOf(plain(await repo.search('cafe', { bookId: SALT_BOOK, limit: 1 }))).length, 1);
  assert.deepEqual(rowsOf(plain(await repo.search('zzzzunmatchable', { bookId: SALT_BOOK }))), []);
  await repo.search('"a" OR b* NEAR(', { bookId: SALT_BOOK });
});

test('search works before the index exists (answers from files or an empty-but-valid result, never a throw)', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  const out = await repo.search('cafe', { bookId: SALT_BOOK });
  assert.ok(Array.isArray(rowsOf(out)));
});

test('library-wide search (no bookId) unions every book', async () => {
  const root = await copyFixture('valid/library');
  const repo = createFsRepository(root);
  await repo.rebuildIndex();
  const books = await repo.listBooks();
  assert.ok(books.length >= 3);
  let sum = 0;
  for (const b of books) sum += rowsOf(plain(await repo.search('maren', { bookId: b.id, limit: 100 }))).length;
  assert.ok(sum >= 3, 'each book has a Maren entry');
  const all = rowsOf(plain(await repo.search('maren', { limit: 100 })));
  assert.equal(all.length, sum);
});

test('getBacklinks returns the sources that link to an object', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const rows = rowsOf(plain(await repo.getBacklinks(SALT_BOOK, PORT_ALDINE)));
  const sources = rows.map((r) => r.src_id);
  assert.ok(sources.includes(MAREN), 'maren-hollis links Home: [[port-aldine]]');
  assert.ok(sources.includes(TOBIN), 'tobin-reyes links [[port-aldine]]');
  assert.ok(rows.every((r) => r.target_id === PORT_ALDINE));
  assert.deepEqual(rowsOf(plain(await repo.getBacklinks(SALT_BOOK, 'entry_00000000000000000000000000'))), []);
});

test('getMentions counts whole-word, case-insensitive name and alias matches outside comments and code', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  const scene = await repo.getScene(SALT_BOOK, ARRIVAL);
  const body =
    scene.body +
    '\nMare laughed. MARE laughed again, and Maren Hollis said nothing. Mares and Marena do not count.\n\n' +
    '<!-- Mare Mare Mare -->\n\n```\nMare Mare\n```\n';
  const w = await repo.updateSceneBody(SALT_BOOK, ARRIVAL, body, { baseSha256: scene.sha256 });
  assert.equal(w.ok, true, JSON.stringify(w));
  await repo.rebuildIndex(SALT_BOOK);

  const rows = rowsOf(plain(await repo.getMentions(SALT_BOOK, { entryId: MAREN })));
  const here = rows.find((r) => r.scene_id === ARRIVAL);
  assert.ok(here, `arrival scene mentions Maren: ${JSON.stringify(rows)}`);
  // original text has no "Maren Hollis"/"Mare" word; the appended prose adds exactly 3.
  const original = scene.body.match(/\b(maren hollis|mare)\b/gi)?.length ?? 0;
  assert.equal(here.count, original + 3);
  assert.ok(rows.every((r) => r.entry_id === MAREN));

  const byScene = rowsOf(plain(await repo.getMentions(SALT_BOOK, { sceneId: ARRIVAL })));
  assert.ok(byScene.some((r) => r.entry_id === MAREN && r.count === here.count));
  assert.ok(byScene.every((r) => r.scene_id === ARRIVAL));
});

test('a write through the repository refreshes the index', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);
  const scene = await repo.getScene(SALT_BOOK, ARRIVAL);

  const w = await repo.updateSceneBody(SALT_BOOK, ARRIVAL, 'Entirely replaced prose about uniquewordtheta.\n', { baseSha256: scene.sha256 });
  assert.equal(w.ok, true, JSON.stringify(w));

  // Reads are right immediately, whatever the index is doing.
  assert.equal((await repo.getScene(SALT_BOOK, ARRIVAL)).body, 'Entirely replaced prose about uniquewordtheta.\n');
  assert.equal((await repo.getBook(SALT_BOOK)).acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).find((s) => s.id === ARRIVAL).word_count, 5); // 'Entirely replaced prose about uniquewordtheta.' = 5 \S+ runs

  await waitFor(async () => (await repo.indexStatus(SALT_BOOK)).state === 'fresh', 'index to become fresh after the write');
  const found = rowsOf(plain(await repo.search('uniquewordtheta', { bookId: SALT_BOOK })));
  assert.deepEqual(found.map((r) => r.id), [ARRIVAL]);
  // text that was removed is gone
  assert.ok(!rowsOf(plain(await repo.search('ferry', { bookId: SALT_BOOK }))).some((r) => r.id === ARRIVAL));
  // the index file on disk matches the files again
  const st = plain(await repo.indexStatus(SALT_BOOK));
  assert.deepEqual(st.stale_paths, []);
  await fs.access(path.join(root, '.storyforge', 'index.sqlite'));
});

test('createScene and archiveScene through the repository keep the index fresh and consistent', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  await repo.rebuildIndex(SALT_BOOK);

  const c = await repo.createScene(SALT_BOOK, { act: 1, chapter: 1, after: null, slug: 'indexed-newcomer', title: 'Indexed Newcomer', body: 'About uniquewordiota.\n' });
  assert.equal(c.ok, true, JSON.stringify(c));
  await waitFor(async () => rowsOf(plain(await repo.search('uniquewordiota', { bookId: SALT_BOOK }))).some((r) => r.id === c.id), 'new scene to be searchable');

  const created = await repo.getScene(SALT_BOOK, c.id);
  const a = await repo.archiveScene(SALT_BOOK, c.id, { baseSha256: created.sha256 });
  assert.equal(a.ok, true, JSON.stringify(a));
  await waitFor(async () => !rowsOf(plain(await repo.search('uniquewordiota', { bookId: SALT_BOOK, kinds: ['scene'] }))).some((r) => r.id === c.id && !r.path.startsWith('archive/')), 'archived scene to leave live results');

  // Whatever the index did, getBook agrees with a file-only repository over the same files.
  await waitFor(async () => (await repo.indexStatus(SALT_BOOK)).state === 'fresh', 'fresh index');
  const reference = createFsRepository(await (async () => {
    const copy = await copyFixture('valid/salt-orchard');
    await fs.rm(copy, { recursive: true, force: true });
    await fs.cp(root, copy, { recursive: true });
    await fs.rm(path.join(copy, '.storyforge', 'index.sqlite'), { force: true });
    return copy;
  })());
  assert.deepEqual(plain(await repo.getBook(SALT_BOOK)), plain(await reference.getBook(SALT_BOOK)));
});

test('indexStatus and rebuildIndex report per book', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  assert.equal(plain(await repo.indexStatus(SALT_BOOK)).state, 'missing');
  const r = await repo.rebuildIndex(SALT_BOOK);
  assert.notEqual(plain(r)?.ok, false);
  assert.equal(plain(await repo.indexStatus(SALT_BOOK)).state, 'fresh');
});
