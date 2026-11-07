// Character arcs (Story Planner M3): request builders, the lanes layout (pure), and the presentational Arcs view, ArcEditor, Codex Arc panel, scene Plan section and Plan subnav.
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
  m.arcs = await vite.ssrLoadModule('/src/planner/ArcsView.jsx');
  m.editor = await vite.ssrLoadModule('/src/planner/ArcEditor.jsx');
  m.panel = await vite.ssrLoadModule('/src/planner/ArcPanel.jsx');
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
  { id: 'S4', title: '', act: 2, chapter: 3, sequence: 1 },
];
const MS = (index, scene, extra = {}) => ({ index, scene, scene_title: null, chapter: null, sequence: null, pressure: '', choice: '', belief_before: '', belief_after: '', cost: '', ...extra });
const ARC = (slug, name, milestones, extra = {}) => ({
  id: `note_${slug}`,
  slug,
  path: `planning/arcs/${slug}.md`,
  sha256: `sha-${slug}`,
  character: { id: `entry_${slug}`, slug, name, shared: false },
  character_id: `entry_${slug}`,
  arc_type: 'positive',
  fields: { want: 'The orchard', need: null, false_belief: null, fear: null, wound: null, start_state: null, end_state: null },
  milestones,
  body: '',
  problems: [],
  ...extra,
});
const MAREN = ARC('maren', 'Maren', [
  MS(0, 'S1', { pressure: 'The key will not turn', choice: 'Takes the ferry', belief_before: 'I can do this alone', belief_after: 'I need help' }),
  MS(1, 'S3', { pressure: 'The crossing' }),
  MS(2, 'S_GONE', { choice: 'Lost' }),
]);
const PELL = ARC('pell', 'Pell', [MS(0, 'S1', { choice: 'Stays quiet' }), MS(1, 'S1', { choice: 'Speaks' })], { arc_type: null });
const ARCS = { arcs: [MAREN, PELL], archived: [] };
const URLSTATE = (patch = {}) => ({ view: 'arcs', node: null, link: null, arc: null, mode: null, filter: null, ...patch });

test('requests: arc urls, create request, update and milestone bodies', () => {
  assert.equal(m.req.arcsUrl('b 1'), '/api/books/b%201/arcs');
  assert.equal(m.req.arcUrl('b1', 'maren'), '/api/books/b1/arcs/maren');
  assert.equal(m.req.arcUrl('b1', 'maren', '/milestones'), '/api/books/b1/arcs/maren/milestones');
  assert.deepEqual(m.req.createArcRequest('b1', { character: 'entry_x' }), { url: '/api/books/b1/arcs', body: { character: 'entry_x' } });
  assert.deepEqual(m.req.createArcRequest('b1', { character: 'entry_x', arc_type: 'flat' }).body, { character: 'entry_x', arc_type: 'flat' });
  assert.deepEqual(m.req.updateArcBody({ sha256: 'abc' }, { fields: { want: 'x', fear: null } }), { fields: { want: 'x', fear: null }, base_sha256: 'abc' });
  assert.deepEqual(m.req.updateArcBody({ sha256: 'abc' }, { arc_type: null, body: 'n', dryRun: true }), { arc_type: null, body: 'n', base_sha256: 'abc', dryRun: true });
  assert.deepEqual(
    m.req.milestonesBody({ sha256: 'abc' }, [{ scene: 'S1', pressure: ' hard ', choice: '', cost: 'x' }, { scene: 'S2' }]),
    { milestones: [{ scene: 'S1', pressure: 'hard', cost: 'x' }, { scene: 'S2' }], base_sha256: 'abc' },
  );
  assert.equal(m.req.milestonesBody({ sha256: 'a' }, [], { dryRun: true }).dryRun, true);
  assert.equal(m.req.planHref('b1', { view: 'arcs', arc: 'maren' }), '/books/b1/plan?view=arcs&arc=maren');
  assert.match(m.req.explainArcFailure(409, { code: 'REFUSED_DUPLICATE_ARC' }), /already has an arc/);
  assert.match(m.req.explainArcFailure(400, { code: 'REFUSED_UNKNOWN_SCENE', index: 1 }), /milestone 2/);
  assert.equal(m.req.explainArcFailure(409, { error: 'conflict' }), 'This arc changed elsewhere; reloaded.');
});

