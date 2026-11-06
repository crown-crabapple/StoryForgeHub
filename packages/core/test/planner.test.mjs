// Story Planner M1 (ADR 0003): the repository methods for links, scene plans and the flow projection, end to end on a copy of salt-orchard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const ARRIVAL = 'scene_01S50000000000000000000002';
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const FERRY_FILE = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md';

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  return { root, repo: createFsRepository(root) };
}
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const scenesBytes = async (root) => {
  const s = await snapshot(root, { skipStoryforge: true });
  return Object.fromEntries(Object.entries(s).filter(([p]) => p.startsWith('manuscript/') || p.startsWith('archive/manuscript/')));
};

test('listLinks / getLink: empty, then a created link with titles, sha256 and no problems', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listLinks('book_nope'), null);
    assert.deepEqual(await repo.listLinks(BOOK), { links: [], archived: [] });
    assert.equal(await repo.getLink(BOOK, 'nothing'), null);

    const r = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'The key failing forces Maren onto the ferry.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(typeof r.opId, 'string');
    assert.equal(r.slug, 'the-key-therefore-ferry');
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listLinks(BOOK);
    assert.equal(list.links.length, 1);
    const l = list.links[0];
    assert.deepEqual(Object.keys(l).sort(), ['created', 'from', 'from_title', 'id', 'path', 'problems', 'rationale', 'relation', 'sha256', 'slug', 'to', 'to_title'].sort());
    assert.equal(l.id, r.id);
    assert.equal(l.path, 'planning/links/the-key-therefore-ferry.md');
    assert.equal(l.from, KEY);
    assert.equal(l.to, FERRY);
    assert.equal(l.relation, 'therefore');
    assert.equal(l.rationale, 'The key failing forces Maren onto the ferry.');
    assert.match(l.created, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(l.from_title, 'The Key');
    assert.equal(l.to_title, 'Ferry');
    assert.deepEqual(l.problems, []);
    const bytes = await fs.readFile(path.join(root, l.path));
    const { createHash } = await import('node:crypto');
    assert.equal(l.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual({ ...(await repo.getLink(BOOK, l.slug)) }, { ...l, archived: false });
  } finally {
    await repo.close();
  }
});

test('createLink refusals keep their codes: unknown scene, self link, duplicate, bad args; dry run writes nothing', async () => {
  const { root, repo } = await setup();
  try {
    const before = await snapshot(root);
    assert.equal((await repo.createLink(BOOK, { from: GHOST, to: FERRY, relation: 'but' })).code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal((await repo.createLink(BOOK, { from: KEY, to: KEY, relation: 'but' })).code, 'REFUSED_SELF_LINK');
    assert.equal((await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'nope' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.createLink('book_nope', { from: KEY, to: FERRY, relation: 'but' })).code, 'NOT_FOUND');
    const dry = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'but', dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(await snapshot(root), before);

    const a = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'but' });
    const dup = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'but' });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(dup.existing, { slug: a.slug });
  } finally {
    await repo.close();
  }
});

