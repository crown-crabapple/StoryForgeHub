// Story Planner M4 (ADR 0003): structures and beat sheets. createStructure, updateStructure, setStructureBeats, archiveStructure / restoreStructure, the templates, primary_structure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { extractDocs, validate } from '@storyforge/format';
import { STRUCTURE_TEMPLATES, archiveStructure, createStructure, restoreOp, restoreStructure, saveStoryPlan, setStructureBeats, templateById, updateStructure } from '../src/index.mjs';
import { ARRIVAL, FERRY, KEY, NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot, write } from './helpers.mjs';

after(cleanup);

const GHOST = 'scene_01S5000000000000000000ZZZZ';
const ARCHIVED_SCENE = 'scene_01S50000000000000000000007';
const ST = 'planning/structures/main-structure.md';
const ID_RE = /^note_[0-9A-HJKMNP-TV-Z]{26}$/;
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));

async function make(dir, extra = {}) {
  const r = await createStructure(dir, { template: 'three-act', name: 'Main structure', ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** The beats list as the format loader reads it back from the written file. */
async function beatsOnDisk(dir, rel) {
  const doc = extractDocs(await validate(dir), '').find((d) => d.rel === rel);
  assert.ok(doc, `${rel} was not loaded`);
  return doc.fm.beats;
}

describe('STRUCTURE_TEMPLATES', () => {
  it('has the eight templates, frozen, each with version 1 and well-formed beats', () => {
    assert.ok(Object.isFrozen(STRUCTURE_TEMPLATES));
    assert.deepEqual(STRUCTURE_TEMPLATES.map((t) => t.id), ['three-act', 'five-act', 'heros-journey', 'seven-point', 'story-circle', 'mystery', 'romance', 'custom']);
    const sizes = Object.fromEntries(STRUCTURE_TEMPLATES.map((t) => [t.id, t.beats.length]));
    assert.deepEqual(sizes, { 'three-act': 8, 'five-act': 5, 'heros-journey': 12, 'seven-point': 7, 'story-circle': 8, mystery: 7, romance: 8, custom: 0 });
    for (const t of STRUCTURE_TEMPLATES) {
      assert.equal(t.version, 1);
      assert.ok(t.name && t.description && !t.description.includes('\n'), t.id);
      for (const b of t.beats) {
        assert.ok(b.name && b.purpose && b.question, `${t.id}: ${b.name}`);
        assert.ok(!/[\n\r]/.test(`${b.name}${b.purpose}${b.question}${b.position ?? ''}`), t.id);
        assert.ok(!/save the cat/i.test(JSON.stringify(b)), t.id);
      }
    }
    assert.equal(templateById('mystery').id, 'mystery');
    assert.equal(templateById('nope'), null);
  });
});

describe('createStructure', () => {
  for (const t of STRUCTURE_TEMPLATES) {
    it(`creates a clean structure from the ${t.id} template`, async () => {
      const dir = copyFixture(SALT);
      const before = snapshot(dir);
      const r = await createStructure(dir, { template: t.id, name: `Plan ${t.id}` });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(r.id, ID_RE);
      assert.equal(r.path, `planning/structures/${r.slug}.md`);
      assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [r.path], removed: [], changed: [] });
      assert.deepEqual(await errorsOf(dir), []);
      const doc = extractDocs(await validate(dir), '').find((d) => d.rel === r.path);
      assert.equal(doc.fm.schema, 'storyforge.structure/v1');
      assert.equal(doc.fm.id, r.id);
      assert.equal(doc.fm.slug, r.slug);
      assert.equal(doc.fm.name, `Plan ${t.id}`);
      assert.equal(doc.fm.template, t.id);
      assert.equal(doc.fm.template_version, 1);
      const beats = doc.fm.beats ?? [];
      assert.equal(beats.length, t.beats.length);
      assert.equal(new Set(beats.map((b) => b.id)).size, t.beats.length);
      beats.forEach((b, i) => {
        assert.match(b.id, ID_RE);
        assert.equal(b.name, t.beats[i].name);
        assert.equal(b.purpose, t.beats[i].purpose);
        assert.equal(b.question, t.beats[i].question);
        assert.equal(b.position, t.beats[i].position);
        assert.equal(b.state, undefined);
        assert.equal(b.scenes, undefined);
      });
      if (t.id === 'custom') assert.ok(!/^beats:/m.test(read(dir, r.path)));
    });
  }

  it('writes the header in the ADR order; a clash gets -2', async () => {
    const dir = copyFixture(SALT);
    const a = await make(dir);
    assert.equal(a.slug, 'main-structure');
    assert.equal(a.path, ST);
    assert.ok(read(dir, ST).startsWith(`---\nschema: storyforge.structure/v1\nid: ${a.id}\nslug: main-structure\nname: Main structure\ntemplate: three-act\ntemplate_version: 1\nbeats:\n  - id: note_`));
    const b = await make(dir);
    assert.equal(b.slug, 'main-structure-2');
  });

  it('refusals: unknown template, bad name', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const t = await createStructure(dir, { template: 'save-the-cat', name: 'X' });
    assert.equal(t.code, 'REFUSED_BAD_ARGS');
    assert.equal(t.field, 'template');
    assert.equal((await createStructure(dir, { name: 'X' })).code, 'REFUSED_BAD_ARGS');
    for (const name of [undefined, '', '   ', 'a\nb', 'x'.repeat(201), 7]) {
      const r = await createStructure(dir, { template: 'custom', name });
      assert.equal(r.code, 'REFUSED_BAD_ARGS', String(name));
      assert.equal(r.field, 'name');
    }
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    assert.equal((await createStructure(dir, { template: 'custom', name: 'x'.repeat(200), dryRun: true })).ok, true);
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createStructure(dir, { template: 'three-act', name: 'Main structure', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].to, ST);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of the create removes the file again', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await make(dir);
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(!exists(dir, ST));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
  });
});

