// Golden pin of the shape of every GET /api/v1 response (status plus a recursive type skeleton), so a storage rewrite cannot change a read response.
// The server runs over a copy of the salt-orchard fixture; a canvas and a task are created through the plugin's own write routes first (the fixture has none).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { V1 } from '../src/plugin-policy.mjs';
import { checkGolden } from './golden-helpers.mjs';
import { SCENE, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'v1-read-shapes.json');
const CMD = 'UPDATE_GOLDEN=1 node --import ./scripts/test-isolate-config.mjs --test apps/server/test/v1-compat-shapes.test.mjs';

/** Keys whose presence or value changes between runs (none needed so far; list them here if one appears). */
const VOLATILE = [];

/** Recursive type skeleton: objects map sorted keys to child shapes, arrays hold the first element's shape ([] when empty), primitives are type names. */
export function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).filter((k) => !VOLATILE.includes(k)).sort().map((k) => [k, shapeOf(v[k])]));
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v;
  throw new Error(`unexpected ${typeof v} in a JSON response`);
}

/** Arrays that are still empty in the golden after the setup below, with the reason; the test fails if this list and the actual empty arrays differ. */
const NOBODY = 'the fixture entry/event/thread has none';
const HEALTHY = 'empty means no problem found; a healthy item is the normal case';
const EMPTY = {
  'GET /api/v1/books/:book/entries .entries[].aliases': NOBODY,
  'GET /api/v1/books/:book/entries .types[].fields': 'the fixture has no custom fields on the first type',
  'GET /api/v1/books/:book/threads .threads[].develop': NOBODY,
  'GET /api/v1/books/:book/events .events[].characters': NOBODY,
  'GET /api/v1/books/:book/events .events[].locations': NOBODY,
  'GET /api/v1/books/:book/plan/links .archived[].problems': HEALTHY,
  'GET /api/v1/books/:book/plan/links .links[].problems': HEALTHY,
  'GET /api/v1/books/:book/plan/arcs .archived[].milestones': 'the archived spare arc was made without milestones',
  'GET /api/v1/books/:book/plan/arcs .archived[].problems': HEALTHY,
  'GET /api/v1/books/:book/plan/arcs .arcs[].problems': HEALTHY,
  'GET /api/v1/books/:book/plan/relationships .relationships[].problems': HEALTHY,
  'GET /api/v1/books/:book/plan/clues .clues[].problems': HEALTHY,
  'GET /api/v1/books/:book/canvases .archived': 'no canvas is archived (no archive step in this setup)',
  'GET /api/v1/books/:book/canvases/compat-canvas .canvas.edges': 'a new canvas is empty; filling it needs a sha-checked PUT with node geometry',
  'GET /api/v1/books/:book/canvases/compat-canvas .canvas.nodes': 'a new canvas is empty; filling it needs a sha-checked PUT with node geometry',
  'GET /api/v1/books/:book/workspace/docs .archived': 'no workspace doc is archived',
  'GET /api/v1/books/:book/ledger .questions[].characters': 'the spare question thread is bare (the promise thread covers the filled shapes)',
  'GET /api/v1/books/:book/ledger .questions[].develop': 'the spare question thread is bare',
  'GET /api/v1/books/:book/ledger .questions[].develop_chapters': 'the spare question thread is bare',
  'GET /api/v1/books/:book/ledger .questions[].payoff': 'the spare question thread is bare',
  'GET /api/v1/books/:book/ledger .questions[].payoff_chapters': 'the spare question thread is bare',
  'GET /api/v1/books/:book/ledger .questions[].setup': 'the spare question thread is bare',
  'GET /api/v1/books/:book/ledger .questions[].setup_chapters': 'the spare question thread is bare',
  'GET /api/v1/books/:book/tasks .tasks[].targets': 'the compat task has no targets',
  'GET /api/v1/books/:book/tasks/compat-task .targets': 'the compat task has no targets',
  'GET /api/v1/books/:book/tasks/compat-task .task.targets': 'the compat task has no targets',
  'GET /api/v1/books/:book/continuity .findings[].related': 'the first finding has no related items',
  'GET /api/v1/books/:book/continuity .stale_exceptions': 'the dismissed finding is still live, so no exception is stale',
  'GET /api/v1/books/:book/continuity .suppressed[].finding.related': 'the dismissed finding has no related items',
  'GET /api/v1/books/:book/context?chapter=1 .truncated': 'the pack fits its budget, so nothing is truncated',
};

/** Paths of the arrays that are empty in a shape, like `.a[].b`. */
function emptyPaths(shape, at = '') {
  if (Array.isArray(shape)) return shape.length ? emptyPaths(shape[0], `${at}[]`) : [at];
  if (shape && typeof shape === 'object') return Object.entries(shape).flatMap(([k, v]) => emptyPaths(v, `${at}.${k}`));
  return [];
}

test('shapeOf: the skeleton rules', () => {
  assert.deepEqual(shapeOf({ b: 1, a: [], c: [{ x: 'y', z: null }, { x: 1 }], d: true }), { a: [], b: 'number', c: [{ x: 'string', z: 'null' }], d: 'boolean' });
  assert.deepEqual(shapeOf([]), []);
  assert.equal(shapeOf(null), 'null');
});

