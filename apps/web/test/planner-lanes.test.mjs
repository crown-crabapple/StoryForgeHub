// Lanes, relationships and beats in links (Story Planner M5): request builders, the three-kind lanes layout (pure), the kind toggles, and the presentational Lanes view,
// RelationshipEditor, New relationship dialog, Connect dialog beats, Flow beats row and scene Plan section.
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
  m.editor = await vite.ssrLoadModule('/src/planner/RelationshipEditor.jsx');
  m.connect = await vite.ssrLoadModule('/src/planner/ConnectDialog.jsx');
  m.flow = await vite.ssrLoadModule('/src/planner/FlowView.jsx');
  m.section = await vite.ssrLoadModule('/src/planner/ScenePlanSection.jsx');
  m.overview = await vite.ssrLoadModule('/src/planner/OverviewView.jsx');
});
after(async () => {
  await vite?.close();
});

const text = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => text(renderToStaticMarkup(el));

const NODES = [
  { id: 'S1', kind: 'scene', title: 'The Key', act: 1, chapter: 1, sequence: 1 },
  { id: 'S2', kind: 'scene', title: 'The Tide', act: 1, chapter: 1, sequence: 2 },
  { id: 'S3', kind: 'scene', title: 'Ferry', act: 1, chapter: 2, sequence: 1 },
];
const ARC = { id: 'note_maren', slug: 'maren', sha256: 'sha-maren', character: { name: 'Maren' }, arc_type: 'positive', fields: {}, milestones: [{ index: 0, scene: 'S1', choice: 'Takes the ferry' }], body: '' };
const REL = {
  id: 'note_maren-pell',
  slug: 'maren-pell',
  name: 'Maren & Pell',
  a: { id: 'entry_maren', slug: 'maren', name: 'Maren', type: 'character' },
  b: { id: 'entry_pell', slug: 'pell', name: 'Pell', type: 'character' },
  baseline: 'Siblings',
  end_state: 'Estranged',
  sha256: 'sha-rel',
  body: 'Notes.',
  developments: [
    { scene: 'S1', scene_title: 'The Key', chapter: 1, sequence: 1, change: 'Trust breaks', a_view: 'Pell is hiding something', b_view: 'Maren is a threat' },
    { scene: 'S_GONE', scene_title: null, chapter: null, sequence: null, change: 'Lost', a_view: null, b_view: null },
  ],
};
const THREAD = { id: 'thread_key', slug: 'missing-key', title: 'The Missing Key', kind: 'mystery', status: 'open', setup: ['S1'], develop: ['S2', 'S3'], payoff: [] };
const DATA = { arcs: { arcs: [ARC], archived: [] }, relationships: { relationships: [REL], archived: [{ slug: 'old-pair', name: 'Old & Pair' }] }, threads: { threads: [THREAD] } };
const URLSTATE = (patch = {}) => ({ view: 'arcs', node: null, link: null, arc: null, relationship: null, structure: null, mode: null, filter: null, ...patch });
const lanesView = (props) => render(h(m.arcs.ArcsView, { bookId: 'b1', ...DATA, flow: { nodes: NODES }, url: URLSTATE(), wide: true, initialKinds: { arc: true, relationship: true, thread: true }, ...props }));

const storage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = String(v)), data };
};

