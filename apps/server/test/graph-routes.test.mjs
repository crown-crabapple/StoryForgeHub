// M04-J01 acceptance 6: GET /api/books/:b/graph, entry appears_in / related (incl. reverse), codex types, 404s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01CG0000000000000000000001';
const UNKNOWN_BOOK = 'book_01CG00000000000000000000ZZ';
const ID = {
  landfall: 'scene_01CG0000000000000000000002',
  nightLines: 'scene_01CG0000000000000000000003',
  lastFerry: 'scene_01CG0000000000000000000004',
  maren: 'entry_01CG0000000000000000000005',
  tobin: 'entry_01CG0000000000000000000006',
  portAldine: 'entry_01CG0000000000000000000007',
  harbourBoard: 'entry_01CG0000000000000000000008',
  brassKey: 'entry_01CG0000000000000000000009',
  gull: 'entry_01CG000000000000000000000B',
  tideCall: 'entry_01CG000000000000000000000C',
};
const b = (rest = '') => `/api/books/${BOOK}${rest}`;

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh({ build = true } = {}) {
  const root = await copyFixture('valid/codex-graph');
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

const sorted = (xs) => xs.map((x) => JSON.stringify(x)).sort();
const touches = (id) => (e) => e.from === id || e.to === id;

// Run the read routes against an indexed book and against one with no index (files fallback).
for (const build of [true, false]) {
  const mode = build ? 'indexed' : 'no index';

  test(`GET graph (${mode}): whole book, every node and both edge kinds`, async () => {
    const { port } = await fresh({ build });
    const r = await request(port, 'GET', b('/graph'));
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers['content-type'], /application\/json/);
    const ids = r.json.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of Object.values(ID)) assert.ok(ids.includes(id), `node ${id}`);
    assert.deepEqual(r.json.nodes.find((n) => n.id === ID.gull), { id: ID.gull, kind: 'entry', type: 'ship', name: 'The Gull' });
    assert.deepEqual(r.json.nodes.find((n) => n.id === ID.landfall), { id: ID.landfall, kind: 'scene', type: null, name: 'Landfall' });
    const kinds = new Set(r.json.edges.map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['explicit', 'inferred']);
    for (const e of r.json.edges) {
      assert.ok(ids.includes(e.from) && ids.includes(e.to));
      assert.ok(e.source && typeof e.source.path === 'string');
    }
  });

  test(`GET graph (${mode}): the same body whether or not an index exists`, async () => {
    const withIndex = await request((await fresh({ build: true })).port, 'GET', b('/graph'));
    const without = await request((await fresh({ build: false })).port, 'GET', b('/graph'));
    assert.deepEqual(sorted(without.json.nodes), sorted(withIndex.json.nodes));
    assert.deepEqual(sorted(without.json.edges), sorted(withIndex.json.edges));
  });

  test(`GET graph?node= (${mode}): the node and its neighbours, with edges in both directions`, async () => {
    const { port } = await fresh({ build });
    const r = await request(port, 'GET', b(`/graph?node=${ID.maren}`));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.edges.length > 0);
    assert.ok(r.json.edges.every(touches(ID.maren)), 'every edge touches the node');
    const nodeIds = new Set(r.json.nodes.map((n) => n.id));
    assert.ok(nodeIds.has(ID.maren));
    for (const e of r.json.edges) assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to));
    // neighbours reached by outgoing related, incoming related, and scenes
    for (const id of [ID.tobin, ID.portAldine, ID.brassKey, ID.landfall, ID.nightLines]) assert.ok(nodeIds.has(id), `neighbour ${id}`);
    assert.ok(!nodeIds.has(ID.tideCall), 'unrelated entry is not a neighbour');
    assert.ok(!nodeIds.has(ID.lastFerry), 'scene that never touches the node is not a neighbour');
    assert.ok(r.json.edges.some((e) => e.from === ID.brassKey && e.to === ID.maren && e.rel === 'related' && e.label === 'carried by'));
    assert.ok(r.json.edges.some((e) => e.from === ID.maren && e.to === ID.tobin && e.rel === 'related' && e.label === 'childhood friend'));
  });

  test(`GET graph?node=&kinds= (${mode}): kinds filter the edges`, async () => {
    const { port } = await fresh({ build });
    const all = (await request(port, 'GET', b('/graph'))).json;

    const ex = await request(port, 'GET', b('/graph?kinds=explicit'));
    assert.equal(ex.status, 200, ex.text);
    assert.ok(ex.json.edges.length > 0 && ex.json.edges.every((e) => e.kind === 'explicit'));
    assert.deepEqual(sorted(ex.json.edges), sorted(all.edges.filter((e) => e.kind === 'explicit')));

    const inf = await request(port, 'GET', b('/graph?kinds=inferred'));
    assert.ok(inf.json.edges.length > 0 && inf.json.edges.every((e) => e.kind === 'inferred' && e.count >= 1));
    assert.deepEqual(sorted(inf.json.edges), sorted(all.edges.filter((e) => e.kind === 'inferred')));

    const both = await request(port, 'GET', b('/graph?kinds=explicit,inferred'));
    assert.deepEqual(sorted(both.json.edges), sorted(all.edges));

    const node = await request(port, 'GET', b(`/graph?node=${ID.nightLines}&kinds=inferred`));
    assert.ok(node.json.edges.length === 5 && node.json.edges.every((e) => e.kind === 'inferred' && e.from === ID.nightLines));
  });

  test(`GET entries/:id (${mode}): appears_in lists explicit scenes first, then inferred`, async () => {
    const { port } = await fresh({ build });
    const r = await request(port, 'GET', b(`/entries/${ID.maren}`));
    assert.equal(r.status, 200, r.text);
    const a = r.json.appears_in;
    for (const row of a) assert.deepEqual(Object.keys(row).sort(), ['kind', 'position', 'rel', 'scene_id', 'title']);
    const firstInferred = a.findIndex((x) => x.kind === 'inferred');
    assert.ok(firstInferred > 0, 'has explicit rows then inferred rows');
    assert.ok(a.slice(0, firstInferred).every((x) => x.kind === 'explicit'));
    assert.ok(a.slice(firstInferred).every((x) => x.kind === 'inferred'));
    const landfall = a.filter((x) => x.scene_id === ID.landfall);
    assert.ok(landfall.length >= 1 && landfall.every((x) => x.kind === 'explicit' && x.title === 'Landfall' && x.position === 1));
    assert.deepEqual(landfall.map((x) => x.rel).sort(), ['character', 'pov']);
    assert.deepEqual(a.filter((x) => x.kind === 'inferred'), [
      { scene_id: ID.nightLines, title: 'Night Lines', position: 2, rel: 'mention', kind: 'inferred' },
    ]);
  });

  test(`GET entries/:id (${mode}): related shows outgoing as out and incoming as in`, async () => {
    const { port } = await fresh({ build });
    const maren = (await request(port, 'GET', b(`/entries/${ID.maren}`))).json.related;
    assert.deepEqual(sorted(maren), sorted([
      { id: ID.tobin, name: 'Tobin Reyes', as: 'childhood friend', direction: 'out' },
      { id: ID.portAldine, name: 'Port Aldine', as: 'home port', direction: 'out' },
      { id: ID.tobin, name: 'Tobin Reyes', as: 'ferry passenger', direction: 'in' },
      { id: ID.brassKey, name: 'Brass Key', as: 'carried by', direction: 'in' },
    ]));

    // incoming-only: the board declares the Gull, the Gull never declares the board
    const gull = (await request(port, 'GET', b(`/entries/${ID.gull}`))).json.related;
    assert.deepEqual(sorted(gull), sorted([
      { id: ID.portAldine, name: 'Port Aldine', as: 'home port', direction: 'out' },
      { id: ID.harbourBoard, name: 'Harbour Board', as: 'operates', direction: 'in' },
    ]));
    const port_ = (await request(port, 'GET', b(`/entries/${ID.portAldine}`))).json.related;
    assert.deepEqual(sorted(port_), sorted([
      { id: ID.maren, name: 'Maren Hollis', as: 'home port', direction: 'in' },
      { id: ID.gull, name: 'The Gull', as: 'home port', direction: 'in' },
    ]));
  });

  test(`GET entries/:id (${mode}): an entry with no relations has related [] and only mention appearances`, async () => {
    const { port } = await fresh({ build });
    const r = await request(port, 'GET', b(`/entries/${ID.tideCall}`));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.related, []);
    assert.deepEqual(r.json.appears_in, [
      { scene_id: ID.nightLines, title: 'Night Lines', position: 2, rel: 'mention', kind: 'inferred' },
    ]);
    assert.equal(r.json.type, 'spell');
  });

  test(`GET entries/:id (${mode}): existing preview fields are still returned`, async () => {
    const { port } = await fresh({ build });
    const r = await request(port, 'GET', b('/entries/the-gull')); // by slug
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.id, ID.gull);
    assert.equal(r.json.type, 'ship');
    assert.equal(r.json.fields.Captain, 'Tobin Reyes');
    assert.equal(r.json.fields.Tonnage, 40);
    assert.deepEqual(r.json.sections.map((s) => s.heading), ['Overview']);
  });

  test(`404s (${mode}): unknown book, unknown node, unknown entry`, async () => {
    const { port } = await fresh({ build });
    assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/graph`)).status, 404);
    assert.equal((await request(port, 'GET', b('/graph?node=entry_01CG00000000000000000000ZZ'))).status, 404);
    assert.equal((await request(port, 'GET', b('/entries/entry_01CG00000000000000000000ZZ'))).status, 404);
    assert.equal((await request(port, 'GET', b('/entries/no-such-slug'))).status, 404);
    assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/entries/${ID.maren}`)).status, 404);
  });
}

test('graph and entry routes are read-only: no file in the book changes', async () => {
  const { port, root } = await fresh({ build: true });
  const before = await snapshot(root, { skipStoryforge: true });
  for (const p of ['/graph', `/graph?node=${ID.maren}`, '/graph?kinds=inferred', `/entries/${ID.maren}`, '/codex/types']) {
    assert.equal((await request(port, 'GET', b(p))).status, 200, p);
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('GET codex/types: built-in types, the defined custom type, and the undefined custom type', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', b('/codex/types'));
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.map((t) => [t.type, t]));
  for (const t of ['character', 'location', 'faction', 'object', 'lore']) assert.equal(by[t].builtin, true, t);
  assert.equal(by.ship.builtin, false);
  assert.equal(by.ship.defined, true);
  assert.equal(by.ship.name, 'Ship');
  assert.equal(by.ship.plural, 'Ships');
  assert.deepEqual(by.ship.fields, ['Captain', 'Home port', 'Tonnage']);
  assert.equal(by.ship.count, 1);
  assert.equal(by.spell.defined, false);
  assert.equal(by.spell.name, 'Spell');
  assert.equal(by.spell.count, 1);
  assert.equal(by.character.count, 2);
  assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/codex/types`)).status, 404);
});
