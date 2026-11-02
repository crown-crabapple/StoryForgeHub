// M04-J04 acceptance 5: with the watcher on, `fs.writeFile` to an event and to a research note shows up within 5 s in the timeline data
// (getTimeline), the notes data (listNotes / getNote) and the inspector data (a scene's events, an entry's research links); an invalid
// edit is listed as a problem and the last valid data is kept. Nothing here goes through the app's own write commands.
// Contract: docs/contracts/M04-J04-timeline-research.md section 5 and acceptance 5. Helpers: watch-helpers.mjs (M01-J04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  ARRIVAL, BOOK, FERRY, PROLOGUE, abs, plain, rowsOf, setup, sha256, stateOf, waitFor,
} from './watch-helpers.mjs';

const FLOOD_REL = 'planning/timeline/the-flood.md';
const FLOOD = 'event_01S5000000000000000000000W';
const TIDES_REL = 'research/tidal-ranges.md';
const TIDES = 'note_01S50000000000000000000011';
const SALT_ORCHARD_ENTRY = 'entry_01S5000000000000000000000M';
const ARRIVAL_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';

const eventOf = async (repo, ref = FLOOD) => (await repo.getTimeline(BOOK)).events.find((e) => e.id === ref || e.slug === ref);
const noteOf = async (repo, id = TIDES) => (await repo.listNotes(BOOK)).notes.find((n) => n.id === id);
const edit = async (root, rel, fn) => {
  const f = abs(root, rel);
  const before = await fs.readFile(f, 'utf8');
  const after = fn(before);
  assert.notEqual(after, before, `edit of ${rel} changed nothing`);
  await fs.writeFile(f, after);
  return after;
};

test('5. an external edit to an event file (order, when, title, date, characters, scenes) shows in the timeline data within 5 s', async (t) => {
  const { root, repo } = await setup(t);
  assert.equal((await eventOf(repo)).order, 100);

  await edit(root, FLOOD_REL, (s) => s
    .replace('order: 100', 'order: 175.5')
    .replace('title: The spring flood', 'title: The great spring flood')
    .replace('when: "Spring, year 0"', 'when: "Late spring, year 0"\ndate: "1998-04"\ncharacters: [ilse-hollis]\nlocations: [salt-orchard]')
    .replace(/scenes: \[(.*)\]/, 'scenes: [$1, scene_01S50000000000000000000005]'));

  const e = await waitFor(async () => {
    const x = await eventOf(repo);
    return x?.order === 175.5 ? x : null;
  }, { what: 'timeline data to show the new order' });
  assert.equal(e.title, 'The great spring flood');
  assert.equal(e.when, 'Late spring, year 0');
  assert.equal(e.date, '1998-04');
  assert.deepEqual(e.characters, ['ilse-hollis']);
  assert.deepEqual(e.locations, ['salt-orchard']);
  assert.deepEqual(e.scenes.map((s) => s.id), [PROLOGUE, FERRY]);
  assert.deepEqual(e.problems, []);
  assert.equal(e.sha256, sha256(await fs.readFile(abs(root, FLOOD_REL))));
  const order = (await repo.getTimeline(BOOK)).events.map((x) => x.slug);
  assert.deepEqual(order, ['the-first-grafting', 'the-key-found-twice', 'the-flood', 'the-return', 'the-wall-falls'], 'order 175.5 puts the flood between 150 and 200');
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh' });
});

test('5. an external edit to an event\'s text is served by getEvent and found by search', async (t) => {
  const { root, repo } = await setup(t);
  await edit(root, FLOOD_REL, (s) => `${s.trimEnd()}\n\nThe wave carried a zephyrquill.\n`);
  await waitFor(async () => (await repo.getEvent(BOOK, FLOOD)).body.includes('zephyrquill'), { what: 'event body' });
  await waitFor(async () => rowsOf(plain(await repo.search('zephyrquill', { bookId: BOOK }))).some((r) => r.id === FLOOD), { what: 'search to find the event text' });
});

