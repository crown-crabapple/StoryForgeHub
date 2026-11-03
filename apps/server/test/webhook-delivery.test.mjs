// M08-J02 acceptance 2 (the webhook consumer) and acceptance 5 (zero traffic with no subscriptions; the integrations module off stops delivery).
// The receiver is the sample (examples/webhook-receiver); the zero-traffic proof uses the network recorder preload in a REAL server process, like the AI tests.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { REPO_ROOT, copyFixture, snapshot } from './helpers.mjs';
import { makeHome } from './ai-helpers.mjs';
import { start, stopAll } from './custom-helpers.mjs';
import { BOOK, SCENE, SCENE_PATH, SLUG, bootPersonal, closeAll, raw, sceneBytes, sleep, startReceiver } from './plugin-helpers.mjs';

after(async () => {
  await closeAll();
  await stopAll();
});

const sha = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const FAST = { backoffMs: [0, 0, 0], timeoutMs: 2000 };

/** Wait (bounded) until `fn` is true. */
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Subscribe `receiver` through the member API, as Settings does. */
async function subscribe(t, receiver, extra = {}) {
  const r = await t.member('POST', '/api/webhooks', { url: receiver.url, events: ['scene.saved'], books: 'all', ...extra });
  assert.equal(r.status, 201, r.text);
  receiver.setSecret(r.json.secret);
  return r.json;
}