test('ARC_TYPES carry their words; the field and milestone labels are the agreed ones', () => {
  const words = Object.fromEntries(m.req.ARC_TYPES.map((t) => [t.value, t.words]));
  assert.equal(words.positive, 'changes for the better');
  assert.equal(words.negative, 'changes for the worse');
  assert.equal(words.flat, 'stays the same and changes others');
  assert.ok('custom' in words);
  assert.deepEqual(m.req.ARC_FIELDS.map((f) => f.label), ['Want', 'Need', 'False belief', 'Fear', 'Wound', 'Starts as', 'Ends as']);
  assert.deepEqual(m.req.MILESTONE_FIELDS.map((f) => f.label), ['Pressure', 'Choice', 'Belief before', 'Belief after', 'Cost']);
});

test('model: the Arcs view round-trips through the URL', () => {
  assert.equal(m.model.parsePlanSearch('?view=arcs&arc=maren&mode=list').view, 'arcs');
  const state = { view: 'arcs', node: null, link: null, arc: 'maren', relationship: null, structure: null, mode: 'list', filter: null };
  const href = m.model.planUrl('b1', state);
  assert.equal(href, '/books/b1/plan?view=arcs&mode=list&arc=maren');
  assert.deepEqual(m.model.parsePlanSearch(href.slice(href.indexOf('?'))), state);
});

test('layoutLanes: one row per arc, a column per scene, a marker per milestone at its scene; unknown scenes are counted, not drawn', () => {
  const lanes = m.model.layoutLanes(ARCS.arcs, NODES);
  assert.equal(lanes.columns.length, 4);
  assert.deepEqual(lanes.columns.map((c) => c.id), ['S1', 'S2', 'S3', 'S4']);
  assert.ok(lanes.columns[1].x > lanes.columns[0].x);
  assert.deepEqual(lanes.chapters.map((c) => c.label), ['Ch 1', 'Ch 2', 'Ch 3']);
  assert.equal(lanes.chapters[0].width, 2 * m.model.LANE_COL_W);
  assert.deepEqual(lanes.rows.map((r) => [r.slug, r.name]), [['maren', 'Maren'], ['pell', 'Pell']]);
  assert.ok(lanes.rows[1].y > lanes.rows[0].y);
  const [a, b] = lanes.rows[0].markers;
  assert.deepEqual(lanes.rows[0].markers.map((x) => x.key), ['maren:0', 'maren:1']);
  assert.ok(a.x >= lanes.columns[0].x && a.x < lanes.columns[1].x);
  assert.ok(b.x >= lanes.columns[2].x && b.x < lanes.columns[3].x);
  assert.equal(lanes.unplaced, 1);
  const [p0, p1] = lanes.rows[1].markers;
  assert.ok(p1.x > p0.x && p1.x < lanes.columns[1].x + m.model.LANE_COL_W, 'two milestones in one scene sit side by side');
  assert.equal(a.name, 'Maren: Takes the ferry in The Key');
  assert.equal(b.name, 'Maren: The crossing in Ferry');
  assert.deepEqual(m.model.layoutLanes(ARCS.arcs, NODES), lanes, 'same input, same layout');
  assert.deepEqual(m.model.layoutLanes([], NODES).rows, []);
  assert.equal(m.model.layoutLanes(ARCS.arcs, []).width, 0);
});

const arcsView = (props) => render(h(m.arcs.ArcsView, { bookId: 'b1', arcs: ARCS, flow: { nodes: NODES }, url: URLSTATE(), wide: true, ...props }));

test('Arcs lanes: markers are buttons with accessible names and a number as text; the selected one is aria-pressed', () => {
  const html = arcsView({ arc: 'maren', selectedMilestone: { slug: 'maren', index: 1 }, url: URLSTATE({ arc: 'maren' }) });
  assert.match(html, /aria-label="Maren: Takes the ferry in The Key"/);
  assert.match(html, /aria-label="Maren: The crossing in Ferry"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-label="Maren: The crossing in Ferry"[^>]*aria-pressed="true"[^>]*><span aria-hidden="true">2<\/span>/);
  assert.match(html, /aria-label="Pell: Stays quiet in The Key"/);
  assert.match(html, /aria-label="Pell: Speaks in The Key"/);
  assert.match(html, /1 milestone points to a scene that is not in the book/);
  assert.match(html, /<h2 id="arc-panel-h">Arc of Maren<\/h2>/);
  assert.match(html, /<h3 id="arc-ms-h">Milestone 2: Ferry<\/h3>/);
  assert.match(html, /<a href="\/books\/b1\?scene=S3">Open scene<\/a>/);
});