test('requests: relationship urls, create request, update and developments bodies, failures', () => {
  assert.equal(m.req.relationshipsUrl('b 1'), '/api/books/b%201/relationships');
  assert.equal(m.req.relationshipUrl('b1', 'maren-pell'), '/api/books/b1/relationships/maren-pell');
  assert.equal(m.req.relationshipUrl('b1', 'maren-pell', '/developments'), '/api/books/b1/relationships/maren-pell/developments');
  assert.equal(m.req.threadsUrl('b1'), '/api/books/b1/threads');
  assert.deepEqual(m.req.createRelationshipRequest('b1', { a: 'entry_a', b: 'entry_b' }), { url: '/api/books/b1/relationships', body: { a: 'entry_a', b: 'entry_b' } });
  assert.deepEqual(m.req.createRelationshipRequest('b1', { a: 'x', b: 'y', fields: { baseline: ' Allies ', end_state: '' }, dryRun: true }).body, { a: 'x', b: 'y', fields: { baseline: 'Allies' }, dryRun: true });
  assert.deepEqual(m.req.updateRelationshipBody({ sha256: 'abc' }, { fields: { baseline: 'x', end_state: null } }), { fields: { baseline: 'x', end_state: null }, base_sha256: 'abc' });
  assert.deepEqual(m.req.updateRelationshipBody({ sha256: 'abc' }, { body: 'n', dryRun: true }), { body: 'n', base_sha256: 'abc', dryRun: true });
  assert.deepEqual(
    m.req.developmentsBody({ sha256: 'abc' }, [{ scene: 'S1', change: ' Trust breaks ', a_view: ' wary ', b_view: '' }, { scene: 'S2', change: 'Mends' }]),
    { developments: [{ scene: 'S1', change: 'Trust breaks', a_view: 'wary' }, { scene: 'S2', change: 'Mends' }], base_sha256: 'abc' },
  );
  assert.equal(m.req.developmentsBody({ sha256: 'a' }, [], { dryRun: true }).dryRun, true);
  assert.match(m.req.explainRelationshipFailure(409, { code: 'REFUSED_DUPLICATE_RELATIONSHIP' }), /already have a relationship/);
  assert.match(m.req.explainRelationshipFailure(400, { code: 'REFUSED_UNKNOWN_SCENE', index: 1 }), /development 2/);
  assert.equal(m.req.explainRelationshipFailure(409, { error: 'conflict' }), 'This relationship changed elsewhere; reloaded.');
  assert.deepEqual(m.req.relationshipChangesForScene(DATA.relationships, 'S1').map((x) => x.development.change), ['Trust breaks']);
  assert.deepEqual(m.req.relationshipChangesForScene(null, 'S1'), []);
});

test('model: the relationship param round-trips through the URL, and the tab is called Lanes', () => {
  assert.equal(m.model.parsePlanSearch('?view=arcs&relationship=maren-pell').relationship, 'maren-pell');
  const state = URLSTATE({ relationship: 'maren-pell' });
  const href = m.model.planUrl('b1', state);
  assert.equal(href, '/books/b1/plan?view=arcs&relationship=maren-pell');
  assert.deepEqual(m.model.parsePlanSearch(href.slice(href.indexOf('?'))), state);
  assert.equal(m.req.planHref('b1', { view: 'arcs', relationship: 'a b' }), '/books/b1/plan?view=arcs&relationship=a%20b');
  assert.equal(m.model.PLAN_VIEWS.find((v) => v.key === 'arcs').label, 'Lanes');
});

