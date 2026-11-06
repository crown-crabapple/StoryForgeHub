// Story Planner M3 (ADR 0003): the repository methods for character arcs, end to end on a copy of salt-orchard (and of tidewater for a shared character).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const MAREN = 'entry_01S5000000000000000000000G';
const PELL = 'entry_01S5000000000000000000000K';
const PORT = 'entry_01S5000000000000000000000N';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const GHOST = 'scene_01S5000000000000000000ZZZZ';

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  return { root, repo: createFsRepository(root) };
}
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

test('listArcs / getArc: empty, then created arcs sorted by character name with the full shape', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listArcs('book_nope'), null);
    assert.deepEqual(await repo.listArcs(BOOK), { arcs: [], archived: [] });
    assert.equal(await repo.getArc(BOOK, 'nothing'), null);
    assert.equal(await repo.getArc(BOOK, '../x'), null);

    const pell = await repo.createArc(BOOK, { character: PELL, arc_type: 'flat' });
    assert.equal(pell.ok, true, JSON.stringify(pell));
    assert.equal(typeof pell.opId, 'string');
    const c = await repo.createArc(BOOK, { character: MAREN, arc_type: 'positive', fields: { want: 'To learn what the key opens.', fear: 'Being locked out' } });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.slug, 'maren-hollis');
    const m = await repo.setArcMilestones(BOOK, c.slug, { milestones: [{ scene: FERRY, pressure: 'The ferry leaves.' }, { scene: KEY, choice: 'Keeps the key', cost: 'Her place' }], baseSha256: (await repo.getArc(BOOK, c.slug)).sha256 });
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listArcs(BOOK);
    assert.deepEqual(list.arcs.map((a) => a.slug), ['maren-hollis', 'pell'], 'sorted by character name');
    assert.deepEqual(list.archived, []);
    const a = list.arcs[0];
    assert.deepEqual(Object.keys(a).sort(), ['arc_type', 'body', 'character', 'character_id', 'fields', 'id', 'milestones', 'path', 'problems', 'sha256', 'slug'].sort());
    assert.equal(a.id, c.id);
    assert.equal(a.path, 'planning/arcs/maren-hollis.md');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(a.character, { id: MAREN, slug: 'maren-hollis', name: 'Maren Hollis', shared: false });
    assert.equal(a.character_id, MAREN);
    assert.equal(a.arc_type, 'positive');
    assert.deepEqual(a.fields, { want: 'To learn what the key opens.', need: null, false_belief: null, fear: 'Being locked out', wound: null, start_state: null, end_state: null });
    assert.equal(a.milestones.length, 2);
    assert.deepEqual(Object.keys(a.milestones[0]).sort(), ['belief_after', 'belief_before', 'chapter', 'choice', 'cost', 'index', 'pressure', 'scene', 'scene_title', 'sequence'].sort());
    assert.equal(a.milestones[0].index, 0);
    assert.equal(a.milestones[0].scene, FERRY);
    assert.equal(typeof a.milestones[0].scene_title, 'string');
    assert.equal(a.milestones[0].chapter, 2);
    assert.equal(Number.isInteger(a.milestones[0].sequence), true);
    assert.equal(a.milestones[0].pressure, 'The ferry leaves.');
    assert.equal(a.milestones[0].choice, null);
    assert.deepEqual([a.milestones[1].index, a.milestones[1].scene, a.milestones[1].choice, a.milestones[1].cost, a.milestones[1].chapter], [1, KEY, 'Keeps the key', 'Her place', 1]);
    assert.equal(a.body, '');
    assert.deepEqual(a.problems, []);
    assert.equal(list.arcs[1].arc_type, 'flat');
    assert.deepEqual(list.arcs[1].milestones, []);

    assert.deepEqual(await repo.getArc(BOOK, 'maren-hollis'), { ...a, archived: false });

    const upd = await repo.updateArc(BOOK, c.slug, { body: 'Free notes.\n\nSecond paragraph.', baseSha256: a.sha256 });
    assert.equal(upd.ok, true, JSON.stringify(upd));
    assert.equal((await repo.getArc(BOOK, c.slug)).body, 'Free notes.\n\nSecond paragraph.');
  } finally {
    await repo.close();
  }
});

