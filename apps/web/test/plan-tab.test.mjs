// The Plan tab is the canvas page (M10 J-plan-tab): route redirect from /canvas, the new hrefs, deep links (legacyPlanTarget), the remembered choices, and List mode's pure model. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasHref } from '../src/canvas/model.js';
import { legacyPlanTarget, resolvePlanTarget } from '../src/canvas/plan/deepLink.js';
import { buildPlanList, locateListItem } from '../src/canvas/plan/listModel.js';
import { chooseCanvas, loadViewMode } from '../src/canvas/plan/selectors.js';
import { planHref } from '../src/planner/requests.js';
import { PROJECT_TABS, parseRoute, redirectFor, tabHref } from '../src/routes.js';

test('there is one Plan tab and no Canvas tab', () => {
  assert.deepEqual(PROJECT_TABS.filter((t) => t.key === 'plan'), [{ key: 'plan', label: 'Plan', path: '/plan' }]);
  assert.equal(PROJECT_TABS.some((t) => t.key === 'canvas'), false);
  assert.equal(tabHref('b', 'canvas'), '/books/b');
});

test('the old canvas address parses as the Plan tab and redirects with the same search', () => {
  assert.deepEqual(parseRoute('/books/x/canvas', '?canvas=y'), { name: 'tab', bookId: 'x', tab: 'plan' });
  assert.equal(redirectFor('/books/x/canvas', '?canvas=y'), '/books/x/plan?canvas=y');
  assert.equal(redirectFor('/books/x/canvas/', ''), '/books/x/plan');
  assert.equal(redirectFor('/books/b%201/canvas', '?canvas=a&select=n1'), '/books/b%201/plan?canvas=a&select=n1');
  assert.equal(redirectFor('/books/x/plan', '?canvas=y'), null);
  assert.equal(redirectFor('/books/x', ''), null);
  assert.equal(redirectFor('/books/x/constructor', ''), null);
  assert.equal(redirectFor('/settings', ''), null);
});

test('canvasHref points at the Plan tab', () => {
  assert.equal(canvasHref('b1'), '/books/b1/plan');
  assert.equal(canvasHref('b1', 'story-plan'), '/books/b1/plan?canvas=story-plan');
});

test('planHref: select gives the id form, the old forms are unchanged', () => {
  assert.equal(planHref('b1', { select: 'note_1' }), '/books/b1/plan?select=note_1');
  assert.equal(planHref('b1', { select: 'a b', branch: 'mutiny', view: 'flow' }), '/books/b1/plan?select=a%20b&branch=mutiny');
  assert.equal(planHref('b1', { select: '' , view: 'flow' }), '/books/b1/plan?view=flow');
  assert.equal(planHref('b1', { view: 'clues', clue: 'torn-map' }), '/books/b1/plan?view=clues&clue=torn-map');
});

test('legacyPlanTarget maps every old Plan-tab form', () => {
  const none = { select: null, slug: null, branch: null, series: false };
  assert.deepEqual(legacyPlanTarget(''), none);
  assert.deepEqual(legacyPlanTarget('?canvas=story-plan'), none);
  assert.deepEqual(legacyPlanTarget('?view=overview'), none);
  assert.deepEqual(legacyPlanTarget('?select=note_a'), { ...none, select: 'note_a' });
  assert.deepEqual(legacyPlanTarget('?view=flow&node=S1'), { ...none, select: 'S1' });
  assert.deepEqual(legacyPlanTarget('?view=flow&link=a-b'), none);
  assert.deepEqual(legacyPlanTarget('?view=structure&structure=three-act'), { ...none, slug: { kind: 'structure', slug: 'three-act' } });
  assert.deepEqual(legacyPlanTarget('?view=structure'), none);
  assert.deepEqual(legacyPlanTarget('?view=clues&clue=torn-map'), { ...none, slug: { kind: 'clue', slug: 'torn-map' } });
  assert.deepEqual(legacyPlanTarget('?view=arcs&arc=maren'), { ...none, slug: { kind: 'arc', slug: 'maren' } });
  assert.deepEqual(legacyPlanTarget('?view=arcs&relationship=maren-pell'), { ...none, slug: { kind: 'relationship', slug: 'maren-pell' } });
  assert.deepEqual(legacyPlanTarget('?view=synopsis&synopsis=my-short'), { ...none, slug: { kind: 'synopsis', slug: 'my-short' } });
  assert.deepEqual(legacyPlanTarget('?view=flow&branch=ferry-sinks'), { ...none, branch: 'ferry-sinks' });
  assert.deepEqual(legacyPlanTarget('?view=flow&branch=*'), none, 'every branch is not a branch');
  assert.deepEqual(legacyPlanTarget('?select=n1&branch=mutiny'), { ...none, select: 'n1', branch: 'mutiny' });
  assert.deepEqual(legacyPlanTarget('?view=series'), { ...none, series: true });
  assert.deepEqual(legacyPlanTarget('?select=n1&clue=x').slug, null, 'an id wins over a slug');
});

