// The Clues view of the Plan tab (Story Planner M8): kinds and words, knower rows and their checks, the clue-by-scene grid, the request builders, the URL, and the rendered view.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
const m = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m.clues = await vite.ssrLoadModule('/src/planner/clues.js');
  m.model = await vite.ssrLoadModule('/src/planner/model.js');
  m.req = await vite.ssrLoadModule('/src/planner/requests.js');
  m.view = await vite.ssrLoadModule('/src/planner/ClueView.jsx');
});
after(async () => {
  await vite?.close();
});

const text = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => text(renderToStaticMarkup(el));

const SCENES = [
  { id: 'S1', kind: 'scene', title: 'The Key', chapter: 1 },
  { id: 'S2', kind: 'scene', title: 'The Tide and the Long Walk Home', chapter: 1 },
  { id: 'S3', kind: 'scene', title: 'Ferry', chapter: 2 },
  { id: 'S4', kind: 'scene', title: '', chapter: 3 },
];
const scene = (id, title, position) => ({ id, title, position });
const CLUE = {
  id: 'note_c1',
  slug: 'torn-map',
  path: 'planning/clues/torn-map.md',
  fact: 'The map is torn on purpose',
  kind: 'clue',
  planted: [scene('S1', 'The Key', 1)],
  revealed: scene('S3', 'Ferry', 3),
  red_herring: false,
  knowers: [
    { who: { id: 'reader', name: 'The reader', reader: true }, scene: scene('S3', 'Ferry', 3), how: null, reliable: true },
    { who: { id: 'e_maren', name: 'Maren', reader: false }, scene: scene('S3', 'Ferry', 3), how: 'Sees the edge', reliable: true },
  ],
  sha256: 'sha-c1',
  body: 'Notes here.',
  problems: [],
};
const OTHER = { ...CLUE, id: 'note_c2', slug: 'red-door', fact: 'The red door', kind: 'secret', planted: [scene('S1', 'The Key', 1), scene('S2', 'The Tide', 2)], revealed: null, red_herring: true, knowers: [], sha256: 'sha-c2' };

test('kinds and words', () => {
  assert.deepEqual(m.clues.CLUE_KINDS.map((k) => k.value), ['clue', 'reveal', 'secret']);
  assert.equal(m.clues.kindLabel('reveal'), 'Reveal');
  assert.equal(m.clues.kindLabel('odd'), 'odd');
  assert.equal(m.clues.plantedText(OTHER), 'Planted in 2 scenes');
  assert.equal(m.clues.plantedText(CLUE), 'Planted in 1 scene');
  assert.equal(m.clues.plantedText({ planted: [] }), 'Planted in 0 scenes');
  assert.equal(m.clues.revealedText(CLUE), 'Revealed in Ferry');
  assert.equal(m.clues.revealedText(OTHER), 'Not revealed yet');
  assert.equal(m.clues.knowerName(CLUE.knowers[0]), 'The reader');
  assert.equal(m.clues.knowerName(CLUE.knowers[1]), 'Maren');
});

test('knower rows: from a clue, plain data, and validation', () => {
  const rows = m.clues.knowerRows(CLUE);
  assert.deepEqual(rows.map(({ who, scene: s, how, reliable }) => ({ who, scene: s, how, reliable })), [
    { who: 'reader', scene: 'S3', how: '', reliable: true },
    { who: 'e_maren', scene: 'S3', how: 'Sees the edge', reliable: true },
  ]);
  assert.equal(new Set(rows.map((r) => r.uid)).size, 2);
  assert.equal(m.clues.plainKnowers(rows), m.clues.plainKnowers(m.clues.knowerRows(CLUE)));
  assert.notEqual(m.clues.plainKnowers(rows), m.clues.plainKnowers(rows.map((r) => ({ ...r, reliable: false }))));
  assert.deepEqual(m.clues.validateKnowers(rows), { ok: true, errors: [] });
  assert.deepEqual(m.clues.validateKnowers([]), { ok: true, errors: [] });
  const bad = m.clues.validateKnowers([{ who: '', scene: 'S1' }, { who: 'reader', scene: '' }, { who: 'reader', scene: 'S2' }, { who: 'reader', scene: 'S2' }]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.index), [0, 1, 3]);
  assert.match(bad.errors[0].message, /Row 1: choose who/);
  assert.match(bad.errors[1].message, /Row 2: choose the scene/);
  assert.match(bad.errors[2].message, /already listed/);
});