test('archive, restore, and planOverview counts.arcs', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal((await repo.planOverview(BOOK)).counts.arcs, 0);
    const c = await repo.createArc(BOOK, { character: MAREN });
    assert.equal((await repo.planOverview(BOOK)).counts.arcs, 1);
    const a = await repo.archiveArc(BOOK, c.slug);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal((await repo.planOverview(BOOK)).counts.arcs, 0);
    const list = await repo.listArcs(BOOK);
    assert.deepEqual([list.arcs.length, list.archived.map((x) => x.slug)], [0, ['maren-hollis']]);
    const got = await repo.getArc(BOOK, c.slug);
    assert.equal(got.archived, true);
    assert.equal(got.path, 'archive/planning/arcs/maren-hollis.md');
    const r = await repo.restoreArc(BOOK, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await repo.getArc(BOOK, c.slug)).archived, false);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('codes: unknown entry, not a character, duplicate (existing), unknown scene (index), stale CONFLICT with current, NOT_FOUND', async () => {
  const { repo } = await setup();
  try {
    assert.equal((await repo.createArc('book_nope', { character: MAREN })).code, 'NOT_FOUND');
    assert.equal((await repo.createArc(BOOK, { character: 'entry_01S5000000000000000000ZZZZ' })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.createArc(BOOK, { character: PORT })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.createArc(BOOK, { character: MAREN, arc_type: 'wavy' })).code, 'REFUSED_BAD_ARGS');
    const c = await repo.createArc(BOOK, { character: MAREN });
    const dup = await repo.createArc(BOOK, { character: MAREN });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_ARC');
    assert.deepEqual(dup.existing, { slug: c.slug });
    const { sha256 } = await repo.getArc(BOOK, c.slug);
    const unk = await repo.setArcMilestones(BOOK, c.slug, { milestones: [{ scene: KEY }, { scene: GHOST }], baseSha256: sha256 });
    assert.equal(unk.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(unk.index, 1);
    const stale = await repo.updateArc(BOOK, c.slug, { fields: { want: 'x' }, baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(stale.current.sha256, sha256);
    assert.match(stale.current.text, /^---\nschema: storyforge\.arc\/v1/);
    assert.equal((await repo.updateArc(BOOK, 'no-such-arc', { fields: { want: 'x' }, baseSha256: sha256 })).code, 'NOT_FOUND');
    assert.equal((await repo.archiveArc(BOOK, 'no-such-arc')).code, 'NOT_FOUND');
    assert.equal((await repo.updateArc(BOOK, c.slug, { fields: { want: 'x' } })).code, 'REFUSED_BAD_ARGS');
  } finally {
    await repo.close();
  }
});

test('a milestone stays on its scene (title, new chapter and sequence) after the scene is moved to another chapter', async () => {
  const { root, repo } = await setup();
  try {
    const c = await repo.createArc(BOOK, { character: MAREN });
    const { sha256 } = await repo.getArc(BOOK, c.slug);
    assert.equal((await repo.setArcMilestones(BOOK, c.slug, { milestones: [{ scene: KEY, choice: 'Keeps the key' }], baseSha256: sha256 })).ok, true);
    const arcBefore = await repo.getArc(BOOK, c.slug);
    const before = arcBefore.milestones[0];
    assert.equal(before.chapter, 1);

    const moved = await repo.moveScene(BOOK, KEY, { chapter: 2, after: null });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const after = await repo.getArc(BOOK, c.slug);
    assert.equal(after.sha256, arcBefore.sha256, 'the arc file itself is untouched by the move');
    assert.equal(after.milestones[0].scene, KEY);
    assert.equal(after.milestones[0].scene_title, before.scene_title);
    assert.equal(after.milestones[0].chapter, 2);
    assert.notEqual(after.milestones[0].sequence, before.sequence);
    assert.equal(after.milestones[0].choice, 'Keeps the key');
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('a series-shared character resolves with shared: true', async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root);
  const LOW_TIDE = 'book_01W1000000000000000000000A';
  const ILSE = 'entry_01W10000000000000000000003';
  try {
    const c = await repo.createArc(LOW_TIDE, { character: ILSE, arc_type: 'flat' });
    assert.equal(c.ok, true, JSON.stringify(c));
    const a = (await repo.listArcs(LOW_TIDE)).arcs[0];
    assert.deepEqual(a.character, { id: ILSE, slug: 'ilse-hollis', name: 'Ilse Hollis', shared: true });
    assert.deepEqual(await errorsOf(root), []);
    assert.equal((await repo.planOverview(LOW_TIDE)).counts.arcs, 1);
  } finally {
    await repo.close();
  }
});

test('an arc whose character id names no entry: character is null, character_id is kept, problems carry the E301', async () => {
  const { root, repo } = await setup();
  try {
    const dir = path.join(root, 'planning', 'arcs');
    await fs.mkdir(dir, { recursive: true });
    const id = 'entry_01S5000000000000000000ZZZZ';
    await fs.writeFile(path.join(dir, 'ghost.md'), `---\nschema: storyforge.arc/v1\nid: note_01S50000000000000000000A01\nslug: ghost\ncharacter: ${id}\n---\n`);
    const list = await repo.listArcs(BOOK);
    assert.equal(list.arcs.length, 1);
    assert.equal(list.arcs[0].character, null);
    assert.equal(list.arcs[0].character_id, id);
    assert.ok(list.arcs[0].problems.some((p) => p.code === 'E301'));
  } finally {
    await repo.close();
  }
});
