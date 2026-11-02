// M04-J02: GET /api/books/:b/entries/:id/image serves an entry's `image` only when it is a supported image under assets/
// (same safety rules as the M02 cover route), and the Codex list's `image_url` is set only for a servable image.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen } from './helpers.mjs';

const BOOK = 'book_01CG0000000000000000000001';
const ENTRY = {
  maren: ['entry_01CG0000000000000000000005', 'codex/characters/maren-hollis.md'],
  tobin: ['entry_01CG0000000000000000000006', 'codex/characters/tobin-reyes.md'],
  port: ['entry_01CG0000000000000000000007', 'codex/locations/port-aldine.md'],
  board: ['entry_01CG0000000000000000000008', 'codex/factions/harbour-board.md'],
  key: ['entry_01CG0000000000000000000009', 'codex/objects/brass-key.md'],
  gull: ['entry_01CG000000000000000000000B', 'codex/ships/the-gull.md'],
  salt: ['entry_01CG000000000000000000000A', 'codex/lore/saltmarks.md'],
  tide: ['entry_01CG000000000000000000000C', 'codex/spells/tide-call.md'],
};
const url = (key) => `/api/books/${BOOK}/entries/${ENTRY[key][0]}/image`;
const SECRET = 'SECRET-OUTSIDE-BYTES';

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

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

/** Copy codex-graph, set `image:` on the named entries ({ key: value }), start a server. */
async function setup(images, { prep } = {}) {
  const root = await copyFixture('valid/codex-graph');
  for (const [key, value] of Object.entries(images)) {
    const f = path.join(root, ...ENTRY[key][1].split('/'));
    const t = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, t.replace(/\nstatus: canon\n/, `\nstatus: canon\nimage: ${value}\n`));
  }
  if (prep) await prep(root);
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: createFsRepository(root), webRoot });
  servers.push(server);
  return { root, port: await listen(server) };
}
const list = async (port) => (await get(port, `/api/books/${BOOK}/codex/entries`)).json.entries;
const imageUrlOf = (entries, key) => entries.find((e) => e.id === ENTRY[key][0]).image_url;

test('each allowed extension is served with its bytes, content-type and nosniff', async () => {
  const types = { maren: ['a.png', 'image/png'], tobin: ['a.jpg', 'image/jpeg'], port: ['a.jpeg', 'image/jpeg'], board: ['a.webp', 'image/webp'], key: ['a.gif', 'image/gif'], gull: ['a.PNG', 'image/png'] };
  const { root, port } = await setup(Object.fromEntries(Object.entries(types).map(([k, [f]]) => [k, `assets/${f}`])), {
    prep: async (r) => {
      await fs.mkdir(path.join(r, 'assets'), { recursive: true });
      for (const [k, [f]] of Object.entries(types)) await fs.writeFile(path.join(r, 'assets', f), Buffer.from([1, 2, 3, 4, k.length]));
    },
  });
  for (const [k, [f, type]] of Object.entries(types)) {
    const r = await get(port, url(k));
    assert.equal(r.status, 200, f);
    assert.equal(r.headers['content-type'], type, f);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', f);
    assert.ok(r.body.equals(await fs.readFile(path.join(root, 'assets', f))), `${f} bytes`);
  }
});

test('image_url is set for a servable image, and that url serves it', async () => {
  const { port } = await setup({ maren: 'assets/m.png' }, { prep: async (r) => { await fs.mkdir(path.join(r, 'assets')); await fs.writeFile(path.join(r, 'assets', 'm.png'), Buffer.from([9, 8, 7])); } });
  const entries = await list(port);
  const u = imageUrlOf(entries, 'maren');
  assert.equal(typeof u, 'string');
  const r = await get(port, u);
  assert.equal(r.status, 200);
  assert.deepEqual([...r.body], [9, 8, 7]);
  assert.equal(imageUrlOf(entries, 'tobin'), null, 'an entry with no image has no image_url');
});

test('svg, outside the book, absolute, not under assets/, a .. segment, missing: 404, no content leaked, no image_url', async () => {
  const abs = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
  const { port } = await setup(
    { maren: 'assets/x.svg', tobin: '../secret.png', port: abs, board: 'codex/pic.png', key: 'assets/../secret.png', gull: 'assets/missing.png', salt: '../../secret.png' },
    {
      prep: async (r) => {
        await fs.mkdir(path.join(r, 'assets'), { recursive: true });
        await fs.writeFile(path.join(r, 'assets', 'x.svg'), '<svg>SECRET-SVG</svg>');
        await fs.writeFile(path.join(r, 'codex', 'pic.png'), 'SECRET-NOT-IN-ASSETS');
        await fs.writeFile(path.join(path.dirname(r), 'secret.png'), SECRET);
        await fs.writeFile(path.join(r, 'secret.png'), SECRET);
      },
    },
  );
  const entries = await list(port);
  for (const k of ['maren', 'tobin', 'port', 'board', 'key', 'gull', 'salt']) {
    const r = await get(port, url(k));
    assert.equal(r.status, 404, k);
    assert.ok(!/^image\//.test(r.headers['content-type'] ?? ''), k);
    assert.ok(!r.body.toString().includes('SECRET'), `${k} leaked`);
    assert.equal(imageUrlOf(entries, k), null, `${k}: image_url only when the image is servable`);
  }
  assert.equal((await get(port, `${url('maren')}?v=00000000`)).status, 404, 'svg is never served, whatever ?v= says');
});

test('a symlink under assets/ pointing outside the book is not followed', async (t) => {
  let linked = true;
  const { port } = await setup({ maren: 'assets/link.png' }, {
    prep: async (r) => {
      await fs.mkdir(path.join(r, 'assets'), { recursive: true });
      await fs.writeFile(path.join(r, 'secret.png'), SECRET);
      try {
        await fs.symlink(path.join(r, 'secret.png'), path.join(r, 'assets', 'link.png'));
      } catch {
        linked = false;
      }
    },
  });
  if (!linked) {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  const r = await get(port, url('maren'));
  assert.equal(r.status, 404);
  assert.ok(!r.body.toString().includes('SECRET'));
  assert.equal(imageUrlOf(await list(port), 'maren'), null);
});

test('an image over 10 MB is 404 error:too_large', async () => {
  const { port } = await setup({ maren: 'assets/big.png' }, { prep: async (r) => { await fs.mkdir(path.join(r, 'assets')); await fs.writeFile(path.join(r, 'assets', 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1)); } });
  const r = await get(port, url('maren'));
  assert.equal(r.status, 404);
  assert.equal(r.json?.error, 'too_large');
});

test('unknown entry, unknown book, an entry without an image: 404', async () => {
  const { port } = await setup({});
  assert.equal((await get(port, `/api/books/${BOOK}/entries/entry_01CG00000000000000000000ZZ/image`)).status, 404);
  assert.equal((await get(port, `/api/books/book_00000000000000000000000000/entries/${ENTRY.maren[0]}/image`)).status, 404);
  assert.equal((await get(port, url('maren'))).status, 404);
});