describe('updateStructure', () => {
  it('changes the name and the body; template, template_version and beats stay byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const before = read(dir, ST);
    const r = await updateStructure(dir, c.slug, { name: 'Renamed plan', body: 'Notes one.\n\nNotes two.', baseSha256: shaOf(dir, ST) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, c.slug);
    assert.equal(read(dir, ST), before.replace('name: Main structure', 'name: Renamed plan').replace(/\n---\n[\s\S]*$/, '\n---\n\nNotes one.\n\nNotes two.\n'));
    const r2 = await updateStructure(dir, c.slug, { body: '', baseSha256: shaOf(dir, ST) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.ok(read(dir, ST).endsWith('\n---\n'));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: base_sha256 required, stale is CONFLICT with current, bad args, unknown structure', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    assert.equal((await updateStructure(dir, c.slug, { name: 'x' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateStructure(dir, c.slug, { baseSha256: shaOf(dir, ST) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateStructure(dir, c.slug, { name: '', baseSha256: shaOf(dir, ST) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateStructure(dir, c.slug, { name: 'a\nb', baseSha256: shaOf(dir, ST) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateStructure(dir, 'no-such', { name: 'x', baseSha256: shaOf(dir, ST) })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await updateStructure(dir, c.slug, { name: 'x', baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, shaOf(dir, ST));
    assert.equal(r.current.text, read(dir, ST));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const before = snapshot(dir);
    const r = await updateStructure(dir, c.slug, { name: 'Other', baseSha256: shaOf(dir, ST), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('setStructureBeats', () => {
  const ITEMS = [
    { name: 'Opening image', purpose: 'Show the world.', question: 'What is normal?', position: 'about 1%', state: 'done', scenes: [KEY, FERRY] },
    { name: 'Inciting event', scenes: [KEY] },
    { name: 'Open beat', state: 'open', purpose: '' },
    { name: 'Dropped', state: 'omitted' },
  ];

  it('writes the whole list and reads it back; a beat with no id gets one, a given id is kept', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const before = snapshot(dir);
    const keepId = 'note_01S50000000000000000000B01';
    const r = await setStructureBeats(dir, c.slug, { beats: [{ id: keepId, ...ITEMS[0] }, ...ITEMS.slice(1)], baseSha256: shaOf(dir, ST) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [ST] }); // no scene file is touched
    const beats = await beatsOnDisk(dir, ST);
    assert.equal(beats.length, 4);
    assert.equal(beats[0].id, keepId);
    for (const b of beats) assert.match(b.id, ID_RE);
    assert.equal(new Set(beats.map((b) => b.id)).size, 4);
    assert.deepEqual(beats[0], { id: keepId, name: 'Opening image', purpose: 'Show the world.', question: 'What is normal?', position: 'about 1%', state: 'done', scenes: [KEY, FERRY] });
    assert.deepEqual(Object.keys(beats[2]), ['id', 'name']); // open = no state key, empty text left out
    assert.deepEqual(beats[3].state, 'omitted');
    assert.deepEqual(beats[1].scenes, [KEY]);
    assert.ok(read(dir, ST).includes(`    scenes: [${KEY}, ${FERRY}]\n`));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('keeps the other fields and the body, de-duplicates scenes in order, and the same scene can sit in two beats', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    assert.equal((await updateStructure(dir, c.slug, { body: 'Keep me.', baseSha256: shaOf(dir, ST) })).ok, true);
    const head = read(dir, ST).split('beats:\n')[0];
    const r = await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [FERRY, KEY, FERRY, KEY] }, { name: 'B', scenes: [KEY] }], baseSha256: shaOf(dir, ST) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = read(dir, ST);
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith('\n---\n\nKeep me.\n'));
    const beats = await beatsOnDisk(dir, ST);
    assert.deepEqual(beats[0].scenes, [FERRY, KEY]);
    assert.deepEqual(beats[1].scenes, [KEY]);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('an empty list removes the block; setting beats on a custom structure inserts it after template_version', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir, { template: 'custom' });
    assert.ok(!/^beats:/m.test(read(dir, ST)));
    const same = await setStructureBeats(dir, c.slug, { beats: [], baseSha256: shaOf(dir, ST) });
    assert.equal(same.ok, true);
    assert.equal(same.changes?.length ?? 0, 0);
    const set = await setStructureBeats(dir, c.slug, { beats: [{ name: 'Only beat' }], baseSha256: shaOf(dir, ST) });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.match(read(dir, ST), /template_version: 1\nbeats:\n {2}- id: note_[0-9A-HJKMNP-TV-Z]{26}\n {4}name: Only beat\n---\n$/);
    const cleared = await setStructureBeats(dir, c.slug, { beats: [], baseSha256: shaOf(dir, ST) });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.ok(!/^beats:/m.test(read(dir, ST)));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('quotes texts that need it and round trips them', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const items = [{ name: 'Why: "now"?', purpose: '# not a comment', question: 'A, b: c', position: 'about 25%' }];
    assert.equal((await setStructureBeats(dir, c.slug, { beats: items, baseSha256: shaOf(dir, ST) })).ok, true);
    const [b] = await beatsOnDisk(dir, ST);
    assert.equal(b.name, 'Why: "now"?');
    assert.equal(b.purpose, '# not a comment');
    assert.equal(b.question, 'A, b: c');
    assert.equal(b.position, 'about 25%');
  });

  it('a scene that is not a live scene is REFUSED_UNKNOWN_SCENE with the index; nothing is written', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const before = snapshot(dir);
    const r = await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [KEY] }, { name: 'B', scenes: [KEY, GHOST] }], baseSha256: shaOf(dir, ST) });
    assert.equal(r.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(r.index, 1);
    assert.equal(r.field, 'beats[1].scenes[1]');
    const archived = await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [ARCHIVED_SCENE] }], baseSha256: shaOf(dir, ST) });
    assert.equal(archived.code, 'REFUSED_UNKNOWN_SCENE');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('refusals: base_sha256, stale CONFLICT with current, bad items, bad or repeated ids, too many, unknown structure, hand-edited block with a comment', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const sha = () => shaOf(dir, ST);
    const bad = async (beats) => (await setStructureBeats(dir, c.slug, { beats, baseSha256: sha() })).code;
    assert.equal((await setStructureBeats(dir, c.slug, { beats: [] })).code, 'REFUSED_BAD_ARGS');
    assert.equal(await bad('x'), 'REFUSED_BAD_ARGS');
    assert.equal(await bad(['x']), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ purpose: 'no name' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: '' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'a\nb' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'x'.repeat(201) }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', purpose: 'x'.repeat(2001) }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', question: 'a\nb' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', mood: 'x' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', state: 'finished' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', scenes: KEY }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ name: 'A', scenes: [7] }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad([{ id: 'beat-1', name: 'A' }]), 'REFUSED_BAD_ARGS');
    const dup = 'note_01S50000000000000000000B01';
    assert.equal(await bad([{ id: dup, name: 'A' }, { id: dup, name: 'B' }]), 'REFUSED_BAD_ARGS');
    assert.equal(await bad(Array.from({ length: 201 }, () => ({ name: 'A' }))), 'REFUSED_BAD_ARGS');
    const manyScenes = Array.from({ length: 51 }, (_, i) => (i % 2 ? KEY : FERRY));
    assert.equal(await bad([{ name: 'A', scenes: manyScenes }]), 'REFUSED_BAD_ARGS');
    assert.equal((await setStructureBeats(dir, c.slug, { beats: Array.from({ length: 200 }, () => ({ name: 'A' })), baseSha256: sha(), dryRun: true })).ok, true);
    assert.equal((await setStructureBeats(dir, 'no-such', { beats: [], baseSha256: sha() })).code, 'NOT_FOUND');
    const stale = await setStructureBeats(dir, c.slug, { beats: [{ name: 'A' }], baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(stale.current.text, read(dir, ST));
    write(dir, ST, read(dir, ST).replace(/^beats:\n[\s\S]*?\n---\n/m, `beats:\n  - id: ${dup}\n    name: Keep # me\n---\n`));
    const before = snapshot(dir);
    const refused = await setStructureBeats(dir, c.slug, { beats: [{ name: 'B' }], baseSha256: sha() });
    assert.equal(refused.code, 'REFUSED_UNSIMPLE_FIELD');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('refuses a beat id that another live structure already uses (the batch would add E102)', async () => {
    const dir = copyFixture(SALT);
    const a = await make(dir);
    const b = await make(dir, { name: 'Second' });
    const [first] = await beatsOnDisk(dir, ST);
    const before = snapshot(dir);
    const r = await setStructureBeats(dir, b.slug, { beats: [{ id: first.id, name: 'Same id' }], baseSha256: shaOf(dir, `planning/structures/${b.slug}.md`) });
    assert.equal(r.ok, false);
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
    assert.equal(a.ok, true);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const before = snapshot(dir);
    const r = await setStructureBeats(dir, c.slug, { beats: ITEMS, baseSha256: shaOf(dir, ST), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('keeps CRLF line endings', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    write(dir, ST, read(dir, ST).replace(/\n/g, '\r\n'));
    const r = await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [KEY] }], baseSha256: shaOf(dir, ST) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!/[^\r]\n/.test(read(dir, ST)), 'no bare LF');
  });
});

describe('archiveStructure / restoreStructure', () => {
  it('moves the file to archive/planning/structures/ and back byte for byte; undo works', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    assert.equal((await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [KEY] }], baseSha256: shaOf(dir, ST) })).ok, true);
    const bytes = fs.readFileSync(path.join(dir, ST));
    const a = await archiveStructure(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.path, `archive/${ST}`);
    assert.ok(!exists(dir, ST));
    assert.ok(fs.readFileSync(path.join(dir, 'archive', ST)).equals(bytes));
    const r = await restoreStructure(dir, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.readFileSync(path.join(dir, ST)).equals(bytes));
    const before = snapshot(dir);
    const a2 = await archiveStructure(dir, c.slug);
    assert.equal((await restoreOp(dir, a2.opId)).ok, true);
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: unknown, stale, restore onto a live file; dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    assert.equal((await archiveStructure(dir, 'nope')).code, 'NOT_FOUND');
    assert.equal((await restoreStructure(dir, c.slug)).code, 'NOT_FOUND');
    assert.equal((await archiveStructure(dir, c.slug, { baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    const snap = snapshot(dir);
    assert.equal((await archiveStructure(dir, c.slug, { dryRun: true })).ok, true);
    assert.deepEqual(diffSnap(snap, snapshot(dir), { trash: true }), NO_DIFF);
    assert.equal((await archiveStructure(dir, c.slug)).ok, true);
    write(dir, ST, read(dir, `archive/${ST}`).replace(/^id: .*$/m, 'id: note_01S50000000000000000000A09').replace(/^(\s+- id: )note_\S+$/gm, (m, p, i) => `${p}note_01S5000000000000000000C${String(i).padStart(3, '0')}`));
    assert.equal((await restoreStructure(dir, c.slug)).code, 'REFUSED_PATH_TAKEN');
  });
});

describe('primary_structure on the story plan', () => {
  it('saveStoryPlan sets and removes it, and refuses an id that names no structure', async () => {
    const dir = copyFixture(SALT);
    const c = await make(dir);
    const set = await saveStoryPlan(dir, { fields: { premise: 'A key opens the wrong door.', primary_structure: c.id } });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.match(read(dir, 'planning/story.md'), new RegExp(`\npremise: A key opens the wrong door\\.\nprimary_structure: ${c.id}\n`));
    assert.deepEqual(await errorsOf(dir), []);
    const before = snapshot(dir);
    const ghost = await saveStoryPlan(dir, { fields: { primary_structure: 'note_01S5000000000000000000ZZZZ' }, baseSha256: shaOf(dir, 'planning/story.md') });
    assert.equal(ghost.ok, false);
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
    const cleared = await saveStoryPlan(dir, { fields: { primary_structure: null }, baseSha256: shaOf(dir, 'planning/story.md') });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.ok(!read(dir, 'planning/story.md').includes('primary_structure'));
  });
});

describe('scene files', () => {
  it('no structure operation changes a scene file', async () => {
    const dir = copyFixture(SALT);
    const scenes = (snap) => Object.fromEntries(Object.entries(snap).filter(([p]) => p.startsWith('manuscript/')));
    const before = scenes(snapshot(dir));
    const c = await make(dir);
    assert.equal((await setStructureBeats(dir, c.slug, { beats: [{ name: 'A', scenes: [KEY, ARRIVAL] }, { name: 'B', scenes: [KEY] }], baseSha256: shaOf(dir, ST) })).ok, true);
    assert.equal((await updateStructure(dir, c.slug, { name: 'New', baseSha256: shaOf(dir, ST) })).ok, true);
    assert.equal((await archiveStructure(dir, c.slug)).ok, true);
    assert.equal((await restoreStructure(dir, c.slug)).ok, true);
    assert.deepEqual(scenes(snapshot(dir)), before);
  });
});
