// M12 W3: the ledgers over the plugin API v1 (permission 'workspace' for writes, 'read' for reads, and the book's AI level on top):
//   GET  /api/v1/books/:b/{ledger|cast|knowledge|state-events|tasks}
//   POST /api/v1/books/:b/ledger/threads | ledger/threads/:slug | scenes/:id/cast | knowledge | state-events | tasks | tasks/:id/status | activity/ai-words
// Every write runs the app's own route (memberWrite) and can reach only threads, a scene's `cast`, state items, tasks and the writing log; never prose.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { decidePlugin } from '../src/plugin-policy.mjs';
import { setBookPreferences } from './custom-helpers.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SCENE, SCENE_PATH, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const base = `/api/v1/books/${BOOK}`;
const bodyOf = (buf) => buf.toString('utf8').slice(buf.toString('utf8').indexOf('\n---', 3) + 4);
const changed = (a, c) => [...new Set([...a.keys(), ...c.keys()])].filter((p) => !a.has(p) || !c.has(p) || !a.get(p).equals(c.get(p))).sort();
const isStore = (p) => p.startsWith('.storyforge/') || p.startsWith('provenance/');
const WRITES = [
  ['POST', '/ledger/threads', { title: 'Maren will mend the wall', kind: 'promise' }],
  ['POST', '/ledger/threads/brass-key', { status: 'paid' }],
  ['POST', `/scenes/${SCENE}/cast`, { cast: [{ entry: 'maren-hollis', role: 'pov' }] }],
  ['POST', '/knowledge', { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 }],
  ['POST', '/state-events', { chapter: 2, items: [{ subject: 'pell', kind: 'died' }] }],
  ['POST', '/tasks', { title: 'Check the tide times', for: 'ai' }],
  ['POST', '/tasks/some-task/status', { status: 'done' }],
  ['POST', '/activity/ai-words', { words: 10 }],
];

test('the policy: reads need read, every write needs workspace and names its AI level; scene prose routes are not plugin routes', () => {
  const grant = (permissions) => ({ id: 'g1', plugin: 'p', permissions, books: 'all' });
  const slugOf = (x) => (x === BOOK || x === SLUG ? SLUG : null);
  const decide = (permissions, method, p) => decidePlugin(grant(permissions), method, `${base}${p}`, slugOf);
  for (const what of ['ledger', 'cast', 'knowledge', 'state-events', 'tasks']) {
    const d = decide(['read'], 'GET', `/${what}`);
    assert.deepEqual([d.ok, d.need, d.level], [true, 'read', 'off'], what);
  }
  const levels = { '/ledger/threads': 'planner', '/ledger/threads/brass-key': 'planner', [`/scenes/${SCENE}/cast`]: 'planner', '/knowledge': 'planner', '/state-events': 'planner', '/tasks': 'advisor', '/tasks/x/status': 'planner', '/activity/ai-words': 'planner' };
  for (const [p, level] of Object.entries(levels)) {
    const ok = decide(['read', 'workspace'], 'POST', p);
    assert.deepEqual([ok.ok, ok.need, ok.level], [true, 'workspace', level], p);
    const refused = decide(['read', 'plan', 'canvas', 'propose'], 'POST', p);
    assert.equal(refused.ok, false, p);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /"workspace"/, p);
  }
  for (const [method, p] of [['POST', `/scenes/${SCENE}/fields`], ['PUT', `/scenes/${SCENE}/body`], ['PUT', `/scenes/${SCENE}/raw`], ['POST', '/ledger/threads/x/body'], ['PUT', '/ledger/threads/x'], ['DELETE', '/ledger/threads/x'], ['POST', '/ledger'], ['POST', '/activity/session'], ['POST', '/tasks/x'], ['POST', '/events']]) {
    const d = decide(['read', 'plan', 'canvas', 'propose', 'workspace', 'draft'], method, p);
    assert.equal(d.ok, false, `${method} ${p}`);
    assert.equal(d.body.code, 'PLUGIN_SCOPE');
  }
  assert.equal(v1RouteOf('POST', `${base}/scenes/${SCENE}/cast`), 'scene-cast');
  assert.equal(v1RouteOf('GET', `${base}/ledger`), 'ledger');
  assert.equal(v1RouteOf('POST', `${base}/ledger/threads`), 'ledger-thread-create');
  assert.equal(v1RouteOf('POST', `${base}/ledger/threads/x`), 'ledger-thread-update');
  assert.equal(v1RouteOf('POST', `${base}/tasks/x/status`), 'task-status');
  assert.equal(v1RouteOf('POST', `${base}/activity/ai-words`), 'activity-ai-log');
});

