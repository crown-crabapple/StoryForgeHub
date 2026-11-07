// M04-J04 acceptance 7: render tests (no browser, no network) for the Timeline page (cards, Story time / Book order toggle, chart and its table
// fallback, filters, Problems panel), the Notes page (sidebar, list, note view with external / attachment links, sources, scene notes), the Research
// section of the Codex inspector and the editor rail, and the Places tab; plus the pure logic behind them, checked against the fixture FILES
// (an independent reader of front matter, not the product's code): chronological and narrative orders, told early / late flags, filters, problems,
// midpoint order values, link classification.
//
// Fixture data is the real answer of the core repository (getTimeline / listNotes / getSceneNotes / listCodexEntries) over a temp copy of
// valid/salt-orchard. Component props follow the JSDoc of apps/web/src/timeline/* and apps/web/src/notes/*.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.resolve(webDir, '../../packages/format/fixtures/valid');
const SO = 'book_01S5000000000000000000000A';
const PROLOGUE = 'scene_01S50000000000000000000001';
const ARRIVAL = 'scene_01S50000000000000000000002';
const KEY = 'scene_01S50000000000000000000003';
const WALL = 'scene_01S50000000000000000000009';
const ARCHIVED_SCENE = 'scene_01S50000000000000000000007';
const TIDES = 'note_01S50000000000000000000011';
const PLAN = 'note_01S50000000000000000000010';
const TABLES = 'note_01S50000000000000000000012';

let vite;
const mod = {};
const sets = {};

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const walk = async (dir, out = []) => {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
};
const frontOf = async (file) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await fs.readFile(file, 'utf8'));
  return m ? YAML.parse(m[1]) : null;
};

/** The independent oracle: what the files say, with no code from the product. */
async function oracle(root) {
  const scenes = [];
  const events = [];
  for (const f of await walk(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel.startsWith('.storyforge/')) continue;
    const fm = await frontOf(f);
    if (fm?.schema === 'storyforge.scene/v1') scenes.push({ ...fm, rel });
    if (fm?.schema === 'storyforge.event/v1' && !rel.startsWith('archive/')) events.push({ ...fm, rel });
  }
  const live = scenes.filter((s) => s.rel.startsWith('manuscript/') && !s.variant_of).sort((a, b) => a.chapter - b.chapter || a.sequence - b.sequence);
  const pos = new Map(live.map((s, i) => [s.id, i + 1]));
  const rows = events.map((e) => {
    const ids = new Set(Array.isArray(e.scenes) ? e.scenes : []);
    for (const s of scenes) if ((s.events ?? []).some((r) => r === e.slug || r === e.id)) ids.add(s.id);
    const positions = [...ids].map((id) => pos.get(id)).filter((p) => p !== undefined);
    return { slug: e.slug, id: e.id, order: typeof e.order === 'number' ? e.order : null, when: e.when ?? null, position: positions.length ? Math.min(...positions) : null, scenes: ids, fm: e };
  });
  const chrono = rows.filter((r) => r.order !== null).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const placed = chrono.filter((r) => r.position !== null);
  for (const e of rows) {
    e.early = e.position !== null && e.order !== null && placed.some((f) => f !== e && f.order < e.order && e.position < f.position);
    e.late = e.position !== null && e.order !== null && placed.some((f) => f !== e && f.order > e.order && e.position > f.position);
  }
  const bookOrder = rows.filter((r) => r.position !== null).sort((a, b) => a.position - b.position || a.order - b.order || (a.id < b.id ? -1 : 1));
  return { rows, chrono: chrono.map((r) => r.slug), book: bookOrder.map((r) => r.slug), unplaced: rows.filter((r) => r.position === null).map((r) => r.slug).sort(), early: rows.filter((r) => r.early).map((r) => r.slug).sort(), late: rows.filter((r) => r.late).map((r) => r.slug).sort(), by: (slug) => rows.find((r) => r.slug === slug) };
}

/** Copy salt-orchard, apply `prep(root)`, and read what the pages are given. */
async function load(prep) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tln-'));
  const root = path.join(base, 'salt-orchard');
  await fs.cp(path.join(FIXTURES, 'salt-orchard'), root, { recursive: true });
  if (prep) await prep(root);
  const repo = createFsRepository(root);
  try {
    const timeline = await repo.getTimeline(SO);
    const notes = await repo.listNotes(SO);
    const sceneNotes = await repo.getSceneNotes(SO);
    const list = await repo.listCodexEntries(SO);
    const types = await repo.getCodexTypes(SO);
    const full = [];
    for (const n of notes.notes) full.push(await repo.getNote(SO, n.id));
    return { root, timeline, notes, sceneNotes, entries: list.entries, chapters: list.chapters, types, full, oracle: await oracle(root) };
  } finally {
    await repo.close?.();
  }
}
const putFile = (rel, content) => async (root) => {
  await fs.mkdir(path.dirname(abs(root, rel)), { recursive: true });
  await fs.writeFile(abs(root, rel), content);
};
const editFile = (rel, fn) => async (root) => fs.writeFile(abs(root, rel), fn(await fs.readFile(abs(root, rel), 'utf8')));
const seq = (...fns) => async (root) => { for (const f of fns) await f(root); };
const eventFile = (n, slug, order, extra = '') => `---\nschema: storyforge.event/v1\nid: event_01S5000000000000000000AA0${n}\nslug: ${slug}\ntitle: ${slug}\norder: ${order}\n${extra}---\n`;

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.tl = await vite.ssrLoadModule('/src/timeline/model.js');
  mod.tlPage = await vite.ssrLoadModule('/src/timeline/TimelinePage.jsx');
  mod.chart = await vite.ssrLoadModule('/src/timeline/TimelineChart.jsx');
  mod.railEvents = await vite.ssrLoadModule('/src/timeline/RailEvents.jsx');
  mod.nt = await vite.ssrLoadModule('/src/notes/model.js');
  mod.render = await vite.ssrLoadModule('/src/notes/render.js');
  mod.ntPage = await vite.ssrLoadModule('/src/notes/NotesPage.jsx');
  mod.prose = await vite.ssrLoadModule('/src/notes/NoteProse.jsx');
  mod.railResearch = await vite.ssrLoadModule('/src/notes/RailResearch.jsx');
  mod.upload = await vite.ssrLoadModule('/src/notes/upload.js');
  mod.codexPage = await vite.ssrLoadModule('/src/codex/CodexPage.jsx');
  mod.inspector = await vite.ssrLoadModule('/src/codex/EntryInspector.jsx');
  mod.codex = await vite.ssrLoadModule('/src/codex/model.js');
  mod.shell = await vite.ssrLoadModule('/src/shell/Inspector.jsx');
  mod.routes = await vite.ssrLoadModule('/src/routes.js');
  sets.so = await load();
  // a copy with the fields the filters need (characters / locations on events, one more event in a thread's scene)
  sets.rich = await load(seq(
    editFile('planning/timeline/the-flood.md', (s) => s.replace('scenes:', 'characters: [ilse-hollis]\nlocations: [salt-orchard]\nscenes:')),
    editFile('planning/timeline/the-return.md', (s) => s.replace('---\nMaren returns', 'characters: [maren-hollis]\nlocations: [port-aldine]\n---\nMaren returns')),
    editFile('planning/timeline/the-wall-falls.md', (s) => s.replace('scenes:', 'characters: [maren-hollis, entry_01S5000000000000000000000K]\nlocations: [salt-orchard]\nscenes:')),
    editFile('planning/timeline/the-first-grafting.md', (s) => s.replace('scenes:', 'characters: [pell, maren-hollis]\nlocations: [salt-orchard]\nscenes:')),
    putFile('planning/timeline/the-key-lands.md', eventFile(1, 'the-key-lands', 160, `scenes: [${KEY}]\n`)),
    putFile('planning/timeline/the-flood-twin.md', eventFile(2, 'the-flood-twin', 100, `when: "Spring, year 0"\nscenes: [${WALL}]\n`)),
  ));
  // a copy with every kind of problem
  sets.bad = await load(seq(
    putFile('planning/timeline/bad-date.md', eventFile(3, 'bad-date', 401, 'date: "2024-13-45"\n')),
    putFile('planning/timeline/broken-scene.md', eventFile(4, 'broken-scene', 402, 'scenes: [scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ]\n')),
    putFile('planning/timeline/archived-scene.md', eventFile(5, 'archived-scene', 403, `scenes: [${ARCHIVED_SCENE}]\n`)),
    putFile('planning/timeline/no-order.md', eventFile(6, 'no-order', 0).replace('order: 0\n', '')),
  ));
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) ?? []).length;
const anchors = (html) => [...decode(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], href: /href="([^"]*)"/.exec(m[1])?.[1] ?? null, text: textOf(m[2]) }));
const cardOf = (html, id) => new RegExp(`<article[^>]*data-event="${id}"[\\s\\S]*?</article>`).exec(html)?.[0] ?? '';
const cardIds = (html) => [...html.matchAll(/<article[^>]*data-event="([^"]+)"/g)].map((m) => m[1]);
const headings = (html) => [...html.matchAll(/<h2 class="tl-when">([\s\S]*?)<\/h2>/g)].map((m) => textOf(m[1]));
const idOf = (set, slug) => set.timeline.events.find((e) => e.slug === slug).id;
const slugsOf = (set, ids) => ids.map((id) => set.timeline.events.find((e) => e.id === id).slug);
const model = (set) => mod.tl.buildTimeline(set.timeline);
const renderTl = (set, props = {}) => renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data: set.timeline, model: model(set), ...props }));
const renderNotes = (set, props = {}) => renderToStaticMarkup(h(mod.ntPage.NotesPage, { bookId: SO, data: set.notes, sceneNotes: set.sceneNotes, ...props }));
const noop = () => {};

