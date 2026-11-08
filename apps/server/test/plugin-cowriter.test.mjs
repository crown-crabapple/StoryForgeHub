// M12 W6: the co-writer over the plugin API v1 (permission 'draft', book AI level cowriter):
//   POST /api/v1/books/:b/chapters | scenes   PUT /api/v1/books/:b/scenes/:id/draft   GET /api/v1/books/:b/context?chapter=N[&budget=]
// A plugin can create chapters and scenes (always an AI draft) and replace the body of its own unaccepted drafts; it can never change a scene the author wrote or accepted.
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
const isStore = (p) => p.startsWith('.storyforge/') || p.startsWith('provenance/');
const changed = (a, c) => [...new Set([...a.keys(), ...c.keys()])].filter((p) => !a.has(p) || !c.has(p) || !a.get(p).equals(c.get(p))).sort();
const COWRITER = ['read', 'draft'];
const levelCowriter = (t) => setBookPreferences(t.root, '  ai:\n    level: cowriter\n');

/** A server whose book is at AI level cowriter, and a token with read + draft. */
async function boot(fixture) {
  const t = await bootPersonal(fixture ? { fixture } : {});
  await levelCowriter(t);
  const token = (await t.grant({ plugin: 'mcp-cowriter', permissions: COWRITER })).token;
  return { t, token };
}
const todayAiWords = async (t) => (await t.member('GET', `/api/books/${BOOK}/activity`)).json?.today?.ai_words ?? 0;

test('the policy: the routes need draft at level cowriter; context needs read; the app routes for prose stay out of reach', () => {
  const grant = (permissions) => ({ id: 'g1', plugin: 'p', permissions, books: 'all' });
  const slugOf = (x) => (x === BOOK || x === SLUG ? SLUG : null);
  const decide = (permissions, method, p) => decidePlugin(grant(permissions), method, `${base}${p}`, slugOf);
  for (const [method, p] of [['POST', '/chapters'], ['POST', '/scenes'], ['PUT', `/scenes/${SCENE}/draft`]]) {
    const ok = decide(['read', 'draft'], method, p);
    assert.deepEqual([ok.ok, ok.need, ok.level], [true, 'draft', 'cowriter'], `${method} ${p}`);
    for (const perms of [['read'], ['read', 'plan', 'canvas', 'propose', 'workspace']]) {
      const refused = decide(perms, method, p);
      assert.equal(refused.ok, false, `${method} ${p}`);
      assert.equal(refused.status, 403);
      assert.match(refused.body.message, /"draft"/);
    }
  }
  const ctx = decide(['read'], 'GET', '/context');
  assert.deepEqual([ctx.ok, ctx.need, ctx.level], [true, 'read', 'off']);
  // still not plugin routes, whatever the grant: the app's own prose routes
  for (const [method, p] of [['PUT', `/scenes/${SCENE}/body`], ['PUT', `/scenes/${SCENE}/raw`], ['POST', `/scenes/${SCENE}/fields`], ['POST', `/scenes/${SCENE}/archive`], ['DELETE', `/scenes/${SCENE}`], ['PUT', `/scenes/${SCENE}/ai-draft`], ['POST', '/chapters/1/archive'], ['POST', '/chapters/1/fields'], ['POST', '/chapters/renumber'], ['POST', '/archive/restore'], ['POST', `/scenes/${SCENE}/split`]]) {
    const d = decide(['read', 'plan', 'canvas', 'propose', 'workspace', 'draft'], method, p);
    assert.equal(d.ok, false, `${method} ${p}`);
    assert.equal(d.body.code, 'PLUGIN_SCOPE');
  }
  assert.equal(v1RouteOf('POST', `${base}/chapters`), 'chapter-create');
  assert.equal(v1RouteOf('POST', `${base}/scenes`), 'scene-create');
  assert.equal(v1RouteOf('PUT', `${base}/scenes/${SCENE}/draft`), 'scene-draft');
  assert.equal(v1RouteOf('GET', `${base}/context`), 'context');
  assert.equal(v1RouteOf('GET', `${base}/scenes/${SCENE}`), 'scene');
  assert.equal(v1RouteOf('POST', `${base}/scenes/${SCENE}/cast`), 'scene-cast');
});

