// Canvases over the plugin API v1: read with 'read', every write needs the 'canvas' permission and changes only planning/canvases/<slug>.canvas.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const base = `/api/v1/books/${SLUG}/canvases`;
const file = (root, slug) => path.join(root, 'planning', 'canvases', `${slug}.canvas`);
const ZERO = '0'.repeat(64);
const card = (id) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 100, height: 60 });

async function withCanvas() {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'writer', permissions: ['read', 'canvas'] })).token;
  const ro = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const made = await t.plugin(rw, 'POST', base, { body: { title: 'Board' } });
  assert.equal(made.status, 201, made.text);
  return { t, rw, ro, made };
}

test('a read-only token lists and reads canvases; every canvas write is 403 PLUGIN_SCOPE', async () => {
  const { t, ro, made } = await withCanvas();
  assert.equal(made.json.slug, 'board');
  assert.equal(made.json.path, 'planning/canvases/board.canvas');
  assert.match(made.json.sha256, /^[0-9a-f]{64}$/);
  const list = await t.plugin(ro, 'GET', base);
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.canvases.map((c) => c.slug), ['board']);
  assert.deepEqual(list.json.archived, []);
  const got = await t.plugin(ro, 'GET', `${base}/board`);
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.sha256, made.json.sha256);
  assert.deepEqual(Object.keys(got.json).sort(), ['canvas', 'path', 'problem', 'refs', 'sha256', 'slug', 'targets', 'title']);
  assert.equal((await t.plugin(ro, 'GET', `${base}/nope`)).status, 404);

  const before = await fs.readFile(file(t.root, 'board'));
  for (const [method, p, body] of [['POST', base, { title: 'Other' }], ['PUT', `${base}/board`, { canvas: { nodes: [], edges: [] }, base_sha256: made.json.sha256 }], ['POST', `${base}/board/archive`, {}], ['POST', `${base}/board/restore`, {}]]) {
    const r = await t.plugin(ro, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
  }
  assert.equal(Buffer.compare(await fs.readFile(file(t.root, 'board')), before), 0);
});

test('a canvas token saves (the file changes), conflicts on a stale sha, refuses a bad canvas byte-for-byte, archives and restores', async () => {
  const { t, rw, made } = await withCanvas();
  const canvas = { nodes: [card('n1'), card('n2')], edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }] };
  const saved = await t.plugin(rw, 'PUT', `${base}/board`, { body: { canvas, base_sha256: made.json.sha256 } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.slug, 'board');
  assert.notEqual(saved.json.sha256, made.json.sha256);
  const onDisk = JSON.parse((await fs.readFile(file(t.root, 'board'))).toString('utf8'));
  assert.deepEqual(onDisk.nodes.map((n) => n.id), ['n1', 'n2']);

  const stale = await t.plugin(rw, 'PUT', `${base}/board`, { body: { canvas: { nodes: [], edges: [] }, base_sha256: made.json.sha256 } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.code, 'CONFLICT');
  assert.equal(stale.json.current.sha256, saved.json.sha256);
  assert.deepEqual(stale.json.current.canvas.nodes.map((n) => n.id), ['n1', 'n2']);

  const bytes = await fs.readFile(file(t.root, 'board'));
  const bad = await t.plugin(rw, 'PUT', `${base}/board`, { body: { canvas: { nodes: [card('x'), card('x')], edges: [] }, base_sha256: saved.json.sha256 } });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.code, 'REFUSED_BAD_CANVAS');
  assert.equal(Buffer.compare(await fs.readFile(file(t.root, 'board')), bytes), 0, 'the file is byte-identical');
  for (const body of [{ canvas: { nodes: [], edges: [] } }, { canvas: { nodes: [], edges: [] }, base_sha256: 'nope' }, { base_sha256: saved.json.sha256 }]) {
    assert.equal((await t.plugin(rw, 'PUT', `${base}/board`, { body })).status, 400);
  }
  assert.equal(Buffer.compare(await fs.readFile(file(t.root, 'board')), bytes), 0);

  const archived = await t.plugin(rw, 'POST', `${base}/board/archive`, { body: {} });
  assert.equal(archived.status, 200, archived.text);
  assert.equal(archived.json.ok, true);
  await assert.rejects(fs.stat(file(t.root, 'board')));
  assert.deepEqual((await t.plugin(rw, 'GET', base)).json.archived.map((c) => c.slug), ['board']);
  const restored = await t.plugin(rw, 'POST', `${base}/board/restore`);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(Buffer.compare(await fs.readFile(file(t.root, 'board')), bytes), 0);
  assert.equal((await t.plugin(rw, 'POST', `${base}/board/archive`, { body: { base_sha256: ZERO } })).status, 409);
  assert.equal((await t.plugin(rw, 'POST', `${base}/ghost/archive`, { body: {} })).status, 404);
  assert.equal((await t.plugin(rw, 'POST', base, { body: { title: 'Board' } })).status, 409, 'a taken name');
  assert.equal((await t.plugin(rw, 'POST', base, { body: { title: '' } })).status, 400);
  assert.equal((await t.plugin(rw, 'POST', base, { body: {} })).status, 400);
});

test('a token granted another book cannot reach this one; routes with a bad slug do not exist', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const [a, b] = (await t.member('GET', '/api/books')).json;
  const { token } = await t.grant({ permissions: ['read', 'canvas'], books: [a.slug] });
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${b.slug}/canvases`)).status, 403);
  assert.equal((await t.plugin(token, 'POST', `/api/v1/books/${b.slug}/canvases`, { body: { title: 'X' } })).status, 403);
  for (const slug of ['..', 'Board', 'a%2Fb', '%2E%2E']) {
    for (const method of ['GET', 'PUT']) {
      const r = await t.plugin(token, method, `/api/v1/books/${a.slug}/canvases/${slug}`, { body: method === 'PUT' ? { canvas: { nodes: [], edges: [] }, base_sha256: ZERO } : undefined });
      assert.equal(r.status, 403, `${method} ${slug}`);
    }
  }
});

test('with the board module off, canvas routes are refused and nothing is written', async () => {
  const t = await bootPersonal({ profile: 'canvas-board-off' });
  const rw = (await t.grant({ permissions: ['read', 'canvas'] })).token;
  assert.equal((await t.member('PUT', '/api/profile', { modules: { board: false } })).status, 200);
  const r = await t.plugin(rw, 'POST', base, { body: { title: 'Board' } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'MODULE_OFF');
  assert.equal(r.json.module, 'board');
  assert.equal((await t.plugin(rw, 'GET', base)).status, 403);
  await assert.rejects(fs.stat(file(t.root, 'board')));
});
