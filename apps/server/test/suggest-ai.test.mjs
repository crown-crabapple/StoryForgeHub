// M05-J06 acceptance 5: an AI rewrite now creates a pending suggestion (source ai, ai block, no key) instead of holding the reply in memory;
// the M05-J04 routes keep working: apply = accept all hunks, discard = decline all. Single hunks are decided with the section 1.2 routes.
//   POST /api/books/:b/ai/context { task: 'rewrite', files, selection: { sceneId, from, to }, instruction }
//   POST /api/books/:b/ai/send    { contextId }
//   POST /api/books/:b/ai/apply   { contextId }   POST /api/books/:b/ai/discard { contextId }
// Expected bytes are spliced from the original file here. The suggestion file is located by scanning suggestions/ (its list route is not fixed by the contract).
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 1.1, 6.5; M05-J04 section 4.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AI, ARRIVAL, ARRIVAL_PATH, freshLibrary, getScene, makeHome, readConfigFiles, readEverything, setupProvider, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { A, NEW, SUG, changedContent, fmOf, opIdOf, readBytes, readText, replaceLines, tree } from './suggest-helpers.mjs';

const SECRET = 'sk-test-J06-SECRET-0123456789';
const TARGET = 'The ferry nudged the jetty and [[tobin-reyes|the ferryman]] threw her bag ashore.';
const REWRITTEN = 'The ferry bumped the jetty, and the ferryman flung her bag ashore.';

let mock;
before(async () => {
  mock = await startMockProvider({ reply: REWRITTEN });
});
after(async () => {
  await mock.close();
  await stopAll();
});

