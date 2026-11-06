// Story Planner M4 routes: structures (planning/structures/<slug>.md), built-in templates and the spec's M4 gate.
//   GET  /api/books/:b/structure-templates | /structures | /structures/:slug | /plan-overview
//   POST /api/books/:b/structures | /structures/:slug | /structures/:slug/beats | /structures/:slug/archive | /structures/:slug/restore, POST /story-plan, POST /ops/:opId/restore
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FERRY, KEY, WALL, BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const PRIMARY_ID = 'note_01S50000000000000000000017';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const undo = (port, opId) => post(port, u('ops', encodeURIComponent(opId), 'restore'), {});
const planner = () => freshBook('valid/planner');

const manuscript = async (root) => new Map([...(await readAll(root))].filter(([p]) => p.startsWith('manuscript/')));
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}
const structFiles = async (root) => [...(await readAll(root)).keys()].filter((p) => /planning\/structures\//.test(p)).sort();
const structOf = async (port, slug) => (await get(port, u('structures', slug))).json;
const list = async (port) => (await get(port, u('structures'))).json;
async function newStructure(port, body = { template: 'three-act', name: 'Second take' }) {
  const r = await post(port, u('structures'), body);
  assert.equal(r.status, 201, r.text);
  return r.json;
}
const setBeats = (port, slug, beats, sha) => post(port, u('structures', slug, 'beats'), { beats, base_sha256: sha });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
/** A beat as GET returned it, in the write shape. */
const writeShape = (b) => clean({ id: b.id, name: b.name, purpose: b.purpose, question: b.question, position: b.position, state: b.state, scenes: b.scenes.map((s) => s.id) });

test('templates: all eight ids are listed with versions, names and beats; custom has none', async () => {
  const { port } = await planner();
  const r = await get(port, u('structure-templates'));
  assert.equal(r.status, 200, r.text);
  const ids = r.json.templates.map((t) => t.id).sort();
  assert.deepEqual(ids, ['custom', 'five-act', 'heros-journey', 'mystery', 'romance', 'seven-point', 'story-circle', 'three-act']);
  for (const t of r.json.templates) {
    assert.ok(Number.isInteger(t.version) && t.version >= 1, `${t.id} version`);
    assert.ok(t.name && t.description, `${t.id} name and description`);
    if (t.id !== 'custom') assert.ok(t.beats.length > 0 && t.beats.every((b) => b.name), `${t.id} has named beats`);
  }
  assert.equal(r.json.templates.find((t) => t.id === 'custom').beats.length, 0);
});

test('zero structures: archiving the only one leaves an empty list and overview count 0; a plain book has none', async () => {
  const { port } = await planner();
  const before = await list(port);
  assert.deepEqual(before.structures.map((s) => s.slug), ['main-three-act']);
  assert.equal((await post(port, u('structures', 'main-three-act', 'archive'), {})).status, 200);
  const after2 = await list(port);
  assert.deepEqual(after2.structures, []);
  assert.deepEqual(after2.archived.map((s) => s.slug), ['main-three-act']);
  assert.equal((await get(port, u('plan-overview'))).json.counts.structures, 0);

  const plain = await freshBook();
  const empty = await get(plain.port, u('structures'));
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json, { structures: [], archived: [] });
  assert.equal((await get(plain.port, u('plan-overview'))).json.counts.structures, 0);
  assert.equal((await get(plain.port, u('structures', 'nope'))).status, 404);
});

test('the fixture structure reads back: primary, beats, counts, scenes with titles', async () => {
  const { port } = await planner();
  const s = (await list(port)).structures[0];
  assert.equal(s.primary, true);
  assert.equal(s.template, 'three-act');
  assert.equal(s.template_version, 1);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(s.counts, { beats: 3, assigned: 2, omitted: 1 });
  const opening = s.beats.find((b) => b.name === 'Opening image');
  assert.equal(opening.state, 'done');
  assert.deepEqual(opening.scenes.map((x) => x.id), [KEY, FERRY]);
  assert.ok(opening.scenes.every((x) => typeof x.title === 'string' && x.title.length > 0));
  assert.match(s.body, /Free structure notes\./);
  assert.deepEqual((await structOf(port, 'main-three-act')).beats, s.beats);
});

