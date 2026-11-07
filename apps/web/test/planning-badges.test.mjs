// Story Planner badges on the Board, Outline and Matrix: pure helpers (badges.js, outlineRows filters) and render tests with a small hand-made book.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const BOOK = 'book_01TEST0000000000000000000A';

let vite;
let model;
let badges;
let views = {};

const scene = (id, chapter, extra = {}) => ({ id, title: `Scene ${id}`, status: 'draft', pov: 'Maren', word_count: 100, path: `manuscript/${id}.md`, chapter, ...extra });
const book = {
  id: BOOK,
  acts: [
    {
      act: 1,
      label: 'Act 1',
      chapters: [
        { chapter: 1, label: 'Chapter 1', scenes: [scene('a', 1), scene('b', 1)] },
        { chapter: 2, label: 'Chapter 2', scenes: [scene('c', 2), scene('d', 2, { pov: 'Joss' })] },
      ],
    },
  ],
};
const planning = {
  threads: [],
  scenes: [
    { id: 'a', summary: 'Maren arrives.', plot_threads: [] },
    { id: 'b', summary: '', plot_threads: [] },
    { id: 'c', summary: 'The storm.', plot_threads: [] },
    { id: 'd', summary: 'Joss leaves.', plot_threads: [] },
  ],
};
const beat = (structure_slug, structure_name, primary, id, name) => ({ structure_slug, structure_name, primary, beat_id: id, beat_name: name });
const PROJECTION = {
  scenes: {
    a: { plan: true, goal: 'Reach the island', purpose: 'Setup', links_in: 0, links_out: 2, beats: [beat('three-act', 'Three act', true, 'opening', 'Opening')], milestones: [{ arc_slug: 'maren', name: 'Maren' }], relationships: [] },
    b: { plan: false, goal: null, purpose: null, links_in: 2, links_out: 1, beats: [], milestones: [], relationships: [] },
    c: {
      plan: true,
      goal: 'Survive',
      purpose: null,
      links_in: 1,
      links_out: 0,
      beats: [beat('three-act', 'Three act', true, 'midpoint', 'Midpoint'), beat('three-act', 'Three act', true, 'opening', 'Opening'), beat('save-the-cat', 'Save the cat', false, 'fun', 'Fun and games')],
      milestones: [],
      relationships: [],
    },
  },
  arcs: [
    { slug: 'maren', name: 'Maren' },
    { slug: 'joss', name: 'Joss' },
  ],
  structures: [
    {
      slug: 'three-act',
      name: 'Three act',
      primary: true,
      beats: [
        { id: 'opening', name: 'Opening', state: 'ok', scenes: ['a', 'c'] },
        { id: 'midpoint', name: 'Midpoint', state: 'ok', scenes: ['c'] },
        { id: 'climax', name: 'Climax', state: 'empty', scenes: [] },
      ],
    },
    { slug: 'save-the-cat', name: 'Save the cat', primary: false, beats: [{ id: 'fun', name: 'Fun and games', state: 'ok', scenes: ['c'] }] },
  ],
};

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  model = await vite.ssrLoadModule('/src/planning/model.js');
  badges = await vite.ssrLoadModule('/src/planning/badges.js');
  views = {
    ...(await vite.ssrLoadModule('/src/planning/BoardView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/OutlineView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/MatrixView.jsx')),
  };
});
after(async () => {
  await vite?.close();
});

const m = () => model.buildModel(book, planning);
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => decode(renderToStaticMarkup(el));
const ids = (rows) => rows.flatMap((g) => g.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v), data };
};

describe('badgesFor', () => {
  test('null without a projection, an empty entry for an unknown scene, the entry otherwise', () => {
    assert.equal(badges.badgesFor(null, 'a'), null);
    assert.equal(badges.badgesFor({ nope: 1 }, 'a'), null);
    const empty = badges.badgesFor(PROJECTION, 'zzz');
    assert.deepEqual([empty.plan, empty.goal, empty.links_in, empty.beats, empty.milestones], [false, null, 0, [], []]);
    assert.equal(badges.badgesFor(PROJECTION, 'a').goal, 'Reach the island');
  });
  test('chips follow the card face', () => {
    const card = m().sceneById.get('b');
    const all = badges.badgeChips(PROJECTION, card, { purpose: true, links: true, beats: true, milestones: true, missing: true });
    assert.deepEqual(all.map((c) => c.text), ['← 2 → 1', 'No summary', 'No goal']);
    assert.ok(all.every((c) => c.label.length > 0));
    const a = badges.badgeChips(PROJECTION, m().sceneById.get('a'), { ...badges.cardFaceDefaults(), purpose: true });
    assert.deepEqual(a.map((c) => c.text), ['Purpose: Setup', '← 0 → 2', 'Beat: Opening', 'Arc: Maren']);
    assert.deepEqual(badges.badgeChips(PROJECTION, card, { purpose: false, links: false, beats: false, milestones: false, missing: false }), []);
    assert.deepEqual(badges.badgeChips(null, card, badges.cardFaceDefaults()), []);
  });
});

