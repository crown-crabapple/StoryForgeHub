// M08-J03 acceptance 2, 4 and 5 against real server processes and a mock provider:
//   2  token accounting (reported usage, estimated usage, the per-book daily table), every outbound request follows an explicit send of a previewed context (net recorder),
//      cover generation sends only after consent and exactly the shown prompt
//   4  stored keys that cannot be unlocked: a clear error, never a crash, never a request with an empty key
//   5  streaming: cancel mid-stream and the partial output is never applied; discovery lists the mock's models
// Contract: docs/contracts/M08-J03-secure-providers-media.md sections 2 to 4.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseAiUsage } from '../../../packages/core/src/ai-usage.mjs';
import { AI, ARRIVAL, BOOK, freshLibrary, getScene, idOf, makeHome, profileBody, readEverything, setupProvider, startApp, stopAll } from './ai-helpers.mjs';
import { snapshot } from './helpers.mjs';
import { PNG, closeMocks, startProvider, until } from './j03-helpers.mjs';

after(async () => {
  await stopAll();
  await closeMocks();
});

const FILE_KEY = { STORYFORGE_SECRETS_BACKEND: 'file-key' }; // keeps these tests off the OS key store (it has its own tests)
const TARGET = 'The ferry nudged the jetty and [[tobin-reyes|the ferryman]] threw her bag ashore.';
const b = (p = '') => `/api/books/${BOOK}${p}`;
const usageFile = (library) => path.join(library, 'activity', 'ai-usage.md');
const exists = (p) => fs.stat(p).then(() => true, () => false);
const fetches = async (app) => (await app.netCalls()).filter((c) => c.api === 'fetch');

async function boot({ mockOpts = {}, net = false, env = FILE_KEY, profile = {} } = {}) {
  const mock = await startProvider({ reply: 'A short reply.', ...mockOpts });
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net, env });
  const id = await setupProvider(app, { baseUrl: mock.baseUrl, model: 'mock-model-a', ...profile });
  return { mock, library, home, app, id };
}
const preview = async (app, instruction = 'Say something.') => {
  const r = await app.post(AI.context(), { task: 'chat', files: ['book.md'], instruction });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
async function rewritePreview(app) {
  const scene = await getScene(app, ARRIVAL);
  const from = scene.body.indexOf(TARGET);
  assert.ok(from >= 0);
  const r = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: scene.id, from, to: from + TARGET.length }, instruction: 'Tighten.' });
  assert.equal(r.status, 200, r.text);
  return { scene, ctx: r.json };
}
const poll = (app, contextId, from = 0) => app.get(`${b('/ai/stream')}?context=${contextId}&from=${from}`);
const waitDone = (app, contextId) => until(async () => (await poll(app, contextId)).json?.state === 'done' && (await poll(app, contextId)), 'the stream to finish');

// ---------------------------------------------------------------- token accounting

test('token accounting: the provider\'s reported usage is used and summed per day in activity/ai-usage.md (whole and streamed replies)', async () => {
  const { library, app, mock } = await boot({ mockOpts: { usage: true } });
  assert.equal((await app.put(b('/ai/records'), { usage: true })).status, 200);
  const pv = await preview(app);
  const one = await app.post(AI.send(), { contextId: pv.contextId });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.tokens.estimated, false);
  assert.equal(one.json.tokens.promptTokens, one.json.usage.prompt_tokens);
  assert.equal(one.json.tokens.completionTokens, one.json.usage.completion_tokens);
  const streamed = await app.post(AI.send(), { contextId: pv.contextId, stream: true });
  assert.equal(streamed.status, 202, streamed.text);
  const done = (await waitDone(app, pv.contextId)).json.result;
  assert.equal(done.tokens.estimated, false, 'the stream asked for usage and the mock reported it');
  assert.equal(mock.chats().at(-1).body.stream_options.include_usage, true);

  const rows = parseAiUsage(await fs.readFile(usageFile(library), 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requests, 2);
  assert.equal(rows[0].promptTokens, one.json.tokens.promptTokens + done.tokens.promptTokens);
  assert.equal(rows[0].completionTokens, one.json.tokens.completionTokens + done.tokens.completionTokens);
  assert.equal(rows[0].estimated, 0);
  assert.equal(rows[0].locality, 'local');
  assert.equal(rows[0].profile, 'Test provider');
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
  const status = (await app.get(b('/ai/status'))).json;
  assert.equal(status.usage, true);
  // counts only: nothing of the prompt or the reply is in the file
  const text = await fs.readFile(usageFile(library), 'utf8');
  assert.equal(/Say something|A short reply|The Salt Orchard/.test(text), false);
});

