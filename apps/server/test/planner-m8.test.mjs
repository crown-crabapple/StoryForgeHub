// Story Planner M8 routes (ADR 0003, "M8 decisions"): clues, link branches, PL5/PL6, the series view, the planning export and the read-only plugin API.
//   GET  /api/books/:b/clues | /clues/:slug | /series-plan | /export/planning | /flow | /continuity
//   POST /api/books/:b/clues | /clues/:slug | /clues/:slug/knowers | /clues/:slug/archive | /clues/:slug/restore, POST /links, POST /links/:slug, POST /ops/:opId/restore
//   GET  /api/v1/books/:b/plan | /plan/{links,arcs,structures,relationships,synopses,clues}
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { unzip } from '../../../packages/export/src/index.mjs';
import { createAudit, openSettings, openSharedData } from '../../../packages/shared/src/index.mjs';
import { classifyRead } from '../src/policy.mjs';
import { createServer } from '../src/server.mjs';
import { createSharedGate } from '../src/shared-gate.mjs';
import { ARRIVAL, BOOK, FERRY, KEY, WALL, closeAll, freshBook, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin, raw } from './plugin-helpers.mjs';
import { PW, boot as bootShared, call, closeAll as closeShared, cookieOf } from './shared-helpers.mjs';
import { close, copyFixture, listen } from './helpers.mjs';

const extraServers = [];
after(async () => {
  await closeAll();
  await closePlugin();
  await closeShared();
  for (const s of extraServers.splice(0)) await close(s);
});

const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const UNKNOWN_ENTRY = 'entry_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const MAREN = 'entry_01S5000000000000000000000G';
const PROLOGUE = 'scene_01S50000000000000000000001';
const SLUG = 'sea-gate-key';
const FILE = 'planning/clues/sea-gate-key.md';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const planner = () => freshBook('valid/planner');
const clueOf = async (port, slug = SLUG) => (await get(port, u('clues', slug))).json;
const listed = async (port) => (await get(port, u('clues'))).json;
const rulesOf = async (port, rule) => (await get(port, u('continuity'))).json.findings.filter((f) => f.rule === rule);

const isClueFile = (p) => p.startsWith('planning/clues/') || p.startsWith('archive/planning/clues/');
const outside = async (root) => new Map([...(await readAll(root))].filter(([p]) => !isClueFile(p)));
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------ clues

