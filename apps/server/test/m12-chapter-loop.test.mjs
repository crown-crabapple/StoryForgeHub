// M12 acceptance: an AI runs a whole chapter loop over MCP (POST /mcp with a token) at Co-writer level, every write shows in AI Activity, and lower levels refuse.
// One server over a copy of the planner fixture (scenes, entries, planner data); the book is set to cowriter through the app's own ai-level route.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { setBookPreferences } from './custom-helpers.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SCENE, SCENE_PATH, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const PERMS = ['read', 'propose', 'plan', 'workspace', 'draft'];
const base = `/api/v1/books/${BOOK}`;
const textOf = (result) => result.content.map((c) => c.text).join('\n');

let nextId = 1;
/** tools/call as the plugin; the JSON-RPC result (HTTP 200 and no protocol error asserted). */
async function call(t, token, name, args = {}) {
  const r = await t.plugin(token, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.error, undefined, r.text);
  return r.json.result;
}
/** A tool call that must succeed; returns structuredContent. */
async function ok(t, token, name, args) {
  const r = await call(t, token, name, { book: SLUG, ...args });
  assert.notEqual(r.isError, true, `${name}: ${textOf(r)}`);
  return r.structuredContent;
}
/** A tool call that must be refused with `code` (the tool error names the HTTP status and code). */
async function refused(t, token, name, args, code, status = 403) {
  const r = await call(t, token, name, { book: SLUG, ...args });
  assert.equal(r.isError, true, `${name} should be refused: ${textOf(r)}`);
  assert.match(textOf(r), new RegExp(`${status} ${code}\\b`), `${name}: ${textOf(r)}`);
  return r;
}
const feedOf = async (t) => {
  const r = await t.member('GET', `/api/books/${BOOK}/ai-activity`);
  assert.equal(r.status, 200, r.text);
  return r.json.activity;
};

async function boot(level = 'cowriter') {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  await setBookPreferences(t.root, `  ai:\n    level: ${level}\n`);
  const { token } = await t.grant({ plugin: 'mcp-chapter-loop', permissions: PERMS });
  return { t, token };
}

const CHAPTER_NO = 4; // the planner fixture has chapters 0 to 3
const PROSE = 'The ferry bell rang twice across the marsh. Maren held the rail and counted the strokes.\n';

