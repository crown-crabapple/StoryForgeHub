// M02-J02 acceptance 4: GET /api/books/:b/cover.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, FIXTURES, listen } from './helpers.mjs';

const ID = {
  'first-light': 'book_01V30000000000000000000003',
  'second-light': 'book_01V30000000000000000000007',
  'north-road': 'book_01V30000000000000000000011',
  'old-draft': 'book_01V30000000000000000000015',
  'lost-cover': 'book_01V30000000000000000000019',
  'svg-cover': 'book_01V30000000000000000000023',
};
const PNG_PATH = path.join(FIXTURES, 'valid/covers/harbour-lights/first-light/assets/cover.png');

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function start(root) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repository = createFsRepository(root);
  const server = createServer({ repository, webRoot });
  servers.push(server);
  return { port: await listen(server), repository };
}

/** Raw request that keeps the body as bytes (the shared helper decodes to text). */
function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(body.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('image cover: bytes, content-type, nosniff', async () => {
  const { port } = await start(await copyFixture('valid/covers'));
  const png = await fs.readFile(PNG_PATH);
  const r = await get(port, `/api/books/${ID['first-light']}/cover`);
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(png), 'bytes are the file bytes');
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('?v= matching the current sha is immutable; a stale or missing v is no-cache', async () => {
  const { port } = await start(await copyFixture('valid/covers'));
  const sha8 = createHash('sha256').update(await fs.readFile(PNG_PATH)).digest('hex').slice(0, 8);
  const url = `/api/books/${ID['first-light']}/cover`;
  const good = await get(port, `${url}?v=${sha8}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers['cache-control'], 'private, max-age=31536000, immutable');
  for (const q of ['', '?v=00000000', '?v=']) {
    const r = await get(port, url + q);
    assert.equal(r.status, 200, q);
    assert.equal(r.headers['cache-control'], 'no-cache', `"${q}"`);
  }
});

test('the url the library hands out is the url that serves the image', async () => {
  const { port, repository } = await start(await copyFixture('valid/covers'));
  const book = (await repository.listBooks()).find((b) => b.id === ID['first-light']);
  const r = await get(port, book.cover_url);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
});

test('404 for none, missing, unsupported cover states', async () => {
  const { port } = await start(await copyFixture('valid/covers'));
  for (const slug of ['second-light', 'north-road', 'old-draft', 'lost-cover', 'svg-cover']) {
    const r = await get(port, `/api/books/${ID[slug]}/cover`);
    assert.equal(r.status, 404, slug);
    assert.ok(!/^image\//.test(r.headers['content-type'] ?? ''), slug);
  }
});

test('the SVG file is never served, even with a matching ?v=', async () => {
  const { port } = await start(await copyFixture('valid/covers'));
  const svg = await fs.readFile(path.join(FIXTURES, 'valid/covers/svg-cover/assets/cover.svg'));
  const sha8 = createHash('sha256').update(svg).digest('hex').slice(0, 8);
  const r = await get(port, `/api/books/${ID['svg-cover']}/cover?v=${sha8}`);
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes('<svg'));
});

test('"outside" covers (escaping the book, or not under assets/) return 404 and never leak the file', async () => {
  const root = await copyFixture('valid/covers');
  await fs.writeFile(path.join(root, 'secret.png'), 'SECRET-OUTSIDE-BYTES');
  await fs.writeFile(path.join(root, 'old-draft', 'cover.png'), 'SECRET-NOT-IN-ASSETS');
  const edit = async (rel, line) => {
    const f = path.join(root, rel, 'book.md');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('profile: fiction', `profile: fiction\ncover: ${line}`));
  };
  await edit('north-road', '../secret.png');
  await edit('old-draft', 'cover.png');
  await edit('lost-cover', '../../../../etc/passwd.png');
  const { port } = await start(root);
  for (const slug of ['north-road', 'old-draft']) {
    const r = await get(port, `/api/books/${ID[slug]}/cover`);
    assert.equal(r.status, 404, slug);
    assert.ok(!r.body.toString().includes('SECRET'), slug);
  }
});

test('a symlink inside assets/ pointing outside the book is not followed', async (t) => {
  const root = await copyFixture('valid/covers');
  await fs.writeFile(path.join(root, 'secret.png'), 'SECRET-OUTSIDE-BYTES');
  const assets = path.join(root, 'north-road', 'assets');
  await fs.mkdir(assets);
  try {
    await fs.symlink(path.join(root, 'secret.png'), path.join(assets, 'link.png'));
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  const f = path.join(root, 'north-road', 'book.md');
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('profile: fiction', 'profile: fiction\ncover: assets/link.png'));
  const { port } = await start(root);
  const r = await get(port, `/api/books/${ID['north-road']}/cover`);
  assert.equal(r.status, 404);
  assert.ok(!r.body.toString().includes('SECRET'));
});

test('unknown book, malformed ids and traversal attempts are 404 with no file content', async () => {
  const { port } = await start(await copyFixture('valid/covers'));
  const paths = [
    '/api/books/book_00000000000000000000000000/cover',
    '/api/books/not-an-id/cover',
    '/api/books/..%2F..%2Fetc%2Fpasswd/cover',
    '/api/books/%2e%2e/cover',
    `/api/books/${ID['first-light']}/cover/extra`,
    `/api/books/${ID['first-light']}/assets/cover.png`,
  ];
  for (const p of paths) {
    const r = await get(port, p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!/^image\//.test(r.headers['content-type'] ?? ''), p);
  }
  assert.equal((await get(port, paths[0])).status, 404);
});

test('a cover over 10 MB is refused with 404 error:too_large', async () => {
  const root = await copyFixture('valid/covers');
  await fs.writeFile(path.join(root, 'harbour-lights', 'first-light', 'assets', 'cover.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  const { port } = await start(root);
  const r = await get(port, `/api/books/${ID['first-light']}/cover`);
  assert.equal(r.status, 404);
  assert.equal(r.json?.error, 'too_large');
});

test('each allowed extension maps to its content-type', async () => {
  const root = await copyFixture('valid/covers');
  const types = { 'a.jpg': 'image/jpeg', 'a.jpeg': 'image/jpeg', 'a.webp': 'image/webp', 'a.gif': 'image/gif', 'a.PNG': 'image/png' };
  const slugs = ['second-light', 'north-road', 'old-draft', 'lost-cover', 'svg-cover'];
  const entries = Object.entries(types);
  for (let i = 0; i < entries.length; i++) {
    const dir = path.join(root, slugs[i] === 'second-light' ? 'harbour-lights/second-light' : slugs[i]);
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', entries[i][0]), Buffer.from([1, 2, 3, 4]));
    const f = path.join(dir, 'book.md');
    const text = (await fs.readFile(f, 'utf8')).replace(/^cover: .*\n/m, '');
    await fs.writeFile(f, text.replace('profile: fiction', `profile: fiction\ncover: assets/${entries[i][0]}`));
  }
  const { port } = await start(root);
  for (let i = 0; i < entries.length; i++) {
    const r = await get(port, `/api/books/${ID[slugs[i]]}/cover`);
    assert.equal(r.status, 200, entries[i][0]);
    assert.equal(r.headers['content-type'], entries[i][1], entries[i][0]);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
});
