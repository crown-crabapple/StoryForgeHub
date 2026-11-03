// M08-J03 acceptance 3: with no configured provider the server makes ZERO outbound network calls, extended to model discovery, image generation, streaming and webhooks.
// Method as in ai-zero-traffic.test.mjs: a REAL server process under the network recorder preload (fetch, http(s).request/get, net, tls, dgram, WebSocket); the recorder
// sees every API, and a positive control (a delivered webhook) shows the recorder does see the webhook path too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AI, ARRIVAL, BOOK, freshLibrary, getScene, makeHome, profileBody, startApp, stopAll } from './ai-helpers.mjs';
import { closeMocks, getBytes, startProvider, startReceiver, until } from './j03-helpers.mjs';

after(async () => {
  await stopAll();
  await closeMocks();
});

const ENV = { STORYFORGE_SECRETS_BACKEND: 'file-key' };
const b = (p = '') => `/api/books/${BOOK}${p}`;

async function saveScene(app, line) {
  const scene = await getScene(app, ARRIVAL);
  const r = await app.put(b(`/scenes/${ARRIVAL}/body`), { body: `${scene.body}\n${line}\n`, base_sha256: scene.sha256 });
  assert.equal(r.status, 200, r.text);
}

test('no provider and no webhook: discovery, connection tests, cover generation, streaming, cancel and every webhook-bearing action make zero outbound calls', async () => {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true, env: ENV });

  // routes that name a profile that does not exist
  for (const p of ['discover', 'test', 'secure']) assert.equal((await app.post(`${AI.profile('prof_nope')}/${p}`, {})).status, 404, p);
  // the book has no provider: the cover generator reports it is unavailable, and every AI action is refused before anything is sent
  const cover = await app.get(b('/ai/cover'));
  assert.equal(cover.status, 200);
  assert.equal(cover.json.available, false, 'no image provider: no button');
  for (const [route, body] of [
    ['cover-generate', { prompt: 'a lighthouse', consent: true, host: 'api.example.com' }],
    ['context', { task: 'chat', files: [], instruction: 'x' }],
    ['send', { contextId: 'ctx_nope', stream: true }],
    ['send', { contextId: 'ctx_nope' }],
  ]) {
    const r = await app.post(b(`/ai/${route}`), body);
    assert.equal(r.status, 409, `${route}: ${r.text}`);
    assert.equal(r.json.code, 'AI_NOT_CONFIGURED', route);
  }
  assert.equal((await app.post(b('/ai/cancel'), { contextId: 'ctx_nope' })).status, 404);
  assert.equal((await app.get(`${b('/ai/stream')}?context=ctx_nope&from=0`)).status, 404);
  assert.equal((await app.get(b('/ai/cover-draft') + '?name=cover-20260101-000000-1.png')).status, 404);
  assert.equal((await app.get(AI.profiles)).status, 200);
  assert.equal((await app.get(b('/ai/status'))).status, 200);

  // webhooks with no subscription: saves, an export and a backup announce events to nobody
  assert.deepEqual((await app.get('/api/webhooks')).json.webhooks, []);
  await saveScene(app, 'A line.');
  for (const url of [b('/export?format=markdown'), b('/backup?provenance=1')]) assert.equal((await getBytes(app.port, url)).status, 200, url);
  await new Promise((r) => setTimeout(r, 300));
  const calls = await app.netCalls();
  assert.deepEqual(calls, [], `outbound calls recorded: ${JSON.stringify(calls)}`);
});

test('providers configured but never asked: setting up profiles, choosing them for a book, previews, listing, moving a key and cover info send nothing', async () => {
  const chat = await startProvider();
  const pictures = await startProvider();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true, env: ENV });
  const c = await app.post(AI.profiles, profileBody({ name: 'Chat', baseUrl: chat.baseUrl, model: 'mock-model-a', keyStorage: 'config', apiKey: 'sk-test-zero-0001' }));
  const i = await app.post(AI.profiles, profileBody({ name: 'Pictures', kind: 'openai-compatible-images', baseUrl: pictures.baseUrl, model: 'image-1' }));
  assert.equal(c.status, 201, c.text);
  assert.equal(i.status, 201, i.text);
  await app.put(AI.bookProfile(), { profileId: c.json.profile.id });
  await app.put(AI.bookProfile(), { profileId: i.json.profile.id });
  assert.equal((await app.post(`${AI.profile(c.json.profile.id)}/secure`, {})).status, 200);
  await app.get(AI.profiles);
  await app.get(b('/ai/status'));
  assert.equal((await app.get(b('/ai/cover'))).json.available, true);
  const pv = await app.post(AI.context(), { task: 'chat', files: ['book.md'], instruction: 'Preview only.' });
  assert.equal(pv.status, 200, pv.text);
  // refused without consent / confirmation: still nothing
  assert.equal((await app.post(b('/ai/cover-generate'), { prompt: 'x' })).status, 409);
  assert.equal((await app.post(b('/ai/cover-generate'), { prompt: 'x', consent: true, host: 'wrong.example.com' })).status, 409);
  assert.equal((await app.put('/api/profile', { modules: { ai: false } })).status, 200);
  assert.equal((await app.post(b('/ai/cover-generate'), { prompt: 'x', consent: true, host: pictures.host })).status, 403);
  assert.equal((await app.post(AI.send(), { contextId: pv.json.contextId })).status, 403, 'the ai module off refuses the send');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(chat.calls.length + pictures.calls.length, 0, 'the providers saw nothing');
  assert.deepEqual(await app.netCalls(), []);
});

test('webhooks: a subscription whose module is off sends nothing; with it on a save sends one signed delivery (the recorder sees it), and the secret comes from the key store', async () => {
  const receiver = await startReceiver();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true, env: ENV });
  const made = await app.post('/api/webhooks', { url: receiver.url, events: ['scene.saved'], books: 'all' });
  assert.equal(made.status, 201, made.text);
  assert.equal((await app.put('/api/profile', { modules: { integrations: false } })).status, 200);
  await saveScene(app, 'First line.');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await app.netCalls(), [], 'integrations module off: nothing sent');
  assert.equal(receiver.deliveries.length, 0);

  assert.equal((await app.put('/api/profile', { modules: { integrations: true } })).status, 200);
  await saveScene(app, 'Second line.');
  await until(() => receiver.deliveries.length >= 1, 'the delivery');
  assert.equal(receiver.deliveries.length, 1);
  assert.ok(receiver.verifies(receiver.deliveries[0], made.json.secret), 'signed with the secret kept in the key store');
  const calls = await app.netCalls();
  assert.ok(calls.some((c) => c.api === 'http.request' && c.target === receiver.url), `the recorder sees the webhook path: ${JSON.stringify(calls)}`);
  assert.ok(calls.every((c) => c.api !== 'fetch'), 'no AI transport call');
});
