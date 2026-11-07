// Story Planner M8 (ADR 0003): clues and the link branch. createClue, updateClue, setClueKnowers, archiveClue / restoreClue, undo of a create,
// createLink / updateLink with a branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { extractDocs, validate } from '@storyforge/format';
import { archiveClue, archiveLink, createClue, createLink, restoreClue, restoreOp, setClueKnowers, updateClue, updateLink } from '../src/index.mjs';
import { ARRIVAL, FERRY, KEY, NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot } from './helpers.mjs';

after(cleanup);

const MAREN = 'entry_01S5000000000000000000000G';
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const CLUE = 'planning/clues/the-harbour-key-opens-the-sea-gate.md';
const FACT = 'The harbour key opens the sea gate';
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));

async function withClue(dir, extra = {}) {
  const r = await createClue(dir, { fact: FACT, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

async function docOnDisk(dir, rel) {
  const doc = extractDocs(await validate(dir), '').find((d) => d.rel === rel);
  assert.ok(doc, `${rel} was not loaded`);
  return doc;
}

describe('createClue', () => {
  it('writes planning/clues/<slug>.md in the ADR order and adds no error', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createClue(dir, { fact: FACT, kind: 'secret', fields: { planted: [ARRIVAL, KEY], revealed: FERRY, red_herring: false } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'the-harbour-key-opens-the-sea-gate');
    assert.equal(r.path, CLUE);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(read(dir, CLUE), new RegExp(`^---\\nschema: storyforge.clue/v1\\nid: ${r.id}\\nslug: ${r.slug}\\nfact: ${FACT}\\nkind: secret\\nplanted: \\[${ARRIVAL}, ${KEY}\\]\\nrevealed: ${FERRY}\\nred_herring: false\\ncreated: \\d{4}-\\d{2}-\\d{2}\\n---\\n$`));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [CLUE], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(dir), []);
    const doc = await docOnDisk(dir, CLUE);
    assert.deepEqual([doc.fm.kind, doc.fm.planted, doc.fm.revealed, doc.fm.red_herring], ['secret', [ARRIVAL, KEY], FERRY, false]);
  });

  it('needs only a fact; a fact with a colon is quoted; the slug is cut to 56 characters; a clash gets -2', async () => {
    const dir = copyFixture(SALT);
    const a = await createClue(dir, { fact: 'Who has the key: Pell' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.match(read(dir, a.path), /\nfact: "Who has the key: Pell"\n/);
    assert.ok(!/kind:|planted:|revealed:/.test(read(dir, a.path)));
    const long = await createClue(dir, { fact: 'word '.repeat(40) });
    assert.equal(long.ok, true);
    assert.ok(long.slug.length <= 56, long.slug);
    const b = await createClue(dir, { fact: 'Who has the key: Pell!' });
    assert.equal(b.slug, 'who-has-the-key-pell-2');
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: bad fact, kind, fields; unknown scene with its field', async () => {
    const dir = copyFixture(SALT);
    for (const args of [{}, { fact: '' }, { fact: 'two\nlines' }, { fact: 'x'.repeat(2001) }, { fact: FACT, kind: 'hint' }, { fact: FACT, fields: { mood: 'x' } }, { fact: FACT, fields: { fact: 'x' } },
      { fact: FACT, fields: { planted: 'scene' } }, { fact: FACT, fields: { planted: [1] } }, { fact: FACT, fields: { revealed: ['a'] } }, { fact: FACT, fields: { red_herring: 'yes' } }, { fact: FACT, fields: [] }]) {
      assert.equal((await createClue(dir, args)).code, 'REFUSED_BAD_ARGS', JSON.stringify(args));
    }
    const p = await createClue(dir, { fact: FACT, fields: { planted: [KEY, GHOST] } });
    assert.equal(p.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(p.field, 'planted[1]');
    const v = await createClue(dir, { fact: FACT, fields: { revealed: GHOST } });
    assert.equal(v.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(v.field, 'revealed');
    assert.ok(!exists(dir, CLUE));
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createClue(dir, { fact: FACT, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes[0].to, CLUE);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of the create removes the file again', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await withClue(dir);
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(!exists(dir, CLUE));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
  });
});

describe('updateClue', () => {
  it('sets, inserts in order, removes with null; the body and knowers are kept unless given', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir, { kind: 'clue' });
    const r = await updateClue(dir, c.slug, { fields: { fact: 'The key opens the sea gate', kind: 'reveal', planted: [KEY], revealed: FERRY, red_herring: true }, body: 'Notes.\n', baseSha256: shaOf(dir, CLUE) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(read(dir, CLUE), new RegExp(`\\nslug: ${c.slug}\\nfact: The key opens the sea gate\\nkind: reveal\\nplanted: \\[${KEY}\\]\\nrevealed: ${FERRY}\\nred_herring: true\\ncreated: .*\\n---\\n\\nNotes.\\n$`));
    assert.deepEqual(await errorsOf(dir), []);
    const k = await setClueKnowers(dir, c.slug, { knowers: [{ who: 'reader', scene: FERRY }], baseSha256: shaOf(dir, CLUE) });
    assert.equal(k.ok, true, JSON.stringify(k));
    const r2 = await updateClue(dir, c.slug, { fields: { kind: null, planted: null, revealed: null, red_herring: null }, baseSha256: shaOf(dir, CLUE) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const doc = await docOnDisk(dir, CLUE);
    assert.deepEqual(['kind', 'planted', 'revealed', 'red_herring'].filter((key) => Object.hasOwn(doc.fm, key)), []);
    assert.deepEqual(doc.fm.knowers, [{ who: 'reader', scene: FERRY }]);
    assert.match(read(dir, CLUE), /Notes\.\n$/);
    const r3 = await updateClue(dir, c.slug, { fields: { planted: [ARRIVAL] }, baseSha256: shaOf(dir, CLUE) });
    assert.equal(r3.ok, true);
    const r4 = await updateClue(dir, c.slug, { fields: { planted: [] }, baseSha256: shaOf(dir, CLUE) });
    assert.equal(r4.ok, true);
    assert.ok(!/planted/.test(read(dir, CLUE)));
  });

  it('refusals: base_sha256 required, stale is CONFLICT with current, bad fields, unknown scene, fact cannot be null, unknown clue', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    const sha = () => shaOf(dir, CLUE);
    assert.equal((await updateClue(dir, c.slug, { fields: { kind: 'clue' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateClue(dir, c.slug, { baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    for (const fields of [{ fact: null }, { fact: 'a\nb' }, { kind: 'hint' }, { planted: 'x' }, { planted: [1] }, { revealed: 5 }, { red_herring: 'no' }, { mood: 'x' }, { kind: undefined }]) {
      assert.equal((await updateClue(dir, c.slug, { fields, baseSha256: sha() })).code, 'REFUSED_BAD_ARGS', JSON.stringify(fields));
    }
    const u = await updateClue(dir, c.slug, { fields: { revealed: GHOST }, baseSha256: sha() });
    assert.equal(u.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(u.field, 'revealed');
    assert.equal((await updateClue(dir, 'no-such', { fields: { kind: 'clue' }, baseSha256: sha() })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await updateClue(dir, c.slug, { fields: { kind: 'secret' }, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, sha());
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    const before = snapshot(dir);
    const r = await updateClue(dir, c.slug, { fields: { kind: 'secret' }, baseSha256: shaOf(dir, CLUE), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('setClueKnowers', () => {
  const ITEMS = [
    { who: 'reader', scene: FERRY, how: 'The ferryman shows the gate.' },
    { who: MAREN, scene: KEY, how: 'She believes the key opens the guild door.', reliable: false },
    { who: MAREN, scene: FERRY, reliable: true },
  ];

  it('writes the whole list, round trips, replaces and removes it, and adds no error', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir, { fields: { planted: [KEY], revealed: FERRY } });
    const r = await setClueKnowers(dir, c.slug, { knowers: ITEMS, baseSha256: shaOf(dir, CLUE) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual((await docOnDisk(dir, CLUE)).fm.knowers, ITEMS);
    assert.match(read(dir, CLUE), /\nrevealed: scene_[^\n]*\nknowers:\n {2}- who: reader\n {4}scene: scene_/);
    assert.deepEqual(await errorsOf(dir), []);
    const r2 = await setClueKnowers(dir, c.slug, { knowers: [ITEMS[1]], baseSha256: shaOf(dir, CLUE) });
    assert.equal(r2.ok, true);
    assert.deepEqual((await docOnDisk(dir, CLUE)).fm.knowers, [ITEMS[1]]);
    const r3 = await setClueKnowers(dir, c.slug, { knowers: [], baseSha256: shaOf(dir, CLUE) });
    assert.equal(r3.ok, true);
    assert.ok(!/knowers/.test(read(dir, CLUE)));
  });

  it('refusals: unknown scene or entry with index, bad shape, too many, stale, unknown clue', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    const sha = () => shaOf(dir, CLUE);
    const s = await setClueKnowers(dir, c.slug, { knowers: [ITEMS[0], { who: 'reader', scene: GHOST }], baseSha256: sha() });
    assert.equal(s.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(s.index, 1);
    const e = await setClueKnowers(dir, c.slug, { knowers: [{ who: 'entry_01S5000000000000000000ZZZZ', scene: KEY }], baseSha256: sha() });
    assert.equal(e.code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal(e.index, 0);
    assert.equal(e.field, 'knowers[0].who');
    for (const bad of [[{ scene: KEY }], [{ who: 'reader' }], [{ who: 'reader', scene: KEY, how: 'a\nb' }], [{ who: 'reader', scene: KEY, reliable: 'no' }], [{ who: 'reader', scene: KEY, mood: 'x' }], ['text']]) {
      assert.equal((await setClueKnowers(dir, c.slug, { knowers: bad, baseSha256: sha() })).code, 'REFUSED_BAD_ARGS', JSON.stringify(bad));
    }
    assert.equal((await setClueKnowers(dir, c.slug, { knowers: Array.from({ length: 201 }, () => ({ who: 'reader', scene: KEY })), baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setClueKnowers(dir, c.slug, { knowers: ITEMS })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await setClueKnowers(dir, 'no-such', { knowers: ITEMS, baseSha256: sha() })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await setClueKnowers(dir, c.slug, { knowers: ITEMS, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing; undo restores the file', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    const bytes = fs.readFileSync(path.join(dir, CLUE));
    const before = snapshot(dir);
    const d = await setClueKnowers(dir, c.slug, { knowers: ITEMS, baseSha256: sha256(bytes), dryRun: true });
    assert.equal(d.ok, true);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    const r = await setClueKnowers(dir, c.slug, { knowers: ITEMS, baseSha256: sha256(bytes) });
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual(fs.readFileSync(path.join(dir, CLUE)), bytes);
  });
});

describe('archiveClue / restoreClue', () => {
  it('moves the file to archive/planning/clues/ and back byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    const bytes = fs.readFileSync(path.join(dir, CLUE));
    const a = await archiveClue(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.path, `archive/${CLUE}`);
    assert.ok(!exists(dir, CLUE));
    assert.deepEqual(await errorsOf(dir), []);
    const b = await restoreClue(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.deepEqual(fs.readFileSync(path.join(dir, CLUE)), bytes);
  });

  it('unknown clue is NOT_FOUND; a stale sha is CONFLICT; a live file in the way is REFUSED_PATH_TAKEN', async () => {
    const dir = copyFixture(SALT);
    const c = await withClue(dir);
    assert.equal((await archiveClue(dir, 'nope')).code, 'NOT_FOUND');
    assert.equal((await restoreClue(dir, c.slug)).code, 'NOT_FOUND');
    assert.equal((await archiveClue(dir, c.slug, { baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    const bytes = fs.readFileSync(path.join(dir, CLUE));
    assert.equal((await archiveClue(dir, c.slug)).ok, true);
    fs.writeFileSync(path.join(dir, ...CLUE.split('/')), bytes);
    assert.equal((await restoreClue(dir, c.slug)).code, 'REFUSED_PATH_TAKEN');
  });
});

describe('link branch', () => {
  const mk = async (dir, extra = {}) => {
    const r = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore', ...extra });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };

  it('createLink writes branch after relation; none (or null or empty) writes no key; bad branches are refused', async () => {
    const dir = copyFixture(SALT);
    const r = await mk(dir, { branch: 'ferry-sinks' });
    assert.match(read(dir, r.path), /\nrelation: therefore\nbranch: ferry-sinks\ncreated: /);
    assert.deepEqual(await errorsOf(dir), []);
    assert.equal((await docOnDisk(dir, r.path)).fm.branch, 'ferry-sinks');
    const n = await mk(dir, { from: FERRY, to: KEY, branch: null });
    assert.ok(!/branch/.test(read(dir, n.path)));
    for (const bad of ['Ferry Sinks', 'a'.repeat(41), 'ferry--sinks', 5]) {
      assert.equal((await createLink(dir, { from: ARRIVAL, to: KEY, relation: 'but', branch: bad })).code, 'REFUSED_BAD_ARGS', String(bad));
    }
    assert.equal((await createLink(dir, { from: ARRIVAL, to: KEY, relation: 'but', branch: 'a'.repeat(40) })).ok, true);
  });

  it('a duplicate is the same from, to, relation and branch; another branch or the main plan is another link', async () => {
    const dir = copyFixture(SALT);
    const main = await mk(dir);
    const onBranch = await mk(dir, { branch: 'ferry-sinks' });
    assert.notEqual(main.slug, onBranch.slug);
    const dup = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore', branch: 'ferry-sinks' });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(dup.existing, { slug: onBranch.slug });
    const dupMain = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore' });
    assert.equal(dupMain.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(dupMain.existing, { slug: main.slug });
    assert.equal((await mk(dir, { branch: 'other-way' })).ok, true);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('updateLink sets, changes and removes the branch; a clash with another link is REFUSED_DUPLICATE_LINK', async () => {
    const dir = copyFixture(SALT);
    const main = await mk(dir);
    const rel = main.path;
    const r = await updateLink(dir, main.slug, { branch: 'ferry-sinks', baseSha256: shaOf(dir, rel) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(read(dir, rel), /\nrelation: therefore\nbranch: ferry-sinks\ncreated: /);
    const r2 = await updateLink(dir, main.slug, { branch: 'other-way', baseSha256: shaOf(dir, rel) });
    assert.equal(r2.ok, true);
    assert.match(read(dir, rel), /\nbranch: other-way\n/);
    const other = await mk(dir);
    const clash = await updateLink(dir, other.slug, { branch: 'other-way', baseSha256: shaOf(dir, other.path) });
    assert.equal(clash.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(clash.existing, { slug: main.slug });
    assert.equal((await updateLink(dir, main.slug, { branch: 'Bad Branch', baseSha256: shaOf(dir, rel) })).code, 'REFUSED_BAD_ARGS');
    const joinsMain = await updateLink(dir, main.slug, { branch: null, baseSha256: shaOf(dir, rel) });
    assert.equal(joinsMain.code, 'REFUSED_DUPLICATE_LINK', 'removing the branch makes it the main-plan link that already exists');
    assert.equal((await archiveLink(dir, other.slug)).ok, true);
    const gone = await updateLink(dir, main.slug, { branch: null, baseSha256: shaOf(dir, rel) });
    assert.equal(gone.ok, true, JSON.stringify(gone));
    assert.ok(!/branch/.test(read(dir, rel)));
    assert.equal((await updateLink(dir, main.slug, { branch: null, baseSha256: shaOf(dir, rel) })).ok, true, 'removing an absent branch is a no-op');
    assert.deepEqual(await errorsOf(dir), []);
  });
});