test('create from three-act: dry run writes nothing, real create is 201 with 8 beats with distinct note_ ids', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const dry = await post(port, u('structures'), { template: 'three-act', name: 'Second take', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');
  assert.equal((await list(port)).structures.length, 1);

  const c = await newStructure(port);
  assert.ok(c.opId);
  assert.ok(c.slug);
  assert.equal((await structFiles(root)).length, 2);
  const s = await structOf(port, c.slug);
  assert.equal(s.template, 'three-act');
  assert.equal(s.template_version, 1);
  assert.equal(s.name, 'Second take');
  assert.equal(s.primary, false);
  assert.equal(s.beats.length, 8);
  assert.equal(new Set(s.beats.map((b) => b.id)).size, 8);
  assert.ok(s.beats.every((b) => /^note_/.test(b.id)));
  assert.deepEqual(s.counts, { beats: 8, assigned: 0, omitted: 0 });
  const tpl = (await get(port, u('structure-templates'))).json.templates.find((t) => t.id === 'three-act');
  assert.deepEqual(s.beats.map((b) => b.name), tpl.beats.map((b) => b.name));

  const cu = await newStructure(port, { template: 'custom', name: 'Blank' });
  assert.equal((await structOf(port, cu.slug)).beats.length, 0);
});

test('create refusals: unknown template and bad shapes are 400, nothing is written', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  assert.equal((await post(port, u('structures'), { template: 'nope', name: 'x' })).status, 400);
  assert.equal((await post(port, u('structures'), { template: 'three-act' })).status, 400);
  assert.equal((await post(port, u('structures'), { name: 'x' })).status, 400);
  assert.equal((await post(port, u('structures'), { template: 5, name: 'x' })).status, 400);
  assertSame(before, await readAll(root), 'refused creates');
});

test('two structures at once; making the new one primary via the story plan moves the flag and the overview', async () => {
  const { port } = await planner();
  const c = await newStructure(port);
  const ls = await list(port);
  assert.equal(ls.structures.length, 2);
  assert.equal(ls.structures.find((s) => s.slug === 'main-three-act').primary, true);
  assert.equal(ls.structures.find((s) => s.slug === c.slug).primary, false);

  const newId = (await structOf(port, c.slug)).id;
  const plan = (await get(port, u('story-plan'))).json;
  const r = await post(port, u('story-plan'), { fields: { primary_structure: newId }, base_sha256: plan.sha256 });
  assert.equal(r.status, 200, r.text);

  const after2 = await list(port);
  assert.equal(after2.structures.find((s) => s.slug === c.slug).primary, true);
  assert.equal(after2.structures.find((s) => s.slug === 'main-three-act').primary, false);
  const ov = (await get(port, u('plan-overview'))).json;
  assert.equal(ov.counts.structures, 2);
  assert.equal(ov.story.fields.primary_structure, newId);
});

test('one scene in beats of two different structures shows in both', async () => {
  const { port } = await planner();
  const c = await newStructure(port);
  const s = await structOf(port, c.slug);
  const beats = s.beats.map(writeShape);
  beats[0].scenes = [WALL];
  assert.equal((await setBeats(port, c.slug, beats, s.sha256)).status, 200);
  const main = await structOf(port, 'main-three-act');
  const mainBeats = main.beats.map(writeShape);
  mainBeats[2].scenes = [WALL];
  assert.equal((await setBeats(port, 'main-three-act', mainBeats, main.sha256)).status, 200);

  const a = await structOf(port, c.slug);
  const b = await structOf(port, 'main-three-act');
  assert.deepEqual(a.beats[0].scenes.map((x) => x.id), [WALL]);
  assert.deepEqual(b.beats[2].scenes.map((x) => x.id), [WALL]);
  assert.equal(a.counts.assigned, 1);
});

test('beats save: round trip, reorder, rename, omit, add without id, remove, clear', async () => {
  const { port } = await planner();
  const s0 = await structOf(port, 'main-three-act');
  const [b0, b1, b2] = s0.beats;

  const rt = await setBeats(port, 'main-three-act', s0.beats.map(writeShape), s0.sha256);
  assert.equal(rt.status, 200, rt.text);
  const s1 = await structOf(port, 'main-three-act');
  assert.deepEqual(s1.beats, s0.beats, 'round trip is exact');

  const input = [
    { ...writeShape(b2), name: 'Closing choice', state: 'omitted' },
    writeShape(b0),
    { name: 'Brand new beat', purpose: 'Added by the author.', scenes: [WALL] },
  ];
  const w = await setBeats(port, 'main-three-act', input, s1.sha256);
  assert.equal(w.status, 200, w.text);
  assert.ok(w.json.opId, 'a save returns an opId');
  const s2 = await structOf(port, 'main-three-act');
  assert.deepEqual(s2.beats.map((b) => b.name), ['Closing choice', 'Opening image', 'Brand new beat']);
  assert.equal(s2.beats[0].id, b2.id, 'renamed beat keeps its id');
  assert.equal(s2.beats[0].state, 'omitted');
  assert.equal(s2.beats[1].id, b0.id);
  assert.match(s2.beats[2].id, /^note_/, 'a beat without an id gets one');
  assert.ok(![b0.id, b1.id, b2.id].includes(s2.beats[2].id));
  assert.deepEqual(s2.beats[2].scenes.map((x) => x.id), [WALL]);
  assert.ok(!s2.beats.some((b) => b.id === b1.id), 'removed beat is gone');
  assert.deepEqual(s2.counts, { beats: 3, assigned: 2, omitted: 1 }, 'assigned counts beats with scenes');
  assert.match(s2.body, /Free structure notes\./, 'the body is kept');

  assert.equal((await setBeats(port, 'main-three-act', [], s2.sha256)).status, 200, 'clearing all beats is allowed');
  assert.deepEqual((await structOf(port, 'main-three-act')).beats, []);
});