const plan = {
  storyPlan: { id: 'note_story', fields: { logline: 'A ferry, a key.', premise: 'P' } },
  structures: {
    structures: [
      { id: 'st1', slug: 'three-act', name: 'Three acts', primary: true, beats: [{ id: 'b1', name: 'Setup', scenes: ['s1', 's2'] }, { id: 'b2', name: 'Turn', scenes: [{ id: 's2' }, 's3'] }, { id: 'b3', name: 'End', scenes: [] }] },
      { id: 'st2', slug: 'hero', name: 'Hero', beats: [{ id: 'h1', name: 'Call', scenes: ['s4'] }] },
    ],
  },
  clues: { clues: [{ id: 'c1', slug: 'torn-map', fact: 'The map is torn', kind: 'clue', planted: [{ id: 's1' }], revealed: { id: 's3' } }, { id: 'c2', slug: 'x', fact: 'Late', red_herring: true, planted: [], revealed: null }] },
  arcs: { arcs: [{ id: 'a1', slug: 'maren', character: { name: 'Maren' }, fields: { start_state: 'afraid', end_state: 'brave' } }] },
  relationships: { relationships: [{ id: 'r1', slug: 'maren-pell', name: 'Maren and Pell', baseline: 'Wary' }] },
  synopses: { synopses: [{ id: 'y1', slug: 'my-short', title: 'Short', type: 'short', body: 'Once upon a time', stale: true }] },
  links: {
    links: [
      { slug: 'l1', from: 's1', to: 's2', relation: 'therefore', to_title: 'Shore' },
      { slug: 'l2', from: 's1', to: 's3', relation: 'but', branch: 'mutiny', to_title: 'Storm' },
      { slug: 'l3', from: 's2', to: 's3', relation: 'enables', broken: true },
    ],
  },
  scenes: [
    { id: 's1', title: 'Ferry', chapter: 1 },
    { id: 's2', title: 'Shore', chapter: 2 },
    { id: 's3', title: 'Storm', chapter: 3 },
    { id: 's4', title: null },
  ],
};

test('resolvePlanTarget turns a slug into the permanent id from the plan', () => {
  const r = (search) => resolvePlanTarget(legacyPlanTarget(search), plan);
  assert.deepEqual(r('?view=clues&clue=torn-map'), { select: 'c1', structureId: null, branch: null, series: false });
  assert.equal(r('?view=arcs&arc=maren').select, 'a1');
  assert.equal(r('?view=arcs&relationship=maren-pell').select, 'r1');
  assert.equal(r('?view=synopsis&synopsis=my-short').select, 'y1');
  assert.deepEqual(r('?view=structure&structure=hero'), { select: 'st2', structureId: 'st2', branch: null, series: false });
  assert.equal(r('?view=clues&clue=nope').select, null, 'an unknown slug just opens');
  assert.equal(r('?view=flow&node=s2').select, 's2');
  assert.equal(r('?view=series').series, true);
  assert.equal(resolvePlanTarget(legacyPlanTarget('?clue=torn-map'), null).select, null, 'plan not loaded');
});