test('layoutLanes: three kinds under heading rows, S/D/P letters for threads, a marker per development', () => {
  const lanes = m.model.layoutLanes(
    [{ kind: 'arc', items: [ARC] }, { kind: 'relationship', items: [REL] }, { kind: 'thread', items: [THREAD] }, { kind: 'thread', items: [] }],
    NODES,
  );
  assert.deepEqual(lanes.rows.map((r) => (r.heading ? `# ${r.label}` : `${r.kind}:${r.slug}`)), ['# Character arcs', 'arc:maren', '# Relationships', 'relationship:maren-pell', '# Plot threads', 'thread:missing-key']);
  const ys = lanes.rows.map((r) => r.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, 'rows go top to bottom');
  const rel = lanes.rows.find((r) => r.slug === 'maren-pell');
  assert.deepEqual(rel.markers.map((x) => x.text), ['1']);
  assert.equal(rel.markers[0].name, 'Maren & Pell: Trust breaks in The Key');
  assert.equal(lanes.unplacedOther, 1, 'the development at a missing scene is counted, not drawn');
  const thread = lanes.rows.find((r) => r.slug === 'missing-key');
  assert.deepEqual(thread.markers.map((x) => x.text), ['S', 'D', 'D']);
  assert.deepEqual(thread.markers.map((x) => x.name), ['The Missing Key: setup in The Key', 'The Missing Key: development in The Tide', 'The Missing Key: development in Ferry']);
  assert.deepEqual(thread.markers.map((x) => x.role), ['setup', 'develop', 'develop']);
  assert.equal(new Set(lanes.rows.flatMap((r) => r.markers ?? []).map((x) => x.key)).size, 5, 'keys are unique');
  assert.equal(lanes.height, lanes.rows.at(-1).y + m.model.LANE_ROW_H + m.model.LANE_PAD);
  assert.deepEqual(m.model.layoutLanes([{ kind: 'arc', items: [] }], NODES).rows, []);
  assert.equal(m.model.layoutLanes([], NODES).height, 0);
  // a plain list of arcs still gives one row per arc and no headings
  assert.deepEqual(m.model.layoutLanes([ARC], NODES).rows.map((r) => [r.slug, r.name]), [['maren', 'Maren']]);
});

test('kind toggles: all on by default, remembered per viewer, and a broken storage is ignored', () => {
  assert.deepEqual(m.model.loadLaneKinds(storage()), { arc: true, relationship: true, thread: true });
  const s = storage();
  m.model.saveLaneKinds({ arc: true, relationship: false, thread: true }, s);
  assert.deepEqual(m.model.loadLaneKinds(s), { arc: true, relationship: false, thread: true });
  assert.deepEqual(m.model.loadLaneKinds(storage({ 'storyforge.plan.lanes.kinds': 'not json' })), { arc: true, relationship: true, thread: true });
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(m.model.loadLaneKinds(broken), { arc: true, relationship: true, thread: true });
  assert.doesNotThrow(() => m.model.saveLaneKinds({ arc: true }, broken));
  assert.deepEqual(m.model.loadLaneKinds(null), { arc: true, relationship: true, thread: true });
});

test('Lanes view: kind checkboxes, headings, markers with accessible names and visible S/D/P letters', () => {
  const html = lanesView({});
  for (const label of ['Character arcs', 'Relationships', 'Plot threads']) assert.match(html, new RegExp(`<input type="checkbox" checked=""/>${label}`), label);
  assert.match(html, /<h3 class="ln-heading"[^>]*>Plot threads<\/h3>/);
  assert.match(html, /aria-label="The Missing Key: setup in The Key"[^>]*><span aria-hidden="true">S<\/span>/);
  assert.match(html, /aria-label="The Missing Key: development in Ferry"[^>]*><span aria-hidden="true">D<\/span>/);
  assert.match(html, /aria-label="Maren & Pell: Trust breaks in The Key"/);
  assert.match(html, /aria-label="Maren: Takes the ferry in The Key"/);
  assert.match(html, /1 marker of a relationship or plot thread points to a scene that is not in the book/);
  assert.match(html, />New relationship…<\/button>/);
  const hidden = lanesView({ initialKinds: { arc: true, relationship: false, thread: false } });
  assert.doesNotMatch(hidden, /Maren & Pell: Trust breaks/);
  assert.doesNotMatch(hidden, /The Missing Key: setup/);
  assert.match(hidden, /aria-label="Maren: Takes the ferry in The Key"/);
  assert.match(lanesView({ initialKinds: { arc: false, relationship: false, thread: false } }), /Every kind of lane is hidden/);
});

