// What-if branches in the Plan tab's Flow (Story Planner M8): the branch name rule, the filter, the URL, the Connect dialog and link panel field, and the dotted drawing.
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
  m.flow = await vite.ssrLoadModule('/src/planner/FlowView.jsx');
  m.graph = await vite.ssrLoadModule('/src/planner/FlowGraph.jsx');
  m.connect = await vite.ssrLoadModule('/src/planner/ConnectDialog.jsx');
  m.panel = await vite.ssrLoadModule('/src/planner/LinkPanel.jsx');
});
after(async () => {
  await vite?.close();
});

const text = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => text(renderToStaticMarkup(el));

const NODES = [
  { id: 'S1', kind: 'scene', title: 'The Key', summary: '', status: 'drafting', act: 1, chapter: 1, sequence: 1 },
  { id: 'S2', kind: 'scene', title: 'The Tide', summary: '', status: 'outline', act: 1, chapter: 1, sequence: 2 },
  { id: 'S3', kind: 'scene', title: 'Ferry', summary: '', status: 'outline', act: 1, chapter: 2, sequence: 1 },
];
const edge = (slug, from, to, relation, branch = null) => ({ id: `note_${slug}`, slug, from, to, relation, rationale: '', sha256: `sha-${slug}`, broken: false, branch });
const EDGES = [edge('key-ferry', 'S1', 'S3', 'therefore'), edge('sink', 'S1', 'S2', 'but', 'ferry-sinks'), edge('swim', 'S2', 'S3', 'enables', 'ferry-sinks'), edge('storm', 'S3', 'S1', 'reveals', 'storm')];
const link = (e) => ({ ...e, from_title: null, to_title: null, problems: [], created: '2026-11-05' });
const LINKS = { links: EDGES.map(link), archived: [] };
const FLOW = { nodes: NODES, edges: EDGES, branches: ['ferry-sinks', 'storm'] };
const URLSTATE = (patch = {}) => ({ view: 'flow', node: null, link: null, mode: 'graph', filter: null, branch: null, ...patch });
const labels = (html) => (html.match(/class="flow-edge-label"/g) ?? []).length;

test('validateBranch: empty is the main plan, a slug passes, anything else says the rule', () => {
  const v = m.model.validateBranch;
  assert.deepEqual(v(''), { value: null, error: null });
  assert.deepEqual(v('   '), { value: null, error: null });
  assert.deepEqual(v(null), { value: null, error: null });
  assert.deepEqual(v(' ferry-sinks '), { value: 'ferry-sinks', error: null });
  assert.deepEqual(v('a1-b2'), { value: 'a1-b2', error: null });
  for (const bad of ['Ferry', 'ferry sinks', 'ferry_sinks', '-x', 'x-', 'a--b', 'é', 'x'.repeat(41)]) {
    const r = v(bad);
    assert.equal(r.value, null, bad);
    assert.equal(r.error, m.model.BRANCH_RULE, bad);
  }
  assert.equal(v('x'.repeat(40)).value, 'x'.repeat(40));
  assert.match(m.model.BRANCH_RULE, /lowercase letters, digits and hyphens/);
});

test('edgesForBranch: main plan by default, one branch, or all', () => {
  const ids = (list) => list.map((e) => e.slug);
  assert.deepEqual(ids(m.model.edgesForBranch(EDGES, null)), ['key-ferry']);
  assert.deepEqual(ids(m.model.edgesForBranch(EDGES, undefined)), ['key-ferry']);
  assert.deepEqual(ids(m.model.edgesForBranch(EDGES, 'ferry-sinks')), ['sink', 'swim']);
  assert.deepEqual(ids(m.model.edgesForBranch(EDGES, 'nope')), []);
  assert.deepEqual(ids(m.model.edgesForBranch(EDGES, m.model.ALL_BRANCHES)), ['key-ferry', 'sink', 'swim', 'storm']);
  assert.deepEqual(ids(m.model.edgesForBranch([{ slug: 'old' }], null)), ['old']);
});

test('branchNames: the flow list plus what the edges use, sorted and unique', () => {
  assert.deepEqual(m.model.branchNames(['storm', 'b'], EDGES), ['b', 'ferry-sinks', 'storm']);
  assert.deepEqual(m.model.branchNames(null, EDGES, LINKS.links), ['ferry-sinks', 'storm']);
  assert.deepEqual(m.model.branchNames(undefined), []);
  assert.equal(m.model.branchPrefix({ branch: 'storm' }), '[storm] ');
  assert.equal(m.model.branchPrefix({ branch: null }), '');
});

test('URL: branch round trips, the empty query is unchanged, a bad value is the main plan', () => {
  assert.deepEqual(m.model.parsePlanSearch(''), { view: 'overview', node: null, link: null, arc: null, relationship: null, structure: null, mode: null, filter: null });
  assert.equal(m.model.branchFromSearch(''), null);
  assert.equal(m.model.branchFromSearch('?view=flow&branch=ferry-sinks'), 'ferry-sinks');
  assert.equal(m.model.branchFromSearch('?branch=*'), '*');
  assert.equal(m.model.branchFromSearch('?branch=Bad%20Name'), null);
  const state = { ...m.model.parsePlanSearch('?view=flow'), branch: 'ferry-sinks' };
  const href = m.model.planUrl('b1', state);
  assert.equal(href, '/books/b1/plan?view=flow&branch=ferry-sinks');
  assert.equal(m.model.branchFromSearch(href.slice(href.indexOf('?'))), 'ferry-sinks');
  const all = m.model.planUrl('b1', state, { branch: m.model.ALL_BRANCHES });
  assert.equal(m.model.branchFromSearch(all.slice(all.indexOf('?'))), '*');
  assert.equal(m.model.planUrl('b1', state, { branch: null }), '/books/b1/plan?view=flow');
  assert.equal(m.req.planHref('b1', { view: 'flow', link: 'sink', branch: 'ferry-sinks' }), '/books/b1/plan?view=flow&link=sink&branch=ferry-sinks');
  assert.equal(m.req.planHref('b1', { view: 'flow', branch: null }), '/books/b1/plan?view=flow');
});

