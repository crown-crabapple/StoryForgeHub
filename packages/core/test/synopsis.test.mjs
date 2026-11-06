// Story Planner M7 (ADR 0003): synopses. The pure extraction rules (extractText) and listSynopses / getSynopsis / extractSynopsis end to end on a copy of the planner fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { basisOf, extractText } from '../src/synopsis-extract.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---- extractText (pure)

const plan = { premise: 'A key opens the wrong door', logline: 'Maren must choose.', protagonist_goal: 'Learn what the key opens', central_conflict: 'The guild wants the key back.', stakes: '' };
const scenes = [
  { id: 's1', title: 'Before', summary: 'Ilse hides the key.', act: 1, chapter: 0 },
  { id: 's2', title: 'Arrival', summary: 'Maren arrives.', act: 1, chapter: 1 },
  { id: 's3', title: 'Key', summary: '', act: 1, chapter: 1 },
  { id: 's4', title: 'Grafting', summary: '  Pell teaches grafting.  ', act: 1, chapter: 2 },
  { id: 's5', title: 'Wall', summary: null, act: 2, chapter: 3 },
  { id: 's6', title: 'Gate', summary: 'The gate opens.', act: 2, chapter: 3 },
];
const structure = {
  beats: [
    { name: 'Setup', scenes: [{ id: 's1' }, { id: 's2' }] },
    { name: 'Empty beat', scenes: [] },
    { name: 'Unsummarised', scenes: [{ id: 's3' }] },
    { name: 'Turn', scenes: ['s6', 's3', 'ghost'] },
  ],
};

test('premise, logline and elevator-pitch come from the story plan only', () => {
  assert.deepEqual(extractText('premise', { storyPlan: plan, scenes }), { text: 'A key opens the wrong door The guild wants the key back.\n', skipped: 0 });
  assert.deepEqual(extractText('premise', { storyPlan: { premise: 'Only this.' } }), { text: 'Only this.\n', skipped: 0 });
  assert.deepEqual(extractText('logline', { storyPlan: plan, scenes }), { text: 'Maren must choose.\n', skipped: 0 });
  assert.deepEqual(extractText('elevator-pitch', { storyPlan: plan, scenes }), { text: 'Maren must choose. Learn what the key opens. The guild wants the key back.\n', skipped: 0 });
  assert.deepEqual(extractText('elevator-pitch', { storyPlan: { fields: { logline: 'Is it?', stakes: 'Everything' } } }), { text: 'Is it? Everything.\n', skipped: 0 });
  for (const type of ['premise', 'logline', 'elevator-pitch']) assert.deepEqual(extractText(type, { storyPlan: {}, scenes }), { text: '', skipped: 0 });
});

test('one-page: one paragraph per act, summaries joined by a space; scenes without a summary are skipped and counted', () => {
  const r = extractText('one-page', { storyPlan: plan, scenes });
  assert.equal(r.text, 'Ilse hides the key. Maren arrives. Pell teaches grafting.\n\nThe gate opens.\n');
  assert.equal(r.skipped, 2);
});

test('long and custom: one paragraph per chapter', () => {
  for (const type of ['long', 'custom']) {
    const r = extractText(type, { storyPlan: plan, scenes });
    assert.equal(r.text, 'Ilse hides the key.\n\nMaren arrives.\n\nPell teaches grafting.\n\nThe gate opens.\n', type);
    assert.equal(r.skipped, 2);
  }
});

test('chapter-treatment: a heading per chapter, then "**title.** summary" for each summarised scene', () => {
  const r = extractText('chapter-treatment', { storyPlan: plan, scenes });
  assert.equal(r.text, '## Chapter 0\n\n**Before.** Ilse hides the key.\n\n## Chapter 1\n\n**Arrival.** Maren arrives.\n\n## Chapter 2\n\n**Grafting.** Pell teaches grafting.\n\n## Chapter 3\n\n**Gate.** The gate opens.\n');
  assert.equal(r.skipped, 2);
});

test('short: one paragraph per beat of the primary structure; empty beats left out; skipped counts distinct summary-less scenes in beats', () => {
  const r = extractText('short', { storyPlan: plan, scenes, primaryStructure: structure });
  assert.equal(r.text, '**Setup.** Ilse hides the key. Maren arrives.\n\n**Turn.** The gate opens.\n');
  assert.equal(r.skipped, 1);
});

test('short without a primary structure falls back to one-page', () => {
  assert.deepEqual(extractText('short', { storyPlan: plan, scenes, primaryStructure: null }), extractText('one-page', { storyPlan: plan, scenes }));
  assert.deepEqual(extractText('short', { storyPlan: plan, scenes }), extractText('one-page', { storyPlan: plan, scenes }));
});

