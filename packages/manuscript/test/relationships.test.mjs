// Story Planner M5 (ADR 0003): relationships and links to beats. createRelationship, updateRelationship, setRelationshipDevelopments, archiveRelationship / restoreRelationship,
// createLink / updateLink with a beat id, and REFUSED_BEAT_LINKED from setStructureBeats.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { extractDocs, validate } from '@storyforge/format';
import {
  archiveLink, archiveRelationship, archiveStructure, createLink, createRelationship, createStructure, restoreOp, restoreRelationship, setRelationshipDevelopments,
  setStructureBeats, updateLink, updateRelationship,
} from '../src/index.mjs';
import { FERRY, KEY, NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot } from './helpers.mjs';

after(cleanup);

const MAREN = 'entry_01S5000000000000000000000G';
const PELL = 'entry_01S5000000000000000000000K';
const PORT = 'entry_01S5000000000000000000000N'; // a location
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const REL = 'planning/relationships/maren-hollis-and-pell.md';
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));

async function withRel(dir, extra = {}) {
  const r = await createRelationship(dir, { a: MAREN, b: PELL, fields: { baseline: 'Wary of each other.' }, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

async function developmentsOnDisk(dir, rel) {
  const doc = extractDocs(await validate(dir), '').find((d) => d.rel === rel);
  assert.ok(doc, `${rel} was not loaded`);
  return doc.fm.developments;
}

describe('createRelationship', () => {
  it('writes planning/relationships/<a>-and-<b>.md in the ADR order and adds no error', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createRelationship(dir, { a: MAREN, b: PELL, fields: { end_state: 'Allies.', baseline: 'Wary: of each other' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'maren-hollis-and-pell');
    assert.equal(r.path, REL);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(read(dir, REL), `---\nschema: storyforge.relationship/v1\nid: ${r.id}\nslug: maren-hollis-and-pell\na: ${MAREN}\nb: ${PELL}\nbaseline: "Wary: of each other"\nend_state: Allies.\n---\n`);
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [REL], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('works with entries of any type and no fields', async () => {
    const dir = copyFixture(SALT);
    const r = await createRelationship(dir, { a: MAREN, b: PORT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'maren-hollis-and-port-aldine');
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: unknown entry, the same entry twice, bad fields, a duplicate pair in either order', async () => {
    const dir = copyFixture(SALT);
    const u = await createRelationship(dir, { a: MAREN, b: 'entry_01S5000000000000000000ZZZZ' });
    assert.equal(u.code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal(u.field, 'b');
    assert.equal((await createRelationship(dir, { a: MAREN, b: MAREN })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createRelationship(dir, { a: MAREN, b: PELL, fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createRelationship(dir, { a: MAREN, b: PELL, fields: { baseline: 'two\nlines' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createRelationship(dir, { a: MAREN })).code, 'REFUSED_BAD_ARGS');
    await withRel(dir);
    const before = snapshot(dir);
    const d1 = await createRelationship(dir, { a: MAREN, b: PELL });
    assert.equal(d1.code, 'REFUSED_DUPLICATE_RELATIONSHIP');
    assert.deepEqual(d1.existing, { slug: 'maren-hollis-and-pell' });
    const d2 = await createRelationship(dir, { a: PELL, b: MAREN });
    assert.equal(d2.code, 'REFUSED_DUPLICATE_RELATIONSHIP');
    assert.deepEqual(d2.existing, { slug: 'maren-hollis-and-pell' });
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createRelationship(dir, { a: MAREN, b: PELL, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].to, REL);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of the create removes the file again', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await withRel(dir);
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(!exists(dir, REL));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
  });
});

describe('updateRelationship', () => {
  it('sets, inserts, removes; a and b and the body are kept unless given', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const r = await updateRelationship(dir, c.slug, { fields: { end_state: 'Allies.', baseline: null }, body: 'Notes.\n', baseSha256: shaOf(dir, REL) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(read(dir, REL), `---\nschema: storyforge.relationship/v1\nid: ${c.id}\nslug: maren-hollis-and-pell\na: ${MAREN}\nb: ${PELL}\nend_state: Allies.\n---\n\nNotes.\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: base_sha256 required, stale is CONFLICT with current, a and b are not fields, unknown relationship', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    assert.equal((await updateRelationship(dir, c.slug, { fields: { baseline: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateRelationship(dir, c.slug, { baseSha256: shaOf(dir, REL) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateRelationship(dir, c.slug, { fields: { a: PORT }, baseSha256: shaOf(dir, REL) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateRelationship(dir, 'no-such', { fields: { baseline: 'x' }, baseSha256: shaOf(dir, REL) })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await updateRelationship(dir, c.slug, { fields: { baseline: 'x' }, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, shaOf(dir, REL));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const before = snapshot(dir);
    const r = await updateRelationship(dir, c.slug, { fields: { end_state: 'x' }, baseSha256: shaOf(dir, REL), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('setRelationshipDevelopments', () => {
  const ITEMS = [
    { scene: KEY, change: 'Pell lends Maren the key.', a_view: 'Maren trusts Pell.', b_view: 'Pell fears Maren.' },
    { scene: FERRY, change: 'Maren pays for passage.' },
  ];

  it('writes the whole list, round trips, replaces and removes it, and adds no error', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const r = await setRelationshipDevelopments(dir, c.slug, { developments: ITEMS, baseSha256: shaOf(dir, REL) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await developmentsOnDisk(dir, REL), ITEMS);
    assert.match(read(dir, REL), /baseline: Wary of each other\.\ndevelopments:\n {2}- scene: scene_/);
    assert.deepEqual(await errorsOf(dir), []);
    const r2 = await setRelationshipDevelopments(dir, c.slug, { developments: [ITEMS[1]], baseSha256: shaOf(dir, REL) });
    assert.equal(r2.ok, true);
    assert.deepEqual(await developmentsOnDisk(dir, REL), [ITEMS[1]]);
    const r3 = await setRelationshipDevelopments(dir, c.slug, { developments: [], baseSha256: shaOf(dir, REL) });
    assert.equal(r3.ok, true);
    assert.ok(!/developments/.test(read(dir, REL)));
  });

  it('refusals: unknown scene with index, change required, single line, unknown key, too many, stale, unknown relationship', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const sha = () => shaOf(dir, REL);
    const u = await setRelationshipDevelopments(dir, c.slug, { developments: [ITEMS[0], { scene: GHOST, change: 'x' }], baseSha256: sha() });
    assert.equal(u.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(u.index, 1);
    for (const bad of [[{ scene: KEY }], [{ scene: KEY, change: '' }], [{ scene: KEY, change: 'a\nb' }], [{ scene: KEY, change: 'x', a_view: 'a\nb' }], [{ scene: KEY, change: 'x', mood: 'y' }], [{ change: 'x' }], ['text']]) {
      assert.equal((await setRelationshipDevelopments(dir, c.slug, { developments: bad, baseSha256: sha() })).code, 'REFUSED_BAD_ARGS', JSON.stringify(bad));
    }
    assert.equal((await setRelationshipDevelopments(dir, c.slug, { developments: [{ scene: KEY, change: 'x'.repeat(2001) }], baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setRelationshipDevelopments(dir, c.slug, { developments: Array.from({ length: 201 }, () => ({ scene: KEY, change: 'x' })), baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setRelationshipDevelopments(dir, c.slug, { developments: ITEMS })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setRelationshipDevelopments(dir, 'no-such', { developments: ITEMS, baseSha256: sha() })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await setRelationshipDevelopments(dir, c.slug, { developments: ITEMS, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('accepts 200 items; dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const before = snapshot(dir);
    const r = await setRelationshipDevelopments(dir, c.slug, { developments: Array.from({ length: 200 }, () => ({ scene: KEY, change: 'x' })), baseSha256: shaOf(dir, REL), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of a developments change restores the file', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const bytes = fs.readFileSync(path.join(dir, REL));
    const r = await setRelationshipDevelopments(dir, c.slug, { developments: ITEMS, baseSha256: sha256(bytes) });
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual(fs.readFileSync(path.join(dir, REL)), bytes);
  });
});

describe('archiveRelationship / restoreRelationship', () => {
  it('moves the file to archive/planning/relationships/ and back byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    const bytes = fs.readFileSync(path.join(dir, REL));
    const a = await archiveRelationship(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.path, `archive/${REL}`);
    assert.ok(!exists(dir, REL));
    assert.deepEqual(await errorsOf(dir), []);
    const b = await restoreRelationship(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.deepEqual(fs.readFileSync(path.join(dir, REL)), bytes);
  });

  it('restore with a live relationship for the same pair is REFUSED_DUPLICATE_RELATIONSHIP', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    assert.equal((await archiveRelationship(dir, c.slug)).ok, true);
    const second = await createRelationship(dir, { a: PELL, b: MAREN });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.slug, 'pell-and-maren-hollis');
    const r = await restoreRelationship(dir, c.slug);
    assert.equal(r.code, 'REFUSED_DUPLICATE_RELATIONSHIP');
    assert.deepEqual(r.existing, { slug: 'pell-and-maren-hollis' });
  });

  it('unknown relationship is NOT_FOUND; a stale sha is CONFLICT', async () => {
    const dir = copyFixture(SALT);
    const c = await withRel(dir);
    assert.equal((await archiveRelationship(dir, 'nope')).code, 'NOT_FOUND');
    assert.equal((await restoreRelationship(dir, c.slug)).code, 'NOT_FOUND');
    assert.equal((await archiveRelationship(dir, c.slug, { baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
  });
});

describe('links to beats', () => {
  async function withStructure(dir) {
    const s = await createStructure(dir, { template: 'three-act', name: 'Main structure' });
    assert.equal(s.ok, true, JSON.stringify(s));
    const doc = extractDocs(await validate(dir), '').find((d) => d.rel === s.path);
    return { slug: s.slug, path: s.path, beats: doc.fm.beats };
  }

  it('createLink accepts a beat id as from or to, names the file after the beat, adds no error', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const beat = st.beats[1];
    const r = await createLink(dir, { from: KEY, to: beat.id, relation: 'enables' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.slug, /^[a-z0-9-]+-enables-[a-z0-9-]+$/);
    assert.ok(r.slug.endsWith(`-enables-${beat.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`), r.slug);
    assert.deepEqual(await errorsOf(dir), []);
    const r2 = await createLink(dir, { from: st.beats[0].id, to: st.beats[1].id, relation: 'therefore' });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('an unknown id still gives REFUSED_UNKNOWN_SCENE and says scene or beat; a beat of an archived structure is unknown; from = to is REFUSED_SELF_LINK', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const u = await createLink(dir, { from: KEY, to: GHOST, relation: 'but' });
    assert.equal(u.code, 'REFUSED_UNKNOWN_SCENE');
    assert.match(u.message, /scene or beat/);
    assert.equal(u.field, 'to');
    const s = await createLink(dir, { from: st.beats[0].id, to: st.beats[0].id, relation: 'but' });
    assert.equal(s.code, 'REFUSED_SELF_LINK');
    assert.equal((await archiveStructure(dir, st.slug)).ok, true);
    assert.equal((await createLink(dir, { from: KEY, to: st.beats[0].id, relation: 'but' })).code, 'REFUSED_UNKNOWN_SCENE');
  });

  it('updateLink can re-point an end to a beat', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const c = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore' });
    const r = await updateLink(dir, c.slug, { to: st.beats[2].id, baseSha256: shaOf(dir, c.path) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(read(dir, c.path), new RegExp(`\\nto: ${st.beats[2].id}\\n`));
    assert.deepEqual(await errorsOf(dir), []);
    const bad = await updateLink(dir, c.slug, { to: GHOST, baseSha256: shaOf(dir, c.path) });
    assert.equal(bad.code, 'REFUSED_UNKNOWN_SCENE');
    assert.match(bad.message, /scene or beat/);
  });

  it('setStructureBeats refuses to remove a beat that a live link uses, with the link slugs; a re-pointed link does not block', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const link = await createLink(dir, { from: KEY, to: st.beats[1].id, relation: 'enables' });
    const keep = st.beats.filter((b) => b.id !== st.beats[1].id).map((b) => ({ id: b.id, name: b.name }));
    const before = snapshot(dir);
    const r = await setStructureBeats(dir, st.slug, { beats: keep, baseSha256: shaOf(dir, st.path) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_BEAT_LINKED');
    assert.deepEqual(r.links, [link.slug]);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    // reordering and renaming that keep the id are fine
    const all = st.beats.map((b) => ({ id: b.id, name: `${b.name}!` })).reverse();
    assert.equal((await setStructureBeats(dir, st.slug, { beats: all, baseSha256: shaOf(dir, st.path) })).ok, true);
    // re-point the link at a scene, then the beat can go
    assert.equal((await updateLink(dir, link.slug, { to: FERRY, baseSha256: shaOf(dir, link.path) })).ok, true);
    const r2 = await setStructureBeats(dir, st.slug, { beats: keep, baseSha256: shaOf(dir, st.path) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('setStructureBeats refuses to remove a beat that only an ARCHIVED link uses: links is empty, archived_links names it, nothing is written', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const link = await createLink(dir, { from: KEY, to: st.beats[1].id, relation: 'enables' });
    assert.equal((await archiveLink(dir, link.slug)).ok, true);
    const keep = st.beats.filter((b) => b.id !== st.beats[1].id).map((b) => ({ id: b.id, name: b.name }));
    const before = snapshot(dir);
    const r = await setStructureBeats(dir, st.slug, { beats: keep, baseSha256: shaOf(dir, st.path) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_BEAT_LINKED');
    assert.deepEqual(r.links, []);
    assert.deepEqual(r.archived_links, [link.slug]);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('archiveStructure with a linked beat is allowed and leaves W303 warnings, no error', async () => {
    const dir = copyFixture(SALT);
    const st = await withStructure(dir);
    const link = await createLink(dir, { from: KEY, to: st.beats[1].id, relation: 'enables' });
    const a = await archiveStructure(dir, st.slug);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(await errorsOf(dir), []);
    const result = await validate(dir);
    assert.ok(result.diagnostics.some((d) => d.code === 'W303' && d.file === link.path && d.location === 'to'));
  });
});