test('an AI runs the whole chapter loop over MCP at Co-writer level; every write is in AI Activity; no existing scene changes', async () => {
  const { t, token } = await boot();
  assert.equal((await t.member('GET', `/api/preferences?book=${BOOK}`)).json.effective.ai.level, 'cowriter');
  const before = await readAll(t.root);

  // orient
  const statusR = await call(t, token, 'codex_status', {});
  assert.notEqual(statusR.isError, true, textOf(statusR));
  const status = statusR.structuredContent;
  assert.deepEqual(status.books.map((b) => b.slug), [SLUG]);
  const setup = await ok(t, token, 'codex_setup_workspace', {});
  assert.match(setup.note, /Undo/);
  const style = await call(t, token, 'codex_get_doc', { book: SLUG, path: 'workspace/style' });
  assert.notEqual(style.isError, true, textOf(style));
  assert.equal(style.structuredContent.path, 'workspace/style');
  assert.match(style.structuredContent.sha256, /^[0-9a-f]{64}$/);
  const pack = await ok(t, token, 'codex_get_context', { chapter: CHAPTER_NO });
  assert.equal(pack.chapter, CHAPTER_NO);
  assert.ok(pack.chars > 0 && pack.chars <= pack.budget);
  assert.ok(pack.previous_tail.length > 0, 'the end of the previous chapter is in the pack');

  // the chapter and its plan
  const chapter = await ok(t, token, 'codex_create_chapter', { title: 'The Crossing', after: 3 });
  assert.equal(chapter.chapter, CHAPTER_NO);
  assert.match(chapter.scene, /^scene_/, 'the placeholder scene');
  const plan = await ok(t, token, 'codex_save_scene_plan', { scene: chapter.scene, fields: { goal: 'Cross the water before the tide turns', conflict: 'The bell warns of a rising tide' }, characters: ['maren-hollis', 'pell'] });
  assert.ok(plan.note);
  const check = await ok(t, token, 'codex_continuity_check', { chapter: CHAPTER_NO, cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'pell', role: 'appears' }] });
  assert.ok(Array.isArray(check.findings), 'the pre-flight returns findings');

  // the prose: a new AI draft scene
  const made = await ok(t, token, 'codex_create_scene', { chapter: CHAPTER_NO, title: 'Bell Water', body: PROSE, summary: 'Maren hears the bell.' });
  assert.match(made.id, /^scene_/);
  const text = await fs.readFile(path.join(t.root, ...made.path.split('/')), 'utf8');
  assert.match(text, /\nstatus: drafting\norigin: ai\n/);
  assert.ok(text.endsWith(PROSE));

  // revise it with the right sha
  const got = await ok(t, token, 'codex_get_scene', { scene: made.id });
  assert.equal(got.status, 'drafting');
  const revised = PROSE + 'Pell said nothing, and the water rose.\n';
  const saved = await ok(t, token, 'codex_save_draft', { scene: made.id, body: revised, base_sha256: got.sha256 });
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(saved.sha256, got.sha256);
  assert.ok(saved.words.added > 0);
  assert.ok((await fs.readFile(path.join(t.root, ...made.path.split('/')), 'utf8')).endsWith(revised));
  // a stale sha is a conflict, not a write
  const stale = await call(t, token, 'codex_save_draft', { book: SLUG, scene: made.id, body: 'late\n', base_sha256: got.sha256 });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /409/);

  // the cast, what they learn, what changed, a promise planted here
  const cast = await ok(t, token, 'codex_set_chapter_cast', { scene: made.id, cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'pell', role: 'appears' }, { entry: 'ferry-bell', role: 'mentioned' }] });
  assert.ok(cast.note);
  await ok(t, token, 'codex_record_knowledge', { character: 'maren-hollis', fact: 'The bell rings twice before the tide turns', chapter: CHAPTER_NO });
  const k = await ok(t, token, 'codex_knowledge_at', { character: 'maren-hollis', at: CHAPTER_NO });
  assert.ok(k.facts.some((f) => f.fact === 'the-bell-rings-twice-before-the-tide-turns'), JSON.stringify(k.facts));
  await ok(t, token, 'codex_record_state_events', { chapter: CHAPTER_NO, items: [{ subject: 'ferry-bell', kind: 'holder', value: 'maren-hollis' }] });
  assert.ok((await ok(t, token, 'codex_get_state_events', { chapter: CHAPTER_NO })).events.some((e) => e.subject.slug === 'ferry-bell'));
  const thread = await ok(t, token, 'codex_save_ledger_item', { title: 'Pell will explain the second bell', kind: 'promise', status: 'planted', setup: [made.id] });
  assert.ok(thread.note);
  const ledger = await ok(t, token, 'codex_get_ledger', {});
  assert.ok(ledger.promises.some((p) => p.title === 'Pell will explain the second bell' && p.status === 'planted' && p.setup_chapters.includes(CHAPTER_NO)), JSON.stringify(ledger.promises));

  // state docs for the chapter, then lock them
  const folder = `state/chapter-0${CHAPTER_NO}`;
  for (const doc of ['situation', 'characters', 'knowledge', 'inventory']) {
    await ok(t, token, 'codex_save_doc', { path: `${folder}/${doc}`, body: `Chapter ${CHAPTER_NO} ${doc}.\n` });
  }
  const sit = await ok(t, token, 'codex_get_doc', { path: `${folder}/situation` });
  assert.equal(sit.locked, false);
  await ok(t, token, 'codex_lock_docs', { prefix: folder });
  assert.equal((await ok(t, token, 'codex_get_doc', { path: `${folder}/situation` })).locked, true);
  assert.equal((await ok(t, token, 'codex_get_doc', { path: `${folder}/inventory` })).locked, true, 'every state doc of the chapter is locked');

  // log the words, hand the author a task
  await ok(t, token, 'codex_log_writing', { words: 25, chapter: CHAPTER_NO, note: 'Drafted Bell Water' });
  const task = await ok(t, token, 'codex_create_task', { title: 'Check the tide times in chapter 4', for: 'ai' });
  assert.ok(task.note);
  assert.ok((await ok(t, token, 'codex_get_tasks', { for: 'ai' })).tasks.some((x) => x.title === 'Check the tide times in chapter 4'));

  // AI Activity: every write step is there with the plugin as actor
  const feed = await feedOf(t);
  assert.ok(feed.length >= 14, `expected one item per write, got ${feed.length}: ${feed.map((i) => i.route).join(', ')}`);
  for (const it of feed) {
    assert.equal(it.actor.kind, 'plugin');
    assert.equal(it.actor.name, 'mcp-chapter-loop');
    assert.match(it.actor.id, /^tok_/);
    assert.equal(it.undone, false);
  }
  const routes = feed.map((i) => i.route);
  for (const expected of ['setupWorkspace', 'createChapter', 'saveScenePlan', 'insertScene', 'setSceneCast', 'recordEventState', 'createThread', 'setThreadFields', 'saveWorkspaceDoc', 'lockWorkspaceDocs', 'createTask']) assert.ok(routes.includes(expected), `${expected} in ${routes.join(', ')}`);
  const chapterItem = feed.find((i) => i.route === 'createChapter');
  assert.deepEqual([chapterItem.archivable, chapterItem.target], [true, { kind: 'chapter', id: CHAPTER_NO }]);
  const sceneItem = feed.find((i) => i.target?.kind === 'scene' && i.target.id === made.id);
  assert.ok(sceneItem, `the new scene is an activity item: ${JSON.stringify(feed.map((i) => [i.route, i.target]))}`);
  assert.equal(sceneItem.archivable, true);
  // touched files: the draft path appears in the feed, and the task / doc / ledger writes are there
  const files = feed.flatMap((i) => i.files);
  for (const needle of [made.path, 'planning/tasks/', 'planning/workspace/book.md', 'planning/state/chapter-04/situation.md', 'planning/scene-plans/', 'planning/timeline/chapter-4-state.md', 'planning/threads/', 'activity/writing-log.md']) {
    assert.ok(files.some((f) => f.includes(needle)), `${needle} missing from ${[...new Set(files)].join(', ')}`);
  }

  // Undo one non-create item: the update that attached the setup scene to the promise
  const threadItem = feed.find((i) => i.route === 'setThreadFields');
  assert.ok(threadItem && threadItem.undoable === true);
  const undo = await t.member('POST', `/api/books/${BOOK}/ops/${threadItem.opId}/restore`, {});
  assert.equal(undo.status, 200, undo.text);
  const promise = (await ok(t, token, 'codex_get_ledger', {})).promises.find((p) => p.title === 'Pell will explain the second bell');
  assert.ok(promise, 'the promise itself (a create) is still there');
  assert.deepEqual(promise.setup_chapters ?? [], [], 'the setup scene was undone');
  assert.equal((await feedOf(t)).find((i) => i.opId === threadItem.opId).undone, true);

  // Safety: no existing file under manuscript/ changed; only the new chapter folder and scene are new
  const after = await readAll(t.root);
  for (const [f, buf] of before) {
    if (f.startsWith('manuscript/')) assert.ok(after.get(f)?.equals(buf), `${f} is untouched`);
  }
  const added = [...after.keys()].filter((f) => f.startsWith('manuscript/') && !before.has(f));
  assert.ok(added.length >= 1 && added.includes(made.path), added.join(', '));
  assert.ok(!added.includes(SCENE_PATH));
});