test('nothing to say gives an empty string, and basisOf is the sha256 of the UTF-8 text', () => {
  assert.deepEqual(extractText('one-page', { scenes: [{ id: 'a', summary: '', act: 1, chapter: 1 }] }), { text: '', skipped: 1 });
  assert.deepEqual(extractText('long', {}), { text: '', skipped: 0 });
  assert.equal(basisOf('Café\n'), sha('Café\n'));
  assert.equal(basisOf(''), sha(''));
});

// ---- the repository

async function setup() {
  const root = await copyFixture('valid/planner');
  return { root, repo: createFsRepository(root) };
}
const SCENE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';

test('listSynopses / getSynopsis: the fixture synopsis, shapes, words, order, archived', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listSynopses('book_nope'), null);
    assert.equal(await repo.getSynopsis('book_nope', 'one-page'), null);
    assert.equal(await repo.getSynopsis(BOOK, 'nothing'), null);
    assert.equal(await repo.getSynopsis(BOOK, '../x'), null);
    assert.equal(await repo.extractSynopsis(BOOK, 'nothing'), null);

    const list = await repo.listSynopses(BOOK);
    assert.equal(list.synopses.length, 1);
    assert.deepEqual(list.archived, []);
    const s = list.synopses[0];
    assert.deepEqual(Object.keys(s).sort(), ['basis', 'id', 'name', 'path', 'sha256', 'slug', 'stale', 'target_words', 'type', 'words']);
    assert.equal(s.slug, 'one-page');
    assert.equal(s.path, 'planning/synopses/one-page.md');
    assert.equal(s.type, 'one-page');
    assert.equal(s.name, 'One page');
    assert.equal(s.target_words, 300);
    assert.equal(s.words, 3);
    assert.equal(s.basis, null);
    assert.equal(s.stale, false);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);

    const g = await repo.getSynopsis(BOOK, 'one-page');
    assert.deepEqual({ ...g, body: undefined, archived: undefined }, { ...s, body: undefined, archived: undefined });
    assert.equal(g.body, 'Free synopsis text.');
    assert.equal(g.archived, false);

    // a second synopsis without a name, ordered by type first, then name
    const a = await repo.createSynopsis(BOOK, { type: 'logline', body: 'One two three four five.' });
    assert.equal(a.ok, true, JSON.stringify(a));
    const b = await repo.createSynopsis(BOOK, { type: 'one-page', name: 'Another page' });
    assert.equal(b.ok, true, JSON.stringify(b));
    const l2 = await repo.listSynopses(BOOK);
    assert.deepEqual(l2.synopses.map((x) => x.slug), ['logline', 'another-page', 'one-page']);
    assert.equal(l2.synopses[0].name, 'Logline');
    assert.equal(l2.synopses[0].words, 5);
    assert.equal(l2.synopses[0].target_words, null);

    const arch = await repo.archiveSynopsis(BOOK, 'logline');
    assert.equal(arch.ok, true, JSON.stringify(arch));
    const l3 = await repo.listSynopses(BOOK);
    assert.deepEqual(l3.synopses.map((x) => x.slug), ['another-page', 'one-page']);
    assert.deepEqual(l3.archived.map((x) => x.slug), ['logline']);
    assert.equal(l3.archived[0].stale, false);
    const ga = await repo.getSynopsis(BOOK, 'logline');
    assert.equal(ga.archived, true);
    assert.equal(ga.body, 'One two three four five.');
  } finally {
    await repo.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractSynopsis reads the story plan, summaries and the primary structure, and writes nothing', async () => {
  const { root, repo } = await setup();
  try {
    const before = await fs.readFile(path.join(root, 'planning', 'synopses', 'one-page.md'));
    const r = await repo.extractSynopsis(BOOK, 'one-page');
    assert.deepEqual(Object.keys(r).sort(), ['basis', 'skipped', 'text']);
    assert.equal(r.basis, sha(r.text));
    assert.ok(r.text.includes('Maren steps off the ferry into the flooded rows.'));
    assert.ok(r.text.endsWith('\n'));
    assert.equal(r.skipped, 3); // Ferry, Low Tide and The Wall have no summary (the alternate key scene is not in reading order)
    assert.deepEqual(await repo.extractSynopsis(BOOK, 'one-page'), r);
    assert.deepEqual(before, await fs.readFile(path.join(root, 'planning', 'synopses', 'one-page.md')));

    const short = await repo.createSynopsis(BOOK, { type: 'short' });
    const sr = await repo.extractSynopsis(BOOK, short.slug);
    assert.match(sr.text, /^\*\*[^*]+\.\*\* /);
    const pitch = await repo.createSynopsis(BOOK, { type: 'elevator-pitch' });
    const pr = await repo.extractSynopsis(BOOK, pitch.slug);
    assert.equal(pr.text, 'Maren must choose between the sea gate and her place in the guild. Learn what the key opens. The guild wants the key back; Maren wants to know what it opens. Her place in the town.\n');
    assert.equal(pr.skipped, 0);
  } finally {
    await repo.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale: false without a basis, false at the proposal basis, true after a scene summary changes, false again after keeping the text (basis update)', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal((await repo.listSynopses(BOOK)).synopses[0].stale, false);
    const first = await repo.extractSynopsis(BOOK, 'one-page');
    const set = await repo.updateSynopsis(BOOK, 'one-page', { basis: first.basis, baseSha256: (await repo.getSynopsis(BOOK, 'one-page')).sha256 });
    assert.equal(set.ok, true, JSON.stringify(set));
    const fresh = await repo.listSynopses(BOOK);
    assert.equal(fresh.synopses[0].basis, first.basis);
    assert.equal(fresh.synopses[0].stale, false);
    assert.equal((await repo.getSynopsis(BOOK, 'one-page')).stale, false);

    // a scene summary changes outside the synopsis
    const file = path.join(root, ...SCENE.split('/'));
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.includes('summary: Maren steps off the ferry into the flooded rows.'));
    await fs.writeFile(file, text.replace('Maren steps off the ferry into the flooded rows.', 'Maren is rowed into the flooded rows.'));
    const stale = await repo.listSynopses(BOOK);
    assert.equal(stale.synopses[0].stale, true);
    assert.equal((await repo.getSynopsis(BOOK, 'one-page')).stale, true);
    const next = await repo.extractSynopsis(BOOK, 'one-page');
    assert.notEqual(next.basis, first.basis);

    // "Keep my text": the new basis is stored, the body is untouched
    const cur = await repo.getSynopsis(BOOK, 'one-page');
    const keep = await repo.updateSynopsis(BOOK, 'one-page', { basis: next.basis, baseSha256: cur.sha256 });
    assert.equal(keep.ok, true, JSON.stringify(keep));
    const after = await repo.listSynopses(BOOK);
    assert.equal(after.synopses[0].stale, false);
    assert.equal((await repo.getSynopsis(BOOK, 'one-page')).body, 'Free synopsis text.');

    // a story plan change makes a premise synopsis stale, an unrelated type stays fresh
    const premise = await repo.createSynopsis(BOOK, { type: 'premise' });
    const pr = await repo.extractSynopsis(BOOK, premise.slug);
    const pset = await repo.updateSynopsis(BOOK, premise.slug, { basis: pr.basis, baseSha256: (await repo.getSynopsis(BOOK, premise.slug)).sha256 });
    assert.equal(pset.ok, true, JSON.stringify(pset));
    const storyFile = path.join(root, 'planning', 'story.md');
    await fs.writeFile(storyFile, (await fs.readFile(storyFile, 'utf8')).replace('An apprentice finds', 'A novice finds'));
    const bySlug = Object.fromEntries((await repo.listSynopses(BOOK)).synopses.map((x) => [x.slug, x.stale]));
    assert.equal(bySlug[premise.slug], true);
    assert.equal(bySlug['one-page'], false);

    // removing the basis ends the stale state
    const cleared = await repo.updateSynopsis(BOOK, premise.slug, { basis: null, baseSha256: (await repo.getSynopsis(BOOK, premise.slug)).sha256 });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal((await repo.getSynopsis(BOOK, premise.slug)).stale, false);
  } finally {
    await repo.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('write refusals pass through the repository: bad args, missing base, stale base', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal((await repo.createSynopsis(BOOK, { type: 'blurb' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.updateSynopsis(BOOK, 'one-page', { name: 'x' })).code, 'REFUSED_BAD_ARGS');
    const stale = await repo.updateSynopsis(BOOK, 'one-page', { name: 'x', baseSha256: 'f'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(typeof stale.current.sha256, 'string');
    assert.equal((await repo.updateSynopsis(BOOK, 'nothing', { name: 'x', baseSha256: 'f'.repeat(64) })).code, 'NOT_FOUND');
    const cur = await repo.getSynopsis(BOOK, 'one-page');
    assert.equal((await repo.updateSynopsis(BOOK, 'one-page', { basis: 'nope', baseSha256: cur.sha256 })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.updateSynopsis(BOOK, 'one-page', { target_words: 0, baseSha256: cur.sha256 })).code, 'REFUSED_BAD_ARGS');
  } finally {
    await repo.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