// ================================================================================================ pure logic: orders and flags

describe('acceptance 2 (pure): the two orders and the told early / late flags equal what the files say', () => {
  for (const key of ['so', 'rich', 'bad']) {
    test(`${key}: story time is order then id; book order is the lowest live scene position; unplaced events are separate`, () => {
      const set = sets[key];
      const m = model(set);
      const o = set.oracle;
      assert.deepEqual(m.events.filter((e) => e.order !== null).map((e) => e.slug), o.chrono, 'chronological');
      assert.deepEqual(m.book.placed.map((e) => e.slug), o.book, 'narrative');
      assert.deepEqual(m.book.unplaced.map((e) => e.slug).sort(), o.unplaced, 'not in the book yet');
      for (const e of m.events) assert.equal(e.position === null, o.by(e.slug).position === null, `${e.slug} placed?`);
    });

    test(`${key}: "told early" / "told late" flags are exactly the oracle's`, () => {
      const set = sets[key];
      const m = model(set);
      assert.deepEqual(m.events.filter((e) => e.told_early).map((e) => e.slug).sort(), set.oracle.early);
      assert.deepEqual(m.events.filter((e) => e.told_late).map((e) => e.slug).sort(), set.oracle.late);
    });
  }

  test('salt-orchard by hand: five events; the flood and the return are told early, the first grafting late; one event unplaced', () => {
    const m = model(sets.so);
    assert.deepEqual(m.events.map((e) => e.slug), ['the-first-grafting', 'the-flood', 'the-key-found-twice', 'the-return', 'the-wall-falls']);
    assert.deepEqual(m.book.placed.map((e) => e.slug), ['the-flood', 'the-return', 'the-first-grafting', 'the-wall-falls']);
    assert.deepEqual(m.book.unplaced.map((e) => e.slug), ['the-key-found-twice'], 'its only scene is a variant');
    assert.deepEqual(m.events.filter((e) => e.told_early).map((e) => e.slug), ['the-flood', 'the-return']);
    assert.deepEqual(m.events.filter((e) => e.told_late).map((e) => e.slug), ['the-first-grafting']);
  });

  test('story time groups runs of the same `when` label (Spring, year 30 holds the key and the return)', () => {
    const m = model(sets.so);
    assert.deepEqual(m.story.map((g) => [g.when, g.events.map((e) => e.slug)]), [
      ['Autumn, year -30', ['the-first-grafting']],
      ['Spring, year 0', ['the-flood']],
      ['Spring, year 30', ['the-key-found-twice', 'the-return']],
      ['Summer, year 30', ['the-wall-falls']],
    ]);
  });

  test('flags on a hand-made set: A(order 1, pos 3) B(2, 1) C(3, 2) D(2, 5, simultaneous with B) and one unplaced event', () => {
    const ev = (id, order, position) => ({ id, slug: id, title: id, order, when: null, date: '', characters: [], locations: [], problems: [], path: `${id}.md`, scenes: position === null ? [] : [{ id: `s${position}`, state: 'live', side: 'event', position, title: 's' }] });
    const m = mod.tl.buildTimeline({ events: [ev('a', 1, 3), ev('b', 2, 1), ev('c', 3, 2), ev('d', 2, 5), ev('u', 4, null)], entries: [], threads: [] });
    const early = m.events.filter((e) => e.told_early).map((e) => e.id).sort();
    const late = m.events.filter((e) => e.told_late).map((e) => e.id).sort();
    assert.deepEqual(early, ['b', 'c'], 'b and c are told before a, which happens earlier');
    assert.deepEqual(late, ['a', 'd'], 'a is told after b; d is told after c, which happens later');
    assert.equal(m.events.find((e) => e.id === 'u').told_early, false, 'an unplaced event is never flagged');
    assert.equal(m.events.find((e) => e.id === 'b').told_late, false, 'b is not also late');
  });

  test('simultaneous events (equal order) never flag each other, whatever their book positions', () => {
    const ev = (id, position) => ({ id, slug: id, title: id, order: 5, when: null, date: '', characters: [], locations: [], problems: [], path: `${id}.md`, scenes: [{ id: `s${position}`, state: 'live', side: 'event', position, title: 's' }] });
    const m = mod.tl.buildTimeline({ events: [ev('x', 9), ev('y', 1)], entries: [], threads: [] });
    assert.deepEqual(m.events.map((e) => [e.told_early, e.told_late]), [[false, false], [false, false]]);
  });

  test('an event of several scenes is placed at the lowest position of its live scenes; archived / variant / missing scenes are skipped', () => {
    const e = { id: 'e', slug: 'e', title: 'e', order: 1, when: null, date: '', characters: [], locations: [], problems: [], path: 'e.md', scenes: [
      { id: 'a', state: 'live', side: 'event', position: 6 }, { id: 'b', state: 'live', side: 'event', position: 2 }, { id: 'c', state: 'archived', side: 'event', position: null },
      { id: 'd', state: 'variant', side: 'event', position: null }, { id: 'f', state: 'missing', side: 'event', position: null }] };
    assert.equal(mod.tl.narrativePosition(e), 2);
    assert.equal(mod.tl.narrativePosition({ scenes: [{ state: 'archived', position: null }, { state: 'variant', position: null }] }), null);
    assert.equal(mod.tl.narrativePosition({ scenes: [] }), null);
  });
});

describe('acceptance 2 (pure): filters', () => {
  const rich = () => sets.rich;
  const filtered = (f) => {
    const m = model(rich());
    return mod.tl.filterEvents(m.events, f, rich().timeline, m.problems).map((e) => e.slug).sort();
  };
  const oracleBy = (pred) => rich().oracle.rows.filter(pred).map((r) => r.slug).sort();
  const names = (r, key) => (r.fm[key] ?? []).map((x) => (x.startsWith('entry_') ? rich().timeline.entries.find((e) => e.id === x).slug : x));

  test('by character: slug or id in the file, the same answer (Maren, Pell by id, Ilse)', () => {
    for (const c of ['maren-hollis', 'pell', 'ilse-hollis', 'tobin-reyes']) assert.deepEqual(filtered({ character: c }), oracleBy((r) => names(r, 'characters').includes(c)), c);
    assert.deepEqual(filtered({ character: 'maren-hollis' }), ['the-first-grafting', 'the-return', 'the-wall-falls']);
    assert.deepEqual(filtered({ character: 'pell' }), ['the-first-grafting', 'the-wall-falls']);
    assert.deepEqual(filtered({ character: 'tobin-reyes' }), []);
  });

  test('by location', () => {
    for (const l of ['salt-orchard', 'port-aldine']) assert.deepEqual(filtered({ location: l }), oracleBy((r) => names(r, 'locations').includes(l)), l);
    assert.deepEqual(filtered({ location: 'port-aldine' }), ['the-return']);
  });

  test('by thread: events with a live scene in the thread\'s setup / develop / payoff lists (brass-key: the key scene and the wall)', () => {
    const inThread = new Set([KEY, WALL]);
    assert.deepEqual(filtered({ thread: 'brass-key' }), oracleBy((r) => [...r.scenes].some((id) => inThread.has(id) && r.position !== null)));
    assert.deepEqual(filtered({ thread: 'brass-key' }), ['the-key-lands', 'the-flood-twin', 'the-wall-falls'].sort());
  });

  test('unplaced only, has problems, and filters combine with AND', () => {
    assert.deepEqual(filtered({ unplacedOnly: true }), rich().oracle.unplaced);
    assert.deepEqual(filtered({ hasProblems: true }), [rich().oracle.unplaced[0]].filter(Boolean).sort(), 'only the unplaced event has an entry in the problems list');
    assert.deepEqual(filtered({ character: 'maren-hollis', location: 'salt-orchard' }), ['the-first-grafting', 'the-wall-falls']);
    assert.deepEqual(filtered({ character: 'maren-hollis', location: 'salt-orchard', thread: 'brass-key' }), ['the-wall-falls']);
    assert.deepEqual(filtered({}), rich().oracle.rows.map((r) => r.slug).sort(), 'no filter: every event');
  });

  test('the filter choices offered are the characters, locations and threads that events use, named, A to Z', () => {
    const m = model(rich());
    assert.deepEqual(m.filters.characters.map((c) => [c.slug, c.name]), [['ilse-hollis', 'Ilse Hollis'], ['maren-hollis', 'Maren Hollis'], ['pell', 'Pell']]);
    assert.deepEqual(m.filters.locations.map((c) => c.slug), ['port-aldine', 'salt-orchard']);
    assert.deepEqual(m.filters.threads.map((t) => [t.slug, t.title]), [['brass-key', 'The brass key']]);
  });
});

