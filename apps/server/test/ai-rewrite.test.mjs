// M05-J04 acceptance 3: rewrite apply.
//   POST /api/books/:b/ai/context { task: 'rewrite', files, selection: { sceneId, from, to }, instruction }   (offsets: UTF-16 indices into the scene `body` as GET scene returns it)
//   POST /api/books/:b/ai/send    { contextId }
//   POST /api/books/:b/ai/apply   { contextId, replacement }   -> writes the scene through the store; 409 SCENE_CHANGED when the scene or the range changed since the preview
//   POST /api/books/:b/ai/discard { contextId }                -> writes nothing
// An accepted rewrite changes only the selected range (the rest of the file is byte-identical); Undo (the M03 exact write-back of the prior body) restores the prior bytes.
// The apply/discard route paths and the `replacement` field are not spelled out in the contract; they live in ai-helpers.mjs (AI) and this file's `apply` helper.
// Contract: docs/contracts/M05-J04-ai-workshop.md section 4 and acceptance 3.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AI, ARRIVAL, ARRIVAL_PATH, BOOK, freshLibrary, getScene, makeHome, setupProvider, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { snapshot } from './helpers.mjs';

const GRAFTING = 'scene_01S50000000000000000000006'; // the CRLF scene
const GRAFTING_PATH = 'manuscript/act-01-low-water/ch-002-the-grafting/0020-the-grafting.md';
const REWRITTEN = 'The ferry bumped the jetty, and the ferryman flung her bag ashore.';
const TARGET = 'The ferry nudged the jetty and [[tobin-reyes|the ferryman]] threw her bag ashore.';

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
  const app = await startApp({ library, home });
  await setupProvider(app, { baseUrl: mock.baseUrl });
  return { library, app, file: (rel) => path.join(library, ...rel.split('/')) };
}
const rewrite = async (app, scene, from, to, instruction = 'Tighten.') => {
  const r = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: scene.id, from, to }, instruction });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
/** The provider's reply becomes the replacement: make the mock answer with it, send the stored context, then Apply (which takes only the contextId). */
async function apply(app, contextId, replacement = REWRITTEN) {
  mock.setReply(replacement);
  const sent = await app.post(AI.send(), { contextId });
  assert.equal(sent.status, 200, sent.text);
  return app.post(AI.apply(), { contextId });
}
const readFile = (file) => fs.readFile(file);
/** Undo: the journaled op the apply returned (POST /ops/:opId/restore) when there is one, else the same guarded body write the editor uses. */
async function undo(app, scene, priorBody, applied) {
  if (applied?.json?.opId) return app.post(`/api/books/${BOOK}/ops/${encodeURIComponent(applied.json.opId)}/restore`, {});
  const now = await getScene(app, scene.id);
  return app.put(`/api/books/${BOOK}/scenes/${scene.id}/body`, { body: priorBody, base_sha256: now.sha256 });
}

test('the selected text really is in the rewrite preview (selection offsets address the scene body)', async () => {
  const { app } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  assert.ok(from >= 0);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  assert.ok(p.messages.map((m) => m.content).join('\n').includes(TARGET));
});

test('apply changes only the selected range; the rest of the file is byte-identical', async () => {
  const { library, app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const before = await readFile(file(ARRIVAL_PATH));
  const from = scene.body.indexOf(TARGET);
  const to = from + TARGET.length;
  const p = await rewrite(app, scene, from, to);
  const r = await apply(app, p.contextId);
  assert.equal(r.status, 200, r.text);
  // expected bytes computed from the original bytes, independent of the product
  const text = before.toString('utf8');
  const bodyStart = text.indexOf(scene.body);
  assert.ok(bodyStart > 0, 'body located in the file');
  const expected = text.slice(0, bodyStart + from) + REWRITTEN + text.slice(bodyStart + to);
  const after = await readFile(file(ARRIVAL_PATH));
  assert.equal(after.toString('utf8'), expected);
  // nothing else in the book changed (the .storyforge bookkeeping may)
  const snap = await snapshot(library, { skipStoryforge: true });
  assert.ok(Object.keys(snap).every((k) => !k.startsWith('ai/')), 'no ai/ records unless switched on');
});

test('apply leaves every other file byte-identical', async () => {
  const { library, app } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const before = await snapshot(library, { skipStoryforge: true });
  const p = await rewrite(app, scene, from, from + TARGET.length);
  assert.equal((await apply(app, p.contextId)).status, 200);
  const after = await snapshot(library, { skipStoryforge: true });
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [ARRIVAL_PATH]);
});