test('token accounting: a provider that reports no usage gives estimated totals (characters / 4), marked as such', async () => {
  const { library, app } = await boot({ mockOpts: { usage: false, reply: 'abcdefghijkl' } });
  await app.put(b('/ai/records'), { usage: true });
  const pv = await preview(app);
  const sent = await app.post(AI.send(), { contextId: pv.contextId });
  assert.equal(sent.status, 200, sent.text);
  const promptChars = pv.messages.map((m) => m.content).join('\n').length;
  assert.deepEqual(sent.json.tokens, { promptTokens: Math.ceil(promptChars / 4), completionTokens: 3, totalTokens: Math.ceil(promptChars / 4) + 3, estimated: true });
  const streamed = await app.post(AI.send(), { contextId: pv.contextId, stream: true });
  assert.equal(streamed.status, 202);
  assert.equal((await waitDone(app, pv.contextId)).json.result.tokens.estimated, true);
  const [row] = parseAiUsage(await fs.readFile(usageFile(library), 'utf8'));
  assert.equal(row.requests, 2);
  assert.equal(row.estimated, 2, 'both requests had no reported usage');
});

test('the usage table is off unless AI records or usage tracking is on for the book; records alone turn it on', async () => {
  const { library, app } = await boot();
  const pv = await preview(app);
  assert.equal((await app.post(AI.send(), { contextId: pv.contextId })).status, 200);
  assert.equal(await exists(usageFile(library)), false, 'off by default: no file, nothing written');
  assert.equal((await app.get(b('/ai/status'))).json.usage, false);
  await app.put(b('/ai/records'), { enabled: true });
  assert.equal((await app.post(AI.send(), { contextId: pv.contextId })).status, 200);
  assert.equal(parseAiUsage(await fs.readFile(usageFile(library), 'utf8'))[0].requests, 1);
  await app.put(b('/ai/records'), { enabled: false });
  await app.put(b('/ai/records'), { usage: false });
  assert.equal((await app.post(AI.send(), { contextId: pv.contextId })).status, 200);
  assert.equal(parseAiUsage(await fs.readFile(usageFile(library), 'utf8'))[0].requests, 1, 'off again: nothing more is counted');
});

// ---------------------------------------------------------------- consent and the net recorder

