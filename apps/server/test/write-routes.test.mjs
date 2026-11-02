import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const SCENE = 'scene_01S50000000000000000000002';
const ARCHIVE_SCENE = 'scene_01S50000000000000000000009';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh() {
  const root = await copyFixture('valid/salt-orchard');
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: createFsRepository(root), webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port };
}

/** Raw request with a body, custom headers and Host. */
function send(port, method, pathname, { headers = GOOD, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const bodyUrl = (id = SCENE) => `/api/books/${BOOK}/scenes/${id}/body`;
const getScene = async (port, id = SCENE) => (await request(port, 'GET', `/api/books/${BOOK}/scenes/${id}`)).json;

test('PUT body: 200 with the new sha256; file holds the new body', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const r = await send(port, 'PUT', bodyUrl(), { body: { body: 'Hello from HTTP\n', base_sha256: scene.sha256 } });
  assert.equal(r.status, 200, r.text);
  const bytes = await fs.readFile(path.join(root, scene.path));
  assert.equal(r.json.sha256, sha(bytes));
  assert.ok(bytes.toString('utf8').endsWith('\nHello from HTTP\n'));
  assert.equal((await getScene(port)).body, 'Hello from HTTP\n');
});

test('PUT body accepts a content-type with a charset parameter', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const r = await send(port, 'PUT', bodyUrl(), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-storyforge': '1' },
    body: { body: 'x\n', base_sha256: scene.sha256 },
  });
  assert.equal(r.status, 200, r.text);
});

test('PUT body after an external edit: 409 conflict with current; disk keeps the external version', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port); // sha A
  const file = path.join(root, scene.path);
  const text = await fs.readFile(file, 'utf8');
  const external = Buffer.from(text.slice(0, text.indexOf('\n---\n', 3) + 5) + 'external edit\n');
  await fs.writeFile(file, external); // sha B

  const r = await send(port, 'PUT', bodyUrl(), { body: { body: 'stale\n', base_sha256: scene.sha256 } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, 'conflict');
  assert.equal(r.json.current.sha256, sha(external));
  assert.equal(r.json.current.body, 'external edit\n');
  assert.equal(Buffer.compare(await fs.readFile(file), external), 0);
});

test('PUT body: unknown scene 404, malformed JSON 400', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root);
  const nf = await send(port, 'PUT', bodyUrl('scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), { body: { body: 'x', base_sha256: 'a'.repeat(64) } });
  assert.equal(nf.status, 404);
  const bad = await send(port, 'PUT', bodyUrl(), { body: '{not json' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await snapshot(root), before);
});

test('POST scene: 201 with id and path; scene appears after its anchor', async () => {
  const { root, port } = await fresh();
  const r = await send(port, 'POST', `/api/books/${BOOK}/scenes`, {
    body: { chapter: 1, after: SCENE, title: 'Via HTTP', slug: 'via-http', body: 'new prose\n' },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(typeof r.json.id, 'string');
  assert.equal(typeof r.json.path, 'string');
  assert.equal((await fs.readFile(path.join(root, r.json.path), 'utf8')).endsWith('\nnew prose\n'), true);
  const book = (await request(port, 'GET', `/api/books/${BOOK}`)).json;
  const ids = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).map((s) => s.id);
  assert.equal(ids[ids.indexOf(SCENE) + 1], r.json.id);
});

test('POST scene with bad arguments: 400 or 409 with a code, nothing written', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root);
  const r = await send(port, 'POST', `/api/books/${BOOK}/scenes`, {
    body: { chapter: 1, after: 'scene_nope', title: 'X', slug: 'x', body: '' },
  });
  assert.ok([400, 409].includes(r.status), r.text);
  assert.equal(typeof r.json.code, 'string');
  assert.deepEqual(await snapshot(root), before);
});

test('POST archive then restore: 200 with path each time, bytes identical', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port, ARCHIVE_SCENE);
  const original = await fs.readFile(path.join(root, scene.path));

  const a = await send(port, 'POST', `/api/books/${BOOK}/scenes/${ARCHIVE_SCENE}/archive`, { body: { base_sha256: scene.sha256 } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.path, `archive/${scene.path}`);
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, a.json.path)), original), 0);
  assert.equal((await request(port, 'GET', `/api/books/${BOOK}/scenes/${ARCHIVE_SCENE}`)).status, 404);

  const r = await send(port, 'POST', `/api/books/${BOOK}/archive/restore`, { body: { path: a.json.path, base_sha256: sha(original) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, scene.path);
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, scene.path)), original), 0);
});