describe('acceptance 2 (pure): the problems list', () => {
  test('salt-orchard: exactly one entry, "not in the book yet" for the key event, linking to that event', () => {
    const m = model(sets.so);
    assert.deepEqual(m.problems.map((p) => [p.kind, p.slug, p.severity, p.code]), [['unplaced', 'the-key-found-twice', 'info', null]]);
    assert.equal(m.problems[0].event_id, idOf(sets.so, 'the-key-found-twice'));
    assert.equal(m.problems[0].path, 'planning/timeline/the-key-found-twice.md');
  });

  test('every kind of problem is listed once per cause, per event, in event order', () => {
    const m = model(sets.bad);
    const of = (slug) => m.problems.filter((p) => p.slug === slug).map((p) => `${p.kind}|${p.code}|${p.location}`);
    assert.deepEqual(of('the-key-found-twice'), ['unplaced|null|']);
    assert.deepEqual(of('bad-date'), ['diagnostic|E102|date', 'unplaced|null|']);
    assert.deepEqual(of('broken-scene'), ['diagnostic|E301|scenes[0]', 'unplaced|null|']);
    const arch = of('archived-scene');
    assert.equal(arch.filter((x) => x.startsWith('archived-scene|W303|')).length, 1, 'one "scenes are archived" entry');
    assert.ok(arch.includes('unplaced|null|'));
    assert.ok(arch.every((x) => /^(diagnostic|archived-scene|unplaced)\|/.test(x)));
    const noOrder = of('no-order');
    assert.ok(noOrder.includes('no-order|E102|order'), noOrder.join(', '));
    // order of events in the list follows story time; an event with no order comes last
    const slugs = [...new Set(m.problems.map((p) => p.slug))];
    assert.deepEqual(slugs, ['the-key-found-twice', 'bad-date', 'broken-scene', 'archived-scene', 'no-order']);
    // events with nothing wrong are absent
    for (const clean of ['the-flood', 'the-return', 'the-first-grafting', 'the-wall-falls']) assert.deepEqual(of(clean), []);
    assert.ok(m.problems.filter((p) => p.event_id).every((p) => p.path.startsWith('planning/timeline/')));
  });

  test('an event with no valid order is listed apart, not placed in story time', () => {
    const m = model(sets.bad);
    assert.deepEqual(m.unordered.map((e) => e.slug), ['no-order']);
    assert.ok(!m.story.some((g) => g.events.some((e) => e.slug === 'no-order')));
    assert.ok(!m.points.some((p) => p.title === 'no-order'));
  });

  test('an unreadable file is a problem that opens nothing; a stale event says so and keeps its last valid data', () => {
    const data = { events: [{ id: 'event_x', slug: 'x', title: 'X', order: 1, when: null, date: '', characters: [], locations: [], path: 'planning/timeline/x.md', stale: true, scenes: [{ id: 's', state: 'live', side: 'event', position: 1 }], problems: [{ code: 'E100', severity: 'error', location: '', message: 'bad yaml' }] }],
      unreadable: [{ path: 'planning/timeline/x.md', code: 'E100', message: 'bad yaml' }, { path: 'planning/timeline/y.md', code: 'E100', message: 'worse yaml' }], entries: [], threads: [] };
    const m = mod.tl.buildTimeline(data);
    assert.equal(m.events.length, 1, 'the last valid event is still there');
    const kinds = m.problems.map((p) => [p.kind, p.path]);
    assert.deepEqual(kinds, [['unreadable', 'planning/timeline/x.md'], ['unreadable', 'planning/timeline/y.md']]);
    assert.match(m.problems[0].message, /last valid version/);
    assert.equal(m.problems[1].event_id, '');
  });
});

// ================================================================================================ pure logic: order values

describe('acceptance 3 (pure): `order` of a dropped event is the midpoint, nothing else renumbered', () => {
  const sorted = () => model(sets.so).events.filter((e) => e.order !== null);
  const moved = (id, index) => mod.tl.reorderTo(sorted(), idOf(sets.so, id), index);

  test('between two events: the midpoint of their orders (decimals allowed); the result carries only the moved event\'s value', () => {
    // others without the wall: grafting 10, flood 100, key 150, return 200 -> index 2 is between flood and key
    assert.deepEqual(moved('the-wall-falls', 2), { ok: true, order: 125 });
    assert.deepEqual(moved('the-wall-falls', 1), { ok: true, order: 55 });
    assert.deepEqual(moved('the-first-grafting', 2), { ok: true, order: 175 }, 'others are flood 100, key 150, return 200, wall 300: index 2 is between key and return');
  });

  test('first place is first order - 10, last place is last order + 10, on an empty list 10', () => {
    assert.deepEqual(moved('the-wall-falls', 0), { ok: true, order: 0 });
    assert.deepEqual(moved('the-first-grafting', 4), { ok: true, order: 310 });
    assert.deepEqual(mod.tl.midpointOrder([], 0), { ok: true, order: 10 });
    assert.deepEqual(mod.tl.midpointOrder([{ order: 5 }], 0), { ok: true, order: -5 });
    assert.deepEqual(mod.tl.midpointOrder([{ order: 5 }], 1), { ok: true, order: 15 });
  });

  test('repeated drops produce decimals without touching anyone else', () => {
    const seen = [];
    let between = 150; // keep dropping a new event just above 100, between 100 and the previous drop
    for (let i = 0; i < 5; i++) {
      const r = mod.tl.midpointOrder([{ order: 100 }, { order: between }], 1);
      assert.equal(r.ok, true);
      seen.push(r.order);
      between = r.order;
    }
    assert.deepEqual(seen, [125, 112.5, 106.25, 103.125, 101.5625]);
  });

  test('between two simultaneous events the value is that same order; neighbours too close for a distinct number are refused (no-room), never renumbered', () => {
    assert.deepEqual(mod.tl.midpointOrder([{ order: 100 }, { order: 100 }], 1), { ok: true, order: 100 });
    const tight = mod.tl.midpointOrder([{ order: 1 }, { order: 1.0000001 }], 1);
    assert.equal(tight.ok, false);
    assert.equal(tight.reason, 'no-room');
  });

  test('dropping where it already is changes nothing (null); an unknown id is null; an index out of range is clamped', () => {
    assert.equal(mod.tl.reorderTo(sorted(), idOf(sets.so, 'the-flood'), 1), null);
    assert.equal(mod.tl.reorderTo(sorted(), 'event_nope', 1), null);
    assert.deepEqual(mod.tl.reorderTo(sorted(), idOf(sets.so, 'the-first-grafting'), 99), { ok: true, order: 310 });
    assert.deepEqual(mod.tl.reorderTo(sorted(), idOf(sets.so, 'the-wall-falls'), -5), { ok: true, order: 0 });
  });

  test('Alt+Up / Alt+Down move one place: Up on the key event goes above the flood (55); nothing happens at the ends', () => {
    const s = sorted();
    assert.deepEqual(mod.tl.reorderByStep(s, idOf(sets.so, 'the-key-found-twice'), -1), { ok: true, order: 55 });
    assert.deepEqual(mod.tl.reorderByStep(s, idOf(sets.so, 'the-flood'), 1), { ok: true, order: 175 });
    assert.equal(mod.tl.reorderByStep(s, idOf(sets.so, 'the-first-grafting'), -1), null);
    assert.equal(mod.tl.reorderByStep(s, idOf(sets.so, 'the-wall-falls'), 1), null);
    assert.equal(mod.tl.reorderByStep(s, 'event_nope', 1), null);
  });

  test('default order of a new event: last + 10 (10 for the first), or between the selected event and the next', () => {
    const s = sorted();
    assert.equal(mod.tl.defaultOrder([]), 10);
    assert.equal(mod.tl.defaultOrder(s), 310);
    assert.equal(mod.tl.defaultOrder(s, idOf(sets.so, 'the-flood')), 125);
    assert.equal(mod.tl.defaultOrder(s, idOf(sets.so, 'the-wall-falls')), 310);
    assert.equal(mod.tl.defaultOrder(s, 'event_nope'), 310);
  });

  test('labels: order, when and date', () => {
    assert.equal(mod.tl.orderLabel(125.5), '125.5');
    assert.equal(mod.tl.orderLabel(null), 'no order');
    assert.equal(mod.tl.whenLabel({ when: 'Spring, year 0', date: '1998-04' }), 'Spring, year 0 · 1998-04');
    assert.equal(mod.tl.whenLabel({ when: '', date: '1998' }), '1998');
    assert.equal(mod.tl.whenLabel({ when: null, date: '' }), '');
  });

  test('URLs: timelineHref / parseTimelineSearch round-trip; unknown order falls back to story', () => {
    assert.equal(mod.tl.timelineHref('book_1'), '/books/book_1/timeline');
    assert.equal(mod.tl.timelineHref('book_1', { event: 'event_1', order: 'book' }), '/books/book_1/timeline?event=event_1&order=book');
    assert.deepEqual(mod.tl.parseTimelineSearch('?event=event_1&order=book'), { event: 'event_1', order: 'book' });
    assert.deepEqual(mod.tl.parseTimelineSearch('?order=sideways'), { event: null, order: 'story' });
  });

  test('eventsForScene: from both sides, in story time (the one-sided return event shows on its scene)', () => {
    assert.deepEqual(mod.tl.eventsForScene(sets.so.timeline, PROLOGUE).map((e) => e.slug), ['the-flood']);
    assert.deepEqual(mod.tl.eventsForScene(sets.so.timeline, ARRIVAL).map((e) => e.slug), ['the-return']);
    assert.deepEqual(mod.tl.eventsForScene(sets.so.timeline, 'scene_nope'), []);
    assert.deepEqual(mod.tl.eventsForScene(null, ARRIVAL), []);
  });
});

// ================================================================================================ render: Timeline