test('without the draft permission every co-writer route is 403 PLUGIN_SCOPE naming "draft", and nothing is written', async () => {
  const t = await bootPersonal();
  await levelCowriter(t);
  const tok = (await t.grant({ plugin: 'planner-only', permissions: ['read', 'propose', 'canvas', 'plan', 'workspace'] })).token;
  const before = await readAll(t.root);
  for (const [method, p, body] of [['POST', '/chapters', { title: 'X', after: 3 }], ['POST', '/scenes', { chapter: 1, title: 'X', body: 'x' }], ['PUT', `/scenes/${SCENE}/draft`, { body: 'x', base_sha256: 'a'.repeat(64) }]]) {
    const r = await t.plugin(tok, method, `${base}${p}`, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
    assert.match(r.json.message, /"draft"/);
  }
  assert.deepEqual(await readAll(t.root), before);
  assert.equal((await t.plugin(tok, 'GET', `${base}/context?chapter=1`)).status, 200, 'a read token gets the context pack');
});

test('below cowriter (planner, advisor, off) the co-writer routes are 403 AI_LEVEL even with a draft token, and nothing is written; context still reads', async () => {
  for (const level of ['planner', 'advisor', 'off']) {
    const t = await bootPersonal();
    await setBookPreferences(t.root, `  ai:\n    level: ${level}\n`);
    const tok = (await t.grant({ plugin: 'rich', permissions: ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft'] })).token;
    const before = await readAll(t.root);
    for (const [method, p, body] of [['POST', '/chapters', { title: 'X', after: 3 }], ['POST', '/scenes', { chapter: 1, title: 'X', body: 'x' }], ['PUT', `/scenes/${SCENE}/draft`, { body: 'x', base_sha256: 'a'.repeat(64) }]]) {
      const r = await t.plugin(tok, method, `${base}${p}`, { body });
      assert.equal(r.status, 403, `${level} ${method} ${p}: ${r.text}`);
      assert.equal(r.json.code, 'AI_LEVEL', `${level} ${p}`);
      assert.equal(r.json.level, level);
      assert.equal(r.json.needs, 'cowriter');
    }
    assert.deepEqual(await readAll(t.root), before, `${level}: refused writes changed nothing`);
    assert.equal((await t.plugin(tok, 'GET', `${base}/context?chapter=1`)).status, 200, `${level}: context is a read`);
  }
});

test('POST scenes: the scene is always an AI draft (origin ai, status drafting) whatever the plugin sent, goes at the end of its chapter, and its words are logged as AI words', async () => {
  const { t, token } = await boot();
  const before = await readAll(t.root);
  const prose = 'The water was black and slow. A bell rang twice across the marsh.\n';
  const r = await t.plugin(token, 'POST', `${base}/scenes`, { body: { chapter: 1, title: 'The Crossing', body: prose, summary: 'They cross.', status: 'final', origin: 'author', id: 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', pov: 'x' } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.id, /^scene_/);
  assert.notEqual(r.json.id, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'the plugin cannot choose the id');
  const text = await fs.readFile(path.join(t.root, ...r.json.path.split('/')), 'utf8');
  assert.match(text, /\nstatus: drafting\norigin: ai\n/);
  assert.doesNotMatch(text, /status: final|origin: author|pov:/);
  assert.match(text, /title: "?The Crossing"?/);
  assert.ok(text.endsWith(prose));
  const scene = (await t.plugin(token, 'GET', `${base}/scenes/${r.json.id}`)).json;
  assert.equal(scene.status, 'drafting');
  assert.equal(scene.front_matter.origin, 'ai');
  assert.equal(scene.chapter, 1);
  // the last scene of chapter 1 is before it
  const book = (await t.plugin(token, 'GET', base)).json;
  const ch1 = book.acts.flatMap((a) => a.chapters).find((c) => c.chapter === 1).scenes;
  assert.equal(ch1[ch1.length - 1].id, r.json.id, 'appended at the end of the chapter');
  // AI words logged for today (13 words), and nothing counted as the author's
  assert.equal(await todayAiWords(t), 13);
  // the app's book view badges it, an author scene is not badged
  const appBook = (await t.member('GET', `/api/books/${BOOK}`)).json;
  const rows = appBook.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
  assert.equal(rows.find((s) => s.id === r.json.id).origin, 'ai');
  assert.equal(rows.find((s) => s.id === SCENE).origin, undefined);
  // only the one new file (and the store) is new; every existing file is byte for byte the same
  const after = await readAll(t.root);
  const touched = changed(before, after).filter((f) => !isStore(f) && !f.startsWith('activity/'));
  assert.deepEqual(touched, [r.json.path], touched.join(', '));
});

test('POST scenes: a dry run previews and writes and logs nothing; a bad body is refused before anything is written', async () => {
  const { t, token } = await boot();
  const before = await readAll(t.root);
  const dry = await t.plugin(token, 'POST', `${base}/scenes`, { body: { chapter: 1, title: 'Preview', body: 'a b c\n', dryRun: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(Array.isArray(dry.json.changes));
  assert.equal(await todayAiWords(t), 0);
  assert.deepEqual(await readAll(t.root), before);
  for (const body of [{ chapter: 1, title: 'x' }, { title: 'x', body: 'x' }, { chapter: 1, body: 'x' }, { chapter: 99, title: 'x', body: 'x' }, { chapter: 1, title: 'x', body: 'x', after: 'scene_nope' }]) {
    const r = await t.plugin(token, 'POST', `${base}/scenes`, { body });
    assert.ok([400, 404, 409].includes(r.status), `${JSON.stringify(body)}: ${r.status} ${r.text}`);
  }
  assert.deepEqual(await readAll(t.root), before);
  assert.equal(await todayAiWords(t), 0);
});

test('POST chapters: a new chapter after chapter 3 (an AI Activity item the author can archive); no existing file changes', async () => {
  const { t, token } = await boot();
  const before = await readAll(t.root);
  const r = await t.plugin(token, 'POST', `${base}/chapters`, { body: { title: 'The Ferry', after: 3 } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.chapter, 4);
  const after = await readAll(t.root);
  const touched = changed(before, after).filter((f) => !isStore(f));
  assert.ok(touched.length > 0 && touched.every((f) => !before.has(f)), `only new files: ${touched.join(', ')}`);
  assert.equal((await t.plugin(token, 'POST', `${base}/chapters`, { body: { after: 3 } })).status, 400, 'a title is required');
  assert.equal((await t.plugin(token, 'POST', `${base}/chapters`, { body: { title: 'Lost', after: 77 } })).status >= 400, true);

  const feed = (await t.member('GET', `/api/books/${BOOK}/ai-activity`)).json.activity;
  const item = feed.find((i) => i.route === 'createChapter');
  assert.deepEqual([item.archivable, item.undoable, item.target], [true, false, { kind: 'chapter', id: 4 }]);
  assert.equal(item.actor.name, 'mcp-cowriter');
  // the author archives it with the existing chapter archive route
  assert.equal((await t.member('POST', `/api/books/${BOOK}/chapters/4/archive`, {})).status, 200);
  const feed2 = (await t.member('GET', `/api/books/${BOOK}/ai-activity`)).json.activity;
  assert.deepEqual(feed2.find((i) => i.route === 'createChapter').target, null);
});

test('PUT draft: replaces the body of an unaccepted AI draft with its sha; a stale sha is 409; the delta is logged as AI words; the author text of other scenes is untouched', async () => {
  const { t, token } = await boot();
  const made = await t.plugin(token, 'POST', `${base}/scenes`, { body: { chapter: 1, title: 'Draft', body: 'One two three.\n' } });
  assert.equal(made.status, 201, made.text);
  const logged = await todayAiWords(t);
  const sha = (await t.plugin(token, 'GET', `${base}/scenes/${made.json.id}`)).json.sha256;
  const before = await readAll(t.root);

  const put = await t.plugin(token, 'PUT', `${base}/scenes/${made.json.id}/draft`, { body: { body: 'One two three four five six seven.\n', base_sha256: sha } });
  assert.equal(put.status, 200, put.text);
  assert.match(put.json.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(put.json.sha256, sha);
  const now = (await t.plugin(token, 'GET', `${base}/scenes/${made.json.id}`)).json;
  assert.equal(now.body.trim(), 'One two three four five six seven.');
  assert.equal(now.front_matter.origin, 'ai');
  assert.equal(now.status, 'drafting');
  assert.ok(put.json.words.added >= 4);
  assert.equal(await todayAiWords(t), logged + put.json.words.added, 'the added words are logged as AI words');
  const after = await readAll(t.root);
  assert.deepEqual(changed(before, after).filter((f) => !isStore(f) && !f.startsWith('activity/')), [now.path], 'only the draft changed');

  // the sha of the first read is stale now
  const stale = await t.plugin(token, 'PUT', `${base}/scenes/${made.json.id}/draft`, { body: { body: 'late\n', base_sha256: sha } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal((await t.plugin(token, 'GET', `${base}/scenes/${made.json.id}`)).json.body.trim(), 'One two three four five six seven.');
  // a missing or malformed sha is a 400, never an unconditional write
  assert.equal((await t.plugin(token, 'PUT', `${base}/scenes/${made.json.id}/draft`, { body: { body: 'x\n' } })).status, 400);
  assert.equal((await t.plugin(token, 'PUT', `${base}/scenes/${made.json.id}/draft`, { body: { base_sha256: put.json.sha256 } })).status, 400);
  assert.equal((await t.plugin(token, 'PUT', `${base}/scenes/scene_01S5NOSUCHSCENE0000000000/draft`, { body: { body: 'x\n', base_sha256: sha } })).status, 404);
});

test('PUT draft: an author scene is 403 NOT_AI_DRAFT and stays byte for byte; so is an AI scene the author accepted (status changed); the AI proposes an edit instead', async () => {
  const { t, token } = await boot();
  const authorSha = (await t.plugin(token, 'GET', `${base}/scenes/${SCENE}`)).json.sha256;
  const authorFile = await fs.readFile(path.join(t.root, ...SCENE_PATH.split('/')));
  const refused = await t.plugin(token, 'PUT', `${base}/scenes/${SCENE}/draft`, { body: { body: 'AI overwrites the author.\n', base_sha256: authorSha } });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, 'NOT_AI_DRAFT');
  assert.match(refused.json.message, /the author has accepted or written this scene; propose an edit instead/);
  assert.ok((await fs.readFile(path.join(t.root, ...SCENE_PATH.split('/')))).equals(authorFile));

  const made = await t.plugin(token, 'POST', `${base}/scenes`, { body: { chapter: 1, title: 'Soon accepted', body: 'Draft text.\n' } });
  const first = (await t.plugin(token, 'GET', `${base}/scenes/${made.json.id}`)).json;
  // the author accepts it in the app: the status leaves drafting
  const accept = await t.member('POST', `/api/books/${BOOK}/scenes/${made.json.id}/fields`, { status: 'revised' });
  assert.equal(accept.status, 200, accept.text);
  const accepted = (await t.plugin(token, 'GET', `${base}/scenes/${made.json.id}`)).json;
  const file = await fs.readFile(path.join(t.root, ...accepted.path.split('/')));
  for (const sha of [first.sha256, accepted.sha256]) {
    const r = await t.plugin(token, 'PUT', `${base}/scenes/${made.json.id}/draft`, { body: { body: 'The AI tries again.\n', base_sha256: sha } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'NOT_AI_DRAFT');
  }
  assert.ok((await fs.readFile(path.join(t.root, ...accepted.path.split('/')))).equals(file), 'the accepted scene did not change');
  // a proposal still works (the author reviews it)
  const proposer = (await t.grant({ plugin: 'mcp-proposer', permissions: ['read', 'propose'] })).token;
  const prop = await t.plugin(proposer, 'POST', `${base}/proposals`, { body: { target: made.json.id, text: 'A proposed rewrite.\n' } });
  assert.notEqual(prop.status, 403, prop.text);
});

test('the scene-ai-draft app route is not an escape hatch: a plugin cannot reach /ai-draft, /body or /raw, and an author-scene body PUT by the author still works', async () => {
  const { t, token } = await boot();
  const sha = (await t.plugin(token, 'GET', `${base}/scenes/${SCENE}`)).json.sha256;
  const before = await readAll(t.root);
  for (const [method, p] of [['PUT', `/scenes/${SCENE}/ai-draft`], ['PUT', `/scenes/${SCENE}/body`], ['PUT', `/scenes/${SCENE}/raw`], ['POST', `/scenes/${SCENE}/fields`], ['POST', `/scenes/${SCENE}/archive`]]) {
    const r = await t.plugin(token, method, `${base}${p}`, { body: { body: 'x', content: 'x', base_sha256: sha } });
    assert.ok([403, 404].includes(r.status), `${method} ${p}: ${r.status}`);
  }
  assert.deepEqual(await readAll(t.root), before);
  const mine = await t.member('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'The author rewrites it.\n', base_sha256: sha });
  assert.equal(mine.status, 200, mine.text);
});

test('GET context: the pack for a chapter, the budget, and bad query values', async () => {
  const { t, token } = await boot('valid/planner');
  const r = await t.plugin(token, 'GET', `${base}/context?chapter=2`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.chapter, 2);
  assert.equal(r.json.budget, 24000);
  assert.ok(r.json.chars > 0 && r.json.chars <= 24000);
  assert.deepEqual(r.json.truncated, []);
  assert.deepEqual(r.json.scene_plans.map((s) => s.title), ['Ferry']);
  assert.ok(r.json.previous_tail.length > 0);
  assert.ok(!/"(path|sha256)"/.test(JSON.stringify({ ...r.json, workspace: [], state_docs: [] })), 'no file paths or hashes outside the docs');
  const small = await t.plugin(token, 'GET', `${base}/context?chapter=2&budget=600`);
  assert.equal(small.status, 200);
  assert.ok(small.json.chars <= 600);
  assert.ok(small.json.truncated.length > 0);
  const app = await t.member('GET', `/api/books/${BOOK}/context?chapter=2`);
  assert.equal(app.status, 200, app.text);
  assert.deepEqual(app.json, r.json, 'the app route and the plugin route give the same pack');
  for (const q of ['', '?chapter=x', '?chapter=-1', '?chapter=1&budget=10', '?chapter=1&budget=99999999', '?chapter=1&budget=abc']) {
    assert.equal((await t.plugin(token, 'GET', `${base}/context${q}`)).status, 400, q);
    assert.equal((await t.member('GET', `/api/books/${BOOK}/context${q}`)).status, 400, q);
  }
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/context?chapter=1`)).status, 403, 'an unknown book is not a granted book');
});
