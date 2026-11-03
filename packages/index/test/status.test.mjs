import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFsRepository } from '../../core/src/index.mjs';
import {
  SALT_BOOK, SALT_LOWTIDE, SALT_LOWTIDE_ID, copyFixture, dbPathOf, openFor, plain,
} from './helpers.mjs';

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const countWords = (s) => s.split(/\s+/).filter(Boolean).length;

async function built() {
  const root = await copyFixture('valid/salt-orchard');
  const ctx = await openFor(root);
  assert.equal((await ctx.idx.rebuild()).ok, true);
  return { root, ...ctx };
}

test('status of a book with no index is "missing" and queries throw INDEX_NOT_READY', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { idx } = await openFor(root);
  const st = plain(await idx.status());
  assert.equal(st.state, 'missing');
  assert.deepEqual(st.stale_paths, []);
  await assert.rejects(Promise.resolve().then(() => idx.query.scenes()), (e) => e.code === 'INDEX_NOT_READY');
  await assert.rejects(Promise.resolve().then(() => idx.query.search('key')), (e) => e.code === 'INDEX_NOT_READY');
});

test('status after rebuild is fresh with schema_version, built_at and file_count', async () => {
  const { idx, root } = await built();
  const st = plain(await idx.status());
  assert.equal(st.state, 'fresh');
  assert.equal(st.schema_version, 3); // M07-J01 contract section 6: shared and external graph nodes
  assert.ok(st.built_at);
  assert.deepEqual(st.stale_paths, []);
  assert.ok(st.file_count >= 30, `file_count counts the book's .md files, got ${st.file_count}`);
  await fs.access(dbPathOf(root));
});

test('external write to a scene makes the index stale, naming that path; reads return the new text', async () => {
  const { idx, root } = await built();
  const repo = createFsRepository(root);
  const baseline = await repo.getScene(SALT_BOOK, SALT_LOWTIDE_ID);
  const bookBefore = await repo.getBook(SALT_BOOK);

  const file = abs(root, SALT_LOWTIDE);
  const original = await fs.readFile(file, 'utf8');
  const added = '\nA freshly written external paragraph with several additional words inside it.\n';
  await fs.writeFile(file, original + added, 'utf8');

  const st = plain(await idx.status());
  assert.equal(st.state, 'stale');
  assert.deepEqual(st.stale_paths, [SALT_LOWTIDE]);

  const scene = await repo.getScene(SALT_BOOK, SALT_LOWTIDE_ID);
  assert.ok(scene.body.includes('freshly written external paragraph'));
  assert.notEqual(scene.sha256, baseline.sha256);
  const book = await repo.getBook(SALT_BOOK);
  assert.equal(book.word_count, bookBefore.word_count + countWords(added));
});

test('touching a file without changing its bytes does not make the index stale', async () => {
  const { idx, root } = await built();
  const file = abs(root, SALT_LOWTIDE);
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(file, future, future);
  const st = plain(await idx.status());
  assert.equal(st.state, 'fresh');
  assert.deepEqual(st.stale_paths, []);
});

test('rewriting a file with identical bytes (new mtime) stays fresh', async () => {
  const { idx, root } = await built();
  const file = abs(root, SALT_LOWTIDE);
  const bytes = await fs.readFile(file);
  const future = new Date(Date.now() + 120_000);
  await fs.writeFile(file, bytes);
  await fs.utimes(file, future, future);
  assert.equal((await idx.status()).state, 'fresh');
});

test('an added or removed Markdown file makes the index stale', async () => {
  const { idx, root } = await built();
  await fs.writeFile(abs(root, 'research/added.md'), 'new file\n');
  let st = plain(await idx.status());
  assert.equal(st.state, 'stale');
  assert.ok(st.stale_paths.includes('research/added.md'));
  await fs.rm(abs(root, 'research/added.md'));
  assert.equal((await idx.status()).state, 'fresh');

  await fs.rm(abs(root, 'research/tidal-ranges.md'));
  st = plain(await idx.status());
  assert.equal(st.state, 'stale');
  assert.ok(st.stale_paths.includes('research/tidal-ranges.md'));
});

test('non-Markdown files and .storyforge contents do not affect freshness', async () => {
  const { idx, root } = await built();
  await fs.writeFile(abs(root, 'notes.txt'), 'not markdown');
  await fs.mkdir(abs(root, '.storyforge/trash'), { recursive: true });
  await fs.writeFile(abs(root, '.storyforge/trash/junk.md'), 'junk');
  assert.equal((await idx.status()).state, 'fresh');
});

test('garbage bytes in index.sqlite: status "error", reads fall back to files, rebuild replaces it', async () => {
  const { idx, root, dbPath } = await built();
  const repo = createFsRepository(root);
  const expectedBook = plain(await repo.getBook(SALT_BOOK));

  await fs.writeFile(dbPath, Buffer.from('this is definitely not a sqlite database '.repeat(50)));
  assert.equal((await idx.status()).state, 'error');
  await assert.rejects(Promise.resolve().then(() => idx.query.scenes()), (e) => e.code === 'INDEX_NOT_READY');

  const fresh = createFsRepository(root);
  assert.deepEqual(plain(await fresh.getBook(SALT_BOOK)), expectedBook);
  assert.equal((await fresh.getScene(SALT_BOOK, SALT_LOWTIDE_ID)).id, SALT_LOWTIDE_ID);
  assert.equal((await fresh.listBooks()).length, 1);

  const r = await idx.rebuild();
  assert.equal(r.ok, true);
  assert.equal((await idx.status()).state, 'fresh');
  const head = (await fs.readFile(dbPath)).subarray(0, 15).toString('latin1');
  assert.equal(head, 'SQLite format 3');
});

test('a zero-length index.sqlite is not trusted', async () => {
  const { idx, root, dbPath } = await built();
  await fs.writeFile(dbPath, Buffer.alloc(0));
  assert.notEqual((await idx.status()).state, 'fresh');
  assert.deepEqual(plain(await createFsRepository(root).listBooks()).map((b) => b.id), [SALT_BOOK]);
  assert.equal((await idx.rebuild()).ok, true);
  assert.equal((await idx.status()).state, 'fresh');
});

test('a different schema_version is not served; rebuild restores it', async () => {
  const { idx, root, dbPath } = await built();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();
  assert.notEqual((await idx.status()).state, 'fresh');
  await assert.rejects(Promise.resolve().then(() => idx.query.scenes()), (e) => e.code === 'INDEX_NOT_READY');
  const book = await createFsRepository(root).getBook(SALT_BOOK);
  assert.equal(book.id, SALT_BOOK);
  assert.equal((await idx.rebuild()).ok, true);
  const st = plain(await idx.status());
  assert.equal(st.state, 'fresh');
  assert.equal(st.schema_version, 3); // M07-J01 contract section 6: shared and external graph nodes
});