describe('acceptance 7: Timeline page', () => {
  test('story time: toggle, cards in order inside their `when` groups, header count', () => {
    const html = renderTl(sets.so);
    assert.match(html, /<h1>Timeline<\/h1>/);
    assert.ok(textOf(html).includes('5 events'));
    const toggle = [...html.matchAll(/<button[^>]*class="chip"[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => [textOf(m[2]), m[1]]);
    assert.deepEqual(toggle, [['Story time', 'true'], ['Book order', 'false']]);
    assert.deepEqual(headings(html), ['Autumn, year -30', 'Spring, year 0', 'Spring, year 30', 'Summer, year 30']);
    assert.deepEqual(cardIds(html).map((id) => sets.so.timeline.events.find((e) => e.id === id).slug), sets.so.oracle.chrono);
  });

  test('book order: "In the book" in narrative order, then "Not in the book yet"; the toggle follows', () => {
    const html = renderTl(sets.so, { order: 'book' });
    assert.deepEqual(headings(html), ['In the book', 'Not in the book yet']);
    assert.deepEqual(slugsOf(sets.so, cardIds(html)), [...sets.so.oracle.book, ...sets.so.oracle.unplaced]);
    assert.ok(/aria-pressed="true"[^>]*>\s*Book order/.test(html));
    assert.ok(!/draggable="true"/.test(html), 'no dragging in book order');
  });

  test('event card: title, when, order value, scenes as manuscript links with their chapter, no participants block when there are none', () => {
    const html = renderTl(sets.so);
    const card = cardOf(html, idOf(sets.so, 'the-flood'));
    const t = textOf(card);
    assert.ok(t.includes('The spring flood') && t.includes('Spring, year 0') && t.includes('100'), t);
    const links = anchors(card);
    assert.deepEqual(links.map((a) => a.href), [`/books/${SO}?scene=${PROLOGUE}`]);
    assert.ok(links[0].text.includes('Before the Tide'));
    assert.match(card, /aria-label="The spring flood, Spring, year 0"/);
    assert.ok(!/Who|Where/.test(t), 'no empty Who / Where');
  });

  test('event card: participants and places by name, and the date next to when', () => {
    const rich = sets.rich;
    const html = renderTl(rich);
    const wall = textOf(cardOf(html, idOf(rich, 'the-wall-falls')));
    assert.ok(/Who\s*Maren Hollis, Pell/.test(wall), wall);
    assert.ok(/Where\s*The Salt Orchard/.test(wall), wall);
  });

  test('told early / told late badges are on exactly the cards the logic flags, with an explanatory title (information only)', () => {
    const html = renderTl(sets.so);
    for (const slug of ['the-flood', 'the-return']) assert.match(cardOf(html, idOf(sets.so, slug)), /told early/);
    assert.match(cardOf(html, idOf(sets.so, 'the-first-grafting')), /told late/);
    for (const slug of ['the-wall-falls', 'the-key-found-twice']) assert.ok(!/told (early|late)/.test(cardOf(html, idOf(sets.so, slug))), slug);
    assert.equal(cardIds(html).filter((id) => /told early/.test(cardOf(html, id))).length, 2, 'two cards are told early');
    assert.ok(/Information only/.test(decode(html)));
  });

  test('an event not in the book says so on its card', () => {
    const html = renderTl(sets.so);
    assert.ok(textOf(cardOf(html, idOf(sets.so, 'the-key-found-twice'))).includes('Not in the book yet'));
  });

  test('story vs. book chart: one dot per placed event with an accessible label, axes labelled, "Show as table" button', () => {
    const html = renderTl(sets.so);
    assert.match(html, /<svg[^>]*class="tl-svg"/);
    const dots = [...html.matchAll(/<(?:g|a)\b[^>]*class="tl-dot"[^>]*aria-label="([^"]*)"/g)].map((m) => decode(m[1]));
    assert.equal(dots.length, 4, 'flood, return, first grafting, wall');
    assert.ok(dots.every((d) => /book position \d+, story rank \d+/.test(d)));
    assert.deepEqual(dots.map((d) => d.split(':')[0]).sort(), ['Maren returns', 'The first grafting', 'The spring flood', 'The wall falls']);
    assert.ok(textOf(html).includes('Show as table'));
    assert.ok(/aria-label="Story time against book order"/.test(html));
    // the dots sit where the data says: x = narrative position, y = chronological rank
    const m = model(sets.so);
    const flood = m.points.find((p) => p.title === 'The spring flood');
    const first = m.events.find((e) => e.slug === 'the-first-grafting');
    assert.equal(flood.x, sets.so.timeline.scenes.find((s) => s.id === PROLOGUE).position);
    assert.equal(flood.y, 2);
    assert.equal(m.points.find((p) => p.title === 'The first grafting').y, 1);
    assert.equal(m.points.find((p) => p.title === 'The wall falls').y, 5);
    assert.ok(first.position > flood.x, 'the first grafting is told after the flood although it happens before');
  });

  test('chart table fallback: same facts as a table (no svg), one row per placed event in book order with the told flag', () => {
    const html = renderTl(sets.so, { table: true });
    assert.ok(!/<svg[^>]*class="tl-svg"/.test(html));
    assert.ok(textOf(html).includes('Show as chart'));
    const table = /<table[^>]*class="tl-table"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    assert.ok(table, 'a table is drawn');
    assert.ok(/<caption/.test(table) && count(table, /<th scope="col"/g) === 5);
    const rows = [...table.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap((m) => [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => textOf(c[1]))));
    assert.deepEqual(rows.map((r) => [r[0], r[2], r[3], r[4]]), [
      ['The spring flood', '2', '100', 'early'],
      ['Maren returns', '4', '200', 'early'],
      ['The first grafting', '1', '10', 'late'],
      ['The wall falls', '5', '300', 'in order'],
    ]);
  });

  test('chart with nothing placed says so instead of drawing an empty plot', () => {
    const html = renderToStaticMarkup(h(mod.chart.TimelineChart, { model: mod.tl.buildTimeline({ events: [], entries: [], threads: [] }) }));
    assert.ok(textOf(html).includes('nothing to plot'));
    assert.ok(!/<svg/.test(html));
  });

  test('filter controls: character, location and thread selects with the names the events use, plus the two checkboxes', () => {
    const html = renderTl(sets.rich);
    const select = (label) => [...(new RegExp(`${label}\\s*<select[\\s\\S]*?</select>`).exec(html)?.[0] ?? '').matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => textOf(m[1]));
    assert.deepEqual(select('Character'), ['Anyone', 'Ilse Hollis', 'Maren Hollis', 'Pell']);
    assert.deepEqual(select('Location'), ['Anywhere', 'Port Aldine', 'The Salt Orchard']);
    assert.deepEqual(select('Thread'), ['Any thread', 'The brass key']);
    assert.ok(/Unplaced only/.test(html) && /Has problems/.test(html));
  });

  test('filters narrow the cards: character, location, thread, unplaced only, has problems; groups with no match disappear', () => {
    const rich = sets.rich;
    const cards = (filters, order = 'story') => slugsOf(rich, cardIds(renderTl(rich, { filters, order })));
    assert.deepEqual(cards({ character: 'maren-hollis' }), ['the-first-grafting', 'the-return', 'the-wall-falls']);
    assert.deepEqual(cards({ location: 'port-aldine' }), ['the-return']);
    assert.deepEqual(cards({ thread: 'brass-key' }), ['the-flood-twin', 'the-key-lands', 'the-wall-falls']);
    assert.deepEqual(cards({ unplacedOnly: true }), rich.oracle.unplaced);
    assert.deepEqual(cards({ hasProblems: true }), rich.oracle.unplaced);
    assert.deepEqual(cards({ character: 'maren-hollis' }, 'book'), ['the-return', 'the-first-grafting', 'the-wall-falls']);
    const only = renderTl(rich, { filters: { location: 'port-aldine' } });
    assert.deepEqual(headings(only), ['Spring, year 30']);
    const none = renderTl(rich, { filters: { character: 'tobin-reyes' } });
    assert.equal(cardIds(none).length, 0);
    assert.ok(textOf(none).includes('No event matches the filters'));
  });

  test('dragging: story time without filters makes cards draggable with drop zones; filters turn it off with an explanation', () => {
    const on = renderTl(sets.so, { handlers: { onReorder: noop, onMoveStep: noop } });
    assert.equal(count(on, /<article[^>]*draggable="true"/g), 5);
    assert.ok(count(on, /class="tl-drop"/g) >= 5);
    assert.ok(/Alt\+Up or Alt\+Down/.test(decode(on)), 'keyboard equivalent is explained');
    const off = renderTl(sets.so, { handlers: { onReorder: noop, onMoveStep: noop }, filters: { character: 'maren-hollis' } });
    assert.equal(count(off, /draggable="true"/g), 0);
    assert.ok(textOf(off).includes('Filters are on, so the order cannot be changed here'));
    const readOnly = renderTl(sets.so);
    assert.equal(count(readOnly, /draggable="true"/g), 0, 'no handler, no dragging');
  });

  test('Problems panel: salt-orchard shows its one entry with an "Open the event" link; the bad copy lists every cause with codes', () => {
    const so = renderTl(sets.so);
    assert.ok(/class="tl-problems"/.test(so));
    const a = anchors(/<details class="tl-problems"[\s\S]*?<\/details>/.exec(so)[0]);
    assert.deepEqual(a.map((x) => [x.text, x.href]), [['Open the event', `/books/${SO}/timeline?event=${idOf(sets.so, 'the-key-found-twice')}`]]);
    const bad = renderTl(sets.bad);
    const panel = textOf(/<details class="tl-problems"[\s\S]*?<\/details>/.exec(bad)[0]);
    for (const needle of ['E102', 'E301', 'W303', 'Not placed', 'bad-date', 'broken-scene', 'archived-scene', 'no-order', 'Not in the book yet']) assert.ok(panel.includes(needle), needle);
    assert.match(/<details class="tl-problems"[^>]*>/.exec(bad)[0], /open/, 'opens by itself when there are real problems');
    assert.ok(!/<details class="tl-problems"[^>]*open/.test(so), 'an information-only list stays closed');
    const clean = sets.so.timeline.events.filter((e) => e.slug !== 'the-key-found-twice');
    const none = renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data: { ...sets.so.timeline, events: clean }, model: mod.tl.buildTimeline({ ...sets.so.timeline, events: clean }) }));
    assert.ok(!/tl-problems/.test(none), 'no panel when nothing is wrong');
  });

  test('no events: an empty state that says how to start; "New event" only when the page can create', () => {
    const empty = { events: [], archived: [], scenes: [], entries: [], threads: [], unreadable: [] };
    const html = renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data: empty, model: mod.tl.buildTimeline(empty) }));
    assert.ok(textOf(html).includes('No events yet.'));
    const newButton = /<button[^>]*>New event<\/button>/;
    assert.ok(!newButton.test(html));
    assert.ok(newButton.test(renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data: empty, model: mod.tl.buildTimeline(empty), handlers: { onNew: noop } }))));
  });

  test('details column: selected event shows story-time order and rank, book position, scenes with side tags; a stale event offers no edit buttons', () => {
    const html = renderTl(sets.so, { selectedId: idOf(sets.so, 'the-return'), handlers: { onEdit: noop, onScenes: noop, onEditText: noop, onArchive: noop } });
    const aside = textOf(/<aside aria-label="Event details"[\s\S]*?<\/aside>/.exec(html)[0]);
    assert.ok(aside.includes('Maren returns') && /order 200, rank 4/.test(aside) && /scene 2/.test(aside), aside);
    assert.ok(aside.includes('one side'), 'only the scene names this event');
    for (const b of ['Edit fields', 'Scenes', 'Edit text', 'Archive']) assert.ok(aside.includes(b), b);
    const empty = textOf(/<aside aria-label="Event details"[\s\S]*?<\/aside>/.exec(renderTl(sets.so))[0]);
    assert.ok(empty.includes('Select an event'));
    const stale = { ...sets.so.timeline, events: sets.so.timeline.events.map((e) => (e.slug === 'the-return' ? { ...e, stale: true, problems: [{ code: 'E100', severity: 'error', location: '', message: 'x' }] } : e)) };
    const staleHtml = renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data: stale, model: mod.tl.buildTimeline(stale), selectedId: idOf(sets.so, 'the-return'), handlers: { onEdit: noop } }));
    assert.ok(!/Edit fields/.test(staleHtml));
    assert.ok(/last valid version/.test(staleHtml));
  });

  test('archived events are listed with Restore only when the page can restore', () => {
    const data = { ...sets.so.timeline, archived: [{ id: 'event_a', slug: 'old', title: 'Old event', path: 'archive/planning/timeline/old.md' }] };
    const html = renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data, model: mod.tl.buildTimeline(data), archived: data.archived, handlers: { onRestore: noop } }));
    assert.ok(textOf(html).includes('Archived events (1)') && textOf(html).includes('Old event') && textOf(html).includes('Restore'));
    assert.ok(!/Restore…/.test(renderToStaticMarkup(h(mod.tlPage.TimelinePage, { bookId: SO, data, model: mod.tl.buildTimeline(data), archived: data.archived }))));
  });

  test('editor rail "Events": the scene\'s events with links to the timeline; empty and loading states', () => {
    const events = mod.tl.eventsForScene(sets.so.timeline, PROLOGUE);
    const html = renderToStaticMarkup(h(mod.railEvents.RailEvents, { bookId: SO, events }));
    assert.ok(textOf(html).includes('Events') && textOf(html).includes('The spring flood'));
    assert.deepEqual(anchors(html).map((a) => a.href), [`/books/${SO}/timeline?event=${idOf(sets.so, 'the-flood')}`, `/books/${SO}/timeline`]);
    assert.ok(textOf(renderToStaticMarkup(h(mod.railEvents.RailEvents, { bookId: SO, events: [] }))).includes('No event is linked to this scene'));
    assert.ok(textOf(renderToStaticMarkup(h(mod.railEvents.RailEvents, { bookId: SO, events: null }))).includes('Loading'));
  });
});