test('Undo of a beats save restores the exact previous bytes', async () => {
  const { root, port } = await planner();
  const file = 'planning/structures/main-three-act.md';
  const before = (await readAll(root)).get(file);
  const s = await structOf(port, 'main-three-act');
  const w = await setBeats(port, 'main-three-act', [{ name: 'Only beat' }], s.sha256);
  assert.equal(w.status, 200, w.text);
  assert.ok(!(await readAll(root)).get(file).equals(before), 'the save changed the file');
  const un = await undo(port, w.json.opId);
  assert.equal(un.status, 200, un.text);
  assert.ok((await readAll(root)).get(file).equals(before), 'bytes are back');
  assert.equal((await structOf(port, 'main-three-act')).sha256, s.sha256);
});

test('update name and body with a base; undo of a create removes the file', async () => {
  const { root, port } = await planner();
  const c = await newStructure(port);
  const s = await structOf(port, c.slug);
  const e = await post(port, u('structures', c.slug), { name: 'Renamed', body: 'Notes.\n', base_sha256: s.sha256 });
  assert.equal(e.status, 200, e.text);
  const s2 = await structOf(port, c.slug);
  assert.equal(s2.name, 'Renamed');
  assert.match(s2.body, /Notes\./);
  assert.equal(s2.beats.length, 8, 'beats kept');
  assert.equal(s2.template, 'three-act');
  assert.equal((await post(port, u('structures', c.slug), { name: 'x' })).status, 400, 'base required');
  assert.equal((await post(port, u('structures', c.slug), { name: 5, base_sha256: s2.sha256 })).status, 400);
  assert.equal((await post(port, u('structures', c.slug), { name: 'x', base_sha256: s.sha256 })).status, 409);

  const fresh = await newStructure(port, { template: 'custom', name: 'Undo me' });
  assert.equal((await structFiles(root)).length, 3);
  assert.equal((await undo(port, fresh.opId)).status, 200);
  assert.equal((await structFiles(root)).length, 2, 'undo of the create removes the file');
});

test('refusals: stale base is 409 conflict with current; unknown scene is 400 REFUSED_UNKNOWN_SCENE; beats not a list is 400; nothing written', async () => {
  const { root, port } = await planner();
  const s = await structOf(port, 'main-three-act');
  const beats = s.beats.map(writeShape);
  const files = await readAll(root);

  const stale = await setBeats(port, 'main-three-act', beats, '0'.repeat(64));
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.ok(stale.json.current, `409 carries current: ${stale.text}`);

  const unk = await setBeats(port, 'main-three-act', [{ ...beats[0], scenes: [KEY, UNKNOWN_SCENE] }], s.sha256);
  assert.equal(unk.status, 400, unk.text);
  assert.equal(unk.json.code, 'REFUSED_UNKNOWN_SCENE');

  for (const bad of ['x', {}, null, [5], [{ name: 5 }], [{ name: 'a', scenes: 'x' }], [{ name: 'a', scenes: [5] }]]) {
    const r = await setBeats(port, 'main-three-act', bad, s.sha256);
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
  }
  assert.equal((await post(port, u('structures', 'main-three-act', 'beats'), { beats })).status, 400, 'base required');
  assert.equal((await setBeats(port, 'nobody', beats, s.sha256)).status, 404);
  assertSame(files, await readAll(root), 'refused saves');
});

