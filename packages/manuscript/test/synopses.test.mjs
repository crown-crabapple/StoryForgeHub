// Story Planner M7 (ADR 0003): synopses. createSynopsis, updateSynopsis, archiveSynopsis / restoreSynopsis and the undo of a create.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { archiveSynopsis, createSynopsis, restoreOp, restoreSynopsis, updateSynopsis } from '../src/index.mjs';
import { NO_DIFF, SALT, cleanup, copyFixture, diffSnap, errorsOf, exists, read, sha256, snapshot } from './helpers.mjs';

after(cleanup);

const REL = 'planning/synopses/one-page-synopsis.md';
const ARCH = `archive/${REL}`;
const BASIS = 'ab'.repeat(32);
const shaOf = (dir, rel) => sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))));

async function made(dir, extra = {}) {
  const r = await createSynopsis(dir, { type: 'one-page', ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

describe('createSynopsis', () => {
  it('writes planning/synopses/<label>.md in order, with created and the body, and adds no error', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createSynopsis(dir, { type: 'one-page', target_words: 300, body: 'A page about the orchard.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'one-page-synopsis');
    assert.equal(r.path, REL);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    const created = new Date().toISOString().slice(0, 10);
    assert.equal(read(dir, REL), `---\nschema: storyforge.synopsis/v1\nid: ${r.id}\nslug: one-page-synopsis\ntype: one-page\ntarget_words: 300\ncreated: ${created}\n---\n\nA page about the orchard.\n`);
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [REL], removed: [], changed: [] });
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('takes the slug from the name, and allows several of one type with -2, -3', async () => {
    const dir = copyFixture(SALT);
    const a = await made(dir, { name: 'Query letter version' });
    assert.equal(a.slug, 'query-letter-version');
    assert.match(read(dir, a.path), /\nname: Query letter version\n/);
    const b = await made(dir);
    const c = await made(dir);
    assert.equal(b.slug, 'one-page-synopsis');
    assert.equal(c.slug, 'one-page-synopsis-2');
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('every type is accepted', async () => {
    const dir = copyFixture(SALT);
    for (const type of ['premise', 'logline', 'elevator-pitch', 'short', 'one-page', 'long', 'chapter-treatment', 'custom']) await made(dir, { type });
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('refusals: bad type, target_words, name and body are REFUSED_BAD_ARGS with the field', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const cases = [
      [{ type: 'blurb' }, 'type'], [{}, 'type'],
      [{ type: 'short', target_words: 0 }, 'target_words'], [{ type: 'short', target_words: 2.5 }, 'target_words'], [{ type: 'short', target_words: '300' }, 'target_words'],
      [{ type: 'short', name: 'two\nlines' }, 'name'], [{ type: 'short', body: 'bad\u0000text' }, 'body'],
    ];
    for (const [args, field] of cases) {
      const r = await createSynopsis(dir, args);
      assert.equal(r.code, 'REFUSED_BAD_ARGS', JSON.stringify(args));
      assert.equal(r.field, field);
    }
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run returns the change and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await createSynopsis(dir, { type: 'premise', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].to, 'planning/synopses/premise.md');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('undo of the create removes the file again', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await made(dir);
    const u = await restoreOp(dir, r.opId);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.ok(!exists(dir, REL));
    assert.deepEqual(diffSnap(before, snapshot(dir)), NO_DIFF);
  });
});

describe('updateSynopsis', () => {
  it('sets name, target_words, basis and body; the type and slug are kept', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir);
    const r = await updateSynopsis(dir, c.slug, { name: 'My page', target_words: 250, basis: BASIS, body: 'New text.\n', baseSha256: shaOf(dir, REL) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const created = new Date().toISOString().slice(0, 10);
    assert.equal(read(dir, REL), `---\nschema: storyforge.synopsis/v1\nid: ${c.id}\nslug: one-page-synopsis\ntype: one-page\nname: My page\ntarget_words: 250\nbasis: ${BASIS}\ncreated: ${created}\n---\n\nNew text.\n`);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('target_words null and basis null remove their lines; name null too', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir, { name: 'Page', target_words: 300, body: 'Text.' });
    const s1 = await updateSynopsis(dir, c.slug, { basis: BASIS, baseSha256: shaOf(dir, c.path) });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.match(read(dir, c.path), new RegExp(`\\nbasis: ${BASIS}\\n`));
    const r = await updateSynopsis(dir, c.slug, { target_words: null, basis: null, name: null, baseSha256: shaOf(dir, c.path) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = read(dir, c.path);
    assert.doesNotMatch(text, /target_words|basis|name:/);
    assert.match(text, /\ntype: one-page\ncreated: /);
    assert.ok(text.endsWith('\n---\n\nText.\n'));
    assert.deepEqual(await errorsOf(dir), []);
    // removing a line that is not there is no change
    const again = await updateSynopsis(dir, c.slug, { basis: null, baseSha256: shaOf(dir, c.path) });
    assert.equal(again.ok, true);
    assert.deepEqual(again.changes, []);
  });

  it('with only a basis the body bytes are untouched', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir, { body: 'Line one.\n\nLine two, with  odd   spacing.' });
    const body = (text) => text.slice(text.indexOf('\n---\n', 4));
    const before = read(dir, REL);
    const r = await updateSynopsis(dir, c.slug, { basis: BASIS, baseSha256: shaOf(dir, REL) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = read(dir, REL);
    assert.notEqual(after, before);
    assert.equal(body(after), body(before));
  });

  it('refusals: base_sha256 required, stale is CONFLICT with current, bad args, unknown synopsis, nothing to change', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir);
    const sha = shaOf(dir, REL);
    assert.equal((await updateSynopsis(dir, c.slug, { name: 'x' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await updateSynopsis(dir, c.slug, { baseSha256: sha })).code, 'REFUSED_BAD_ARGS');
    for (const [args, field] of [[{ target_words: 0 }, 'target_words'], [{ target_words: 1.5 }, 'target_words'], [{ basis: 'nope' }, 'basis'], [{ basis: 'AB'.repeat(32) }, 'basis'], [{ name: 'a\nb' }, 'name']]) {
      const r = await updateSynopsis(dir, c.slug, { ...args, baseSha256: sha });
      assert.equal(r.code, 'REFUSED_BAD_ARGS', JSON.stringify(args));
      assert.equal(r.field, field);
    }
    assert.equal((await updateSynopsis(dir, 'no-such', { name: 'x', baseSha256: sha })).code, 'NOT_FOUND');
    const before = snapshot(dir);
    const r = await updateSynopsis(dir, c.slug, { name: 'x', baseSha256: 'f'.repeat(64) });
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.current.sha256, sha);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });

  it('dry run writes nothing', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir);
    const before = snapshot(dir);
    const r = await updateSynopsis(dir, c.slug, { target_words: 100, baseSha256: shaOf(dir, REL), dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NO_DIFF);
  });
});

describe('archiveSynopsis / restoreSynopsis', () => {
  it('moves the file to archive/planning/synopses and back, byte for byte', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir, { body: 'Kept.' });
    const text = read(dir, REL);
    const a = await archiveSynopsis(dir, c.slug);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(!exists(dir, REL));
    assert.equal(read(dir, ARCH), text);
    assert.deepEqual(await errorsOf(dir), []);
    const r = await restoreSynopsis(dir, c.slug);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!exists(dir, ARCH));
    assert.equal(read(dir, REL), text);
  });

  it('refusals: unknown, stale base, restore onto a taken path', async () => {
    const dir = copyFixture(SALT);
    const c = await made(dir);
    assert.equal((await archiveSynopsis(dir, 'no-such')).code, 'NOT_FOUND');
    assert.equal((await restoreSynopsis(dir, c.slug)).code, 'NOT_FOUND');
    assert.equal((await archiveSynopsis(dir, c.slug, { baseSha256: 'f'.repeat(64) })).code, 'CONFLICT');
    assert.equal((await archiveSynopsis(dir, c.slug)).ok, true);
    fs.mkdirSync(path.join(dir, 'planning', 'synopses'), { recursive: true });
    fs.writeFileSync(path.join(dir, ...REL.split('/')), read(dir, ARCH)); // a live file now holds the name
    const taken = await restoreSynopsis(dir, c.slug);
    assert.equal(taken.code, 'REFUSED_PATH_TAKEN');
  });
});
