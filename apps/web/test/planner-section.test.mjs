// The Plan section of the scene rail: request builders (pure) and the presentational view with fixture data.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
let req;
let view;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  req = await vite.ssrLoadModule('/src/planner/requests.js');
  view = await vite.ssrLoadModule('/src/planner/ScenePlanSection.jsx');
});
after(async () => {
  await vite?.close();
});

const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (props) => text(renderToStaticMarkup(h(view.ScenePlanView, { bookId: 'b1', sceneId: 'S1', ...props })));

const EMPTY = Object.fromEntries(['goal', 'opposition', 'conflict', 'turn', 'outcome', 'consequence', 'stakes', 'emotional_start', 'emotional_end', 'purpose'].map((k) => [k, null]));
const PLAN = { scene_id: 'S1', path: 'planning/scene-plans/s1.md', sha256: 'abc', fields: { ...EMPTY, goal: 'Find the key', stakes: 'The orchard' }, characters: [], body: '' };
const LINKS = {
  links: [
    { id: 'L1', slug: 'a-pays-off-b', from: 'S1', to: 'S2', relation: 'pays_off', rationale: '', from_title: 'The Key', to_title: 'The Door', sha256: 'x', problems: [] },
    { id: 'L2', slug: 'c-but-a', from: 'S3', to: 'S1', relation: 'but', rationale: '', from_title: 'The Tide', to_title: 'The Key', sha256: 'y', problems: [] },
    { id: 'L3', slug: 'c-but-d', from: 'S3', to: 'S4', relation: 'but', rationale: '', from_title: 'The Tide', to_title: 'Elsewhere', sha256: 'z', problems: [] },
  ],
  archived: [],
};

test('requests: urls, body and hrefs', () => {
  assert.equal(req.scenePlanUrl('b 1', 'S/1'), '/api/books/b%201/scene-plans/S%2F1');
  assert.equal(req.linksUrl('b1'), '/api/books/b1/links');
  assert.deepEqual(req.scenePlanBody({ fields: { goal: 'x' }, sha: 'abc' }), { fields: { goal: 'x' }, base_sha256: 'abc' });
  assert.deepEqual(req.scenePlanBody({ fields: { goal: null }, sha: null }), { fields: { goal: null } });
  assert.deepEqual(req.scenePlanBody({ fields: { goal: 'x' }, sha: 'abc', characters: ['pell'], dryRun: true }), { fields: { goal: 'x' }, characters: ['pell'], base_sha256: 'abc', dryRun: true });
  assert.equal(req.fieldValue('  '), null);
  assert.equal(req.fieldValue(' hi '), 'hi');
  assert.equal(req.relationLabel('pays_off'), 'pays off');
  assert.equal(req.planHref('b1', { view: 'flow', link: 'a-b' }), '/books/b1/plan?view=flow&link=a-b');
  assert.equal(req.planHref('b1', { view: 'flow', node: 'S1' }), '/books/b1/plan?view=flow&node=S1');
  assert.equal(req.planHref('b1'), '/books/b1/plan');
  assert.equal(req.PLAN_FIELDS.length, 10);
});

test('requests: linksForScene splits outgoing and incoming', () => {
  const { outgoing, incoming } = req.linksForScene(LINKS, 'S1');
  assert.deepEqual(outgoing.map((l) => l.id), ['L1']);
  assert.deepEqual(incoming.map((l) => l.id), ['L2']);
  assert.deepEqual(req.linksForScene(null, 'S1'), { outgoing: [], incoming: [] });
});

test('view: heading, ten labelled inputs, values and placeholders for empty fields', () => {
  const html = render({ plan: PLAN, links: LINKS });
  assert.match(html, /<h2>Plan<\/h2>/);
  for (const label of ['Goal', 'Opposition', 'Conflict', 'Turn', 'Outcome', 'Consequence', 'Stakes', 'Feeling at start', 'Feeling at end', 'Purpose']) {
    assert.match(html, new RegExp(`<label for="plan-[a-z_]+">${label}</label>`), label);
  }
  assert.equal((html.match(/<input /g) ?? []).length, 10);
  assert.match(html, /id="plan-goal"[^>]*value="Find the key"/);
  assert.match(html, /id="plan-opposition"[^>]*placeholder="Not set"/);
  assert.doesNotMatch(html, /required/);
  assert.doesNotMatch(html, /class="error"/);
});

test('view: links as words, outgoing and incoming, each an href to the flow view', () => {
  const html = render({ plan: PLAN, links: LINKS });
  assert.match(html, /<a href="\/books\/b1\/plan\?view=flow&link=a-pays-off-b"[^>]*>→ pays off The Door<\/a>/);
  assert.match(html, /<a href="\/books\/b1\/plan\?view=flow&link=c-but-a"[^>]*>The Tide but →<\/a>/);
  assert.ok(!html.includes('Elsewhere'), 'a link of other scenes is not shown');
  assert.ok(!html.includes('Not linked'));
});

test('view: no links gives the empty text and a Connect in Flow link', () => {
  const html = render({ plan: PLAN, links: { links: [], archived: [] } });
  assert.ok(html.includes('Not linked to other scenes yet.'));
  assert.match(html, /<a href="\/books\/b1\/plan\?select=S1"[^>]*>Connect in Flow<\/a>/);
});

test('view: loading, a notice and an inline refusal', () => {
  assert.ok(render({ plan: null, links: null }).includes('Loading…'));
  const html = render({ plan: PLAN, links: LINKS, message: 'This plan changed elsewhere; reloaded.', error: 'The change was not made (REFUSED_BAD_ARGS).' });
  assert.match(html, /role="status">This plan changed elsewhere; reloaded\./);
  assert.match(html, /role="alert">The change was not made \(REFUSED_BAD_ARGS\)\./);
});