test('Undo restores the prior bytes exactly', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const before = await readFile(file(ARRIVAL_PATH));
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  const applied = await apply(app, p.contextId);
  assert.equal(applied.status, 200, applied.text);
  assert.ok(!(await readFile(file(ARRIVAL_PATH))).equals(before));
  const u = await undo(app, scene, scene.body, applied);
  assert.equal(u.status, 200, u.text);
  assert.ok((await readFile(file(ARRIVAL_PATH))).equals(before), 'byte-identical after Undo');
});

test('apply on a CRLF scene keeps every other line ending and Undo is byte-identical', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, GRAFTING);
  const before = await readFile(file(GRAFTING_PATH));
  const sel = 'Every cut left its [[saltmarks]] on the bark by morning.';
  assert.ok(scene.body.includes('\r\n'), 'the fixture scene is CRLF');
  const from = scene.body.indexOf(sel); // index in the real (CRLF) text
  assert.ok(from >= 0, 'selection found in the CRLF scene');
  const lfFrom = scene.body.replace(/\r\n/g, '\n').indexOf(sel); // editor offsets count a line break as 1
  const p = await rewrite(app, scene, lfFrom, lfFrom + sel.length);
  const applied = await apply(app, p.contextId, 'Each cut left its mark.');
  assert.equal(applied.status, 200, applied.text);
  const text = before.toString('utf8');
  const bodyStart = text.indexOf(scene.body);
  const expected = text.slice(0, bodyStart + from) + 'Each cut left its mark.' + text.slice(bodyStart + from + sel.length);
  assert.equal((await readFile(file(GRAFTING_PATH))).toString('utf8'), expected);
  assert.equal((await undo(app, scene, scene.body, applied)).status, 200);
  assert.ok((await readFile(file(GRAFTING_PATH))).equals(before));
});

test('a multi-line reply on a CRLF scene keeps the scene line ending and everything outside the range byte-identical', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, GRAFTING);
  const before = (await readFile(file(GRAFTING_PATH))).toString('utf8');
  const sel = 'Pell handed over the [[grafting-knife]] handle first.';
  const from = scene.body.indexOf(sel);
  const lfFrom = scene.body.replace(/\r\n/g, '\n').indexOf(sel);
  const p = await rewrite(app, scene, lfFrom, lfFrom + sel.length);
  const r = await apply(app, p.contextId, 'Pell held out the knife.\nHandle first.');
  assert.equal(r.status, 200, r.text);
  const now = (await readFile(file(GRAFTING_PATH))).toString('utf8');
  const bodyStart = before.indexOf(scene.body);
  assert.equal(now.slice(0, bodyStart + from), before.slice(0, bodyStart + from), 'bytes before the range');
  assert.equal(now.slice(now.length - (before.length - (bodyStart + from + sel.length))), before.slice(bodyStart + from + sel.length), 'bytes after the range');
  assert.ok(!/(^|[^\r])\n/.test(now), 'no bare LF was introduced into a CRLF file');
});

test('SCENE_CHANGED when the scene changed elsewhere after the preview: 409, nothing written', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  // an edit OUTSIDE the range through the normal editor route
  const put = await app.put(`/api/books/${BOOK}/scenes/${ARRIVAL}/body`, { body: `${scene.body.trimEnd()}\n\nA late addition.\n`, base_sha256: scene.sha256 });
  assert.equal(put.status, 200, put.text);
  const edited = await readFile(file(ARRIVAL_PATH));
  const r = await apply(app, p.contextId);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code ?? r.json.error, 'SCENE_CHANGED');
  assert.ok((await readFile(file(ARRIVAL_PATH))).equals(edited), 'nothing written');
});

