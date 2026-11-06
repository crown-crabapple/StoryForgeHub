// Story Planner M1 routes (ADR 0003 D04-D06): causal links, scene plans, the flow projection, undo of a create, module gating and the plugin boundary.
//   GET  /api/books/:b/links | /links/:slug | /scene-plans/:sceneId | /flow
//   POST /api/books/:b/links | /links/:slug | /links/:slug/archive | /links/:slug/restore | /scene-plans/:sceneId
//   POST /api/books/:b/ops/:opId/restore  (undo of createLink / a new scene plan)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FERRY, KEY, ORIGINAL_ORDER, WALL, UNKNOWN_SCENE, BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';
import { asMember, asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const linkBody = (over = {}) => ({ from: KEY, to: FERRY, relation: 'therefore', rationale: 'The key opens the ferry.', ...over });

/** Files under planning/links and planning/scene-plans (live and archived), relative paths. */
async function plannerFiles(root) {
  return [...(await readAll(root)).keys()].filter((p) => /(^|\/)planning\/(links|scene-plans)\//.test(p)).sort();
}

async function newLink(port, over) {
  const r = await post(port, u('links'), linkBody(over));
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test('create link: a dry run answers 200 with changes and writes nothing; a real create is 201 and is listed, readable and in the flow', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);

  const dry = await post(port, u('links'), { ...linkBody(), dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(dry.json.changes, 'a dry run carries changes');
  assert.deepEqual([...(await readAll(root)).keys()].sort(), [...before.keys()].sort(), 'a dry run writes nothing');
  assert.deepEqual((await get(port, u('links'))).json, { links: [], archived: [] });

  const made = await post(port, u('links'), linkBody());
  assert.equal(made.status, 201, made.text);
  assert.ok(made.json.slug && made.json.id && made.json.path && made.json.opId, `slug/id/path/opId: ${made.text}`);
  assert.equal((await plannerFiles(root)).length, 1, 'exactly one planner file was written');

  const list = (await get(port, u('links'))).json;
  assert.equal(list.links.length, 1);
  assert.deepEqual(list.archived, []);
  const l = list.links[0];
  assert.equal(l.slug, made.json.slug);
  assert.equal(l.from, KEY);
  assert.equal(l.to, FERRY);
  assert.equal(l.relation, 'therefore');
  assert.equal(l.rationale, 'The key opens the ferry.');
  assert.ok(l.from_title && l.to_title, 'scene titles are resolved');

  const one = await get(port, u('links', made.json.slug));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.id, made.json.id);
  assert.equal(one.json.sha256, l.sha256);
  assert.equal((await get(port, u('links', 'no-such-link'))).status, 404);

  const flow = (await get(port, u('flow'))).json;
  assert.deepEqual(flow.nodes.map((n) => n.id), ORIGINAL_ORDER, 'nodes are the live scenes in reading order');
  assert.equal(flow.edges.length, 1);
  assert.equal(flow.edges[0].slug, made.json.slug);
  assert.equal(flow.edges[0].from, KEY);
  assert.equal(flow.edges[0].to, FERRY);
  assert.equal(flow.edges[0].broken, false);
});

test('update link: a stale base is 409 with the current link, a fresh base is 200, a missing base is 400', async () => {
  const { port } = await freshBook();
  const made = await newLink(port);
  const first = (await get(port, u('links', made.slug))).json;

  const missing = await post(port, u('links', made.slug), { relation: 'but' });
  assert.equal(missing.status, 400, missing.text);

  const stale = await post(port, u('links', made.slug), { relation: 'but', base_sha256: '0'.repeat(64) });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.equal((await get(port, u('links', made.slug))).json.relation, 'therefore', 'a refused update changes nothing');

  const ok = await post(port, u('links', made.slug), { relation: 'but', base_sha256: first.sha256 });
  assert.equal(ok.status, 200, ok.text);
  const after1 = (await get(port, u('links', made.slug))).json;
  assert.equal(after1.relation, 'but');
  assert.notEqual(after1.sha256, first.sha256);
  assert.equal((await get(port, u('flow'))).json.edges[0].relation, 'but');
});

// ADR 0003 section on routes: "CONFLICT 409 with `current`". Today the planner ops return CONFLICT without `current`, so the route answers `current: null`.
test('a stale base carries the current state of the file in the 409 (ADR 0003)', async () => {
  const { port } = await freshBook();
  const made = await newLink(port);
  const stale = await post(port, u('links', made.slug), { relation: 'but', base_sha256: '0'.repeat(64) });
  assert.equal(stale.status, 409, stale.text);
  assert.ok(stale.json.current, `link: ${stale.text}`);
  await post(port, u('scene-plans', KEY), { fields: { goal: 'a' } });
  const staleP = await post(port, u('scene-plans', KEY), { fields: { goal: 'b' }, base_sha256: '0'.repeat(64) });
  assert.equal(staleP.status, 409, staleP.text);
  assert.ok(staleP.json.current, `plan: ${staleP.text}`);
});

test('refusals: self link, duplicate, unknown scene and bad relation write nothing', async () => {
  const { root, port } = await freshBook();
  const made = await newLink(port);
  const before = await readAll(root);

  const self = await post(port, u('links'), linkBody({ to: KEY }));
  assert.equal(self.status, 400, self.text);
  assert.equal(self.json.code, 'REFUSED_SELF_LINK');

  const dup = await post(port, u('links'), linkBody());
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.error, 'conflict');
  assert.equal(dup.json.code, 'REFUSED_DUPLICATE_LINK');
  assert.equal(dup.json.existing.slug, made.slug);

  for (const over of [{ to: UNKNOWN_SCENE }, { from: UNKNOWN_SCENE }]) {
    const r = await post(port, u('links'), linkBody(over));
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'REFUSED_UNKNOWN_SCENE');
  }

  const rel = await post(port, u('links'), linkBody({ relation: 'bogus' }));
  assert.equal(rel.status, 400, rel.text);
  assert.equal((await post(port, u('links'), { from: KEY })).status, 400, 'a missing field is 400');
  assert.equal((await post(port, u('links'), linkBody({ rationale: 5 }))).status, 400);

  const afterFiles = await readAll(root);
  assert.deepEqual([...afterFiles.keys()].sort(), [...before.keys()].sort());
  for (const [p, b] of before) assert.ok(afterFiles.get(p).equals(b), `${p} unchanged`);
});