test('buildPlanList: scenes grouped by the first beat in book order, with outgoing links', () => {
  const l = buildPlanList({ plan, findings: [] });
  assert.equal(l.structureName, 'Three acts');
  assert.deepEqual(l.groups.map((g) => g.name), ['Setup', 'Turn', 'End', 'Not in a beat']);
  assert.deepEqual(l.groups.map((g) => g.scenes.map((s) => s.id)), [['s1', 's2'], ['s3'], [], ['s4']]);
  const ferry = l.groups[0].scenes[0];
  assert.equal(ferry.title, 'Ferry');
  assert.equal(ferry.chapter, 1);
  assert.deepEqual(ferry.links.map((x) => x.text), ['→ therefore → Shore']);
  assert.equal(l.groups[3].scenes[0].title, 'Untitled scene');
  assert.equal(l.story.logline, 'A ferry, a key.');
  assert.equal(l.primary, 'Three acts');
});

test('buildPlanList: the structure, the branch and the layers choose what shows', () => {
  assert.deepEqual(buildPlanList({ plan, structureId: 'st2' }).groups.map((g) => g.name), ['Call', 'Not in a beat']);
  const what = buildPlanList({ plan, branch: 'mutiny' }).groups[0].scenes[0].links;
  assert.deepEqual(what.map((x) => [x.text, x.whatIf]), [['→ therefore → Shore', false], ['→ but → Storm', true]]);
  assert.deepEqual(buildPlanList({ plan, branch: 'other' }).groups[0].scenes[0].links.map((x) => x.slug), ['l1']);
  const off = buildPlanList({ plan, layers: { links: false, beats: false, clues: false, arcs: false, relationships: false } });
  assert.deepEqual(off.groups.map((g) => g.name), ['Scenes']);
  assert.equal(off.groups[0].scenes.length, 4);
  assert.equal(off.groups[0].scenes[0].links.length, 0);
  assert.equal(off.clues, null);
  assert.equal(off.arcs, null);
  assert.equal(off.relationships, null);
  assert.equal(off.synopses.length, 1, 'synopses have no layer');
});

test('buildPlanList: clues carry planted, revealed and the PL6 warning; scene plans fill goal and turn when given', () => {
  const l = buildPlanList({ plan, findings: [{ rule: 'PL6', subject: { id: 'c1' }, title: 'Revealed before it is planted' }, { rule: 'PL1', subject: { id: 'c2' } }], scenePlans: { s1: { goal: 'Cross', turn: 'Fog' } } });
  assert.deepEqual(l.clues[0], { id: 'c1', fact: 'The map is torn', kind: 'Clue', planted: ['Ferry'], revealed: 'Storm', warn: 'Revealed before it is planted' });
  assert.equal(l.clues[1].kind, 'Red herring');
  assert.equal(l.clues[1].warn, null);
  assert.deepEqual(l.clues[1].planted, []);
  assert.equal(l.clues[1].revealed, null);
  assert.deepEqual([l.groups[0].scenes[0].goal, l.groups[0].scenes[0].turn], ['Cross', 'Fog']);
  assert.deepEqual(l.arcs, [{ id: 'a1', name: 'Maren', summary: 'afraid → brave' }]);
  assert.deepEqual(l.relationships, [{ id: 'r1', name: 'Maren and Pell', summary: 'Wary' }]);
  assert.equal(l.synopses[0].stale, true);
});

test('buildPlanList copes with no plan; locateListItem finds items by id', () => {
  const empty = buildPlanList({ plan: null });
  assert.equal(empty.story, null);
  assert.deepEqual(empty.groups, [{ id: 'all', name: 'Scenes', scenes: [] }]);
  const l = buildPlanList({ plan });
  assert.deepEqual(locateListItem(l, 's3'), { kind: 'scene', id: 's3', title: 'Storm' });
  assert.equal(locateListItem(l, 'c1').kind, 'clue');
  assert.equal(locateListItem(l, 'a1').kind, 'arc');
  assert.equal(locateListItem(l, 'r1').kind, 'relationship');
  assert.equal(locateListItem(l, 'y1').kind, 'synopsis');
  assert.equal(locateListItem(l, 'note_story').kind, 'story-plan');
  assert.equal(locateListItem(l, 'st1'), null);
});