test('grid: rows are clues, columns are scenes in reading order, cells mark P, R and K', () => {
  const g = m.clues.clueGrid({ clues: [CLUE, OTHER], scenes: SCENES });
  assert.deepEqual(g.columns.map((c) => c.id), ['S1', 'S2', 'S3', 'S4']);
  assert.equal(g.columns[1].short, 'The Tide and …');
  assert.equal(g.columns[3].title, 'Untitled scene');
  assert.deepEqual(g.rows.map((r) => r.slug), ['torn-map', 'red-door']);
  assert.deepEqual(g.rows[0].cells.map((c) => c.marks), ['P', '', 'RK', '']);
  assert.deepEqual(g.rows[1].cells.map((c) => c.marks), ['P', 'P', '', '']);
  const cell = g.rows[0].cells[2];
  assert.equal(cell.tip, 'Revealed. Learned by: The reader, Maren.');
  assert.deepEqual(cell.knowers, ['The reader', 'Maren']);
  assert.equal(cell.label, 'The map is torn on purpose, Ferry: Revealed. Learned by: The reader, Maren.');
  assert.match(g.rows[0].cells[1].label, /The Tide and the Long Walk Home: no marks$/);
  assert.equal(g.hidden, 0);
});

test('grid: "only scenes with marks" drops the columns nobody marks', () => {
  const g = m.clues.clueGrid({ clues: [CLUE, OTHER], scenes: SCENES, onlyMarked: true });
  assert.deepEqual(g.columns.map((c) => c.id), ['S1', 'S2', 'S3']);
  assert.equal(g.hidden, 1);
  assert.ok(g.rows.every((r) => r.cells.length === 3));
  const none = m.clues.clueGrid({ clues: [], scenes: SCENES, onlyMarked: true });
  assert.deepEqual(none.columns, []);
  assert.deepEqual(none.rows, []);
});

test('requests: urls, create, update, knowers, archive and restore', () => {
  assert.equal(m.clues.cluesUrl('b 1'), '/api/books/b%201/clues');
  assert.equal(m.clues.clueUrl('b1', 'torn-map'), '/api/books/b1/clues/torn-map');
  assert.equal(m.clues.clueUrl('b1', 'a/b', '/knowers'), '/api/books/b1/clues/a%2Fb/knowers');
  assert.deepEqual(m.clues.createClueRequest('b1', { fact: '  The map  ', kind: 'secret' }), { url: '/api/books/b1/clues', body: { fact: 'The map', kind: 'secret' } });
  assert.deepEqual(m.clues.createClueRequest('b1', { fact: 'x' }).body, { fact: 'x' });
  assert.deepEqual(m.clues.createClueRequest('b1', { fact: 'x', fields: { planted: ['S1'], revealed: '', red_herring: false }, dryRun: true }).body, { fact: 'x', fields: { planted: ['S1'] }, dryRun: true });
  assert.deepEqual(m.clues.createClueRequest('b1', { fact: 'x', fields: { revealed: 'S3', red_herring: true } }).body.fields, { revealed: 'S3', red_herring: true });
  assert.deepEqual(m.clues.updateClueBody(CLUE, { fact: ' New ', kind: 'reveal', planted: ['S1', 'S2'], revealed: null, red_herring: true }), {
    fields: { fact: 'New', kind: 'reveal', planted: ['S1', 'S2'], revealed: null, red_herring: true },
    base_sha256: 'sha-c1',
  });
  assert.deepEqual(m.clues.updateClueBody(CLUE, { body: 'n' }), { body: 'n', base_sha256: 'sha-c1' });
  assert.deepEqual(m.clues.updateClueBody(CLUE, { revealed: 'S2', dryRun: true }), { fields: { revealed: 'S2' }, base_sha256: 'sha-c1', dryRun: true });
  assert.deepEqual(m.clues.knowersBody(CLUE, [{ who: 'reader', scene: 'S3', how: '  ', reliable: true }, { who: 'e_maren', scene: 'S3', how: ' Sees it ', reliable: false }]), {
    knowers: [{ who: 'reader', scene: 'S3' }, { who: 'e_maren', scene: 'S3', how: 'Sees it', reliable: false }],
    base_sha256: 'sha-c1',
  });
  assert.deepEqual(m.clues.archiveClueRequest('b1', 'torn-map', CLUE), { url: '/api/books/b1/clues/torn-map/archive', body: { base_sha256: 'sha-c1' } });
  assert.deepEqual(m.clues.restoreClueRequest('b1', 'torn-map'), { url: '/api/books/b1/clues/torn-map/restore', body: {} });
});

