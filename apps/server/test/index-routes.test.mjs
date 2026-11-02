import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const MAREN = 'entry_01S5000000000000000000000G';
const PORT_ALDINE = 'entry_01S5000000000000000000000N';
const TOBIN = 'entry_01S5000000000000000000000J';
const LOWTIDE = 'scene_01S50000000000000000000008';
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh({ build = true } = {}) {
  const root = await copyFixture('valid/salt-orchard');
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repository = createFsRepository(root);
  if (build) await repository.rebuildIndex(BOOK);
  const server = createServer({ repository, webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port, repository };
}

function post(port, pathname, { headers = GOOD, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname, headers: h }, (res) => {
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const rowsOf = (j) => (Array.isArray(j) ? j : j?.results ?? j?.rows ?? j?.links ?? j?.mentions ?? []);
const enc = encodeURIComponent;

test('GET /api/search returns ranked results with id, kind, title, path and snippet', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', '/api/search?q=cafe');
  assert.equal(r.status, 200, r.text);
  const rows = rowsOf(r.json);
  const hit = rows.find((x) => x.id === LOWTIDE);
  assert.ok(hit, r.text);
  assert.equal(hit.kind, 'scene');
  assert.equal(hit.title, 'Low Tide');
  assert.equal(typeof hit.path, 'string');
  assert.equal(typeof hit.snippet, 'string');
  assert.ok(!r.headers['content-type'] || r.headers['content-type'].startsWith('application/json'));
});

test('GET /api/search honours book, kinds and limit', async () => {
  const { port } = await fresh();
  const scoped = rowsOf((await request(port, 'GET', `/api/search?q=cafe&book=${BOOK}`)).json);
  assert.ok(scoped.some((x) => x.id === LOWTIDE));
  const entries = await request(port, 'GET', '/api/search?q=cafe&kinds=entry');
  assert.equal(entries.status, 200);
  assert.ok(rowsOf(entries.json).length > 0 && rowsOf(entries.json).every((x) => x.kind === 'entry'));
  const both = await request(port, 'GET', '/api/search?q=grafting&kinds=scene,entry');
  assert.ok(rowsOf(both.json).every((x) => x.kind === 'scene' || x.kind === 'entry'));
  const one = await request(port, 'GET', '/api/search?q=grafting&limit=1');
  assert.equal(rowsOf(one.json).length, 1);
});

test('GET /api/search validates q: missing, empty and over 200 chars are 400; 1 and 200 chars are fine', async () => {
  const { port } = await fresh();
  for (const p of ['/api/search', '/api/search?q=', `/api/search?q=${'a'.repeat(201)}`, '/api/search?book=' + BOOK]) {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 400, `${p.slice(0, 40)} -> ${r.status}`);
    assert.ok(r.json && typeof r.json.error === 'string', 'JSON error body');
  }
  assert.equal((await request(port, 'GET', '/api/search?q=a')).status, 200);
  assert.equal((await request(port, 'GET', `/api/search?q=${'a'.repeat(200)}`)).status, 200);
});

test('GET /api/search treats FTS syntax as plain text (never a 500)', async () => {
  const { port } = await fresh();
  for (const q of ['"a" OR b*', 'NEAR(', ':', '"', 'title:key', '*']) {
    const r = await request(port, 'GET', `/api/search?q=${enc(q)}`);
    assert.equal(r.status, 200, `${q} -> ${r.status} ${r.text}`);
    assert.ok(Array.isArray(rowsOf(r.json)));
  }
});

test('GET /api/search answers even before an index exists', async () => {
  const { port } = await fresh({ build: false });
  const r = await request(port, 'GET', '/api/search?q=cafe');
  assert.equal(r.status, 200, r.text);
});

test('GET /api/books/:b/backlinks/:id lists the sources linking to an object', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', `/api/books/${BOOK}/backlinks/${PORT_ALDINE}`);
  assert.equal(r.status, 200, r.text);
  const rows = rowsOf(r.json);
  const sources = rows.map((x) => x.src_id);
  assert.ok(sources.includes(MAREN) && sources.includes(TOBIN), r.text);
  const none = await request(port, 'GET', `/api/books/${BOOK}/backlinks/entry_00000000000000000000000000`);
  assert.equal(none.status, 200);
  assert.deepEqual(rowsOf(none.json), []);
});

test('GET /api/books/:b/mentions filters by entry and by scene', async () => {
  const { port, repository } = await fresh();
  const byEntry = await request(port, 'GET', `/api/books/${BOOK}/mentions?entry=${MAREN}`);
  assert.equal(byEntry.status, 200, byEntry.text);
  const rows = rowsOf(byEntry.json);
  assert.ok(rows.every((x) => x.entry_id === MAREN));
  assert.deepEqual(rows, rowsOf(JSON.parse(JSON.stringify(await repository.getMentions(BOOK, { entryId: MAREN })))));

  const all = await request(port, 'GET', `/api/books/${BOOK}/mentions`);
  assert.equal(all.status, 200);
  assert.ok(rowsOf(all.json).length >= rows.length);

  if (rows.length > 0) {
    const sceneId = rows[0].scene_id;
    const byScene = await request(port, 'GET', `/api/books/${BOOK}/mentions?scene=${sceneId}`);
    assert.ok(rowsOf(byScene.json).length > 0 && rowsOf(byScene.json).every((x) => x.scene_id === sceneId));
  }
});

test('GET /api/index/status reports every book', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', '/api/index/status');
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /fresh/);
  assert.ok(r.text.includes(BOOK) || Array.isArray(r.json) || typeof r.json === 'object');

  const { port: p2 } = await fresh({ build: false });
  const missing = await request(p2, 'GET', '/api/index/status');
  assert.equal(missing.status, 200);
  assert.match(missing.text, /missing|building|stale/);
});

test('POST /api/index/rebuild is write-guarded: 403 without the header, 200 with it', async () => {
  const { port, root } = await fresh({ build: false });
  const dbFile = path.join(root, '.storyforge', 'index.sqlite');

  const noHeader = await post(port, '/api/index/rebuild', { headers: { 'content-type': 'application/json' }, body: {} });
  assert.equal(noHeader.status, 403);
  await assert.rejects(fs.access(dbFile), 'a rejected request builds nothing');

  const noType = await post(port, '/api/index/rebuild', { headers: { 'x-storyforge': '1' }, body: {} });
  assert.equal(noType.status, 403);

  const ok = await post(port, '/api/index/rebuild', { body: {} });
  assert.equal(ok.status, 200, ok.text);
  await fs.access(dbFile);
  const status = await request(port, 'GET', '/api/index/status');
  assert.match(status.text, /fresh/);
});

test('POST /api/index/rebuild with a book id rebuilds that book only; GET is not allowed', async () => {
  const { port } = await fresh({ build: false });
  const ok = await post(port, '/api/index/rebuild', { body: { book: BOOK } });
  assert.equal(ok.status, 200, ok.text);
  const bad = await post(port, '/api/index/rebuild', { body: [] });
  assert.equal(bad.status, 400);
  const get = await request(port, 'GET', '/api/index/rebuild');
  assert.ok([404, 405].includes(get.status), `GET rebuild -> ${get.status}`);
});