test('5. an external edit to a research note (tags, canon, links, sources, text) shows in the notes data within 5 s', async (t) => {
  const { root, repo } = await setup(t);
  assert.deepEqual((await noteOf(repo)).tags, ['tides', 'setting']);

  await edit(root, TIDES_REL, (s) => s
    .replace('tags: [tides, setting]', 'tags: [tides, maps]')
    .replace('canon: false', 'canon: true')
    .replace('links: [salt-orchard]', 'links: [salt-orchard, maren-hollis, brass-key]')
    .replace('Neap tides about two.', 'Neap tides about two. Quasarwort grows here.'));

  const n = await waitFor(async () => {
    const x = await noteOf(repo);
    return x?.canon === true ? x : null;
  }, { what: 'notes data to show canon: true' });
  assert.deepEqual(n.tags, ['tides', 'maps']);
  assert.deepEqual(n.links.map((l) => [l.slug, l.kind, l.state]), [['salt-orchard', 'entry', 'ok'], ['maren-hollis', 'entry', 'ok'], ['brass-key', 'thread', 'ok']]);
  assert.match(n.excerpt, /Quasarwort grows here\./);
  assert.deepEqual(n.problems, []);
  assert.match((await repo.getNote(BOOK, TIDES)).body, /Quasarwort/);
  const tags = (await repo.listNotes(BOOK)).tags;
  assert.deepEqual(tags, [{ tag: 'maps', count: 1 }, { tag: 'tides', count: 1 }]);
  await waitFor(async () => rowsOf(plain(await repo.search('quasarwort', { bookId: BOOK }))).some((r) => r.id === TIDES), { what: 'search to find the research text' });
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh' });
});

test('5. inspector data: the Research section of an entry follows an external edit of a note\'s links (add and remove)', async (t) => {
  const { root, repo } = await setup(t);
  const linking = async (entryId) => (await repo.listNotes(BOOK)).notes.filter((n) => n.links.some((l) => l.id === entryId)).map((n) => n.id);
  assert.deepEqual(await linking(SALT_ORCHARD_ENTRY), [TIDES]);
  assert.deepEqual(await linking('entry_01S5000000000000000000000G'), [], 'Maren has no research yet');

  await edit(root, TIDES_REL, (s) => s.replace('links: [salt-orchard]', 'links: [maren-hollis]'));
  await waitFor(async () => (await linking('entry_01S5000000000000000000000G')).length === 1, { what: 'Maren to gain the note' });
  assert.deepEqual(await linking(SALT_ORCHARD_ENTRY), [], 'and salt-orchard to lose it');

  // a brand-new note file created outside the app is picked up too
  await fs.writeFile(abs(root, 'research/new-note.md'), '---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000FF01\ntitle: Created outside\nlinks: [maren-hollis]\n---\nHi.\n');
  await waitFor(async () => (await linking('entry_01S5000000000000000000000G')).includes('note_01S5000000000000000000FF01'), { what: 'the new note' });
  assert.equal((await noteOf(repo, 'note_01S5000000000000000000FF01')).title, 'Created outside');
});

test('5. inspector data: a scene\'s events (from both sides) follow an external edit of a scene\'s events list and of an event\'s scenes list', async (t) => {
  const { root, repo } = await setup(t);
  const eventsOfScene = async (sceneId) => (await repo.getTimeline(BOOK)).events.filter((e) => e.scenes.some((s) => s.id === sceneId)).map((e) => e.slug).sort();
  assert.deepEqual(await eventsOfScene(ARRIVAL), ['the-return']);

  await edit(root, ARRIVAL_REL, (s) => s.replace('events: [the-return]', 'events: [the-return, the-flood]'));
  await waitFor(async () => (await eventsOfScene(ARRIVAL)).length === 2, { what: 'scene side of the link' });
  assert.deepEqual(await eventsOfScene(ARRIVAL), ['the-flood', 'the-return']);
  assert.equal((await eventOf(repo, 'the-flood')).scenes.find((s) => s.id === ARRIVAL).side, 'scene');

  await edit(root, FLOOD_REL, (s) => s.replace(/scenes: \[(.*)\]/, `scenes: [$1, ${ARRIVAL}]`));
  await waitFor(async () => (await eventOf(repo, 'the-flood')).scenes.find((s) => s.id === ARRIVAL)?.side === 'both', { what: 'both sides' });
});

