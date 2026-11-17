// A new Codex entry over the plugin API v1 (permission 'workspace', book AI level planner) and the MCP tool codex_create_entry:
//   POST /api/v1/books/:b/entries  { type, name, slug?, status? (seed | sketch), fields?, body? }   (app route entry-create; a new file in the book only)
// Nothing existing changes: no other entry route is reachable, status canon and the series codex are refused, and the type must be one the book already has.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { decidePlugin } from '../src/plugin-policy.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const base = `/api/v1/books/${BOOK}`;
const text = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const isStore = (p) => p.startsWith('.storyforge/') || p.startsWith('provenance/');
const changed = (a, c) => [...new Set([...a.keys(), ...c.keys()])].filter((p) => !a.has(p) || !c.has(p) || !a.get(p).equals(c.get(p))).sort();

test('the policy: POST /entries needs workspace at level planner; the other entry write paths stay out of reach', () => {
  const grant = (permissions) => ({ id: 'g1', plugin: 'p', permissions, books: 'all' });
  const slugOf = (x) => (x === BOOK || x === SLUG ? SLUG : null);
  const decide = (permissions, method, p) => decidePlugin(grant(permissions), method, `${base}${p}`, slugOf);
  const ok = decide(['read', 'workspace'], 'POST', '/entries');
  assert.deepEqual([ok.ok, ok.need, ok.level], [true, 'workspace', 'planner']);
  for (const perms of [['read'], ['read', 'propose', 'plan', 'canvas', 'draft']]) {
    const refused = decide(perms, 'POST', '/entries');
    assert.equal(refused.ok, false);
    assert.match(refused.body.message, /"workspace"/);
  }
  const all = ['read', 'propose', 'plan', 'canvas', 'workspace', 'draft'];
  for (const [method, p] of [['PUT', '/entries/maren-hollis/body'], ['POST', '/entries/maren-hollis/fields'], ['POST', '/entries/maren-hollis/slug'], ['POST', '/entries/maren-hollis/archive'], ['POST', '/entries/restore'], ['POST', '/entries/maren-hollis/move-to-series'], ['POST', '/entries/maren-hollis'], ['PUT', '/entries']]) {
    const d = decide(all, method, p);
    assert.equal(d.ok, false, `${method} ${p}`);
    assert.equal(d.body.code, 'PLUGIN_SCOPE');
  }
  assert.equal(v1RouteOf('POST', `${base}/entries`), 'entry-create');
  assert.equal(v1RouteOf('GET', `${base}/entries`), 'entries');
});

test('a plugin creates a seed or sketch entry with fields and a Markdown body; only the new file is written', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'worldbuilder', permissions: ['read', 'workspace'] })).token;

  const list = await t.plugin(rw, 'GET', `${base}/entries`);
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.types.some((x) => x.type === 'character' && Array.isArray(x.fields)), 'the listing names the codex types');

  const before = await readAll(t.root);
  const body = '## Overview\n\nA ferry pilot who knows every channel of the marsh.\n\n## Appearance\n\nWeathered hands.';
  const r = await t.plugin(rw, 'POST', `${base}/entries`, { body: { type: 'character', name: 'Odile Varn', status: 'sketch', fields: { Age: '52' }, body } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.id, /^entry_/);
  assert.equal(r.json.slug, 'odile-varn');
  const rel = 'codex/characters/odile-varn.md';
  const file = await text(t.root, rel);
  assert.match(file, /^status: sketch$/m);
  assert.match(file, /^name: Odile Varn$/m);
  assert.match(file, /Age: "?52"?/);
  assert.ok(file.endsWith(`---\n${body}\n`), file);
  const diff = changed(before, await readAll(t.root)).filter((p) => !isStore(p));
  assert.deepEqual(diff, [rel], 'only the new entry file');

  // default status seed, default body; the entry reads back through the API
  const seed = await t.plugin(rw, 'POST', `${base}/entries`, { body: { type: 'location', name: 'The Low Ferry' } });
  assert.equal(seed.status, 201, seed.text);
  const got = await t.plugin(rw, 'GET', `${base}/entries/the-low-ferry`);
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.status, 'seed');
  assert.match(got.json.body, /^## Overview/);
});

test('refused: canon, the series codex, an unknown type, a taken slug; nothing is written', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'worldbuilder', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);
  for (const [b, code] of [
    [{ type: 'character', name: 'X', status: 'canon' }, 'REFUSED_STATUS'],
    [{ type: 'character', name: 'X', where: 'series' }, 'REFUSED_SCOPE'],
    [{ type: 'spaceship', name: 'X' }, 'REFUSED_TYPE'],
    [{ type: 'character', name: 'X', body: 7 }, 'BAD_ARGS'],
  ]) {
    const r = await t.plugin(rw, 'POST', `${base}/entries`, { body: b });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, code, r.text);
  }
  const taken = await t.plugin(rw, 'POST', `${base}/entries`, { body: { type: 'character', name: 'Maren Hollis' } });
  assert.equal(taken.status, 409, taken.text);
  const reader = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  assert.equal((await t.plugin(reader, 'POST', `${base}/entries`, { body: { type: 'character', name: 'Y' } })).status, 403);
  assert.deepEqual(changed(before, await readAll(t.root)).filter((p) => !isStore(p)), [], 'refusals wrote nothing');
});

test('MCP: codex_create_entry creates the entry; codex_list_entries returns the types', async () => {
  const t = await bootPersonal();
  const token = (await t.grant({ plugin: 'mcp-worldbuilder', permissions: ['read', 'workspace'] })).token;
  let id = 1;
  const call = async (name, args) => {
    const r = await t.plugin(token, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(r.status, 200, r.text);
    return r.json.result;
  };
  const listed = await call('codex_list_entries', { book: SLUG });
  assert.ok(listed.structuredContent.types.some((x) => x.type === 'faction'));
  const made = await call('codex_create_entry', { book: SLUG, type: 'faction', name: 'The Tide Wardens', body: '## Overview\n\nThey keep the sluice gates.\n' });
  assert.notEqual(made.isError, true, JSON.stringify(made));
  assert.equal(made.structuredContent.slug, 'the-tide-wardens');
  assert.match(made.structuredContent.id, /^entry_/);
  assert.match(await text(t.root, 'codex/factions/the-tide-wardens.md'), /They keep the sluice gates\./);
  const canon = await call('codex_create_entry', { book: SLUG, type: 'faction', name: 'Nope', status: 'canon' });
  assert.equal(canon.isError, true);
});
