// M05-J04 acceptance 5: optional AI records.
//   off by default (no ai/ folder is ever created); switched on per book (user config `ai.recordBooks[bookId]`, never in book.md)
//   -> each chat/rewrite saves ai/<YYYY>/<YYYYMMDD-HHMMSS>-<task>.md (schema storyforge.ai-record/v1, id note_...), front matter { task, provider, model, locality, contextSha256, files, applied },
//      body = instruction + reply (+ the selected text for rewrites); the full context text only when "Include the full context" was ticked for that record; never a key.
// The toggle route and the `includeContext` field are not spelled out in the contract; they live in AI (ai-helpers.mjs) and `RECORDS` below.
// Contract: docs/contracts/M05-J04-ai-workshop.md section 5 and acceptance 5.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import { snapshot } from './helpers.mjs';
import { AI, ARRIVAL, ARRIVAL_PATH, BOOK, freshLibrary, getScene, makeHome, readConfigFiles, setupProvider, sha, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';

const RECORDS = { toggle: (b = BOOK) => `/api/books/${b}/ai/records`, includeField: 'includeContext' };
const SECRET = 'sk-sftest-records-0a1b2c3d4e5f';
const REPLY = 'A short grey summary of the arrival.';
const SCENE_ONLY_LINE = 'In the glass of the ticket hut'; // in the scene, not in the instruction, reply or selection
const TARGET = 'The ferry nudged the jetty and [[tobin-reyes|the ferryman]] threw her bag ashore.';

let mock;
before(async () => {
  mock = await startMockProvider({ reply: REPLY });
});
after(async () => {
  await mock.close();
  await stopAll();
});

async function boot(profile = {}) {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  await setupProvider(app, { baseUrl: mock.baseUrl, name: 'Rec mock', model: 'rec-model', ...profile });
  return { library, home, app };
}
const chat = async (app, extra = {}) => {
  const p = await app.post(AI.context(), { task: 'chat', files: [ARRIVAL_PATH], instruction: 'Summarise the arrival.' });
  assert.equal(p.status, 200, p.text);
  const r = await app.post(AI.send(), { contextId: p.json.contextId, ...extra });
  assert.equal(r.status, 200, r.text);
  return p.json;
};
async function recordFiles(library) {
  // Walk only ai/: a whole-library walk races the server's own temp files (a file can vanish between readdir and read).
  const out = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fs.readdir(path.join(library, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(child);
      else if (!e.name.includes('.sf-tmp')) out.push({ rel: child, text: await fs.readFile(path.join(library, child), 'utf8') });
    }
  }
  await walk('ai');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
const split = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  assert.ok(m, 'front matter present');
  return { fm: YAML.parse(m[1]), body: m[2] };
};
const exists = (p) => fs.stat(p).then(() => true, () => false);

test('off by default: chat and rewrite create no ai/ folder and change no file', async () => {
  const { library, app } = await boot();
  const before = await snapshot(library, { skipStoryforge: true });
  await chat(app);
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const p = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: ARRIVAL, from, to: from + TARGET.length }, instruction: 'Tighten.' });
  await app.post(AI.send(), { contextId: p.json.contextId });
  await app.post(AI.discard(), { contextId: p.json.contextId });
  assert.equal(await exists(path.join(library, 'ai')), false, 'no ai/ folder');
  // M05-J06: the rewrite's proposal is a suggestion document (declined by the discard); nothing else changes
  const after = await snapshot(library, { skipStoryforge: true });
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([k]) => !k.startsWith('suggestions/'))), before);
});

test('switching records on is stored in the user config, not in the book', async () => {
  const { library, home, app } = await boot();
  const bookMd = await fs.readFile(path.join(library, 'book.md'));
  const r = await app.put(RECORDS.toggle(), { enabled: true });
  assert.equal(r.status, 200, r.text);
  assert.ok((await fs.readFile(path.join(library, 'book.md'))).equals(bookMd), 'book.md untouched');
  const cfg = Object.values(await readConfigFiles(home.configDir)).join('\n');
  assert.match(cfg, /recordBooks/);
  assert.ok(cfg.includes(BOOK));
  assert.equal(await exists(path.join(library, 'ai')), false, 'the toggle alone creates nothing in the book');
});