test('updateLink, archiveLink, restoreLink round trip with base_sha256 and CONFLICT', async () => {
  const { root, repo } = await setup();
  try {
    const c = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'why' });
    const l0 = await repo.getLink(BOOK, c.slug);
    assert.equal((await repo.updateLink(BOOK, c.slug, { relation: 'but' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.updateLink(BOOK, c.slug, { relation: 'but', baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    assert.equal((await repo.updateLink(BOOK, 'nothing', { relation: 'but', baseSha256: l0.sha256 })).code, 'NOT_FOUND');

    const u = await repo.updateLink(BOOK, c.slug, { relation: 'but', rationale: 'changed', baseSha256: l0.sha256 });
    assert.equal(u.ok, true, JSON.stringify(u));
    const l1 = await repo.getLink(BOOK, c.slug);
    assert.equal(l1.relation, 'but');
    assert.equal(l1.rationale, 'changed');
    assert.notEqual(l1.sha256, l0.sha256);
    assert.equal(l1.slug, c.slug);

    const a = await repo.archiveLink(BOOK, c.slug, { baseSha256: l1.sha256 });
    assert.equal(a.ok, true, JSON.stringify(a));
    let list = await repo.listLinks(BOOK);
    assert.deepEqual(list.links, []);
    assert.equal(list.archived.length, 1);
    assert.equal(list.archived[0].path, 'archive/planning/links/the-key-therefore-ferry.md');
    const got = await repo.getLink(BOOK, c.slug);
    assert.equal(got.archived, true);
    assert.equal(got.relation, 'but');

    const r = await repo.restoreLink(BOOK, c.slug, {});
    assert.equal(r.ok, true, JSON.stringify(r));
    list = await repo.listLinks(BOOK);
    assert.equal(list.links.length, 1);
    assert.deepEqual(list.archived, []);
    assert.equal((await repo.getLink(BOOK, c.slug)).archived, false);
    assert.deepEqual(await errorsOf(root), []);

    // Undo of the update, through the repository's restoreOp
    const u2 = await repo.updateLink(BOOK, c.slug, { relation: 'enables', baseSha256: (await repo.getLink(BOOK, c.slug)).sha256 });
    const before = (await repo.getLink(BOOK, c.slug)).sha256;
    assert.equal(u2.ok, true);
    assert.equal((await repo.restoreOp(BOOK, u2.opId)).ok, true);
    assert.notEqual((await repo.getLink(BOOK, c.slug)).sha256, before);
    assert.equal((await repo.getLink(BOOK, c.slug)).relation, 'but');
  } finally {
    await repo.close();
  }
});

test('getScenePlan: none yet, then saveScenePlan creates and edits the sidecar', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.getScenePlan('book_nope', KEY), null);
    assert.equal(await repo.getScenePlan(BOOK, GHOST), null);
    assert.equal(await repo.getScenePlan(BOOK, 'scene_01S50000000000000000000007'), null, 'an archived scene has no plan view');
    const none = await repo.getScenePlan(BOOK, KEY);
    assert.deepEqual(none, {
      scene_id: KEY, path: null, sha256: null, characters: [], body: '',
      fields: { goal: null, opposition: null, conflict: null, turn: null, outcome: null, consequence: null, stakes: null, emotional_start: null, emotional_end: null, purpose: null },
    });

    assert.equal((await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'x' }, characters: ['nobody-here'] })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.saveScenePlan(BOOK, GHOST, { fields: { goal: 'x' } })).code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal((await repo.saveScenePlan(BOOK, KEY, { fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');

    const c = await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'Prove the key opens the gate.', stakes: 'Her place in the town.' }, characters: ['maren-hollis', 'pell'] });
    assert.equal(c.ok, true, JSON.stringify(c));
    const p1 = await repo.getScenePlan(BOOK, KEY);
    assert.equal(p1.path, 'planning/scene-plans/the-key.md');
    assert.equal(p1.fields.goal, 'Prove the key opens the gate.');
    assert.equal(p1.fields.stakes, 'Her place in the town.');
    assert.equal(p1.fields.turn, null);
    assert.deepEqual(p1.characters, ['maren-hollis', 'pell']);
    assert.equal(typeof p1.sha256, 'string');

    assert.equal((await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'y' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'y' }, baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    const e = await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'Changed', stakes: null }, characters: [], baseSha256: p1.sha256 });
    assert.equal(e.ok, true, JSON.stringify(e));
    const p2 = await repo.getScenePlan(BOOK, KEY);
    assert.equal(p2.fields.goal, 'Changed');
    assert.equal(p2.fields.stakes, null);
    assert.deepEqual(p2.characters, []);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('flowGraph: nodes in reading order with plan flags, edges with broken ends after a scene is archived', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.flowGraph('book_nope'), null);
    const empty = await repo.flowGraph(BOOK);
    assert.equal(empty.nodes.length, 7);
    assert.deepEqual(empty.edges, []);
    assert.deepEqual(Object.keys(empty.nodes[0]).sort(), ['act', 'chapter', 'id', 'kind', 'plan', 'pov', 'sequence', 'status', 'summary', 'title'].sort());

    await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'x' } });
    const link = await repo.createLink(BOOK, { from: ARRIVAL, to: FERRY, relation: 'enables', rationale: 'because' });
    assert.equal(link.ok, true, JSON.stringify(link));
    const g = await repo.flowGraph(BOOK);
    assert.deepEqual(g.nodes.map((n) => n.id), [
      'scene_01S50000000000000000000001', ARRIVAL, KEY, FERRY, 'scene_01S50000000000000000000006', 'scene_01S50000000000000000000008', 'scene_01S50000000000000000000009',
    ]);
    assert.deepEqual(g.nodes.filter((n) => n.plan).map((n) => n.id), [KEY]);
    const arrival = g.nodes.find((n) => n.id === ARRIVAL);
    assert.equal(arrival.kind, 'scene');
    assert.equal(arrival.title, 'Arrival');
    assert.equal(arrival.act, 1);
    assert.equal(arrival.chapter, 1);
    assert.equal(arrival.sequence, 10);
    assert.equal(g.edges.length, 1);
    const l = await repo.getLink(BOOK, link.slug);
    assert.deepEqual(g.edges[0], { id: link.id, slug: link.slug, from: ARRIVAL, to: FERRY, relation: 'enables', rationale: 'because', sha256: l.sha256, broken: false });
    await repo.close();

    // the Ferry scene is archived by hand (a move to archive/): the edge stays, flagged broken
    const dest = path.join(root, 'archive', ...FERRY_FILE.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(path.join(root, ...FERRY_FILE.split('/')), dest);
    const repo2 = createFsRepository(root);
    try {
      const g2 = await repo2.flowGraph(BOOK);
      assert.ok(!g2.nodes.some((n) => n.id === FERRY));
      assert.equal(g2.edges.length, 1);
      assert.equal(g2.edges[0].broken, true);
      const l2 = (await repo2.listLinks(BOOK)).links[0];
      assert.equal(l2.to_title, null);
      assert.equal(l2.from_title, 'Arrival');
      assert.ok(l2.problems.some((p) => p.code === 'W303'), JSON.stringify(l2.problems));
    } finally {
      await repo2.close();
    }
  } finally {
    await repo.close();
  }
});