test('archive and restore: the link moves between the lists and the flow follows', async () => {
  const { port } = await freshBook();
  const made = await newLink(port);

  const arch = await post(port, u('links', made.slug, 'archive'), {});
  assert.equal(arch.status, 200, arch.text);
  let list = (await get(port, u('links'))).json;
  assert.deepEqual(list.links, []);
  assert.deepEqual(list.archived.map((l) => l.slug), [made.slug]);
  assert.deepEqual((await get(port, u('flow'))).json.edges, [], 'an archived link is not an edge');
  assert.equal((await get(port, u('links', made.slug))).json.archived, true);

  const back = await post(port, u('links', made.slug, 'restore'), {});
  assert.equal(back.status, 200, back.text);
  list = (await get(port, u('links'))).json;
  assert.deepEqual(list.links.map((l) => l.slug), [made.slug]);
  assert.deepEqual(list.archived, []);
  assert.deepEqual((await get(port, u('flow'))).json.edges.map((e) => e.slug), [made.slug]);

  assert.equal((await post(port, u('links', 'no-such-link', 'archive'), {})).status, 404);
});

test('undo: restoring the op of a create removes the link, and the op of a first scene plan removes the plan', async () => {
  const { root, port } = await freshBook();
  const before = await plannerFiles(root);

  const made = await newLink(port);
  const undo = await post(port, u('ops', encodeURIComponent(made.opId), 'restore'), {});
  assert.equal(undo.status, 200, undo.text);
  assert.deepEqual((await get(port, u('links'))).json, { links: [], archived: [] });
  assert.deepEqual(await plannerFiles(root), before, 'the link file is gone');

  const saved = await post(port, u('scene-plans', KEY), { fields: { goal: 'Open the door' } });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(saved.json.opId, `a created plan returns an opId: ${saved.text}`);
  assert.ok((await get(port, u('scene-plans', KEY))).json.path);
  const undo2 = await post(port, u('ops', encodeURIComponent(saved.json.opId), 'restore'), {});
  assert.equal(undo2.status, 200, undo2.text);
  const plan = (await get(port, u('scene-plans', KEY))).json;
  assert.equal(plan.path, null);
  assert.equal(plan.fields.goal, null);
  assert.deepEqual(await plannerFiles(root), before, 'the plan file is gone');
});