test('on: a chat saves one valid record with the documented front matter, instruction and reply, and no key or context text', async () => {
  const { library, app } = await boot({ keyStorage: 'session', [AI.keyField]: SECRET });
  assert.equal((await app.put(RECORDS.toggle(), { enabled: true })).status, 200);
  const preview = await chat(app);
  const recs = await recordFiles(library);
  assert.equal(recs.length, 1, recs.map((r) => r.rel).join());
  const [rec] = recs;
  assert.match(rec.rel, /^ai\/\d{4}\/\d{8}-\d{6}-chat\.md$/);
  const { fm, body } = split(rec.text);
  assert.equal(fm.schema, 'storyforge.ai-record/v1');
  assert.match(fm.id, /^note_[0-9A-Z]{26}$/);
  assert.equal(fm.task, 'chat');
  assert.equal(fm.model, 'rec-model');
  assert.equal(fm.locality, 'local');
  assert.ok(String(typeof fm.provider === 'object' ? fm.provider.name : fm.provider).includes('Rec mock'));
  assert.equal(fm.contextSha256, preview.contextSha256);
  assert.equal(fm.applied, false);
  assert.deepEqual(fm.files.map((f) => ({ path: f.path, sha256: f.sha256 })), [{ path: ARRIVAL_PATH, sha256: sha(await fs.readFile(path.join(library, ...ARRIVAL_PATH.split('/')))) }]);
  assert.ok(body.includes('Summarise the arrival.'), 'instruction in the body');
  assert.ok(body.includes(REPLY), 'reply in the body');
  assert.ok(!rec.text.includes(SECRET), 'no key');
  assert.ok(!rec.text.includes(SCENE_ONLY_LINE), 'the context text is not saved unless asked');
  // the validator accepts the book with the record, with no diagnostic about it
  const diags = (await validate(library)).diagnostics;
  assert.deepEqual(diags.filter((d) => String(d.file).startsWith('ai/')), []);
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), []);
});

test('on: "Include the full context" for that record saves the context text, and only for that record', async () => {
  const { library, app } = await boot();
  await app.put(RECORDS.toggle(), { enabled: true });
  await chat(app, { [RECORDS.includeField]: true });
  const withCtx = await recordFiles(library);
  assert.equal(withCtx.length, 1);
  assert.ok(withCtx[0].text.includes(SCENE_ONLY_LINE), 'full context saved when ticked');
  await fs.rm(path.join(library, 'ai'), { recursive: true });
  await chat(app); // not ticked this time
  const without = await recordFiles(library);
  assert.equal(without.length, 1);
  assert.ok(!without[0].text.includes(SCENE_ONLY_LINE));
});

test('on: a rewrite record holds the selected text and applied: true after Apply, applied: false after Discard', async () => {
  const { library, app } = await boot();
  await app.put(RECORDS.toggle(), { enabled: true });
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  const mk = async () => {
    const p = await app.post(AI.context(), { task: 'rewrite', files: [ARRIVAL_PATH], selection: { sceneId: ARRIVAL, from, to: from + TARGET.length }, instruction: 'Tighten this.' });
    assert.equal(p.status, 200, p.text);
    assert.equal((await app.post(AI.send(), { contextId: p.json.contextId })).status, 200);
    return p.json;
  };
  const discarded = await mk();
  assert.equal((await app.post(AI.discard(), { contextId: discarded.contextId })).status, 200);
  let recs = (await recordFiles(library)).filter((r) => /-rewrite(-\d+)?\.md$/.test(r.rel));
  assert.equal(recs.length, 1);
  assert.equal(split(recs[0].text).fm.applied, false);
  assert.ok(split(recs[0].text).body.includes(TARGET), 'selected text kept in the record');
  assert.ok(!recs[0].text.includes(SCENE_ONLY_LINE), 'but not the rest of the scene');

  const fresh = await getScene(app, ARRIVAL);
  assert.equal(fresh.sha256, scene.sha256, 'discard changed nothing');
  const applied = await mk();
  assert.equal((await app.post(AI.apply(), { contextId: applied.contextId, replacement: REPLY })).status, 200);
  recs = (await recordFiles(library)).filter((r) => /-rewrite(-\d+)?\.md$/.test(r.rel));
  assert.ok(recs.some((r) => split(r.text).fm.applied === true), 'an applied rewrite is recorded with applied: true');
  assert.deepEqual((await validate(library)).diagnostics.filter((d) => d.severity === 'error'), []);
});

test('switching records off again stops new records', async () => {
  const { library, app } = await boot();
  await app.put(RECORDS.toggle(), { enabled: true });
  await chat(app);
  await app.put(RECORDS.toggle(), { enabled: false });
  const n = (await recordFiles(library)).length;
  await chat(app);
  assert.equal((await recordFiles(library)).length, n);
});

test('records are per book: switching one book on does not switch another on', async () => {
  const { app, home } = await boot();
  const r = await app.put(RECORDS.toggle('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), { enabled: true });
  assert.ok(r.status === 404 || r.status === 400, 'unknown book refused');
  const cfg = Object.values(await readConfigFiles(home.configDir)).join('\n');
  assert.ok(!cfg.includes('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ'));
});