test('requests: a link is created with its branch only when it has one, and a branch can be removed', () => {
  assert.deepEqual(m.req.createLinkRequest('b1', { from: 'S1', to: 'S2', relation: 'but', branch: ' ferry-sinks ' }).body, { from: 'S1', to: 'S2', relation: 'but', branch: 'ferry-sinks' });
  assert.deepEqual(m.req.createLinkRequest('b1', { from: 'S1', to: 'S2', relation: 'but', branch: null }).body, { from: 'S1', to: 'S2', relation: 'but' });
  assert.deepEqual(m.req.createLinkRequest('b1', { from: 'S1', to: 'S2', relation: 'but', branch: '' }).body, { from: 'S1', to: 'S2', relation: 'but' });
  assert.deepEqual(m.req.updateLinkBody({ sha256: 's' }, { branch: null }), { branch: null, base_sha256: 's' });
});

test('describeLink: a branch link is prefixed in its sentence and name', () => {
  const nodes = new Map(NODES.map((n) => [n.id, n]));
  const d = m.model.describeLink(link(EDGES[1]), nodes);
  assert.equal(d.sentence, '[ferry-sinks] The Key — but → The Tide');
  assert.equal(d.name, '[ferry-sinks] The Key but The Tide');
  assert.equal(m.model.describeLink(link(EDGES[0]), nodes).sentence, 'The Key — therefore → Ferry');
});

test('Flow graph: branch edges are dotted and labelled [branch]', () => {
  const html = render(h(m.graph.FlowGraph, { nodes: NODES, edges: EDGES }));
  const paths = html.match(/<path[^>]*class="flow-edge[^"]*"[^>]*>/g) ?? [];
  assert.equal(paths.length, 4);
  const dotted = paths.filter((p) => p.includes('flow-edge-branch'));
  assert.equal(dotted.length, 3);
  assert.ok(dotted.every((p) => p.includes('stroke-dasharray="2 4"')));
  assert.ok(!paths.find((p) => !p.includes('flow-edge-branch')).includes('stroke-dasharray="2 4"'));
  assert.match(html, />\[ferry-sinks\] but</);
  assert.match(html, />therefore</);
});

test('Flow view: the Branch filter picks what is drawn and listed', () => {
  const view = (url, extra = {}) => render(h(m.flow.FlowView, { bookId: 'b1', flow: FLOW, links: LINKS, url: URLSTATE(url), wide: true, ...extra }));
  const main = view({});
  assert.match(main, /<label for="flow-branch">Branch<\/label>/);
  assert.match(main, /<option value="" selected="">Main plan<\/option>/);
  assert.match(main, /<option value="ferry-sinks">ferry-sinks<\/option>/);
  assert.match(main, /<option value="\*">All<\/option>/);
  assert.equal(labels(main), 1);
  assert.equal(labels(view({ branch: 'ferry-sinks' })), 2);
  assert.equal(labels(view({ branch: '*' })), 4);
  const list = view({ mode: 'list', branch: 'storm' });
  assert.match(list, /\[storm\] Ferry — reveals → The Key/);
  assert.ok(!list.includes('The Key — therefore → Ferry'));
  assert.match(main, /Download SVG/);
});

test('Connect dialog: the Branch field with its rule and datalist', () => {
  const html = render(h(m.connect.ConnectDialog, { scenes: NODES, links: LINKS.links, branches: ['ferry-sinks', 'storm'], initialFrom: 'S1', onPreview() {}, onClose() {} }));
  assert.match(html, /<label for="connect-branch">Branch \(what-if\)<\/label>/);
  assert.match(html, /list="connect-branch-list"/);
  assert.match(html, /<datalist id="connect-branch-list"><option value="ferry-sinks"><\/option><option value="storm"><\/option><\/datalist>/);
  assert.match(html, /Leave empty for the main plan\. Use lowercase letters, digits and hyphens/);
  const withBranch = render(h(m.connect.ConnectDialog, { scenes: NODES, branches: [], initialBranch: 'storm', onPreview() {}, onClose() {} }));
  assert.match(withBranch, /id="connect-branch"[^>]*value="storm"/);
});

test('Link panel: the Branch field shows the link branch and its rule', () => {
  const html = render(h(m.panel.LinkPanel, { link: link(EDGES[1]), nodeById: new Map(NODES.map((n) => [n.id, n])), branches: ['ferry-sinks'] }));
  assert.match(html, /<label for="link-branch">Branch \(what-if\)<\/label>/);
  assert.match(html, /id="link-branch"[^>]*value="ferry-sinks"/);
  assert.match(html, /\[ferry-sinks\] The Key — but → The Tide/);
  assert.match(html, /lowercase letters, digits and hyphens/);
});
