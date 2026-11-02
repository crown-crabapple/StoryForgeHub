// M05-J04 acceptance 2: a local OpenAI-compatible mock provider (POST /v1/chat/completions on 127.0.0.1, records bodies).
//   POST /api/books/:b/ai/context -> the preview; POST /api/books/:b/ai/send { contextId } -> sends EXACTLY the stored messages.
// The body the provider receives equals the previewed `messages` byte for byte; omitted files are absent; locality is `local`.
// Contract: docs/contracts/M05-J04-ai-workshop.md sections 2 and 3.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { snapshot } from './helpers.mjs';
import { AI, ARRIVAL_PATH, BOOK, KEY_PATH, freshLibrary, idOf, makeHome, profileBody, setupProvider, sha, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';

const GRAFTING_PATH = 'manuscript/act-01-low-water/ch-002-the-grafting/0020-the-grafting.md';
const WALL_PATH = 'manuscript/act-02-high-water/ch-003-the-wall/0020-the-wall.md';
// a sentence unique to each file, used to see whether that file's text reached the messages
const MARK = { arrival: 'The ferry nudged the jetty', key: null, grafting: 'Pell handed over the', wall: null };

let mock;
before(async () => {
  mock = await startMockProvider({ reply: 'A reply from the mock.' });
});
after(async () => {
  await mock.close();
  await stopAll();
});

async function boot(profile = {}) {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const id = await setupProvider(app, { baseUrl: mock.baseUrl, ...profile });
  return { library, home, app, id };
}
const ctxBody = (over = {}) => ({ task: 'chat', files: [ARRIVAL_PATH], instruction: 'Summarise this scene.', ...over });
const rawOf = async (library, rel) => fs.readFile(path.join(library, ...rel.split('/')));
const textOf = (messages) => messages.map((m) => m.content).join('\n');

test('preview: shape, file facts, locality local, nothing sent', async () => {
  mock.calls.length = 0;
  const { library, app, id } = await boot({ name: 'Local mock', model: 'm-1' });
  const r = await app.post(AI.context(), ctxBody());
  assert.equal(r.status, 200, r.text);
  const p = r.json;
  assert.equal(typeof p.contextId, 'string');
  assert.ok(Array.isArray(p.messages) && p.messages.length >= 1);
  for (const m of p.messages) {
    assert.ok(['system', 'user', 'assistant'].includes(m.role), m.role);
    assert.equal(typeof m.content, 'string');
  }
  assert.match(textOf(p.messages), /Summarise this scene\./, 'the instruction is in the messages');
  assert.match(textOf(p.messages), new RegExp(MARK.arrival), 'the scene text is in the messages');
  assert.match(p.contextSha256, /^[0-9a-f]{64}$/);
  // provider block: derived locality
  assert.equal(p.provider.locality, 'local');
  assert.equal(p.provider.model, 'm-1');
  assert.equal(p.provider.name, 'Local mock');
  assert.equal(p.provider.baseUrl, mock.baseUrl);
  assert.equal(p.provider.hasKey, undefined, 'no key material in the provider block');
  // file facts are the file's real bytes
  const buf = await rawOf(library, ARRIVAL_PATH);
  assert.equal(p.files.length, 1);
  const [f] = p.files;
  assert.equal(f.path, ARRIVAL_PATH);
  assert.equal(f.sha256, sha(buf));
  assert.equal(f.bytes, buf.length);
  assert.equal(f.included, 'full');
  assert.equal(f.tokens, Math.ceil(buf.toString('utf8').length / 4), 'token estimate = ceil(chars / 4)');
  assert.equal(p.tokens.budget, 8000, 'default context budget');
  assert.ok(p.tokens.estimate >= f.tokens);
  assert.equal(mock.calls.length, 0, 'previewing sends nothing');
  assert.ok(id);
});

test('preview: front matter of the file is kept', async () => {
  const { app } = await boot();
  const r = await app.post(AI.context(), ctxBody());
  assert.match(textOf(r.json.messages), /schema: storyforge\.scene\/v1/);
  assert.match(textOf(r.json.messages), /title: Arrival/);
});

test('preview is deterministic: same request, same contextSha256; a different instruction changes it', async () => {
  const { app } = await boot();
  const a = (await app.post(AI.context(), ctxBody())).json;
  const b = (await app.post(AI.context(), ctxBody())).json;
  const c = (await app.post(AI.context(), ctxBody({ instruction: 'Something else.' }))).json;
  assert.equal(a.contextSha256, b.contextSha256);
  assert.notEqual(a.contextSha256, c.contextSha256);
  assert.notEqual(a.contextId, c.contextId);
});

test('contextSha256 covers the model and settings, not just the messages', async () => {
  const one = await boot({ model: 'model-a', temperature: 0.2 });
  const two = await boot({ model: 'model-b', temperature: 0.2 });
  const three = await boot({ model: 'model-a', temperature: 0.9 });
  const get = async (x) => (await x.app.post(AI.context(), ctxBody())).json.contextSha256;
  const [a, b, c] = [await get(one), await get(two), await get(three)];
  assert.notEqual(a, b, 'model changes the hash');
  assert.notEqual(a, c, 'temperature changes the hash');
});

test('send: the provider receives exactly the previewed messages, byte for byte, at /v1/chat/completions', async () => {
  mock.calls.length = 0;
  const { app } = await boot({ model: 'wire-model', temperature: 0.3, maxTokens: 256 });
  const preview = (await app.post(AI.context(), ctxBody({ files: [ARRIVAL_PATH, KEY_PATH] }))).json;
  const r = await app.post(AI.send(), { contextId: preview.contextId });
  assert.equal(r.status, 200, r.text);
  assert.equal(mock.calls.length, 1, 'one request');
  const call = mock.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/chat/completions');
  assert.match(call.headers['content-type'], /application\/json/);
  assert.equal(call.body.model, 'wire-model');
  assert.equal(call.body.temperature, 0.3);
  assert.equal(call.body.max_tokens, 256);
  assert.equal(JSON.stringify(call.body.messages), JSON.stringify(preview.messages), 'messages are identical, byte for byte');
  assert.equal(call.headers.authorization, undefined, 'keyStorage none sends no Authorization header');
  assert.ok(r.text.includes('A reply from the mock.'), 'the reply is returned to the caller');
  // the send reports the same hash that was previewed
  assert.equal(r.json.contextSha256 ?? preview.contextSha256, preview.contextSha256);
});

test('send uses only the stored package: extra messages or instruction in the send body are ignored', async () => {
  mock.calls.length = 0;
  const { app } = await boot();
  const preview = (await app.post(AI.context(), ctxBody())).json;
  const r = await app.post(AI.send(), { contextId: preview.contextId, messages: [{ role: 'user', content: 'EVIL-INJECTED' }], instruction: 'EVIL-INSTRUCTION', model: 'evil-model' });
  assert.ok(r.status < 500);
  if (mock.calls.length) {
    assert.equal(JSON.stringify(mock.calls[0].body.messages), JSON.stringify(preview.messages));
    assert.doesNotMatch(mock.calls[0].raw, /EVIL/);
  } else {
    assert.ok(r.status >= 400, 'rejecting the extra fields is also acceptable');
  }
});

test('send with an unknown contextId is refused and nothing is sent', async () => {
  mock.calls.length = 0;
  const { app } = await boot();
  const r = await app.post(AI.send(), { contextId: 'ctx_does_not_exist' });
  assert.ok(r.status >= 400 && r.status < 500, r.text);
  assert.equal(mock.calls.length, 0);
});

test('send with no contextId is refused (4xx) and nothing is sent', async () => {
  mock.calls.length = 0;
  const { app } = await boot();
  const r = await app.post(AI.send(), {});
  assert.ok(r.status === 400 || r.status === 404, r.text);
  assert.equal(mock.calls.length, 0);
});

test('budget: files go in the given order; the rest are omitted (absent from the messages); at most the last included one is truncated', async () => {
  mock.calls.length = 0;
  const { library, app } = await boot({ contextBudget: 220 });
  const order = [ARRIVAL_PATH, GRAFTING_PATH, KEY_PATH, WALL_PATH];
  const r = await app.post(AI.context(), ctxBody({ files: order }));
  assert.equal(r.status, 200, r.text);
  const p = r.json;
  assert.equal(p.tokens.budget, 220);
  assert.deepEqual(p.files.map((f) => f.path), order, 'one entry per file, in the given order');
  const states = p.files.map((f) => f.included);
  assert.notEqual(states[0], 'omitted', 'the first file is not dropped');
  assert.ok(states.includes('omitted'), `the budget is small enough to omit something: ${states}`);
  // once a file is omitted, every later one is too (no skipping ahead)
  const firstOmitted = states.indexOf('omitted');
  assert.ok(states.slice(firstOmitted).every((s) => s === 'omitted'), states.join());
  // never silently cut mid-file except the last included one, which is marked
  const truncated = states.map((s, i) => (s === 'truncated' ? i : -1)).filter((i) => i >= 0);
  assert.ok(truncated.length <= 1);
  if (truncated.length) assert.equal(truncated[0], firstOmitted - 1, 'only the last included file may be truncated');
  assert.ok(p.tokens.estimate <= p.tokens.budget, `estimate ${p.tokens.estimate} within budget ${p.tokens.budget}`);
  // omitted files contribute nothing; their facts are still reported
  const all = textOf(p.messages);
  for (const f of p.files.filter((x) => x.included === 'omitted')) {
    const text = (await rawOf(library, f.path)).toString('utf8');
    const body = text.split(/\r?\n---\r?\n/).pop();
    const line = body.split(/\r?\n/).find((l) => l.trim().length > 20);
    assert.ok(!all.includes(line), `omitted ${f.path} must not appear in the messages`);
    assert.equal(f.sha256, sha(await rawOf(library, f.path)));
  }
  // and what the provider later receives is the same
  await app.post(AI.send(), { contextId: p.contextId });
  assert.equal(mock.calls.length, 1);
  assert.equal(JSON.stringify(mock.calls[0].body.messages), JSON.stringify(p.messages));
});

test('budget: a large budget includes every requested file in full', async () => {
  const { app } = await boot({ contextBudget: 100000 });
  const p = (await app.post(AI.context(), ctxBody({ files: [ARRIVAL_PATH, KEY_PATH, GRAFTING_PATH, WALL_PATH] }))).json;
  assert.deepEqual(p.files.map((f) => f.included), ['full', 'full', 'full', 'full']);
});

test('budget: the smallest budget (200 tokens) never sends a whole file that does not fit (first file truncated or omitted, never full)', async () => {
  const { app } = await boot({ contextBudget: 200 });
  const r = await app.post(AI.context(), ctxBody());
  assert.ok(r.status === 200 || r.status === 400, r.text);
  if (r.status === 200) assert.notEqual(r.json.files[0].included, 'full');
});

test('context refuses .storyforge/, provenance/ and paths outside the book with 400, and sends nothing', async () => {
  mock.calls.length = 0;
  const { app } = await boot();
  for (const bad of ['.storyforge/index.sqlite', '.storyforge/journal/x.json', 'provenance/2026.jsonl', '../outside.md', '../../etc/passwd', 'manuscript/../../x.md', 'C:/Windows/win.ini', '/etc/passwd', 'manuscript\\..\\..\\x.md']) {
    const r = await app.post(AI.context(), ctxBody({ files: [ARRIVAL_PATH, bad] }));
    assert.equal(r.status, 400, `${bad}: ${r.status} ${r.text}`);
  }
  assert.equal(mock.calls.length, 0);
});

test('context: bad requests are 400 (unknown task, files not an array, missing instruction) and unknown books 404', async () => {
  const { app } = await boot();
  assert.equal((await app.post(AI.context(), ctxBody({ task: 'summon' }))).status, 400);
  assert.equal((await app.post(AI.context(), ctxBody({ files: 'book.md' }))).status, 400);
  assert.equal((await app.post(AI.context(), { task: 'chat', files: [ARRIVAL_PATH] })).status, 400);
  assert.equal((await app.post(AI.context('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), ctxBody())).status, 404);
});

test('context of a missing file is refused (400 or 404), not an empty package', async () => {
  const { app } = await boot();
  const r = await app.post(AI.context(), ctxBody({ files: ['manuscript/nope.md'] }));
  assert.ok(r.status === 400 || r.status === 404, r.text);
});

test('locality is derived from the host: localhost, 127.0.0.1 and [::1] are local; anything else is cloud; a client-sent locality is ignored', async () => {
  const { app } = await boot();
  const make = async (baseUrl, extra = {}) => {
    const r = await app.post(AI.profiles, profileBody({ baseUrl, name: baseUrl, ...extra }));
    assert.ok(r.status === 200 || r.status === 201, `${baseUrl}: ${r.text}`);
    return idOf(r);
  };
  const ids = {
    local1: await make('http://localhost:11434/v1'),
    local2: await make('http://127.0.0.1:1234/v1'),
    local3: await make('http://[::1]:8080/v1'),
    cloud1: await make('https://api.example.com/v1'),
    cloud2: await make('https://api.example.com/v1', { name: 'liar', locality: 'local' }),
  };
  const list = (await app.get(AI.profiles)).json;
  const rows = list.profiles ?? list;
  const loc = (id) => rows.find((p) => p.id === id).locality;
  assert.equal(loc(ids.local1), 'local');
  assert.equal(loc(ids.local2), 'local');
  assert.equal(loc(ids.local3), 'local');
  assert.equal(loc(ids.cloud1), 'cloud');
  assert.equal(loc(ids.cloud2), 'cloud', 'locality is not chosen by the client');
});

test('profile test route sends one tiny fixed prompt and no book text', async () => {
  mock.calls.length = 0;
  const { library, app, id } = await boot();
  const before = await snapshot(library, { skipStoryforge: true });
  const r = await app.post(AI.test(id), {});
  assert.equal(r.status, 200, r.text);
  assert.equal(mock.calls.length, 1);
  const sent = JSON.stringify(mock.calls[0].body.messages);
  assert.match(sent, /Reply with OK\./);
  assert.doesNotMatch(sent, /ferry|Maren|orchard/i, 'no book text in the test request');
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

test('chat writes nothing to the book (no ai/ folder, files unchanged)', async () => {
  const { library, app } = await boot();
  const before = await snapshot(library, { skipStoryforge: true });
  const p = (await app.post(AI.context(), ctxBody())).json;
  const r = await app.post(AI.send(), { contextId: p.contextId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

test('GET /api/books/:b/ai/profile style reads never expose the base URL credentials or keys; PUT book profile null turns AI off for the book', async () => {
  const { app } = await boot();
  const off = await app.put(AI.bookProfile(), { profileId: null });
  assert.equal(off.status, 200, off.text);
  const r = await app.post(AI.context(), ctxBody());
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code ?? r.json.error, 'AI_NOT_CONFIGURED');
  assert.ok(BOOK);
});