test('Lanes list: kind headings, relationship developments with both views, thread S/D/P rows', () => {
  const html = lanesView({ url: URLSTATE({ mode: 'list' }) });
  assert.match(html, /<h2 id="ln-arcs-h" class="ln-kind-heading">Character arcs<\/h2>/);
  assert.match(html, /<h2 id="ln-relationships-h" class="ln-kind-heading">Relationships<\/h2>/);
  assert.match(html, /<h2 id="ln-threads-h" class="ln-kind-heading">Plot threads<\/h2>/);
  assert.match(html, /<h3 id="rel-h-maren-pell">Maren & Pell<\/h3>/);
  assert.match(html, /The Key<\/button>[^<]*— Trust breaks/);
  assert.match(html, /How Maren sees Pell: Pell is hiding something/);
  assert.match(html, /How Pell sees Maren: Maren is a threat/);
  assert.match(html, /<span class="tag"> missing scene<\/span>/);
  assert.match(html, /aria-label="Edit the relationship Maren & Pell"/);
  assert.match(html, /<h3 id="thread-h-missing-key">The Missing Key/);
  assert.match(html, /<span class="ln-letter" aria-hidden="true">S<\/span> <button[^>]*aria-label="The Missing Key: setup in The Key"/);
  assert.match(html, /— development/);
  assert.doesNotMatch(html, /arc-lanes"/);
});

test('Lanes view: archived relationships with Restore; selected relationship and thread panels', () => {
  const html = lanesView({});
  assert.match(html, /<summary>Archived relationships \(1\)<\/summary>/);
  assert.match(html, /aria-label="Restore the relationship Old & Pair"[^>]*>Restore<\/button>/);
  const rel = lanesView({ url: URLSTATE({ relationship: 'maren-pell' }), selectedDevelopment: { slug: 'maren-pell', index: 0 }, relationshipPanel: h('p', null, 'EDITOR') });
  assert.match(rel, /<h2 id="rel-panel-h">Relationship: Maren & Pell<\/h2>/);
  assert.match(rel, /<h3 id="rel-dev-h">Development 1: The Key<\/h3>/);
  assert.match(rel, /<a href="\/books\/b1\?scene=S1">Open scene<\/a>/);
  assert.match(rel, /EDITOR/);
  assert.match(lanesView({ url: URLSTATE({ relationship: 'nope' }) }), /That relationship is not there any more\./);
  const thread = lanesView({ selectedThread: { slug: 'missing-key', role: 'setup', scene: 'S1' } });
  assert.match(thread, /<h2 id="thread-panel-h">Thread: The Missing Key<\/h2>/);
  assert.match(thread, /Setup in The Key/);
  assert.match(thread, /<a href="\/books\/b1\?view=threads&thread=missing-key">Open thread<\/a>/);
  assert.match(thread, /<a href="\/books\/b1\?scene=S1">Open scene<\/a>/);
});

test('RelationshipEditor: fields, notes, developments with each side\'s view labelled, controls, Archive', () => {
  const html = render(h(m.editor.RelationshipEditor, { bookId: 'b1', relationship: REL, scenes: NODES }));
  assert.match(html, /<label for="rel-baseline">Baseline<\/label>/);
  assert.match(html, /<input id="rel-end_state"[^>]*value="Estranged"/);
  assert.match(html, />Save notes<\/button>/);
  assert.match(html, /<h4>Development 1<\/h4>/);
  assert.match(html, /<h4>Development 2<\/h4>/);
  assert.match(html, />How Maren sees Pell<\/label>/);
  assert.match(html, />How Pell sees Maren<\/label>/);
  assert.match(html, /<option value="S3">Ch 2: Ferry<\/option>/);
  assert.match(html, /<option value="S_GONE" selected="">Missing scene<\/option>/);
  assert.match(html, /<a href="\/books\/b1\?scene=S1">Open scene \(development 1\)<\/a>/);
  assert.match(html, /disabled="" aria-label="Move development 1 up"/);
  assert.match(html, /aria-label="Move development 2 down"/);
  assert.match(html, /aria-label="Remove development 2"/);
  assert.match(html, />Add development<\/button>/);
  assert.match(html, /<button type="button" class="btn btn-primary" disabled="">Save developments<\/button>/);
  assert.match(html, />Archive relationship<\/button>/);
  const shown = render(h(m.editor.RelationshipEditor, { bookId: 'b1', relationship: { ...REL, developments: [] }, scenes: NODES, state: { error: 'Nope.', message: 'Reloaded.' } }));
  assert.match(shown, /role="alert">Nope\./);
  assert.match(shown, /role="status">Reloaded\./);
  assert.match(shown, /No developments yet\./);
});

test('New relationship dialog: characters first, then other types; the chosen entry cannot be picked twice', () => {
  const entries = [
    { id: 'e_quay', slug: 'quay', title: 'The Quay', type: 'location' },
    { id: 'e_pell', slug: 'pell', title: 'Pell', type: 'character' },
    { id: 'e_maren', slug: 'maren', title: 'Maren', type: 'character' },
  ];
  assert.deepEqual(m.model.orderEntries(entries).map((e) => e.id), ['e_maren', 'e_pell', 'e_quay']);
  const html = render(h(m.editor.NewRelationshipDialog, { entries, onCreate: () => {}, onClose: () => {} }));
  assert.match(html, /aria-label="New relationship"/);
  assert.match(html, /<label for="new-rel-a">First entry \(A\)<\/label>/);
  assert.match(html, /<label for="new-rel-b">Second entry \(B\)<\/label>/);
  assert.ok(html.indexOf('>Maren<') < html.indexOf('>Pell<') && html.indexOf('>Pell<') < html.indexOf('>The Quay (location)<'));
  assert.match(html, />Start relationship<\/button>/);
});

test('ConnectDialog: both pickers have a Beats group of every live beat as "<structure>: <beat>"', () => {
  const structures = { structures: [{ slug: 'three-act', name: 'Three acts', beats: [{ id: 'beat_1', name: 'Inciting incident' }, { id: 'beat_2', name: 'Midpoint' }] }, { slug: 'mystery', name: 'Mystery', beats: [{ id: 'beat_3', name: 'Reveal' }] }] };
  const beats = m.req.beatOptions(structures);
  assert.deepEqual(beats, [{ id: 'beat_1', label: 'Three acts: Inciting incident' }, { id: 'beat_2', label: 'Three acts: Midpoint' }, { id: 'beat_3', label: 'Mystery: Reveal' }]);
  assert.deepEqual(m.req.beatOptions(null), []);
  const html = render(h(m.connect.ConnectDialog, { scenes: NODES, beats, onPreview: () => {}, onClose: () => {} }));
  assert.equal(html.match(/<optgroup label="Beats">/g).length, 2);
  assert.equal(html.match(/<option value="beat_1">Three acts: Inciting incident<\/option>/g).length, 2);
  assert.match(html, /<option value="beat_3">Mystery: Reveal<\/option>/);
  assert.doesNotMatch(render(h(m.connect.ConnectDialog, { scenes: NODES, onPreview: () => {}, onClose: () => {} })), /optgroup/);
});

test('REFUSED_BEAT_LINKED says how many links hold the beat', () => {
  assert.equal(m.req.explainStructureFailure(400, { code: 'REFUSED_BEAT_LINKED', links: ['a', 'b'] }), 'This beat is linked in Flow (2 links). Re-point those links first.');
  assert.equal(m.req.explainStructureFailure(400, { code: 'REFUSED_BEAT_LINKED', links: ['a'] }), 'This beat is linked in Flow (1 link). Re-point those links first.');
  assert.equal(m.req.explainStructureFailure(400, { code: 'REFUSED_BEAT_LINKED', links: [], archived_links: ['c'] }), 'This beat is linked in Flow (1 link). Re-point those links first; an archived link must be restored to change it.');
});

test('Flow: beat nodes get their own top row labelled Beats, and are listed as "<structure>: <beat>"', () => {
  const BEAT = { id: 'beat_1', kind: 'beat', title: 'Inciting incident', structure: { slug: 'three-act', name: 'Three acts' }, chapter: null, sequence: null };
  const layout = m.model.layoutGraph([BEAT, ...NODES]);
  assert.equal(layout.beatsRow.label, 'Beats');
  const beat = layout.nodes.find((n) => n.id === 'beat_1');
  const firstScene = layout.nodes.find((n) => n.id === 'S1');
  assert.ok(beat.y < firstScene.y, 'the beats row is above the scene columns');
  assert.equal(layout.columns.length, 2, 'a beat is not a chapter column');
  assert.equal(m.model.layoutGraph(NODES).beatsRow ?? null, null);
  assert.equal(m.model.beatLabel(BEAT), 'Three acts: Inciting incident');
  const link = { id: 'note_l', slug: 'key-beat', from: 'S1', to: 'beat_1', relation: 'enables', rationale: '', sha256: 's', from_title: 'The Key', to_title: 'Three acts: Inciting incident', from_kind: 'scene', to_kind: 'beat' };
  assert.equal(m.model.describeLink(link, new Map([...NODES, BEAT].map((n) => [n.id, n]))).sentence, 'The Key — enables → Three acts: Inciting incident');
  const html = render(h(m.flow.FlowView, { bookId: 'b1', flow: { nodes: [BEAT, ...NODES], edges: [] }, links: { links: [link], archived: [] }, url: { view: 'flow', node: null, link: null, arc: null, relationship: null, structure: null, mode: 'list', filter: null }, wide: true }));
  assert.match(html, /<h2 id="flow-beats-h">Beats<\/h2>/);
  assert.match(html, /Three acts: Inciting incident<\/button>/);
  assert.doesNotMatch(html, /Three acts: Inciting incident<\/button>[\s\S]*Scenes not linked yet[\s\S]*Three acts: Inciting incident<\/button>/, 'a beat is never listed as an unlinked scene');
  const graph = render(h(m.flow.FlowView, { bookId: 'b1', flow: { nodes: [BEAT, ...NODES], edges: [] }, links: { links: [link], archived: [] }, url: { view: 'flow', node: null, link: null, arc: null, relationship: null, structure: null, mode: 'graph', filter: null }, wide: true }));
  assert.match(graph, /class="flow-col-head"[^>]*>Beats<\/div>/);
  assert.match(graph, /ln-beat-node/);
});

test('scene Plan section: lists the relationship changes in the scene and links them to the Lanes view', () => {
  const view = (relationships) => render(h(m.section.ScenePlanView, { bookId: 'b1', sceneId: 'S1', plan: null, links: { links: [] }, relationships }));
  const html = view(DATA.relationships);
  assert.match(html, /<h3 class="plan-links-heading">Relationship changes in this scene<\/h3>/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=arcs&relationship=maren-pell">Maren & Pell: Trust breaks<\/a>/);
  assert.match(view({ relationships: [] }), /No relationship changes here\./);
  assert.doesNotMatch(view(null), /Relationship changes in this scene/);
});

test('Overview: counts relationships next to the arcs, when the number is present', () => {
  const overview = (counts) => ({
    story: { path: null, sha256: null, fields: Object.fromEntries(m.req.STORY_FIELDS.map((f) => [f.key, null])), body: '' },
    counts: { scenes: 4, planned_scenes: 1, links: 0, linked_scenes: 0, unlinked_scenes: 4, broken_links: 0, archived_links: 0, threads: 0, arcs: 2, ...counts },
    unlinked: [],
  });
  assert.match(render(h(m.overview.OverviewView, { bookId: 'b1', overview: overview({ relationships: 3 }) })), /<a href="\/books\/b1\/plan\?view=arcs">3 relationships<\/a>/);
  assert.doesNotMatch(render(h(m.overview.OverviewView, { bookId: 'b1', overview: overview({}) })), /relationship/);
});
