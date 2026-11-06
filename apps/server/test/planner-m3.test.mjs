// Story Planner M3 routes: character arcs (planning/arcs/<slug>.md) and the spec's M3 gate.
//   GET  /api/books/:b/arcs | /arcs/:slug
//   POST /api/books/:b/arcs | /arcs/:slug | /arcs/:slug/milestones | /arcs/:slug/archive | /arcs/:slug/restore, POST /ops/:opId/restore, POST /scenes/:id/move
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FERRY, GRAFTING, KEY, WALL, BOOK, closeAll, freshBook, move, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const MAREN = 'entry_01S5000000000000000000000G';
const PORT_ALDINE = 'entry_01S5000000000000000000000N';
const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const undo = (port, opId) => post(port, u('ops', encodeURIComponent(opId), 'restore'), {});

/** Files outside planning/ (codex, manuscript, book.md ...): path -> Buffer. */
async function nonPlanning(root) {
  return new Map([...(await readAll(root))].filter(([p]) => !p.startsWith('planning/') && !p.startsWith('archive/planning/')));
}
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}
const arcFiles = async (root) => [...(await readAll(root)).keys()].filter((p) => /planning\/arcs\//.test(p)).sort();
async function newArc(port, body = { character: MAREN }) {
  const r = await post(port, u('arcs'), body);
  assert.equal(r.status, 201, r.text);
  return r.json;
}
const arcOf = async (port, slug) => (await get(port, u('arcs', slug))).json;
const ms = (a) => a.milestones.map((m) => m.scene);

test('arc create: dry run writes nothing, real create is 201, list shows the character and no milestones', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);

  const empty = await get(port, u('arcs'));
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json, { arcs: [], archived: [] });

  const dry = await post(port, u('arcs'), { character: MAREN, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(await arcFiles(root), [], 'a dry run writes nothing');
  assertSame(before, await readAll(root), 'dry run');
  assert.deepEqual((await get(port, u('arcs'))).json.arcs, []);

  const c = await newArc(port, { character: MAREN, arc_type: 'positive', fields: { want: 'The orchard' } });
  assert.equal(c.slug, 'maren-hollis');
  assert.equal(c.path, 'planning/arcs/maren-hollis.md');
  assert.ok(c.opId);
  assert.deepEqual(await arcFiles(root), ['planning/arcs/maren-hollis.md']);

  const list = (await get(port, u('arcs'))).json;
  assert.equal(list.arcs.length, 1);
  assert.deepEqual(list.archived, []);
  assert.equal(list.arcs[0].character.name, 'Maren Hollis');
  assert.equal(list.arcs[0].character.id, MAREN);
  assert.equal(list.arcs[0].character.shared, false);
  assert.deepEqual(list.arcs[0].milestones, []);
  assert.equal(list.arcs[0].arc_type, 'positive');
  assert.equal(list.arcs[0].fields.want, 'The orchard');
  assert.equal(list.arcs[0].fields.need, null);

  const one = await get(port, u('arcs', c.slug));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.slug, 'maren-hollis');
  assert.equal(one.json.archived, false);
  assert.match(one.json.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await get(port, u('arcs', 'nobody'))).status, 404);
});

test('arc create: duplicate is 409 with existing.slug; a location, an unknown entry and bad args are 400; nothing extra is written', async () => {
  const { root, port } = await freshBook();
  await newArc(port);
  const files = await readAll(root);

  const dup = await post(port, u('arcs'), { character: MAREN });
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, 'REFUSED_DUPLICATE_ARC');
  assert.equal(dup.json.existing.slug, 'maren-hollis');

  const loc = await post(port, u('arcs'), { character: PORT_ALDINE });
  assert.equal(loc.status, 400, loc.text);
  assert.equal(loc.json.code, 'REFUSED_BAD_ARGS');

  const unk = await post(port, u('arcs'), { character: 'entry_nope' });
  assert.equal(unk.status, 400, unk.text);
  assert.equal(unk.json.code, 'REFUSED_UNKNOWN_ENTRY');

  assert.equal((await post(port, u('arcs'), {})).status, 400, 'character is required');
  assert.equal((await post(port, u('arcs'), { character: 5 })).status, 400);
  assertSame(files, await readAll(root), 'refused creates');
});

