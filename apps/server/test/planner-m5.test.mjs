// Story Planner M5 routes: relationships (planning/relationships/<slug>.md), links to beats, REFUSED_BEAT_LINKED, the plan badges and the spec's M5 gate.
//   GET  /api/books/:b/relationships | /relationships/:slug | /plan-badges | /flow | /links
//   POST /api/books/:b/relationships | /relationships/:slug | /relationships/:slug/developments | /relationships/:slug/archive | /relationships/:slug/restore,
//        POST /links, POST /structures/:slug/beats, POST /structures/:slug/archive, POST /ops/:opId/restore, POST /scenes/:id/move, POST /threads/:id/fields
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL, FERRY, GRAFTING, KEY, WALL, BOOK, closeAll, freshBook, move, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const MAREN = 'entry_01S5000000000000000000000G';
const PELL = 'entry_01S5000000000000000000000K';
const ILSE = 'entry_01S5000000000000000000000H';
const INCITING = 'note_01S50000000000000000000019'; // beat of main-three-act, the `to` of key-enables-inciting-event
const THREAD_ID = 'thread_01S5000000000000000000000T';
const REL = 'maren-hollis-and-pell';
const REL_FILE = 'planning/relationships/maren-hollis-and-pell.md';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const undo = (port, opId) => post(port, u('ops', encodeURIComponent(opId), 'restore'), {});
const planner = () => freshBook('valid/planner');

const only = (m, pred) => new Map([...m].filter(([p]) => pred(p)));
const codexOf = async (root) => only(await readAll(root), (p) => p.startsWith('codex/'));
const nonPlanning = async (root) => only(await readAll(root), (p) => !p.startsWith('planning/') && !p.startsWith('archive/planning/'));
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}
const rels = async (port) => (await get(port, u('relationships'))).json;
const relOf = async (port, slug = REL) => (await get(port, u('relationships', slug))).json;
const structOf = async (port, slug) => (await get(port, u('structures', slug))).json;
const flowOf = async (port) => (await get(port, u('flow'))).json;
const linksOf = async (port) => (await get(port, u('links'))).json;
const badgesOf = async (port) => (await get(port, u('plan-badges'))).json;
const setBeats = (port, slug, beats, sha) => post(port, u('structures', slug, 'beats'), { beats, base_sha256: sha });
const keepAll = (s, dropId) => s.beats.filter((b) => b.id !== dropId).map((b) => ({ id: b.id, name: b.name, scenes: b.scenes.map((x) => x.id) }));

test('relationships: list and get read the fixture, with names, developments in order and scene titles', async () => {
  const { port } = await planner();
  const l = await rels(port);
  assert.deepEqual(l.archived, []);
  assert.equal(l.relationships.length, 1);
  const r = l.relationships[0];
  assert.equal(r.slug, REL);
  assert.equal(r.path, REL_FILE);
  assert.equal(r.a.id, MAREN);
  assert.equal(r.b.id, PELL);
  assert.equal(r.a.name, 'Maren Hollis');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.baseline, 'Apprentice and ferryman, wary of each other.');
  assert.equal(r.end_state, 'Allies who owe each other.');
  assert.match(r.body, /Free relationship notes\./);
  assert.deepEqual(r.developments.map((d) => d.scene), [KEY, FERRY]);
  assert.equal(r.developments[0].a_view, 'Maren trusts Pell a little.');
  assert.equal(r.developments[0].b_view, 'Pell fears what Maren will find.');
  assert.equal(r.developments[1].change, 'Maren pays Pell for passage.');
  assert.ok(r.developments.every((d) => typeof d.scene_title === 'string' && d.scene_title.length > 0));
  const one = await get(port, u('relationships', REL));
  assert.equal(one.status, 200, one.text);
  assert.deepEqual(one.json.developments, r.developments);
  assert.equal(one.json.sha256, r.sha256);
  assert.equal((await get(port, u('relationships', 'nobody'))).status, 404);
  assert.deepEqual(await rels((await freshBook()).port), { relationships: [], archived: [] }, 'a plain book has none');
});

