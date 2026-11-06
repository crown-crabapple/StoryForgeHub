// Story Planner M2 routes: the story plan (planning/story.md), the Plan overview, and the spec's M2 gate journey (J2).
//   GET  /api/books/:b/story-plan | /plan-overview | /flow | /links
//   POST /api/books/:b/story-plan | /links | /links/:slug | /links/:slug/archive, POST /ops/:opId/restore, POST /scenes/:id/move
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL, FERRY, GRAFTING, KEY, WALL, BOOK, closeAll, freshBook, move, readAll, send } from './move-helpers.mjs';
import { asPlugin, bootPersonal, closeAll as closePlugin } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await closePlugin();
});

const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const undo = (port, opId) => post(port, u('ops', encodeURIComponent(opId), 'restore'), {});
const FIELD_KEYS = ['premise', 'logline', 'theme_question', 'central_conflict', 'protagonist_goal', 'stakes', 'protagonist'];

/** Every file except planning/ (book.md, manuscript/, codex ...): relative path -> Buffer. */
async function nonPlanning(root) {
  return new Map([...(await readAll(root))].filter(([p]) => !p.startsWith('planning/')));
}
function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}
/** Planner link files (live and archived): path -> Buffer. */
async function linkFiles(root) {
  return new Map([...(await readAll(root))].filter(([p]) => /(^|\/)planning\/links\//.test(p)));
}
async function newLink(port, body) {
  const r = await post(port, u('links'), body);
  assert.equal(r.status, 201, r.text);
  return r.json;
}
const edgeOf = (flow, slug) => flow.edges.find((e) => e.slug === slug);

test('story plan: empty shape, create (dry run writes nothing), edit with a base, stale base, unknown protagonist, body save, undo of the create', async () => {
  const { root, port } = await freshBook();
  const guard = await nonPlanning(root);
  const planFiles = async () => [...(await readAll(root)).keys()].filter((p) => p === 'planning/story.md');

  const empty = await get(port, u('story-plan'));
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.path, null);
  assert.equal(empty.json.sha256, null);
  assert.equal(empty.json.body, '');
  assert.deepEqual(Object.keys(empty.json.fields).sort(), [...FIELD_KEYS].sort());
  assert.ok(Object.values(empty.json.fields).every((v) => v === null));

  const dry = await post(port, u('story-plan'), { fields: { premise: 'A drowned town.' }, base_sha256: null, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(await planFiles(), [], 'a dry run writes nothing');
  assert.equal((await get(port, u('story-plan'))).json.path, null);

  const created = await post(port, u('story-plan'), { fields: { premise: 'A drowned town.', logline: 'She returns.' }, base_sha256: null });
  assert.equal(created.status, 200, created.text);
  assert.ok(created.json.opId, `a create returns an opId: ${created.text}`);
  assert.deepEqual(await planFiles(), ['planning/story.md']);
  const g1 = (await get(port, u('story-plan'))).json;
  assert.equal(g1.path, 'planning/story.md');
  assert.match(g1.sha256, /^[0-9a-f]{64}$/);
  assert.equal(g1.fields.premise, 'A drowned town.');
  assert.equal(g1.fields.logline, 'She returns.');
  assert.equal(g1.fields.stakes, null);

  const edited = await post(port, u('story-plan'), { fields: { stakes: 'The town', protagonist: 'maren-hollis' }, base_sha256: g1.sha256 });
  assert.equal(edited.status, 200, edited.text);
  const g2 = (await get(port, u('story-plan'))).json;
  assert.equal(g2.fields.stakes, 'The town');
  assert.equal(g2.fields.protagonist, 'maren-hollis');
  assert.equal(g2.fields.premise, 'A drowned town.', 'a field not in the request is kept');
  assert.notEqual(g2.sha256, g1.sha256);

  const stale = await post(port, u('story-plan'), { fields: { premise: 'x' }, base_sha256: g1.sha256 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'conflict');
  assert.ok(stale.json.current, `409 carries current: ${stale.text}`);
  const nullBase = await post(port, u('story-plan'), { fields: { premise: 'x' }, base_sha256: null });
  assert.equal(nullBase.status, 400, nullBase.text);
  assert.equal(nullBase.json.code, 'REFUSED_BAD_ARGS', 'no base on an existing story plan is refused');
  assert.equal((await get(port, u('story-plan'))).json.sha256, g2.sha256, 'refused saves change nothing');

  const bad = await post(port, u('story-plan'), { fields: { protagonist: 'nobody-here' }, base_sha256: g2.sha256 });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.code, 'REFUSED_UNKNOWN_ENTRY');
  assert.equal((await post(port, u('story-plan'), { fields: { premise: 5 }, base_sha256: g2.sha256 })).status, 400);
  assert.equal((await get(port, u('story-plan'))).json.sha256, g2.sha256);

  const bodied = await post(port, u('story-plan'), { fields: {}, body: 'Free notes about the story.\n', base_sha256: g2.sha256 });
  assert.equal(bodied.status, 200, bodied.text);
  const g3 = (await get(port, u('story-plan'))).json;
  assert.match(g3.body, /Free notes about the story\./);
  assert.equal(g3.fields.premise, 'A drowned town.');

  const late = await undo(port, created.json.opId);
  assert.equal(late.status, 409, 'undo of a create after later edits is refused, not destructive');
  assert.equal(late.json.code, 'REFUSED_FILES_CHANGED');
  assert.deepEqual(await planFiles(), ['planning/story.md']);
  assert.equal((await get(port, u('story-plan'))).json.sha256, g3.sha256);

  assertSame(guard, await nonPlanning(root), 'story plan writes');
});

test('story plan: undo of the create (right after it) removes planning/story.md and leaves everything else byte-identical', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);
  const created = await post(port, u('story-plan'), { fields: { premise: 'P' }, base_sha256: null });
  assert.equal(created.status, 200, created.text);
  assert.ok((await readAll(root)).has('planning/story.md'));
  const un = await undo(port, created.json.opId);
  assert.equal(un.status, 200, un.text);
  assert.ok(!(await readAll(root)).has('planning/story.md'), 'planning/story.md is gone');
  assert.equal((await get(port, u('story-plan'))).json.path, null);
  const after2 = await readAll(root);
  for (const [p, b] of before) assert.ok(after2.get(p)?.equals(b), `${p} is byte-identical`);
});

test('story plan: creating with a non-null base when no file exists is refused and writes nothing', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);
  const r = await post(port, u('story-plan'), { fields: { premise: 'x' }, base_sha256: '0'.repeat(64) });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, 'REFUSED_BAD_ARGS');
  assertSame(before, await readAll(root), 'refused create');
});

