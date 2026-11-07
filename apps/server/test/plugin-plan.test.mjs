// M11: planner writes over the plugin API v1 (permission 'plan'): every write runs the app's own planner route and changes only Story Planner files under planning/ (and archive/planning/).
//   GET  /api/v1/books/:b/plan/scene-plans/:id | /plan/check | /plan/templates (read)
//   POST /api/v1/books/:b/plan/story | /plan/scene-plans/:id | /plan/{links,arcs,structures,relationships,clues,synopses}[/:slug[/archive|restore]] | .../milestones | beats | developments | knowers
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { ARRIVAL, BOOK, FERRY, KEY, WALL, readAll } from './move-helpers.mjs';
import { bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const MAREN = 'entry_01S5000000000000000000000G';
const ILSE = 'entry_01S5000000000000000000000H';
const PELL = 'entry_01S5000000000000000000000K';
const base = `/api/v1/books/${BOOK}/plan`;
const planner = () => bootPersonal({ fixture: 'valid/planner' });
const isPlanning = (p) => p.startsWith('planning/') || p.startsWith('archive/planning/');
const outside = async (root) => new Map([...(await readAll(root))].filter(([p]) => !isPlanning(p)));
const planFiles = async (root) => new Map([...(await readAll(root))].filter(([p]) => isPlanning(p)));

function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}

async function withPlan(profile) {
  const t = await planner();
  const rw = (await t.grant({ plugin: 'planner-writer', permissions: ['read', 'plan'] })).token;
  const ro = (await t.grant({ plugin: 'planner-reader', permissions: ['read'] })).token;
  return { t, rw, ro, profile };
}

/** Run a write that must succeed; assert planning files changed or appeared and nothing outside planning/ did. */
async function write(t, token, p, body, { status = 200, changes = true } = {}) {
  const before = await readAll(t.root);
  const outsideBefore = await outside(t.root);
  const r = await t.plugin(token, 'POST', `${base}/${p}`, { body });
  assert.equal(r.status, status, `${p}: ${r.text}`);
  const after2 = await readAll(t.root);
  assertSame(outsideBefore, await outside(t.root), `${p}: nothing outside planning/`);
  for (const [f, b] of after2) assert.ok(isPlanning(f) || before.get(f)?.equals(b), `${f} is not a planning file`);
  if (changes) {
    const touched = [...after2].filter(([f, b]) => !before.get(f)?.equals(b)).map(([f]) => f).concat([...before.keys()].filter((f) => !after2.has(f)));
    assert.ok(touched.length > 0, `${p}: a file changed`);
    assert.ok(touched.every(isPlanning), `${p}: only planning files changed: ${touched.join(', ')}`);
  }
  return r;
}

const get = async (t, token, p) => {
  const r = await t.plugin(token, 'GET', `${base}/${p}`);
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return r.json;
};
const bySlug = (list, slug) => list.find((x) => x.slug === slug);