test('arc update: fields with a base, body, null removes a field, stale base is 409 with current, missing base is 400', async () => {
  const { root, port } = await freshBook();
  const guard = await nonPlanning(root);
  const c = await newArc(port);
  const g0 = await arcOf(port, c.slug);

  const e1 = await post(port, u('arcs', c.slug), { fields: { want: 'Water', fear: 'Drowning' }, arc_type: 'flat', base_sha256: g0.sha256 });
  assert.equal(e1.status, 200, e1.text);
  const g1 = await arcOf(port, c.slug);
  assert.equal(g1.fields.want, 'Water');
  assert.equal(g1.fields.fear, 'Drowning');
  assert.equal(g1.arc_type, 'flat');
  assert.notEqual(g1.sha256, g0.sha256);

  const e2 = await post(port, u('arcs', c.slug), { fields: { need: 'Trust' }, base_sha256: g1.sha256 });
  assert.equal(e2.status, 200, e2.text);
  const g2 = await arcOf(port, c.slug);
  assert.equal(g2.fields.need, 'Trust');
  assert.equal(g2.fields.want, 'Water', 'a field not in the request is kept');
  assert.equal(g2.arc_type, 'flat', 'arc_type not in the request is kept');

  const e3 = await post(port, u('arcs', c.slug), { body: 'Notes on Maren.\n', base_sha256: g2.sha256 });
  assert.equal(e3.status, 200, e3.text);
  const g3 = await arcOf(port, c.slug);
  assert.match(g3.body, /Notes on Maren\./);
  assert.equal(g3.fields.want, 'Water');

  const e4 = await post(port, u('arcs', c.slug), { fields: { fear: null }, base_sha256: g3.sha256 });
  assert.equal(e4.status, 200, e4.text);
  const g4 = await arcOf(port, c.slug);
  assert.equal(g4.fields.fear, null, 'null removes the field');
  assert.equal(g4.fields.want, 'Water');
  assert.match(g4.body, /Notes on Maren\./);

  const stale = await post(port, u('arcs', c.slug), { fields: { want: 'x' }, base_sha256: g1.sha256 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.ok(stale.json.current, `409 carries current: ${stale.text}`);
  assert.equal((await post(port, u('arcs', c.slug), { fields: { want: 'x' } })).status, 400, 'base_sha256 is required');
  assert.equal((await post(port, u('arcs', c.slug), { fields: { want: 5 }, base_sha256: g4.sha256 })).status, 400);
  assert.equal((await arcOf(port, c.slug)).sha256, g4.sha256, 'refused saves change nothing');

  assertSame(guard, await nonPlanning(root), 'arc updates');
});

test('M3 gate: milestones round-trip, reorder, remove, follow a scene move; unknown scene refused; Codex untouched', async () => {
  const { root, port } = await freshBook();
  const guard = await readAll(root);
  const codexBytes = guard.get('codex/characters/maren-hollis.md');
  assert.ok(codexBytes, 'fixture has the Maren codex entry');

  const c = await newArc(port);
  const base = async () => (await arcOf(port, c.slug)).sha256;
  const set = (milestones, sha) => post(port, u('arcs', c.slug, 'milestones'), { milestones, base_sha256: sha });

  const input = [
    { scene: KEY, choice: 'A' },
    { scene: FERRY, pressure: 'B' },
    { scene: WALL, belief_before: 'X', belief_after: 'Y' },
  ];
  const s1 = await set(input, await base());
  assert.equal(s1.status, 200, s1.text);

  // simulated refresh: new requests
  let a = await arcOf(port, c.slug);
  assert.deepEqual(ms(a), [KEY, FERRY, WALL]);
  assert.deepEqual(a.milestones.map((m) => m.index), [0, 1, 2]);
  assert.ok(a.milestones.every((m) => typeof m.scene_title === 'string' && m.scene_title.length > 0), 'every milestone has a scene_title');
  assert.equal(a.milestones[0].choice, 'A');
  assert.equal(a.milestones[0].pressure, null);
  assert.equal(a.milestones[1].pressure, 'B');
  assert.equal(a.milestones[2].belief_before, 'X');
  assert.equal(a.milestones[2].belief_after, 'Y');
  assert.equal(a.milestones[2].cost, null);
  const listed = (await get(port, u('arcs'))).json.arcs[0];
  assert.deepEqual(listed.milestones, a.milestones, 'the list and the single arc agree');

  // round trip exact: sending back what we read changes nothing
  const strip = (m) => Object.fromEntries(['scene', 'pressure', 'choice', 'belief_before', 'belief_after', 'cost'].filter((k) => m[k] != null).map((k) => [k, m[k]]));
  const shaBefore = a.sha256;
  const rt = await set(a.milestones.map(strip), shaBefore);
  assert.equal(rt.status, 200, rt.text);
  const a2 = await arcOf(port, c.slug);
  assert.deepEqual(a2.milestones, a.milestones, 'round trip is exact');
  const titles = Object.fromEntries(a.milestones.map((m) => [m.scene, m.scene_title]));

  // reorder: WALL first
  const reordered = [input[2], input[0], input[1]];
  assert.equal((await set(reordered, await base())).status, 200);
  a = await arcOf(port, c.slug);
  assert.deepEqual(ms(a), [WALL, KEY, FERRY], 'the order is persisted');
  assert.equal(a.milestones[0].belief_after, 'Y');

  // remove one (KEY)
  assert.equal((await set([reordered[0], reordered[2]], await base())).status, 200);
  a = await arcOf(port, c.slug);
  assert.deepEqual(ms(a), [WALL, FERRY], 'removal persisted');

  // put KEY back, then move it to another chapter with the existing move route
  assert.equal((await set(reordered, await base())).status, 200);
  const preMove = await arcOf(port, c.slug);
  const keyBefore = preMove.milestones.find((m) => m.scene === KEY);
  const mv = await move(port, KEY, { chapter: 2, after: GRAFTING });
  assert.equal(mv.status, 200, mv.text);
  const postMove = await arcOf(port, c.slug);
  const keyAfter = postMove.milestones.find((m) => m.scene === KEY);
  assert.ok(keyAfter, 'the milestone still points at KEY');
  assert.equal(keyAfter.chapter, 2, 'chapter follows the move');
  assert.notEqual(keyAfter.chapter, keyBefore.chapter);
  assert.equal(keyAfter.scene_title, keyBefore.scene_title);
  assert.equal(keyAfter.scene_title, titles[KEY]);
  assert.deepEqual(ms(postMove), [WALL, KEY, FERRY], 'milestone order is the author order, not reading order');
  assert.equal(postMove.sha256, preMove.sha256, 'a move does not rewrite the arc file');

  // unknown scene: refused, nothing written
  const filesNow = await readAll(root);
  const bad = await set([{ scene: KEY }, { scene: UNKNOWN_SCENE }], postMove.sha256);
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.code, 'REFUSED_UNKNOWN_SCENE');
  assertSame(filesNow, await readAll(root), 'refused milestones');
  assert.deepEqual(ms(await arcOf(port, c.slug)), [WALL, KEY, FERRY]);

  // stale base, malformed list
  const stale = await set([{ scene: KEY }], shaBefore);
  assert.equal(stale.status, 409, stale.text);
  assert.ok(stale.json.current);
  assert.equal((await post(port, u('arcs', c.slug, 'milestones'), { milestones: [{ scene: KEY }] })).status, 400, 'base required');
  assert.equal((await post(port, u('arcs', c.slug, 'milestones'), { milestones: 'x', base_sha256: postMove.sha256 })).status, 400);

  // clearing all milestones is allowed
  assert.equal((await set([], postMove.sha256)).status, 200);
  assert.deepEqual((await arcOf(port, c.slug)).milestones, []);

  // old Codex data unaffected
  const end = await readAll(root);
  assert.ok(end.get('codex/characters/maren-hollis.md').equals(codexBytes), 'Maren codex entry is byte-identical');
  for (const [p, b] of guard) if (p.startsWith('codex/')) assert.ok(end.get(p)?.equals(b), `${p} is byte-identical`);
});

test('M3 gate: arc writes alone leave Codex and every manuscript file byte-identical', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);
  const c = await newArc(port, { character: MAREN, fields: { want: 'w' } });
  let sha = (await arcOf(port, c.slug)).sha256;
  assert.equal((await post(port, u('arcs', c.slug, 'milestones'), { milestones: [{ scene: KEY, choice: 'A' }, { scene: WALL }], base_sha256: sha })).status, 200);
  sha = (await arcOf(port, c.slug)).sha256;
  assert.equal((await post(port, u('arcs', c.slug), { fields: { need: 'n' }, body: 'b\n', base_sha256: sha })).status, 200);
  assert.equal((await post(port, u('arcs', c.slug, 'archive'), {})).status, 200);
  assert.equal((await post(port, u('arcs', c.slug, 'restore'), {})).status, 200);
  const end = await readAll(root);
  for (const [p, b] of before) assert.ok(end.get(p)?.equals(b), `${p} is byte-identical`);
  assert.ok([...end.keys()].filter((p) => !before.has(p)).every((p) => p.startsWith('planning/arcs/')), 'only planning/arcs/ gained files');
});