test('plan overview: counts match the flow after two links and one scene plan', async () => {
  const { port } = await freshBook();
  const first = (await get(port, u('plan-overview'))).json;
  assert.equal(first.counts.links, 0);
  assert.equal(first.counts.planned_scenes, 0);
  assert.equal(first.story.fields.premise, null);

  await newLink(port, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'r1' });
  await newLink(port, { from: FERRY, to: WALL, relation: 'but', rationale: 'r2' });
  assert.equal((await post(port, u('scene-plans', ARRIVAL), { fields: { goal: 'Arrive' } })).status, 200);
  assert.equal((await post(port, u('story-plan'), { fields: { premise: 'P' }, base_sha256: null })).status, 200);

  const flow = (await get(port, u('flow'))).json;
  const ov = (await get(port, u('plan-overview'))).json;
  assert.equal(ov.story.fields.premise, 'P');
  assert.equal(ov.counts.scenes, flow.nodes.length);
  assert.equal(ov.counts.planned_scenes, flow.nodes.filter((n) => n.plan).length);
  assert.equal(ov.counts.planned_scenes, 1);
  assert.equal(ov.counts.links, flow.edges.length);
  assert.equal(ov.counts.links, 2);
  assert.equal(ov.counts.broken_links, flow.edges.filter((e) => e.broken).length);
  assert.equal(ov.counts.broken_links, 0);
  assert.equal(ov.counts.archived_links, 0);
  const linked = new Set(flow.edges.flatMap((e) => [e.from, e.to]));
  assert.equal(ov.counts.linked_scenes, linked.size);
  assert.equal(ov.counts.linked_scenes, 3);
  assert.equal(ov.counts.unlinked_scenes, flow.nodes.length - linked.size);
  assert.deepEqual(ov.unlinked.map((s) => s.id).sort(), flow.nodes.map((n) => n.id).filter((id) => !linked.has(id)).sort());
  assert.ok(ov.unlinked.every((s) => typeof s.title === 'string'));
  assert.equal(typeof ov.counts.threads, 'number');
});