test('safety: an author scene, an accepted AI scene and a locked doc are refused; an unlock is the author\'s alone', async () => {
  const { t, token } = await boot();
  await ok(t, token, 'codex_setup_workspace', {});
  const author = await ok(t, token, 'codex_get_scene', { scene: SCENE });
  const authorFile = await fs.readFile(path.join(t.root, ...SCENE_PATH.split('/')));
  await refused(t, token, 'codex_save_draft', { scene: SCENE, body: 'AI overwrites the author.\n', base_sha256: author.sha256 }, 'NOT_AI_DRAFT');
  assert.ok((await fs.readFile(path.join(t.root, ...SCENE_PATH.split('/')))).equals(authorFile), 'the author scene is byte for byte the same');

  // an AI scene the author accepts by changing its status
  const made = await ok(t, token, 'codex_create_scene', { chapter: 1, title: 'Soon accepted', body: 'Draft text.\n' });
  const sha = (await ok(t, token, 'codex_get_scene', { scene: made.id })).sha256;
  assert.equal((await t.member('POST', `/api/books/${BOOK}/scenes/${made.id}/fields`, { status: 'revised' })).status, 200);
  const accepted = await ok(t, token, 'codex_get_scene', { scene: made.id });
  const file = await fs.readFile(path.join(t.root, ...made.path.split('/')));
  await refused(t, token, 'codex_save_draft', { scene: made.id, body: 'The AI tries again.\n', base_sha256: accepted.sha256 }, 'NOT_AI_DRAFT');
  await refused(t, token, 'codex_save_draft', { scene: made.id, body: 'The AI tries again.\n', base_sha256: sha }, 'NOT_AI_DRAFT');
  assert.ok((await fs.readFile(path.join(t.root, ...made.path.split('/')))).equals(file), 'the accepted scene did not change');

  // a locked doc
  await ok(t, token, 'codex_save_doc', { path: 'state/chapter-05/situation', body: 'Locked soon.\n' });
  await ok(t, token, 'codex_lock_docs', { prefix: 'state/chapter-05' });
  const doc = await ok(t, token, 'codex_get_doc', { path: 'state/chapter-05/situation' });
  await refused(t, token, 'codex_save_doc', { path: 'state/chapter-05/situation', body: 'Changed.\n', base_sha256: doc.sha256 }, 'LOCKED', 409);
  assert.equal((await ok(t, token, 'codex_get_doc', { path: 'state/chapter-05/situation' })).sha256, doc.sha256, 'the locked doc did not change');

  // there is no unlock tool: the MCP schema rejects "locked" ...
  const viaTool = await call(t, token, 'codex_lock_docs', { book: SLUG, prefix: 'state/chapter-05', locked: false });
  assert.equal(viaTool.isError, true);
  assert.match(textOf(viaTool), /invalid arguments/);
  // ... and the plugin API refuses an unlock outright
  const viaApi = await t.plugin(token, 'POST', `${base}/workspace/docs/lock`, { body: { prefix: 'state/chapter-05', locked: false } });
  assert.equal(viaApi.status, 403, viaApi.text);
  assert.equal(viaApi.json.code, 'AUTHOR_ONLY');
  assert.equal((await ok(t, token, 'codex_get_doc', { path: 'state/chapter-05/situation' })).locked, true, 'still locked');
});