test('every outbound request follows an explicit send of a previewed context: previews, bad sends and stale previews make none (net recorder)', async () => {
  const { app, mock, id } = await boot({ net: true });
  const nothing = async (why) => {
    assert.equal(mock.calls.length, 0, `${why}: the provider saw nothing`);
    assert.deepEqual(await fetches(app), [], `${why}: no outbound call was recorded`);
  };
  await app.get(AI.profiles);
  await app.get(b('/ai/status'));
  const pv = await preview(app);
  await preview(app, 'Another preview.');
  await nothing('after profile setup and two previews');
  assert.equal((await app.post(AI.send(), { contextId: 'ctx_nope' })).status, 404);
  assert.equal((await app.post(AI.send(), { contextId: pv.contextId, stream: 'yes' })).status, 400);
  assert.equal((await app.post(b('/ai/cancel'), { contextId: pv.contextId })).json.cancelled, false);
  await nothing('after a send of a preview that is gone, a bad request and a cancel');
  assert.equal((await app.put(AI.profile(id), { ...profileBody({ baseUrl: mock.baseUrl }), model: 'other-model' })).status, 200);
  const stale = await app.post(AI.send(), { contextId: pv.contextId });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'CONTEXT_STALE');
  await nothing('after the provider changed since the preview');

  // the explicit send of a fresh preview: exactly one request, carrying exactly the previewed messages
  await app.put(AI.profile(id), { ...profileBody({ baseUrl: mock.baseUrl }), model: 'mock-model-a' });
  const fresh = await preview(app, 'Send me.');
  const sent = await app.post(AI.send(), { contextId: fresh.contextId });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(mock.chats().length, 1);
  assert.deepEqual(mock.chats()[0].body.messages, fresh.messages, 'exactly the previewed context');
  const calls = await fetches(app);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].target.startsWith(mock.baseUrl), calls[0].target);
  // and a streamed send of the same preview is again exactly one request
  assert.equal((await app.post(AI.send(), { contextId: fresh.contextId, stream: true })).status, 202);
  await waitDone(app, fresh.contextId);
  assert.deepEqual(mock.chats()[1].body.messages, fresh.messages);
  assert.equal((await fetches(app)).length, 2);
  assert.equal(mock.calls.length, 2, 'the provider saw nothing but the two sends');
});