test('a read-only token: every plan write is 403 PLUGIN_SCOPE naming "plan"; reads work, carry sha256 and no path; nothing is written', async () => {
  const { t, ro } = await withPlan();
  const before = await readAll(t.root);
  const writes = [
    ['story', { fields: { logline: 'x' }, base_sha256: null }],
    [`scene-plans/${KEY}`, { fields: { goal: 'x' } }],
    ['links', { from: ARRIVAL, to: WALL, relation: 'therefore' }],
    ['links/key-therefore-ferry', { rationale: 'x', base_sha256: 'a'.repeat(64) }],
    ['links/key-therefore-ferry/archive', {}],
    ['links/key-therefore-ferry/restore', {}],
    ['arcs', { character: ILSE }],
    ['arcs/maren-hollis', { base_sha256: 'a'.repeat(64) }],
    ['arcs/maren-hollis/milestones', { milestones: [], base_sha256: 'a'.repeat(64) }],
    ['structures', { template: 'three-act', name: 'X' }],
    ['structures/main-three-act/beats', { beats: [], base_sha256: 'a'.repeat(64) }],
    ['relationships', { a: MAREN, b: ILSE }],
    ['relationships/maren-hollis-and-pell/developments', { developments: [], base_sha256: 'a'.repeat(64) }],
    ['clues', { fact: 'x' }],
    ['clues/sea-gate-key/knowers', { knowers: [], base_sha256: 'a'.repeat(64) }],
    ['synopses', { type: 'one-page' }],
    ['synopses/one-page/archive', {}],
  ];
  for (const [p, body] of writes) {
    const r = await t.plugin(ro, 'POST', `${base}/${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', p);
    assert.match(JSON.stringify(r.json), /plan/, `${p}: the refusal names the plan permission`);
  }
  assertSame(before, await readAll(t.root), 'refused writes');

  for (const what of ['links', 'arcs', 'structures', 'relationships', 'synopses', 'clues']) {
    const j = await get(t, ro, what);
    const rows = Object.values(j).find(Array.isArray);
    assert.ok(rows.length >= 1, what);
    for (const row of rows) {
      assert.match(row.sha256, /^[0-9a-f]{64}$/, `${what}: a row carries sha256`);
      assert.ok(!('path' in row) && !('file' in row) && !('rel' in row), `${what}: no path, file or rel`);
    }
  }
  const text = (await t.plugin(ro, 'GET', base)).text;
  assert.ok(!/"(path|file|rel|base_sha256)"/.test(text), 'overview has no file keys');
});

test('links: create, update with base_sha256, stale base is 409, archive, restore', async () => {
  const { t, rw } = await withPlan();
  const made = await write(t, rw, 'links', { from: ARRIVAL, to: WALL, relation: 'therefore', rationale: 'Because.' }, { status: 201 });
  const slug = made.json.slug;
  assert.ok(slug);
  let link = bySlug((await get(t, rw, 'links')).links, slug);
  assert.equal(link.relation, 'therefore');
  const upd = await write(t, rw, `links/${slug}`, { rationale: 'Changed.', base_sha256: link.sha256 });
  assert.equal(upd.status, 200);
  const next = bySlug((await get(t, rw, 'links')).links, slug);
  assert.notEqual(next.sha256, link.sha256);
  assert.match(JSON.stringify(next), /Changed\./);

  const bytes = await planFiles(t.root);
  const stale = await t.plugin(rw, 'POST', `${base}/links/${slug}`, { body: { rationale: 'Late.', base_sha256: link.sha256 } });
  assert.equal(stale.status, 409, stale.text);
  assertSame(bytes, await planFiles(t.root), 'stale write');
  const noBase = await t.plugin(rw, 'POST', `${base}/links/${slug}`, { body: { rationale: 'x' } });
  assert.equal(noBase.status, 400, noBase.text);
  assert.equal((await t.plugin(rw, 'POST', `${base}/links/nobody`, { body: { rationale: 'x', base_sha256: link.sha256 } })).status, 404);
  assert.equal((await t.plugin(rw, 'POST', `${base}/links`, { body: { from: ARRIVAL } })).status, 400);
  assert.equal((await t.plugin(rw, 'POST', `${base}/links`, { body: [] })).status, 400, 'body must be an object');
  assertSame(bytes, await planFiles(t.root), 'refused writes');

  await write(t, rw, `links/${slug}/archive`, { base_sha256: next.sha256 });
  assert.equal(bySlug((await get(t, rw, 'links')).links, slug), undefined, 'archived links leave the live list');
  assert.ok([...(await readAll(t.root)).keys()].some((p) => p.startsWith('archive/planning/links/')));
  await write(t, rw, `links/${slug}/restore`, {});
  assert.ok(bySlug((await get(t, rw, 'links')).links, slug), 'restored');
});

test('story plan and scene plan save; scene plan reads back with GET plan/scene-plans/:id', async () => {
  const { t, rw, ro } = await withPlan();
  const overview = await t.plugin(ro, 'GET', base);
  assert.equal(overview.status, 200, overview.text);
  assert.ok(overview.json.story.fields.premise);
  const bytes0 = await readAll(t.root);
  const blind = await t.plugin(rw, 'POST', `${base}/story`, { body: { fields: { logline: 'Blind.' }, base_sha256: null } });
  assert.ok(blind.status >= 400 && blind.status < 500, `a save with no base over an existing story is refused: ${blind.text}`);
  assertSame(bytes0, await readAll(t.root), 'a refused story save');
  const member = await t.member('GET', `/api/books/${BOOK}/story-plan`);
  assert.equal(member.status, 200, member.text);
  await write(t, rw, 'story', { fields: { logline: 'A new logline.' }, base_sha256: member.json.sha256 });
  assert.match(await fs.readFile(path.join(t.root, 'planning', 'story.md'), 'utf8'), /logline: A new logline\./);
  assert.equal((await t.plugin(ro, 'GET', base)).json.story.fields.logline, 'A new logline.');
  const staleStory = await t.plugin(rw, 'POST', `${base}/story`, { body: { fields: { logline: 'Stale.' }, base_sha256: member.json.sha256 } });
  assert.equal(staleStory.status, 409, staleStory.text);

  const sp0 = await get(t, ro, `scene-plans/${KEY}`);
  assert.equal(sp0.fields.goal, 'Prove the harbour key opens the sea gate.');
  assert.ok(!('path' in sp0));
  await write(t, rw, `scene-plans/${KEY}`, { fields: { goal: 'A new goal.' }, base_sha256: sp0.sha256 });
  assert.equal((await get(t, ro, `scene-plans/${KEY}`)).fields.goal, 'A new goal.');
  assert.match(await fs.readFile(path.join(t.root, 'planning', 'scene-plans', 'the-key.md'), 'utf8'), /A new goal\./);

  const bytes = await readAll(t.root);
  const stale = await t.plugin(rw, 'POST', `${base}/scene-plans/${KEY}`, { body: { fields: { goal: 'Stale.' }, base_sha256: sp0.sha256 } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal((await t.plugin(rw, 'POST', `${base}/scene-plans/${KEY}`, { body: { fields: { goal: 5 } } })).status, 400);
  assertSame(bytes, await readAll(t.root), 'refused scene-plan saves');
  assert.equal((await t.plugin(ro, 'GET', `${base}/scene-plans/scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ`)).status, 404);
});

test('clues: create, set planted and revealed, knowers', async () => {
  const { t, rw } = await withPlan();
  const made = await write(t, rw, 'clues', { fact: 'The lamp is cold.', kind: 'clue' }, { status: 201 });
  const slug = made.json.slug;
  assert.ok(slug);
  assert.ok((await planFiles(t.root)).has(`planning/clues/${slug}.md`));
  let c = bySlug((await get(t, rw, 'clues')).clues, slug);
  await write(t, rw, `clues/${slug}`, { fields: { planted: [ARRIVAL], revealed: FERRY }, base_sha256: c.sha256 });
  c = bySlug((await get(t, rw, 'clues')).clues, slug);
  assert.deepEqual(c.planted.map((x) => x.id ?? x), [ARRIVAL]);
  assert.equal(c.revealed?.id ?? c.revealed, FERRY);
  const disk = await fs.readFile(path.join(t.root, 'planning', 'clues', `${slug}.md`), 'utf8');
  assert.match(disk, new RegExp(`revealed: ${FERRY}`));

  await write(t, rw, `clues/${slug}/knowers`, { knowers: [{ who: 'reader', scene: FERRY }, { who: MAREN, scene: KEY, reliable: false }], base_sha256: c.sha256 });
  c = bySlug((await get(t, rw, 'clues')).clues, slug);
  assert.equal(c.knowers.length, 2);

  const bytes = await planFiles(t.root);
  assert.equal((await t.plugin(rw, 'POST', `${base}/clues/${slug}/knowers`, { body: { knowers: [{ who: 'reader', scene: FERRY }], base_sha256: 'a'.repeat(64) } })).status, 409, 'stale base');
  assert.equal((await t.plugin(rw, 'POST', `${base}/clues/${slug}`, { body: { fields: { planted: ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] }, base_sha256: c.sha256 } })).status, 400, 'unknown scene');
  assert.equal((await t.plugin(rw, 'POST', `${base}/clues`, { body: {} })).status, 400);
  assertSame(bytes, await planFiles(t.root), 'refused clue writes');
  await write(t, rw, `clues/${slug}/archive`, {});
  await write(t, rw, `clues/${slug}/restore`, {});
});

test('arcs: create, milestones; relationships: create, developments', async () => {
  const { t, rw } = await withPlan();
  const arc = await write(t, rw, 'arcs', { character: ILSE, arc_type: 'positive', fields: { want: 'To find the ledger.' } }, { status: 201 });
  let a = bySlug((await get(t, rw, 'arcs')).arcs, arc.json.slug);
  assert.ok(a, 'the new arc is listed');
  await write(t, rw, `arcs/${arc.json.slug}/milestones`, { milestones: [{ scene: KEY, choice: 'A' }, { scene: WALL }], base_sha256: a.sha256 });
  a = bySlug((await get(t, rw, 'arcs')).arcs, arc.json.slug);
  assert.equal(a.milestones.length, 2);
  assert.equal((await t.plugin(rw, 'POST', `${base}/arcs`, { body: { character: ILSE } })).status, 409, 'a second arc for the same character');
  assert.equal((await t.plugin(rw, 'POST', `${base}/arcs/${arc.json.slug}/milestones`, { body: { milestones: 'x', base_sha256: a.sha256 } })).status, 400);

  const rel = await write(t, rw, 'relationships', { a: MAREN, b: ILSE, fields: { baseline: 'Mother and daughter.' } }, { status: 201 });
  let r = bySlug((await get(t, rw, 'relationships')).relationships, rel.json.slug);
  assert.ok(r, 'the new relationship is listed');
  await write(t, rw, `relationships/${rel.json.slug}/developments`, { developments: [{ scene: KEY, change: 'They argue.' }], base_sha256: r.sha256 });
  r = bySlug((await get(t, rw, 'relationships')).relationships, rel.json.slug);
  assert.equal(r.developments.length, 1);
  assert.equal((await t.plugin(rw, 'POST', `${base}/relationships/${rel.json.slug}/developments`, { body: { developments: [{ scene: KEY, change: 'x' }], base_sha256: 'b'.repeat(64) } })).status, 409);
  assert.equal((await t.plugin(rw, 'POST', `${base}/relationships`, { body: { a: MAREN, b: PELL } })).status, 409, 'a duplicate pair');
});

test('structures: list templates, create from a template, set beats (a scene on a beat); synopses: create and update', async () => {
  const { t, rw, ro } = await withPlan();
  const tpl = await get(t, ro, 'templates');
  assert.ok(Array.isArray(tpl.templates));
  const three = tpl.templates.find((x) => x.id === 'three-act');
  assert.ok(three && three.beats.length > 0);
  assert.equal(tpl.templates.find((x) => x.id === 'custom').beats.length, 0);

  const made = await write(t, rw, 'structures', { template: 'three-act', name: 'Second take' }, { status: 201 });
  assert.ok((await planFiles(t.root)).has(`planning/structures/${made.json.slug}.md`));
  assert.equal((await t.plugin(rw, 'POST', `${base}/structures`, { body: { template: 'no-such-template', name: 'Bad' } })).status, 400);
  let s = bySlug((await get(t, rw, 'structures')).structures, made.json.slug);
  const beats = s.beats.map((b) => {
    const o = { id: b.id, name: b.name, scenes: b.scenes.map((x) => x.id ?? x) };
    for (const k of ['purpose', 'question', 'position', 'state']) if (b[k]) o[k] = b[k];
    return o;
  });
  beats[0].scenes = [KEY];
  await write(t, rw, `structures/${made.json.slug}/beats`, { beats, base_sha256: s.sha256 });
  s = bySlug((await get(t, rw, 'structures')).structures, made.json.slug);
  assert.deepEqual(s.beats[0].scenes.map((x) => x.id ?? x), [KEY]);
  assert.match(await fs.readFile(path.join(t.root, 'planning', 'structures', `${made.json.slug}.md`), 'utf8'), new RegExp(KEY));
  const bytes = await planFiles(t.root);
  assert.equal((await t.plugin(rw, 'POST', `${base}/structures/${made.json.slug}/beats`, { body: { beats, base_sha256: 'c'.repeat(64) } })).status, 409);
  assert.equal((await t.plugin(rw, 'POST', `${base}/structures/${made.json.slug}/beats`, { body: { beats: 'x', base_sha256: s.sha256 } })).status, 400);
  assertSame(bytes, await planFiles(t.root), 'refused beat saves');

  const syn = await write(t, rw, 'synopses', { type: 'one-page', name: 'Second page', target_words: 250, body: 'Text.\n' }, { status: 201 });
  let y = bySlug((await get(t, rw, 'synopses')).synopses, syn.json.slug);
  assert.ok(y);
  await write(t, rw, `synopses/${syn.json.slug}`, { body: 'Updated text.\n', base_sha256: y.sha256 });
  assert.match(await fs.readFile(path.join(t.root, 'planning', 'synopses', `${syn.json.slug}.md`), 'utf8'), /Updated text\./);
  assert.equal((await t.plugin(rw, 'POST', `${base}/synopses/${syn.json.slug}`, { body: { body: 'Late.\n', base_sha256: y.sha256 } })).status, 409);
  await write(t, rw, `structures/${made.json.slug}/archive`, {});
  await write(t, rw, `structures/${made.json.slug}/restore`, {});
});

test('the plan overview carries the story sha256 a plugin needs as base_sha256 to save the story plan (otherwise it can never update an existing one)', async () => {
  const { t, ro } = await withPlan();
  const story = (await t.plugin(ro, 'GET', base)).json.story;
  assert.match(story.sha256, /^[0-9a-f]{64}$/);
  const member = await t.member('GET', `/api/books/${BOOK}/story-plan`);
  assert.equal(story.sha256, member.json.sha256);
  assert.ok(!('path' in story));
});

test('GET plan/check lists the PL findings with related arrays', async () => {
  const { t, rw, ro } = await withPlan();
  const none = await get(t, ro, 'check');
  assert.ok(Array.isArray(none.findings));
  for (const f of none.findings) assert.ok(/^PL/.test(f.rule));
  // a clue revealed before it is planted raises PL6; one planted but never revealed raises PL5
  await write(t, rw, 'clues', { fact: 'Late plant', fields: { planted: [WALL], revealed: ARRIVAL } }, { status: 201 });
  await write(t, rw, 'clues', { fact: 'Open thread', fields: { planted: [KEY] } }, { status: 201 });
  const { findings } = await get(t, ro, 'check');
  for (const rule of ['PL5', 'PL6']) {
    const f = findings.filter((x) => x.rule === rule);
    assert.equal(f.length, 1, rule);
    assert.ok(Array.isArray(f[0].related), `${rule} has related`);
    assert.ok(f[0].severity && f[0].title && f[0].message, rule);
  }
  assert.ok(findings.every((f) => /^PL/.test(f.rule) && Array.isArray(f.related)));
});

test('path safety: odd plan paths are refused or missing and write nothing; a token granted another book is 403', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const [a, b] = (await t.member('GET', '/api/books')).json;
  const { token } = await t.grant({ permissions: ['read', 'plan'], books: [a.slug] });
  const before = await readAll(t.root);
  for (const p of ['plan/../scenes/x', 'plan/links/%2E%2E', 'plan/links/..', 'plan/books', 'plan/scenes/x', 'plan/links/a%2Fb', 'plan/links/Upper', 'plan/scene-plans', 'plan/story/extra', 'plan/clues/x/y/z', 'plan/links/x/delete', 'plan/arcs/x/beats']) {
    const r = await t.plugin(token, 'POST', `/api/v1/books/${a.slug}/${p}`, { body: { fact: 'x', fields: {} } });
    assert.ok([403, 404].includes(r.status), `${p}: ${r.status} ${r.text}`);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await t.plugin(token, method, `/api/v1/books/${a.slug}/plan/links`, { body: {} });
    assert.ok([403, 404, 405].includes(r.status), `${method}: ${r.status}`);
  }
  assertSame(before, await readAll(t.root), 'unsafe paths');
  for (const p of ['plan/clues', 'plan/story', 'plan/links/x/archive']) {
    const r = await t.plugin(token, 'POST', `/api/v1/books/${b.slug}/${p}`, { body: { fact: 'x' } });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
  }
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${b.slug}/plan/check`)).status, 403);
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${b.slug}/plan/templates`)).status, 403);
  assertSame(before, await readAll(t.root), 'other book');
});

test('planner module off: reads and writes are 403 MODULE_OFF and nothing is written; back on, a write works', async () => {
  const { t, rw } = await withPlan();
  assert.equal((await t.member('PUT', '/api/profile', { modules: { planner: false } })).status, 200);
  const before = await readAll(t.root);
  for (const [method, p, body] of [['POST', 'clues', { fact: 'x' }], ['POST', 'story', { fields: { logline: 'x' }, base_sha256: null }], ['GET', 'check'], ['GET', 'templates'], ['GET', `scene-plans/${KEY}`]]) {
    const r = await t.plugin(rw, method, `${base}/${p}`, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(r.json.module, 'planner');
  }
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);
  await write(t, rw, 'clues', { fact: 'x' }, { status: 201 });
});

test('integrations module off: plugin plan reads and writes are 403 MODULE_OFF and nothing is written', async () => {
  const { t, rw } = await withPlan();
  assert.equal((await t.member('PUT', '/api/profile', { modules: { integrations: false } })).status, 200);
  const before = await readAll(t.root);
  for (const [method, p, body] of [['POST', 'clues', { fact: 'x' }], ['GET', 'check']]) {
    const r = await t.plugin(rw, method, `${base}/${p}`, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(r.json.module, 'integrations');
  }
  assertSame(before, await readAll(t.root), 'integrations off');
});

test('the audit route name of a plan write is plan-<kind>-write; reads are plan-<kind>', () => {
  const b = `/api/v1/books/${BOOK}`;
  assert.equal(v1RouteOf('POST', `${b}/plan/links`), 'plan-links-write');
  assert.equal(v1RouteOf('POST', `${b}/plan/clues/x/knowers`), 'plan-clues-write');
  assert.equal(v1RouteOf('POST', `${b}/plan/story`), 'plan-story-write');
  assert.equal(v1RouteOf('POST', `${b}/plan/scene-plans/${KEY}`), 'plan-scene-plans-write');
  assert.equal(v1RouteOf('GET', `${b}/plan/check`), 'plan-check');
  assert.equal(v1RouteOf('GET', `${b}/plan`), 'plan');
});