const B = `/api/v1/books/${SLUG}`;

/** Concrete requests per GET route of the table, keyed by the route's regex source. A GET route that is not listed here fails the test, so a new route needs a decision. */
const CONCRETE = {
  '^\\/api\\/v1$': ['/api/v1'],
  '^\\/api\\/v1\\/books$': ['/api/v1/books'],
  '^\\/api\\/v1\\/books\\/([^/]+)$': [B],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/scenes\\/[^/]+$': [`${B}/scenes/${SCENE}`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/(entries|threads|events)$': [`${B}/entries`, `${B}/threads`, `${B}/events`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/entries\\/[^/]+$': [`${B}/entries/ferry-bell`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/(search|graph|diagnostics)$': [`${B}/search?q=bell`, `${B}/graph`, `${B}/diagnostics`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/plan$': [`${B}/plan`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/plan\\/(links|arcs|structures|relationships|synopses|clues)$': ['links', 'arcs', 'structures', 'relationships', 'synopses', 'clues'].map((x) => `${B}/plan/${x}`),
  '^\\/api\\/v1\\/books\\/([^/]+)\\/plan\\/scene-plans\\/[^/]{1,120}$': [`${B}/plan/scene-plans/${SCENE}`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/plan\\/(check|templates)$': [`${B}/plan/check`, `${B}/plan/templates`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/canvases$': [`${B}/canvases`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/canvases\\/[a-z0-9-]{1,60}$': [`${B}/canvases/compat-canvas`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/workspace\\/docs$': [`${B}/workspace/docs`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/(ledger|cast|knowledge|state-events|tasks)$': [`${B}/ledger`, `${B}/cast`, `${B}/knowledge?character=maren-hollis&at=1`, `${B}/state-events`, `${B}/tasks`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/tasks\\/[^/]{1,200}$': [`${B}/tasks/compat-task`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/continuity$': [`${B}/continuity`],
  '^\\/api\\/v1\\/books\\/([^/]+)\\/context$': [`${B}/context?chapter=1`],
  '^\\/api\\/v1\\/webhooks$': ['/api/v1/webhooks'],
};

/** GET routes deliberately not shape-pinned, with the reason (recorded in the golden). */
const SKIPPED = [];

test('the concrete request list covers every GET route of the table, and each request matches its route', () => {
  const gets = V1.filter((r) => r.method === 'GET');
  assert.deepEqual(gets.map((r) => r.re.source).filter((s) => !CONCRETE[s] && !SKIPPED.some((k) => k.route === s)), [], 'a GET route has no concrete request: add it to CONCRETE (or SKIPPED with a reason)');
  for (const r of gets) for (const u of CONCRETE[r.re.source] ?? []) assert.ok(r.re.test(u.split('?')[0]), `${u} does not match ${r.re.source}`);
});

test('every GET /api/v1 route keeps its status and response shape', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard', profile: 'v1-compat-shapes' });
  // make every module that gates a read route explicitly on
  const mods = Object.fromEntries(['ai', 'continuity', 'receipts', 'suggestions', 'timeline', 'board', 'threads', 'insights', 'tasks', 'research', 'planner', 'integrations', 'workspace'].map((m) => [m, true]));
  const saved = await t.member('PUT', '/api/profile', { modules: mods });
  assert.equal(saved.status, 200, saved.text);
  const { token } = await t.grant({ plugin: 'v1-compat', permissions: ['read', 'events', 'canvas', 'workspace', 'plan'], books: [SLUG] });

  // create what the fixture lacks (through the plugin's own write routes, as an author's tool would)
  const setup = [
    ['POST', `${B}/canvases`, { title: 'Compat canvas' }],
    ['POST', `${B}/tasks`, { title: 'Compat task', labels: ['compat'] }],
    ['POST', `${B}/workspace/setup`, {}],
  ];
  for (const [m, p, body] of setup) {
    const r = await t.plugin(token, m, p, { body });
    assert.ok(r.status >= 200 && r.status < 300, `setup ${m} ${p}: ${r.status} ${r.text}`);
  }

  // fill the arrays the fixture leaves empty, so each element's shape is pinned: planner items, ledger, cast, knowledge, state events, a continuity exception
  const ok = async (m, p, body) => {
    const r = await t.plugin(token, m, p, { body });
    assert.ok(r.status >= 200 && r.status < 300, `setup ${m} ${p}: ${r.status} ${r.text}`);
    return r.json;
  };
  const book = (await t.plugin(token, 'GET', B)).json;
  const ids = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((x) => x.id)));
  const S0 = ids[0]; // the first scene of the book (prologue, chapter 0)
  const [S1, S2] = [SCENE, ids[ids.indexOf(SCENE) + 1]]; // two scenes of chapter 1
  const sha = async (kind, slug) => (await t.plugin(token, 'GET', `${B}/plan/${kind}`)).json[kind].find((x) => x.slug === slug).sha256;
  const ents = (await t.plugin(token, 'GET', `${B}/entries`)).json.entries;
  const E = (slug) => ents.find((e) => e.slug === slug).id;
  await ok('POST', `${B}/plan/scene-plans/${SCENE}`, { fields: { goal: 'Arrive' }, characters: ['maren-hollis'] });
  const P = `${B}/plan`;
  await ok('POST', `${P}/links`, { from: S1, to: S2, relation: 'therefore' });
  const arc = await ok('POST', `${P}/arcs`, { character: E('maren-hollis'), arc_type: 'positive', fields: { want: 'w' } });
  await ok('POST', `${P}/arcs/${arc.slug}/milestones`, { milestones: [{ scene: S1, choice: 'c' }], base_sha256: await sha('arcs', arc.slug) });
  const st = await ok('POST', `${P}/structures`, { template: 'three-act', name: 'Main' });
  await ok('POST', `${P}/structures/${st.slug}/beats`, { beats: [{ name: 'Hook', scenes: [S1] }], base_sha256: await sha('structures', st.slug) });
  const rel = await ok('POST', `${P}/relationships`, { a: E('maren-hollis'), b: E('ilse-hollis'), fields: { baseline: 'b' } });
  await ok('POST', `${P}/relationships/${rel.slug}/developments`, { developments: [{ scene: S1, change: 'c' }], base_sha256: await sha('relationships', rel.slug) });
  const clue = await ok('POST', `${P}/clues`, { fact: 'The key', kind: 'clue', fields: { planted: [S1] } });
  await ok('POST', `${P}/clues/${clue.slug}/knowers`, { knowers: [{ who: 'reader', scene: S2, reliable: false }], base_sha256: await sha('clues', clue.slug) });
  await ok('POST', `${P}/synopses`, { type: 'logline', name: 'N', target_words: 25, body: 'b' });
  // a second item of each planner kind, archived, so the archived lists have an element too
  const spare = [
    ['links', { from: S2, to: S1, relation: 'but' }],
    ['arcs', { character: E('ilse-hollis'), arc_type: 'positive', fields: { want: 'w' } }],
    ['structures', { template: 'three-act', name: 'Spare' }],
    ['relationships', { a: E('maren-hollis'), b: E('tobin-reyes'), fields: { baseline: 'b' } }],
    ['clues', { fact: 'Spare clue', kind: 'clue' }],
    ['synopses', { type: 'logline', name: 'Spare', target_words: 25, body: 'b' }],
  ];
  for (const [kind, body] of spare) {
    const made = await ok('POST', `${P}/${kind}`, body);
    await ok('POST', `${P}/${kind}/${made.slug}/archive`, {});
  }
  const thread = await ok('POST', `${B}/ledger/threads`, { title: 'Who has the key', kind: 'promise' });
  const tsha = (await t.plugin(token, 'GET', `${B}/ledger`)).json.promises.find((x) => x.slug === thread.slug).sha256;
  await ok('POST', `${B}/ledger/threads/${thread.slug}`, { setup: [S0], develop: [S1], payoff: [S2], characters: ['maren-hollis'], base_sha256: tsha });
  await ok('POST', `${B}/ledger/threads`, { title: 'What is in the cellar', kind: 'question' });
  for (const sc of [S0, S1]) await ok('POST', `${B}/scenes/${sc}/cast`, { cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'ilse-hollis', role: 'appears' }] });
  await ok('POST', `${B}/knowledge`, { character: 'maren-hollis', fact: 'The ferry bell is cracked', chapter: 0 });
  await ok('POST', `${B}/state-events`, { chapter: 0, items: [{ subject: 'tobin-reyes', kind: 'died' }] });
  const finding = (await t.plugin(token, 'GET', `${B}/continuity`)).json.findings[0];
  assert.ok(finding, 'the fixture has a continuity finding to dismiss');
  await ok('POST', `${B}/continuity/exceptions`, { fingerprint: finding.fingerprint, reason: 'On purpose.' });
  await ok('POST', '/api/v1/webhooks', { url: 'https://example.com/storyforge-hook', events: ['scene.saved'] });

  const routes = {};
  for (const r of V1.filter((x) => x.method === 'GET')) {
    for (const u of CONCRETE[r.re.source]) {
      const res = await t.plugin(token, 'GET', u);
      assert.ok(res.json !== undefined, `${u} answered ${res.status} with a non-JSON body`);
      routes[`GET ${u.replace(SLUG, ':book').replace(SCENE, ':scene')}`] = { status: res.status, shape: shapeOf(res.json) };
    }
  }
  const bad = Object.entries(routes).filter(([, v]) => v.status !== 200).map(([k, v]) => `${k} -> ${v.status}`);
  assert.deepEqual(bad, [], 'every pinned read should answer 200 on the fixture');
  const actualEmpty = Object.entries(routes).flatMap(([k, v]) => emptyPaths(v.shape).map((p) => `${k} ${p}`)).sort();
  assert.deepEqual(actualEmpty, Object.keys(EMPTY).sort(), 'the empty arrays differ from EMPTY: fill them in the setup (better) or list them with a reason');
  checkGolden(GOLDEN, { volatile: VOLATILE, skipped: SKIPPED, empty: EMPTY, routes }, CMD);
});