// ================================================================================================ pure logic: notes

describe('acceptance 7 (pure): notes model', () => {
  test('sidebar counts: live notes per kind, archived separately, scene notes as given', () => {
    assert.deepEqual(mod.nt.sidebarCounts(sets.so.notes.notes, 1), { all: 3, research: 1, docs: 1, sources: 1, 'scene-notes': 1, archived: 0 });
    const withArchived = sets.so.notes.notes.map((n) => (n.kind === 'source' ? { ...n, archived: true } : n));
    assert.deepEqual(mod.nt.sidebarCounts(withArchived, 0), { all: 2, research: 1, docs: 1, sources: 0, 'scene-notes': 0, archived: 1 });
    assert.deepEqual(mod.nt.NOTE_SECTIONS.map((s) => s.label), ['All', 'Research', 'Planning docs', 'Sources', 'Scene notes']);
  });

  test('filterNotes: by section, tag, query over title / tags / author / linked names, and by text hits', () => {
    const notes = sets.so.notes.notes;
    const ids = (f) => mod.nt.filterNotes(notes, f).map((n) => n.id);
    assert.deepEqual(ids({}), [PLAN, TIDES, TABLES]);
    assert.deepEqual(ids({ section: 'research' }), [TIDES]);
    assert.deepEqual(ids({ section: 'docs' }), [PLAN]);
    assert.deepEqual(ids({ section: 'sources' }), [TABLES]);
    assert.deepEqual(ids({ section: 'research', tag: 'tides' }), [TIDES]);
    assert.deepEqual(ids({ section: 'research', tag: 'nope' }), []);
    assert.deepEqual(ids({ query: 'TIDAL' }), [TIDES], 'case-insensitive title');
    assert.deepEqual(ids({ query: 'setting' }), [TIDES], 'tag');
    assert.deepEqual(ids({ query: 'harbour office' }), [TABLES], 'source author');
    assert.deepEqual(ids({ query: 'salt orchard' }), [TIDES], 'linked entry name');
    assert.deepEqual(ids({ query: 'tidäl' }), [TIDES], 'accents folded');
    assert.deepEqual(ids({ query: 'zzz' }), []);
    assert.deepEqual(ids({ query: 'zzz', textIds: new Set([PLAN]) }), [PLAN], 'a body hit from full-text search is included');
    assert.deepEqual(ids({ section: 'archived' }), []);
    const archived = notes.map((n) => (n.id === PLAN ? { ...n, archived: true } : n));
    assert.deepEqual(mod.nt.filterNotes(archived, { section: 'archived' }).map((n) => n.id), [PLAN]);
    assert.deepEqual(mod.nt.filterNotes(archived, {}).map((n) => n.id), [TIDES, TABLES], 'archived notes are not in All');
  });

  test('associations: notes linking an entry (Codex inspector) and notes linking any entry or thread of a scene (editor rail)', () => {
    const notes = sets.so.notes.notes;
    const salt = sets.so.entries.find((e) => e.slug === 'salt-orchard');
    const maren = sets.so.entries.find((e) => e.slug === 'maren-hollis');
    assert.deepEqual(mod.nt.researchForEntry(notes, salt).map((n) => n.id), [TIDES]);
    assert.deepEqual(mod.nt.researchForEntry(notes, maren), []);
    assert.deepEqual(mod.nt.researchForEntry(null, maren), []);
    assert.deepEqual(mod.nt.researchForEntry(notes.map((n) => ({ ...n, archived: true })), salt), [], 'archived notes are not shown');
    const items = [{ id: salt.id, name: 'The Salt Orchard' }, { id: maren.id, name: 'Maren Hollis' }, { id: null, name: 'unknown' }];
    const found = mod.nt.researchForScene(notes, items);
    assert.deepEqual(found.map((n) => [n.id, n.via]), [[TIDES, ['The Salt Orchard']]]);
    assert.deepEqual(mod.nt.researchForScene(notes, [{ id: maren.id, name: 'Maren Hollis' }]), []);
    assert.deepEqual(mod.nt.researchForScene(null, items), []);
    const broken = [{ ...notes.find((n) => n.id === TIDES), links: [{ ref: 'x', id: null, kind: null, state: 'broken' }] }];
    assert.deepEqual(mod.nt.researchForScene(broken, [{ id: null, name: 'x' }]), [], 'a broken link matches nothing');
  });

  test('the editor rail pulls the same through the scene links of objects (characters, locations, threads and body [[links]])', () => {
    const objects = [...sets.so.timeline.entries.map((e) => ({ id: e.id, kind: 'entry', slug: e.slug, title: e.name, type: e.type })), ...sets.so.timeline.threads.map((t) => ({ id: t.id, kind: 'thread', slug: t.slug, title: t.title, type: null }))];
    // the Prologue scene: locations [salt-orchard]
    const items = [{ key: 'k', id: objects.find((o) => o.slug === 'salt-orchard').id, name: 'The Salt Orchard' }];
    assert.deepEqual(mod.nt.researchForScene(sets.so.notes.notes, items).map((n) => n.id), [TIDES]);
  });

  test('citationOf and scene-note grouping', () => {
    const src = sets.so.notes.notes.find((n) => n.id === TABLES);
    assert.equal(mod.nt.citationOf(src), 'Aldine Harbour Office, Tide Tables for the North Shore (1998)');
    assert.equal(mod.nt.citationOf({ title: 'Only a title', source: {} }), 'Only a title');
    const groups = mod.nt.groupSceneNotes(sets.so.sceneNotes);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].scenes.map((s) => [s.id, s.notes.map((n) => n.text)]), [[KEY, ['check the tide times against chapter 3']]]);
    assert.ok(groups[0].label.length > 0);
    assert.deepEqual(mod.nt.groupSceneNotes(null), []);
    const two = mod.nt.groupSceneNotes({ scenes: [{ id: 'a', title: 'A', act: 1, chapter: 1, notes: [{ text: 't', line: 1 }] }, { id: 'b', title: 'B', act: 1, chapter: 1, notes: [{ text: 'u', line: 2 }] }, { id: 'c', title: 'C', act: 1, chapter: 2, notes: [{ text: 'v', line: 3 }] }] });
    assert.deepEqual(two.map((g) => g.scenes.map((s) => s.id)), [['a', 'b'], ['c']], 'grouped by chapter, book order kept');
  });

  test('URLs and small helpers', () => {
    assert.equal(mod.nt.notesHref('book_1'), '/books/book_1/notes');
    assert.equal(mod.nt.notesHref('book_1', { section: 'research', tag: 'tides', note: 'note_1' }), '/books/book_1/notes?section=research&tag=tides&note=note_1');
    assert.deepEqual(mod.nt.parseNotesSearch('?section=sources&note=note_1'), { section: 'sources', tag: null, note: 'note_1' });
    assert.deepEqual(mod.nt.parseNotesSearch('?section=bogus'), { section: 'all', tag: null, note: null });
    assert.equal(mod.nt.sceneLineHref('book_1', 'scene_1', 18), '/books/book_1?scene=scene_1&line=18');
    assert.deepEqual(mod.nt.tagsOf(' a, b ,a,, c '), ['a', 'b', 'c']);
    assert.equal(mod.nt.updatedLabel(null), '');
    assert.equal(mod.nt.updatedLabel('not a date'), '');
  });
});