test('5. a new event file written outside the app appears; a deleted one disappears; a renamed one keeps its id', async (t) => {
  const { root, repo } = await setup(t);
  await fs.writeFile(abs(root, 'planning/timeline/outside.md'), '---\nschema: storyforge.event/v1\nid: event_01S5000000000000000000FF02\nslug: outside\ntitle: Written outside\norder: 50\n---\n');
  await waitFor(async () => (await eventOf(repo, 'outside')) !== undefined, { what: 'new event' });
  assert.deepEqual((await repo.getTimeline(BOOK)).events.map((e) => e.slug).slice(0, 3), ['the-first-grafting', 'outside', 'the-flood']);

  await fs.rename(abs(root, 'planning/timeline/outside.md'), abs(root, 'planning/timeline/outside-renamed.md'));
  const moved = await waitFor(async () => {
    const x = await eventOf(repo, 'event_01S5000000000000000000FF02');
    return x?.path.endsWith('outside-renamed.md') ? x : null;
  }, { what: 'rename' });
  assert.equal(moved.title, 'Written outside');
  assert.equal((await repo.getTimeline(BOOK)).events.filter((e) => e.id === 'event_01S5000000000000000000FF02').length, 1);

  await fs.rm(abs(root, 'planning/timeline/outside-renamed.md'));
  await waitFor(async () => (await eventOf(repo, 'event_01S5000000000000000000FF02')) === undefined, { what: 'deleted event gone' });
  assert.equal((await repo.getTimeline(BOOK)).events.length, 5);
  assert.deepEqual((await repo.getTimeline(BOOK)).unreadable, [], 'a deleted file is not "unreadable"');
});

test('5. an invalid external edit (bad date) is listed as a problem on the event; the other fields stay; fixing it clears the problem', async (t) => {
  const { root, repo } = await setup(t);
  const good = await fs.readFile(abs(root, FLOOD_REL), 'utf8');
  await fs.writeFile(abs(root, FLOOD_REL), good.replace('when:', 'date: "next spring"\nwhen:'));

  const e = await waitFor(async () => {
    const x = await eventOf(repo);
    return x?.problems.length ? x : null;
  }, { what: 'problem on the event' });
  assert.deepEqual(e.problems.map((p) => `${p.code}|${p.severity}|${p.location}`), ['E102|error|date']);
  assert.equal(e.order, 100, 'the rest of the event is kept');
  assert.equal(e.title, 'The spring flood');
  assert.equal((await repo.getTimeline(BOOK)).events.length, 5);
  assert.equal(await fs.readFile(abs(root, FLOOD_REL), 'utf8'), good.replace('when:', 'date: "next spring"\nwhen:'), 'the app never rewrites the file');

  await fs.writeFile(abs(root, FLOOD_REL), good);
  await waitFor(async () => (await eventOf(repo)).problems.length === 0, { what: 'problem cleared' });
  await waitFor(async () => (await stateOf(repo)) === 'fresh', { what: 'state fresh again' });
});

test('5. an unreadable external edit (broken YAML) to an event: problem listed, the last valid event kept (stale), file untouched; the fix un-stales it', async (t) => {
  const { root, repo } = await setup(t);
  assert.equal((await eventOf(repo)).order, 100); // the page has seen it once
  await edit(root, FLOOD_REL, (s) => s.replace('order: 100', 'order: 125'));
  await waitFor(async () => (await eventOf(repo)).order === 125, { what: 'valid edit first' });

  const broken = (await fs.readFile(abs(root, FLOOD_REL), 'utf8')).replace(/^title:.*$/m, 'title: [unclosed');
  await fs.writeFile(abs(root, FLOOD_REL), broken);

  const tl = await waitFor(async () => {
    const x = await repo.getTimeline(BOOK);
    return x.unreadable.some((u) => u.path === FLOOD_REL) ? x : null;
  }, { what: 'unreadable file listed' });
  assert.ok(tl.unreadable.find((u) => u.path === FLOOD_REL).code.startsWith('E1'));
  const kept = tl.events.find((e) => e.id === FLOOD);
  assert.ok(kept, 'last valid projection kept');
  assert.equal(kept.stale, true);
  assert.equal(kept.order, 125, 'the last VALID version, with the valid edit, not the original');
  assert.equal(kept.title, 'The spring flood');
  assert.ok(kept.problems.some((p) => p.code.startsWith('E1')));
  assert.equal(tl.events.length, 5);
  assert.equal(await fs.readFile(abs(root, FLOOD_REL), 'utf8'), broken, 'raw file untouched');

  await fs.writeFile(abs(root, FLOOD_REL), broken.replace('title: [unclosed', 'title: Repaired'));
  const fixed = await waitFor(async () => {
    const x = await eventOf(repo);
    return x && !x.stale && x.title === 'Repaired' ? x : null;
  }, { what: 'repaired event' });
  assert.deepEqual(fixed.problems, []);
  assert.deepEqual((await repo.getTimeline(BOOK)).unreadable, []);
});

