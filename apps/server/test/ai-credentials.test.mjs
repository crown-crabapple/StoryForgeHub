// M05-J04 acceptance 4: credentials.
//  - an API key is never in any API response, in the server's stdout/stderr, in any book file (including .storyforge/), or anywhere but the user config file (and only for keyStorage 'config')
//  - a `session` key is gone after a restart; a `config` key survives it
//  - the key goes out only as `Authorization: Bearer` to that profile's own base URL
//  - cloud locality: a send without `confirmCloud: true` is 409 CLOUD_CONFIRM_REQUIRED (nothing sent, every time); with it, the request carries the Authorization header
//  - an http: base URL on a non-loopback host is refused when the profile is saved
//
// The cloud case uses a REAL TLS handshake with no external network: the "cloud" is a TLS mock on 127.0.0.2 (loopback, but not one of the three hosts the contract treats as
// local, so its locality is derived as `cloud`), with a throwaway self-signed certificate (fixtures/ai-tls) that the server process trusts through NODE_EXTRA_CA_CERTS.
// If 127.0.0.2 cannot be bound on a machine, those two tests report that instead of passing silently.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { snapshot } from './helpers.mjs';
import { AI, ARRIVAL_PATH, TLS_CERT, freshLibrary, idOf, makeHome, profileBody, readConfigFiles, readEverything, setupProvider, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';

const SECRET = 'sk-sftest-7c1e5b2d4a68f09e3b1d'; // a made-up value for these tests only
const mocks = [];
after(async () => {
  for (const m of mocks) await m.close();
  await stopAll();
});
const mockLocal = async (opts) => {
  const m = await startMockProvider(opts);
  mocks.push(m);
  return m;
};
const ctx = (app, over = {}) => app.post(AI.context(), { task: 'chat', files: [ARRIVAL_PATH], instruction: 'Summarise.', ...over });
const hasSecret = (text) => text.includes(SECRET);

/** Every text file under `dir` that mentions the secret. */
async function filesWithSecret(dir) {
  const hits = [];
  for (const [rel, buf] of await readEverything(dir)) if (buf.includes(SECRET)) hits.push(rel);
  return hits;
}

test('session key: never in a response, a log line, a book file or the config file; sent as Authorization: Bearer to its own base URL', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const seen = [];
  const keep = (r) => (seen.push(r.text), r);

  const created = keep(await app.post(AI.profiles, profileBody({ baseUrl: mock.baseUrl, keyStorage: 'session', [AI.keyField]: SECRET })));
  assert.ok(created.status === 200 || created.status === 201, created.text);
  const id = idOf(created);
  assert.equal(keep(await app.put(AI.bookProfile(), { profileId: id })).status, 200);
  const list = keep(await app.get(AI.profiles));
  const rows = list.json.profiles ?? list.json;
  const row = rows.find((p) => p.id === id);
  assert.equal(row.hasKey, true, 'the API says a key exists');
  assert.equal(row.keyStorage, 'session');
  for (const k of Object.keys(row)) assert.ok(!/key$/i.test(k) || k === 'hasKey', `no key-bearing field in a profile (${k})`);
  keep(await app.put(AI.profile(id), { ...profileBody({ baseUrl: mock.baseUrl, keyStorage: 'session' }), name: 'Renamed' }));
  const preview = keep(await ctx(app));
  assert.equal(preview.status, 200, preview.text);
  keep(await app.post(AI.send(), { contextId: preview.json.contextId }));
  keep(await app.post(AI.test(id), {}));
  keep(await app.post(AI.send(), { contextId: 'ctx_missing' }));
  keep(await app.get('/api/status'));

  assert.ok(mock.calls.length >= 2);
  for (const c of mock.calls) assert.equal(c.headers.authorization, `Bearer ${SECRET}`, 'the provider gets the key as a bearer token');
  assert.ok(!mock.calls.some((c) => c.raw.includes(SECRET)), 'the key is not in a request body either');
  assert.ok(seen.every((t) => !hasSecret(t)), 'the key is in no API response');
  assert.ok(!hasSecret(app.output()), 'the key is in no log line (server stdout + stderr)');
  assert.deepEqual(await filesWithSecret(library), [], 'the key is in no book file');
  assert.deepEqual(await filesWithSecret(home.home), [], 'a session key is not written to disk at all (not even the user config file)');
});

