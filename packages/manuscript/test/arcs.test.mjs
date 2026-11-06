// Story Planner M3 (ADR 0003): character arcs. createArc, updateArc, setArcMilestones, archiveArc / restoreArc.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { extractDocs, validate } from '@storyforge/format';
import { archiveArc, createArc, restoreArc, restoreOp, setArcMilestones, updateArc } from '../src/index.mjs';
import { ARRIVAL, FERRY, KEY, NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot, write } from './helpers.mjs';

after(cleanup);

const MAREN = 'entry_01S5000000000000000000000G';
const PELL = 'entry_01S5000000000000000000000K';
const PORT = 'entry_01S5000000000000000000000N'; // a location
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const ARC = 'planning/arcs/maren-hollis.md';
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));
const frontMatterOf = (dir, rel) => read(dir, rel).split('\n---\n')[0].slice(4);

async function withArc(dir, extra = {}) {
  const r = await createArc(dir, { character: MAREN, arc_type: 'positive', fields: { want: 'To learn what the key opens.' }, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** The milestones list as the format loader reads it back from the written file. */
async function milestonesOnDisk(dir, rel) {
  const doc = extractDocs(await validate(dir), '').find((d) => d.rel === rel);
  assert.ok(doc, `${rel} was not loaded`);
  return doc.fm.milestones;
}

describe('createArc', () => {
  it('writes planning/arcs/<entry-slug>.md in the ADR order and adds no error', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createArc(dir, { character: MAREN, arc_type: 'positive', fields: { end_state: 'Free.', want: 'To learn what the key opens.', fear: 'Being locked out: for good' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'maren-hollis');
    assert.equal(r.path, ARC);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(read(dir, ARC), `---\nschema: storyforge.arc/v1\nid: ${r.id}\nslug: maren-hollis\ncharacter: ${MAREN}\narc_type: positive\nwant: To learn what the key opens.\nfear: "Being locked out: for good"\nend_state: Free.\n---\n`);
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [ARC], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('works with only a character (no arc_type, no fields)', async () => {
    const dir = copyFixture(SALT);
    const r = await createArc(dir, { character: PELL });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'pell');
    assert.equal(read(dir, 'planning/arcs/pell.md'), `---\nschema: storyforge.arc/v1\nid: ${r.id}\nslug: pell\ncharacter: ${PELL}\n---\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('a series-shared character gets an arc in the book; the shared entry file is untouched', async () => {
    const lib = copyFixture('valid/tidewater');
    const book = path.join(lib, 'tidewater', 'low-tide');
    const before = snapshot(lib);
    const r = await createArc(book, { character: 'entry_01W10000000000000000000003', arc_type: 'flat' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'ilse-hollis');
    const d = diffSnap(before, snapshot(lib)); // (the op journal lives in the book's own .storyforge/)
    assert.deepEqual({ ...d, added: d.added.filter((p) => !p.startsWith('tidewater/low-tide/.storyforge/')) }, { added: ['tidewater/low-tide/planning/arcs/ilse-hollis.md'], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(lib), []);
  });

  it('refusals: unknown entry, not a character, duplicate live arc, bad args', async () => {
    const dir = copyFixture(SALT);
    const unknown = await createArc(dir, { character: 'entry_01S5000000000000000000ZZZZ' });
    assert.equal(unknown.code, 'REFUSED_UNKNOWN_ENTRY');
    const notChar = await createArc(dir, { character: PORT });
    assert.equal(notChar.code, 'REFUSED_BAD_ARGS');
    assert.match(notChar.message, /not a character/);
    const a = await withArc(dir);
    const dup = await createArc(dir, { character: MAREN });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_ARC');
    assert.deepEqual(dup.existing, { slug: a.slug });
    assert.equal((await createArc(dir, { character: PELL, arc_type: 'sideways' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createArc(dir, { character: PELL, fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createArc(dir, { character: PELL, fields: { want: 'a\nb' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createArc(dir, { character: PELL, fields: { want: 'x'.repeat(2001) } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createArc(dir, {})).code, 'REFUSED_BAD_ARGS');
  });

  it('an archived arc does not block a new one, and its name is taken (-2)', async () => {
    const dir = copyFixture(SALT);
    const a = await withArc(dir);
    assert.equal((await archiveArc(dir, a.slug)).ok, true);
    const b = await createArc(dir, { character: MAREN });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.slug, 'maren-hollis-2');
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createArc(dir, { character: MAREN, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].to, ARC);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of the create removes the file again', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await withArc(dir);
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(!exists(dir, ARC));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
  });
});

describe('updateArc', () => {
  it('sets, inserts in order, removes; the body is kept unless given', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    const head = (extra) => `---\nschema: storyforge.arc/v1\nid: ${c.id}\nslug: maren-hollis\ncharacter: ${MAREN}\n${extra}---\n`;
    const r = await updateArc(dir, c.slug, { arc_type: 'negative', fields: { want: 'Better want', end_state: 'Gone', need: 'To trust' }, body: 'Notes one.\n\nNotes two.', baseSha256: shaOf(dir, ARC) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(read(dir, ARC), `${head('arc_type: negative\nwant: Better want\nneed: To trust\nend_state: Gone\n')}\nNotes one.\n\nNotes two.\n`);
    const r2 = await updateArc(dir, c.slug, { arc_type: null, fields: { want: '', fear: 'Water' }, baseSha256: shaOf(dir, ARC) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(read(dir, ARC), `${head('need: To trust\nfear: Water\nend_state: Gone\n')}\nNotes one.\n\nNotes two.\n`);
    const r3 = await updateArc(dir, c.slug, { body: '', baseSha256: shaOf(dir, ARC) });
    assert.equal(r3.ok, true, JSON.stringify(r3));
    assert.equal(read(dir, ARC), head('need: To trust\nfear: Water\nend_state: Gone\n'));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('a field inserted next to milestones lands before them', async () => {
    const dir = copyFixture(SALT);
    const c = await createArc(dir, { character: MAREN });
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY }], baseSha256: shaOf(dir, ARC) })).ok, true);
    assert.equal((await updateArc(dir, c.slug, { fields: { want: 'W' }, baseSha256: shaOf(dir, ARC) })).ok, true);
    assert.equal(read(dir, ARC), `---\nschema: storyforge.arc/v1\nid: ${c.id}\nslug: maren-hollis\ncharacter: ${MAREN}\nwant: W\nmilestones:\n  - scene: ${KEY}\n---\n`);
  });

  it('refusals: base_sha256 required, stale is CONFLICT with current, bad args, unknown arc', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    assert.equal((await updateArc(dir, c.slug, { fields: { want: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateArc(dir, c.slug, { baseSha256: shaOf(dir, ARC) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateArc(dir, c.slug, { arc_type: 'x', baseSha256: shaOf(dir, ARC) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateArc(dir, c.slug, { fields: { mood: 'x' }, baseSha256: shaOf(dir, ARC) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateArc(dir, 'no-such-arc', { fields: { want: 'x' }, baseSha256: shaOf(dir, ARC) })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await updateArc(dir, c.slug, { fields: { want: 'x' }, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, shaOf(dir, ARC));
    assert.equal(r.current.text, read(dir, ARC));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    const before = snapshot(dir);
    const r = await updateArc(dir, c.slug, { fields: { need: 'n' }, baseSha256: shaOf(dir, ARC), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('setArcMilestones', () => {
  const ITEMS = [
    { scene: KEY, pressure: 'The harbourmaster wants the key back.', choice: 'She keeps it.', belief_before: 'Rules protect her', belief_after: 'Rules are a cage', cost: 'Her apprenticeship' },
    { scene: FERRY },
    { scene: ARRIVAL, pressure: 'Tricky: "quotes", a # hash, and café', cost: '42' },
  ];

  it('sets, reorders and clears the list; the block is written as mappings and round-trips exactly', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir, { fields: { want: 'W', end_state: 'E' } });
    const head = `---\nschema: storyforge.arc/v1\nid: ${c.id}\nslug: maren-hollis\ncharacter: ${MAREN}\narc_type: positive\nwant: W\nend_state: E\n`;
    const r = await setArcMilestones(dir, c.slug, { milestones: ITEMS, baseSha256: shaOf(dir, ARC) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = read(dir, ARC);
    assert.ok(text.startsWith(`${head}milestones:\n  - scene: ${KEY}\n    pressure: The harbourmaster wants the key back.\n    choice: She keeps it.\n    belief_before: Rules protect her\n    belief_after: Rules are a cage\n    cost: Her apprenticeship\n  - scene: ${FERRY}\n  - scene: ${ARRIVAL}\n    pressure: `), text);
    assert.deepEqual(await milestonesOnDisk(dir, ARC), ITEMS);
    assert.deepEqual(await errorsOf(dir), []);

    const reordered = [ITEMS[2], ITEMS[0]];
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: reordered, baseSha256: shaOf(dir, ARC) })).ok, true);
    assert.deepEqual(await milestonesOnDisk(dir, ARC), reordered);
    assert.ok(read(dir, ARC).startsWith(head));

    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [], baseSha256: shaOf(dir, ARC) })).ok, true);
    assert.equal(read(dir, ARC), `${head}---\n`);
    // clearing when there is nothing to clear changes nothing
    const again = await setArcMilestones(dir, c.slug, { milestones: [], baseSha256: shaOf(dir, ARC) });
    assert.equal(again.ok, true);
    assert.equal(again.changes.length, 0);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('the body and the other lines are kept byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    assert.equal((await updateArc(dir, c.slug, { body: 'Notes.', baseSha256: shaOf(dir, ARC) })).ok, true);
    const before = read(dir, ARC);
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY }], baseSha256: shaOf(dir, ARC) })).ok, true);
    assert.equal(read(dir, ARC), before.replace('\n---\n\nNotes.', `\nmilestones:\n  - scene: ${KEY}\n---\n\nNotes.`));
  });

  it('CRLF files keep their line endings', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    write(dir, ARC, read(dir, ARC).replace(/\n/g, '\r\n'));
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY, cost: 'x' }], baseSha256: shaOf(dir, ARC) })).ok, true);
    const text = read(dir, ARC);
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF');
    assert.ok(text.includes(`milestones:\r\n  - scene: ${KEY}\r\n    cost: x\r\n`));
  });

  it('a milestone scene that is not a live scene is REFUSED_UNKNOWN_SCENE with the index; nothing is written', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    const before = snapshot(dir);
    const r = await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY }, { scene: GHOST }], baseSha256: shaOf(dir, ARC) });
    assert.equal(r.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(r.index, 1);
    assert.equal(r.field, 'milestones[1].scene');
    const archived = await setArcMilestones(dir, c.slug, { milestones: [{ scene: 'scene_01S50000000000000000000007' }], baseSha256: shaOf(dir, ARC) });
    assert.equal(archived.code, 'REFUSED_UNKNOWN_SCENE');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('refusals: base_sha256, stale CONFLICT with current, bad items, too many, unknown arc, hand-edited block with a comment', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    const sha = () => shaOf(dir, ARC);
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: 'x', baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ pressure: 'x' }], baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY, mood: 'x' }], baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY, cost: 'a\nb' }], baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY, cost: 'x'.repeat(2001) }], baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: Array.from({ length: 201 }, () => ({ scene: KEY })), baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: Array.from({ length: 200 }, () => ({ scene: KEY })), baseSha256: sha(), dryRun: true })).ok, true);
    assert.equal((await setArcMilestones(dir, 'no-such-arc', { milestones: [], baseSha256: sha() })).code, 'NOT_FOUND');
    const stale = await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY }], baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(stale.current.text, read(dir, ARC));
    write(dir, ARC, read(dir, ARC).replace('\n---\n', `\nmilestones:\n  - scene: ${KEY} # keep\n---\n`));
    const before = snapshot(dir);
    const refused = await setArcMilestones(dir, c.slug, { milestones: [{ scene: FERRY }], baseSha256: sha() });
    assert.equal(refused.code, 'REFUSED_UNSIMPLE_FIELD');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    const before = snapshot(dir);
    const r = await setArcMilestones(dir, c.slug, { milestones: ITEMS, baseSha256: shaOf(dir, ARC), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('archiveArc / restoreArc', () => {
  it('moves the file to archive/planning/arcs/ and back byte for byte; undo works', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY }], baseSha256: shaOf(dir, ARC) })).ok, true);
    const bytes = fs.readFileSync(path.join(dir, ARC));
    const a = await archiveArc(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.path, `archive/${ARC}`);
    assert.ok(!exists(dir, ARC));
    assert.ok(fs.readFileSync(path.join(dir, 'archive', ARC)).equals(bytes));
    const r = await restoreArc(dir, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.readFileSync(path.join(dir, ARC)).equals(bytes));
    const before = snapshot(dir);
    const a2 = await archiveArc(dir, c.slug);
    assert.equal((await restoreOp(dir, a2.opId)).ok, true);
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: unknown, stale, restore onto a live file, restore when a live arc exists for the character', async () => {
    const dir = copyFixture(SALT);
    const c = await withArc(dir);
    assert.equal((await archiveArc(dir, 'nope')).code, 'NOT_FOUND');
    assert.equal((await restoreArc(dir, c.slug)).code, 'NOT_FOUND');
    const stale = await archiveArc(dir, c.slug, { baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal((await archiveArc(dir, c.slug)).ok, true);
    write(dir, ARC, read(dir, `archive/${ARC}`).replace(/^id: .*$/m, 'id: note_01S50000000000000000000A09').replace(MAREN, PELL));
    assert.equal((await restoreArc(dir, c.slug)).code, 'REFUSED_PATH_TAKEN');
    fs.rmSync(path.join(dir, ARC));
    const twin = await createArc(dir, { character: MAREN });
    assert.equal(twin.slug, 'maren-hollis-2');
    const r = await restoreArc(dir, c.slug);
    assert.equal(r.code, 'REFUSED_DUPLICATE_ARC');
    assert.deepEqual(r.existing, { slug: twin.slug });
  });
});

describe('arcs never write Codex entries or scenes', () => {
  it('BYTE SNAPSHOT: only files under planning/arcs/ (and archive/planning/arcs/) change', async () => {
    const dir = copyFixture(SALT);
    const outside = () => new Map([...snapshot(dir)].filter(([p]) => !p.startsWith('planning/arcs/') && !p.startsWith('archive/planning/arcs/') && !p.startsWith('.storyforge/')));
    const base = outside();
    const same = (label) => assert.deepEqual(outside(), base, `${label} changed a file outside planning/arcs/`);
    const c = await withArc(dir);
    same('createArc');
    assert.equal((await updateArc(dir, c.slug, { arc_type: 'flat', fields: { need: 'n' }, body: 'b', baseSha256: shaOf(dir, ARC) })).ok, true);
    same('updateArc');
    assert.equal((await setArcMilestones(dir, c.slug, { milestones: [{ scene: KEY, cost: 'c' }, { scene: FERRY }], baseSha256: shaOf(dir, ARC) })).ok, true);
    same('setArcMilestones');
    assert.equal((await archiveArc(dir, c.slug)).ok, true);
    same('archiveArc');
    assert.equal((await restoreArc(dir, c.slug)).ok, true);
    same('restoreArc');
    const d = await createArc(dir, { character: PELL, dryRun: true });
    assert.equal(d.ok, true);
    same('dry run');
    for (const rel of ['codex/characters/maren-hollis.md', 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md']) assert.ok(base.has(rel), rel);
  });
});
