import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, readExpected, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const SCENE = 'scene_01S50000000000000000000001';
const JSON_CT = 'application/json; charset=utf-8';

let libRoot, outer, webRoot, server, port, expected, before0;
const SECRET = 'TOP-SECRET-OUTSIDE-WEBROOT';

before(async () => {
  libRoot = await copyFixture('valid/salt-orchard');
  expected = await readExpected('valid/salt-orchard');
  outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  await fs.writeFile(path.join(webRoot, 'a.js'), 'console.log("a");');
  await fs.writeFile(path.join(outer, 'secret.txt'), SECRET);
  await fs.writeFile(path.join(outer, 'package.json'), `{"name":"${SECRET}"}`);
  server = createServer({ repository: createFsRepository(libRoot), webRoot });
  port = await listen(server);
  before0 = await snapshot(libRoot, { skipStoryforge: true });
});

after(async () => {
  await close(server);
});

test('GET /api/health', async () => {
  const r = await request(port, 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.version, 'string');
  assert.ok('library' in r.json);
});

test('GET /api/library', async () => {
  const r = await request(port, 'GET', '/api/library');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.equal(typeof r.json.root, 'string');
  assert.ok(Array.isArray(r.json.diagnostics));
  assert.ok('title' in r.json);
});

test('GET /api/books', async () => {
  const r = await request(port, 'GET', '/api/books');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.ok(Array.isArray(r.json));
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].id, BOOK);
  assert.equal(r.json[0].title, 'The Salt Orchard');
  assert.equal(r.json[0].scene_count, 7);
});

test('GET /api/books/:id returns scenes in expected.json order', async () => {
  const r = await request(port, 'GET', `/api/books/${BOOK}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  const ids = r.json.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
  assert.deepEqual(ids, expected.order);
  assert.deepEqual(r.json.acts[0].chapters.map((c) => c.label), ['Prologue', 'Chapter One', 'Chapter Two']);
  assert.equal(r.json.excluded.length, 2);
});

test('GET /api/books/:id unknown -> 404 not_found', async () => {
  const r = await request(port, 'GET', '/api/books/book_NOPE');
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.deepEqual(r.json, { error: 'not_found' });
});

test('GET scene returns SceneDoc', async () => {
  const r = await request(port, 'GET', `/api/books/${BOOK}/scenes/${SCENE}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.equal(r.json.id, SCENE);
  assert.equal(r.json.title, 'Before the Tide');
  assert.equal(typeof r.json.body, 'string');
  assert.ok(r.json.body.includes('潮が引く、そして戻る'));
  assert.equal(r.json.front_matter.id, SCENE);
});

test('GET scene: unknown scene or unknown book -> 404', async () => {
  for (const p of [`/api/books/${BOOK}/scenes/scene_NOPE`, `/api/books/book_NOPE/scenes/${SCENE}`]) {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'not_found' }, p);
  }
});

test('GET diagnostics', async () => {
  const r = await request(port, 'GET', `/api/books/${BOOK}/diagnostics`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_CT);
  assert.deepEqual(r.json, expected.diagnostics);
});

test('non-GET methods -> 405 read_only', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const p of ['/api/books', `/api/books/${BOOK}`, `/api/books/${BOOK}/scenes/${SCENE}`, '/', '/a.js']) {
      const r = await request(port, method, p);
      assert.equal(r.status, 405, `${method} ${p}`);
      assert.deepEqual(r.json, { error: 'read_only' }, `${method} ${p}`);
    }
  }
});

test('Host header guard: evil host -> 403', async () => {
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', 'localhost']) {
    for (const p of ['/api/health', '/', '/api/books']) {
      const r = await request(port, 'GET', p, { host });
      assert.equal(r.status, 403, `${host} ${p}`);
    }
  }
});

test('Host header guard: localhost:<port> and 127.0.0.1:<port> are accepted', async () => {
  assert.equal((await request(port, 'GET', '/api/health', { host: `localhost:${port}` })).status, 200);
  assert.equal((await request(port, 'GET', '/api/health', { host: `127.0.0.1:${port}` })).status, 200);
});

test('static: /a.js served', async () => {
  const r = await request(port, 'GET', '/a.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.equal(r.text, 'console.log("a");');
});

test('static: / serves index.html', async () => {
  const r = await request(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /<title>SPA<\/title>/);
});

test('static: SPA fallback for client routes', async () => {
  for (const p of ['/books/x', `/books/${BOOK}`]) {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /text\/html/, p);
    assert.match(r.text, /<title>SPA<\/title>/, p);
  }
});

test('static: path traversal -> 404, never outside webRoot', async () => {
  for (const p of [
    '/..%2f..%2fpackage.json',
    '/%2e%2e/secret.txt',
    '/%2e%2e/%2e%2e/package.json',
    '/../secret.txt',
    '/..%5csecret.txt',
    '/a.js/../../secret.txt',
    '/%2e%2e%2fsecret.txt',
  ]) {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes(SECRET), p);
  }
});

test('read-only: library byte-identical after hitting every route', async () => {
  const paths = [
    '/api/health', '/api/library', '/api/books', `/api/books/${BOOK}`, '/api/books/book_NOPE',
    `/api/books/${BOOK}/scenes/${SCENE}`, `/api/books/${BOOK}/scenes/scene_NOPE`,
    `/api/books/${BOOK}/diagnostics`, '/', '/a.js', '/books/x',
  ];
  for (const p of paths) await request(port, 'GET', p);
  for (const m of ['POST', 'PUT', 'DELETE']) await request(port, m, `/api/books/${BOOK}`);
  // Reads may build the index under .storyforge/ (J03 rule 5); nothing else may change.
  const afterSnap = await snapshot(libRoot, { skipStoryforge: true });
  assert.deepEqual(Object.keys(afterSnap).sort(), Object.keys(before0).sort(), 'nothing outside .storyforge/ created or removed');
  assert.deepEqual(afterSnap, before0);
});
