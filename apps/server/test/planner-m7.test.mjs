// Story Planner M7 routes: synopses (planning/synopses/<slug>.md), deterministic extraction, stale basis and the spec's M7 gate.
//   GET  /api/books/:b/synopses | /synopses/:slug | /synopses/:slug/extract
//   POST /api/books/:b/synopses | /synopses/:slug | /synopses/:slug/archive | /synopses/:slug/restore, POST /ops/:opId/restore, POST /scenes/:id/fields
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FERRY, BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const SLUG = 'one-page';
const FILE = 'planning/synopses/one-page.md';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const planner = () => freshBook('valid/planner');
const syn = async (port, slug = SLUG) => (await get(port, u('synopses', slug))).json;
const extract = async (port, slug = SLUG) => (await get(port, u('synopses', slug, 'extract'))).json;
const listed = async (port) => (await get(port, u('synopses'))).json;
const bodyOf = async (root) => (await readAll(root)).get(FILE).toString('utf8').split('\n---\n').slice(1).join('\n---\n');

const isSynopsisPath = (p) => p.startsWith('planning/synopses/') || p.startsWith('archive/planning/synopses/');
const outside = async (root) => new Map([...(await readAll(root))].filter(([p]) => !isSynopsisPath(p)));
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}

test('synopses: list and get read the fixture item exactly; missing slug is 404', async () => {
  const { port } = await planner();
  const l = await listed(port);
  assert.deepEqual(l.archived, []);
  assert.equal(l.synopses.length, 1);
  const s = l.synopses[0];
  assert.equal(s.slug, SLUG);
  assert.equal(s.path, FILE);
  assert.equal(s.type, 'one-page');
  assert.equal(s.name, 'One page');
  assert.equal(s.target_words, 300);
  assert.equal(s.words, 3);
  assert.equal(s.basis, null);
  assert.equal(s.stale, false);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  const one = await get(port, u('synopses', SLUG));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.sha256, s.sha256);
  assert.equal(one.json.type, 'one-page');
  assert.equal(one.json.name, 'One page');
  assert.equal(one.json.target_words, 300);
  assert.equal(one.json.words, 3);
  assert.equal(one.json.basis, null);
  assert.equal(one.json.stale, false);
  assert.match(one.json.body, /^Free synopsis text\.\n?$/);
  assert.equal((await get(port, u('synopses', 'nobody'))).status, 404);
});

test('extract: non-empty text ending in a newline, 64-hex basis, numeric skipped; deterministic; writes nothing', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const r = await get(port, u('synopses', SLUG, 'extract'));
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.text, 'string');
  assert.ok(r.json.text.length > 0);
  assert.ok(r.json.text.endsWith('\n'));
  assert.match(r.json.basis, /^[0-9a-f]{64}$/);
  assert.equal(typeof r.json.skipped, 'number');
  assert.match(r.json.text, /Maren steps off the ferry/, 'built from scene summaries');
  assert.deepEqual(await extract(port), r.json, 'extraction is deterministic');
  assertSame(before, await readAll(root), 'extract');
});

