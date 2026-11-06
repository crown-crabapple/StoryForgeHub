// Story Planner M2 (ADR 0003): saveStoryPlan, the book-level story plan planning/story.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { restoreOp, saveStoryPlan } from '../src/index.mjs';
import { NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, read, sha256, snapshot, write } from './helpers.mjs';

after(cleanup);

const STORY = 'planning/story.md';
const shaOf = (dir) => sha256(fs.readFileSync(path.join(dir, ...STORY.split('/'))));

describe('saveStoryPlan', () => {
  it('creates planning/story.md with the keys in order and the body, and touches nothing else', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await saveStoryPlan(dir, { fields: { stakes: 'Her place in the town.', premise: 'A key opens the wrong door.', protagonist: 'maren-hollis', theme_question: 'What does belonging cost?' }, body: 'Notes line one.\n\nLine two.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, STORY);
    assert.equal(r.created, true);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(read(dir, STORY), `---\nschema: storyforge.story-plan/v1\nid: ${r.id}\npremise: A key opens the wrong door.\ntheme_question: "What does belonging cost?"\nstakes: Her place in the town.\nprotagonist: maren-hollis\n---\n\nNotes line one.\n\nLine two.\n`);
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [STORY], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('edits by byte edits: set, insert in order, remove a field, keep the body', async () => {
    const dir = copyFixture(SALT);
    const c = await saveStoryPlan(dir, { fields: { premise: 'P', stakes: 'S' }, body: 'Keep me.' });
    const r = await saveStoryPlan(dir, { fields: { logline: 'L', premise: 'Better premise', stakes: null }, baseSha256: shaOf(dir) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.created, false);
    assert.equal(read(dir, STORY), `---\nschema: storyforge.story-plan/v1\nid: ${c.id}\npremise: Better premise\nlogline: L\n---\n\nKeep me.\n`);
    const r2 = await saveStoryPlan(dir, { fields: { protagonist: 'pell', logline: '' }, baseSha256: shaOf(dir) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(read(dir, STORY), `---\nschema: storyforge.story-plan/v1\nid: ${c.id}\npremise: Better premise\nprotagonist: pell\n---\n\nKeep me.\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('a body edit replaces only the body and keeps the front matter bytes; an empty body removes it', async () => {
    const dir = copyFixture(SALT);
    await saveStoryPlan(dir, { fields: { premise: 'P' }, body: 'old' });
    const head = read(dir, STORY).split('---\n\n')[0];
    const r = await saveStoryPlan(dir, { body: 'new\nbody', baseSha256: shaOf(dir) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(read(dir, STORY), `${head}---\n\nnew\nbody\n`);
    const r2 = await saveStoryPlan(dir, { body: '', baseSha256: shaOf(dir) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(read(dir, STORY), `${head}---\n`);
  });

  it('only planning/story.md changes on an edit', async () => {
    const dir = copyFixture(SALT);
    await saveStoryPlan(dir, { fields: { premise: 'P' } });
    const before = snapshot(dir);
    await saveStoryPlan(dir, { fields: { logline: 'L' }, body: 'b', baseSha256: shaOf(dir) });
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [STORY] });
  });

  it('a stale base is CONFLICT with the current file; nothing is written', async () => {
    const dir = copyFixture(SALT);
    await saveStoryPlan(dir, { fields: { premise: 'P' } });
    const before = snapshot(dir);
    const r = await saveStoryPlan(dir, { fields: { premise: 'Q' }, baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, shaOf(dir));
    assert.equal(r.current.text, read(dir, STORY));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('refusals: bad args, unknown entry, base_sha256 rules, a foreign file in the way', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await saveStoryPlan(dir, {})).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { fields: { mood: 'x' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { fields: { premise: 'a\nb' } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { fields: { premise: 'x'.repeat(2001) } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { fields: { premise: 7 } })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { body: 'x'.repeat(20001) })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { body: 5 })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await saveStoryPlan(dir, { fields: { protagonist: 'nobody-here' } })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await saveStoryPlan(dir, { fields: { premise: 'x' }, baseSha256: 'f'.repeat(64) })).code, 'REFUSED_BAD_ARGS', 'create takes no base');
    assert.equal((await saveStoryPlan(dir, { fields: { premise: null } })).code, 'REFUSED_BAD_ARGS', 'nothing to save');
    await saveStoryPlan(dir, { fields: { premise: 'x' } });
    assert.equal((await saveStoryPlan(dir, { fields: { premise: 'y' } })).code, 'REFUSED_BAD_ARGS', 'existing needs base');
    const other = copyFixture(SALT);
    write(other, STORY, '---\nschema: storyforge.doc/v1\nid: note_01S50000000000000000000D01\ntitle: Mine\n---\n');
    assert.equal((await saveStoryPlan(other, { fields: { premise: 'y' } })).code, 'REFUSED_PATH_TAKEN');
  });

  it('dry run writes nothing, for create and for edit', async () => {
    const dir = copyFixture(SALT);
    let before = snapshot(dir);
    const c = await saveStoryPlan(dir, { fields: { premise: 'x' }, dryRun: true });
    assert.equal(c.ok, true);
    assert.equal(c.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
    await saveStoryPlan(dir, { fields: { premise: 'x' } });
    before = snapshot(dir);
    const e = await saveStoryPlan(dir, { fields: { premise: 'y' }, baseSha256: shaOf(dir), dryRun: true });
    assert.equal(e.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo removes a created plan and puts an edit back byte for byte', async () => {
    const dir = copyFixture(SALT);
    const start = snapshot(dir);
    const c = await saveStoryPlan(dir, { fields: { premise: 'x' } });
    const afterCreate = snapshot(dir);
    const e = await saveStoryPlan(dir, { fields: { premise: 'y' }, body: 'b', baseSha256: shaOf(dir) });
    assert.equal(typeof e.opId, 'string');
    assert.equal((await restoreOp(dir, e.opId)).ok, true);
    assert.deepEqual(diffSnap(afterCreate, snapshot(dir)), NO_DIFF);
    assert.equal(typeof c.opId, 'string');
    const u = await restoreOp(dir, c.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual(diffSnap(start, snapshot(dir)), NO_DIFF);
  });
});