test('AI level: planner refuses scene creation (AI_LEVEL) but allows docs; advisor allows only tasks; off refuses everything but reads', async () => {
  const { t, token } = await boot();
  const level = async (l) => assert.equal((await t.member('POST', `/api/books/${BOOK}/ai-level`, { level: l })).status, 200);
  const scene = { chapter: 1, title: 'Not allowed', body: 'x y z\n' };

  await level('planner');
  const beforePlanner = await readAll(t.root);
  await refused(t, token, 'codex_create_scene', scene, 'AI_LEVEL');
  await refused(t, token, 'codex_create_chapter', { title: 'Nope', after: 3 }, 'AI_LEVEL');
  assert.deepEqual(await readAll(t.root), beforePlanner, 'a refused write changes nothing');
  await ok(t, token, 'codex_save_doc', { path: 'workspace/ideas', body: 'An idea.\n' });

  await level('advisor');
  await refused(t, token, 'codex_save_doc', { path: 'workspace/ideas2', body: 'Another.\n' }, 'AI_LEVEL');
  await refused(t, token, 'codex_create_scene', scene, 'AI_LEVEL');
  const beforeAdvisor = await readAll(t.root);
  await ok(t, token, 'codex_create_task', { title: 'Revise the ferry scene', for: 'ai' });
  assert.notDeepEqual(await readAll(t.root), beforeAdvisor);

  await level('off');
  await refused(t, token, 'codex_create_task', { title: 'Not now' }, 'AI_LEVEL');
  const beforeOff = await readAll(t.root);
  await refused(t, token, 'codex_save_doc', { path: 'workspace/ideas3', body: 'x\n' }, 'AI_LEVEL');
  assert.deepEqual(await readAll(t.root), beforeOff);
  assert.equal((await ok(t, token, 'codex_get_tasks', {})).tasks.length, 1, 'reads work and show the earlier task');
  await ok(t, token, 'codex_get_context', { chapter: 2 });
  await ok(t, token, 'codex_list_chapters', {});
  await ok(t, token, 'codex_get_doc', { path: 'workspace/ideas' });

  await level('cowriter');
  await ok(t, token, 'codex_create_scene', scene);
});

test('with the workspace module off the workspace tools are refused MODULE_OFF and write nothing', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  await setBookPreferences(t.root, '  ai:\n    level: cowriter\n  modules:\n    workspace: false\n');
  const { token } = await t.grant({ plugin: 'mcp-chapter-loop', permissions: PERMS });
  const before = await readAll(t.root);
  await refused(t, token, 'codex_setup_workspace', {}, 'MODULE_OFF');
  await refused(t, token, 'codex_save_doc', { path: 'workspace/ideas', body: 'x\n' }, 'MODULE_OFF');
  await refused(t, token, 'codex_record_knowledge', { character: 'maren-hollis', fact: 'A fact', chapter: 1 }, 'MODULE_OFF');
  await refused(t, token, 'codex_log_writing', { words: 5 }, 'MODULE_OFF');
  assert.deepEqual(await readAll(t.root), before);
});
