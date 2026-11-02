import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, readExpected, snapshot } from './helpers.mjs';

const SALT_BOOK = 'book_01S5000000000000000000000A';
const FIRST_SCENE = 'scene_01S50000000000000000000001';
const allScenes = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));

let saltRoot, salt, expectedSalt;
before(async () => {
  saltRoot = await copyFixture('valid/salt-orchard');
  salt = createFsRepository(saltRoot);
  expectedSalt = await readExpected('valid/salt-orchard');
});

test('salt-orchard: listBooks returns the single book', async () => {
  const books = await salt.listBooks();
  assert.equal(books.length, 1);
  const b = books[0];
  assert.equal(b.id, SALT_BOOK);
  assert.equal(b.slug, 'salt-orchard');
  assert.equal(b.title, 'The Salt Orchard');
  assert.equal(b.scene_count, 7);
  assert.equal(b.series, null);
  assert.equal(b.series_number, null);
  assert.equal(b.status, 'drafting');
  assert.equal(b.error_count, 0);
  assert.equal(b.warning_count, 0);
  assert.ok(b.word_count > 0);
  assert.ok(!b.path.includes('\\') && !path.isAbsolute(b.path));
});

test('salt-orchard: getBook scenes follow expected.json order', async () => {
  const book = await salt.getBook(SALT_BOOK);
  assert.deepEqual(allScenes(book).map((s) => s.id), expectedSalt.order);
});

test('salt-orchard: acts, chapters and labels', async () => {
  const book = await salt.getBook(SALT_BOOK);
  assert.deepEqual(book.acts.map((a) => a.act), [1, 2]);
  assert.deepEqual(book.acts[0].chapters.map((c) => c.chapter), [0, 1, 2]);
  assert.deepEqual(book.acts[0].chapters.map((c) => c.label), ['Prologue', 'Chapter One', 'Chapter Two']);
  assert.deepEqual(book.acts[0].chapters.map((c) => c.title), ['Before the Tide', 'The Drowned Rows', 'The Grafting']);
  assert.deepEqual(book.acts[1].chapters.map((c) => c.chapter), [3]);
  assert.equal(book.acts[1].chapters[0].label, 'Chapter Three');
});

test('salt-orchard: scene summaries carry position, pov, status, path', async () => {
  const book = await salt.getBook(SALT_BOOK);
  const scenes = allScenes(book);
  assert.equal(scenes.length, 7);
  assert.equal(new Set(scenes.map((s) => s.position)).size, 7);
  const first = scenes[0];
  assert.equal(first.title, 'Before the Tide');
  assert.equal(first.pov, 'ilse-hollis');
  assert.equal(first.status, 'revised');
  assert.equal(first.act, 1);
  assert.equal(first.chapter, 0);
  assert.equal(first.sequence, 10);
  assert.equal(first.path, 'manuscript/act-01-low-water/ch-000-prologue/0010-before-the-tide.md');
  assert.ok(first.word_count > 0);
});

test('salt-orchard: excluded lists the variant and the archived scene', async () => {
  const book = await salt.getBook(SALT_BOOK);
  const byId = Object.fromEntries(book.excluded.map((e) => [e.id, e]));
  for (const e of expectedSalt.excluded) {
    assert.equal(byId[e.id]?.reason, e.reason);
    assert.equal(byId[e.id]?.path, e.path);
  }
  assert.equal(book.excluded.length, expectedSalt.excluded.length);
});

test('salt-orchard: getScene body is byte-equal to the file body', async () => {
  const rel = 'manuscript/act-01-low-water/ch-000-prologue/0010-before-the-tide.md';
  const raw = await fs.readFile(path.join(saltRoot, rel), 'utf8');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  assert.ok(m, 'fixture has front matter');
  const expectedBody = raw.slice(m[0].length);
  const scene = await salt.getScene(SALT_BOOK, FIRST_SCENE);
  assert.equal(scene.id, FIRST_SCENE);
  assert.equal(scene.body, expectedBody);
  assert.ok(scene.body.includes('潮が引く、そして戻る'));
  assert.equal(scene.front_matter.id, FIRST_SCENE);
  assert.equal(scene.front_matter.pov, 'ilse-hollis');
  assert.equal(scene.path, rel);
});

test('unknown book / scene ids return null', async () => {
  assert.equal(await salt.getBook('book_NOPE'), null);
  assert.equal(await salt.getScene('book_NOPE', FIRST_SCENE), null);
  assert.equal(await salt.getScene(SALT_BOOK, 'scene_NOPE'), null);
});

test('libraryInfo and getDiagnostics on a clean book', async () => {
  const info = await salt.libraryInfo();
  assert.equal(typeof info.root, 'string');
  assert.ok(Array.isArray(info.diagnostics));
  assert.deepEqual(await salt.getDiagnostics(), []);
  assert.deepEqual(await salt.getDiagnostics(SALT_BOOK), []);
});

test('library fixture: 3 books, series books by number then standalone', async () => {
  const repo = createFsRepository(await copyFixture('valid/library'));
  const books = await repo.listBooks();
  assert.deepEqual(books.map((b) => b.slug), ['tidewater-one', 'tidewater-two', 'lantern-hill']);
  assert.deepEqual(books.map((b) => b.series_number), [1, 2, null]);
  assert.equal(books[0].series, 'tidewater');
  assert.equal(books[1].series, 'tidewater');
  assert.equal(books[2].series, null);
  for (const b of books) assert.equal(b.scene_count, 2);
});

test('spec-example: diagnostics surfaced and counts match', async () => {
  const repo = createFsRepository(await copyFixture('valid/spec-example'));
  const expected = await readExpected('valid/spec-example');
  const diags = await repo.getDiagnostics();
  assert.equal(diags.length, 4);
  assert.deepEqual(diags.map((d) => d.code).sort(), expected.diagnostics.map((d) => d.code).sort());
  const [b] = await repo.listBooks();
  assert.equal(b.scene_count, expected.order.length);
  assert.equal(b.error_count, 0);
  assert.equal(b.warning_count, diags.filter((d) => d.code.startsWith('W')).length);
  assert.equal((await repo.getDiagnostics(b.id)).length, 4);
});

test('invalid E204 fixture: does not throw, reports errors', async () => {
  const repo = createFsRepository(await copyFixture('invalid/E204-duplicate-sequence'));
  const diags = await repo.getDiagnostics();
  assert.ok(diags.filter((d) => d.code === 'E204').length >= 2);
  const books = await repo.listBooks();
  assert.equal(books.length, 1);
  assert.ok(books[0].error_count >= 2);
  await repo.libraryInfo();
});

test('read-only: library is byte-identical after calling every method', async () => {
  for (const fx of ['valid/salt-orchard', 'valid/library', 'valid/spec-example', 'invalid/E204-duplicate-sequence']) {
    const root = await copyFixture(fx);
    const repo = createFsRepository(root);
    const before = await snapshot(root);
    await repo.libraryInfo();
    const books = await repo.listBooks();
    await repo.getDiagnostics();
    for (const b of books) {
      const detail = await repo.getBook(b.id);
      await repo.getDiagnostics(b.id);
      for (const s of allScenes(detail)) await repo.getScene(b.id, s.id);
    }
    await repo.getBook('book_NOPE');
    await repo.getScene('book_NOPE', 'scene_NOPE');
    assert.deepEqual(await snapshot(root), before, fx);
  }
});
