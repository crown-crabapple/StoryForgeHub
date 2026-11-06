// Story Planner M4 (ADR 0003): the repository methods for structures and beat sheets, end to end on a copy of salt-orchard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '@storyforge/format';
import { STRUCTURE_TEMPLATES } from '@storyforge/manuscript';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const GHOST = 'scene_01S5000000000000000000ZZZZ';

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  return { root, repo: createFsRepository(root) };
}
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

test('listStructureTemplates returns the built-in templates', async () => {
  const { repo } = await setup();
  try {
    assert.equal(await repo.listStructureTemplates(), STRUCTURE_TEMPLATES);
    assert.deepEqual((await repo.listStructureTemplates()).map((t) => t.id), ['three-act', 'five-act', 'heros-journey', 'seven-point', 'story-circle', 'mystery', 'romance', 'custom']);
  } finally {
    await repo.close();
  }
});

test('listStructures / getStructure: empty, then a created structure with the full shape and beats with scenes', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listStructures('book_nope'), null);
    assert.deepEqual(await repo.listStructures(BOOK), { structures: [], archived: [] });
    assert.equal(await repo.getStructure(BOOK, 'nothing'), null);
    assert.equal(await repo.getStructure(BOOK, '../x'), null);

    const c = await repo.createStructure(BOOK, { template: 'three-act', name: 'Main structure' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(typeof c.opId, 'string');
    assert.equal(c.slug, 'main-structure');
    let s = await repo.getStructure(BOOK, c.slug);
    assert.equal(s.beats.length, 8);
    const items = s.beats.map((b, i) => ({ id: b.id, name: b.name, purpose: b.purpose, question: b.question, position: b.position, ...(i === 0 ? { state: 'done', scenes: [KEY, FERRY] } : i === 1 ? { scenes: [KEY] } : i === 7 ? { state: 'omitted' } : {}) }));
    const set = await repo.setStructureBeats(BOOK, c.slug, { beats: items, baseSha256: s.sha256 });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listStructures(BOOK);
    assert.deepEqual(list.archived, []);
    assert.equal(list.structures.length, 1);
    s = list.structures[0];
    assert.deepEqual(Object.keys(s).sort(), ['beats', 'body', 'counts', 'id', 'name', 'primary', 'sha256', 'slug', 'template', 'template_version'].sort());
    assert.equal(s.id, c.id);
    assert.equal(s.slug, 'main-structure');
    assert.equal(s.name, 'Main structure');
    assert.equal(s.template, 'three-act');
    assert.equal(s.template_version, 1);
    assert.equal(s.primary, false);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.equal(s.body, '');
    assert.deepEqual(s.counts, { beats: 8, assigned: 2, omitted: 1 });
    assert.deepEqual(Object.keys(s.beats[0]).sort(), ['id', 'name', 'position', 'purpose', 'question', 'scenes', 'state'].sort());
    assert.equal(s.beats[0].name, 'Opening image');
    assert.equal(s.beats[0].state, 'done');
    assert.equal(s.beats[1].state, 'open');
    assert.equal(s.beats[7].state, 'omitted');
    assert.deepEqual(s.beats[0].scenes.map((x) => x.id), [KEY, FERRY]);
    assert.deepEqual(Object.keys(s.beats[0].scenes[0]).sort(), ['chapter', 'id', 'sequence', 'title']);
    assert.equal(typeof s.beats[0].scenes[0].title, 'string');
    assert.deepEqual([s.beats[0].scenes[0].chapter, s.beats[0].scenes[1].chapter], [1, 2]);
    assert.equal(Number.isInteger(s.beats[0].scenes[0].sequence), true);
    assert.deepEqual(s.beats[1].scenes.map((x) => x.id), [KEY]);
    assert.deepEqual(s.beats[2].scenes, []);
    assert.equal(s.beats[0].purpose, STRUCTURE_TEMPLATES[0].beats[0].purpose);
    assert.equal(s.beats[0].position, 'about 1%');

    assert.deepEqual(await repo.getStructure(BOOK, 'main-structure'), { ...s, archived: false });

    const upd = await repo.updateStructure(BOOK, c.slug, { name: 'Renamed', body: 'Free notes.\n\nSecond paragraph.', baseSha256: s.sha256 });
    assert.equal(upd.ok, true, JSON.stringify(upd));
    const after = await repo.getStructure(BOOK, c.slug);
    assert.equal(after.name, 'Renamed');
    assert.equal(after.body, 'Free notes.\n\nSecond paragraph.');
    assert.equal(after.template, 'three-act');
    assert.deepEqual(after.beats, s.beats);
  } finally {
    await repo.close();
  }
});