test('Arcs list: per arc a heading, ordered milestone rows "<scene> — <choice / pressure>" with belief before → after', () => {
  const html = arcsView({ url: URLSTATE({ mode: 'list' }) });
  assert.match(html, /<h2 id="arc-h-maren">Maren/);
  assert.match(html, /<h2 id="arc-h-pell">Pell/);
  assert.match(html, /The Key<\/button>[^<]*— Takes the ferry \/ The key will not turn/);
  assert.match(html, /I can do this alone → I need help/);
  assert.match(html, /Ferry<\/button>[^<]*— The crossing/);
  assert.match(html, /<span class="tag"> missing scene<\/span>/);
  assert.match(html, /aria-label="Edit the arc of Maren"/);
  assert.match(html, /aria-pressed="true"[^>]*>List</);
  assert.doesNotMatch(html, /arc-lanes/);
});

test('Arcs view: narrow screens get only the list, an empty book gets the sentence, New arc is a button', () => {
  const narrow = arcsView({ wide: false });
  assert.match(narrow, /class="arc-list"/);
  assert.match(narrow, /<button type="button" class="btn" aria-pressed="false" disabled="">Lanes<\/button>/);
  assert.match(narrow, /The lanes need a screen at least 768 px wide/);
  const empty = arcsView({ arcs: { arcs: [], archived: [] } });
  assert.match(empty, /No arcs yet\. Start one from a character&#x27;s Codex page or with New arc\.|No arcs yet\. Start one from a character's Codex page or with New arc\./);
  assert.match(empty, />New arc…<\/button>/);
  assert.match(arcsView({ arcs: null }), /Loading…/);
  assert.match(arcsView({ url: URLSTATE({ arc: 'nope' }) }), /That arc is not there any more\./);
});

test('New arc dialog: labelled character select, a character that has an arc is disabled', () => {
  const html = render(h(m.arcs.NewArcDialog, { characters: [{ id: 'entry_maren', title: 'Maren', slug: 'maren' }, { id: 'entry_pell', title: 'Pell', slug: 'pell' }], hasArc: new Set(['entry_maren']), onCreate: () => {}, onClose: () => {} }));
  assert.match(html, /aria-label="New arc"/);
  assert.match(html, /<label for="new-arc-character">Character<\/label>/);
  assert.match(html, /<option value="entry_maren" disabled="">Maren \(has an arc\)<\/option>/);
  assert.match(html, /<option value="entry_pell">Pell<\/option>/);
});

test('ArcEditor: type select with words, seven fields, notes with Save, milestone controls, Archive', () => {
  const html = render(h(m.editor.ArcEditor, { bookId: 'b1', arc: MAREN, scenes: NODES, defaultScene: 'S2' }));
  assert.match(html, /<label for="arc-type">Arc type<\/label>/);
  assert.match(html, /<option value="positive" selected="">Positive: changes for the better<\/option>/);
  assert.match(html, /This character changes for the better\./);
  for (const f of m.req.ARC_FIELDS) assert.match(html, new RegExp(`<label for="arc-${f.key}">${f.label}</label>`), f.label);
  assert.match(html, /<input id="arc-want"[^>]*value="The orchard"/);
  assert.match(html, />Save notes<\/button>/);
  assert.match(html, /<h4>Milestone 1<\/h4>/);
  assert.match(html, /<h4>Milestone 3<\/h4>/);
  assert.match(html, /<option value="S3">Ch 2: Ferry<\/option>/);
  assert.match(html, /<option value="S_GONE" selected="">Missing scene<\/option>/);
  assert.match(html, /<a href="\/books\/b1\?scene=S1">Open scene \(milestone 1\)<\/a>/);
  for (const label of ['Pressure', 'Choice', 'Belief before', 'Belief after', 'Cost']) assert.match(html, new RegExp(`>${label}</label>`), label);
  assert.match(html, /aria-label="Move milestone 1 up"/);
  assert.match(html, /disabled="" aria-label="Move milestone 1 up"/, 'the first cannot move up');
  assert.match(html, /aria-label="Move milestone 3 down"/);
  assert.match(html, /aria-label="Remove milestone 2"/);
  assert.match(html, />Add milestone<\/button>/);
  assert.match(html, /<button type="button" class="btn btn-primary" disabled="">Save milestones<\/button>/, 'nothing to save yet');
  assert.match(html, />Archive arc<\/button>/);
  assert.doesNotMatch(html, /Unsaved changes/);
  const shown = render(h(m.editor.ArcEditor, { bookId: 'b1', arc: PELL, scenes: NODES, state: { error: 'Nope.', message: 'Reloaded.' } }));
  assert.match(shown, /role="alert">Nope\./);
  assert.match(shown, /role="status">Reloaded\./);
  assert.match(shown, /<option value="" selected="">Not set<\/option>/);
});

const CHARACTER = { id: 'entry_maren', name: 'Maren', type: 'character', shared: false };

test('Codex Arc panel: a character without an arc gets the empty sentence and Start an arc; with an arc, the editor', () => {
  const empty = render(h(m.panel.ArcPanelView, { bookId: 'b1', entry: CHARACTER, arc: null }));
  assert.match(empty, /<h3 id="arc-panel-heading">Arc<\/h3>/);
  assert.match(empty, /No arc for Maren in this book\./);
  assert.match(empty, />Start an arc<\/button>/);
  const shared = render(h(m.panel.ArcPanelView, { bookId: 'b1', entry: { ...CHARACTER, shared: true }, arc: null }));
  assert.match(shared, /<h3 id="arc-panel-heading">Arc in this book<\/h3>/);
  const full = render(h(m.panel.ArcPanelView, { bookId: 'b1', entry: CHARACTER, arc: MAREN, scenes: NODES }));
  assert.match(full, /<label for="arc-type">Arc type<\/label>/);
  assert.match(full, /<a href="\/books\/b1\/plan\?view=arcs&arc=maren">Open in the Plan tab<\/a>/);
  assert.doesNotMatch(full, /Start an arc/);
});

test('Codex Arc panel: not shown for a location', () => {
  assert.equal(render(h(m.panel.ArcPanelView, { bookId: 'b1', entry: { id: 'entry_l', name: 'The Quay', type: 'location' }, arc: null })), '');
});

test('scene Plan section: lists the arc milestones set in the scene and links them to the Arcs view', () => {
  const view = (arcs) => render(h(m.section.ScenePlanView, { bookId: 'b1', sceneId: 'S1', plan: null, links: { links: [] }, arcs }));
  assert.deepEqual(m.req.arcMilestonesForScene(ARCS, 'S1').map((x) => `${x.arc.slug}:${x.milestone.index}`), ['maren:0', 'pell:0', 'pell:1']);
  const html = view(ARCS);
  assert.match(html, /<h3 class="plan-links-heading">Arc milestones in this scene<\/h3>/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=arcs&arc=maren">Maren: Takes the ferry<\/a>/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=arcs&arc=pell">Pell: Stays quiet<\/a>/);
  assert.match(view({ arcs: [], archived: [] }), /No character arc has a milestone here\./);
  assert.doesNotMatch(view(null), /Arc milestones in this scene/);
});

test('the Overview counts character arcs with a link to them', () => {
  const overview = {
    story: { path: null, sha256: null, fields: Object.fromEntries(m.req.STORY_FIELDS.map((f) => [f.key, null])), body: '' },
    counts: { scenes: 4, planned_scenes: 1, links: 0, linked_scenes: 0, unlinked_scenes: 4, broken_links: 0, archived_links: 0, threads: 0, arcs: 2 },
    unlinked: [],
  };
  assert.match(render(h(m.overview.OverviewView, { bookId: 'b1', overview })), /<a href="\/books\/b1\/plan\?view=arcs">2 character arcs<\/a>/);
});
