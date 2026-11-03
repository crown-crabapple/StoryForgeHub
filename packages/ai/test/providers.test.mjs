// M08-J03: streaming (SSE and NDJSON), cancel, token accounting, model discovery, image generation and the profile key storage, against a mock provider on 127.0.0.1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { accountUsage, createAiSettings, createKeystore, discoverCapabilities, generateImage, KeystoreError, streamCompletion } from '../src/index.mjs';

const servers = [];
after(() => servers.forEach((s) => s.closeAllConnections?.() ?? s.close()));

/** @param {(req: http.IncomingMessage, res: http.ServerResponse, body: string) => void} handler */
async function serve(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { calls, origin: `http://127.0.0.1:${server.address().port}`, base: `http://127.0.0.1:${server.address().port}/v1` };
}

const sse = (res, parts) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const p of parts) res.write(typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\n\n`);
  res.end();
};
const delta = (t) => ({ choices: [{ delta: { content: t } }] });

test('stream: SSE pieces arrive in order, the reported usage is used, the key goes out only as a header', async () => {
  const m = await serve((req, res) => sse(res, [delta('Hel'), delta('lo'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }, 'data: [DONE]\n\n']));
  const seen = [];
  const r = await streamCompletion({ baseUrl: m.base }, 'sk-test-abc123', { model: 'x', messages: [{ role: 'user', content: 'hi there' }] }, { onDelta: (t) => seen.push(t) });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.equal(r.reply, 'Hello');
  assert.deepEqual(r.tokens, { promptTokens: 7, completionTokens: 2, totalTokens: 9, estimated: false });
  assert.equal(m.calls[0].headers.authorization, 'Bearer sk-test-abc123');
  assert.equal(JSON.parse(m.calls[0].body).stream, true);
  assert.equal(m.calls[0].body.includes('sk-test-abc123'), false);
});

test('stream: NDJSON (Ollama style) works, and without reported usage the totals are estimated (characters / 4)', async () => {
  const m = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: 'abcd' }, done: false })}\n`);
    res.write(`${JSON.stringify({ message: { content: 'efgh' }, done: false })}\n`);
    res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
  });
  const r = await streamCompletion({ baseUrl: m.base }, null, { model: 'x', messages: [{ role: 'user', content: '12345678' }] });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'abcdefgh');
  assert.deepEqual(r.tokens, { promptTokens: 2, completionTokens: 2, totalTokens: 4, estimated: true });
});

test('stream: a stream that ends early is not a result; cancel mid-stream returns no text', async () => {
  const early = await serve((req, res) => sse(res, [delta('half a sentence')]));
  const a = await streamCompletion({ baseUrl: early.base }, null, { model: 'x', messages: [] });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'STREAM_INCOMPLETE');
  assert.equal('reply' in a, false, 'the partial text is not handed back');

  const slow = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(delta('first'))}\n\n`); // then nothing: the client has to cancel
  });
  const ctl = new AbortController();
  const r = await streamCompletion({ baseUrl: slow.base }, null, { model: 'x', messages: [] }, { signal: ctl.signal, onDelta: () => ctl.abort() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ABORTED');
  assert.equal('reply' in r, false);
});

test('accountUsage: reported when both counts are there, else estimated', () => {
  assert.deepEqual(accountUsage({ prompt_tokens: 3, completion_tokens: 4 }, { promptText: 'x', completionText: 'y' }), { promptTokens: 3, completionTokens: 4, totalTokens: 7, estimated: false });
  assert.equal(accountUsage({ prompt_tokens: 3 }, { promptText: 'abcdefgh', completionText: 'abcd' }).estimated, true);
  assert.deepEqual(accountUsage(null, { promptText: 'abcdefgh', completionText: 'abcde' }), { promptTokens: 2, completionTokens: 2, totalTokens: 4, estimated: true });
});

test('discovery: lists /models; on a localhost base also finds Ollama through /api/tags; reports streaming and usage; sends no book text', async () => {
  const m = await serve((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3:8b' }] }));
    } else sse(res, [delta('OK'), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, 'data: [DONE]\n\n']);
  });
  const r = await discoverCapabilities({ baseUrl: m.base, model: 'model-a' }, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['llama3:8b', 'model-a', 'model-b']);
  assert.equal(r.ollama, true);
  assert.equal(r.streaming, true);
  assert.equal(r.usageReported, true);
  assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url}`), ['GET /v1/models', 'GET /api/tags', 'POST /v1/chat/completions']);
  assert.match(m.calls[2].body, /Reply with OK\./);
  const without = await discoverCapabilities({ baseUrl: m.base, model: 'model-a' }, null, { probe: false });
  assert.equal(without.streaming, null);
});

test('image generation: sends exactly the prompt, takes only inline PNG data, refuses a link', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  let mode = 'png';
  const m = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [mode === 'png' ? { b64_json: png.toString('base64') } : { url: 'https://example.com/x.png' }] }));
  });
  const ok = await generateImage({ baseUrl: m.base, model: 'img' }, 'sk-test-img', 'A lighthouse at dusk');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.bytes, png);
  assert.equal(JSON.parse(m.calls[0].body).prompt, 'A lighthouse at dusk');
  assert.equal(m.calls[0].url, '/v1/images/generations');
  mode = 'url';
  const bad = await generateImage({ baseUrl: m.base, model: 'img' }, null, 'p');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_RESPONSE');
  assert.equal(m.calls.length, 2, 'the link was not followed');
});