describe('acceptance 6/7 (pure): how note links are classified (render.js)', () => {
  const c = (raw, note = 'research/x.md') => mod.render.classifyHref(raw, note, 'book_1');

  test('http(s) links are external with the host (www. dropped); nothing else with a scheme is', () => {
    assert.deepEqual(c('https://www.example.com/a/b?q=1#f'), { kind: 'external', url: 'https://www.example.com/a/b?q=1#f', host: 'example.com' });
    assert.equal(c('http://example.com').kind, 'external');
    assert.equal(c('HTTPS://EXAMPLE.COM/X').host, 'example.com');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/x.pdf', 'ftp://example.com/x', 'mailto:a@example.com', 'vbscript:x', 'https://']) assert.equal(c(bad).kind, 'none', bad);
  });

  test('a relative path that lands under assets/ is an attachment served by the attachment route; the link is resolved from the note\'s own folder', () => {
    assert.deepEqual(c('../assets/research/map.pdf'), { kind: 'attachment', path: 'assets/research/map.pdf', url: '/api/books/book_1/attachments?path=assets%2Fresearch%2Fmap.pdf', image: false });
    assert.equal(c('../assets/research/map.png').image, true);
    assert.equal(c('../../assets/research/m.pdf', 'research/sources/s.md').path, 'assets/research/m.pdf');
    assert.equal(c('../assets/research/m.pdf', 'planning/plan.md').path, 'assets/research/m.pdf');
    assert.equal(c('assets/research/m.pdf', 'plan.md').path, 'assets/research/m.pdf', 'a note at the book root');
    assert.equal(c('<../assets/research/my map.pdf>').path, 'assets/research/my map.pdf');
    assert.equal(c('../assets/research/map.pdf "A title"').path, 'assets/research/map.pdf');
    assert.equal(c('../assets/research/my%20map.pdf').path, 'assets/research/my map.pdf');
    assert.equal(c('../assets/research/map.pdf#page=3').path, 'assets/research/map.pdf');
    assert.equal(c('../assets/./research/../research/map.pdf').path, 'assets/research/map.pdf');
  });

  test('everything else is plain text, never a link: absolute paths, escapes, outside assets/, other types, SVG, empty', () => {
    for (const bad of ['C:\\maps\\x.pdf', 'C:/maps/x.pdf', '/maps/x.pdf', '\\\\server\\x.pdf', '../../outside.pdf', '../../../assets/research/x.pdf', '%2e%2e/%2e%2e/etc/passwd', '../codex/characters/maren-hollis.md', 'assets/research/x.pdf', '../assets/research/x.svg', '../assets/research/x.html', '../assets/research/x.exe', '../assets/research/noext', '#anchor', '', '   ']) {
      assert.equal(c(bad).kind, 'none', JSON.stringify(bad));
    }
    assert.equal(c('../assets/research/x.pdf', 'x.md').kind, 'none', 'from a root-level note that climbs out of the book');
  });

  test('inlineParts: text, links, images and [@cite] split cleanly and join back to the original', () => {
    const src = 'See [the map](../assets/research/map.pdf) and ![chart](../assets/research/c.png), [site](https://example.com) [@admiralty-tables] end.';
    const parts = mod.render.inlineParts(src, 'research/x.md', 'book_1');
    assert.deepEqual(parts.map((p) => p.type), ['text', 'link', 'text', 'image', 'text', 'link', 'text', 'cite', 'text']);
    assert.equal(parts.map((p) => p.raw).join(''), src);
    assert.equal(parts[1].target.kind, 'attachment');
    assert.equal(parts[3].target.image, true);
    assert.equal(parts[5].target.kind, 'external');
    assert.equal(parts[7].key, 'admiralty-tables');
    assert.deepEqual(mod.render.inlineParts('', 'research/x.md', 'b'), []);
    assert.equal(mod.render.inlineParts('[a](b) [@x](y)', 'research/x.md', 'b').filter((p) => p.type === 'cite').length, 0, '[@x](y) is a link, not a citation');
  });
});

describe('acceptance 6 (pure): the upload helper (no network: fetch is stubbed)', () => {
  const file = (name, size, type = 'application/pdf') => ({ name, size, type });

  test('posts the raw file with the write guard and the note, returns the link to insert', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([url, init]); return { status: 201, json: async () => ({ ok: true, path: 'assets/research/m.pdf', markdown: '[m.pdf](../assets/research/m.pdf)' }) }; };
    const f = file('My Map.pdf', 10);
    const r = await mod.upload.uploadAttachment('book_1', f, 'note_1', fetchImpl);
    assert.deepEqual(r, { ok: true, path: 'assets/research/m.pdf', markdown: '[m.pdf](../assets/research/m.pdf)' });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, '/api/books/book_1/attachments?name=My%20Map.pdf&note=note_1');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-storyforge'], '1');
    assert.equal(init.headers['content-type'], 'application/pdf');
    assert.equal(init.body, f, 'the file itself is the body');
  });

  test('over 25 MB is refused without any request; a file without a type is sent as octet-stream; no note is simply left out', async () => {
    let n = 0;
    const fetchImpl = async (url, init) => { n++; assert.ok(!url.includes('note=')); assert.equal(init.headers['content-type'], 'application/octet-stream'); return { status: 201, json: async () => ({ path: 'p', markdown: 'm' }) }; };
    const big = await mod.upload.uploadAttachment('book_1', file('big.pdf', mod.upload.MAX_UPLOAD_BYTES + 1), null, fetchImpl);
    assert.equal(big.ok, false);
    assert.match(big.message, /25 MB/);
    assert.equal(n, 0, 'nothing was sent');
    assert.equal(mod.upload.MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
    assert.equal((await mod.upload.uploadAttachment('book_1', file('a.pdf', 1, ''), null, fetchImpl)).ok, true);
    assert.equal(n, 1);
  });

  test('failures never insert anything: 403, 413, 415, no answer, a malformed answer', async () => {
    const answer = (status, json) => async () => ({ status, json: async () => json });
    for (const [status, json, re] of [[403, { error: 'forbidden' }, /refused/], [413, { error: 'too_large' }, /25 MB/], [415, { code: 'UNSUPPORTED_TYPE', message: 'files of this type cannot be attached (allowed: png, pdf)' }, /cannot be attached/], [500, null, /not attached/]]) {
      const r = await mod.upload.uploadAttachment('book_1', file('a.pdf', 1), null, answer(status, json));
      assert.equal(r.ok, false, String(status));
      assert.match(r.message, re, String(status));
    }
    const down = await mod.upload.uploadAttachment('book_1', file('a.pdf', 1), null, async () => { throw new Error('offline'); });
    assert.equal(down.ok, false);
    assert.match(down.message, /could not be reached/);
    assert.equal((await mod.upload.uploadAttachment('book_1', file('a.pdf', 1), null, answer(201, { ok: true }))).ok, false, '201 without a link is not a success');
  });

  test('the file picker accepts exactly the server\'s allowlist', () => {
    assert.deepEqual(mod.upload.ACCEPT.split(',').sort(), ['.csv', '.gif', '.jpeg', '.jpg', '.md', '.pdf', '.png', '.txt', '.webp']);
  });
});

// ================================================================================================ render: Notes

