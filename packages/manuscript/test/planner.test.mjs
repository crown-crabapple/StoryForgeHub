// Story Planner M1 (ADR 0003): createLink, updateLink, archiveLink / restoreLink, saveScenePlan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { archiveLink, createLink, restoreLink, restoreOp, saveScenePlan, updateLink } from '../src/index.mjs';
import { ARRIVAL, FERRY, KEY, NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot, write } from './helpers.mjs';

after(cleanup);

const LINK = 'planning/links/the-key-therefore-ferry.md';
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const ARCHIVED_SCENE = 'scene_01S50000000000000000000007';
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));
const manuscriptBytes = (dir) => new Map([...snapshot(dir)].filter(([p]) => p.startsWith('manuscript/') || p.startsWith('archive/manuscript/')));

async function withLink(dir, extra = {}) {
  const r = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'The key failing forces Maren onto the ferry.', ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

describe('createLink', () => {
  it('writes planning/links/<slug>.md in the ADR shape and adds no error', async () => {
    const dir = copyFixture(SALT);
    const r = await withLink(dir);
    assert.equal(r.slug, 'the-key-therefore-ferry');
    assert.equal(r.path, LINK);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    const text = read(dir, LINK);
    assert.match(text, new RegExp(`^---\\nschema: storyforge.link/v1\\nid: ${r.id}\\nslug: the-key-therefore-ferry\\nfrom: ${KEY}\\nto: ${FERRY}\\nrelation: therefore\\ncreated: \\d{4}-\\d{2}-\\d{2}\\n---\\n\\nThe key failing forces Maren onto the ferry.\\n$`));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('an empty rationale writes no body; a multi-line one is kept', async () => {
    const dir = copyFixture(SALT);
    await withLink(dir, { rationale: '' });
    assert.match(read(dir, LINK), /relation: therefore\ncreated: \S+\n---\n$/);
    const dir2 = copyFixture(SALT);
    await withLink(dir2, { rationale: 'one\n\ntwo' });
    assert.ok(read(dir2, LINK).endsWith('---\n\none\n\ntwo\n'));
  });

  it('a clash gets -2 (the first is archived: not a duplicate, but the name is taken)', async () => {
    const dir = copyFixture(SALT);
    const a = await withLink(dir);
    assert.equal((await archiveLink(dir, a.slug)).ok, true);
    const b = await withLink(dir);
    assert.equal(b.slug, 'the-key-therefore-ferry-2');
    const c = await withLink(dir, { relation: 'but' });
    assert.equal(c.slug, 'the-key-but-ferry');
  });

  it('a long slug is cut at a hyphen boundary within 60 characters', async () => {
    const dir = copyFixture(SALT);
    const longName = 'a-remarkably-long-scene-name-that-keeps-going-and-going';
    const keyText = read(dir, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md');
    const text = keyText.replace(/^id: .*$/m, 'id: scene_01S50000000000000000000099').replace(/^sequence: 20$/m, 'sequence: 30').replace(/^title: .*$/m, 'title: Long');
    write(dir, `manuscript/act-01-low-water/ch-001-the-drowned-rows/0030-${longName}.md`, text);
    const r = await createLink(dir, { from: 'scene_01S50000000000000000000099', to: FERRY, relation: 'foreshadows' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.slug.length <= 60, r.slug);
    assert.ok(!r.slug.endsWith('-'));
    assert.ok(`${longName}-foreshadows-ferry`.startsWith(`${r.slug}-`), r.slug);
  });

  it('refusals: bad args, unknown scene, self link, duplicate', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await createLink(dir, { from: KEY, to: FERRY, relation: 'causes' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createLink(dir, { from: KEY, to: FERRY, relation: 'but', rationale: 'a\u0000b' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await createLink(dir, { from: KEY, to: FERRY, relation: 'but', rationale: 'x'.repeat(20001) })).code, 'REFUSED_BAD_ARGS');
    const unknown = await createLink(dir, { from: GHOST, to: FERRY, relation: 'but' });
    assert.equal(unknown.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(unknown.field, 'from');
    assert.equal((await createLink(dir, { from: KEY, to: GHOST, relation: 'but' })).field, 'to');
    assert.equal((await createLink(dir, { from: KEY, to: KEY, relation: 'but' })).code, 'REFUSED_SELF_LINK');
    const a = await withLink(dir);
    const dup = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore' });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(dup.existing, { slug: a.slug });
    assert.equal((await createLink(dir, { from: FERRY, to: KEY, relation: 'therefore' })).ok, true, 'the other direction is another link');
  });

  it('an archived scene is not a live scene', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await createLink(dir, { from: KEY, to: ARCHIVED_SCENE, relation: 'but' })).code, 'REFUSED_UNKNOWN_SCENE');
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createLink(dir, { from: KEY, to: FERRY, relation: 'therefore', rationale: 'why', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].to, LINK);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('updateLink', () => {
  it('changes relation, ends and rationale by byte edits; the name never changes', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    const before = read(dir, LINK);
    const r = await updateLink(dir, c.slug, { relation: 'but', baseSha256: shaOf(dir, LINK) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(read(dir, LINK), before.replace('relation: therefore', 'relation: but'));
    const r2 = await updateLink(dir, c.slug, { rationale: 'New reason.\nSecond line.', baseSha256: shaOf(dir, LINK) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(read(dir, LINK), `${before.replace('relation: therefore', 'relation: but').split('---\n\n')[0]}---\n\nNew reason.\nSecond line.\n`);
    const r3 = await updateLink(dir, c.slug, { from: ARRIVAL, to: KEY, baseSha256: shaOf(dir, LINK) });
    assert.equal(r3.ok, true, JSON.stringify(r3));
    assert.match(read(dir, LINK), new RegExp(`from: ${ARRIVAL}\\nto: ${KEY}\\nrelation: but`));
    assert.ok(exists(dir, LINK));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('an empty rationale clears the body and keeps the front matter bytes', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    const head = `${read(dir, LINK).split('---\n\n')[0]}---\n`;
    assert.equal((await updateLink(dir, c.slug, { rationale: '', baseSha256: shaOf(dir, LINK) })).ok, true);
    assert.equal(read(dir, LINK), head);
  });

  it('base_sha256 is required; a stale one is CONFLICT and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    assert.equal((await updateLink(dir, c.slug, { relation: 'but' })).code, 'REFUSED_BAD_ARGS');
    const before = snapshot(dir);
    const r = await updateLink(dir, c.slug, { relation: 'but', baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('refusals: nothing to change, bad relation, unknown scene, self link, duplicate (not itself), unknown link', async () => {
    const dir = copyFixture(SALT);
    const a = await withLink(dir);
    const b = await withLink(dir, { relation: 'but' });
    const sha = () => shaOf(dir, `planning/links/${a.slug}.md`);
    assert.equal((await updateLink(dir, a.slug, { baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateLink(dir, a.slug, { relation: 'x', baseSha256: sha() })).code, 'REFUSED_BAD_ARGS');
    const unk = await updateLink(dir, a.slug, { to: GHOST, baseSha256: sha() });
    assert.equal(unk.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(unk.field, 'to');
    assert.equal((await updateLink(dir, a.slug, { to: KEY, baseSha256: sha() })).code, 'REFUSED_SELF_LINK');
    const dup = await updateLink(dir, a.slug, { relation: 'but', baseSha256: sha() });
    assert.equal(dup.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(dup.existing, { slug: b.slug });
    assert.equal((await updateLink(dir, a.slug, { relation: 'therefore', baseSha256: sha() })).ok, true, 'same values: not a duplicate of itself');
    assert.equal((await updateLink(dir, 'no-such-link', { relation: 'but', baseSha256: sha() })).code, 'NOT_FOUND');
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    const before = snapshot(dir);
    const r = await updateLink(dir, c.slug, { relation: 'enables', rationale: 'x', baseSha256: shaOf(dir, LINK), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('archiveLink / restoreLink', () => {
  it('moves the file to archive/planning/links/ and back byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    const bytes = fs.readFileSync(path.join(dir, LINK));
    const a = await archiveLink(dir, c.slug, { baseSha256: sha256(bytes) });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.path, `archive/${LINK}`);
    assert.ok(!exists(dir, LINK));
    assert.ok(fs.readFileSync(path.join(dir, 'archive', LINK)).equals(bytes));
    const r = await restoreLink(dir, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.readFileSync(path.join(dir, LINK)).equals(bytes));
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: unknown, stale, restore onto a live file, restore of a duplicate', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    assert.equal((await archiveLink(dir, 'nope')).code, 'NOT_FOUND');
    assert.equal((await restoreLink(dir, c.slug)).code, 'NOT_FOUND');
    assert.equal((await archiveLink(dir, c.slug, { baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    assert.equal((await archiveLink(dir, c.slug)).ok, true);
    // the same name live again: path taken
    write(dir, LINK, read(dir, `archive/${LINK}`).replace(/^id: .*$/m, 'id: note_01S50000000000000000000K09').replace('relation: therefore', 'relation: but'));
    assert.equal((await restoreLink(dir, c.slug)).code, 'REFUSED_PATH_TAKEN');
    fs.rmSync(path.join(dir, LINK));
    // a live twin under another name: duplicate
    const twin = await withLink(dir);
    assert.equal(twin.slug, 'the-key-therefore-ferry-2');
    const r = await restoreLink(dir, c.slug);
    assert.equal(r.code, 'REFUSED_DUPLICATE_LINK');
    assert.deepEqual(r.existing, { slug: twin.slug });
  });

  it('dry runs write nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    let before = snapshot(dir);
    assert.equal((await archiveLink(dir, c.slug, { dryRun: true })).changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    await archiveLink(dir, c.slug);
    before = snapshot(dir);
    assert.equal((await restoreLink(dir, c.slug, { dryRun: true })).changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('saveScenePlan', () => {
  const PLAN = 'planning/scene-plans/the-key.md';

  it('creates the sidecar with the keys in order and characters as a flow list', async () => {
    const dir = copyFixture(SALT);
    const r = await saveScenePlan(dir, KEY, { fields: { stakes: 'Her place in the town.', goal: 'Prove the harbour key opens the sea gate.', turn: 'The key opens: a different door.' }, characters: ['maren-hollis', 'pell'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, PLAN);
    assert.equal(r.scene_id, KEY);
    assert.equal(read(dir, PLAN), `---\nschema: storyforge.scene-plan/v1\nid: ${r.id}\nscene: ${KEY}\ngoal: Prove the harbour key opens the sea gate.\nturn: "The key opens: a different door."\nstakes: Her place in the town.\ncharacters: [maren-hollis, pell]\n---\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('edits an existing sidecar by byte edits: set, insert in order, remove, characters', async () => {
    const dir = copyFixture(SALT);
    await saveScenePlan(dir, KEY, { fields: { goal: 'G', stakes: 'S' }, characters: ['pell'] });
    write(dir, PLAN, `${read(dir, PLAN)}\nFree planning notes.\n`);
    const sha = () => shaOf(dir, PLAN);
    const r = await saveScenePlan(dir, KEY, { fields: { conflict: 'C', goal: 'Better goal', stakes: null }, characters: ['maren-hollis', 'pell'], baseSha256: sha() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.created, false);
    assert.equal(read(dir, PLAN), `---\nschema: storyforge.scene-plan/v1\nid: ${r.id}\nscene: ${KEY}\ngoal: Better goal\nconflict: C\ncharacters: [maren-hollis, pell]\n---\n\nFree planning notes.\n`);
    const r2 = await saveScenePlan(dir, KEY, { fields: { purpose: 'P', opposition: '' }, characters: [], baseSha256: sha() });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(read(dir, PLAN), `---\nschema: storyforge.scene-plan/v1\nid: ${r.id}\nscene: ${KEY}\ngoal: Better goal\nconflict: C\npurpose: P\n---\n\nFree planning notes.\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('saving the same values is ok with no changes', async () => {
    const dir = copyFixture(SALT);
    await saveScenePlan(dir, KEY, { fields: { goal: 'G' } });
    const r = await saveScenePlan(dir, KEY, { fields: { goal: 'G' }, baseSha256: shaOf(dir, PLAN) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes, []);
  });

  it('refusals: bad args, unknown scene, unknown entry, base_sha256 rules, CONFLICT', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await saveScenePlan(dir, KEY, {})).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'a\nb' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'x'.repeat(2001) } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 7 } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveScenePlan(dir, GHOST, { fields: { goal: 'x' } })).code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal((await saveScenePlan(dir, ARCHIVED_SCENE, { fields: { goal: 'x' } })).code, 'REFUSED_UNKNOWN_SCENE', 'archived scene');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'x' }, characters: ['nobody-here'] })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'x' }, baseSha256: 'f'.repeat(64) })).code, 'REFUSED_BAD_ARGS', 'create takes no base');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: null } })).code, 'REFUSED_BAD_ARGS', 'nothing to save');
    assert.ok(!exists(dir, PLAN));
    await saveScenePlan(dir, KEY, { fields: { goal: 'x' } });
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'y' } })).code, 'REFUSED_BAD_ARGS', 'existing needs base');
    const before = snapshot(dir);
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: 'y' }, baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('a name clash with an archived file gets -2', async () => {
    const dir = copyFixture(SALT);
    write(dir, 'archive/planning/scene-plans/the-key.md', `---\nschema: storyforge.scene-plan/v1\nid: note_01S50000000000000000000K11\nscene: ${ARCHIVED_SCENE}\n---\n`);
    const r = await saveScenePlan(dir, KEY, { fields: { goal: 'x' } });
    assert.equal(r.path, 'planning/scene-plans/the-key-2.md');
  });

  it('dry run writes nothing, for create and for edit', async () => {
    const dir = copyFixture(SALT);
    let before = snapshot(dir);
    const c = await saveScenePlan(dir, KEY, { fields: { goal: 'x' }, dryRun: true });
    assert.equal(c.ok, true);
    assert.equal(c.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    await saveScenePlan(dir, KEY, { fields: { goal: 'x' } });
    before = snapshot(dir);
    const e = await saveScenePlan(dir, KEY, { fields: { goal: 'y' }, baseSha256: shaOf(dir, PLAN), dryRun: true });
    assert.equal(e.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('undo and the scene files', () => {
  it('restoreOp puts an edit, an archive and a plan edit back byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await withLink(dir);
    const plan = await saveScenePlan(dir, KEY, { fields: { goal: 'x' } });
    for (const run of [
      () => updateLink(dir, c.slug, { relation: 'but', rationale: 'changed', baseSha256: shaOf(dir, LINK) }),
      () => archiveLink(dir, c.slug),
      () => saveScenePlan(dir, KEY, { fields: { goal: 'y', stakes: 'z' }, baseSha256: shaOf(dir, plan.path) }),
    ]) {
      const before = snapshot(dir);
      const r = await run();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(typeof r.opId, 'string');
      const u = await restoreOp(dir, r.opId);
      assert.equal(u.ok, true, JSON.stringify(u));
      assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
    }
  });

  it('BYTE SNAPSHOT: no file under manuscript/ changes after any planner op', async () => {
    const dir = copyFixture(SALT);
    const base = manuscriptBytes(dir);
    const same = (label) => assert.deepEqual(manuscriptBytes(dir), base, `${label} changed a scene file`);
    const c = await withLink(dir);
    same('createLink');
    const d = await createLink(dir, { from: ARRIVAL, to: KEY, relation: 'enables' });
    assert.equal((await updateLink(dir, c.slug, { relation: 'but', rationale: 'r', baseSha256: shaOf(dir, LINK) })).ok, true);
    same('updateLink');
    assert.equal((await updateLink(dir, d.slug, { from: FERRY, baseSha256: shaOf(dir, d.path) })).ok, true);
    same('updateLink ends');
    assert.equal((await archiveLink(dir, c.slug)).ok, true);
    same('archiveLink');
    assert.equal((await restoreLink(dir, c.slug)).ok, true);
    same('restoreLink');
    const p = await saveScenePlan(dir, KEY, { fields: { goal: 'g' }, characters: ['pell'] });
    same('saveScenePlan create');
    assert.equal((await saveScenePlan(dir, KEY, { fields: { goal: null, stakes: 's' }, characters: [], baseSha256: shaOf(dir, p.path) })).ok, true);
    same('saveScenePlan edit');
    await createLink(dir, { from: ARRIVAL, to: KEY, relation: 'but', dryRun: true });
    same('dry run');
    assert.deepEqual(await errorsOf(dir), []);
  });
});