test('arc archive and restore, and undo of the create removes the file', async () => {
  const { root, port } = await freshBook();
  const c = await newArc(port);
  const live = 'planning/arcs/maren-hollis.md';

  const arch = await post(port, u('arcs', c.slug, 'archive'), {});
  assert.equal(arch.status, 200, arch.text);
  assert.ok(arch.json.opId);
  let list = (await get(port, u('arcs'))).json;
  assert.deepEqual(list.arcs, []);
  assert.deepEqual(list.archived.map((x) => x.slug), ['maren-hollis']);
  assert.ok(!(await readAll(root)).has(live));

  const res = await post(port, u('arcs', c.slug, 'restore'), {});
  assert.equal(res.status, 200, res.text);
  list = (await get(port, u('arcs'))).json;
  assert.deepEqual(list.arcs.map((x) => x.slug), ['maren-hollis']);
  assert.deepEqual(list.archived, []);
  assert.ok((await readAll(root)).has(live));

  const un = await undo(port, c.opId);
  assert.equal(un.status, 200, un.text);
  assert.deepEqual(await arcFiles(root), [], 'undo of the create removes the file');
  assert.deepEqual((await get(port, u('arcs'))).json, { arcs: [], archived: [] });
});

test('series entry: an arc in low-tide for a series-shared character is 201, shared is true, the series codex file is untouched', async () => {
  const { root, port } = await freshBook('valid/tidewater');
  const lowTide = 'book_01W1000000000000000000000A';
  const ILSE = 'entry_01W10000000000000000000003';
  const seriesFile = 'tidewater/codex/characters/ilse-hollis.md';
  const before = await readAll(root);
  const seriesBytes = before.get(seriesFile);
  assert.ok(seriesBytes, 'fixture has the series character');

  const r = await post(port, `/api/books/${lowTide}/arcs`, { character: ILSE });
  assert.equal(r.status, 201, r.text);
  const one = await get(port, `/api/books/${lowTide}/arcs/${r.json.slug}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.character.shared, true);
  assert.equal(one.json.character.id, ILSE);
  assert.equal(one.json.character.name, 'Ilse Hollis');
  const list = (await get(port, `/api/books/${lowTide}/arcs`)).json;
  assert.equal(list.arcs[0].character.shared, true);

  const after2 = await readAll(root);
  assert.ok(after2.get(seriesFile).equals(seriesBytes), 'the series codex file is byte-identical');
  for (const [p, b] of before) assert.ok(after2.get(p)?.equals(b), `${p} is byte-identical`);
  assert.deepEqual([...after2.keys()].filter((p) => !before.has(p)), [`tidewater/low-tide/${r.json.path}`]);
});

test('module off: POST /arcs is 403 MODULE_OFF; a plugin token with every permission gets 403 PLUGIN_SCOPE on the arc routes', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const w = await t.member('POST', u('arcs'), { character: MAREN });
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);

  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before2 = await readAll(t.root);
  for (const [method, p, body] of [
    ['GET', u('arcs')],
    ['POST', u('arcs'), { character: MAREN }],
  ]) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before2, await readAll(t.root), 'plugin boundary');
});