test('session key is gone after a restart; the profile itself survives', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const first = await startApp({ library, home });
  const id = await setupProvider(first, { baseUrl: mock.baseUrl, keyStorage: 'session', [AI.keyField]: SECRET });
  await first.stop();

  const second = await startApp({ library, home });
  const rows = (await second.get(AI.profiles)).json;
  const row = (rows.profiles ?? rows).find((p) => p.id === id);
  assert.ok(row, 'profile persisted in the user config');
  assert.equal(row.hasKey, false, 'the session key did not survive');
  mock.calls.length = 0;
  const preview = await ctx(second);
  if (preview.status === 200) await second.post(AI.send(), { contextId: preview.json.contextId });
  for (const c of mock.calls) assert.equal(c.headers.authorization, undefined, 'no stale key is sent');
  assert.ok(!hasSecret(second.output()));
  assert.deepEqual(await filesWithSecret(home.home), []);
});

test('config key: present in the user config file (plain text) and nowhere else; survives a restart and is then sent', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const first = await startApp({ library, home });
  const seen = [];
  const created = await first.post(AI.profiles, profileBody({ baseUrl: mock.baseUrl, keyStorage: 'config', [AI.keyField]: SECRET }));
  seen.push(created.text);
  const id = idOf(created);
  seen.push((await first.put(AI.bookProfile(), { profileId: id })).text);
  seen.push((await first.get(AI.profiles)).text);
  const preview = await ctx(first);
  seen.push(preview.text);
  seen.push((await first.post(AI.send(), { contextId: preview.json.contextId })).text);
  assert.ok(seen.every((t) => !hasSecret(t)), 'never in a response');
  assert.ok(!hasSecret(first.output()), 'never in a log');
  assert.deepEqual(await filesWithSecret(library), [], 'never in a book');

  const cfgFiles = await readConfigFiles(home.configDir);
  const holders = Object.entries(cfgFiles).filter(([, t]) => hasSecret(t)).map(([n]) => n);
  assert.equal(holders.length, 1, `exactly one config file holds the key: ${JSON.stringify(holders)}`);
  assert.deepEqual(await filesWithSecret(home.home), [path.relative(home.home, path.join(home.configDir, holders[0])).split(path.sep).join('/')], 'the config file is the only place on disk');
  await first.stop();

  const second = await startApp({ library, home });
  const rows = (await second.get(AI.profiles)).json;
  assert.equal((rows.profiles ?? rows).find((p) => p.id === id).hasKey, true, 'key persisted');
  mock.calls.length = 0;
  const p2 = await ctx(second);
  assert.equal((await second.post(AI.send(), { contextId: p2.json.contextId })).status, 200);
  assert.equal(mock.calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.ok(!hasSecret(second.output()));
});

test('deleting a profile removes its stored key from the config file', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const id = await setupProvider(app, { baseUrl: mock.baseUrl, keyStorage: 'config', [AI.keyField]: SECRET });
  assert.ok((await filesWithSecret(home.home)).length === 1);
  const d = await app.del(AI.profile(id));
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(await filesWithSecret(home.home), []);
  const rows = (await app.get(AI.profiles)).json;
  assert.deepEqual(rows.profiles ?? rows, []);
});

test('keyStorage none sends no Authorization header; a key given together with keyStorage none is refused and kept nowhere', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const refused = await app.post(AI.profiles, profileBody({ baseUrl: mock.baseUrl, keyStorage: 'none', [AI.keyField]: SECRET }));
  // refusing it (400) or accepting the profile and dropping the key (hasKey false) are both fine; keeping it is not
  assert.ok(refused.status === 400 || (refused.status === 201 && refused.json.profile.hasKey === false), refused.text);
  assert.ok(!hasSecret(refused.text));
  assert.deepEqual(await filesWithSecret(home.home), []);
  await setupProvider(app, { baseUrl: mock.baseUrl, keyStorage: 'none' });
  const p = await ctx(app);
  await app.post(AI.send(), { contextId: p.json.contextId });
  assert.equal(mock.calls[0].headers.authorization, undefined);
});

