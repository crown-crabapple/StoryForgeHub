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
  m.view = await vite.ssrLoadModule('/src/planner/StructureView.jsx');
  m.editor = await vite.ssrLoadModule('/src/planner/BeatSheetEditor.jsx');
  m.dialog = await vite.ssrLoadModule('/src/planner/NewStructureDialog.jsx');
  m.section = await vite.ssrLoadModule('/src/planner/ScenePlanSection.jsx');
  m.overview = await vite.ssrLoadModule('/src/planner/OverviewView.jsx');
  m.page = await vite.ssrLoadModule('/src/planner/PlanPage.jsx');
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
const URLSTATE = (patch = {}) => ({ view: 'structure', node: null, link: null, arc: null, structure: null, mode: null, filter: null, ...patch });

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
  assert.deepEqual(m.model.PLAN_VIEWS.map((v) => v.label), ['Overview', 'Flow', 'Structure', 'Arcs']);
});

test('Plan subnav has Structure between Flow and Arcs', () => {
  const html = render(h(m.page.PlanPage, { bookId: 'b1', view: 'structure' }, h('p', null, 'body')));
  assert.match(html, /<a href="\/books\/b1\/plan\?view=structure" class="view-tab" aria-current="page">Structure<\/a>/);
  assert.ok(html.indexOf('>Flow<') < html.indexOf('>Structure<') && html.indexOf('>Structure<') < html.indexOf('>Arcs<'));
});

test('StructureView: empty state offers New structure and says structures are optional', () => {
  const html = render(h(m.view.StructureView, { bookId: 'b1', structures: { structures: [], archived: [] }, flow: { nodes: NODES }, url: URLSTATE() }));
  assert.match(html, /No structures yet/);
  assert.match(html, /optional guidance/);
  assert.match(html, /<button[^>]*>New structure<\/button>/);
  assert.doesNotMatch(html, /Archived structures/);
  assert.match(render(h(m.view.StructureView, { bookId: 'b1', structures: null, flow: null, url: URLSTATE() })), /Loading/);
});

test('StructureView: tabs mark the primary in words; the selected structure shows its details and archived ones can be restored', () => {
  const html = render(h(m.view.StructureView, { bookId: 'b1', structures: DATA, flow: { nodes: NODES }, url: URLSTATE({ structure: 'mystery' }) }));
  assert.match(html, /<a href="\/books\/b1\/plan\?view=structure&structure=three-act" class="view-tab">Three acts \(Primary\)<\/a>/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=structure&structure=mystery" class="view-tab" aria-current="page">Mystery<\/a>/);
  assert.match(html, /Template: three-act \(version 1\)/);
  assert.match(html, /<label for="st-name">Structure name<\/label>/);
  assert.match(html, /Set as primary/);
  assert.match(html, /Archive structure/);
  assert.match(html, /Archived structures \(1\)/);
  assert.match(html, /aria-label="Restore Old one"/);
  const primary = render(h(m.view.StructureView, { bookId: 'b1', structures: DATA, flow: { nodes: NODES }, url: URLSTATE() }));
  assert.match(primary, /This is the primary structure\./);
  assert.doesNotMatch(primary, /Set as primary/);
  assert.match(render(h(m.view.StructureView, { bookId: 'b1', structures: DATA, flow: { nodes: NODES }, url: URLSTATE({ structure: 'gone' }), state: {} })), /not there any more/);
  const shown = render(h(m.view.StructureView, { bookId: 'b1', structures: DATA, flow: { nodes: NODES }, url: URLSTATE(), state: { error: 'Nope.', message: 'Reloaded.' } }));
  assert.match(shown, /role="alert">Nope\./);
  assert.match(shown, /role="status">Reloaded\./);
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

test('NewStructureDialog: radio list with descriptions, a preview of the chosen template and the name defaulting to its name', () => {
  const templates = [
    { id: 'three-act', version: 1, name: 'Three acts', description: 'Setup, confrontation, resolution.', beats: [{ name: 'Setup', purpose: 'Show the world' }, { name: 'Turn', purpose: 'Raise the stakes' }] },
    { id: 'custom', version: 1, name: 'Custom', description: 'Start empty.', beats: [] },
  ];
  const html = render(h(m.dialog.NewStructureDialog, { templates, onCreate: () => {}, onClose: () => {} }));
  assert.match(html, /<legend>Template<\/legend>/);
  assert.match(html, /type="radio" id="st-template-three-act"[^>]*checked=""/);
  assert.match(html, /Setup, confrontation, resolution\./);
  assert.match(html, /Beats in Three acts/);
  assert.match(html, /<strong>Setup<\/strong> — Show the world/);
  assert.match(html, /id="new-structure-name"[^>]*value="Three acts"/);
  assert.match(html, />Create</);
  assert.match(render(h(m.dialog.NewStructureDialog, { templates: null, onCreate: () => {}, onClose: () => {} })), /Loading/);
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