async function boot() {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true });
  await setupProvider(app, { baseUrl: mock.baseUrl, keyStorage: 'session', [AI.keyField]: SECRET });
  return { library, home, app };
}
async function rewrite(app, from, to, reply) {
  const scene = await getScene(app, ARRIVAL);
  const r = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: ARRIVAL, from: from ?? 0, to: to ?? scene.body.length }, instruction: 'Tighten.' });
  assert.equal(r.status, 200, r.text);
  mock.setReply(reply);
  const sent = await app.post(AI.send(), { contextId: r.json.contextId });
  assert.equal(sent.status, 200, sent.text);
  return { contextId: r.json.contextId, scene, sent };
}
async function suggestionFiles(library) {
  const out = [];
  const root = path.join(library, 'suggestions');
  async function walk(dir) {
    let es;
    try {
      es = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md')) out.push(path.relative(library, full).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out;
}
const oneSuggestion = async (library) => {
  const files = await suggestionFiles(library);
  assert.equal(files.length, 1, `exactly one suggestion file, saw ${files}`);
  const text = await readText(library, files[0]);
  return { rel: files[0], text, fm: fmOf(text) };
};

test('a rewrite creates one pending suggestion (source ai, ai block, no key) and does NOT touch the scene', async () => {
  const { library, home, app } = await boot();
  const sceneBefore = await readBytes(library, ARRIVAL_PATH);
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  assert.ok(from >= 0);
  const { sent } = await rewrite(app, from, from + TARGET.length, REWRITTEN);
  assert.ok(mock.calls.length > 0, 'the mock provider answered');

  assert.ok((await readBytes(library, ARRIVAL_PATH)).equals(sceneBefore), 'the scene is unchanged until the author accepts');
  const { rel, fm, text } = await oneSuggestion(library);
  assert.match(rel, /^suggestions\/\d{4}\/\d{8}-\d{6}-[a-z0-9-]+\.md$/);
  assert.equal(fm.schema, 'storyforge.suggestion/v1');
  assert.equal(fm.source, 'ai');
  assert.equal(fm.status, 'pending');
  assert.equal(fm.target, ARRIVAL);
  assert.match(fm.id, /^note_[0-9A-Z]{26}$/);
  assert.equal(fm.target_path, ARRIVAL_PATH);
  assert.equal(fm.base_sha256, (await import('node:crypto')).createHash('sha256').update(sceneBefore).digest('hex'));
  assert.ok(fm.ai, 'ai block');
  assert.equal(fm.ai.model, 'test-model');
  assert.equal(fm.ai.locality, 'local');
  assert.equal(typeof fm.ai.provider, 'string');
  assert.match(String(fm.ai.context_sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(fm.hunks.map((h) => [h.line, h.lines, h.status]), [[A.L1, 1, 'pending']]);
  assert.ok(text.includes(REWRITTEN), 'the proposed text is in the diff block');

  // the key is nowhere in the book (suggestion included, .storyforge included), nor in any response, nor on the server's output
  for (const [name, buf] of await readEverything(library)) assert.ok(!buf.toString('latin1').includes(SECRET), `key in ${name}`);
  assert.ok(!sent.text.includes(SECRET));
  assert.ok(!app.output().includes(SECRET));
  assert.ok(!JSON.stringify(await readConfigFiles(home.configDir)).includes(SECRET), 'session key is not on disk at all');
});

test('J04 apply = accept all hunks: the scene changes only the selected range and the suggestion is accepted; Undo restores', async () => {
  const { library, app } = await boot();
  const sceneBefore = (await readBytes(library, ARRIVAL_PATH)).toString('utf8');
  const bytesBefore = await readBytes(library, ARRIVAL_PATH);
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const { contextId } = await rewrite(app, from, from + TARGET.length, REWRITTEN);
  const sugBefore = await oneSuggestion(library);
  const r = await app.post(AI.apply(), { contextId });
  assert.equal(r.status, 200, r.text);
  assert.equal(await readText(library, ARRIVAL_PATH), replaceLines(sceneBefore, { [A.L1]: REWRITTEN }));
  const after = await oneSuggestion(library);
  assert.equal(after.fm.status, 'accepted');
  assert.equal(after.fm.id, sugBefore.fm.id);
  assert.ok(after.fm.hunks.every((h) => h.status === 'accepted'));
  if (opIdOf(r)) {
    const u = await app.post(SUG.restore(opIdOf(r)), {});
    assert.equal(u.status, 200, u.text);
    assert.ok((await readBytes(library, ARRIVAL_PATH)).equals(bytesBefore), 'Undo byte-identical');
    assert.equal((await oneSuggestion(library)).text, sugBefore.text, 'suggestion restored too');
  }
});

test('J04 discard = decline all hunks: scene byte-identical, suggestion declined, nothing else changes', async () => {
  const { library, app } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const { contextId } = await rewrite(app, from, from + TARGET.length, REWRITTEN);
  const before = await tree(library);
  const r = await app.post(AI.discard(), { contextId });
  assert.equal(r.status, 200, r.text);
  const after = await tree(library);
  const { rel, fm } = await oneSuggestion(library);
  assert.deepEqual(changedContent(before, after), [rel]);
  assert.equal(fm.status, 'declined');
  assert.ok(fm.hunks.every((h) => h.status === 'declined'));
});

test('a whole-body rewrite touching three lines makes a three-hunk suggestion; accepting h2 changes only line 17', async () => {
  const { library, app } = await boot();
  const original = (await readBytes(library, ARRIVAL_PATH)).toString('utf8');
  const scene = await getScene(app, ARRIVAL);
  assert.ok(original.endsWith(scene.body), 'scene body is the tail of the file');
  const proposedFile = replaceLines(original, { 15: NEW[15], 17: NEW[17], 19: NEW[19] });
  const proposedBody = proposedFile.slice(original.length - scene.body.length);
  await rewrite(app, 0, scene.body.length, proposedBody);

  const { fm } = await oneSuggestion(library);
  assert.deepEqual(fm.hunks.map((h) => [h.line, h.lines, h.status]), [[15, 1, 'pending'], [17, 1, 'pending'], [19, 1, 'pending']]);
  assert.ok((await readBytes(library, ARRIVAL_PATH)).equals(Buffer.from(original)), 'still unapplied');

  const r = await app.post(SUG.decideHunk(fm.id, fm.hunks[1].id), { decision: 'accept' });
  assert.equal(r.status, 200, r.text);
  assert.equal(await readText(library, ARRIVAL_PATH), replaceLines(original, { 17: NEW[17] }));
  const after = await oneSuggestion(library);
  assert.equal(after.fm.status, 'partial');
  assert.deepEqual(after.fm.hunks.map((h) => h.status), ['pending', 'accepted', 'pending']);
});

test('a rewrite whose reply equals the selection creates no suggestion and no write (NO_CHANGE)', async () => {
  const { library, app } = await boot();
  const before = await tree(library);
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const ctx = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: ARRIVAL, from, to: from + TARGET.length }, instruction: 'Keep.' });
  mock.setReply(TARGET);
  const sent = await app.post(AI.send(), { contextId: ctx.json.contextId });
  assert.ok(sent.status < 500, sent.text);
  assert.deepEqual(await suggestionFiles(library), []);
  assert.deepEqual(changedContent(before, await tree(library)), []);
});