test('a read-only token reads the ledgers and every write is 403 PLUGIN_SCOPE naming "workspace"; nothing is written', async () => {
  const t = await bootPersonal();
  const ro = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const before = await readAll(t.root);
  for (const what of ['ledger', 'cast', 'state-events', 'tasks']) assert.equal((await t.plugin(ro, 'GET', `${base}/${what}`)).status, 200, what);
  assert.equal((await t.plugin(ro, 'GET', `${base}/knowledge?character=maren-hollis`)).status, 200);
  for (const [method, p, body] of WRITES) {
    const r = await t.plugin(ro, method, `${base}${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE', p);
    assert.match(r.json.message, /workspace/, p);
  }
  assert.deepEqual(await readAll(t.root), before);
});

test('a workspace token (planner level, the default) writes ledgers, cast, knowledge, state events, tasks and AI words; no scene prose changes', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'workspace-writer', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);

  // ledger: create a promise and a question, then update the promise with scenes
  const p = await t.plugin(rw, 'POST', `${base}/ledger/threads`, { body: { title: 'Maren will mend the wall', kind: 'promise' } });
  assert.equal(p.status, 201, p.text);
  assert.equal((await t.plugin(rw, 'POST', `${base}/ledger/threads`, { body: { title: 'Who left the key?', kind: 'question' } })).status, 201);
  const up = await t.plugin(rw, 'POST', `${base}/ledger/threads/${p.json.slug}`, { body: { status: 'planted', setup: [SCENE] } });
  assert.equal(up.status, 200, up.text);
  const ledger = (await t.plugin(rw, 'GET', `${base}/ledger`)).json;
  assert.deepEqual(ledger.promises.map((x) => [x.slug, x.status, x.setup_chapters]), [[p.json.slug, 'planted', [1]]]);
  assert.equal(ledger.questions.length, 1);
  assert.ok(!/"(path|file|rel)"/.test(JSON.stringify(ledger)), 'no file paths');

  // cast
  const cast = await t.plugin(rw, 'POST', `${base}/scenes/${SCENE}/cast`, { body: { cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'pell', role: 'mentioned' }] } });
  assert.equal(cast.status, 200, cast.text);
  const got = (await t.plugin(rw, 'GET', `${base}/cast?chapter=1`)).json.cast;
  assert.deepEqual(got.find((s) => s.scene === SCENE).cast.map((c) => [c.slug, c.role]), [['maren-hollis', 'pov'], ['pell', 'mentioned']]);
  assert.equal((await t.plugin(rw, 'POST', `${base}/scenes/${SCENE}/cast`, { body: { cast: [{ entry: 'nobody-here', role: 'appears' }] } })).status, 400);

  // knowledge and state events
  assert.equal((await t.plugin(rw, 'POST', `${base}/knowledge`, { body: { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 } })).status, 200);
  const k = await t.plugin(rw, 'GET', `${base}/knowledge?character=maren-hollis&at=1`);
  assert.deepEqual(k.json.facts.map((f) => f.fact), ['the-key-opens-the-sluice']);
  assert.equal((await t.plugin(rw, 'GET', `${base}/knowledge?character=maren-hollis&at=0`)).json.facts.length, 0);
  assert.equal((await t.plugin(rw, 'GET', `${base}/knowledge`)).status, 400);
  assert.equal((await t.plugin(rw, 'GET', `${base}/knowledge?character=nobody-here`)).status, 404);
  assert.equal((await t.plugin(rw, 'POST', `${base}/state-events`, { body: { chapter: 2, items: [{ subject: 'ferry-bell', kind: 'lost' }] } })).status, 200);
  const se = (await t.plugin(rw, 'GET', `${base}/state-events?chapter=2`)).json.events;
  assert.deepEqual(se.map((e) => [e.subject.slug, e.kind]), [['ferry-bell', 'lost']]);
  assert.equal((await t.plugin(rw, 'GET', `${base}/state-events?chapter=zz`)).status, 400);

  // tasks: a task for the AI, listed with ?for=ai, finished with a status
  const task = await t.plugin(rw, 'POST', `${base}/tasks`, { body: { title: 'Check the tide times', for: 'ai' } });
  assert.equal(task.status, 201, task.text);
  assert.equal((await t.plugin(rw, 'POST', `${base}/tasks`, { body: { title: 'Fix the ferry scene' } })).status, 201);
  const ai = (await t.plugin(rw, 'GET', `${base}/tasks?for=ai`)).json;
  assert.deepEqual(ai.tasks.map((x) => [x.slug, x.for]), [[task.json.slug, 'ai']]);
  assert.ok(!('path' in ai.tasks[0]), 'no file path');
  assert.equal((await t.plugin(rw, 'GET', `${base}/tasks?for=robot`)).status, 400);
  assert.equal((await t.plugin(rw, 'POST', `${base}/tasks`, { body: { title: 'x', for: 'robot' } })).status, 400);
  const done = await t.plugin(rw, 'POST', `${base}/tasks/${task.json.slug}/status`, { body: { status: 'done' } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await t.plugin(rw, 'GET', `${base}/tasks?status=done`)).json.tasks.length, 1);

  // AI words
  const log = await t.plugin(rw, 'POST', `${base}/activity/ai-words`, { body: { words: 321, chapter: 1, note: 'Drafted' } });
  assert.equal(log.status, 200, log.text);
  assert.equal(log.json.today.ai_words, 321);
  assert.match(await fs.readFile(path.join(t.root, 'activity', 'writing-log.md'), 'utf8'), /\| AI words \|/);

  // what changed: planning files, the writing log, and the one scene file's front matter; no prose
  const after = await readAll(t.root);
  const touched = changed(before, after).filter((f) => !isStore(f));
  assert.ok(touched.every((f) => f.startsWith('planning/') || f.startsWith('activity/') || f === SCENE_PATH), touched.join(', '));
  assert.equal(bodyOf(after.get(SCENE_PATH)), bodyOf(before.get(SCENE_PATH)), 'the prose of the scene is byte for byte the same');
  for (const [f, buf] of before) {
    if (f.startsWith('manuscript/') && f !== SCENE_PATH) assert.ok(after.get(f)?.equals(buf), `${f} is untouched`);
  }
});

test('the book AI level: advisor may create a task but a planner write is 403 AI_LEVEL; off refuses every write; reads always work; nothing is written when refused', async () => {
  const t = await bootPersonal();
  await setBookPreferences(t.root, '  ai:\n    level: advisor\n');
  const rw = (await t.grant({ plugin: 'level-test', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);
  for (const [method, p, body] of WRITES.filter(([, p]) => p !== '/tasks')) {
    const r = await t.plugin(rw, method, `${base}${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'AI_LEVEL', p);
    assert.equal(r.json.level, 'advisor');
    assert.equal(r.json.needs, 'planner');
  }
  assert.deepEqual(await readAll(t.root), before, 'refused writes changed nothing');
  const task = await t.plugin(rw, 'POST', `${base}/tasks`, { body: { title: 'Check the tide times', for: 'ai' } });
  assert.equal(task.status, 201, task.text);
  for (const what of ['ledger', 'cast', 'state-events', 'tasks']) assert.equal((await t.plugin(rw, 'GET', `${base}/${what}`)).status, 200, what);
  // a token that has more permissions than the level allows does not get more
  const rich = (await t.grant({ plugin: 'rich', permissions: ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft'] })).token;
  const r = await t.plugin(rich, 'POST', `${base}/knowledge`, { body: { character: 'maren-hollis', fact: 'a b', chapter: 1 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'AI_LEVEL');

  const off = await bootPersonal();
  await setBookPreferences(off.root, '  ai:\n    level: off\n');
  const tok = (await off.grant({ plugin: 'off-test', permissions: ['read', 'workspace'] })).token;
  const offBefore = await readAll(off.root);
  for (const [method, p, body] of WRITES) {
    const r2 = await off.plugin(tok, method, `${base}${p}`, { body });
    assert.equal(r2.status, 403, `${p}: ${r2.text}`);
    assert.equal(r2.json.code, 'AI_LEVEL', p);
  }
  assert.deepEqual(await readAll(off.root), offBefore);
  assert.equal((await off.plugin(tok, 'GET', `${base}/ledger`)).status, 200);
});

test('a workspace token cannot reach the scene prose routes, the thread body or any other app write route', async () => {
  const t = await bootPersonal();
  const rich = (await t.grant({ plugin: 'rich', permissions: ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft'] })).token;
  const before = await readAll(t.root);
  const tries = [
    ['PUT', `/scenes/${SCENE}/body`, { body: 'x', base_sha256: '0'.repeat(64) }],
    ['PUT', `/scenes/${SCENE}/raw`, { content: 'x', base_sha256: '0'.repeat(64) }],
    ['POST', `/scenes/${SCENE}/fields`, { title: 'x' }],
    ['POST', '/ledger/threads/brass-key/body', { body: 'x' }],
    ['POST', '/ledger/threads/brass-key/fields', { status: 'dropped' }],
    ['POST', '/activity/session', { minutes: 5 }],
    ['POST', '/events', { title: 'x' }],
  ];
  for (const [method, p, body] of tries) {
    const r = await t.plugin(rich, method, `${base}${p}`, { body });
    assert.ok([403, 404].includes(r.status), `${method} ${p}: ${r.status} ${r.text}`);
  }
  assert.deepEqual(await readAll(t.root), before);
});

test('the workspace module off for the book: the plugin write is refused by the same module gate as the app (403 MODULE_OFF)', async () => {
  const t = await bootPersonal();
  await setBookPreferences(t.root, '  modules:\n    workspace: false\n');
  const rw = (await t.grant({ plugin: 'gate', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);
  for (const [method, p, body] of WRITES.filter(([, p]) => ['/knowledge', '/state-events', '/activity/ai-words', `/scenes/${SCENE}/cast`].includes(p))) {
    const r = await t.plugin(rw, method, `${base}${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF', p);
  }
  assert.deepEqual(await readAll(t.root), before);
});
