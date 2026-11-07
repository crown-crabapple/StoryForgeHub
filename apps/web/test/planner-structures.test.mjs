// Story structures (Story Planner M4): request builders, the URL state, the Structure view, the beat sheet editor, the New structure dialog, the scene Plan section and the Overview.
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
  m.model = await vite.ssrLoadModule('/src/planner/model.js');
  m.req = await vite.ssrLoadModule('/src/planner/requests.js');
  m.editor = await vite.ssrLoadModule('/src/planner/BeatSheetEditor.jsx');
  m.section = await vite.ssrLoadModule('/src/planner/ScenePlanSection.jsx');
  m.overview = await vite.ssrLoadModule('/src/planner/OverviewView.jsx');
});
after(async () => {
  await vite?.close();
});

const text = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => text(renderToStaticMarkup(el));

const NODES = [
  { id: 'S1', title: 'The Key', act: 1, chapter: 1, sequence: 1 },
  { id: 'S2', title: 'The Tide', act: 1, chapter: 1, sequence: 2 },
  { id: 'S3', title: 'Ferry', act: 1, chapter: 2, sequence: 1 },
];
const BEAT = (id, name, extra = {}) => ({ id, name, purpose: '', question: '', position: '', state: 'open', scenes: [], ...extra });
const STRUCT = (slug, name, beats, extra = {}) => ({
  id: `note_${slug}`,
  slug,
  name,
  template: 'three-act',
  template_version: 1,
  primary: false,
  sha256: `sha-${slug}`,
  body: '',
  beats,
  counts: { beats: beats.length, assigned: beats.filter((b) => b.scenes.length).length, omitted: beats.filter((b) => b.state === 'omitted').length },
  ...extra,
});
const THREE = STRUCT(
  'three-act',
  'Three acts',
  [
    BEAT('b1', 'Setup', { purpose: 'Show the world', position: 'about 10%', scenes: [{ id: 'S1', title: 'The Key', chapter: 1, sequence: 1 }] }),
    BEAT('b2', 'Turn', { question: 'What changes?', state: 'omitted' }),
  ],
  { primary: true },
);
const MYSTERY = STRUCT('mystery', 'Mystery', [BEAT('m1', 'The body', { scenes: [{ id: 'S3', title: 'Ferry', chapter: 2, sequence: 1 }] })]);
const DATA = { structures: [THREE, MYSTERY], archived: [{ slug: 'old', name: 'Old one' }] };
const URLSTATE = (patch = {}) => ({ view: 'structure', node: null, link: null, arc: null, relationship: null, structure: null, mode: null, filter: null, ...patch });

test('requests: URLs', () => {
  assert.equal(m.req.structureTemplatesUrl('b1'), '/api/books/b1/structure-templates');
  assert.equal(m.req.structuresUrl('b1'), '/api/books/b1/structures');
  assert.equal(m.req.structureUrl('b1', 'three act'), '/api/books/b1/structures/three%20act');
  assert.equal(m.req.structureUrl('b1', 'mystery', '/beats'), '/api/books/b1/structures/mystery/beats');
  assert.equal(m.req.planHref('b1', { view: 'structure', structure: 'mystery' }), '/books/b1/plan?view=structure&structure=mystery');
});

test('requests: beatsBody strips empty strings, keeps order, ids, states and scene ids', () => {
  const body = m.req.beatsBody({ sha256: 'abc' }, [
    { id: 'b2', name: ' Turn ', purpose: '  ', question: 'What changes?', position: '', state: 'omitted', scenes: [] },
    { name: 'New', purpose: 'p', state: 'weird', scenes: ['S1', 'S2'] },
  ]);
  assert.deepEqual(body, {
    beats: [
      { id: 'b2', name: 'Turn', question: 'What changes?', state: 'omitted', scenes: [] },
      { name: 'New', purpose: 'p', state: 'open', scenes: ['S1', 'S2'] },
    ],
    base_sha256: 'abc',
  });
  assert.equal(m.req.beatsBody({ sha256: 'abc' }, [], { dryRun: true }).dryRun, true);
});

test('requests: create and update bodies, failure sentences', () => {
  assert.deepEqual(m.req.createStructureRequest('b1', { template: 'mystery', name: ' Mine ' }), { url: '/api/books/b1/structures', body: { template: 'mystery', name: 'Mine' } });
  assert.deepEqual(m.req.updateStructureBody({ sha256: 's' }, { name: 'X' }), { name: 'X', base_sha256: 's' });
  assert.match(m.req.explainStructureFailure(400, { code: 'REFUSED_UNKNOWN_SCENE', index: 1 }), /beat 2/);
  assert.equal(m.req.explainStructureFailure(409, { error: 'conflict' }), 'This structure changed elsewhere; reloaded.');
  assert.equal(m.req.explainStructureFailure(500, {}), null);
});

