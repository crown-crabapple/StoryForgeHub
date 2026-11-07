// Story Planner M8 (ADR 0003): the repository methods for clues, the link branch and the series plan, end to end on copies of salt-orchard and tidewater.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const MAREN = 'entry_01S5000000000000000000000G';
const ARRIVAL = 'scene_01S50000000000000000000002';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const GHOST = 'scene_01S5000000000000000000ZZZZ';
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

test('listClues / getClue: empty, then a clue with positions, a reader knower and a character knower', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    assert.equal(await repo.listClues('book_nope'), null);
    assert.deepEqual(await repo.listClues(BOOK), { clues: [], archived: [] });
    assert.equal(await repo.getClue(BOOK, 'nothing'), null);
    assert.equal(await repo.getClue(BOOK, '../x'), null);

    const c = await repo.createClue(BOOK, { fact: 'The harbour key opens the sea gate', kind: 'secret', fields: { planted: [ARRIVAL, KEY], revealed: FERRY } });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(typeof c.opId, 'string');
    const sha = (await repo.getClue(BOOK, c.slug)).sha256;
    const k = await repo.setClueKnowers(BOOK, c.slug, {
      knowers: [{ who: 'reader', scene: FERRY, how: 'The ferryman shows the gate.' }, { who: MAREN, scene: KEY, how: 'She believes the key opens the guild door.', reliable: false }, { who: MAREN, scene: FERRY }],
      baseSha256: sha,
    });
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listClues(BOOK);
    assert.deepEqual(list.archived, []);
    assert.equal(list.clues.length, 1);
    const a = list.clues[0];
    assert.deepEqual(Object.keys(a).sort(), ['body', 'fact', 'id', 'kind', 'knowers', 'path', 'planted', 'problems', 'red_herring', 'revealed', 'sha256', 'slug'].sort());
    assert.equal(a.id, c.id);
    assert.equal(a.path, 'planning/clues/the-harbour-key-opens-the-sea-gate.md');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.fact, 'The harbour key opens the sea gate');
    assert.equal(a.kind, 'secret');
    assert.equal(a.red_herring, false);
    assert.deepEqual(a.planted, [{ id: ARRIVAL, title: 'Arrival', position: 2 }, { id: KEY, title: 'The Key', position: 3 }]);
    assert.deepEqual(a.revealed, { id: FERRY, title: a.revealed.title, position: 4 });
    assert.equal(typeof a.revealed.title, 'string');
    assert.equal(a.knowers.length, 3);
    assert.deepEqual(Object.keys(a.knowers[0]).sort(), ['how', 'reliable', 'scene', 'who']);
    assert.deepEqual(a.knowers[0].who, { id: 'reader', name: null, reader: true });
    assert.equal(a.knowers[0].how, 'The ferryman shows the gate.');
    assert.equal(a.knowers[0].reliable, true);
    assert.deepEqual(a.knowers[0].scene, { id: FERRY, title: a.revealed.title, position: 4 });
    assert.deepEqual(a.knowers[1].who, { id: MAREN, name: 'Maren Hollis', reader: false, shared: false });
    assert.equal(a.knowers[1].reliable, false);
    assert.equal(a.knowers[1].scene.position, 3);
    assert.equal(a.knowers[2].how, null);
    assert.deepEqual(a.problems, []);

    const one = await repo.getClue(BOOK, c.slug);
    assert.equal(one.archived, false);
    assert.deepEqual({ ...one, archived: undefined }, { ...a, archived: undefined });

    const arch = await repo.archiveClue(BOOK, c.slug);
    assert.equal(arch.ok, true, JSON.stringify(arch));
    const after = await repo.listClues(BOOK);
    assert.deepEqual(after, { clues: [], archived: [{ slug: c.slug, fact: 'The harbour key opens the sea gate' }] });
    assert.equal((await repo.getClue(BOOK, c.slug)).archived, true);
    assert.equal((await repo.restoreClue(BOOK, c.slug)).ok, true);
    assert.equal((await repo.listClues(BOOK)).clues.length, 1);
  } finally {
    await repo.close();
  }
});

test('listClues: clues are sorted by fact; an unknown scene or entry shows null title, position and name and the problem', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    await repo.createClue(BOOK, { fact: 'Zed' });
    await repo.createClue(BOOK, { fact: 'alpha' });
    assert.deepEqual((await repo.listClues(BOOK)).clues.map((c) => c.fact), ['alpha', 'Zed']);

    const dir = path.join(root, 'planning', 'clues');
    await fs.writeFile(path.join(dir, 'ghost.md'), `---\nschema: storyforge.clue/v1\nid: note_01S50000000000000000000C09\nslug: ghost\nfact: A ghost fact\nplanted: [${GHOST}]\nrevealed: ${GHOST}\nred_herring: true\nknowers:\n  - who: entry_01S5000000000000000000ZZZZ\n    scene: ${GHOST}\n    reliable: false\n---\n`);
    const g = (await repo.listClues(BOOK)).clues.find((c) => c.slug === 'ghost');
    assert.deepEqual(g.planted, [{ id: GHOST, title: null, position: null }]);
    assert.deepEqual(g.revealed, { id: GHOST, title: null, position: null });
    assert.equal(g.red_herring, true);
    assert.deepEqual(g.knowers[0].who, { id: 'entry_01S5000000000000000000ZZZZ', name: null, reader: false, shared: false });
    assert.deepEqual(g.knowers[0].scene, { id: GHOST, title: null, position: null });
    assert.ok(g.problems.some((p) => p.code === 'E301'));
  } finally {
    await repo.close();
  }
});

