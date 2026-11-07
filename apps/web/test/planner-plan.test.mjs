// The Plan tab (Story Planner M2): the pure model (URL, graph layout, line styles), the presentational Overview, Flow (list and graph) and Connect dialog with fixture data, and the route.
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
  m.overview = await vite.ssrLoadModule('/src/planner/OverviewView.jsx');
  m.routes = await vite.ssrLoadModule('/src/routes.js');
});
after(async () => {
  await vite?.close();
});

const text = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => text(renderToStaticMarkup(el));

const NODES = [
  { id: 'S1', kind: 'scene', title: 'The Key', summary: 'Maren finds the key.', status: 'drafting', pov: 'maren', act: 1, chapter: 1, sequence: 1, plan: true },
  { id: 'S2', kind: 'scene', title: 'The Tide', summary: 'The tide comes in.', status: 'outline', pov: 'maren', act: 1, chapter: 1, sequence: 2, plan: false },
  { id: 'S3', kind: 'scene', title: 'Ferry', summary: 'The ferry crossing.', status: 'outline', pov: 'pell', act: 1, chapter: 2, sequence: 1, plan: false },
  { id: 'S4', kind: 'scene', title: '', summary: '', status: 'final', pov: null, act: 2, chapter: 3, sequence: 1, plan: false },
];
const LINK = (slug, from, to, relation, extra = {}) => ({ id: `note_${slug}`, slug, path: `planning/links/${slug}.md`, from, to, relation, rationale: '', created: '2026-11-05', sha256: `sha-${slug}`, from_title: null, to_title: null, problems: [], ...extra });
const LINKS = {
  links: [
    LINK('key-ferry', 'S1', 'S3', 'therefore', { rationale: 'The key fails, so Maren takes the ferry.', from_title: 'The Key', to_title: 'Ferry' }),
    LINK('tide-key', 'S2', 'S1', 'pays_off', { from_title: 'The Tide', to_title: 'The Key' }),
    LINK('gone', 'S1', 'S_GONE', 'but', { from_title: 'The Key', to_title: null }),
  ],
  archived: [LINK('old', 'S3', 'S2', 'reveals', { from_title: 'Ferry', to_title: 'The Tide' })],
};
const URLSTATE = (patch = {}) => ({ view: 'flow', node: null, link: null, mode: null, filter: null, ...patch });

test('model: parsePlanSearch defaults, and planUrl round-trips every part', () => {
  assert.deepEqual(m.model.parsePlanSearch(''), { view: 'overview', node: null, link: null, arc: null, relationship: null, structure: null, mode: null, filter: null });
  assert.equal(m.model.parsePlanSearch('?view=nonsense&mode=wat&filter=x').view, 'overview');
  assert.equal(m.model.parsePlanSearch('?mode=wat').mode, null);
  const state = { view: 'flow', node: 'scene_01 A', link: 'key-ferry', arc: null, relationship: null, structure: null, mode: 'list', filter: 'unlinked' };
  const href = m.model.planUrl('book one', state);
  assert.equal(href, '/books/book%20one/plan?view=flow&link=key-ferry&node=scene_01%20A&mode=list&filter=unlinked');
  assert.deepEqual(m.model.parsePlanSearch(href.slice(href.indexOf('?'))), state);
  assert.equal(m.model.planUrl('b', { view: 'overview', node: null, link: null, mode: null, filter: null }), '/books/b/plan');
  assert.equal(m.model.planUrl('b', URLSTATE({ node: 'S1' }), { node: null, link: 'x' }), '/books/b/plan?view=flow&link=x');
  assert.equal(m.req.planHref('b1', { view: 'flow', mode: 'list', filter: 'unlinked' }), '/books/b1/plan?view=flow&mode=list&filter=unlinked');
});