test('clues: list and get read the fixture clue exactly; missing slug and unknown book are 404', async () => {
  const { port } = await planner();
  const l = await listed(port);
  assert.deepEqual(l.archived, []);
  assert.equal(l.clues.length, 1);
  const c = l.clues[0];
  assert.equal(c.slug, SLUG);
  assert.equal(c.path, FILE);
  assert.equal(c.fact, 'The harbour key opens the sea gate.');
  assert.equal(c.kind, 'clue');
  assert.equal(c.red_herring, false);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.planted.map((s) => s.id), [ARRIVAL, KEY]);
  assert.equal(c.revealed.id, FERRY);
  assert.deepEqual(c.problems, []);
  assert.equal(c.knowers.length, 2);
  assert.deepEqual(c.knowers[0].who, { id: 'reader', name: null, reader: true });
  assert.equal(c.knowers[0].scene.id, FERRY);
  assert.equal(c.knowers[0].reliable, true);
  assert.equal(c.knowers[1].who.id, MAREN);
  assert.equal(c.knowers[1].who.name, 'Maren Hollis');
  assert.equal(c.knowers[1].reliable, false);
  const one = await get(port, u('clues', SLUG));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.sha256, c.sha256);
  assert.equal(one.json.fact, c.fact);
  assert.match(one.json.body, /Free clue notes\./);
  assert.equal((await get(port, u('clues', 'nobody'))).status, 404);
  assert.equal((await get(port, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/clues')).status, 404);
});

test('create: 201 then get; kind defaults to clue; dry run and every refusal write nothing', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const dry = await post(port, u('clues'), { fact: 'Dry fact', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');

  const bad = [
    [{ fact: 'x', kind: 'nope' }, 400, 'REFUSED_BAD_ARGS'],
    [{ fact: 'x', fields: { planted: [UNKNOWN_SCENE] } }, 400, 'REFUSED_UNKNOWN_SCENE'],
    [{ fact: 'x', fields: { revealed: UNKNOWN_SCENE } }, 400, 'REFUSED_UNKNOWN_SCENE'],
    [{ fact: 'x', fields: { knowers: [] } }, 400, 'REFUSED_BAD_ARGS'], // knowers have their own route
    [{ fact: 5 }, 400, undefined],
    [{}, 400, undefined],
    [{ fact: 'x', fields: 'nope' }, 400, undefined],
  ];
  for (const [body, status, code] of bad) {
    const r = await post(port, u('clues'), body);
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
    if (code) assert.equal(r.json.code, code, JSON.stringify(body));
  }
  assertSame(before, await readAll(root), 'refused creates');

  const c = await post(port, u('clues'), { fact: 'The ferryman is not who he says' });
  assert.equal(c.status, 201, c.text);
  assert.ok(c.json.opId);
  assert.match(c.json.path, /^planning\/clues\/.+\.md$/);
  const g = await clueOf(port, c.json.slug);
  assert.equal(g.fact, 'The ferryman is not who he says');
  assert.equal(g.kind, 'clue');
  assert.deepEqual(g.planted, []);
  assert.equal(g.revealed, null);
  assert.deepEqual(g.knowers, []);
  assert.equal((await listed(port)).clues.length, 2);

  const full = await post(port, u('clues'), { fact: 'Pell is the thief', kind: 'secret', fields: { planted: [ARRIVAL], revealed: WALL, red_herring: true } });
  assert.equal(full.status, 201, full.text);
  const f = await clueOf(port, full.json.slug);
  assert.equal(f.kind, 'secret');
  assert.equal(f.red_herring, true);
  assert.deepEqual(f.planted.map((s) => s.id), [ARRIVAL]);
  assert.equal(f.revealed.id, WALL);
});

test('update: base_sha256 required and checked; edits fields and body; stale base is 409 with current; refusals write nothing', async () => {
  const { root, port } = await planner();
  const s0 = await clueOf(port);
  const before = await readAll(root);
  for (const [bad, status, code] of [
    [{ fields: { kind: 'reveal' } }, 400, undefined],
    [{ fields: { kind: 'nope' }, base_sha256: s0.sha256 }, 400, 'REFUSED_BAD_ARGS'],
    [{ fields: { planted: [UNKNOWN_SCENE] }, base_sha256: s0.sha256 }, 400, 'REFUSED_UNKNOWN_SCENE'],
    [{ body: 7, base_sha256: s0.sha256 }, 400, undefined],
  ]) {
    const r = await post(port, u('clues', SLUG), bad);
    assert.equal(r.status, status, `${JSON.stringify(bad)}: ${r.text}`);
    if (code) assert.equal(r.json.code, code);
  }
  assertSame(before, await readAll(root), 'refused updates');

  const dry = await post(port, u('clues', SLUG), { fields: { kind: 'reveal' }, base_sha256: s0.sha256, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assertSame(before, await readAll(root), 'dry run');

  const w = await post(port, u('clues', SLUG), { fields: { kind: 'reveal', red_herring: true }, body: 'Rewritten notes.\n', base_sha256: s0.sha256 });
  assert.equal(w.status, 200, w.text);
  const s1 = await clueOf(port);
  assert.equal(s1.kind, 'reveal');
  assert.equal(s1.red_herring, true);
  assert.match(s1.body, /Rewritten notes\./);
  assert.notEqual(s1.sha256, s0.sha256);
  assert.equal(s1.fact, s0.fact, 'untouched fields kept');
  assert.deepEqual(s1.knowers, s0.knowers, 'knowers kept');
  assert.equal(s1.revealed.id, FERRY);

  const old = await post(port, u('clues', SLUG), { fields: { kind: 'secret' }, base_sha256: s0.sha256 });
  assert.equal(old.status, 409, old.text);
  assert.equal(old.json.error, 'conflict');
  assert.ok(old.json.current);
  assert.equal((await clueOf(port)).kind, 'reveal', 'stale write changed nothing');
  assert.equal((await post(port, u('clues', 'nobody'), { fields: { kind: 'reveal' }, base_sha256: s0.sha256 })).status, 404);
});

test('knowers: replace the list; reader and unreliable entries round-trip; unknown entry and scene are refused; stale is 409', async () => {
  const { root, port } = await planner();
  const s0 = await clueOf(port);
  const before = await readAll(root);
  const entry = (who, scene) => ({ knowers: [{ who, scene }], base_sha256: s0.sha256 });
  const unknownEntry = await post(port, u('clues', SLUG, 'knowers'), entry(UNKNOWN_ENTRY, FERRY));
  assert.equal(unknownEntry.status, 400, unknownEntry.text);
  assert.equal(unknownEntry.json.code, 'REFUSED_UNKNOWN_ENTRY');
  const unknownScene = await post(port, u('clues', SLUG, 'knowers'), entry('reader', UNKNOWN_SCENE));
  assert.equal(unknownScene.status, 400, unknownScene.text);
  assert.equal(unknownScene.json.code, 'REFUSED_UNKNOWN_SCENE');
  assert.equal((await post(port, u('clues', SLUG, 'knowers'), { knowers: [{ who: 'reader', scene: FERRY }] })).status, 400, 'base_sha256 required');
  assert.equal((await post(port, u('clues', SLUG, 'knowers'), { knowers: 'nope', base_sha256: s0.sha256 })).status, 400, 'knowers must be a list');
  assertSame(before, await readAll(root), 'refused knowers');

  const set = await post(port, u('clues', SLUG, 'knowers'), {
    knowers: [{ who: 'reader', scene: KEY, how: 'Shown in close-up.' }, { who: MAREN, scene: FERRY, reliable: false }],
    base_sha256: s0.sha256,
  });
  assert.equal(set.status, 200, set.text);
  const s1 = await clueOf(port);
  assert.equal(s1.knowers.length, 2);
  assert.equal(s1.knowers[0].who.reader, true);
  assert.equal(s1.knowers[0].scene.id, KEY);
  assert.equal(s1.knowers[0].how, 'Shown in close-up.');
  assert.equal(s1.knowers[1].who.id, MAREN);
  assert.equal(s1.knowers[1].reliable, false);
  assert.equal(s1.fact, s0.fact, 'only the knowers changed');
  assert.deepEqual(s1.planted, s0.planted);

  const stale = await post(port, u('clues', SLUG, 'knowers'), { knowers: [], base_sha256: s0.sha256 });
  assert.equal(stale.status, 409, stale.text);
  const cleared = await post(port, u('clues', SLUG, 'knowers'), { knowers: [], base_sha256: s1.sha256 });
  assert.equal(cleared.status, 200, cleared.text);
  assert.deepEqual((await clueOf(port)).knowers, [], 'an empty list clears the knowers');
});

test('archive then restore round trip; the archived list shows it while archived', async () => {
  const { root, port } = await planner();
  const a = await post(port, u('clues', SLUG, 'archive'), {});
  assert.equal(a.status, 200, a.text);
  const l = await listed(port);
  assert.equal(l.clues.length, 0);
  assert.equal(l.archived.length, 1);
  assert.equal(l.archived[0].slug, SLUG);
  assert.ok(!(await readAll(root)).has(FILE));
  const viaGet = await get(port, u('clues', SLUG));
  assert.equal(viaGet.status, 200, 'an archived clue can still be read by slug');
  assert.equal(viaGet.json.archived, true);
  const r = await post(port, u('clues', SLUG, 'restore'), {});
  assert.equal(r.status, 200, r.text);
  const l2 = await listed(port);
  assert.deepEqual(l2.archived, []);
  assert.equal(l2.clues[0].slug, SLUG);
  assert.ok((await readAll(root)).has(FILE));
  assert.equal((await post(port, u('clues', 'nobody', 'archive'), {})).status, 404);
});

test('undo of a create removes the file and leaves the library as it was', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const c = await post(port, u('clues'), { fact: 'Temporary clue' });
  assert.equal(c.status, 201, c.text);
  assert.ok((await readAll(root)).has(c.json.path));
  const un = await post(port, u('ops', encodeURIComponent(c.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  assert.ok(!(await readAll(root)).has(c.json.path), 'file removed');
  assertSame(before, await readAll(root), 'after undo');
});

test('only clue files change: every clue write leaves all other files byte-identical', async () => {
  const { root, port } = await planner();
  const before = await outside(root);
  const c = await post(port, u('clues'), { fact: 'Another clue', fields: { planted: [ARRIVAL], revealed: FERRY } });
  assert.equal(c.status, 201, c.text);
  const g = await clueOf(port, c.json.slug);
  assert.equal((await post(port, u('clues', c.json.slug, 'knowers'), { knowers: [{ who: 'reader', scene: FERRY }, { who: MAREN, scene: KEY }], base_sha256: g.sha256 })).status, 200);
  const g2 = await clueOf(port, c.json.slug);
  assert.equal((await post(port, u('clues', c.json.slug), { fields: { kind: 'secret' }, body: 'Notes.\n', base_sha256: g2.sha256 })).status, 200);
  assert.equal((await post(port, u('clues', c.json.slug, 'archive'), {})).status, 200);
  assert.equal((await post(port, u('clues', c.json.slug, 'restore'), {})).status, 200);
  assert.equal((await post(port, u('clues', SLUG, 'archive'), {})).status, 200);
  assertSame(before, await outside(root), 'files outside planning/clues');
});

// ------------------------------------------------------------------------------------------------------------------------------ link branches

test('links with a branch: 201; same triple on main is allowed; same triple and branch is 409; bad branch is 400; flow carries branch and branches', async () => {
  const { root, port } = await planner();
  const link = (extra) => post(port, u('links'), { from: ARRIVAL, to: WALL, relation: 'therefore', ...extra });
  const b1 = await link({ branch: 'ferry-sinks' });
  assert.equal(b1.status, 201, b1.text);
  const main = await link({});
  assert.equal(main.status, 201, 'the same triple on the main plan is a different link');
  assert.notEqual(main.json.slug, b1.json.slug);

  const before = await readAll(root);
  const dup = await link({ branch: 'ferry-sinks' });
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, 'REFUSED_DUPLICATE_LINK');
  assert.equal(dup.json.existing.slug, b1.json.slug);
  assert.equal((await link({})).status, 409, 'a second main link with the same triple is a duplicate too');
  assert.equal((await link({ branch: 'other-branch' })).status, 201, 'another branch is another link');
  const wasWritten = await readAll(root);
  assert.equal(wasWritten.size, before.size + 1, 'only the allowed branch link was written');

  const files = await readAll(root);
  const countNow = files.size;
  for (const branch of ['Bad Branch!', 'UPPER', 'a--b', '-lead', 'trail-', 'x'.repeat(41), 5]) {
    const r = await link({ branch });
    assert.equal(r.status, 400, `${JSON.stringify(branch)}: ${r.text}`);
  }
  assert.equal((await readAll(root)).size, countNow, 'bad branches write nothing');

  const flow = (await get(port, u('flow'))).json;
  assert.deepEqual(flow.branches, ['ferry-sinks', 'other-branch']);
  const e = (slug) => flow.edges.find((x) => x.slug === slug);
  assert.equal(e(b1.json.slug).branch, 'ferry-sinks');
  assert.equal(e(main.json.slug).branch, null);
  const fixtureEdge = flow.edges.find((x) => x.slug === 'key-therefore-ferry');
  assert.equal(fixtureEdge.branch, null, 'links without a branch are main');
  const l = (await get(port, u('links'))).json.links;
  assert.equal(l.find((x) => x.slug === b1.json.slug).branch, 'ferry-sinks');
});

test('flow: with no branch links, branches is empty', async () => {
  const { port } = await planner();
  const flow = (await get(port, u('flow'))).json;
  assert.deepEqual(flow.branches, []);
  assert.ok(flow.edges.every((x) => x.branch === null));
});

test('update link branch: null moves it to main; 409 if main already has that triple; a new branch name is accepted; bad branch is 400', async () => {
  const { port } = await planner();
  const mk = async (relation, branch) => {
    const r = await post(port, u('links'), { from: ARRIVAL, to: WALL, relation, branch });
    assert.equal(r.status, 201, r.text);
    return r.json.slug;
  };
  const shaOf = async (slug) => (await get(port, u('links'))).json.links.find((x) => x.slug === slug).sha256;
  const branchOf = async (slug) => (await get(port, u('links'))).json.links.find((x) => x.slug === slug).branch;

  const movable = await mk('but', 'ferry-sinks');
  const bad = await post(port, u('links', movable), { branch: 'Not A Slug', base_sha256: await shaOf(movable) });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(await branchOf(movable), 'ferry-sinks');
  const renamed = await post(port, u('links', movable), { branch: 'wall-holds', base_sha256: await shaOf(movable) });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(await branchOf(movable), 'wall-holds');
  const moved = await post(port, u('links', movable), { branch: null, base_sha256: await shaOf(movable) });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(await branchOf(movable), null);
  let flow = (await get(port, u('flow'))).json;
  assert.equal(flow.edges.find((x) => x.slug === movable).branch, null);
  assert.deepEqual(flow.branches, [], 'the branch disappears when its last link leaves');

  const onMain = await mk('therefore', null);
  const onBranch = await mk('therefore', 'ferry-sinks');
  const before = await shaOf(onBranch);
  const dup = await post(port, u('links', onBranch), { branch: null, base_sha256: before });
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, 'REFUSED_DUPLICATE_LINK');
  assert.equal(dup.json.existing.slug, onMain);
  assert.equal(await branchOf(onBranch), 'ferry-sinks', 'a refused move changed nothing');
  assert.equal(await shaOf(onBranch), before);
  flow = (await get(port, u('flow'))).json;
  assert.deepEqual(flow.branches, ['ferry-sinks']);
});

// ----------------------------------------------------------------------------------------------------------------------------------- continuity

test('continuity PL5/PL6: the fixture clue raises neither; revealed before planted is a PL6 warning; planted but never revealed is a PL5 info', async () => {
  const { port } = await planner();
  assert.deepEqual(await rulesOf(port, 'PL5'), [], 'fixture: planted early, revealed later');
  assert.deepEqual(await rulesOf(port, 'PL6'), []);

  const late = await post(port, u('clues'), { fact: 'Late plant', fields: { planted: [WALL], revealed: ARRIVAL } });
  assert.equal(late.status, 201, late.text);
  const pl6 = await rulesOf(port, 'PL6');
  assert.equal(pl6.length, 1);
  assert.equal(pl6[0].severity, 'warning');
  assert.match(pl6[0].fingerprint, /^pl6-/);
  assert.match(pl6[0].title, /Late plant/);
  assert.deepEqual(await rulesOf(port, 'PL5'), [], 'a clue with a reveal is not PL5');

  const open = await post(port, u('clues'), { fact: 'Open thread', fields: { planted: [KEY] } });
  assert.equal(open.status, 201, open.text);
  const pl5 = await rulesOf(port, 'PL5');
  assert.equal(pl5.length, 1);
  assert.equal(pl5[0].severity, 'info');
  assert.match(pl5[0].title, /Open thread/);
  assert.equal((await rulesOf(port, 'PL6')).length, 1, 'PL6 unchanged');

  // fixing the order removes the PL6 finding: the reveal moves to a later scene
  const g = await clueOf(port, late.json.slug);
  assert.equal((await post(port, u('clues', late.json.slug), { fields: { revealed: null }, base_sha256: g.sha256 })).status, 200);
  assert.deepEqual(await rulesOf(port, 'PL6'), [], 'no reveal, no PL6');
  assert.equal((await rulesOf(port, 'PL5')).length, 2, 'it is now planted-never-revealed instead');
});

test('continuity PL5/PL6 boundaries: a red herring, a clue with no plant, and a same-scene plant and reveal raise nothing', async () => {
  const { port } = await planner();
  const mk = async (fact, fields) => assert.equal((await post(port, u('clues'), { fact, fields })).status, 201);
  await mk('Herring', { planted: [KEY], red_herring: true });
  await mk('No plant', { revealed: FERRY });
  await mk('Nothing yet', {});
  await mk('Same scene', { planted: [KEY], revealed: KEY });
  await mk('Prologue plant', { planted: [PROLOGUE], revealed: ARRIVAL });
  assert.deepEqual(await rulesOf(port, 'PL5'), []);
  assert.deepEqual(await rulesOf(port, 'PL6'), []);
});

test('continuity: branch links never change PL1/PL2; a main link does', async () => {
  const { port } = await planner();
  const keyOf = async () => (await get(port, u('continuity'))).json.findings.filter((f) => f.rule === 'PL1' || f.rule === 'PL2').map((f) => f.fingerprint).sort();
  const base = await keyOf();
  assert.ok(base.length > 0, 'the fixture has scenes outside the flow (PL1)');
  const b = await post(port, u('links'), { from: ARRIVAL, to: WALL, relation: 'therefore', branch: 'ferry-sinks' });
  assert.equal(b.status, 201, b.text);
  assert.deepEqual(await keyOf(), base, 'a branch link leaves PL1/PL2 exactly as they were');
  const b2 = await post(port, u('links'), { from: PROLOGUE, to: WALL, relation: 'but', branch: 'ferry-sinks' });
  assert.equal(b2.status, 201, b2.text);
  assert.deepEqual(await keyOf(), base, 'a second branch link too');

  const main = await post(port, u('links'), { from: ARRIVAL, to: WALL, relation: 'therefore' });
  assert.equal(main.status, 201, main.text);
  const after2 = await keyOf();
  assert.ok(after2.length < base.length, 'a main link takes scenes into the flow');
});

// ------------------------------------------------------------------------------------------------------------------------------------ series

const SO = 'book_01W10000000000000000000006'; // Salt Orchard Two, series_number 1
const LT = 'book_01W1000000000000000000000A'; // Low Tide, series_number 2
const ILSE = 'entry_01W10000000000000000000003'; // a series-shared character
const sp = (book) => `/api/books/${book}/series-plan`;

test('series-plan: a standalone book is { series: null, hidden: 0 }; an unknown book is 404', async () => {
  const { port } = await planner();
  const r = await get(port, u('series-plan'));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { series: null, hidden: 0 });
  assert.equal((await get(port, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/series-plan')).status, 404);
});

test('series-plan: a series lists its books by series_number with logline, premise, synopsis and shared arcs; the same from either book; writes nothing', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const m = (method, p, body) => t.member(method, p, body);
  const bare = await m('GET', sp(LT));
  assert.equal(bare.status, 200, bare.text);
  assert.equal(bare.json.hidden, 0);
  assert.deepEqual(bare.json.series, { slug: 'tidewater', title: 'The Tidewater Books' });
  assert.deepEqual(bare.json.books.map((b) => [b.id, b.series_number]), [[SO, 1], [LT, 2]], 'ordered by series_number, not by request');
  assert.deepEqual(bare.json.books[0], { id: SO, slug: 'salt-orchard-2', title: 'Salt Orchard Two', series_number: 1, logline: null, premise: null, synopsis: null, arcs: [] });
  assert.deepEqual(bare.json.characters, []);

  assert.equal((await m('POST', `/api/books/${LT}/story-plan`, { fields: { logline: 'Ilse looks for the ledger.', premise: 'A lamp keeper left something behind.' }, base_sha256: null })).status, 200);
  assert.equal((await m('POST', `/api/books/${SO}/synopses`, { type: 'short', body: 'A short synopsis.\n' })).status, 201);
  assert.equal((await m('POST', `/api/books/${SO}/synopses`, { type: 'one-page', body: 'The one-page text.\n' })).status, 201);
  const arcOne = await m('POST', `/api/books/${SO}/arcs`, { character: ILSE, arc_type: 'flat', fields: { start_state: 'Keeper of the lamp.', end_state: 'Gone.' } });
  assert.equal(arcOne.status, 201, arcOne.text);
  const arcTwo = await m('POST', `/api/books/${LT}/arcs`, { character: ILSE, arc_type: 'flat', fields: { start_state: 'A name in a ledger.' } });
  assert.equal(arcTwo.status, 201, arcTwo.text);

  const before = await readAll(t.root);
  const plan = await m('GET', sp(SO));
  assert.equal(plan.status, 200, plan.text);
  assert.deepEqual([...(await readAll(t.root)).keys()].sort(), [...before.keys()].sort(), 'GET adds no file');
  const [one, two] = plan.json.books;
  assert.equal(one.logline, null);
  assert.equal(two.logline, 'Ilse looks for the ledger.');
  assert.equal(two.premise, 'A lamp keeper left something behind.');
  assert.equal(one.synopsis.type, 'one-page', 'the one-page synopsis wins over short');
  assert.equal(one.synopsis.body, 'The one-page text.');
  assert.equal(two.synopsis, null);
  assert.equal(one.arcs.length, 1);
  assert.equal(one.arcs[0].character.id, ILSE);
  assert.equal(one.arcs[0].start, 'Keeper of the lamp.');
  assert.equal(one.arcs[0].end, 'Gone.');
  assert.equal(two.arcs[0].end, null);
  assert.equal(plan.json.characters.length, 1);
  assert.equal(plan.json.characters[0].id, ILSE);
  assert.deepEqual(plan.json.characters[0].books.map((b) => b.id), [SO, LT], 'one character, its arcs joined across books in series order');
  assert.deepEqual((await m('GET', sp(LT))).json, plan.json, 'the same from either book');
  assert.equal(plan.json.hidden, 0);
});

/** A shared-mode server over tidewater with an owner and one member limited to Salt Orchard Two. */
async function bootSeries() {
  const root = await copyFixture('valid/tidewater');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-data-'));
  const data = await openSharedData(dir);
  const settings = await openSettings(dir);
  const audit = createAudit(dir);
  const gate = createSharedGate({ data, publicUrl: null, bindHost: '127.0.0.1', aiForMembers: () => settings.get().ai_for_members, audit: (e) => audit.append(e) });
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  await repository.rebuildIndex();
  const server = createServer({ repository, shared: { gate, data, settings, audit: (e) => audit.append(e), publicUrl: null, dir } });
  extraServers.push(server);
  const port = await listen(server);
  const init = await data.initOwner('ilse', 'Ilse');
  const setup = await call(port, 'POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
  assert.equal(setup.status, 200, setup.text);
  const owner = cookieOf(setup, 'sf_session');
  const inv = await call(port, 'POST', '/api/shared/invites', { cookie: owner, body: { role: 'editor' } });
  const acc = await call(port, 'POST', '/api/auth/invite/accept', { body: { token: inv.json.link.split('#token=')[1], username: 'maren', display_name: 'maren', password: PW } });
  assert.equal(acc.status, 200, acc.text);
  const maren = cookieOf(acc, 'sf_session');
  return { port, root, owner, maren, userId: acc.json.user.id };
}

test('series-plan in shared mode: a member limited to one book gets only that book and a hidden count; the owner and an unlimited member get both', async () => {
  const t = await bootSeries();
  const as = (cookie, p) => call(t.port, 'GET', p, { cookie });
  // an arc of the shared character in each book, written by the owner, so there is something to join and to hide
  for (const book of [SO, LT]) {
    const r = await call(t.port, 'POST', `/api/books/${book}/arcs`, { cookie: t.owner, body: { character: ILSE, arc_type: 'flat', fields: { start_state: `Start in ${book.slice(-1)}` } } });
    assert.equal(r.status, 201, r.text);
  }
  const full = await as(t.owner, sp(SO));
  assert.equal(full.status, 200, full.text);
  assert.equal(full.json.hidden, 0);
  assert.deepEqual(full.json.books.map((b) => b.id), [SO, LT]);

  const unlimited = await as(t.maren, sp(SO));
  assert.equal(unlimited.status, 200, unlimited.text);
  assert.deepEqual(unlimited.json.books.map((b) => b.id), [SO, LT], 'a member with no book list sees the series');
  assert.equal(unlimited.json.hidden, 0);

  const set = await call(t.port, 'PUT', `/api/shared/members/${t.userId}`, { cookie: t.owner, body: { books: { [SO]: 'editor' } } });
  assert.equal(set.status, 200, set.text);
  const r = await as(t.maren, sp(SO));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.books.map((b) => b.id), [SO]);
  assert.equal(r.json.hidden, 1);
  assert.equal(r.json.series.slug, 'tidewater');
  assert.equal(r.text.includes(LT), false, 'the hidden book id appears nowhere');
  assert.equal(r.text.includes('Low Tide'), false, 'nor its title');
  assert.equal(r.json.characters.length, 1);
  assert.deepEqual(r.json.characters[0].books.map((b) => b.id), [SO], 'the joined character lists only the readable book');

  const other = await as(t.maren, sp(LT));
  assert.equal(other.status, 403, 'the series view of a book they cannot read is refused');
  assert.equal(other.text.includes('Salt Orchard Two'), false);
});

// -------------------------------------------------------------------------------------------------------------------------- planning export

const unzipBody = (res) => unzip(res.bytes);

test('export/planning: a zip of Markdown files under <slug>-planning/, content-type and filename set, and nothing is written', async () => {
  const { root, port } = await planner();
  const before = await readAll(root);
  const res = await raw(port, 'GET', u('export', 'planning'));
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.match(res.headers['content-type'], /^application\/zip/);
  assert.match(res.headers['content-disposition'] ?? '', /salt-orchard-planning\.zip/);
  const files = unzipBody(res);
  const names = [...files.keys()].sort();
  assert.deepEqual(names, ['characters.md', 'clues.md', 'links.md', 'outline.md', 'story-plan.md', 'structure.md', 'synopses/one-page.md'].map((n) => `salt-orchard-planning/${n}`).sort());
  const text = (n) => files.get(`salt-orchard-planning/${n}`).toString('utf8');
  assert.match(text('story-plan.md'), /An apprentice finds that the harbour key opens the wrong door\./);
  assert.match(text('outline.md'), /Maren steps off the ferry into the flooded rows\./);
  assert.match(text('characters.md'), /Maren Hollis/);
  assert.match(text('structure.md'), /Opening image/);
  assert.match(text('clues.md'), /The harbour key opens the sea gate\./);
  assert.match(text('links.md'), /The Key/);
  assert.match(text('synopses/one-page.md'), /Free synopsis text\./);
  assertSame(before, await readAll(root), 'export');
});

test('export/planning: branch links and new clues reach the export; the manuscript export carries no planning', async () => {
  const { port } = await planner();
  assert.equal((await post(port, u('clues'), { fact: 'Brand new fact' })).status, 201);
  assert.equal((await post(port, u('links'), { from: ARRIVAL, to: WALL, relation: 'therefore', branch: 'ferry-sinks' })).status, 201);
  const files = unzipBody(await raw(port, 'GET', u('export', 'planning')));
  assert.match(files.get('salt-orchard-planning/clues.md').toString('utf8'), /Brand new fact/);
  assert.match(files.get('salt-orchard-planning/links.md').toString('utf8'), /ferry-sinks/);
  const manuscript = await raw(port, 'GET', `${u('export')}?format=markdown`);
  assert.equal(manuscript.status, 200);
  assert.ok(!manuscript.text.includes('Brand new fact'), 'planning stays out of the manuscript export');
});

test('export/planning: unknown book is 404; the policy marks it private (never shareable)', async () => {
  const { port } = await planner();
  assert.equal((await get(port, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/export/planning')).status, 404);
  assert.deepEqual(classifyRead('/api/books/x/export/planning'), { cls: 'read', book: 'x', shareable: false });
});

test('shared mode: a share link, even with the export scope, gets 403 on export/planning, clues and series-plan; the owner gets 200', async () => {
  const t = await bootShared();
  for (const p of ['export/planning', 'clues', 'series-plan']) {
    const url = `/api/books/${BOOK}/${p}`;
    assert.equal((await t.call('GET', url, { cookie: t.c.owner })).status, 200, `owner ${p}`);
    for (const who of ['share', 'exportShare']) {
      const r = await t.call('GET', url, { cookie: t.c[who] });
      assert.equal(r.status, 403, `${who} ${p}: ${r.text.slice(0, 120)}`);
    }
    assert.equal((await t.call('GET', url)).status, 401, `anonymous ${p}`);
  }
  const before = await readAll(t.root);
  const w = await t.call('POST', `/api/books/${BOOK}/clues`, { cookie: t.c.exportShare, body: { fact: 'nope' } });
  assert.equal(w.status, 403, w.text);
  assert.deepEqual([...(await readAll(t.root)).keys()].sort(), [...before.keys()].sort());
});

// ----------------------------------------------------------------------------------------------------------------------------- plugin API v1

const PLAN_PATHS = ['', '/links', '/arcs', '/structures', '/relationships', '/synopses', '/clues'];
const keysAnywhere = (v, found = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysAnywhere(x, found));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (found.add(k), keysAnywhere(x, found));
  return found;
};

test('plugin v1 plan routes: 200 for a read token with the book; JSON has no path, file, rel or base_sha256 key at any depth (sha256 is kept since M11)', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const { token } = await t.grant({ plugin: 'planner-reader', permissions: ['read'], books: ['salt-orchard'] });
  const before = await readAll(t.root);
  for (const what of PLAN_PATHS) {
    const r = await asPlugin(t.port, token, 'GET', `/api/v1/books/${BOOK}/plan${what}`);
    assert.equal(r.status, 200, `plan${what}: ${r.text.slice(0, 200)}`);
    assert.ok(r.json && typeof r.json === 'object', what);
    const keys = keysAnywhere(r.json);
    for (const banned of ['path', 'file', 'rel', 'base_sha256']) assert.ok(!keys.has(banned), `plan${what} has a "${banned}" key`);
    assert.ok(!/planning\/[a-z-]+\/[a-z-]+\.md/.test(r.text), `plan${what} names a planning file`);
  }
  const root = (await asPlugin(t.port, token, 'GET', `/api/v1/books/${BOOK}/plan`)).json;
  assert.match(root.story.fields.premise, /apprentice/);
  assert.equal(root.counts.scenes, 7);
  const clues = (await asPlugin(t.port, token, 'GET', `/api/v1/books/${BOOK}/plan/clues`)).json;
  assert.equal(clues.clues.length, 1);
  assert.equal(clues.clues[0].slug, SLUG);
  assert.equal(clues.clues[0].fact, 'The harbour key opens the sea gate.');
  const bySlug = await asPlugin(t.port, token, 'GET', '/api/v1/books/salt-orchard/plan/links');
  assert.equal(bySlug.status, 200, 'the book may be named by slug');
  assert.ok(bySlug.json.links.length >= 2);
  assertSame(before, await readAll(t.root), 'plugin reads');
});

test('plugin v1 plan routes: a token without the book is 403 PLUGIN_SCOPE; a token without read is refused', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const { token } = await t.grant({ plugin: 'one-book', permissions: ['read'], books: ['pilgrims-road'] });
  for (const what of PLAN_PATHS) {
    for (const book of [LT, 'low-tide']) {
      const r = await asPlugin(t.port, token, 'GET', `/api/v1/books/${book}/plan${what}`);
      assert.equal(r.status, 403, `${book} plan${what}: ${r.text}`);
      assert.equal(r.json.code, 'PLUGIN_SCOPE');
    }
  }
  const own = await asPlugin(t.port, token, 'GET', '/api/v1/books/pilgrims-road/plan');
  assert.equal(own.status, 200, 'the granted book is readable');
  const noRead = await t.grant({ plugin: 'canvas-only', permissions: ['canvas'], books: 'all' });
  const r = await asPlugin(t.port, noRead.token, 'GET', `/api/v1/books/${LT}/plan`);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'PLUGIN_SCOPE');
});

test('plugin v1 plan routes: with the planner module off every plan route is 403 MODULE_OFF and nothing is written', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const { token } = await t.grant({ plugin: 'planner-reader', permissions: ['read'], books: ['salt-orchard'] });
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  for (const what of PLAN_PATHS) {
    const r = await asPlugin(t.port, token, 'GET', `/api/v1/books/${BOOK}/plan${what}`);
    assert.equal(r.status, 403, `plan${what}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF', what);
    assert.equal(r.json.module, 'planner');
  }
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);
  assert.equal((await asPlugin(t.port, token, 'GET', `/api/v1/books/${BOOK}/plan`)).status, 200, 'back on: readable again');
});

test('plugin boundary: no write reaches /api/v1/books/:b/plan/*; the app clue and series routes are PLUGIN_SCOPE for a token; nothing is written', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'], books: 'all' });
  const before = await readAll(t.root);
  const attempts = [];
  for (const what of PLAN_PATHS) for (const method of ['POST', 'PUT', 'DELETE']) attempts.push([method, `/api/v1/books/${BOOK}/plan${what}`, { fact: 'x' }]);
  attempts.push(['POST', `/api/v1/books/${BOOK}/plan/clues/${SLUG}`, { fields: {} }], ['POST', `/api/v1/books/${BOOK}/plan/links`, { from: ARRIVAL, to: WALL, relation: 'therefore' }]);
  attempts.push(['GET', u('clues')], ['GET', u('clues', SLUG)], ['GET', u('series-plan')], ['GET', u('export', 'planning')]);
  attempts.push(['POST', u('clues'), { fact: 'x' }], ['POST', u('clues', SLUG, 'knowers'), { knowers: [], base_sha256: 'a'.repeat(64) }], ['POST', u('clues', SLUG, 'archive'), {}]);
  for (const [method, p, body] of attempts) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before, await readAll(t.root), 'plugin boundary');
});