test('archive: every manuscript file is byte-identical, it moves to archived, restore brings it back; the primary can be archived', async () => {
  const { root, port } = await planner();
  const ms = await manuscript(root);
  const c = await newStructure(port);
  const sc = await structOf(port, c.slug);
  const beats = sc.beats.map(writeShape);
  beats[0].scenes = [KEY, WALL];
  assert.equal((await setBeats(port, c.slug, beats, sc.sha256)).status, 200);

  const arch = await post(port, u('structures', c.slug, 'archive'), {});
  assert.equal(arch.status, 200, arch.text);
  assert.ok(arch.json.opId);
  assertSame(ms, await manuscript(root), 'after archive');
  let ls = await list(port);
  assert.deepEqual(ls.structures.map((s) => s.slug), ['main-three-act']);
  assert.deepEqual(ls.archived.map((s) => s.slug), [c.slug]);
  const one = await get(port, u('structures', c.slug));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.archived, true, 'a single GET of an archived structure says so');

  const res = await post(port, u('structures', c.slug, 'restore'), {});
  assert.equal(res.status, 200, res.text);
  ls = await list(port);
  assert.equal(ls.structures.length, 2);
  assert.deepEqual(ls.archived, []);
  assert.deepEqual((await structOf(port, c.slug)).beats[0].scenes.map((x) => x.id), [KEY, WALL], 'assignments survive');
  assertSame(ms, await manuscript(root), 'after restore');

  const primary = await post(port, u('structures', 'main-three-act', 'archive'), {});
  assert.equal(primary.status, 200, primary.text);
  assert.deepEqual((await list(port)).archived.map((s) => s.slug), ['main-three-act']);
  assertSame(ms, await manuscript(root), 'after archiving the primary');
  assert.equal((await get(port, u('story-plan'))).json.fields.primary_structure, PRIMARY_ID, 'the story plan still names it');
  assert.equal((await post(port, u('structures', 'main-three-act', 'restore'), {})).status, 200);
  assert.equal((await structOf(port, 'main-three-act')).primary, true);
});

test('a template never follows its instances and an instance never follows the template', async () => {
  const { port } = await planner();
  const tplBefore = (await get(port, u('structure-templates'))).json.templates.find((t) => t.id === 'three-act');
  const c = await newStructure(port);
  const s = await structOf(port, c.slug);
  const w = await setBeats(port, c.slug, [{ name: 'Mine alone' }, ...s.beats.slice(0, 2).map(writeShape)], s.sha256);
  assert.equal(w.status, 200, w.text);
  const tplAfter = (await get(port, u('structure-templates'))).json.templates.find((t) => t.id === 'three-act');
  assert.deepEqual(tplAfter, tplBefore);
  assert.equal(tplAfter.beats.length, 8);
  const s2 = await structOf(port, c.slug);
  assert.equal(s2.template, 'three-act');
  assert.equal(s2.template_version, 1);
  assert.equal(s2.beats.length, 3);
  assert.equal(s2.beats[0].name, 'Mine alone');
});

test('M4 gate: planning writes alone leave every scene file byte-identical; only planning/structures/ gains files', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const c = await newStructure(port);
  let s = await structOf(port, c.slug);
  const beats = s.beats.map(writeShape);
  beats[0].scenes = [KEY, FERRY, WALL];
  beats[1].state = 'omitted';
  assert.equal((await setBeats(port, c.slug, beats, s.sha256)).status, 200);
  s = await structOf(port, c.slug);
  assert.equal((await post(port, u('structures', c.slug), { name: 'Z', body: 'b\n', base_sha256: s.sha256 })).status, 200);
  const plan = (await get(port, u('story-plan'))).json;
  assert.equal((await post(port, u('story-plan'), { fields: { primary_structure: s.id }, base_sha256: plan.sha256 })).status, 200);
  assert.equal((await post(port, u('structures', c.slug, 'archive'), {})).status, 200);
  assert.equal((await post(port, u('structures', c.slug, 'restore'), {})).status, 200);
  const end = await readAll(root);
  for (const [p, b] of before) {
    if (p.startsWith('manuscript/') || p.startsWith('codex/') || p === 'book.md') assert.ok(end.get(p)?.equals(b), `${p} is byte-identical`);
  }
  assert.ok([...end.keys()].filter((p) => !before.has(p)).every((p) => p.startsWith('planning/structures/')), 'only planning/structures/ gained files');
});

test('module off: POST /structures is 403 MODULE_OFF; a plugin token with every permission gets 403 PLUGIN_SCOPE on the structure routes', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const w = await t.member('POST', u('structures'), { template: 'three-act', name: 'X' });
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);

  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before2 = await readAll(t.root);
  for (const [method, p, body] of [
    ['GET', u('structures')],
    ['GET', u('structure-templates')],
    ['POST', u('structures'), { template: 'three-act', name: 'X' }],
  ]) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before2, await readAll(t.root), 'plugin boundary');
});