test('model: layoutGraph puts one column per chapter in reading order, stacked by sequence, and is deterministic', () => {
  const shuffled = [NODES[1], NODES[0], NODES[2], NODES[3]]; // S2 (seq 2) before S1 (seq 1) in the same chapter
  const a = m.model.layoutGraph(NODES);
  const b = m.model.layoutGraph(NODES);
  assert.deepEqual(a, b);
  assert.equal(a.columns.length, 3);
  assert.deepEqual(a.columns.map((c) => c.label), ['Ch 1', 'Ch 2', 'Ch 3']);
  const at = (id) => a.nodes.find((n) => n.id === id);
  assert.equal(at('S1').x, at('S2').x, 'the same chapter shares a column');
  assert.ok(at('S3').x > at('S1').x && at('S4').x > at('S3').x, 'columns run left to right in reading order');
  assert.ok(at('S2').y > at('S1').y, 'scenes stack by sequence');
  assert.equal(at('S1').row, 0);
  assert.equal(at('S2').row, 1);
  const s = m.model.layoutGraph(shuffled);
  assert.ok(s.nodes.find((n) => n.id === 'S1').y < s.nodes.find((n) => n.id === 'S2').y, 'sequence orders a column whatever the input order');
  assert.ok(a.width > 0 && a.height > 0);
  assert.deepEqual(m.model.layoutGraph([]), { nodes: [], columns: [], width: 0, height: 0 });
  // a chapter number used in two acts is two columns
  assert.equal(m.model.layoutGraph([{ id: 'x', act: 1, chapter: 1, sequence: 1 }, { id: 'y', act: 2, chapter: 1, sequence: 1 }]).columns.length, 2);
});

test('model: every relation has a stroke group, the groups are drawn differently, and the legend names every relation', () => {
  const R = m.req.RELATIONS.map((r) => r.value);
  assert.equal(R.length, 10);
  assert.deepEqual(['therefore', 'enables', 'motivates'].map((r) => m.model.relationStroke(r).group), ['solid', 'solid', 'solid']);
  assert.deepEqual(['but', 'prevents'].map((r) => m.model.relationStroke(r).group), ['dashed', 'dashed']);
  assert.deepEqual(['reveals', 'foreshadows', 'pays_off'].map((r) => m.model.relationStroke(r).group), ['dotted', 'dotted', 'dotted']);
  assert.deepEqual(['parallel', 'other', 'unknown'].map((r) => m.model.relationStroke(r).group), ['long-dash', 'long-dash', 'long-dash']);
  const dashes = ['solid', 'dashed', 'dotted', 'long-dash'].map((g) => m.model.relationStroke(R.find((r) => m.model.RELATION_STYLES[r] === g)).dasharray);
  assert.equal(dashes[0], null);
  assert.equal(new Set(dashes).size, 4, 'four distinct line styles');
  const legend = m.model.strokeLegend().join(' ');
  for (const r of R) assert.ok(legend.includes(m.req.relationLabel(r)), r);
});

test('model: describeLink writes the sentence, marks a missing scene, and filter and unlinked helpers work', () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));
  assert.equal(m.model.describeLink(LINKS.links[0], byId).sentence, 'The Key — therefore → Ferry');
  assert.equal(m.model.describeLink(LINKS.links[1], byId).sentence, 'The Tide — pays off → The Key');
  assert.equal(m.model.describeLink(LINKS.links[2], byId).sentence, 'The Key — but → Missing scene (missing scene)');
  assert.equal(m.model.describeLink(LINKS.links[2], null).broken, true);
  assert.equal(m.model.describeLink(LINKS.links[0], null).broken, false);
  assert.equal(m.model.describeLink({ from: 'S4', to: 'S1', relation: 'but' }, byId).sentence, 'Untitled scene — but → The Key');
  assert.deepEqual(m.model.filterNodes(NODES, 'KEY').map((n) => n.id), ['S1']);
  assert.deepEqual(m.model.filterNodes(NODES, 'untitled').map((n) => n.id), ['S4']);
  assert.equal(m.model.filterNodes(NODES, '  ').length, 4);
  assert.deepEqual(m.model.unlinkedNodes(NODES, LINKS.links).map((n) => n.id), ['S4']);
});