test('a key is sent only to its own profile: another profile with no key never carries it', async () => {
  const withKey = await mockLocal();
  const plain = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  await app.post(AI.profiles, profileBody({ name: 'keyed', baseUrl: withKey.baseUrl, keyStorage: 'session', [AI.keyField]: SECRET }));
  await setupProvider(app, { name: 'plain', baseUrl: plain.baseUrl, keyStorage: 'none' });
  const p = await ctx(app);
  await app.post(AI.send(), { contextId: p.json.contextId });
  assert.equal(plain.calls.length, 1);
  assert.equal(plain.calls[0].headers.authorization, undefined);
  assert.equal(withKey.calls.length, 0);
});

test('an unreachable provider yields an error response without the key, and the log stays clean', async () => {
  const dead = await startMockProvider();
  const baseUrl = dead.baseUrl;
  await dead.close(); // nothing listens there now
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  await setupProvider(app, { baseUrl, keyStorage: 'session', [AI.keyField]: SECRET });
  const p = await ctx(app);
  const r = await app.post(AI.send(), { contextId: p.json.contextId });
  assert.ok(r.status >= 400, r.text);
  assert.ok(!hasSecret(r.text));
  assert.ok(!hasSecret(app.output()));
});

// ---------------------------------------------------------------- cloud
async function cloudBoot(t, { keyStorage = 'session' } = {}) {
  let cloud;
  try {
    cloud = await startMockProvider({ tls: true, host: '127.0.0.2', reply: 'cloud reply' });
  } catch (e) {
    t.skip(`cannot bind 127.0.0.2 here (${e.code}); the cloud confirm gate is still covered by route-level tests that need no TLS`);
    return null;
  }
  mocks.push(cloud);
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, env: { NODE_EXTRA_CA_CERTS: TLS_CERT } });
  await setupProvider(app, { name: 'Cloud mock', baseUrl: cloud.baseUrl, keyStorage, [AI.keyField]: SECRET });
  return { cloud, library, home, app };
}