test('5. an invalid external edit to a research note: problem listed, last valid note data kept (stale); a bad cite key is a problem on the note', async (t) => {
  const { root, repo } = await setup(t);
  assert.equal((await noteOf(repo)).canon, false);
  await edit(root, TIDES_REL, (s) => s.replace('sources: [admiralty-tables]', 'sources: [admiralty-tables, no-such-source]'));
  const withBad = await waitFor(async () => {
    const x = await noteOf(repo);
    return x?.problems.length ? x : null;
  }, { what: 'E301 on the note' });
  assert.deepEqual(withBad.problems.map((p) => `${p.code}|${p.location}`), ['E301|sources[1]']);
  assert.deepEqual(withBad.sources.map((s) => [s.cite_key, s.state]), [['admiralty-tables', 'ok'], ['no-such-source', 'broken']]);

  const broken = (await fs.readFile(abs(root, TIDES_REL), 'utf8')).replace(/^title:.*$/m, 'title: [unclosed');
  await fs.writeFile(abs(root, TIDES_REL), broken);
  const list = await waitFor(async () => {
    const x = await repo.listNotes(BOOK);
    return x.unreadable.some((u) => u.path === TIDES_REL) ? x : null;
  }, { what: 'unreadable note listed' });
  const kept = list.notes.find((n) => n.id === TIDES);
  assert.ok(kept, 'last valid note kept');
  assert.equal(kept.stale, true);
  assert.equal(kept.title, 'Tidal ranges on the coast');
  assert.deepEqual(kept.tags, ['tides', 'setting']);
  assert.ok(kept.problems.some((p) => p.code.startsWith('E1')));
  assert.equal(list.notes.length, 3);
  assert.equal(await fs.readFile(abs(root, TIDES_REL), 'utf8'), broken, 'raw file untouched');

  await fs.writeFile(abs(root, TIDES_REL), broken.replace('title: [unclosed', 'title: Repaired note'));
  await waitFor(async () => {
    const x = await noteOf(repo);
    return x && !x.stale && x.title === 'Repaired note';
  }, { what: 'repaired note' });
  assert.deepEqual((await repo.listNotes(BOOK)).unreadable, []);
});

test('5. an external edit to a source (cite key renamed) breaks the citing note\'s reference until the note is fixed', async (t) => {
  const { root, repo } = await setup(t);
  await edit(root, 'research/sources/admiralty-tables.md', (s) => s.replace('cite_key: admiralty-tables', 'cite_key: admiralty-1998'));
  const n = await waitFor(async () => {
    const x = await noteOf(repo);
    return x?.sources[0].state === 'broken' ? x : null;
  }, { what: 'broken citation' });
  assert.deepEqual(n.problems.map((p) => `${p.code}|${p.location}`), ['E301|sources[0]']);
  await edit(root, TIDES_REL, (s) => s.replace('sources: [admiralty-tables]', 'sources: [admiralty-1998]'));
  await waitFor(async () => (await noteOf(repo)).problems.length === 0, { what: 'fixed' });
  assert.equal((await noteOf(repo)).sources[0].title, 'Tide Tables for the North Shore');
});

test('5. scene notes follow an external edit of a scene (added, changed, removed)', async (t) => {
  const { root, repo } = await setup(t);
  const texts = async () => (await repo.getSceneNotes(BOOK)).scenes.flatMap((s) => s.notes.map((n) => `${s.id}:${n.text}`));
  const before = await texts();
  assert.equal(before.length, 1);
  await edit(root, ARRIVAL_REL, (s) => `${s.trimEnd()}\n\n<!-- note: added outside -->\n`);
  await waitFor(async () => (await texts()).includes(`${ARRIVAL}:added outside`), { what: 'added note' });
  await edit(root, ARRIVAL_REL, (s) => s.replace('added outside', 'changed outside'));
  await waitFor(async () => (await texts()).includes(`${ARRIVAL}:changed outside`), { what: 'changed note' });
  await edit(root, ARRIVAL_REL, (s) => s.replace(/\n*<!-- note: changed outside -->\n?/, '\n'));
  await waitFor(async () => (await texts()).length === 1, { what: 'removed note' });
});

test('5. attachments: a file dropped into assets/ outside the app is served at once (nothing is cached)', async (t) => {
  const { root, repo } = await setup(t);
  assert.equal(await repo.getAttachment(BOOK, 'assets/research/late.pdf'), null);
  await fs.mkdir(abs(root, 'assets/research'), { recursive: true });
  await fs.writeFile(abs(root, 'assets/research/late.pdf'), '%PDF-1.4\n');
  const a = await waitFor(async () => repo.getAttachment(BOOK, 'assets/research/late.pdf'), { what: 'attachment' });
  assert.equal(a.contentType, 'application/pdf');
  assert.equal(a.inline, false);
  assert.equal(a.bytes.toString(), '%PDF-1.4\n');
});