// ---------------------------------------------------------------- profile key storage

function memoryConfig() {
  let doc = null;
  return { read: async () => (doc === null ? null : structuredClone(doc)), write: async (_f, v) => ((doc = structuredClone(v)), { ok: true }), raw: () => JSON.stringify(doc) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-aikeys-'));
const SECRET = `sk-test-${Math.random().toString(36).slice(2)}`;
const body = (over = {}) => ({ name: 'P', baseUrl: 'https://api.example.com/v1', model: 'm', ...over });

test('a new key defaults to secure storage: ai.json holds no key, the key store does, and the profile only says hasKey', async () => {
  const cfg = memoryConfig();
  const dir = tmp();
  const ks = createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key' } });
  const s = createAiSettings({ read: cfg.read, write: cfg.write, keystore: ks });
  const c = await s.create(body({ apiKey: SECRET }));
  assert.equal(c.ok, true);
  assert.equal(c.profile.keyStorage, 'secure');
  assert.equal(c.profile.hasKey, true);
  assert.equal(JSON.stringify(c.profile).includes(SECRET), false);
  assert.equal(cfg.raw().includes(SECRET), false);
  assert.equal(await s.keyFor((await s.get(c.profile.id))), SECRET);
  assert.deepEqual(await s.allKeys(), [SECRET]);
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes(SECRET), false);
  // a clear key removes it from the store
  await s.update(c.profile.id, { apiKey: '' });
  assert.deepEqual(await ks.ids(), []);
});

test('"Move key to secure storage": the plain copy is deleted only after the secure copy exists', async () => {
  const cfg = memoryConfig();
  const ks = createKeystore({ dir: tmp(), env: { STORYFORGE_SECRETS_BACKEND: 'file-key' } });
  const s = createAiSettings({ read: cfg.read, write: cfg.write, keystore: ks });
  const c = await s.create(body({ keyStorage: 'config', apiKey: SECRET }));
  assert.equal(cfg.raw().includes(SECRET), true, 'config storage is plain text, as documented');
  const m = await s.moveKeyToSecure(c.profile.id);
  assert.equal(m.ok, true);
  assert.equal(m.profile.keyStorage, 'secure');
  assert.equal(cfg.raw().includes(SECRET), false);
  assert.equal(await ks.get('ai.' + c.profile.id), SECRET);
  assert.equal((await s.moveKeyToSecure(c.profile.id)).ok, false, 'nothing left to move');

  const failing = { ...ks, set: async () => { throw new KeystoreError('STORE_FAILED', 'nope'); } };
  const s2 = createAiSettings({ read: cfg.read, write: cfg.write, keystore: /** @type {any} */ (failing) });
  const c2 = await s2.create(body({ keyStorage: 'config', apiKey: 'sk-test-second-key' }));
  await assert.rejects(s2.moveKeyToSecure(c2.profile.id), (e) => e.code === 'STORE_FAILED');
  assert.equal(cfg.raw().includes('sk-test-second-key'), true, 'a failed move keeps the plain copy');
});

test('a key that cannot be unlocked is a LOCKED error, never an empty key; the status says why', async () => {
  const cfg = memoryConfig();
  const dir = tmp();
  const env = { STORYFORGE_SECRETS_BACKEND: 'file-key' };
  const s = createAiSettings({ read: cfg.read, write: cfg.write, keystore: createKeystore({ dir, env }) });
  const c = await s.create(body({ apiKey: SECRET }));
  fs.writeFileSync(path.join(dir, 'secrets-key.json'), JSON.stringify({ version: 1, key: Buffer.alloc(32, 9).toString('base64') }));
  const fresh = createAiSettings({ read: cfg.read, write: cfg.write, keystore: createKeystore({ dir, env }) });
  const profile = await fresh.get(c.profile.id);
  await assert.rejects(fresh.keyFor(/** @type {any} */ (profile)), (e) => e.code === 'LOCKED' && !String(e.message).includes(SECRET));
  const st = await fresh.keystoreStatus();
  assert.equal(st.locked, true);
  assert.match(String(st.message), /cannot unlock stored keys/);
  assert.deepEqual(await fresh.allKeys(), [], 'nothing to redact, and no crash');
  assert.equal((await fresh.list())[0].hasKey, true);
});

test('an image profile fills the book image slot, not the chat slot', async () => {
  const cfg = memoryConfig();
  const s = createAiSettings({ read: cfg.read, write: cfg.write, keystore: createKeystore({ dir: tmp(), env: { STORYFORGE_SECRETS_BACKEND: 'file-key' } }) });
  const chat = await s.create(body());
  const img = await s.create(body({ kind: 'openai-compatible-images', name: 'Pictures' }));
  await s.setBookProfile('book_1', chat.profile.id);
  await s.setBookProfile('book_1', img.profile.id);
  assert.equal((await s.activeProfile('book_1'))?.id, chat.profile.id);
  assert.equal((await s.activeImageProfile('book_1'))?.id, img.profile.id);
  await s.setBookProfile('book_1', null, 'image');
  assert.equal(await s.activeImageProfile('book_1'), null);
  assert.equal((await s.activeProfile('book_1'))?.id, chat.profile.id);
});