describe('card face storage', () => {
  test('defaults: links, beats, milestones, missing on; purpose off', () => {
    assert.deepEqual(badges.cardFaceDefaults(), { purpose: false, links: true, beats: true, milestones: true, missing: true });
    assert.deepEqual(badges.readCardFace(memory()), badges.cardFaceDefaults());
    assert.deepEqual(badges.readCardFace(null), badges.cardFaceDefaults());
  });
  test('round trip, partial values, garbage and a throwing storage', () => {
    const st = memory();
    badges.writeCardFace({ purpose: true, links: false, beats: true, milestones: true, missing: true }, st);
    assert.equal(Object.keys(st.data)[0], 'sf.board.cardFace');
    assert.deepEqual(badges.readCardFace(st), { purpose: true, links: false, beats: true, milestones: true, missing: true });
    assert.deepEqual(badges.readCardFace(memory({ 'sf.board.cardFace': '{"purpose":true,"links":"no"}' })), { ...badges.cardFaceDefaults(), purpose: true });
    assert.deepEqual(badges.readCardFace(memory({ 'sf.board.cardFace': '{not json' })), badges.cardFaceDefaults());
    assert.deepEqual(badges.readCardFace(memory({ 'sf.board.cardFace': '7' })), badges.cardFaceDefaults());
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    assert.deepEqual(badges.readCardFace(boom), badges.cardFaceDefaults());
    assert.doesNotThrow(() => badges.writeCardFace(badges.cardFaceDefaults(), boom));
  });
});

describe('outlineRows with arc and beat filters', () => {
  test('without them the output is identical, badges or not', () => {
    const model1 = m();
    const plain = ids(model.outlineRows(model1, { status: 'draft' }));
    assert.deepEqual(ids(model.outlineRows(model1, { status: 'draft', badges: PROJECTION })), plain);
    assert.deepEqual(ids(model.outlineRows(model1, { arc: '', beat: '', badges: PROJECTION })), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(model.outlineRows(model1, { arc: 'maren' })), ['a', 'b', 'c', 'd'], 'an arc filter without a projection is ignored');
  });
  test('arc = a milestone of that arc; beat = in that beat of the primary structure; both combine with the old filters', () => {
    const model1 = m();
    assert.deepEqual(ids(model.outlineRows(model1, { arc: 'maren', badges: PROJECTION })), ['a']);
    assert.deepEqual(ids(model.outlineRows(model1, { arc: 'joss', badges: PROJECTION })), []);
    assert.deepEqual(ids(model.outlineRows(model1, { beat: 'opening', badges: PROJECTION })), ['a', 'c']);
    assert.deepEqual(ids(model.outlineRows(model1, { beat: 'fun', badges: PROJECTION })), [], 'a beat of a secondary structure is not the primary beat');
    assert.deepEqual(ids(model.outlineRows(model1, { beat: 'opening', pov: 'Joss', badges: PROJECTION })), []);
    assert.deepEqual(ids(model.outlineRows(model1, { beat: 'opening', pov: 'Maren', badges: PROJECTION })), ['a', 'c']);
  });
});