/** Save the scene through the member API with `text` added to its body; returns the new sha256 and the whole body. */
async function saveScene(t, marker) {
  const cur = (await t.member('GET', `/api/books/${BOOK}/scenes/${SCENE}`)).json;
  const body = `${cur.body.trimEnd()}\n\n${marker}\n`;
  const r = await t.member('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body, base_sha256: cur.sha256 });
  assert.equal(r.status, 200, r.text);
  return { sha256: r.json.sha256, body };
}

test('acceptance 2: the sample receiver gets ONE signed event with ids and hashes and no text; the body bytes are never sent with include_content off', async () => {
  const t = await bootPersonal({ integrations: FAST });
  const receiver = await startReceiver();
  const made = await subscribe(t, receiver);
  assert.equal(made.webhook.include_content, false);
  const MARKER = 'Zq7-unmistakable-sentence-about-saltwater';
  const saved = await saveScene(t, MARKER);

  await until(() => receiver.seen.length >= 1, 'the delivery');
  await sleep(300); // and no second one
  assert.equal(receiver.seen.length, 1, 'one event for one save');
  const got = receiver.seen[0];
  assert.equal(got.status, 204);
  assert.equal(got.headers['x-storyforge-signature'], hmac(made.secret, got.raw), 'the signature is the HMAC of the exact bytes');
  assert.equal(got.headers['x-storyforge-event'], 'scene.saved');
  const event = JSON.parse(got.raw.toString('utf8'));
  assert.deepEqual(Object.keys(event).sort(), ['at', 'book_id', 'event', 'path', 'sha256', 'target_id']);
  assert.equal(event.event, 'scene.saved');
  assert.equal(event.book_id, BOOK);
  assert.equal(event.target_id, SCENE);
  assert.equal(event.path, SCENE_PATH);
  assert.equal(event.sha256, sha(await sceneBytes(t.root)), 'the hash is of the scene file as saved');
  assert.match(event.at, /^\d{4}-\d\d-\d\dT/);
  // byte search: neither the marker nor any sentence of the body is in what was sent, in any header or the body
  const sent = Buffer.concat([got.raw, Buffer.from(JSON.stringify(got.headers))]);
  assert.equal(sent.includes(Buffer.from(MARKER)), false);
  assert.equal(sent.includes(Buffer.from('The ferry nudged the jetty')), false);
  assert.equal(sent.includes(Buffer.from(saved.body.slice(0, 40))), false);
  // the sample wrote the good event to its file
  assert.deepEqual((await receiver.events()).map((e) => e.sha256), [event.sha256]);
  // the secret is shown once: never in a listing, and never in the library
  const listed = await t.member('GET', '/api/webhooks');
  assert.equal(listed.text.includes(made.secret), false);
  assert.equal(listed.json.webhooks[0].last_delivery.ok, true);
  assert.equal(listed.json.webhooks[0].last_delivery.status, 204);
  for (const [rel] of Object.entries(await snapshot(t.root))) {
    if (rel.endsWith('/')) continue;
    assert.equal((await fs.readFile(path.join(t.root, ...rel.split('/')))).includes(Buffer.from(made.secret)), false, `${rel} holds no secret`);
  }
});

test('acceptance 2: a bad signature is rejected by the receiver, and a body signed with another secret too', async () => {
  const t = await bootPersonal({ integrations: FAST });
  const receiver = await startReceiver();
  const made = await subscribe(t, receiver);
  await saveScene(t, 'second save');
  await until(() => receiver.seen.length >= 1, 'the delivery');
  const good = receiver.seen[0];
  assert.equal(good.status, 204);
  const before = (await receiver.events()).length;
  for (const sig of ['sha256=' + '0'.repeat(64), hmac('not-the-secret', good.raw), 'sha256=zz', '', hmac(made.secret, Buffer.from('another body'))]) {
    const r = await raw(receiver.port, 'POST', '/hook', { body: good.raw.toString('utf8'), headers: { 'content-type': 'application/json', 'x-storyforge-signature': sig } });
    assert.equal(r.status, 401, sig);
  }
  const unsigned = await raw(receiver.port, 'POST', '/hook', { body: good.raw.toString('utf8'), headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 401);
  assert.equal((await receiver.events()).length, before, 'nothing was recorded for a rejected request');
});

test('include_content is the author\'s choice: with it on the scene text is added; it is part of what is signed; a different subscriber without it still gets none', async () => {
  const t = await bootPersonal({ integrations: FAST });
  const withText = await startReceiver();
  const without = await startReceiver();
  const a = await subscribe(t, withText, { include_content: true });
  assert.equal(a.webhook.include_content, true);
  await subscribe(t, without);
  const MARKER = 'Kx9-sentence-only-the-opted-in-receiver-may-see';
  await saveScene(t, MARKER);
  await until(() => withText.seen.length >= 1 && without.seen.length >= 1, 'both deliveries');
  const full = JSON.parse(withText.seen[0].raw.toString('utf8'));
  assert.match(full.content, new RegExp(MARKER));
  assert.equal(withText.seen[0].headers['x-storyforge-signature'], hmac(a.secret, withText.seen[0].raw));
  assert.equal(without.seen[0].raw.includes(Buffer.from(MARKER)), false);
  assert.equal(Object.hasOwn(JSON.parse(without.seen[0].raw.toString('utf8')), 'content'), false);
});

test('events: scene.created, scene.moved, entry.changed, suggestion.created and suggestion.decided are sent, a dry run and a failed save are not, books filter', async () => {
  const t = await bootPersonal({ integrations: FAST, fixture: 'valid/suggestion' });
  const receiver = await startReceiver();
  const all = ['scene.saved', 'scene.created', 'scene.moved', 'entry.changed', 'suggestion.created', 'suggestion.decided', 'export.done', 'backup.done'];
  const made = await t.member('POST', '/api/webhooks', { url: receiver.url, events: all, books: [SLUG] });
  assert.equal(made.status, 201, made.text);
  receiver.setSecret(made.json.secret);
  const names = () => receiver.seen.map((s) => JSON.parse(s.raw.toString('utf8')).event);

  const cur = (await t.member('GET', `/api/books/${BOOK}/scenes/${SCENE}`)).json;
  // a refused save (stale base) sends nothing
  assert.equal((await t.member('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'x', base_sha256: 'f'.repeat(64) })).status, 409);
  // a dry run writes nothing and so sends nothing
  const dry = await t.member('POST', `/api/books/${BOOK}/scenes`, { chapter: 1, after: SCENE, title: 'Dry', slug: 'dry', body: 'Dry text.\n', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  await sleep(150);
  assert.deepEqual(names(), []);

  const created = await t.member('POST', `/api/books/${BOOK}/scenes`, { chapter: 1, after: SCENE, title: 'Fresh scene', slug: 'fresh-scene', body: 'New text.\n' });
  assert.equal(created.status, 201, created.text);
  const moved = await t.member('POST', `/api/books/${BOOK}/scenes/${created.json.id}/move`, { chapter: 1, after: null });
  assert.equal(moved.status, 200, moved.text);
  const entry = (await t.member('GET', `/api/books/${BOOK}/codex/entries`)).json.entries[0];
  const entryChanged = await t.member('POST', `/api/books/${BOOK}/entries/${entry.id}/fields`, { role: 'someone new' });
  assert.equal(entryChanged.status, 200, entryChanged.text);
  const proposed = await t.member('POST', `/api/books/${BOOK}/suggestions`, { target: SCENE, proposedText: cur.body.replace('ferry', 'boat') });
  assert.equal(proposed.status, 201, proposed.text);
  const decided = await t.member('POST', `/api/books/${BOOK}/suggestions/${proposed.json.id}`, { decision: 'decline' });
  assert.equal(decided.status, 200, decided.text);
  const exported = await t.member('GET', `/api/books/${BOOK}/export?format=markdown`);
  assert.equal(exported.status, 200);
  const backup = await t.member('GET', `/api/books/${BOOK}/backup`);
  assert.equal(backup.status, 200);

  await until(() => receiver.seen.length >= 7, `7 events (have ${names().join(', ')})`);
  assert.deepEqual([...new Set(names())].sort(), [...all].sort().filter((n) => n !== 'scene.saved'));
  const byName = Object.fromEntries(receiver.seen.map((s) => JSON.parse(s.raw.toString('utf8'))).map((e) => [e.event, e]));
  assert.equal(byName['scene.created'].target_id, created.json.id);
  assert.equal(byName['scene.moved'].target_id, created.json.id);
  assert.equal(byName['entry.changed'].target_id, entry.id);
  assert.equal(byName['suggestion.created'].target_id, proposed.json.id);
  assert.equal(byName['suggestion.decided'].target_id, proposed.json.id);
  assert.equal(byName['export.done'].sha256, sha(exported.bytes), 'an export event carries the hash of the file');
  assert.match(byName['backup.done'].path, /\.zip$/);
  for (const s of receiver.seen) assert.equal(s.status, 204);
});

test('a plugin\'s proposal sends suggestion.created with the plugin as `by`, never its text', async () => {
  const t = await bootPersonal({ integrations: FAST });
  const receiver = await startReceiver();
  const { token } = await t.grant({ plugin: 'proposer', permissions: ['read', 'propose'] });
  const hook = await t.member('POST', '/api/webhooks', { url: receiver.url, events: ['suggestion.created'], books: 'all' });
  receiver.setSecret(hook.json.secret);
  const scene = (await t.plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/${SCENE}`)).json;
  const r = await t.plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { body: { target: SCENE, text: scene.body.replace('ferry', 'PROPOSED-WORD') } });
  assert.equal(r.status, 201, r.text);
  await until(() => receiver.seen.length >= 1, 'the event');
  const event = JSON.parse(receiver.seen[0].raw.toString('utf8'));
  assert.equal(event.event, 'suggestion.created');
  assert.equal(event.target_id, r.json.suggestion.id);
  assert.deepEqual(event.by, { name: 'proposer' });
  assert.equal(receiver.seen[0].raw.includes(Buffer.from('PROPOSED-WORD')), false);
});

test('Settings refuse a bad address: http to anything but this computer, a private network without the tick, credentials, other protocols', async () => {
  const t = await bootPersonal();
  const make = (url, extra) => t.member('POST', '/api/webhooks', { url, events: ['scene.saved'], books: 'all', ...extra });
  assert.equal((await make('http://example.com/hook')).json.code, 'REFUSED_INSECURE');
  assert.equal((await make('https://192.168.1.20/hook')).json.code, 'REFUSED_PRIVATE');
  assert.equal((await make('https://192.168.1.20/hook', { allow_local: true })).status, 201, 'the author may allow the local network');
  assert.equal((await make('https://user:pw@example.com/hook')).json.code, 'REFUSED_CREDENTIALS');
  assert.equal((await make('ftp://example.com/hook')).json.code, 'REFUSED_PROTOCOL');
  assert.equal((await make('not a url')).json.code, 'BAD_URL');
  assert.equal((await make('https://example.com/hook', { include_content: 'yes' })).status, 400);
  assert.equal((await make('http://127.0.0.1:9/hook', { books: ['nope'] })).status, 400);
  assert.equal((await t.member('POST', '/api/webhooks', { url: 'https://example.com/h', events: [], books: 'all' })).status, 400);
  assert.equal((await t.member('DELETE', '/api/webhooks/whk_NOPE')).status, 404);
});

test('a revoked webhook is not sent to; a receiver that refuses is not retried (a 4xx) and the failure is shown', async () => {
  const t = await bootPersonal({ integrations: FAST });
  const a = await startReceiver();
  const made = await subscribe(t, a);
  assert.equal((await t.member('DELETE', `/api/webhooks/${made.webhook.id}`)).status, 200);
  await saveScene(t, 'after revoke');
  await sleep(300);
  assert.equal(a.seen.length, 0);

  const failing = await startReceiver(); // its secret is never set: every request is answered 401, which is a failure that is not retried
  await t.member('POST', '/api/webhooks', { url: failing.url, events: ['scene.saved'], books: 'all' });
  await saveScene(t, 'to a failing receiver');
  await until(async () => (await t.member('GET', '/api/webhooks')).json.webhooks.find((w) => w.url === failing.url)?.failures === 1, 'the failure to be recorded');
  const row = (await t.member('GET', '/api/webhooks')).json.webhooks.find((w) => w.url === failing.url);
  assert.equal(row.last_delivery.ok, false);
  assert.equal(row.last_delivery.status, 401);
  assert.equal(row.disabled, false);
  assert.equal(failing.seen.length, 1, 'a 4xx answer is not retried');
});

// ---------------------------------------------------------------- acceptance 5: zero traffic, and the integrations module off

/** The writes and reads of a normal session, as the app makes them. */
async function session(app) {
  const b = `/api/books/${BOOK}`;
  const cur = (await app.get(`${b}/scenes/${SCENE}`)).json;
  assert.equal((await app.put(`${b}/scenes/${SCENE}/body`, { body: `${cur.body.trimEnd()}\n\nmore\n`, base_sha256: cur.sha256 })).status, 200);
  assert.equal((await app.post(`${b}/suggestions`, { target: SCENE, proposedText: `${cur.body.trimEnd()}\n\nanother\n` })).status, 201);
  assert.equal((await app.get(`${b}/export?format=markdown`)).status, 200);
  assert.equal((await app.get(`${b}/backup`)).status, 200);
  assert.equal((await app.get('/api/plugins')).status, 200);
  assert.equal((await app.get('/api/webhooks')).status, 200);
  assert.equal((await app.get('/api/books')).status, 200);
}

test('acceptance 5: with no subscription a real server makes ZERO outbound network calls, plugin API and Settings included (and the recorder does see a delivery)', async () => {
  const library = await copyFixture('valid/salt-orchard');
  const home = await makeHome();
  const app = await start({ library, home, net: true });
  await session(app);
  // the plugin API: grant, read, propose, list webhooks (none)
  const g = await app.post('/api/plugins/grants', { plugin: 'p', permissions: ['read', 'propose', 'events'], books: 'all' });
  assert.equal(g.status, 201, g.text);
  const asPlugin = (method, p, body) => raw(app.port, method, p, { body, headers: { authorization: `Bearer ${g.json.token}`, ...(body ? { 'content-type': 'application/json' } : {}) } });
  assert.equal((await asPlugin('GET', `/api/v1/books/${SLUG}`)).status, 200);
  assert.equal((await asPlugin('GET', '/api/v1/webhooks')).status, 200);
  assert.equal((await asPlugin('POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: 'one two three\n' })).status, 201);
  await sleep(500);
  assert.deepEqual(await app.netCalls(), [], 'nothing went out: no subscriptions, no traffic');

  // positive control: one loopback subscription, one save, and the recorder sees the outbound request
  const receiver = await startReceiver();
  const made = await app.post('/api/webhooks', { url: receiver.url, events: ['scene.saved'], books: 'all' });
  assert.equal(made.status, 201, made.text);
  receiver.setSecret(made.json.secret);
  const cur = (await app.get(`/api/books/${BOOK}/scenes/${SCENE}`)).json;
  assert.equal((await app.put(`/api/books/${BOOK}/scenes/${SCENE}/body`, { body: `${cur.body.trimEnd()}\n\nonce more\n`, base_sha256: cur.sha256 })).status, 200);
  await until(() => receiver.seen.length >= 1, 'the delivery from the real server');
  const calls = await app.netCalls();
  assert.ok(calls.some((c) => /^(http|https)\.request$/.test(c.api)), `the recorder saw ${JSON.stringify(calls)}`);
  assert.ok(calls.every((c) => c.target.includes(`${receiver.port}`) || c.api.startsWith('net.')), 'and only to the subscribed receiver');
});

test('acceptance 5: with the integrations module off nothing is delivered, and turning it back on resumes', async () => {
  const t = await bootPersonal({ integrations: FAST, profile: 'j02-hooks-off' });
  const receiver = await startReceiver();
  await subscribe(t, receiver);
  assert.equal((await t.member('PUT', '/api/profile', { modules: { integrations: false } })).status, 200);
  await saveScene(t, 'while off');
  await sleep(400);
  assert.equal(receiver.seen.length, 0, 'no delivery while the module is off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: { integrations: true } })).status, 200);
  await saveScene(t, 'while on again');
  await until(() => receiver.seen.length >= 1, 'a delivery once it is on again');
  assert.equal(receiver.seen.length, 1);
});

test('the sample receiver runs as its own process: it verifies, writes a good event and answers 401 to a bad one', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'sf-recv-cli-'));
  const out = path.join(dir, 'events.jsonl');
  const secretFile = path.join(dir, 'secret.txt');
  await fs.writeFile(secretFile, 's3cret-from-a-file\n');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'examples', 'webhook-receiver', 'receiver.mjs'), '--port', '0', '--out', out, '--secret-file', secretFile], { windowsHide: true });
  try {
    const port = await new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (d) => {
        text += d;
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', () => reject(new Error('receiver exited')));
    });
    const body = JSON.stringify({ event: 'scene.saved', at: 'now', book_id: 'b', target_id: 's', path: 'p', sha256: 'h' });
    const good = await raw(port, 'POST', '/', { body, headers: { 'content-type': 'application/json', 'x-storyforge-signature': hmac('s3cret-from-a-file', Buffer.from(body)) } });
    assert.equal(good.status, 204);
    const bad = await raw(port, 'POST', '/', { body, headers: { 'content-type': 'application/json', 'x-storyforge-signature': hmac('wrong', Buffer.from(body)) } });
    assert.equal(bad.status, 401);
    assert.deepEqual((await fs.readFile(out, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).event), ['scene.saved']);
  } finally {
    child.kill();
  }
});