test('a series-shared character knower resolves with shared: true', async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root);
  const LOW_TIDE = 'book_01W1000000000000000000000A';
  const ILSE = 'entry_01W10000000000000000000003';
  const EBB = 'scene_01W1000000000000000000000B';
  try {
    const c = await repo.createClue(LOW_TIDE, { fact: 'Ilse kept the ledger', fields: { revealed: EBB } });
    assert.equal(c.ok, true, JSON.stringify(c));
    const k = await repo.setClueKnowers(LOW_TIDE, c.slug, { knowers: [{ who: ILSE, scene: EBB }, { who: 'reader', scene: EBB }], baseSha256: (await repo.getClue(LOW_TIDE, c.slug)).sha256 });
    assert.equal(k.ok, true, JSON.stringify(k));
    const a = (await repo.listClues(LOW_TIDE)).clues[0];
    assert.deepEqual(a.knowers[0].who, { id: ILSE, name: 'Ilse Hollis', reader: false, shared: true });
    assert.deepEqual(a.knowers[1].who, { id: 'reader', name: null, reader: true });
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('clue writes through the repository: refusals carry their codes, creation is undoable', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    assert.equal((await repo.createClue('book_nope', { fact: 'x' })).code, 'NOT_FOUND');
    assert.equal((await repo.createClue(BOOK, { fact: '' })).code, 'REFUSED_BAD_ARGS');
    const u = await repo.createClue(BOOK, { fact: 'x', fields: { revealed: GHOST } });
    assert.equal(u.code, 'REFUSED_UNKNOWN_SCENE');
    assert.equal(u.field, 'revealed');
    const c = await repo.createClue(BOOK, { fact: 'Undo me' });
    const undone = await repo.restoreOp(BOOK, c.opId);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.deepEqual(await repo.listClues(BOOK), { clues: [], archived: [] });
  } finally {
    await repo.close();
  }
});

test('links carry a branch; flowGraph edges and getLink show it and branches lists the distinct labels; planOverview counts are unchanged', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    const main = await repo.createLink(BOOK, { from: ARRIVAL, to: FERRY, relation: 'enables' });
    const b1 = await repo.createLink(BOOK, { from: ARRIVAL, to: FERRY, relation: 'enables', branch: 'ferry-sinks' });
    const b2 = await repo.createLink(BOOK, { from: KEY, to: FERRY, relation: 'but', branch: 'ferry-sinks' });
    const b3 = await repo.createLink(BOOK, { from: KEY, to: ARRIVAL, relation: 'but', branch: 'another-way' });
    for (const r of [main, b1, b2, b3]) assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await repo.getLink(BOOK, main.slug)).branch, null);
    assert.equal((await repo.getLink(BOOK, b1.slug)).branch, 'ferry-sinks');
    const list = await repo.listLinks(BOOK);
    assert.deepEqual(list.links.map((l) => l.branch).sort(), ['another-way', 'ferry-sinks', 'ferry-sinks', null]);
    const g = await repo.flowGraph(BOOK);
    assert.deepEqual(g.branches, ['another-way', 'ferry-sinks']);
    assert.equal(g.edges.find((e) => e.slug === b3.slug).branch, 'another-way');
    assert.equal(g.edges.find((e) => e.slug === main.slug).branch, null);
    assert.equal((await repo.planOverview(BOOK)).counts.links, 4);
    const u = await repo.updateLink(BOOK, b3.slug, { branch: null, baseSha256: (await repo.getLink(BOOK, b3.slug)).sha256 });
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual((await repo.flowGraph(BOOK)).branches, ['ferry-sinks']);
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close();
  }
});

test('seriesPlan: null for an unknown book, { series: null } outside a series', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    assert.equal(await repo.seriesPlan('book_nope'), null);
    assert.deepEqual(await repo.seriesPlan(BOOK), { series: null });
  } finally {
    await repo.close();
  }
});