test('create: 201 then get; dry run writes nothing; bad type, target_words and name are 400 and write nothing', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const dry = await post(port, u('synopses'), { type: 'logline', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');

  for (const bad of [{ type: 'nope' }, { type: 'logline', target_words: 1.5 }, { type: 'logline', target_words: 0 }, {}]) {
    const r = await post(port, u('synopses'), bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
  }
  assertSame(before, await readAll(root), 'refused creates');

  const c = await post(port, u('synopses'), { type: 'logline', name: 'My logline', target_words: 25, body: 'A line.\n' });
  assert.equal(c.status, 201, c.text);
  assert.ok(c.json.opId);
  assert.match(c.json.path, /^planning\/synopses\/.+\.md$/);
  const g = await syn(port, c.json.slug);
  assert.equal(g.type, 'logline');
  assert.equal(g.name, 'My logline');
  assert.equal(g.target_words, 25);
  assert.match(g.body, /A line\./);
  assert.equal((await listed(port)).synopses.length, 2);

  const d = await post(port, u('synopses'), { type: 'premise' });
  assert.equal(d.status, 201, d.text);
  assert.ok((await syn(port, d.json.slug)).name.length > 0, 'name defaults to the type label');
});

test('update: base_sha256 required and checked; edits body; bad args are 400; stale base is 409 with current', async () => {
  const { root, port } = await planner();
  const s0 = await syn(port);
  const before = await readAll(root);
  for (const bad of [
    { body: 'x' },
    { body: 'x', base_sha256: s0.sha256, basis: 'xyz' },
    { body: 'x', base_sha256: s0.sha256, target_words: 1.5 },
  ]) {
    const r = await post(port, u('synopses', SLUG), bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
  }
  assertSame(before, await readAll(root), 'refused updates');

  const dry = await post(port, u('synopses', SLUG), { body: 'Dry.\n', base_sha256: s0.sha256, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');

  const w = await post(port, u('synopses', SLUG), { body: 'Rewritten by hand.\n', base_sha256: s0.sha256 });
  assert.equal(w.status, 200, w.text);
  const s1 = await syn(port);
  assert.match(s1.body, /Rewritten by hand\./);
  assert.notEqual(s1.sha256, s0.sha256);
  assert.equal(s1.target_words, 300, 'untouched fields kept');

  const old = await post(port, u('synopses', SLUG), { body: 'Lost.\n', base_sha256: s0.sha256 });
  assert.equal(old.status, 409, old.text);
  assert.equal(old.json.error, 'conflict');
  assert.ok(old.json.current);
  assert.match((await syn(port)).body, /Rewritten by hand\./);

  const nul = await post(port, u('synopses', SLUG), { target_words: null, base_sha256: s1.sha256 });
  assert.equal(nul.status, 200, nul.text);
  assert.ok(!(await syn(port)).target_words, 'target_words null clears it');
});

test('stale: extract basis is not stale; a scene summary change makes it stale; keep my text stores the new basis and leaves the body byte-identical', async () => {
  const { root, port } = await planner();
  const s0 = await syn(port);
  const e0 = await extract(port);
  assert.equal((await post(port, u('synopses', SLUG), { basis: e0.basis, base_sha256: s0.sha256 })).status, 200);
  let item = (await listed(port)).synopses[0];
  assert.equal(item.basis, e0.basis);
  assert.equal(item.stale, false);

  const edit = await post(port, u('scenes', FERRY, 'fields'), { summary: 'A silent crossing, changed for the stale test.' });
  assert.equal(edit.status, 200, edit.text);
  item = (await listed(port)).synopses[0];
  assert.equal(item.stale, true, 'list shows stale');
  assert.equal((await syn(port)).stale, true, 'get shows stale');

  const bodyBefore = await bodyOf(root);
  const e1 = await extract(port);
  assert.notEqual(e1.basis, e0.basis);
  const s1 = await syn(port);
  const keep = await post(port, u('synopses', SLUG), { basis: e1.basis, base_sha256: s1.sha256 });
  assert.equal(keep.status, 200, keep.text);
  item = (await listed(port)).synopses[0];
  assert.equal(item.stale, false);
  assert.equal(item.basis, e1.basis);
  assert.equal(await bodyOf(root), bodyBefore, 'body is byte-identical');

  const clear = await post(port, u('synopses', SLUG), { basis: null, base_sha256: item.sha256 });
  assert.equal(clear.status, 200, clear.text);
  const cleared = (await listed(port)).synopses[0];
  assert.equal(cleared.basis, null);
  assert.equal(cleared.stale, false, 'no basis is never stale');
});

test('gate: handwritten synopsis is not overwritten; extract and every GET leave the file alone, only an explicit update changes it', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  await get(port, u('synopses'));
  await get(port, u('synopses', SLUG));
  await get(port, u('synopses', SLUG, 'extract'));
  await get(port, u('synopses', SLUG, 'extract'));
  assertSame(before, await readAll(root), 'reads');
  const s = await syn(port);
  const w = await post(port, u('synopses', SLUG), { body: 'Explicit.\n', base_sha256: s.sha256 });
  assert.equal(w.status, 200, w.text);
  const after2 = await readAll(root);
  assert.ok(!after2.get(FILE).equals(before.get(FILE)));
  const rest = (m) => new Map([...m].filter(([p]) => p !== FILE));
  assertSame(rest(before), rest(after2), 'other files');
});

test('gate: with the ai module off, extract still works (200) and writes nothing', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const off = await t.member('PUT', '/api/profile', { modules: { ai: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const r = await t.member('GET', u('synopses', SLUG, 'extract'));
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.basis, /^[0-9a-f]{64}$/);
  assertSame(before, await readAll(t.root), 'ai off');
});

test('archive then restore round trip; archived list shows it while archived', async () => {
  const { root, port } = await planner();
  const a = await post(port, u('synopses', SLUG, 'archive'), {});
  assert.equal(a.status, 200, a.text);
  const l = await listed(port);
  assert.equal(l.synopses.length, 0);
  assert.equal(l.archived.length, 1);
  assert.equal(l.archived[0].slug, SLUG);
  assert.ok(!(await readAll(root)).has(FILE));
  const r = await post(port, u('synopses', SLUG, 'restore'), {});
  assert.equal(r.status, 200, r.text);
  const l2 = await listed(port);
  assert.deepEqual(l2.archived, []);
  assert.equal(l2.synopses[0].slug, SLUG);
  assert.ok((await readAll(root)).has(FILE));
});

test('undo of a create removes the file', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const c = await post(port, u('synopses'), { type: 'elevator-pitch' });
  assert.equal(c.status, 201, c.text);
  assert.ok((await readAll(root)).has(c.json.path));
  const un = await post(port, u('ops', encodeURIComponent(c.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  assert.ok(!(await readAll(root)).has(c.json.path), 'file removed');
  assertSame(before, await readAll(root), 'after undo');
});

test('only synopsis files change: every synopsis write leaves all other files byte-identical', async () => {
  const { root, port } = await planner();
  const before = await outside(root);
  const c = await post(port, u('synopses'), { type: 'short', body: 'Hi.\n' });
  assert.equal(c.status, 201, c.text);
  const g = await syn(port, c.json.slug);
  const e = await extract(port, c.json.slug);
  assert.equal((await post(port, u('synopses', c.json.slug), { basis: e.basis, base_sha256: g.sha256 })).status, 200);
  const g2 = await syn(port, c.json.slug);
  assert.equal((await post(port, u('synopses', c.json.slug), { name: 'Renamed', body: 'Bye.\n', base_sha256: g2.sha256 })).status, 200);
  assert.equal((await post(port, u('synopses', c.json.slug, 'archive'), {})).status, 200);
  assert.equal((await post(port, u('synopses', c.json.slug, 'restore'), {})).status, 200);
  assert.equal((await post(port, u('synopses', SLUG, 'archive'), {})).status, 200);
  assertSame(before, await outside(root), 'files outside synopses');
});

test('module planner off: POST /synopses is 403 MODULE_OFF; a plugin token gets 403 PLUGIN_SCOPE on synopses', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const w = await t.member('POST', u('synopses'), { type: 'logline' });
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);

  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before2 = await readAll(t.root);
  for (const [method, p, body] of [['GET', u('synopses')], ['POST', u('synopses'), { type: 'logline' }]]) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before2, await readAll(t.root), 'plugin boundary');
});