test('POST archive after an external edit: 409, nothing archived', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port, ARCHIVE_SCENE);
  const file = path.join(root, scene.path);
  const external = Buffer.from((await fs.readFile(file, 'utf8')) + '\nexternal\n');
  await fs.writeFile(file, external);
  const r = await send(port, 'POST', `/api/books/${BOOK}/scenes/${ARCHIVE_SCENE}/archive`, { body: { base_sha256: scene.sha256 } });
  assert.equal(r.status, 409, r.text);
  assert.equal(Buffer.compare(await fs.readFile(file), external), 0);
  await assert.rejects(fs.access(path.join(root, 'archive', scene.path)));
});

test('POST /api/recover: 200 report; GET /api/recover/last: 200', async () => {
  const { port } = await fresh();
  const r = await send(port, 'POST', '/api/recover', { body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json, 'object');
  const last = await request(port, 'GET', '/api/recover/last');
  assert.equal(last.status, 200, last.text);
});

// ---------------------------------------------------------------- guards (acceptance 7)

const WRITE_ROUTES = [
  ['PUT', bodyUrl(), { body: 'x\n', base_sha256: 'a'.repeat(64) }],
  ['POST', `/api/books/${BOOK}/scenes`, { chapter: 1, after: SCENE, title: 'G', slug: 'g', body: '' }],
  ['POST', `/api/books/${BOOK}/scenes/${SCENE}/archive`, { base_sha256: 'a'.repeat(64) }],
  ['POST', `/api/books/${BOOK}/archive/restore`, { path: 'archive/x.md', base_sha256: 'a'.repeat(64) }],
  ['POST', '/api/recover', {}],
];

for (const [method, url, payload] of WRITE_ROUTES) {
  test(`guards: ${method} ${url.replace(BOOK, ':b').replace(SCENE, ':s')} rejects missing header, wrong content-type and foreign Host with 403`, async () => {
    const { root, port } = await fresh();
    const before = await snapshot(root);

    const noHeader = await send(port, method, url, { headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(noHeader.json, { error: 'forbidden' });

    const wrongType = await send(port, method, url, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body: payload });
    assert.equal(wrongType.status, 403);
    assert.deepEqual(wrongType.json, { error: 'forbidden' });

    const noType = await send(port, method, url, { headers: { 'x-storyforge': '1' }, body: JSON.stringify(payload) });
    assert.equal(noType.status, 403);

    const evil = await send(port, method, url, { host: 'evil.example', body: payload });
    assert.equal(evil.status, 403);
    assert.deepEqual(evil.json, { error: 'forbidden' });

    assert.deepEqual(await snapshot(root), before, 'rejected writes change nothing');
    for (const r of [noHeader, wrongType, noType, evil]) {
      assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS headers are ever sent');
    }
  });
}

test('guards: a 6 MB body is rejected with 413 and nothing is written', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const before = await snapshot(root);
  const big = JSON.stringify({ body: 'a'.repeat(6 * 1024 * 1024), base_sha256: scene.sha256 });
  const r = await send(port, 'PUT', bodyUrl(), { body: big });
  assert.equal(r.status, 413);
  assert.deepEqual(await snapshot(root), before);
});

test('guards: GET routes still work without the x-storyforge header', async () => {
  const { port } = await fresh();
  for (const url of ['/api/health', '/api/books', `/api/books/${BOOK}`, `/api/books/${BOOK}/scenes/${SCENE}`, '/']) {
    const r = await request(port, 'GET', url);
    assert.equal(r.status, 200, url);
  }
});

test('other methods and paths stay 405 (DELETE, PATCH on API routes)', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root);
  for (const method of ['DELETE', 'PATCH']) {
    for (const url of [bodyUrl(), `/api/books/${BOOK}`, '/api/health']) {
      const r = await send(port, method, url, { body: {} });
      assert.equal(r.status, 405, `${method} ${url}`);
    }
  }
  assert.deepEqual(await snapshot(root), before);
});
