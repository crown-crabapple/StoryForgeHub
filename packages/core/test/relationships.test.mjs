// Story Planner M5 (ADR 0003): relationships, links to beats in listLinks / flowGraph, and the planBadges projection, end to end on copies of salt-orchard and the planner fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const ARRIVAL = 'scene_01S50000000000000000000002';
const MAREN = 'entry_01S5000000000000000000000G';
const PELL = 'entry_01S5000000000000000000000K';
const GHOST = 'scene_01S5000000000000000000ZZZZ';

async function setup(fixture = 'valid/salt-orchard') {
  const root = await copyFixture(fixture);
  return { root, repo: createFsRepository(root) };
}
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const scenesBytes = async (root) => {
  const s = await snapshot(root, { skipStoryforge: true });
  return Object.fromEntries(Object.entries(s).filter(([p]) => p.startsWith('manuscript/') || p.startsWith('archive/manuscript/')));
};

test('listRelationships / getRelationship: empty, then a created relationship with the full shape and developments', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listRelationships('book_nope'), null);
    assert.deepEqual(await repo.listRelationships(BOOK), { relationships: [], archived: [] });
    assert.equal(await repo.getRelationship(BOOK, 'nothing'), null);
    assert.equal(await repo.getRelationship(BOOK, '../x'), null);

    const c = await repo.createRelationship(BOOK, { a: MAREN, b: PELL, fields: { baseline: 'Wary of each other.' } });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.slug, 'maren-hollis-and-pell');
    const r0 = await repo.getRelationship(BOOK, c.slug);
    const set = await repo.setRelationshipDevelopments(BOOK, c.slug, {
      developments: [{ scene: KEY, change: 'Pell lends the key.', a_view: 'trusts', b_view: 'fears' }, { scene: FERRY, change: 'Paid for passage.' }],
      baseSha256: r0.sha256,
    });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listRelationships(BOOK);
    assert.equal(list.relationships.length, 1);
    const r = list.relationships[0];
    assert.deepEqual(Object.keys(r).sort(), ['a', 'b', 'baseline', 'body', 'developments', 'end_state', 'id', 'name', 'path', 'problems', 'sha256', 'slug']);
    assert.equal(r.id, c.id);
    assert.equal(r.path, 'planning/relationships/maren-hollis-and-pell.md');
    assert.equal(r.name, 'Maren Hollis & Pell');
    assert.deepEqual(r.a, { id: MAREN, slug: 'maren-hollis', name: 'Maren Hollis', type: 'character' });
    assert.deepEqual(r.b, { id: PELL, slug: 'pell', name: 'Pell', type: 'character' });
    assert.equal(r.baseline, 'Wary of each other.');
    assert.equal(r.end_state, null);
    assert.deepEqual(r.developments.map((d) => [d.scene, d.scene_title, d.change, d.a_view, d.b_view]), [[KEY, 'The Key', 'Pell lends the key.', 'trusts', 'fears'], [FERRY, 'Ferry', 'Paid for passage.', null, null]]);
    assert.equal(Number.isInteger(r.developments[0].chapter), true);
    assert.equal(Number.isInteger(r.developments[0].sequence), true);
    assert.deepEqual(r.problems, []);
    assert.deepEqual({ ...(await repo.getRelationship(BOOK, c.slug)), archived: undefined }, { ...r, archived: undefined });

    // update, then archive and restore
    const u = await repo.updateRelationship(BOOK, c.slug, { fields: { end_state: 'Allies.' }, baseSha256: r.sha256 });
    assert.equal(u.ok, true, JSON.stringify(u));
    const cur = await repo.getRelationship(BOOK, c.slug);
    assert.equal(cur.end_state, 'Allies.');
    assert.equal(cur.archived, false);
    assert.equal((await repo.planOverview(BOOK)).counts.relationships, 1);
    const a = await repo.archiveRelationship(BOOK, c.slug, { baseSha256: cur.sha256 });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(await repo.listRelationships(BOOK), { relationships: [], archived: [{ slug: c.slug, name: 'Maren Hollis & Pell' }] });
    assert.equal((await repo.getRelationship(BOOK, c.slug)).archived, true);
    assert.equal((await repo.planOverview(BOOK)).counts.relationships, 0);
    assert.equal((await repo.restoreRelationship(BOOK, c.slug, { baseSha256: cur.sha256 })).ok, true);
    assert.equal((await repo.listRelationships(BOOK)).relationships.length, 1);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('relationship writes keep their refusal codes (unknown entry and scene are not turned into NOT_FOUND)', async () => {
  const { repo } = await setup();
  try {
    const u = await repo.createRelationship(BOOK, { a: MAREN, b: 'entry_01S5000000000000000000ZZZZ' });
    assert.equal(u.code, 'REFUSED_UNKNOWN_ENTRY');
    const c = await repo.createRelationship(BOOK, { a: MAREN, b: PELL });
    const dup = await repo.createRelationship(BOOK, { a: PELL, b: MAREN });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_RELATIONSHIP');
    assert.deepEqual(dup.existing, { slug: c.slug });
    const r = await repo.getRelationship(BOOK, c.slug);
    const g = await repo.setRelationshipDevelopments(BOOK, c.slug, { developments: [{ scene: GHOST, change: 'x' }], baseSha256: r.sha256 });
    assert.equal(g.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(g.index, 0);
  } finally {
    await repo.close();
  }
});

test('planner fixture: listRelationships reads the fixture relationship', async () => {
  const { repo } = await setup('valid/planner');
  try {
    const list = await repo.listRelationships(BOOK);
    assert.equal(list.relationships.length, 1);
    const r = list.relationships[0];
    assert.equal(r.slug, 'maren-hollis-and-pell');
    assert.equal(r.name, 'Maren Hollis & Pell');
    assert.equal(r.developments.length, 2);
    assert.equal(r.developments[0].a_view, 'Maren trusts Pell a little.');
    assert.equal((await repo.planOverview(BOOK)).counts.relationships, 1);
  } finally {
    await repo.close();
  }
});

test('links to beats: listLinks titles and kinds, flowGraph beat node, broken only when an end is not a live scene or a live-structure beat', async () => {
  const { root, repo } = await setup('valid/planner');
  try {
    const flow0 = await repo.flowGraph(BOOK);
    const beatNodes = flow0.nodes.filter((n) => n.kind === 'beat');
    assert.equal(beatNodes.length, 1, 'only the beat a live link uses is a node');
    const s = await repo.getStructure(BOOK, 'main-three-act');
    const inciting = s.beats[1];
    assert.deepEqual(beatNodes[0], { id: inciting.id, kind: 'beat', title: 'Inciting event', structure: { slug: 'main-three-act', name: 'Main structure' }, chapter: null, sequence: null });
    // beat nodes come after every scene node
    assert.equal(flow0.nodes.findIndex((n) => n.kind === 'beat'), flow0.nodes.filter((n) => n.kind === 'scene').length);
    const edge = flow0.edges.find((e) => e.slug === 'key-enables-inciting-event');
    assert.equal(edge.to, inciting.id);
    assert.equal(edge.broken, false);
    assert.equal(flow0.edges.every((e) => e.broken === false), true);

    const list = await repo.listLinks(BOOK);
    const l = list.links.find((x) => x.slug === 'key-enables-inciting-event');
    assert.equal(l.from_kind, 'scene');
    assert.equal(l.to_kind, 'beat');
    assert.equal(l.from_title, 'The Key');
    assert.equal(l.to_title, 'Main structure: Inciting event');
    assert.deepEqual(l.problems, []);
    const g = await repo.getLink(BOOK, 'key-enables-inciting-event');
    assert.equal(g.to_title, 'Main structure: Inciting event');

    // overview counts are about scenes: a beat node never counts as a scene
    const o = await repo.planOverview(BOOK);
    assert.equal(o.counts.scenes, flow0.nodes.filter((n) => n.kind === 'scene').length);
    assert.equal(o.counts.links, 2);
    assert.equal(o.counts.broken_links, 0);

    // archive the structure: W303 on the link, the beat node goes, the edge is broken
    const a = await repo.archiveStructure(BOOK, 'main-three-act');
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(await errorsOf(root), []);
    const flow1 = await repo.flowGraph(BOOK);
    assert.equal(flow1.nodes.some((n) => n.kind === 'beat'), false);
    assert.equal(flow1.edges.find((e) => e.slug === 'key-enables-inciting-event').broken, true);
    assert.equal((await repo.planOverview(BOOK)).counts.broken_links, 1);
  } finally {
    await repo.close();
  }
});

test('createLink to a beat and REFUSED_BEAT_LINKED through the repository', async () => {
  const { root, repo } = await setup('valid/planner');
  try {
    const s = await repo.getStructure(BOOK, 'main-three-act');
    const final = s.beats[2];
    const c = await repo.createLink(BOOK, { from: FERRY, to: final.id, relation: 'enables' });
    assert.equal(c.ok, true, JSON.stringify(c));
    const keep = s.beats.slice(0, 2).map((b) => ({ id: b.id, name: b.name, state: b.state, scenes: b.scenes.map((x) => x.id) }));
    const r = await repo.setStructureBeats(BOOK, 'main-three-act', { beats: keep, baseSha256: s.sha256 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_BEAT_LINKED');
    assert.deepEqual(r.links, [c.slug]);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('planBadges: the planner fixture numbers, and no scene file is touched', async () => {
  const { root, repo } = await setup('valid/planner');
  try {
    assert.equal(await repo.planBadges('book_nope'), null);
    const before = await scenesBytes(root);
    const all = await snapshot(root, { skipStoryforge: true });
    const s = await repo.getStructure(BOOK, 'main-three-act');
    const b = await repo.planBadges(BOOK);
    const flow = await repo.flowGraph(BOOK);
    assert.deepEqual(Object.keys(b.scenes).sort(), flow.nodes.filter((n) => n.kind === 'scene').map((n) => n.id).sort());

    const beat = (i) => ({ structure_slug: 'main-three-act', structure_name: 'Main structure', primary: true, beat_id: s.beats[i].id, beat_name: s.beats[i].name });
    assert.deepEqual(b.scenes[KEY], {
      plan: true,
      goal: 'Prove the harbour key opens the sea gate.',
      purpose: 'Close off the safe path.',
      links_in: 0,
      links_out: 2,
      beats: [beat(0), beat(1)],
      milestones: [{ arc_slug: 'maren-hollis', name: 'Maren Hollis' }],
      relationships: [{ slug: 'maren-hollis-and-pell', name: 'Maren Hollis & Pell', change: 'Pell lends Maren the key.' }],
    });
    assert.deepEqual(b.scenes[FERRY], {
      plan: false, goal: null, purpose: null, links_in: 1, links_out: 0,
      beats: [beat(0)],
      milestones: [{ arc_slug: 'maren-hollis', name: 'Maren Hollis' }],
      relationships: [{ slug: 'maren-hollis-and-pell', name: 'Maren Hollis & Pell', change: 'Maren pays Pell for passage.' }],
    });
    assert.deepEqual(b.scenes[ARRIVAL], { plan: false, goal: null, purpose: null, links_in: 0, links_out: 0, beats: [], milestones: [], relationships: [] });
    assert.deepEqual(b.arcs, [{ slug: 'maren-hollis', name: 'Maren Hollis' }]);
    assert.deepEqual(b.structures, [{
      slug: 'main-three-act', name: 'Main structure', primary: true,
      beats: [
        { id: s.beats[0].id, name: 'Opening image', state: 'done', scenes: [KEY, FERRY] },
        { id: s.beats[1].id, name: 'Inciting event', state: 'open', scenes: [KEY] },
        { id: s.beats[2].id, name: 'Final choice', state: 'omitted', scenes: [] },
      ],
    }]);
    // read-only: nothing on disk changed
    assert.deepEqual(await scenesBytes(root), before);
    assert.deepEqual(await snapshot(root, { skipStoryforge: true }), all);
  } finally {
    await repo.close();
  }
});

test('planBadges: a link counts only while its other end resolves; scene files stay byte-identical across planning writes', async () => {
  const { root, repo } = await setup('valid/planner');
  try {
    const before = await scenesBytes(root);
    // archiving the structure makes the beat end unresolved: KEY keeps only the scene-to-scene link
    assert.equal((await repo.archiveStructure(BOOK, 'main-three-act')).ok, true);
    let b = await repo.planBadges(BOOK);
    assert.equal(b.scenes[KEY].links_out, 1);
    assert.equal(b.scenes[FERRY].links_in, 1);
    assert.deepEqual(b.scenes[KEY].beats, []);
    assert.deepEqual(b.structures, []);
    // an archived link counts for nothing
    const link = await repo.getLink(BOOK, 'key-therefore-ferry');
    assert.equal((await repo.archiveLink(BOOK, 'key-therefore-ferry', { baseSha256: link.sha256 })).ok, true);
    b = await repo.planBadges(BOOK);
    assert.equal(b.scenes[KEY].links_out, 0);
    assert.equal(b.scenes[FERRY].links_in, 0);
    assert.deepEqual(await scenesBytes(root), before);
  } finally {
    await repo.close();
  }
});