test('requests: beatsForScene lists structure, beat and index in order', () => {
  const found = m.req.beatsForScene(DATA, 'S1');
  assert.equal(found.length, 1);
  assert.equal(found[0].structure.slug, 'three-act');
  assert.equal(found[0].beat.name, 'Setup');
  assert.equal(found[0].index, 0);
  assert.deepEqual(m.req.beatsForScene(DATA, 'S2'), []);
  assert.deepEqual(m.req.beatsForScene(null, 'S1'), []);
});

test('model: the Structure view round-trips through the URL and old params keep working', () => {
  assert.equal(m.model.parsePlanSearch('?view=structure&structure=mystery').view, 'structure');
  assert.equal(m.model.parsePlanSearch('?view=arcs&arc=maren').arc, 'maren');
  const state = URLSTATE({ structure: 'mystery' });
  const href = m.model.planUrl('b1', state);
  assert.equal(href, '/books/b1/plan?view=structure&structure=mystery');
  assert.deepEqual(m.model.parsePlanSearch(href.slice(href.indexOf('?'))), state);
  assert.deepEqual(m.model.PLAN_VIEWS.map((v) => v.label), ['Overview', 'Flow', 'Structure', 'Lanes', 'Synopsis', 'Clues']);
});

test('BeatSheetEditor: one labelled row per beat with name, purpose, question, position, state, scene chips and the move and remove buttons', () => {
  const html = render(h(m.editor.BeatSheetEditor, { structure: THREE, scenes: NODES }));
  assert.match(html, /Name, beat 1/);
  assert.match(html, /Purpose, beat 1/);
  assert.match(html, /Question, beat 2/);
  assert.match(html, /Position \(such as about 25%\), beat 1/);
  assert.match(html, /State of beat 2/);
  assert.match(html, /<option value="omitted" selected="">Omitted<\/option>/);
  assert.match(html, /<option value="done">Done<\/option>/);
  assert.match(html, /aria-label="Remove scene Ch 1: The Key from beat 1"/);
  assert.match(html, /Search scenes to add to beat 1/);
  assert.match(html, /Add scene to beat 2/);
  assert.match(html, /disabled="" aria-label="Move beat 1 up"/);
  assert.match(html, /disabled="" aria-label="Move beat 2 down"/);
  assert.match(html, /aria-label="Move beat 1 down"/);
  assert.match(html, /aria-label="Remove beat 2"/);
  assert.match(html, />Add beat</);
  assert.match(html, /<button type="button" class="btn btn-primary" disabled="">Save beats<\/button>/);
  // a scene already in a beat is not offered again for that beat
  const add1 = html.slice(html.indexOf('Add scene to beat 1'), html.indexOf('Move beat 1 up'));
  assert.doesNotMatch(add1, /value="S1"/);
  assert.match(add1, /value="S2"/);
});

test('BeatSheetEditor: an empty sheet says so; a scene that is gone shows as Missing scene', () => {
  assert.match(render(h(m.editor.BeatSheetEditor, { structure: STRUCT('c', 'Custom', []), scenes: NODES })), /No beats yet/);
  const gone = STRUCT('c', 'Custom', [BEAT('x', 'X', { scenes: [{ id: 'S_GONE', title: 'Gone' }] })]);
  assert.match(render(h(m.editor.BeatSheetEditor, { structure: gone, scenes: NODES })), /Missing scene/);
});

test('scene Plan section: Beats in this scene links to the structure, or says no beat uses the scene', () => {
  const view = (structures) => render(h(m.section.ScenePlanView, { bookId: 'b1', sceneId: 'S1', plan: null, links: { links: [] }, structures }));
  const html = view(DATA);
  assert.match(html, /Beats in this scene/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=structure&structure=three-act">Three acts: Setup<\/a>/);
  assert.match(view({ structures: [], archived: [] }), /No beat uses this scene\./);
  assert.doesNotMatch(view(null), /Beats in this scene/);
});

test('Overview: shows the structure count and the primary structure, each linking to the Structure view', () => {
  const base = {
    story: { path: null, sha256: null, fields: Object.fromEntries(m.req.STORY_FIELDS.map((f) => [f.key, null])), body: '' },
    counts: { scenes: 4, planned_scenes: 1, links: 0, linked_scenes: 0, unlinked_scenes: 4, broken_links: 0, archived_links: 0, threads: 0, arcs: 0, structures: 2 },
    unlinked: [],
  };
  const withPrimary = render(h(m.overview.OverviewView, { bookId: 'b1', overview: { ...base, primary_structure: { id: 'note_three-act', slug: 'three-act', name: 'Three acts' } } }));
  assert.match(withPrimary, /<a href="\/books\/b1\/plan\?view=structure">2 structures<\/a>/);
  assert.match(withPrimary, /<a href="\/books\/b1\/plan\?view=structure&structure=three-act">Primary: Three acts<\/a>/);
  const none = render(h(m.overview.OverviewView, { bookId: 'b1', overview: { ...base, primary_structure: null } }));
  assert.match(none, /No primary structure/);
  const old = render(h(m.overview.OverviewView, { bookId: 'b1', overview: { ...base, counts: { ...base.counts, structures: undefined } } }));
  assert.doesNotMatch(old, /structure/i);
});