test('SCENE_CHANGED when the selected range itself changed after the preview: 409, nothing written', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  const put = await app.put(`/api/books/${BOOK}/scenes/${ARRIVAL}/body`, { body: scene.body.replace('nudged', 'bumped'), base_sha256: scene.sha256 });
  assert.equal(put.status, 200, put.text);
  const edited = await readFile(file(ARRIVAL_PATH));
  const r = await apply(app, p.contextId);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code ?? r.json.error, 'SCENE_CHANGED');
  assert.ok((await readFile(file(ARRIVAL_PATH))).equals(edited));
});

test('SCENE_CHANGED when the file was edited outside StoryForge after the preview', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  const raw = (await readFile(file(ARRIVAL_PATH))).toString('utf8');
  await fs.writeFile(file(ARRIVAL_PATH), raw.replace('half under water', 'half drowned'));
  const edited = await readFile(file(ARRIVAL_PATH));
  const r = await apply(app, p.contextId);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code ?? r.json.error, 'SCENE_CHANGED');
  assert.ok((await readFile(file(ARRIVAL_PATH))).equals(edited));
});

test('a second apply of the same preview is refused (the scene has changed since)', async () => {
  const { app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  assert.equal((await apply(app, p.contextId)).status, 200);
  const once = await readFile(file(ARRIVAL_PATH));
  const again = await apply(app, p.contextId);
  assert.ok(again.status === 409 || again.status === 404 || again.status === 410, again.text);
  assert.ok((await readFile(file(ARRIVAL_PATH))).equals(once));
});

test('Discard writes nothing, anywhere in the book', async () => {
  const { library, app } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const before = await snapshot(library, { skipStoryforge: true });
  const p = await rewrite(app, scene, from, from + TARGET.length);
  assert.equal((await app.post(AI.send(), { contextId: p.contextId })).status, 200);
  const r = await app.post(AI.discard(), { contextId: p.contextId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
  // a discarded preview cannot be applied afterwards
  const late = await app.post(AI.apply(), { contextId: p.contextId });
  assert.ok(late.status >= 400 && late.status < 500, late.text);
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

test('bad selections are 400 and write nothing: from > to, out of range, negative, unknown scene', async () => {
  const { library, app } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const before = await snapshot(library, { skipStoryforge: true });
  const base = { task: 'rewrite', files: [], instruction: 'x' };
  const tries = [
    { sceneId: ARRIVAL, from: 20, to: 10 },
    { sceneId: ARRIVAL, from: 0, to: scene.body.length + 50 },
    { sceneId: ARRIVAL, from: -1, to: 5 },
    { sceneId: ARRIVAL, from: 'a', to: 5 },
    { sceneId: 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', from: 0, to: 5 },
  ];
  for (const selection of tries) {
    const r = await app.post(AI.context(), { ...base, selection });
    assert.ok(r.status === 400 || r.status === 404, `${JSON.stringify(selection)} -> ${r.status} ${r.text}`);
  }
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

test('a rewrite task without a selection is a 400', async () => {
  const { app } = await boot();
  const r = await app.post(AI.context(), { task: 'rewrite', files: [ARRIVAL_PATH], instruction: 'x' });
  assert.equal(r.status, 400, r.text);
});

test('model output is data: a reply that looks like HTML, a path or a front-matter block lands only as text in the selected range', async () => {
  const evil = '<script>alert(1)</script>\n../../outside.md\n---\nid: scene_evil\n---';
  const { library, app, file } = await boot();
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await rewrite(app, scene, from, from + TARGET.length);
  const before = await snapshot(library, { skipStoryforge: true });
  const r = await apply(app, p.contextId, evil);
  // either refused or applied literally; never a write anywhere but the scene file
  assert.ok(r.status === 200 || r.status === 400, r.text);
  const after = await snapshot(library, { skipStoryforge: true });
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.ok(changed.every((k) => k === ARRIVAL_PATH), changed.join());
  if (r.status === 200) {
    const text = (await readFile(file(ARRIVAL_PATH))).toString('utf8');
    assert.ok(text.includes(evil), 'applied literally, in the range');
    assert.match(text, /^---\r?\nschema: storyforge\.scene\/v1\r?\nid: scene_01S50000000000000000000002\r?\n/, 'front matter untouched');
  }
});