test('requests: link bodies carry base_sha256, an empty rationale is left out', () => {
  assert.deepEqual(m.req.createLinkRequest('b1', { from: 'A', to: 'B', relation: 'but', rationale: '  ' }), { url: '/api/books/b1/links', body: { from: 'A', to: 'B', relation: 'but' } });
  assert.deepEqual(m.req.createLinkRequest('b1', { from: 'A', to: 'B', relation: 'but', rationale: ' why ' }).body, { from: 'A', to: 'B', relation: 'but', rationale: 'why' });
  assert.deepEqual(m.req.reverseLinkBody({ from: 'A', to: 'B', sha256: 'x' }), { from: 'B', to: 'A', base_sha256: 'x' });
  assert.deepEqual(m.req.updateLinkBody({ sha256: 'x' }, { relation: 'but' }), { relation: 'but', base_sha256: 'x' });
  assert.equal(m.req.linkUrl('b 1', 'a/b', '/archive'), '/api/books/b%201/links/a%2Fb/archive');
  assert.deepEqual(m.req.storyPlanBody({ fields: { premise: 'x' }, sha: 'abc' }), { fields: { premise: 'x' }, base_sha256: 'abc' });
  assert.deepEqual(m.req.storyPlanBody({ body: 'notes' }), { fields: {}, body: 'notes', base_sha256: null });
  assert.equal(m.req.STORY_FIELDS.length, 7);
  assert.equal(m.req.explainLinkFailure(400, { code: 'REFUSED_SELF_LINK' }), "A scene can't lead to itself.");
  assert.equal(m.req.explainLinkFailure(409, { code: 'REFUSED_DUPLICATE_LINK' }), 'These scenes already have that link.');
  assert.equal(m.req.isStaleWrite(409, { error: 'conflict', current: {} }), true);
  assert.equal(m.req.isStaleWrite(409, { error: 'conflict', code: 'REFUSED_DUPLICATE_LINK' }), false);
});

const OVERVIEW = {
  story: { path: 'planning/story.md', sha256: 's1', fields: { premise: 'A key opens the wrong door.', logline: null, theme_question: null, central_conflict: null, protagonist_goal: null, stakes: null, protagonist: 'maren' }, body: 'Some notes.' },
  counts: { scenes: 9, planned_scenes: 8, links: 7, linked_scenes: 5, unlinked_scenes: 4, broken_links: 1, archived_links: 2, threads: 3 },
  unlinked: [{ id: 'S4', title: '' }, { id: 'S2', title: 'The Tide' }],
};

test('Overview: seven labelled fields, notes with a Save button, counts as sentences that link into Flow, the unlinked scenes', () => {
  const html = render(h(m.overview.OverviewView, { bookId: 'b1', overview: OVERVIEW, characters: [{ slug: 'maren', title: 'Maren' }, { slug: 'pell', title: 'Pell' }] }));
  for (const label of ['Premise', 'Logline', 'Theme / question', 'Central conflict', 'Protagonist (Codex entry)', "Protagonist's goal", 'Stakes', 'Story notes']) assert.match(html, new RegExp(`<label for="[^"]+">${label.replace(/[()/]/g, '\\$&')}</label>`), label);
  assert.match(html, /value="A key opens the wrong door\."/);
  assert.match(html, /<option value="maren" selected="">Maren<\/option>/);
  assert.match(html, />Save notes</);
  assert.match(html, /8 of 9 scenes have a plan/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=flow&mode=list&filter=unlinked">5 scenes linked, 4 not linked<\/a>/);
  assert.match(html, /1 link points to a missing scene/);
  assert.match(html, /2 archived links/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=flow&node=S2">The Tide<\/a>/);
  assert.match(html, /Untitled scene/);
  assert.match(html, />Connect scenes…</);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=flow" class="btn">Open Flow<\/a>/);
});

test('Overview: an empty book gets friendly words, no errors', () => {
  const empty = { story: { path: null, sha256: null, fields: Object.fromEntries(m.req.STORY_FIELDS.map((f) => [f.key, null])), body: '' }, counts: { scenes: 0, planned_scenes: 0, links: 0, linked_scenes: 0, unlinked_scenes: 0, broken_links: 0, archived_links: 0, threads: 0 }, unlinked: [] };
  const html = render(h(m.overview.OverviewView, { bookId: 'b1', overview: empty }));
  assert.match(html, /This book has no scenes yet/);
  assert.doesNotMatch(html, /role="alert"|NaN|undefined/);
});

test('routes: Plan is a project tab right after Manuscript at /plan, parses as a tab, and follows the planner module', () => {
  const keys = m.routes.PROJECT_TABS.map((t) => t.key);
  assert.equal(keys[keys.indexOf('manuscript') + 1], 'plan');
  assert.deepEqual(m.routes.PROJECT_TABS.find((t) => t.key === 'plan'), { key: 'plan', label: 'Plan', path: '/plan' });
  assert.deepEqual(m.routes.parseRoute('/books/b1/plan', '?view=flow'), { name: 'tab', bookId: 'b1', tab: 'plan' });
  assert.equal(m.routes.tabHref('b1', 'plan'), '/books/b1/plan');
  assert.equal(m.routes.tabModule('plan'), 'planner');
});