test('scene plan: empty shape, create, read, edit with a base, clear a field with null, and the refusals', async () => {
  const { port } = await freshBook();
  const empty = await get(port, u('scene-plans', KEY));
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.scene_id, KEY);
  assert.equal(empty.json.path, null);
  assert.equal(empty.json.sha256, null);
  assert.deepEqual(empty.json.characters, []);
  assert.equal(empty.json.body, '');
  assert.ok(Object.keys(empty.json.fields).includes('goal') && Object.keys(empty.json.fields).includes('purpose'));
  assert.ok(Object.values(empty.json.fields).every((v) => v === null));

  const created = await post(port, u('scene-plans', KEY), { fields: { goal: 'Find the key', conflict: 'The tide' }, characters: ['maren-hollis'] });
  assert.equal(created.status, 200, created.text);
  assert.equal((await get(port, u('flow'))).json.nodes.find((n) => n.id === KEY).plan, true);
  const got = (await get(port, u('scene-plans', KEY))).json;
  assert.equal(got.fields.goal, 'Find the key');
  assert.equal(got.fields.conflict, 'The tide');
  assert.equal(got.fields.stakes, null);
  assert.deepEqual(got.characters, ['maren-hollis']);
  assert.match(got.sha256, /^[0-9a-f]{64}$/);

  const edited = await post(port, u('scene-plans', KEY), { fields: { goal: 'Find the other key' }, base_sha256: got.sha256 });
  assert.equal(edited.status, 200, edited.text);
  const got2 = (await get(port, u('scene-plans', KEY))).json;
  assert.equal(got2.fields.goal, 'Find the other key');
  assert.equal(got2.fields.conflict, 'The tide', 'a field not in the request is kept');
  assert.deepEqual(got2.characters, ['maren-hollis']);

  const stale = await post(port, u('scene-plans', KEY), { fields: { goal: 'x' }, base_sha256: got.sha256 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.equal((await get(port, u('scene-plans', KEY))).json.fields.goal, 'Find the other key');

  const cleared = await post(port, u('scene-plans', KEY), { fields: { conflict: null }, base_sha256: got2.sha256 });
  assert.equal(cleared.status, 200, cleared.text);
  const got3 = (await get(port, u('scene-plans', KEY))).json;
  assert.equal(got3.fields.conflict, null);
  assert.equal(got3.fields.goal, 'Find the other key');

  const beforeSha = got3.sha256;
  const badChar = await post(port, u('scene-plans', KEY), { characters: ['nobody-here'], base_sha256: beforeSha });
  assert.equal(badChar.status, 400, badChar.text);
  assert.equal(badChar.json.code, 'REFUSED_UNKNOWN_ENTRY');
  assert.equal((await post(port, u('scene-plans', KEY), { fields: { goal: 7 }, base_sha256: beforeSha })).status, 400);
  assert.equal((await get(port, u('scene-plans', KEY))).json.sha256, beforeSha, 'refusals change nothing');

  const unknownGet = await get(port, u('scene-plans', UNKNOWN_SCENE));
  assert.equal(unknownGet.status, 404, 'GET of an unknown scene is 404');
  const unknownSave = await post(port, u('scene-plans', UNKNOWN_SCENE), { fields: { goal: 'x' } });
  assert.equal(unknownSave.status, 400, unknownSave.text);
  assert.equal(unknownSave.json.code, 'REFUSED_UNKNOWN_SCENE');
});

test('data safety: every planner write leaves manuscript/ byte-identical', async () => {
  const { root, port } = await freshBook();
  const manuscript = async () => new Map([...(await readAll(root))].filter(([p]) => p.startsWith('manuscript/')));
  const before = await manuscript();
  assert.ok(before.size > 0);

  const a = await newLink(port);
  const b = await newLink(port, { from: FERRY, to: WALL, relation: 'but' });
  const sha1 = (await get(port, u('links', a.slug))).json.sha256;
  await post(port, u('links', a.slug), { relation: 'enables', base_sha256: sha1 });
  await post(port, u('links', b.slug, 'archive'), {});
  await post(port, u('links', b.slug, 'restore'), {});
  await post(port, u('scene-plans', KEY), { fields: { goal: 'g', purpose: 'p' }, characters: ['pell'] });
  await post(port, u('scene-plans', WALL), { fields: { turn: 't' } });
  const undo = await post(port, u('ops', encodeURIComponent(b.opId), 'restore'), {});
  assert.ok(undo.status === 200 || undo.status === 409 || undo.status === 400, undo.text);

  const afterM = await manuscript();
  assert.deepEqual([...afterM.keys()].sort(), [...before.keys()].sort());
  for (const [p, bytes] of before) assert.ok(afterM.get(p).equals(bytes), `${p} is byte-identical`);
});

test('module off: with planner switched off in the profile a write is 403 MODULE_OFF and writes nothing; reads still work', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);

  const w = await t.member('POST', u('links'), linkBody());
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  const wp = await t.member('POST', u('scene-plans', KEY), { fields: { goal: 'x' } });
  assert.equal(wp.status, 403, wp.text);
  assert.equal(wp.json.code, 'MODULE_OFF');

  const after2 = await readAll(t.root);
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort());
  assert.equal((await t.member('GET', u('links'))).status, 200);
  assert.equal((await t.member('GET', u('flow'))).status, 200);

  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);
  assert.equal((await t.member('POST', u('links'), linkBody())).status, 201, 'on again, the same write succeeds');
});

test('plugin boundary: a token with every permission cannot reach the planner routes (403 PLUGIN_SCOPE) and nothing is written', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before = await readAll(t.root);

  const attempts = [
    ['GET', u('links')],
    ['GET', u('flow')],
    ['POST', u('links'), linkBody()],
    ['POST', u('links'), { ...linkBody(), dryRun: true }],
    ['POST', u('scene-plans', KEY), { fields: { goal: 'x' } }],
    ['GET', `/api/v1/books/salt-orchard/links`],
    ['GET', `/api/v1/books/salt-orchard/flow`],
    ['POST', `/api/v1/books/salt-orchard/links`, linkBody()],
  ];
  for (const [method, p, body] of attempts) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  const after2 = await readAll(t.root);
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort());
  assert.equal((await asMember(t.port, 'GET', u('links'))).json.links.length, 0);
});