test('conflict: a 409 conflict is told in words, other refusals are left to explainFailure', () => {
  assert.equal(m.clues.isClueConflict(409, { error: 'conflict', current: {} }), true);
  assert.equal(m.clues.isClueConflict(400, { error: 'conflict' }), false);
  assert.match(m.clues.explainClueFailure(409, { error: 'conflict' }), /changed elsewhere/);
  assert.equal(m.clues.explainClueFailure(400, { code: 'X' }), null);
});

test('URL: the Clues view and ?clue= round trip, and the empty query is unchanged', () => {
  assert.equal(m.model.parsePlanSearch('?view=clues').view, 'clues');
  assert.equal(m.model.clueFromSearch('?view=clues&clue=torn-map'), 'torn-map');
  assert.equal(m.model.clueFromSearch(''), null);
  assert.equal(m.req.planHref('b1', { view: 'clues', clue: 'torn-map' }), '/books/b1/plan?view=clues&clue=torn-map');
  const state = { ...m.model.parsePlanSearch('?view=clues'), clue: 'torn-map' };
  assert.equal(m.model.planUrl('b1', state), '/books/b1/plan?view=clues&clue=torn-map');
  assert.deepEqual(m.model.PLAN_VIEWS.map((v) => v.key).slice(-2), ['synopsis', 'clues']);
  assert.ok(!('clue' in m.model.parsePlanSearch('')));
});

const props = (extra = {}) => ({
  bookId: 'b1',
  list: { clues: [CLUE, OTHER], archived: [{ slug: 'old', fact: 'Old fact' }] },
  detail: null,
  selected: null,
  scenes: SCENES,
  characters: [{ id: 'e_maren', slug: 'maren', title: 'Maren' }],
  structure: { showToast() {}, apply() {} },
  refresh() {},
  onSelect() {},
  ...extra,
});

test('view: the list, the New clue form, the archived list and the grid', () => {
  const html = render(h(m.view.ClueView, props()));
  assert.match(html, /The map is torn on purpose/);
  assert.match(html, /Planted in 2 scenes/);
  assert.match(html, /Revealed in Ferry/);
  assert.match(html, /Not revealed yet/);
  assert.match(html, /Red herring/);
  assert.match(html, /aria-label="New clue"/);
  assert.match(html, /Archived clues/);
  assert.match(html, /aria-label="Restore Old fact"/);
  assert.match(html, /Show only scenes with marks/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /<th scope="row">The red door<\/th>/);
  assert.match(html, /title="Revealed\. Learned by: The reader, Maren\."/);
  assert.match(html, /href="\/books\/b1\/plan\?view=clues&clue=torn-map"/);
});

test('view: the editor has the fields, the knowers table and Archive', () => {
  const html = render(h(m.view.ClueView, props({ detail: CLUE, selected: 'torn-map' })));
  assert.match(html, /for="cl-fact"/);
  assert.match(html, /value="The map is torn on purpose"/);
  assert.match(html, /Planted in scenes/);
  assert.match(html, /aria-label="Remove Ch 1: The Key"/);
  assert.match(html, /<option value="">None<\/option>/);
  assert.match(html, /Red herring \(deliberate misdirection\)/);
  assert.match(html, /Save knowers/);
  assert.match(html, /aria-label="Who, row 2"/);
  assert.match(html, /Archive clue/);
  const unreliable = render(h(m.view.ClueView, props({ detail: { ...CLUE, knowers: [{ ...CLUE.knowers[1], reliable: false }] }, selected: 'torn-map' })));
  assert.match(unreliable, /Believes something false/);
});
