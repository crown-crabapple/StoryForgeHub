// POST /api/books/:b/title, POST /api/series, POST /api/books/:b/move-to-series on a copy of the `valid/covers` library.
// (Shared-mode refusal for non-owners is swept by shared-mode.test.mjs and m07-proof.test.mjs, which list all three routes as admin.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request } from './helpers.mjs';

const NORTH = 'book_01V30000000000000000000011';
const FIRST_LIGHT = 'book_01V30000000000000000000003';
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
const repos = [];
after(async () => {
  for (const s of servers) await close(s);
  for (const r of repos) await r.close();
});

async function fresh() {
  const root = await copyFixture('valid/covers');
  const repository = createFsRepository(root, { watch: false });
  repos.push(repository);
  const server = createServer({ repository });
  servers.push(server);
  const port = await listen(server);
  return { root, port, repository };
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { Host: `127.0.0.1:${port}`, ...GOOD, 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST /books/:b/title: 200 changes only the title line; the library list shows it', async () => {
  const { root, port } = await fresh();
  const file = path.join(root, 'north-road', 'book.md');
  const before = await fs.readFile(file, 'utf8');
  const r = await post(port, `/api/books/${NORTH}/title`, { title: 'The Long Road' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, title: 'The Long Road' });
  assert.equal(await fs.readFile(file, 'utf8'), before.replace('title: North Road', 'title: The Long Road'));
  const lib = await request(port, 'GET', '/api/library');
  assert.equal(lib.status, 200);
  const books = (await request(port, 'GET', '/api/books')).json;
  assert.equal((books.books ?? books).find((b) => b.id === NORTH).title, 'The Long Road');
});

test('POST /books/:b/title: 400 BAD_TITLE, 404 unknown book, 409 stale base_sha256, 400 on a non-string title', async () => {
  const { port } = await fresh();
  const bad = await post(port, `/api/books/${NORTH}/title`, { title: '   ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_TITLE');
  assert.equal(bad.json.field, 'title');
  assert.equal((await post(port, `/api/books/${NORTH}/title`, { title: 5 })).status, 400);
  assert.equal((await post(port, '/api/books/book_01V3000000000000000000ZZZZ/title', { title: 'X' })).status, 404);
  const stale = await post(port, `/api/books/${NORTH}/title`, { title: 'X', base_sha256: 'a'.repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
});

test('POST /series: 201 creates a series the library lists; refusals are 400 and 409', async () => {
  const { root, port } = await fresh();
  const r = await post(port, '/api/series', { title: 'Salt Trilogy' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.slug, 'salt-trilogy');
  assert.equal(r.json.path, 'salt-trilogy');
  assert.match(r.json.seriesId, /^series_/);
  assert.match(await fs.readFile(path.join(root, 'salt-trilogy', 'series.md'), 'utf8'), /^status: active$/m);
  const lib = (await request(port, 'GET', '/api/library')).json;
  assert.ok(lib.series.some((s) => s.slug === 'salt-trilogy' && s.title === 'Salt Trilogy' && s.status === 'active'));

  const dup = await post(port, '/api/series', { title: 'Salt Trilogy' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'SLUG_TAKEN');
  assert.equal(dup.json.field, 'slug');
  await fs.mkdir(path.join(root, 'plain-folder'));
  assert.equal((await post(port, '/api/series', { title: 'P', slug: 'plain-folder' })).json.code, 'FOLDER_EXISTS');
  assert.equal((await post(port, '/api/series', { title: 'P', slug: 'plain-folder' })).status, 409);
  const noTitle = await post(port, '/api/series', {});
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.json.code, 'BAD_TITLE');
  assert.equal((await post(port, '/api/series', { title: 'Q', slug: 'Bad Slug' })).status, 400);
  assert.equal((await post(port, '/api/series', { title: 'Q', status: 'nope' })).status, 400);
});

test('POST /books/:b/move-to-series: 200 moves a standalone book; refusals map to 400 / 404 / 409', async () => {
  const { root, port } = await fresh();
  const ok = await post(port, `/api/books/${NORTH}/move-to-series`, { seriesSlug: 'harbour-lights' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.path, 'harbour-lights/north-road');
  assert.equal(ok.json.from, 'north-road');
  assert.equal(ok.json.seriesNumber, 3);
  assert.equal(await fs.stat(path.join(root, 'north-road')).then(() => true, () => false), false);

  const again = await post(port, `/api/books/${NORTH}/move-to-series`, { seriesSlug: 'harbour-lights' });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, 'ALREADY_IN_SERIES');
  assert.equal((await post(port, `/api/books/${FIRST_LIGHT}/move-to-series`, { seriesSlug: 'harbour-lights' })).json.code, 'ALREADY_IN_SERIES');

  const lost = (await request(port, 'GET', '/api/books')).json;
  const lostId = (lost.books ?? lost).find((b) => b.path === 'lost-cover').id;
  const nos = await post(port, `/api/books/${lostId}/move-to-series`, { seriesSlug: 'no-such' });
  assert.equal(nos.status, 400);
  assert.equal(nos.json.code, 'NO_SUCH_SERIES');
  const taken = await post(port, `/api/books/${lostId}/move-to-series`, { seriesSlug: 'harbour-lights', seriesNumber: 1 });
  assert.equal(taken.status, 400);
  assert.equal(taken.json.code, 'SERIES_NUMBER_TAKEN');
  assert.equal((await post(port, `/api/books/${lostId}/move-to-series`, {})).status, 400);
  assert.equal((await post(port, '/api/books/book_01V3000000000000000000ZZZZ/move-to-series', { seriesSlug: 'harbour-lights' })).status, 404);
});

test('a series made over HTTP takes a moved book, and the library lists both', async () => {
  const { port } = await fresh();
  assert.equal((await post(port, '/api/series', { title: 'New Cycle', slug: 'cycle' })).status, 201);
  const moved = await post(port, `/api/books/${NORTH}/move-to-series`, { seriesSlug: 'cycle', seriesNumber: 4 });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.seriesNumber, 4);
  const lib = (await request(port, 'GET', '/api/library')).json;
  assert.equal(lib.series.find((s) => s.slug === 'cycle').book_ids.length, 1);
});