test('cover generation: nothing is sent without consent for this provider host; then exactly the shown prompt and nothing else', async () => {
  const mock = await startProvider();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true, env: FILE_KEY });
  const created = await app.post(AI.profiles, profileBody({ name: 'Pictures', kind: 'openai-compatible-images', model: 'image-1', baseUrl: mock.baseUrl }));
  assert.equal(created.status, 201, created.text);
  await app.put(AI.bookProfile(), { profileId: created.json.profile.id });
  const info = (await app.get(b('/ai/cover'))).json;
  assert.equal(info.available, true);
  assert.deepEqual(info.provider, { id: created.json.profile.id, name: 'Pictures', model: 'image-1', host: mock.host, locality: 'local' });
  assert.match(info.prompt, /The Salt Orchard/, 'prefilled from the title');
  assert.match(info.prompt, /literary/, 'and the genre');
  assert.match(info.prompt, /cartographer/, 'and the logline');
  assert.equal(mock.calls.length, 0, 'asking for the cover state sends nothing');

  const PROMPT = '  A minimal lighthouse\n  at dusk, "no text" ✓  ';
  const refused = [
    [{ prompt: PROMPT }, 'CONSENT_REQUIRED'],
    [{ prompt: PROMPT, consent: 'yes', host: mock.host }, 'CONSENT_REQUIRED'],
    [{ prompt: PROMPT, consent: true, host: 'elsewhere.example.com' }, 'CONSENT_STALE'],
    [{ prompt: PROMPT, consent: true }, 'CONSENT_STALE'],
  ];
  for (const [body, code] of refused) {
    const r = await app.post(b('/ai/cover-generate'), body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, code);
  }
  assert.equal((await app.post(b('/ai/cover-generate'), { consent: true, host: mock.host })).status, 400, 'a prompt is required');
  assert.equal(mock.calls.length, 0, 'no consent, no request');
  assert.deepEqual(await fetches(app), []);

  const before = await snapshot(library, { skipStoryforge: true });
  const gen = await app.post(b('/ai/cover-generate'), { prompt: PROMPT, consent: true, host: mock.host });
  assert.equal(gen.status, 201, gen.text);
  assert.equal(mock.posts().length, 1);
  const sent = mock.posts()[0];
  assert.equal(sent.url, '/v1/images/generations');
  assert.equal(sent.body.prompt, PROMPT, 'exactly the shown prompt, byte for byte');
  assert.deepEqual(Object.keys(sent.body).sort(), ['model', 'n', 'prompt', 'response_format', 'size']);
  assert.equal(/Salt Orchard|cartographer|Maren|ferry/i.test(sent.raw), false, 'nothing about the book but the prompt');
  assert.equal((await fetches(app)).length, 1);
  assert.equal(sent.headers.authorization, undefined, 'no key was configured');

  // the draft: assets/drafts/*.png + an asset note with the prompt, and a receipt; nothing else in the book changed but those files
  const after = await snapshot(library, { skipStoryforge: true });
  const added = Object.keys(after).filter((k) => !(k in before) && !k.endsWith('/'));
  assert.deepEqual(added.filter((k) => !k.startsWith('provenance/')).sort(), [`assets/drafts/${gen.json.draft.name}`, `assets/drafts/${gen.json.draft.name.replace(/\.png$/, '.md')}`].sort());
  assert.deepEqual(Object.keys(before).filter((k) => !k.endsWith('/') && before[k] !== after[k]), [], 'no existing file changed');
  assert.deepEqual(await fs.readFile(path.join(library, 'assets', 'drafts', gen.json.draft.name)), PNG);
  const list = (await app.get(b('/ai/cover'))).json.drafts;
  assert.equal(list.length, 1);
  assert.equal(list[0].prompt, PROMPT);
  assert.deepEqual([list[0].provider, list[0].model, list[0].locality, list[0].isCover], ['Pictures', 'image-1', 'local', false]);
  const note = await fs.readFile(path.join(library, 'assets', 'drafts', gen.json.draft.name.replace(/\.png$/, '.md')), 'utf8');
  assert.match(note, /schema: storyforge\.asset-note\/v1/);
  const receipts = [...(await readEverything(library))].filter(([p]) => p.startsWith('provenance/receipts') || (p.startsWith('provenance/') && p.endsWith('.md'))).map(([, bytes]) => bytes.toString('utf8'));
  assert.ok(receipts.some((r) => /operation: ai\.generation/.test(r) && /workflow: ai-cover/.test(r) && r.includes(`assets/drafts/${gen.json.draft.name}`)), 'an ai.generation receipt targets the asset');
  assert.equal(receipts.some((r) => r.includes(PROMPT.trim())), false, 'the receipt keeps hashes, not the prompt (the prompt is in the asset note)');

  // the draft is not the cover until the author says so, and that is a single-line edit of book.md
  assert.equal((await app.get(b('/cover'))).status, 404, 'a draft is not the cover');
  const bookBefore = (await fs.readFile(path.join(library, 'book.md'), 'utf8')).split('\n');
  assert.equal((await app.post(b('/ai/cover-use'), { name: gen.json.draft.name })).status, 200);
  const bookAfter = (await fs.readFile(path.join(library, 'book.md'), 'utf8')).split('\n');
  assert.deepEqual(bookBefore.filter((l) => !bookAfter.includes(l)), []);
  assert.equal(bookAfter.filter((l) => !bookBefore.includes(l)).length, 1);
  assert.equal((await app.get(b('/cover'))).status, 200);
  assert.equal((await app.post(b('/ai/cover-delete'), { name: gen.json.draft.name })).status, 409, 'the cover itself is not deleted as a draft');
  const second = await app.post(b('/ai/cover-generate'), { prompt: 'Another', consent: true, host: mock.host });
  assert.equal((await app.post(b('/ai/cover-delete'), { name: second.json.draft.name })).status, 200, 'a draft goes to the trash');
  assert.equal(await exists(path.join(library, 'assets', 'drafts', second.json.draft.name)), false);
  assert.equal(mock.posts().length, 2, 'only the two consented generations reached the provider');
});