test('relationship create: dry run writes nothing, real create is 201; duplicate in either order is 409 with existing; a = b and unknown entries are 400', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const dry = await post(port, u('relationships'), { a: MAREN, b: ILSE, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');

  const c = await post(port, u('relationships'), { a: MAREN, b: ILSE, fields: { baseline: 'Mother and daughter.' } });
  assert.equal(c.status, 201, c.text);
  assert.ok(c.json.opId);
  const made = (await rels(port)).relationships;
  assert.equal(made.length, 2);
  const mine = made.find((r) => r.slug === c.json.slug);
  assert.equal(mine.baseline, 'Mother and daughter.');
  assert.deepEqual(mine.developments, []);

  const snap = await readAll(root);
  for (const [a, b] of [[MAREN, PELL], [PELL, MAREN]]) {
    const dup = await post(port, u('relationships'), { a, b });
    assert.equal(dup.status, 409, dup.text);
    assert.equal(dup.json.code, 'REFUSED_DUPLICATE_RELATIONSHIP');
    assert.equal(dup.json.existing.slug, REL);
  }
  assert.equal((await post(port, u('relationships'), { a: MAREN, b: MAREN })).status, 400, 'a = b');
  assert.equal((await post(port, u('relationships'), { a: MAREN, b: 'entry_nope' })).status, 400, 'unknown entry');
  assert.equal((await post(port, u('relationships'), { a: MAREN })).status, 400, 'b is required');
  assertSame(snap, await readAll(root), 'refused creates');
});

test('developments: round trip keeps order, a_view and b_view; Undo restores the exact bytes; refusals write nothing', async () => {
  const { root, port } = await planner();
  const codex = await codexOf(root);
  const before = (await readAll(root)).get(REL_FILE);
  const r0 = await relOf(port);
  const input = [
    { scene: WALL, change: 'The wall divides them.', a_view: 'Maren is furious.', b_view: 'Pell is ashamed.' },
    { scene: KEY, change: 'Pell lends Maren the key.' },
    { scene: FERRY, change: 'Maren pays Pell for passage.' },
  ];
  const w = await post(port, u('relationships', REL, 'developments'), { developments: input, base_sha256: r0.sha256 });
  assert.equal(w.status, 200, w.text);
  assert.ok(w.json.opId);
  const r1 = await relOf(port);
  assert.deepEqual(r1.developments.map((d) => d.scene), [WALL, KEY, FERRY], 'order is kept');
  assert.equal(r1.developments[0].a_view, 'Maren is furious.');
  assert.equal(r1.developments[0].b_view, 'Pell is ashamed.');
  assert.equal(r1.developments[0].change, 'The wall divides them.');
  assert.ok(!r1.developments[1].a_view);
  assert.match(r1.body, /Free relationship notes\./, 'the body is kept');
  assert.equal(r1.baseline, r0.baseline);
  assertSame(codex, await codexOf(root), 'codex after the save');

  // stale base, unknown scene: refused with nothing written
  const snap = await readAll(root);
  const stale = await post(port, u('relationships', REL, 'developments'), { developments: input, base_sha256: r0.sha256 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.ok(stale.json.current, `409 carries current: ${stale.text}`);
  const unk = await post(port, u('relationships', REL, 'developments'), { developments: [{ scene: UNKNOWN_SCENE, change: 'x' }], base_sha256: r1.sha256 });
  assert.equal(unk.status, 400, unk.text);
  assert.equal(unk.json.code, 'REFUSED_UNKNOWN_SCENE');
  assert.equal((await post(port, u('relationships', REL, 'developments'), { developments: 'x', base_sha256: r1.sha256 })).status, 400);
  assert.equal((await post(port, u('relationships', REL, 'developments'), { developments: [] })).status, 400, 'base required');
  assertSame(snap, await readAll(root), 'refused saves');

  const un = await undo(port, w.json.opId);
  assert.equal(un.status, 200, un.text);
  assert.ok((await readAll(root)).get(REL_FILE).equals(before), 'bytes are back');
  assert.equal((await relOf(port)).sha256, r0.sha256);
});

test('relationship update with a base edits fields and body; archive then restore; Codex entry files are byte-identical throughout', async () => {
  const { root, port } = await planner();
  const codex = await codexOf(root);
  const r0 = await relOf(port);
  const e = await post(port, u('relationships', REL), { fields: { end_state: 'Estranged.' }, body: 'New notes.\n', base_sha256: r0.sha256 });
  assert.equal(e.status, 200, e.text);
  const r1 = await relOf(port);
  assert.equal(r1.end_state, 'Estranged.');
  assert.equal(r1.baseline, r0.baseline);
  assert.match(r1.body, /New notes\./);
  assert.deepEqual(r1.developments, r0.developments, 'developments kept');
  assert.equal((await post(port, u('relationships', REL), { fields: { end_state: 'x' } })).status, 400, 'base required');
  assert.equal((await post(port, u('relationships', REL), { fields: { end_state: 'x' }, base_sha256: r0.sha256 })).status, 409, 'stale base');

  const arch = await post(port, u('relationships', REL, 'archive'), {});
  assert.equal(arch.status, 200, arch.text);
  const l = await rels(port);
  assert.deepEqual(l.relationships, []);
  assert.deepEqual(l.archived.map((r) => r.slug), [REL]);
  assertSame(codex, await codexOf(root), 'after archive');
  const res = await post(port, u('relationships', REL, 'restore'), {});
  assert.equal(res.status, 200, res.text);
  const l2 = await rels(port);
  assert.deepEqual(l2.relationships.map((r) => r.slug), [REL]);
  assert.deepEqual(l2.archived, []);
  assert.deepEqual(l2.relationships[0].developments, r1.developments, 'developments survive');
  assertSame(codex, await codexOf(root), 'after restore');
});

test('links to beats: the fixture link is a beat edge; create scene -> beat; archive the structure; restore', async () => {
  const { port } = await planner();
  const flow = await flowOf(port);
  const beat = flow.nodes.find((n) => n.kind === 'beat');
  assert.ok(beat, 'the fixture link makes a beat node');
  assert.equal(beat.id, INCITING);
  assert.equal(beat.title, 'Inciting event');
  assert.equal(beat.structure.slug, 'main-three-act');
  assert.ok(flow.edges.some((e) => e.to === INCITING && e.from === KEY && e.broken === false));
  assert.equal(flow.nodes.filter((n) => n.kind === 'beat').length, 1, 'only beats used by live links');

  const s = await structOf(port, 'main-three-act');
  const opening = s.beats[0].id;
  const c = await post(port, u('links'), { from: FERRY, to: opening, relation: 'enables', rationale: 'The ferry shows the opening.' });
  assert.equal(c.status, 201, c.text);
  const row = (await linksOf(port)).links.find((l) => l.slug === c.json.slug);
  assert.equal(row.to_kind, 'beat');
  assert.equal(row.from_kind, 'scene');
  assert.equal(row.to_title, `${s.name}: Opening image`);
  assert.equal((await flowOf(port)).nodes.filter((n) => n.kind === 'beat').length, 2);
  assert.equal((await post(port, u('links'), { from: KEY, to: 'note_01S5ZZZZZZZZZZZZZZZZZZZZZZ', relation: 'enables' })).status, 400, 'an unknown end');

  // archive the structure: its beats stop resolving; the API reports the edges as broken
  assert.equal((await post(port, u('structures', 'main-three-act', 'archive'), {})).status, 200);
  const flow2 = await flowOf(port);
  assert.ok(!flow2.nodes.some((n) => n.kind === 'beat'), 'no beat node once the structure is archived');
  const edge = flow2.edges.find((e) => e.to === INCITING);
  assert.ok(edge, 'the edge is still returned');
  assert.equal(edge.broken, true, 'and is broken');
  const lk = (await linksOf(port)).links.find((l) => l.to === INCITING);
  assert.ok(lk.problems.some((p) => p.code === 'W303'), `the link reports W303: ${JSON.stringify(lk.problems)}`);

  assert.equal((await post(port, u('structures', 'main-three-act', 'restore'), {})).status, 200);
  const flow3 = await flowOf(port);
  assert.equal(flow3.nodes.filter((n) => n.kind === 'beat').length, 2);
  assert.ok(flow3.edges.every((e) => e.broken === false));
});

test('REFUSED_BEAT_LINKED: a live link then an archived link both block removal, with the slugs, and nothing is written', async () => {
  const { root, port } = await planner();
  const s = await structOf(port, 'main-three-act');
  const keep = keepAll(s, INCITING);
  const snap = await readAll(root);
  const r = await setBeats(port, 'main-three-act', keep, s.sha256);
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, 'REFUSED_BEAT_LINKED');
  assert.deepEqual(r.json.links, ['key-enables-inciting-event']);
  assert.deepEqual(r.json.archived_links, []);
  assertSame(snap, await readAll(root), 'refused (live link)');

  assert.equal((await post(port, u('links', 'key-enables-inciting-event', 'archive'), {})).status, 200);
  const snap2 = await readAll(root);
  const r2 = await setBeats(port, 'main-three-act', keep, s.sha256);
  assert.equal(r2.status, 400, r2.text);
  assert.equal(r2.json.code, 'REFUSED_BEAT_LINKED');
  assert.deepEqual(r2.json.links, []);
  assert.deepEqual(r2.json.archived_links, ['key-enables-inciting-event']);
  assertSame(snap2, await readAll(root), 'refused (archived link)');
});

test('plan-badges agree with /links, /arcs, /structures and /relationships (cross-view consistency)', async () => {
  const { port } = await planner();
  const b = await badgesOf(port);
  const links = (await linksOf(port)).links;
  const arcs = (await get(port, u('arcs'))).json.arcs;
  const structures = (await get(port, u('structures'))).json.structures;
  const relationships = (await rels(port)).relationships;
  assert.ok(Object.keys(b.scenes).length >= 5, 'every live scene has an entry');
  assert.deepEqual(b.arcs.map((a) => a.slug), arcs.map((a) => a.slug));
  assert.deepEqual(b.structures.map((s) => s.slug), structures.map((s) => s.slug));

  for (const id of [KEY, FERRY, WALL, ARRIVAL]) {
    const e = b.scenes[id];
    assert.ok(e, `${id} has badges`);
    assert.equal(e.links_out, links.filter((l) => l.from === id).length, `${id} links_out`);
    assert.equal(e.links_in, links.filter((l) => l.to === id).length, `${id} links_in`);
    const beatsHere = structures.flatMap((s) => s.beats.filter((x) => x.scenes.some((sc) => sc.id === id)).map((x) => x.id));
    assert.deepEqual(e.beats.map((x) => x.beat_id).sort(), beatsHere.sort(), `${id} beats`);
    const arcsHere = arcs.filter((a) => a.milestones.some((m) => m.scene === id)).map((a) => a.slug);
    assert.deepEqual(e.milestones.map((m) => m.arc_slug).sort(), arcsHere.sort(), `${id} milestones`);
    const relsHere = relationships.filter((r) => r.developments.some((d) => d.scene === id)).map((r) => r.slug);
    assert.deepEqual(e.relationships.map((r) => r.slug).sort(), relsHere.sort(), `${id} relationships`);
  }
  // concrete numbers for the fixture
  assert.equal(b.scenes[KEY].links_out, 2);
  assert.equal(b.scenes[KEY].beats.length, 2);
  assert.equal(b.scenes[KEY].milestones.length, 1);
  assert.deepEqual(b.scenes[KEY].relationships.map((r) => [r.slug, r.change]), [[REL, 'Pell lends Maren the key.']]);
  assert.equal(b.scenes[KEY].plan, true);
  assert.equal(b.scenes[FERRY].links_in, 1);
  assert.equal(b.scenes[FERRY].beats.length, 1);
  assert.deepEqual(b.scenes[FERRY].relationships.map((r) => r.slug), [REL]);
  assert.deepEqual(b.scenes[WALL], { plan: false, goal: null, purpose: null, links_in: 0, links_out: 0, beats: [], milestones: [], relationships: [] });
});

test('M5 gate: board move and thread S/D/P edits still work, and links, milestones, beats and relationships follow the scene by id', async () => {
  const { port } = await planner();
  const b0 = await badgesOf(port);
  const links0 = (await linksOf(port)).links.map((l) => [l.slug, l.from, l.to]);

  const mv = await move(port, KEY, { chapter: 3, after: WALL });
  assert.equal(mv.status, 200, mv.text);
  const b1 = await badgesOf(port);
  assert.deepEqual(b1.scenes[KEY], b0.scenes[KEY], 'the moved scene keeps every badge');
  assert.deepEqual(Object.keys(b1.scenes).sort(), Object.keys(b0.scenes).sort());
  assert.deepEqual((await linksOf(port)).links.map((l) => [l.slug, l.from, l.to]), links0);
  assert.ok((await flowOf(port)).edges.every((e) => e.broken === false));
  assert.deepEqual((await relOf(port)).developments.map((d) => d.scene), [KEY, FERRY]);

  const add = await post(port, u('threads', THREAD_ID, 'fields'), { add: { develop: [GRAFTING] } });
  assert.equal(add.status, 200, add.text);
  let th = (await get(port, u('threads', THREAD_ID))).json;
  assert.ok(th.develop.includes(GRAFTING), JSON.stringify(th));
  const rem = await post(port, u('threads', THREAD_ID, 'fields'), { remove: { develop: [GRAFTING] } });
  assert.equal(rem.status, 200, rem.text);
  th = (await get(port, u('threads', THREAD_ID))).json;
  assert.ok(!(th.develop ?? []).includes(GRAFTING));
  const list = await get(port, u('threads'));
  assert.equal(list.status, 200);
  assert.ok(list.json.threads.some((t) => t.id === THREAD_ID));
  assert.deepEqual((await badgesOf(port)).scenes[KEY], b0.scenes[KEY], 'badges unchanged after the thread edits');
});

test('module planner off: POST /relationships is 403 MODULE_OFF; a plugin token gets 403 PLUGIN_SCOPE on relationships and plan-badges', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const w = await t.member('POST', u('relationships'), { a: MAREN, b: PELL });
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);

  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before2 = await readAll(t.root);
  for (const [method, p, body] of [
    ['GET', u('relationships')],
    ['GET', u('plan-badges')],
    ['POST', u('relationships'), { a: MAREN, b: PELL }],
  ]) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before2, await readAll(t.root), 'plugin boundary');
});