test('M2 gate (J2)', async () => {
  const { root, port } = await freshBook();

  const a = await newLink(port, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'The key opens the ferry.' });
  const b = await newLink(port, { from: FERRY, to: WALL, relation: 'but', rationale: 'The wall stands in the way.' });

  // simulated refresh: brand-new requests
  let flow = (await get(port, u('flow'))).json;
  const links = (await get(port, u('links'))).json;
  assert.equal(flow.edges.length, 2);
  assert.deepEqual([edgeOf(flow, a.slug).from, edgeOf(flow, a.slug).to, edgeOf(flow, a.slug).relation], [KEY, FERRY, 'therefore']);
  assert.deepEqual([edgeOf(flow, b.slug).from, edgeOf(flow, b.slug).to, edgeOf(flow, b.slug).relation], [FERRY, WALL, 'but']);
  assert.equal(links.links.find((l) => l.slug === a.slug).rationale, 'The key opens the ferry.');
  assert.equal(links.links.find((l) => l.slug === b.slug).rationale, 'The wall stands in the way.');

  // edit the rationale of the first (with sha)
  const cur = (await get(port, u('links', a.slug))).json;
  const ed = await post(port, u('links', a.slug), { rationale: 'Turning the key opens the ferry gate.', base_sha256: cur.sha256 });
  assert.equal(ed.status, 200, ed.text);
  assert.equal((await get(port, u('links', a.slug))).json.rationale, 'Turning the key opens the ferry gate.');
  assert.equal((await get(port, u('links'))).json.links.find((l) => l.slug === a.slug).rationale, 'Turning the key opens the ferry gate.');

  // move scene KEY to another chapter (real): edges follow the id, link files untouched
  const linksBefore = await linkFiles(root);
  assert.equal(linksBefore.size, 2);
  const mv = await move(port, KEY, { chapter: 2, after: GRAFTING });
  assert.equal(mv.status, 200, mv.text);
  flow = (await get(port, u('flow'))).json;
  assert.equal(flow.edges.length, 2);
  const ea = edgeOf(flow, a.slug);
  const eb = edgeOf(flow, b.slug);
  assert.deepEqual([ea.from, ea.to, ea.broken], [KEY, FERRY, false]);
  assert.deepEqual([eb.from, eb.to, eb.broken], [FERRY, WALL, false]);
  assertSame(linksBefore, await linkFiles(root), 'the move');

  // archive the second link, then undo the archive
  const arch = await post(port, u('links', b.slug, 'archive'), {});
  assert.equal(arch.status, 200, arch.text);
  assert.ok(arch.json.opId, `archive returns an opId: ${arch.text}`);
  assert.equal(edgeOf((await get(port, u('flow'))).json, b.slug), undefined, 'an archived link is not an edge');
  const un = await undo(port, arch.json.opId);
  assert.equal(un.status, 200, un.text);
  const lst = (await get(port, u('links'))).json;
  assert.ok(lst.links.some((l) => l.slug === b.slug), 'the link is live again');
  assert.deepEqual(lst.archived, []);
  assert.ok(edgeOf((await get(port, u('flow'))).json, b.slug));

  // undo works for a create too
  const c = await newLink(port, { from: ARRIVAL, to: KEY, relation: 'enables', rationale: 'r' });
  assert.equal((await undo(port, c.opId)).status, 200);
  const finalLinks = (await get(port, u('links'))).json.links;
  assert.ok(!finalLinks.some((l) => l.slug === c.slug), 'the created link is gone');
  assert.equal(finalLinks.length, 2);
});

test('module off: a story-plan write is 403 MODULE_OFF; a plugin token with every permission gets 403 PLUGIN_SCOPE on the M2 routes', async () => {
  const t = await bootPersonal();
  const off = await t.member('PUT', '/api/profile', { modules: { planner: false } });
  assert.equal(off.status, 200, off.text);
  const before = await readAll(t.root);
  const w = await t.member('POST', u('story-plan'), { fields: { premise: 'x' }, base_sha256: null });
  assert.equal(w.status, 403, w.text);
  assert.equal(w.json.code, 'MODULE_OFF');
  assert.equal(w.json.module, 'planner');
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);

  const { token } = await t.grant({ plugin: 'everything', permissions: ['read', 'propose', 'events', 'canvas'] });
  const before2 = await readAll(t.root);
  for (const [method, p, body] of [
    ['GET', u('story-plan')],
    ['POST', u('story-plan'), { fields: { premise: 'x' }, base_sha256: null }],
    ['GET', u('plan-overview')],
  ]) {
    const r = await asPlugin(t.port, token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', `${method} ${p}`);
  }
  assertSame(before2, await readAll(t.root), 'plugin boundary');
});