test('cover generation: no image provider means no button (available: false) and no request; the ai module off hides and refuses it', async () => {
  const chat = await startProvider();
  const pictures = await startProvider();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true, env: FILE_KEY });
  await setupProvider(app, { baseUrl: chat.baseUrl }); // a chat provider only
  const none = (await app.get(b('/ai/cover'))).json;
  assert.equal(none.available, false);
  assert.equal(none.provider, null);
  const r = await app.post(b('/ai/cover-generate'), { prompt: 'x', consent: true, host: chat.host });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'AI_NOT_CONFIGURED');
  assert.equal(chat.calls.length, 0, 'a chat provider is not asked for pictures');

  const img = await app.post(AI.profiles, profileBody({ name: 'Pictures', kind: 'openai-compatible-images', model: 'image-1', baseUrl: pictures.baseUrl }));
  await app.put(AI.bookProfile(), { profileId: img.json.profile.id });
  assert.equal((await app.get(b('/ai/cover'))).json.available, true);
  assert.equal((await app.put('/api/profile', { modules: { ai: false } })).status, 200);
  const off = await app.get(b('/ai/cover'));
  assert.equal(off.status, 403);
  assert.equal(off.json.code, 'MODULE_OFF');
  for (const [route, body] of [['cover-generate', { prompt: 'x', consent: true, host: pictures.host }], ['cover-use', { name: 'cover-20260101-000000-1.png' }], ['cover-delete', { name: 'cover-20260101-000000-1.png' }]]) {
    const w = await app.post(b(`/ai/${route}`), body);
    assert.equal(w.status, 403, `${route}: ${w.text}`);
    assert.equal(w.json.code, 'MODULE_OFF');
  }
  assert.equal(pictures.calls.length, 0, 'refused: nothing was sent');
  assert.deepEqual(await fetches(app), []);
});

// ---------------------------------------------------------------- streaming and discovery

test('streaming: cancel mid-stream stops the request and the partial reply is never applied, suggested, recorded or counted', async () => {
  const { library, app, mock } = await boot({ mockOpts: { hold: true, reply: 'The ferry bumped the jetty, and the ferryman flung her bag ashore.' } });
  await app.put(b('/ai/records'), { enabled: true });
  await app.put(b('/ai/records'), { usage: true });
  const { scene, ctx } = await rewritePreview(app);
  const before = await snapshot(library, { skipStoryforge: true });
  const sent = await app.post(AI.send(), { contextId: ctx.contextId, stream: true });
  assert.equal(sent.status, 202, sent.text);
  await mock.onHeld;
  const live = await until(async () => {
    const p = await poll(app, ctx.contextId);
    return p.json.text !== '' && p;
  }, 'the first piece');
  assert.equal(live.json.state, 'running');
  assert.ok(live.json.text.length > 0, 'the partial text is shown while it arrives');
  // nothing can be applied while the reply is still arriving
  const early = await app.post(AI.apply(), { contextId: ctx.contextId });
  assert.equal(early.status, 409);
  assert.equal(early.json.code, 'STREAM_RUNNING');

  const cancelled = await app.post(b('/ai/cancel'), { contextId: ctx.contextId });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.cancelled, true);
  const after = (await poll(app, ctx.contextId)).json;
  assert.equal(after.state, 'cancelled');
  assert.equal(after.text, '', 'what had arrived is thrown away');
  await until(() => mock.state.clientGone >= 1, 'the provider to see the connection close (the request was cancelled)');

  const apply = await app.post(AI.apply(), { contextId: ctx.contextId });
  assert.equal(apply.status, 409, 'there is no reply to apply');
  assert.equal(apply.json.code, 'NO_REPLY');
  await new Promise((r) => setTimeout(r, 300)); // anything wrongly written by a late completion would be here by now
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before, 'the library is byte-identical: no suggestion, no record, no usage row, no change to the scene');
  assert.equal((await getScene(app, ARRIVAL)).sha256, scene.sha256);
  for (const dir of ['suggestions', 'ai']) assert.equal(await exists(path.join(library, dir)), false, `no ${dir}/ folder was created`);
  assert.equal(await exists(usageFile(library)), false);
});