test('only planning/ changes: scene, Codex and book.md bytes are identical after every M5 planning write', async () => {
  const { root, port } = await planner();
  const before = await nonPlanning(root);
  const c = await post(port, u('relationships'), { a: MAREN, b: ILSE, fields: { baseline: 'b' } });
  assert.equal(c.status, 201, c.text);
  const r = await relOf(port, c.json.slug);
  assert.equal((await post(port, u('relationships', c.json.slug, 'developments'), { developments: [{ scene: ARRIVAL, change: 'x', a_view: 'y' }], base_sha256: r.sha256 })).status, 200);
  const r2 = await relOf(port, c.json.slug);
  assert.equal((await post(port, u('relationships', c.json.slug), { fields: { end_state: 'z' }, base_sha256: r2.sha256 })).status, 200);
  assert.equal((await post(port, u('relationships', c.json.slug, 'archive'), {})).status, 200);
  assert.equal((await post(port, u('relationships', c.json.slug, 'restore'), {})).status, 200);
  const s = await structOf(port, 'main-three-act');
  assert.equal((await post(port, u('links'), { from: FERRY, to: s.beats[0].id, relation: 'enables', rationale: 'r' })).status, 201);
  assert.equal((await post(port, u('relationships', REL, 'archive'), {})).status, 200);
  assertSame(before, await nonPlanning(root), 'non-planning files');
  const end = await readAll(root);
  assert.ok([...end.keys()].filter((p) => p.startsWith('planning/')).every((p) => /^planning\/(links|relationships|structures|synopses|clues|arcs|threads|timeline|scene-plans|archive)\/|^planning\/(plan|story)\.md$/.test(p)));
});