test('seriesPlan: a two-book series in series_number order with story plan, overview synopsis and shared arcs joined by character', async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root);
  const ONE = 'book_01W10000000000000000000006'; // salt-orchard-2, series_number 1
  const TWO = 'book_01W1000000000000000000000A'; // low-tide, series_number 2
  const SCENE_TWO = 'scene_01W1000000000000000000000B';
  const ILSE = 'entry_01W10000000000000000000003';
  try {
    // nothing planned yet: both books, no logline, no synopsis, no arcs, no characters
    const bare = await repo.seriesPlan(TWO);
    assert.deepEqual(bare.series, { slug: 'tidewater', title: 'The Tidewater Books' });
    assert.deepEqual(bare.books.map((b) => [b.id, b.slug, b.title, b.series_number]), [[ONE, 'salt-orchard-2', 'Salt Orchard Two', 1], [TWO, 'low-tide', 'Low Tide', 2]]);
    assert.deepEqual(bare.books[0], { id: ONE, slug: 'salt-orchard-2', title: 'Salt Orchard Two', series_number: 1, logline: null, premise: null, synopsis: null, arcs: [] });
    assert.deepEqual(bare.characters, []);
    assert.deepEqual(await repo.seriesPlan(ONE), bare, 'the same from either book');

    assert.equal((await repo.saveStoryPlan(TWO, { fields: { logline: 'Ilse looks for the ledger.', premise: 'A lamp keeper left something behind.' } })).ok, true);
    assert.equal((await repo.createSynopsis(ONE, { type: 'short', name: 'Short one', body: 'A short synopsis.\n' })).ok, true);
    assert.equal((await repo.createSynopsis(ONE, { type: 'one-page', body: 'The one-page text.\n' })).ok, true);
    assert.equal((await repo.createSynopsis(TWO, { type: 'short', body: 'Short for two.\n' })).ok, true);
    const arcOne = await repo.createArc(ONE, { character: ILSE, arc_type: 'flat', fields: { start_state: 'Keeper of the lamp.', end_state: 'Gone.' } });
    assert.equal(arcOne.ok, true, JSON.stringify(arcOne));
    const arcTwo = await repo.createArc(TWO, { character: ILSE, arc_type: 'flat', fields: { start_state: 'A name in a ledger.' } });
    assert.equal(arcTwo.ok, true, JSON.stringify(arcTwo));
    const ms = await repo.setArcMilestones(TWO, arcTwo.slug, { milestones: [{ scene: SCENE_TWO, pressure: 'The tide turns.' }], baseSha256: (await repo.getArc(TWO, arcTwo.slug)).sha256 });
    assert.equal(ms.ok, true, JSON.stringify(ms));
    assert.deepEqual(await errorsOf(root), []);

    const plan = await repo.seriesPlan(ONE);
    const [one, two] = plan.books;
    assert.deepEqual(Object.keys(one).sort(), ['arcs', 'id', 'logline', 'premise', 'series_number', 'slug', 'synopsis', 'title']);
    assert.deepEqual(one.synopsis, { type: 'one-page', name: 'One-page synopsis', body: 'The one-page text.' }, 'one-page beats short');
    assert.deepEqual(one.arcs, [{ character: { id: ILSE, name: 'Ilse Hollis', shared: true }, start: 'Keeper of the lamp.', end: 'Gone.', milestones: 0 }]);
    assert.equal(one.logline, null);
    assert.equal(two.logline, 'Ilse looks for the ledger.');
    assert.equal(two.premise, 'A lamp keeper left something behind.');
    assert.deepEqual(two.synopsis, { type: 'short', name: 'Short synopsis', body: 'Short for two.' });
    assert.deepEqual(two.arcs, [{ character: { id: ILSE, name: 'Ilse Hollis', shared: true }, start: 'A name in a ledger.', end: null, milestones: 1 }]);
    assert.deepEqual(plan.characters, [{ id: ILSE, name: 'Ilse Hollis', books: [{ id: ONE, title: 'Salt Orchard Two', arc_slug: arcOne.slug }, { id: TWO, title: 'Low Tide', arc_slug: arcTwo.slug }] }]);
    assert.deepEqual(await repo.seriesPlan(TWO), plan);

    // an archived synopsis and an archived arc drop out
    assert.equal((await repo.archiveArc(TWO, arcTwo.slug)).ok, true);
    const slim = await repo.seriesPlan(TWO);
    assert.deepEqual(slim.books[1].arcs, []);
    assert.deepEqual(slim.characters.map((c) => c.books.map((b) => b.id)), [[ONE]]);
  } finally {
    await repo.close();
  }
});

test('seriesPlan: an arc of a character that is not series-shared is left out', async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root);
  const TWO = 'book_01W1000000000000000000000A';
  try {
    const own = await repo.createEntry(TWO, { type: 'character', name: 'Local Hero' });
    assert.equal(own.ok, true, JSON.stringify(own));
    const arc = await repo.createArc(TWO, { character: own.id, arc_type: 'flat' });
    assert.equal(arc.ok, true, JSON.stringify(arc));
    assert.equal((await repo.listArcs(TWO)).arcs.length, 1);
    const plan = await repo.seriesPlan(TWO);
    assert.deepEqual(plan.books.find((b) => b.id === TWO).arcs, []);
    assert.deepEqual(plan.characters, []);
  } finally {
    await repo.close();
  }
});