test('streaming: a stream that ends early is an error and keeps nothing; a complete stream makes its suggestion only when it is complete', async () => {
  const { library, app, mock } = await boot({ mockOpts: { reply: 'The ferry bumped the jetty, and the ferryman flung her bag ashore.', stall: 120 } });
  const { scene, ctx } = await rewritePreview(app);
  mock.state.truncate = true;
  assert.equal((await app.post(AI.send(), { contextId: ctx.contextId, stream: true })).status, 202);
  const failed = await until(async () => {
    const p = await poll(app, ctx.contextId);
    return p.json.state === 'error' && p;
  }, 'the early end');
  assert.match(failed.json.error.message, /ended before the reply was complete/);
  assert.equal(failed.json.text, '');
  assert.equal(await exists(path.join(library, 'suggestions')), false, 'no suggestion from half a reply');
  assert.equal((await app.post(AI.apply(), { contextId: ctx.contextId })).json.code, 'NO_REPLY');

  mock.state.truncate = false;
  assert.equal((await app.post(AI.send(), { contextId: ctx.contextId, stream: true })).status, 202);
  const running = await until(async () => {
    const p = await poll(app, ctx.contextId);
    return p.json.state === 'running' && p.json.text !== '' && p;
  }, 'a running stream with some text');
  assert.equal(await exists(path.join(library, 'suggestions')), false, 'while it arrives nothing is written to the book');
  const done = await waitDone(app, ctx.contextId);
  assert.equal(done.json.result.replacement.includes('ferryman flung'), true);
  assert.ok(done.json.result.suggestion, 'the suggestion exists once the reply is complete');
  assert.equal((await getScene(app, ARRIVAL)).sha256, scene.sha256, 'and the scene is still untouched until Apply');
  assert.ok(running.json.length < done.json.length, 'the text did grow while streaming');
  assert.equal((await app.post(AI.apply(), { contextId: ctx.contextId })).status, 200);
});