test('planner writes never touch a scene file', async () => {
  const { root, repo } = await setup();
  try {
    const base = await scenesBytes(root);
    const c = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'why' });
    await repo.updateLink(BOOK, c.slug, { relation: 'but', baseSha256: (await repo.getLink(BOOK, c.slug)).sha256 });
    await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'g' }, characters: ['pell'] });
    await repo.archiveLink(BOOK, c.slug, {});
    await repo.restoreLink(BOOK, c.slug, {});
    assert.deepEqual(await scenesBytes(root), base);
  } finally {
    await repo.close();
  }
});

test('getStoryPlan: unknown book, none yet, then saveStoryPlan creates and edits planning/story.md', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.getStoryPlan('book_nope'), null);
    const none = { premise: null, logline: null, theme_question: null, central_conflict: null, protagonist_goal: null, stakes: null, protagonist: null };
    assert.deepEqual(await repo.getStoryPlan(BOOK), { path: null, sha256: null, fields: none, body: '' });

    assert.equal((await repo.saveStoryPlan(BOOK, { fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.saveStoryPlan(BOOK, { fields: { protagonist: 'nobody-here' } })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.saveStoryPlan('book_nope', { fields: { premise: 'x' } })).code, 'NOT_FOUND');
    const before = await snapshot(root);
    assert.equal((await repo.saveStoryPlan(BOOK, { fields: { premise: 'x' }, dryRun: true })).ok, true);
    assert.deepEqual(await snapshot(root), before);

    const c = await repo.saveStoryPlan(BOOK, { fields: { premise: 'A key opens the wrong door.', stakes: 'Her place in the town.', protagonist: 'maren-hollis' }, body: 'Free notes.' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.path, 'planning/story.md');
    assert.deepEqual(await errorsOf(root), []);
    const p1 = await repo.getStoryPlan(BOOK);
    assert.equal(p1.path, 'planning/story.md');
    assert.match(p1.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(p1.fields, { ...none, premise: 'A key opens the wrong door.', stakes: 'Her place in the town.', protagonist: 'maren-hollis' });
    assert.equal(p1.body, 'Free notes.');

    assert.equal((await repo.saveStoryPlan(BOOK, { fields: { premise: 'y' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.saveStoryPlan(BOOK, { fields: { premise: 'y' }, baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    const e = await repo.saveStoryPlan(BOOK, { fields: { premise: 'Changed', stakes: null }, body: 'New notes.', baseSha256: p1.sha256 });
    assert.equal(e.ok, true, JSON.stringify(e));
    const p2 = await repo.getStoryPlan(BOOK);
    assert.equal(p2.fields.premise, 'Changed');
    assert.equal(p2.fields.stakes, null);
    assert.equal(p2.body, 'New notes.');
    assert.notEqual(p2.sha256, p1.sha256);
    assert.equal((await repo.restoreOp(BOOK, e.opId)).ok, true);
    assert.equal((await repo.getStoryPlan(BOOK)).sha256, p1.sha256);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('planOverview: counts on salt-orchard with two links and one scene plan, and the unlinked scenes in reading order', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.planOverview('book_nope'), null);
    const flow0 = await repo.flowGraph(BOOK);
    const empty = await repo.planOverview(BOOK);
    assert.deepEqual(empty.story, await repo.getStoryPlan(BOOK));
    assert.equal(empty.counts.scenes, flow0.nodes.length);
    assert.deepEqual({ ...empty.counts, scenes: 0, threads: 0 }, { scenes: 0, planned_scenes: 0, links: 0, linked_scenes: 0, unlinked_scenes: flow0.nodes.length, broken_links: 0, archived_links: 0, threads: 0, arcs: 0 });
    assert.deepEqual(empty.unlinked, flow0.nodes.slice(0, 50).map((n) => ({ id: n.id, title: n.title })));

    const a = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'therefore' });
    assert.equal((await repo.createLink(BOOK, { from: ARRIVAL, to: KEY, relation: 'enables' })).ok, true);
    const gone = await repo.createLink(BOOK, { from: ARRIVAL, to: FERRY, relation: 'but' });
    assert.equal((await repo.archiveLink(BOOK, gone.slug)).ok, true);
    assert.equal((await repo.saveScenePlan(BOOK, KEY, { fields: { goal: 'g' } })).ok, true);
    assert.ok(a.ok);

    const o = await repo.planOverview(BOOK);
    const total = flow0.nodes.length;
    assert.deepEqual(o.counts, { scenes: total, planned_scenes: 1, links: 2, linked_scenes: 3, unlinked_scenes: total - 3, broken_links: 0, archived_links: 1, threads: empty.counts.threads, arcs: 0 });
    assert.deepEqual(o.unlinked, flow0.nodes.filter((n) => ![KEY, FERRY, ARRIVAL].includes(n.id)).slice(0, 50).map((n) => ({ id: n.id, title: n.title })));
    assert.deepEqual(o.story, await repo.getStoryPlan(BOOK));
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});