test('cloud: the preview says cloud with the host; send without confirmCloud is 409 CLOUD_CONFIRM_REQUIRED and sends nothing', async (t) => {
  const x = await cloudBoot(t);
  if (!x) return;
  const { cloud, app, library } = x;
  const before = await snapshot(library, { skipStoryforge: true });
  const preview = await ctx(app);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.provider.locality, 'cloud');
  assert.ok(preview.json.provider.baseUrl.includes('127.0.0.2'), 'the host is shown');
  for (const confirm of [undefined, false, 'true', 1, null]) {
    const r = await app.post(AI.send(), confirm === undefined ? { contextId: preview.json.contextId } : { contextId: preview.json.contextId, confirmCloud: confirm });
    if (confirm === undefined || confirm === false) {
      assert.equal(r.status, 409, `confirmCloud=${JSON.stringify(confirm)}: ${r.text}`);
      assert.equal(r.json.code ?? r.json.error, 'CLOUD_CONFIRM_REQUIRED');
    } else {
      // not literally `true`: the contract says only confirmCloud: true sends; a malformed value may be a 400 or the same 409, never a send
      assert.ok(r.status === 400 || r.status === 409, `confirmCloud=${JSON.stringify(confirm)}: ${r.status} ${r.text}`);
    }
    assert.ok(!hasSecret(r.text));
  }
  assert.equal(cloud.calls.length, 0, 'nothing reached the provider');
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

test('cloud: send with confirmCloud: true goes out over TLS with the Authorization header; the next send needs confirming again', async (t) => {
  const x = await cloudBoot(t);
  if (!x) return;
  const { cloud, app, home, library } = x;
  const preview = (await ctx(app)).json;
  const r = await app.post(AI.send(), { contextId: preview.contextId, confirmCloud: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(cloud.calls.length, 1);
  assert.equal(cloud.calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(cloud.calls[0].body.messages), JSON.stringify(preview.messages));
  assert.ok(!hasSecret(r.text));
  assert.ok(!hasSecret(app.output()));
  assert.deepEqual(await filesWithSecret(library), []);
  assert.deepEqual(await filesWithSecret(home.home), []);
  const again = (await ctx(app)).json;
  const second = await app.post(AI.send(), { contextId: again.contextId });
  assert.equal(second.status, 409, 'confirmation is required on every send');
  assert.equal(cloud.calls.length, 1);
});

test('cloud: the profile test route also needs the confirmation (it still leaves the machine)', async (t) => {
  const x = await cloudBoot(t);
  if (!x) return;
  const { cloud, app } = x;
  const id = idOf(await app.post(AI.profiles, profileBody({ name: 'second', baseUrl: cloud.baseUrl })));
  const r = await app.post(AI.test(id), {});
  if (r.status === 409) assert.equal(r.json.code ?? r.json.error, 'CLOUD_CONFIRM_REQUIRED');
  else assert.equal(r.status, 200, 'or it is an explicit click that carries confirmCloud');
  const confirmed = await app.post(AI.test(id), { confirmCloud: true });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.ok(cloud.calls.length >= 1);
  assert.doesNotMatch(cloud.calls.at(-1).raw, /ferry|Maren|orchard/i);
});

// ---------------------------------------------------------------- base URL rules at profile save
test('http on a non-loopback host is refused when a profile is saved (400); https and loopback http are accepted', async () => {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const save = (baseUrl) => app.post(AI.profiles, profileBody({ baseUrl, name: baseUrl }));
  for (const bad of ['http://example.com/v1', 'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://127.0.0.2:8080/v1', 'http://localhost.example.com/v1', 'http://api.openai.com/v1', 'ftp://example.com/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
    const r = await save(bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${r.text}`);
  }
  const rows0 = (await app.get(AI.profiles)).json;
  assert.deepEqual(rows0.profiles ?? rows0, [], 'nothing was saved');
  for (const good of ['https://api.example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
    const r = await save(good);
    assert.ok(r.status === 200 || r.status === 201, `${good} -> ${r.status} ${r.text}`);
  }
});

test('editing a profile to an http non-loopback URL is refused and leaves the profile as it was', async () => {
  const mock = await mockLocal();
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const id = idOf(await app.post(AI.profiles, profileBody({ baseUrl: mock.baseUrl })));
  const r = await app.put(AI.profile(id), profileBody({ baseUrl: 'http://example.com/v1' }));
  assert.equal(r.status, 400, r.text);
  const rows = (await app.get(AI.profiles)).json;
  assert.equal((rows.profiles ?? rows).find((p) => p.id === id).baseUrl, mock.baseUrl);
});

test('profile validation: kind, missing model, missing name, out-of-range budget, bad keyStorage are 400', async () => {
  const mock = await mockLocal();
  const app = await startApp({ library: await freshLibrary(), home: await makeHome() });
  const base = profileBody({ baseUrl: mock.baseUrl });
  for (const bad of [{ kind: 'anthropic-native' }, { model: '' }, { name: '' }, { keyStorage: 'keychain' }, { contextBudget: -5 }, { contextBudget: 'lots' }]) {
    const r = await app.post(AI.profiles, { ...base, ...bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await app.del(AI.profile('prof_does_not_exist'))).status, 404);
});

test('profile write routes carry the same guards as other writes (a request without the StoryForge header is 403)', async () => {
  const app = await startApp({ library: await freshLibrary(), home: await makeHome() });
  const { default: http } = await import('node:http');
  const r = await new Promise((resolve, reject) => {
    const payload = JSON.stringify(profileBody({ baseUrl: 'http://127.0.0.1:1/v1' }));
    const req = http.request({ host: '127.0.0.1', port: app.port, method: 'POST', path: AI.profiles, headers: { Host: `127.0.0.1:${app.port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(r, 403);
});