test('discovery: "Test connection" lists the mock\'s models and shows streaming and usage; a localhost Ollama is found through /api/tags; no manuscript data is sent', async () => {
  const { app, mock, id } = await boot({ mockOpts: { ollama: true, usage: true } });
  const r = await app.post(AI.profile(id) + '/discover', {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.models, ['llama3:8b', 'mock-model-a', 'mock-model-b']);
  assert.equal(r.json.ollama, true);
  assert.equal(r.json.streaming, true);
  assert.equal(r.json.usageReported, true);
  assert.deepEqual(mock.calls.map((c) => `${c.method} ${c.url}`), ['GET /v1/models', 'GET /api/tags', 'POST /v1/chat/completions']);
  assert.match(mock.calls[2].raw, /Reply with OK\./);
  assert.equal(mock.calls.some((c) => /ferry|Maren|orchard|cartographer/i.test(c.raw)), false);
  const cached = (await app.get(AI.profiles)).json.profiles.find((p) => p.id === id);
  assert.deepEqual(cached.capabilities.models, r.json.models, 'the result is cached per profile');
  // a provider that reports no usage and has no Ollama
  mock.state.usage = false;
  mock.calls.length = 0;
  const plain = await startProvider({ usage: false, ollama: false });
  const id2 = idOf(await app.post(AI.profiles, profileBody({ name: 'plain', baseUrl: plain.baseUrl, model: 'mock-model-a' })));
  const r2 = await app.post(AI.profile(id2) + '/discover', {});
  assert.equal(r2.json.ollama, false);
  assert.equal(r2.json.usageReported, false);
  assert.deepEqual(r2.json.models, ['mock-model-a', 'mock-model-b']);
  // an image provider is asked for its models only (GET), with no chat message
  const pics = await startProvider();
  const id3 = idOf(await app.post(AI.profiles, profileBody({ name: 'pics', kind: 'openai-compatible-images', baseUrl: pics.baseUrl, model: 'image-1' })));
  const r3 = await app.post(AI.profile(id3) + '/discover', {});
  assert.equal(r3.status, 200, r3.text);
  assert.ok(pics.calls.length > 0 && pics.calls.every((c) => c.method === 'GET'), 'only GET requests: no chat message');
  assert.equal(r3.json.streaming, null);
});

// ---------------------------------------------------------------- stored keys that cannot be unlocked

test('a stored key that cannot be unlocked: Settings says so, a send gives a clear error, nothing is sent (no empty key), and the server keeps running', async () => {
  const KEY = `sk-test-locked-${randomBytes(6).toString('hex')}`;
  const right = randomBytes(32).toString('base64');
  const wrong = randomBytes(32).toString('base64');
  const mock = await startProvider();
  const library = await freshLibrary();
  const home = await makeHome();
  const env = (k) => ({ ...FILE_KEY, STORYFORGE_SECRETS_KEY: k });

  const first = await startApp({ library, home, env: env(right) });
  const id = await setupProvider(first, { baseUrl: mock.baseUrl, model: 'mock-model-a', keyStorage: 'secure', [AI.keyField]: KEY });
  assert.equal((await first.get(AI.profiles)).json.keystore.locked, false);
  await first.stop();

  const second = await startApp({ library, home, env: env(wrong) });
  const list = await second.get(AI.profiles);
  assert.equal(list.status, 200);
  assert.equal(list.json.keystore.locked, true);
  assert.match(list.json.keystore.message, /cannot unlock stored keys/);
  assert.equal(list.json.keystore.backend, 'file-key');
  assert.equal(list.json.profiles[0].hasKey, true, 'the profile still says a key is stored (it is not reset)');
  const pv = await preview(second);
  for (const [label, r] of [
    ['send', await second.post(AI.send(), { contextId: pv.contextId })],
    ['streamed send', await second.post(AI.send(), { contextId: pv.contextId, stream: true })],
    ['test message', await second.post(AI.test(id), {})],
    ['connection test', await second.post(`${AI.profile(id)}/discover`, {})],
  ]) {
    assert.equal(r.status, 409, `${label}: ${r.text}`);
    assert.equal(r.json.code, 'KEYS_LOCKED', label);
    assert.match(r.json.message, /cannot unlock stored keys/);
    assert.equal(r.text.includes(KEY), false);
  }
  assert.equal(mock.calls.length, 0, 'no request went out without its key');
  assert.equal((await second.get('/api/health')).status, 200, 'no crash');
  assert.equal(second.output().includes(KEY), false);
  await second.stop();

  const third = await startApp({ library, home, env: env(right) });
  assert.equal((await third.get(AI.profiles)).json.keystore.locked, false);
  const pv3 = await preview(third);
  assert.equal((await third.post(AI.send(), { contextId: pv3.contextId })).status, 200);
  assert.equal(mock.chats().at(-1).headers.authorization, `Bearer ${KEY}`, 'the right key unlocks it again: nothing was lost');
});

test('"Move key to secure storage": the plain copy leaves ai.json, the key still works, and only a plain-text key can be moved', async () => {
  const KEY = `sk-test-move-${randomBytes(6).toString('hex')}`;
  const { app, mock, id, home } = await boot({ profile: { keyStorage: 'config', [AI.keyField]: KEY } });
  const aiJson = () => fs.readFile(path.join(process.platform === 'win32' ? path.join(home.home, 'AppData', 'StoryForge') : path.join(home.home, 'xdg', 'storyforge'), 'ai.json'), 'utf8');
  assert.equal((await aiJson()).includes(KEY), true, 'config storage is plain text, as the warning says');
  const moved = await app.post(`${AI.profile(id)}/secure`, {});
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.profile.keyStorage, 'secure');
  assert.equal(moved.json.profile.hasKey, true);
  assert.equal(moved.text.includes(KEY), false);
  assert.equal((await aiJson()).includes(KEY), false, 'the plain copy is gone');
  const pv = await preview(app);
  assert.equal((await app.post(AI.send(), { contextId: pv.contextId })).status, 200);
  assert.equal(mock.chats().at(-1).headers.authorization, `Bearer ${KEY}`);
  assert.equal((await app.post(`${AI.profile(id)}/secure`, {})).status, 400, 'nothing left to move');
});
