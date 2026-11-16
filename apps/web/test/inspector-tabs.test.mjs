// The scene inspector groups its sections into tabs: Scene, Links, Review, Problems, History.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let m;
let nav;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m = await vite.ssrLoadModule('/src/shell/Inspector.jsx');
  nav = await vite.ssrLoadModule('/src/codex/model.js');
});
after(async () => {
  await vite?.close();
});

const BOOK = { id: 'book_1', slug: 'salt-orchard', title: 'The Salt Orchard', path: '' };
const SCENE = {
  id: 'scene_2',
  title: 'The Key',
  path: 'manuscript/act-01/ch-001/0020-the-key.md',
  pov: 'maren-hollis',
  front_matter: { pov: 'maren-hollis', characters: ['maren-hollis'], locations: [], plot_threads: [] },
  body: 'The key was colder.\n',
  sha256: 'abc',
};
const NO_DIAGS = { items: [], error: null, loading: false };
const DIAGS = {
  items: [
    { code: 'SF101', severity: 'error', file: SCENE.path, location: 'line 1', message: 'one' },
    { code: 'SF102', severity: 'warning', file: SCENE.path, location: 'line 2', message: 'two' },
    { code: 'SF103', severity: 'warning', file: 'other.md', location: '', message: 'elsewhere' },
  ],
  error: null,
  loading: false,
};
const render = (props) => renderToStaticMarkup(h(m.SceneInspector, { book: BOOK, scene: SCENE, diagnostics: NO_DIAGS, timeline: null, notes: null, ...props }));
const tablist = (html) => /<div[^>]*role="tablist"[^>]*>[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
const tabNames = (html) => [...tablist(html).matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((x) => x[1].replace(/<[^>]*>/g, ''));
const keys = (tabs) => tabs.map((t) => t.key);
const ALL = { goal: true, scene: true, plan: true, linked: true, notes: true, events: true, research: true, continuity: true, comments: true, suggestions: true, problems: true, revisions: true, receipts: true };

test('a readable scene with every module on has the five tabs, Scene selected, in order', () => {
  const html = render({});
  assert.deepEqual(tabNames(html), ['Scene', 'Links', 'Review', 'Problems', 'History']);
  assert.match(html, /aria-label="Scene panel sections"/);
  const selected = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((x) => /aria-selected="true"/.test(x[0]));
  assert.deepEqual(selected, [true, false, false, false, false]);
  assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 5);
});

test('the Problems tab shows the number of problems of this scene', () => {
  assert.deepEqual(tabNames(render({ diagnostics: DIAGS })), ['Scene', 'Links', 'Review', 'Problems2', 'History']);
  assert.deepEqual(tabNames(render({})), ['Scene', 'Links', 'Review', 'Problems', 'History']);
});

test('every section is still in the markup; only the inactive panels are hidden', () => {
  const html = render({ diagnostics: DIAGS });
  for (const title of ['Problems', 'Book problems', 'Revisions']) assert.match(html, new RegExp(`<h2[^>]*>${title}</h2>`), title);
  const panels = [...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((x) => x[0]);
  assert.equal(panels.length, 5);
  assert.deepEqual(panels.map((p) => /\shidden=""/.test(p)), [false, true, true, true, true]);
  assert.ok(html.includes('elsewhere'), 'book problems are in the markup');
});

test('without timeline and research data, Links still shows for the linked entries', () => {
  const html = render({ timeline: undefined, notes: undefined });
  assert.ok(tabNames(html).includes('Links'));
  assert.ok(!/<h2[^>]*>Events<\/h2>/.test(html) && !/<h2[^>]*>Research<\/h2>/.test(html));
});

test('an unreadable scene has no History tab', () => {
  const html = render({ scene: { ...SCENE, problem: 'bad front matter' } });
  assert.ok(!tabNames(html).includes('History'));
  assert.ok(tabNames(html).includes('Review'), 'continuity keeps Review');
});

test('without a scene (Read view) only book problems are drawn, with no tablist', () => {
  const html = render({ scene: null, diagnostics: DIAGS });
  assert.ok(!html.includes('role="tablist"') && !html.includes('role="tabpanel"'));
  assert.match(html, /<h2[^>]*>Book problems<\/h2>/);
});

test('inspectorTabs: a tab needs a section that is given, whose module is on and which the layout shows', () => {
  const on = () => true;
  assert.deepEqual(keys(m.inspectorTabs({ has: ALL, moduleOn: on, pinned: null })), ['scene', 'links', 'review', 'problems', 'history']);
  // timeline and research off, nothing else for Links
  const off = (id) => id !== 'timeline' && id !== 'research';
  assert.deepEqual(keys(m.inspectorTabs({ has: ALL, moduleOn: off, pinned: null })), ['scene', 'links', 'review', 'problems', 'history']);
  const noLinked = m.inspectorTabs({ has: ALL, moduleOn: off, pinned: ['goal', 'events', 'research', 'problems'] });
  assert.deepEqual(keys(noLinked), ['scene', 'problems']);
  // continuity, suggestions off; comments not readable
  assert.deepEqual(keys(m.inspectorTabs({ has: { ...ALL, comments: false }, moduleOn: (id) => id !== 'continuity' && id !== 'suggestions', pinned: null })), ['scene', 'links', 'problems', 'history']);
  // not readable: no scene facts, comments, suggestions, revisions, receipts
  const unreadable = { ...ALL, scene: false, comments: false, suggestions: false, revisions: false, receipts: false };
  assert.deepEqual(keys(m.inspectorTabs({ has: unreadable, moduleOn: on, pinned: null })), ['scene', 'links', 'review', 'problems']);
  assert.equal(m.inspectorTabs({ has: ALL, moduleOn: on, pinned: null, problemCount: 3 }).find((t) => t.key === 'problems').count, 3);
  assert.equal(m.inspectorTabs({ has: ALL, moduleOn: on, pinned: null, problemCount: 0 }).find((t) => t.key === 'problems').count, undefined);
});

test('defaultInspectorTab follows the layout order: Writing opens Scene, Review opens Review', () => {
  const on = () => true;
  const review = ['continuity', 'comments', 'suggestions', 'receipts', 'revisions', 'problems', 'book-problems', 'goal'];
  const writing = m.inspectorTabs({ has: ALL, moduleOn: on, pinned: null });
  assert.equal(m.defaultInspectorTab(writing, null), 'scene');
  const rv = m.inspectorTabs({ has: ALL, moduleOn: on, pinned: review });
  assert.equal(m.defaultInspectorTab(rv, review), 'review');
  assert.equal(m.defaultInspectorTab([], null), null);
});

test('keyboard: the tab order wraps and Home/End jump to the ends', () => {
  assert.equal(nav.nextTabIndex(0, 'ArrowRight', 5), 1);
  assert.equal(nav.nextTabIndex(4, 'ArrowRight', 5), 0);
  assert.equal(nav.nextTabIndex(0, 'ArrowLeft', 5), 4);
  assert.equal(nav.nextTabIndex(2, 'Home', 5), 0);
  assert.equal(nav.nextTabIndex(2, 'End', 5), 4);
});