test('chooseCanvas: the address, then the last opened, then the first', () => {
  const cs = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.equal(chooseCanvas(cs, 'c', 'b'), 'c');
  assert.equal(chooseCanvas(cs, 'zzz', 'b'), 'b');
  assert.equal(chooseCanvas(cs, null, 'gone'), 'a');
  assert.equal(chooseCanvas([], 'a', 'b'), null);
});

test('loadViewMode: a kept choice wins, else List under 720px wide', () => {
  assert.equal(loadViewMode('nobook', 500), 'list');
  assert.equal(loadViewMode('nobook', 719), 'list');
  assert.equal(loadViewMode('nobook', 720), 'canvas');
  assert.equal(loadViewMode('nobook', null), 'canvas');
  globalThis.localStorage = { getItem: (k) => (k.endsWith('.kept') ? 'canvas' : null), setItem() {} };
  try {
    assert.equal(loadViewMode('kept', 300), 'canvas');
  } finally {
    delete globalThis.localStorage;
  }
});

// ---------------------------------------------------------------- rendered markup (List mode and the first-visit panel)

import { fileURLToPath } from 'node:url';
import { after, before, describe } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { audit } from './a11y-check.mjs';

describe('rendered', () => {
  let vite;
  let listMod;
  let pageMod;
  before(async () => {
    vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
    listMod = await vite.ssrLoadModule('/src/canvas/plan/PlanList.jsx');
    pageMod = await vite.ssrLoadModule('/src/canvas/CanvasView.jsx');
  });
  after(async () => {
    await vite?.close();
  });

  test('List mode: headed lists, every item a button, aria-pressed on the picked one, no role=application', () => {
    const list = buildPlanList({ plan, findings: [{ rule: 'PL6', subject: { id: 'c1' }, title: 'Revealed before it is planted' }] });
    const markup = renderToStaticMarkup(h(listMod.PlanList, { list, picked: { kind: 'scene', id: 's2' }, onPick: () => {} }));
    for (const heading of ['Story plan', 'Scenes by beat (Three acts)', 'Clues', 'Arcs', 'Relationships', 'Synopses']) assert.ok(markup.includes(`>${heading}</h2>`), heading);
    for (const beat of ['Setup', 'Turn', 'End', 'Not in a beat']) assert.ok(markup.includes(`>${beat}</h3>`), beat);
    assert.match(markup, /→ therefore → Shore/);
    assert.match(markup, /Plan check: Revealed before it is planted/);
    assert.equal([...markup.matchAll(/aria-pressed="true"/g)].length, 1);
    assert.match(markup, /aria-pressed="true"[^>]*><span class="cv-plist-title">Shore</);
    assert.doesNotMatch(markup, /role="application"/);
    assert.deepEqual(audit(markup, {}).filter((x) => /name|heading/i.test(x)), []);
  });

  test('a book with no canvases offers Build your plan canvas (only with the planner on and a handler)', () => {
    const props = { bookId: 'b1', list: { canvases: [], archived: [] }, slug: null, onNew: () => {}, onArchive: () => {}, onRestore: () => {} };
    const withBuild = renderToStaticMarkup(h(pageMod.CanvasPage, { ...props, onBuildPlan: async () => null }));
    assert.match(withBuild, /<h2[^>]*>Build your plan canvas<\/h2>/);
    assert.match(withBuild, /<button[^>]*>Build your plan canvas<\/button>|<button[^>]*disabled=""[^>]*>Build your plan canvas<\/button>/);
    assert.doesNotMatch(renderToStaticMarkup(h(pageMod.CanvasPage, props)), /Build your plan canvas/);
  });
});