describe('acceptance 7: Notes page', () => {
  test('sidebar: All, Research, Planning docs, Sources, Scene notes with counts, then the tags with counts; the current row is marked', () => {
    const html = renderNotes(sets.so);
    const aside = /<aside aria-label="Notes sections"[\s\S]*?<\/aside>/.exec(html)[0];
    const rows = anchors(aside).map((a) => [a.text, a.href, /aria-current="true"/.test(a.attrs)]);
    assert.deepEqual(rows.map((r) => r[0]), ['All 3', 'Research 1', 'Planning docs 1', 'Sources 1', 'Scene notes 1', 'setting 1', 'tides 1']);
    assert.deepEqual(rows.filter((r) => r[2]).map((r) => r[0]), ['All 3']);
    assert.equal(rows[1][1], `/books/${SO}/notes?section=research`);
    assert.equal(rows[5][1], `/books/${SO}/notes?section=research&tag=setting`);
    assert.ok(!/Archived/.test(aside), 'no Archived row when nothing is archived');
    const withArchived = { ...sets.so.notes, notes: sets.so.notes.notes.map((n) => (n.id === PLAN ? { ...n, archived: true } : n)) };
    assert.ok(textOf(/<aside aria-label="Notes sections"[\s\S]*?<\/aside>/.exec(renderToStaticMarkup(h(mod.ntPage.NotesPage, { bookId: SO, data: withArchived, sceneNotes: sets.so.sceneNotes })))[0]).includes('Archived 1'));
  });

  test('list: title, kind, tags, linked entries, updated date and excerpt for each note, in title order; header count', () => {
    const html = renderNotes(sets.so);
    assert.match(html, /<h1>All<\/h1>/);
    assert.ok(textOf(html).includes('3 notes'));
    const rows = [...html.matchAll(/<a\b[^>]*class="nt-card"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => textOf(m[1]));
    assert.equal(rows.length, 3);
    assert.ok(rows[0].includes('Book plan') && rows[0].includes('Planning doc'));
    assert.ok(rows[1].includes('Tidal ranges on the coast') && rows[1].includes('Research') && rows[1].includes('tides') && rows[1].includes('setting') && rows[1].includes('Salt Orchard') && rows[1].includes('Spring tides here reach four metres.'), rows[1]);
    assert.ok(rows[2].includes('Tide Tables for the North Shore') && rows[2].includes('Source'));
    assert.deepEqual(anchors(html).filter((a) => /nt-card/.test(a.attrs)).map((a) => a.href), [PLAN, TIDES, TABLES].map((id) => `/books/${SO}/notes?note=${id}`));
  });

  test('section, tag and search narrow the list; the title says which; an empty result explains', () => {
    const research = renderNotes(sets.so, { section: 'research' });
    assert.match(research, /<h1>Research<\/h1>/);
    assert.equal(count(research, /class="nt-card"/g), 1);
    const tag = renderNotes(sets.so, { section: 'research', tag: 'tides' });
    assert.match(tag, /<h1>Tag: tides<\/h1>/);
    assert.equal(count(tag, /class="nt-card"/g), 1);
    const search = renderNotes(sets.so, { query: 'harbour' });
    assert.equal(count(search, /class="nt-card"/g), 1);
    assert.ok(/value="harbour"/.test(search));
    const none = renderNotes(sets.so, { query: 'zzzz' });
    assert.ok(textOf(none).includes('No notes match.'));
    const empty = renderToStaticMarkup(h(mod.ntPage.NotesPage, { bookId: SO, data: { notes: [], tags: [] }, sceneNotes: { scenes: [] } }));
    assert.ok(textOf(empty).includes('Nothing here yet.') && textOf(empty).includes('No tags yet.'));
  });

  test('"New research note / planning doc / source" buttons only when the page can create', () => {
    assert.ok(!/New research note/.test(renderNotes(sets.so)));
    const t = textOf(renderNotes(sets.so, { handlers: { onNew: noop } }));
    for (const b of ['New research note', 'New planning doc', 'New source']) assert.ok(t.includes(b), b);
  });

  test('note view (research): tags, canon flag with its explanation, link chips to the Codex, source citations, the text, file and buttons', () => {
    const note = sets.so.full.find((n) => n.id === TIDES);
    const html = renderNotes(sets.so, { section: 'research', note, selectedId: TIDES, handlers: { onEditText: noop, onEdit: noop, onArchive: noop } });
    const view = /role="dialog"[\s\S]*$/.exec(html)[0];
    const t = textOf(view);
    assert.ok(t.includes('Tidal ranges on the coast') && t.includes('Tags') && t.includes('tides') && t.includes('setting'));
    assert.ok(t.includes('Not canon') && /not treat it as fact unless you mark it canon/.test(t), 'canon flag explained');
    const a = anchors(view);
    assert.ok(a.some((x) => x.text === 'The Salt Orchard' || x.text === 'Salt Orchard' ? x.href === `/books/${SO}/codex?entry=${sets.so.entries.find((e) => e.slug === 'salt-orchard').id}` : false), JSON.stringify(a));
    assert.ok(a.some((x) => x.text === '[@admiralty-tables]' && x.href === `/books/${SO}/notes?section=sources&note=${TABLES}`));
    assert.ok(t.includes('Tide Tables for the North Shore'));
    assert.ok(t.includes('Spring tides here reach four metres.') && t.includes('research/tidal-ranges.md'));
    for (const b of ['Edit text', 'Edit fields', 'Archive']) assert.ok(t.includes(b), b);
    const canon = textOf(renderNotes(sets.so, { note: { ...note, canon: true }, section: 'research' }));
    assert.ok(canon.includes('Canon') && /may treat what this note says as fact/.test(canon));
  });

  test('note view: external links open in a new tab with rel="noopener noreferrer", an icon and the host; attachment links open the attachment route', () => {
    const body = 'Read [the report](https://www.example.org/report.pdf), the [map](../assets/research/map.pdf) and <b>raw</b>.\n';
    const html = renderToStaticMarkup(h(mod.prose.NoteProse, { source: body, notePath: 'research/x.md', bookId: SO }));
    const ext = /<a[^>]*class="note-link note-external"[^>]*>[\s\S]*?<\/a>/.exec(html)[0];
    assert.match(ext, /href="https:\/\/www\.example\.org\/report\.pdf"/);
    assert.match(ext, /target="_blank"/);
    assert.match(ext, /rel="noopener noreferrer"/);
    assert.match(ext, /<svg/, 'external-link icon');
    assert.ok(textOf(ext).includes('example.org'), 'host shown');
    const att = /<a[^>]*class="note-link note-attachment"[^>]*>[\s\S]*?<\/a>/.exec(html)[0];
    assert.ok(decode(att).includes(`href="/api/books/${SO}/attachments?path=assets%2Fresearch%2Fmap.pdf"`), att);
    assert.ok(!/<b>raw<\/b>/.test(html), 'raw HTML is escaped, never rendered');
  });

  test('note view: images from assets/ are shown through the attachment route; an unsafe link or image is plain text, never an anchor / img', () => {
    const body = ['![diagram](../assets/research/d.png)', '[bad](javascript:alert(1))', '[abs](C:\\maps\\x.pdf)', '[root](/etc/passwd)', '[up](../../outside.pdf)', '![svg](../assets/research/x.svg)', '![remote](https://example.com/x.png)', '[ftp](ftp://example.com/x)'].join('\n\n');
    const html = renderToStaticMarkup(h(mod.prose.NoteProse, { source: body, notePath: 'research/x.md', bookId: SO }));
    assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => decode(m[1])), [`/api/books/${SO}/attachments?path=assets%2Fresearch%2Fd.png`], 'one image, from the attachment route; the remote image is not loaded');
    assert.equal(count(html, /<a\b/g), 0, 'no anchors at all');
    for (const label of ['bad', 'abs', 'root', 'up', 'svg', 'remote', 'ftp']) assert.ok(textOf(html).includes(label), `${label} kept as text`);
    assert.equal(count(html, /href="javascript/gi), 0);
  });

  test('note view: [@cite] shows as a citation with the source title; an unknown key is marked missing; author notes stay visible, [[links]] show their label', () => {
    const sources = new Map([['admiralty-tables', 'Aldine Harbour Office, Tide Tables for the North Shore (1998)']]);
    const html = renderToStaticMarkup(h(mod.prose.NoteProse, { source: 'Tides [@admiralty-tables] and [@nobody] <!-- note: check -->, see [[maren-hollis|Maren]].\n', notePath: 'research/x.md', bookId: SO, sources }));
    assert.ok(decode(html).includes('title="Aldine Harbour Office, Tide Tables for the North Shore (1998)"'));
    assert.ok(textOf(html).includes('[@nobody]'));
    assert.equal(count(html, /data-missing="true"/g), 1);
    assert.ok(textOf(html).includes('note: check'));
    assert.ok(textOf(html).includes('Maren') && !textOf(html).includes('[[maren-hollis'));
  });

  test('note view (source): cite-as, author, year, type, URL as an external link; (doc): locked state; archived and stale banners; Restore instead of Archive', () => {
    const src = sets.so.full.find((n) => n.id === TABLES);
    const html = renderNotes(sets.so, { section: 'sources', note: { ...src, source: { ...src.source, url: 'https://example.com/tables' } }, selectedId: TABLES });
    const t = textOf(/role="dialog"[\s\S]*$/.exec(html)[0]);
    assert.ok(t.includes('Cite as [@admiralty-tables]') && t.includes('Aldine Harbour Office') && t.includes('1998') && t.includes('report'), t);
    assert.ok(t.includes('Nothing written yet.'), 'a source with no text');
    assert.match(html, /href="https:\/\/example\.com\/tables"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*href="https:\/\/example\.com\/tables"/);
    const doc = textOf(/role="dialog"[\s\S]*$/.exec(renderNotes(sets.so, { note: sets.so.full.find((n) => n.id === PLAN) }))[0]);
    assert.ok(doc.includes('Planning doc') && /Locked\s*No/.test(doc));
    const locked = textOf(/role="dialog"[\s\S]*$/.exec(renderNotes(sets.so, { note: { ...sets.so.full.find((n) => n.id === PLAN), locked: true } }))[0]);
    assert.ok(/Locked\s*Yes/.test(locked));
    const arch = textOf(/role="dialog"[\s\S]*$/.exec(renderNotes(sets.so, { note: { ...src, archived: true }, handlers: { onRestore: noop, onArchive: noop, onEdit: noop, onEditText: noop } }))[0]);
    assert.ok(arch.includes('Archived.') && arch.includes('Restore') && !arch.includes('Archive…') && !arch.includes('Edit fields'));
    const stale = textOf(/role="dialog"[\s\S]*$/.exec(renderNotes(sets.so, { note: { ...src, stale: true }, handlers: { onEdit: noop } }))[0]);
    assert.ok(stale.includes('cannot be read right now') && !stale.includes('Edit fields'));
    assert.ok(!/role="dialog"/.test(renderNotes(sets.so)), 'no dialog when no note is selected');
    const open = renderNotes(sets.so, { section: 'research', note: sets.so.full.find((n) => n.id === TIDES), selectedId: TIDES });
    assert.match(open, /role="dialog"[^>]*aria-label="Tidal ranges on the coast"|aria-label="Tidal ranges on the coast"[^>]*role="dialog"/);
    assert.match(open, /<button[^>]*aria-label="Close note"/);
  });

  test('a link that resolves to nothing is marked "not found", not hidden; an archived target is tagged', () => {
    const note = { ...sets.so.full.find((n) => n.id === TIDES), links: [{ ref: 'nobody', id: null, kind: null, slug: null, name: null, state: 'broken' }, { ref: 'pell', id: 'entry_01S5000000000000000000000K', kind: 'entry', slug: 'pell', name: 'Pell', state: 'archived' }], sources: [{ cite_key: 'gone', id: null, title: null, state: 'broken' }] };
    const t = textOf(/role="dialog"[\s\S]*$/.exec(renderNotes(sets.so, { note }))[0]);
    assert.ok(t.includes('nobody (not found)') && t.includes('[@gone] (not found)') && /Pell\s*archived/.test(t), t);
  });

  test('scene notes: grouped by chapter and scene, every note links to its line in the manuscript; the empty state explains the syntax', () => {
    const html = renderNotes(sets.so, { section: 'scene-notes' });
    assert.match(html, /<h1>Scene notes<\/h1>/);
    const links = anchors(/<div class="note-scenes"[\s\S]*?<\/div>\s*<\/section>/.exec(html)?.[0] ?? html).filter((a) => /note-jump/.test(a.attrs));
    assert.deepEqual(links.map((a) => a.href), [`/books/${SO}?scene=${KEY}&line=${sets.so.sceneNotes.scenes[0].notes[0].line}`]);
    assert.ok(links[0].text.includes('check the tide times against chapter 3') && /Line \d+/.test(links[0].text));
    assert.ok(textOf(html).includes('The Key'));
    assert.ok(!/nt-card/.test(html), 'no note list in this section');
    const none = renderNotes({ ...sets.so, sceneNotes: { scenes: [] } }, { section: 'scene-notes' });
    assert.ok(textOf(none).includes('No scene notes.') && /note: like this/.test(decode(none)));
  });
});

// ================================================================================================ render: associations, Places

describe('acceptance 7: Research sections and the Places tab', () => {
  const saltEntry = () => sets.so.entries.find((e) => e.slug === 'salt-orchard');
  const renderPage = (props = {}) => renderToStaticMarkup(h(mod.codexPage.CodexPage, { bookId: SO, types: sets.so.types, entries: sets.so.entries, chapters: sets.so.chapters, typeKey: 'all', ...props }));

  test('Codex inspector: a "Research" section lists the notes whose links name the entry, each linking to the note', () => {
    const research = mod.nt.researchForEntry(sets.so.notes.notes, saltEntry());
    const html = renderToStaticMarkup(h(mod.inspector.EntryInspector, { bookId: SO, entry: saltEntry(), chapters: sets.so.chapters, types: sets.so.types, research }));
    assert.match(html, /<h[23][^>]*>Research<\/h[23]>/);
    assert.deepEqual(anchors(html).filter((a) => a.href?.includes('/notes')).map((a) => [a.text, a.href]), [['Tidal ranges on the coast', `/books/${SO}/notes?section=research&note=${TIDES}`]]);
  });

  test('Codex inspector: an entry no note links says so; without notes data the section is not drawn; an archived entry has none', () => {
    const maren = sets.so.entries.find((e) => e.slug === 'maren-hollis');
    const empty = renderToStaticMarkup(h(mod.inspector.EntryInspector, { bookId: SO, entry: maren, research: [] }));
    assert.ok(textOf(empty).includes('No research notes link to this entry.'));
    const none = renderToStaticMarkup(h(mod.inspector.EntryInspector, { bookId: SO, entry: maren }));
    assert.ok(!/>Research</.test(none));
    const archived = renderToStaticMarkup(h(mod.inspector.EntryInspector, { bookId: SO, entry: { ...maren, archived: true }, research: [] }));
    assert.ok(!/>Research</.test(archived));
  });

  test('Codex page: with the notes given, selecting Salt Orchard shows its note, selecting Maren shows the empty message', () => {
    const withSalt = renderPage({ notes: sets.so.notes.notes, selectedId: saltEntry().id, onSelect: noop });
    assert.ok(/<h[23][^>]*>Research<\/h[23]>/.test(withSalt) && textOf(withSalt).includes('Tidal ranges on the coast'));
    const maren = sets.so.entries.find((e) => e.slug === 'maren-hollis');
    const withMaren = renderPage({ notes: sets.so.notes.notes, selectedId: maren.id, onSelect: noop });
    assert.ok(textOf(withMaren).includes('No research notes link to this entry.'));
    assert.ok(!/>Research</.test(renderPage({ selectedId: maren.id, onSelect: noop })), 'no notes data yet: no section');
  });

  test('editor rail "Research": notes that link an entry or thread of the scene, with what matched; empty and loading states', () => {
    const notes = [{ ...sets.so.notes.notes.find((n) => n.id === TIDES), via: ['The Salt Orchard'] }];
    const html = renderToStaticMarkup(h(mod.railResearch.RailResearch, { bookId: SO, notes }));
    assert.ok(textOf(html).includes('Research') && textOf(html).includes('Tidal ranges on the coast') && textOf(html).includes('The Salt Orchard'));
    assert.deepEqual(anchors(html).map((a) => a.href), [`/books/${SO}/notes?section=research&note=${TIDES}`]);
    assert.ok(textOf(renderToStaticMarkup(h(mod.railResearch.RailResearch, { bookId: SO, notes: [] }))).includes('No research notes link anything in this scene.'));
    assert.ok(textOf(renderToStaticMarkup(h(mod.railResearch.RailResearch, { bookId: SO, notes: null }))).includes('Loading'));
  });

  test('the composed editor rail shows Events and Research for the open scene; left out entirely when the data is not offered', () => {
    const objects = [...sets.so.timeline.entries.map((e) => ({ id: e.id, kind: 'entry', slug: e.slug, title: e.name, type: e.type })), ...sets.so.timeline.threads.map((t) => ({ id: t.id, kind: 'thread', slug: t.slug, title: t.title, type: null }))];
    const scene = { id: PROLOGUE, title: 'Before the Tide', path: 'manuscript/act-01-low-water/ch-000-prologue/0010-before-the-tide.md', pov: 'ilse-hollis', front_matter: { pov: 'ilse-hollis', characters: ['ilse-hollis'], locations: ['salt-orchard'], plot_threads: ['brass-key'], events: ['the-flood'] }, body: 'Text.\n', sha256: 'abc' };
    const base = { book: { id: SO, slug: 'salt-orchard', title: 'The Salt Orchard', path: '' }, scene, diagnostics: { items: [], error: null, loading: false }, objects };
    const withBoth = decode(renderToStaticMarkup(h(mod.shell.SceneInspector, { ...base, timeline: sets.so.timeline, notes: sets.so.notes })));
    assert.ok(/<h2[^>]*>Events<\/h2>/.test(withBoth) && withBoth.includes('The spring flood'));
    assert.ok(/<h2[^>]*>Research<\/h2>/.test(withBoth) && withBoth.includes('Tidal ranges on the coast'));
    const loading = renderToStaticMarkup(h(mod.shell.SceneInspector, { ...base, timeline: null, notes: null }));
    assert.equal(count(loading, /Loading…/g) >= 2, true);
    const without = renderToStaticMarkup(h(mod.shell.SceneInspector, base));
    assert.ok(!/<h2[^>]*>Events<\/h2>/.test(without) && !/<h2[^>]*>Research<\/h2>/.test(without));
  });

  test('Places tab: the Codex locked to locations: titled Places, only the Locations row, only location cards, a way back to the whole Codex, no "New type"', () => {
    const html = renderPage({ typeKey: 'location', lockedType: 'location', onNewType: noop, onNewEntry: noop });
    assert.match(html, /<h1>Places<\/h1>/);
    const bar = /<div[^>]*class="codex-tabbar"[\s\S]*?<div[^>]*role="tabpanel"/.exec(html)[0];
    const tablist = /<div[^>]*role="tablist"[^>]*aria-label="Codex sections"[\s\S]*?<\/div>/.exec(bar)[0];
    const rows = [...tablist.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1]));
    assert.deepEqual(rows.filter((r) => /\d+$/.test(r)), ['Locations 2']);
    assert.ok(anchors(bar).some((a) => a.href === `/books/${SO}/codex` && a.text.includes('The whole Codex')));
    assert.ok(!/New type/.test(html));
    const cards = [...html.matchAll(/data-entry-id="([^"]+)"/g)].map((m) => m[1]);
    const locations = sets.so.entries.filter((e) => e.type === 'location').map((e) => e.id).sort();
    assert.deepEqual([...new Set(cards)].sort(), locations);
    for (const id of cards) assert.ok(locations.includes(id));
    const plain = renderPage({ typeKey: 'all' });
    assert.ok(!/<h1>Places<\/h1>/.test(plain), 'the ordinary Codex is unchanged');
  });

  test('routes: Timeline, Places and Notes are real project tabs in order; /books/:id/places|timeline|notes parse as tabs; places URLs round-trip', () => {
    assert.deepEqual(mod.routes.PROJECT_TABS.map((t) => t.key), ['manuscript', 'plan', 'codex', 'timeline', 'continuity', 'places', 'notes']);
    for (const tab of ['timeline', 'places', 'notes']) assert.deepEqual(mod.routes.parseRoute(`/books/${SO}/${tab}`), { name: 'tab', bookId: SO, tab });
    assert.equal(mod.routes.tabHref(SO, 'places'), `/books/${SO}/places`);
    assert.equal(mod.codex.placesHref(SO), `/books/${SO}/places`);
    assert.equal(mod.codex.placesHref(SO, { entry: 'entry_1' }), `/books/${SO}/places?entry=entry_1`);
  });
});