describe('by-beat grouping', () => {
  test('beats in order, an empty beat kept, a scene under several beats, the rest under not in a beat', () => {
    const groups = badges.beatGroups(m(), PROJECTION);
    assert.deepEqual(groups.map((g) => [g.name, g.scenes.map((s) => s.id)]), [
      ['Opening', ['a', 'c']],
      ['Midpoint', ['c']],
      ['Climax', []],
      ['Not in a beat', ['b', 'd']],
    ]);
    assert.equal(groups[3].none, true);
  });
  test('the filter applies and no primary structure gives null', () => {
    const g = badges.beatGroups(m(), PROJECTION, model.sceneKeep({ pov: 'Joss' }));
    assert.deepEqual(g.map((x) => x.scenes.map((s) => s.id)), [[], [], [], ['d']]);
    assert.equal(badges.beatGroups(m(), { scenes: {}, arcs: [], structures: [] }), null);
    assert.equal(badges.beatGroups(m(), null), null);
  });
});

describe('matrix extra columns', () => {
  test('arcs and beats only when asked, M and B cells', () => {
    assert.deepEqual(badges.matrixExtraColumns(PROJECTION, {}), []);
    assert.deepEqual(badges.matrixExtraColumns(null, { arcs: true, beats: true }), []);
    const arcs = badges.matrixExtraColumns(PROJECTION, { arcs: true });
    assert.deepEqual(arcs.map((c) => [c.name, c.mark, c.has('a'), c.has('c')]), [['Maren', 'M', true, false], ['Joss', 'M', false, false]]);
    const beats = badges.matrixExtraColumns(PROJECTION, { beats: true });
    assert.deepEqual(beats.map((c) => [c.name, c.mark, c.has('a'), c.has('c')]), [['Opening', 'B', true, true], ['Midpoint', 'B', false, true], ['Climax', 'B', false, false]]);
  });
});

describe('render', () => {
  const noop = () => {};
  test('BoardCard shows the chosen chips with accessible text; none without badges', () => {
    const card = m().sceneById.get('a');
    const html = render(h(views.BoardCard, { bookId: BOOK, card, badges: PROJECTION, face: badges.cardFaceDefaults() }));
    assert.match(html, /← 0 → 2/);
    assert.match(html, /Beat: Opening/);
    assert.match(html, /Arc: Maren/);
    assert.match(html, /aria-label="Beat Opening of Three act"/);
    assert.doesNotMatch(html, /Purpose:/);
    const bare = render(h(views.BoardCard, { bookId: BOOK, card }));
    assert.doesNotMatch(bare, /pb-chip/);
    const b = render(h(views.BoardCard, { bookId: BOOK, card: m().sceneById.get('b'), badges: PROJECTION, face: badges.cardFaceDefaults() }));
    assert.match(b, /No summary/);
    assert.match(b, /No goal/);
  });
  test('BoardView: Card face menu and arc filter only with the projection', () => {
    const withBadges = render(h(views.BoardView, { bookId: BOOK, model: m(), badges: PROJECTION, onMove: noop }));
    assert.match(withBadges, /Card face/);
    assert.match(withBadges, /name="arc"/);
    assert.match(withBadges, /Missing summary\/goal/);
    const without = render(h(views.BoardView, { bookId: BOOK, model: m(), onMove: noop }));
    assert.doesNotMatch(without, /Card face/);
    assert.doesNotMatch(without, /name="arc"/);
  });
  test('Outline: a Plan column with a link, colspans follow; unchanged without badges', () => {
    const html = render(h(views.OutlineView, { bookId: BOOK, model: m(), badges: PROJECTION }));
    assert.match(html, /<th scope="col">Plan<\/th>/);
    assert.match(html, /Open in Plan/);
    assert.match(html, new RegExp(`href="/books/${BOOK}/plan\\?select=a"`));
    assert.match(html, /colSpan="8"|colspan="8"/i);
    assert.match(html, /Group by/);
    const plain = render(h(views.OutlineView, { bookId: BOOK, model: m() }));
    assert.doesNotMatch(plain, />Plan</);
    assert.doesNotMatch(plain, /Group by/);
    assert.match(plain, /colSpan="7"|colspan="7"/i);
  });
  test('Matrix: toggles are off by default and add no columns', () => {
    const threadModel = model.buildModel(book, { ...planning, threads: [{ id: 't1', slug: 't', title: 'Thread', status: 'planned', setup: ['a'], develop: [], payoff: [], characters: [] }] });
    const html = render(h(views.MatrixView, { bookId: BOOK, model: threadModel, badges: PROJECTION }));
    assert.match(html, /Show arc milestones/);
    assert.match(html, /Show beats \(primary structure\)/);
    assert.doesNotMatch(html, /data-plan-column/);
  });
});