test('primary: from the story plan, first in the list, and shown in the overview', async () => {
  const { root, repo } = await setup();
  try {
    const empty = await repo.planOverview(BOOK);
    assert.equal(empty.counts.structures, 0);
    assert.equal(empty.primary_structure, null);

    const zed = await repo.createStructure(BOOK, { template: 'custom', name: 'Zed plan' });
    const alpha = await repo.createStructure(BOOK, { template: 'five-act', name: 'Alpha plan' });
    assert.equal(zed.ok && alpha.ok, true);
    assert.deepEqual((await repo.listStructures(BOOK)).structures.map((s) => [s.slug, s.primary]), [['alpha-plan', false], ['zed-plan', false]], 'by name');
    assert.equal((await repo.planOverview(BOOK)).counts.structures, 2);
    assert.equal((await repo.planOverview(BOOK)).primary_structure, null);

    const saved = await repo.saveStoryPlan(BOOK, { fields: { premise: 'A key opens the wrong door.', primary_structure: zed.id } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(await errorsOf(root), []);
    assert.deepEqual((await repo.listStructures(BOOK)).structures.map((s) => [s.slug, s.primary]), [['zed-plan', true], ['alpha-plan', false]], 'primary first');
    assert.equal((await repo.getStructure(BOOK, 'zed-plan')).primary, true);
    assert.equal((await repo.getStoryPlan(BOOK)).fields.primary_structure, zed.id);
    const o = await repo.planOverview(BOOK);
    assert.equal(o.counts.structures, 2);
    assert.deepEqual(o.primary_structure, { id: zed.id, slug: 'zed-plan', name: 'Zed plan' });

    const ghost = await repo.saveStoryPlan(BOOK, { fields: { primary_structure: 'note_01S5000000000000000000ZZZZ' }, baseSha256: (await repo.getStoryPlan(BOOK)).sha256 });
    assert.equal(ghost.ok, false);

    const cleared = await repo.saveStoryPlan(BOOK, { fields: { primary_structure: null }, baseSha256: (await repo.getStoryPlan(BOOK)).sha256 });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal((await repo.planOverview(BOOK)).primary_structure, null);
    assert.equal((await repo.listStructures(BOOK)).structures.every((s) => !s.primary), true);
  } finally {
    await repo.close();
  }
});

test('archive, restore, and planOverview counts.structures', async () => {
  const { root, repo } = await setup();
  try {
    const c = await repo.createStructure(BOOK, { template: 'custom', name: 'Plan' });
    assert.equal((await repo.planOverview(BOOK)).counts.structures, 1);
    const a = await repo.archiveStructure(BOOK, c.slug);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal((await repo.planOverview(BOOK)).counts.structures, 0);
    const list = await repo.listStructures(BOOK);
    assert.deepEqual(list.structures, []);
    assert.deepEqual(list.archived, [{ slug: 'plan', name: 'Plan' }]);
    const got = await repo.getStructure(BOOK, c.slug);
    assert.equal(got.archived, true);
    const r = await repo.restoreStructure(BOOK, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await repo.getStructure(BOOK, c.slug)).archived, false);
    assert.equal((await repo.planOverview(BOOK)).counts.structures, 1);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('codes: bad template, unknown scene (index), stale CONFLICT with current, NOT_FOUND', async () => {
  const { repo } = await setup();
  try {
    assert.equal((await repo.createStructure('book_nope', { template: 'custom', name: 'X' })).code, 'NOT_FOUND');
    assert.equal((await repo.createStructure(BOOK, { template: 'nope', name: 'X' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.createStructure(BOOK, { template: 'custom', name: '' })).code, 'REFUSED_BAD_ARGS');
    const c = await repo.createStructure(BOOK, { template: 'custom', name: 'Plan' });
    const { sha256 } = await repo.getStructure(BOOK, c.slug);
    const unk = await repo.setStructureBeats(BOOK, c.slug, { beats: [{ name: 'A', scenes: [KEY] }, { name: 'B', scenes: [GHOST] }], baseSha256: sha256 });
    assert.equal(unk.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(unk.index, 1);
    const stale = await repo.updateStructure(BOOK, c.slug, { name: 'x', baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(stale.current.sha256, sha256);
    assert.match(stale.current.text, /^---\nschema: storyforge\.structure\/v1/);
    assert.equal((await repo.updateStructure(BOOK, 'no-such', { name: 'x', baseSha256: sha256 })).code, 'NOT_FOUND');
    assert.equal((await repo.setStructureBeats(BOOK, 'no-such', { beats: [], baseSha256: sha256 })).code, 'NOT_FOUND');
    assert.equal((await repo.archiveStructure(BOOK, 'no-such')).code, 'NOT_FOUND');
    assert.equal((await repo.updateStructure(BOOK, c.slug, { name: 'x' })).code, 'REFUSED_BAD_ARGS');
  } finally {
    await repo.close();
  }
});
