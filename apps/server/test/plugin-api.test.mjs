// M08-J02 acceptance 1, 3, 4, 5 (module off) and 6 for the plugin API, personal mode. Contract: docs/contracts/M08-J02-extensions-api-webhooks.md.
// A real server in this process over a copy of the fixture library; the plugin script runs as its own process, as an author would run it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { userConfigDir } from '../../../packages/store/src/index.mjs';
import { REPO_ROOT, snapshot } from './helpers.mjs';
import { BOOK, SCENE, SLUG, bootPersonal, closeAll, raw, sceneBytes } from './plugin-helpers.mjs';

after(closeAll);

const MANIFEST = (extra = {}) => {
  const fm = { schema: 'storyforge.plugin/v1', id: 'note_01S8000000000000000000WF01', plugin: 'word-frequency', name: 'Word frequency', version: '1.0.0', api: 1, permissions: '[read]', books: 'all', ...extra };
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\nWhat it does.\n`;
};

// ---------------------------------------------------------------- grants (Settings)

test('grant: the token is shown once, only its hash is stored, and listing never shows it', async () => {
  const t = await bootPersonal({ manifests: { 'word-frequency': MANIFEST() } });
  const r = await t.member('POST', '/api/plugins/grants', { plugin: 'word-frequency', permissions: ['read'], books: [SLUG] });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.grant.plugin, 'word-frequency');
  assert.deepEqual(r.json.grant.books, [SLUG]);
  assert.equal(JSON.stringify(r.json.grant).includes('hash'), false, 'no token hash in the answer');
  assert.equal(r.headers['cache-control'], 'no-store');
  const list = await t.member('GET', '/api/plugins');
  assert.equal(list.status, 200);
  assert.equal(list.text.includes(r.json.token), false, 'the token is never listed');
  assert.equal(list.json.grants.length, 1);
  assert.equal(list.json.manifests.length, 1, 'the manifest in _plugins/ is found');
  assert.equal(list.json.manifests[0].plugin, 'word-frequency');
  assert.deepEqual(list.json.manifests[0].permissions, ['read']);
  const stored = await fs.readFile(path.join(userConfigDir(), 'plugin-tokens.json'), 'utf8');
  assert.equal(stored.includes(r.json.token), false, 'plugin-tokens.json holds no token');
  assert.match(stored, /token_hash/);
});

test('grant: bad requests are refused (permissions, books, an unknown book); a revoke names an existing token', async () => {
  const t = await bootPersonal();
  for (const body of [{ plugin: 'x y', permissions: ['read'], books: 'all' }, { plugin: 'p', permissions: ['write'], books: 'all' }, { plugin: 'p', permissions: [], books: 'all' }, { plugin: 'p', permissions: ['read'], books: [] }, { plugin: 'p', permissions: ['read'], books: ['no-such-book'] }]) {
    const r = await t.member('POST', '/api/plugins/grants', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await t.member('DELETE', '/api/plugins/grants/tok_NOPE')).status, 404);
  const noHeader = await raw(t.port, 'POST', '/api/plugins/grants', { body: { plugin: 'p', permissions: ['read'], books: 'all' }, headers: { 'content-type': 'application/json' } });
  assert.equal(noHeader.status, 403, 'the member write guard still applies to grants');
});

// ---------------------------------------------------------------- the read routes

test('read: root, books, book tree, scene, entries, threads, events, search, graph, diagnostics, with stable shapes', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const g = async (p) => {
    const r = await t.plugin(token, 'GET', `/api/v1${p}`);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    return r.json;
  };
  const root = await g('');
  assert.equal(root.api, 1);
  assert.equal(typeof root.server, 'string');
  const books = await g('/books');
  assert.deepEqual(books.books.map((b) => b.slug), [SLUG]);
  assert.deepEqual(Object.keys(books.books[0]).sort(), ['id', 'language', 'scenes', 'series', 'series_number', 'slug', 'status', 'title', 'words']);
  const book = await g(`/books/${SLUG}`);
  assert.equal(book.id, BOOK);
  const scenes = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
  assert.ok(scenes.length >= 7);
  assert.deepEqual(Object.keys(scenes[0]).sort(), ['act', 'chapter', 'id', 'order', 'path', 'pov', 'sequence', 'status', 'title', 'words']);
  const scene = await g(`/books/${SLUG}/scenes/${SCENE}`);
  assert.equal(scene.id, SCENE);
  assert.match(scene.sha256, /^[0-9a-f]{64}$/);
  assert.equal(scene.front_matter.title, 'Arrival');
  assert.match(scene.body, /The ferry nudged the jetty/);
  const entries = await g(`/books/${SLUG}/entries`);
  assert.ok(entries.entries.length > 3);
  const entry = await g(`/books/${SLUG}/entries/${entries.entries[0].id}`);
  assert.equal(entry.id, entries.entries[0].id);
  assert.equal(typeof entry.body, 'string');
  assert.ok((await g(`/books/${SLUG}/threads`)).threads.length >= 1);
  assert.ok((await g(`/books/${SLUG}/events`)).events.length >= 1);
  const found = await g(`/books/${SLUG}/search?q=key`);
  assert.ok(found.hits.length >= 1);
  assert.deepEqual(Object.keys(found.hits[0]).sort(), ['id', 'kind', 'path', 'snippet', 'title']);
  const graph = await g(`/books/${SLUG}/graph`);
  assert.ok(graph.nodes.length > 3 && Array.isArray(graph.edges));
  assert.deepEqual((await g(`/books/${SLUG}/diagnostics`)).diagnostics, []);
  // the book can also be named by its id; unknown things are 404, a bad query 400
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${BOOK}`)).status, 200);
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/scene_01S5000000000000000000ZZZZ`)).status, 404);
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${SLUG}/search`)).status, 400);
  assert.equal((await t.plugin(token, 'GET', '/api/v1/books/no-such-book')).status, 403, 'an unknown book looks like a book you were not granted');
});

// ---------------------------------------------------------------- acceptance 1: the sample plugin against fixture data

/** Run examples/plugin-word-frequency/plugin.mjs as its own process. */
function runPlugin(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'examples', 'plugin-word-frequency', 'plugin.mjs'), ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('acceptance 1: the sample plugin run against salt-orchard prints the golden output', async () => {
  const t = await bootPersonal({ manifests: { 'word-frequency': MANIFEST() } });
  const { token } = await t.grant({ permissions: ['read'], books: [SLUG] });
  const r = await runPlugin(['--book', SLUG, '--url', `http://127.0.0.1:${t.port}`], { STORYFORGE_TOKEN: token });
  assert.equal(r.code, 0, r.err);
  const golden = await fs.readFile(path.join(REPO_ROOT, 'apps', 'server', 'test', 'fixtures', 'plugin-word-frequency.golden.txt'), 'utf8');
  assert.equal(r.out.replace(/\r\n/g, '\n'), golden.replace(/\r\n/g, '\n'));
  // without a token, or with a revoked one, it says so and exits 1
  const none = await runPlugin(['--book', SLUG, '--url', `http://127.0.0.1:${t.port}`], { STORYFORGE_TOKEN: 'x'.repeat(43) });
  assert.equal(none.code, 1);
  assert.match(none.err, /401/);
});

// ---------------------------------------------------------------- acceptance 3: writes are denied, a proposal is only a suggestion

test('acceptance 3: no token can write a canonical file, a read token cannot even propose; nothing on disk changes', async () => {
  const t = await bootPersonal();
  const readOnly = (await t.grant({ permissions: ['read'] })).token;
  const everything = (await t.grant({ plugin: 'big', permissions: ['read', 'propose', 'events'] })).token;
  const before = await snapshot(t.root, { skipStoryforge: true });
  const sha = (await t.member('GET', `/api/books/${BOOK}/scenes/${SCENE}`)).json.sha256;
  const attempts = [
    ['POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: 'x' }, readOnly, 'a read token cannot propose'],
    ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'hijacked', base_sha256: sha }, readOnly, 'body write, read token'],
    ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'hijacked', base_sha256: sha }, everything, 'body write, every permission'],
    ['PUT', `/api/v1/books/${SLUG}/scenes/${SCENE}/body`, { body: 'hijacked', base_sha256: sha }, everything, 'a write under /api/v1'],
    ['PUT', `/api/v1/books/${SLUG}/scenes/${SCENE}`, { body: 'hijacked' }, everything, 'PUT the v1 scene'],
    ['DELETE', `/api/v1/books/${SLUG}/scenes/${SCENE}`, undefined, everything, 'DELETE the v1 scene'],
    ['POST', `/api/books/${BOOK}/scenes/${SCENE}/archive`, { base_sha256: sha }, everything, 'archive'],
    ['POST', `/api/books/${BOOK}/suggestions`, { target: SCENE, proposedText: 'x' }, everything, 'member suggestion route'],
    ['POST', '/api/books', { title: 'Nope' }, everything, 'create a book'],
    ['POST', '/api/plugins/grants', { plugin: 'x', permissions: ['read'], books: 'all' }, everything, 'a plugin granting itself more'],
    ['POST', '/api/webhooks', { url: 'http://127.0.0.1:9/', events: ['scene.saved'], books: 'all' }, everything, 'the member webhook route'],
    ['POST', '/api/library/restore?folder=x', undefined, everything, 'restore'],
    ['GET', `/api/books/${BOOK}`, undefined, readOnly, 'a member read'],
    ['GET', `/api/books/${BOOK}/export?format=markdown`, undefined, everything, 'export'],
    ['GET', `/api/books/${BOOK}/backup`, undefined, everything, 'backup'],
    ['GET', `/api/books/${BOOK}/receipts?scene=${SCENE}`, undefined, everything, 'receipts'],
    ['GET', '/api/ai/profiles', undefined, everything, 'AI'],
    ['GET', '/api/plugins', undefined, everything, 'the grant list'],
    ['GET', '/api/health', undefined, everything, 'health'],
    ['GET', '/', undefined, everything, 'the web app itself'],
  ];
  for (const [method, p, body, token, label] of attempts) {
    const r = await t.plugin(token, method, p, { body });
    assert.equal(r.status, 403, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json?.code, 'PLUGIN_SCOPE', label);
  }
  assert.deepEqual(await snapshot(t.root, { skipStoryforge: true }), before, 'not one file changed');
});

test('acceptance 3: a propose token makes a suggestion; the scene file is unchanged until the author accepts in the normal review', async () => {
  const t = await bootPersonal({ manifests: { 'word-frequency': MANIFEST({ permissions: '[read, propose]', name: 'Word frequency' }) } });
  const { token } = await t.grant({ plugin: 'word-frequency', permissions: ['read', 'propose'], books: [SLUG] });
  const scene = (await t.plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/${SCENE}`)).json;
  const original = await sceneBytes(t.root);
  const next = scene.body.replace('green eyes ringed with salt', 'grey eyes ringed with salt');
  assert.notEqual(next, scene.body);

  const r = await t.plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { body: { target: SCENE, text: next, rationale: 'Her eyes are grey elsewhere in the book.' } });
  assert.equal(r.status, 201, r.text);
  const s = r.json.suggestion;
  assert.equal(s.source, 'plugin');
  assert.equal(s.plugin, 'word-frequency');
  assert.deepEqual(s.by, { name: 'Word frequency' });
  assert.equal(s.target, SCENE);
  assert.equal(s.rationale, 'Her eyes are grey elsewhere in the book.');
  assert.equal(s.hunks.length, 1);
  assert.equal(s.hunks[0].status, 'pending');
  assert.equal(Buffer.compare(await sceneBytes(t.root), original), 0, 'the scene file is byte-identical after the proposal');

  // it is in the author's normal review, and the file on disk validates (source: plugin, plugin: slug)
  const listed = await t.member('GET', `/api/books/${BOOK}/suggestions?state=open`);
  assert.equal(listed.json.suggestions.length, 1);
  assert.equal(listed.json.suggestions[0].plugin, 'word-frequency');
  const diags = await t.member('GET', `/api/books/${BOOK}/diagnostics`);
  assert.deepEqual(diags.json.filter((d) => d.severity === 'error'), []);

  // the author accepts the hunk through the existing route: only that line changes, and the receipt names the plugin
  const accepted = await t.member('POST', `/api/books/${BOOK}/suggestions/${s.id}`, { decision: 'accept' });
  assert.equal(accepted.status, 200, accepted.text);
  const after = (await sceneBytes(t.root)).toString('utf8');
  assert.equal(after, original.toString('utf8').replace('green eyes ringed with salt', 'grey eyes ringed with salt'));
  const receipts = await t.member('GET', `/api/books/${BOOK}/receipts?scene=${SCENE}`);
  assert.match(JSON.stringify(receipts.json), /Plugin: word-frequency/);
});

test('proposals by hunks: ranges into the body, overlap and bad ranges refused, an unchanged proposal is a conflict', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'] });
  const scene = (await t.plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/${SCENE}`)).json;
  const at = scene.body.indexOf('ferry');
  const ok = await t.plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { body: { target: SCENE, hunks: [{ from: at, to: at + 5, replacement: 'boat' }] } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.suggestion.by.name, 'word-frequency', 'with no manifest the plugin slug is its name');
  const bad = [
    [{ target: SCENE }, 400],
    [{ target: SCENE, text: 'a', hunks: [] }, 400],
    [{ target: SCENE, hunks: [{ from: 5, to: 2, replacement: '' }] }, 400],
    [{ target: SCENE, hunks: [{ from: 0, to: 10, replacement: 'a' }, { from: 5, to: 12, replacement: 'b' }] }, 400],
    [{ target: SCENE, hunks: [{ from: 0, to: 10 ** 7, replacement: 'a' }] }, 400],
    [{ target: SCENE, text: scene.body }, 409],
    [{ target: 'scene_01S5000000000000000000ZZZZ', text: 'x' }, 404],
    [{ target: 'book_01S5000000000000000000000A', text: 'x' }, 404],
    [{ target: SCENE, text: 'x', rationale: 5 }, 400],
    [{ target: SCENE, text: 'x', base_sha256: 'nope' }, 400],
    [{ target: SCENE, text: 'x', base_sha256: 'f'.repeat(64) }, 409],
  ];
  for (const [body, status] of bad) assert.equal((await t.plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { body })).status, status, JSON.stringify(body).slice(0, 80));
  assert.equal((await t.plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { body: '{nope', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await raw(t.port, 'POST', `/api/v1/books/${SLUG}/proposals`, { body: '{}', headers: { authorization: `Bearer ${token}` } })).status, 415, 'a body needs its content type');
});

// ---------------------------------------------------------------- acceptance 4: scope, revoked tokens, cookies

test('acceptance 4: a token for one book cannot read, list or propose to another', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const books = (await t.member('GET', '/api/books')).json;
  assert.ok(books.length >= 2, 'tidewater has several books');
  const [a, b] = books;
  const { token } = await t.grant({ permissions: ['read', 'propose'], books: [a.slug] });
  const mine = await t.plugin(token, 'GET', '/api/v1/books');
  assert.deepEqual(mine.json.books.map((x) => x.slug), [a.slug], 'the list shows only the granted book');
  assert.equal((await t.plugin(token, 'GET', `/api/v1/books/${a.slug}`)).status, 200);
  for (const p of [`/api/v1/books/${b.slug}`, `/api/v1/books/${b.id}`, `/api/v1/books/${b.slug}/search?q=a`, `/api/v1/books/${b.slug}/entries`]) {
    const r = await t.plugin(token, 'GET', p);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
  }
  assert.equal((await t.plugin(token, 'POST', `/api/v1/books/${b.slug}/proposals`, { body: { target: 'x', text: 'y' } })).status, 403);
});

test('acceptance 4: a revoked token is 401, and so is an unknown, malformed or non-bearer one', async () => {
  const t = await bootPersonal();
  const { token, grant } = await t.grant({ permissions: ['read'] });
  assert.equal((await t.plugin(token, 'GET', '/api/v1')).status, 200);
  const revoked = await t.member('DELETE', `/api/plugins/grants/${grant.id}`);
  assert.equal(revoked.status, 200);
  const r = await t.plugin(token, 'GET', '/api/v1');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'TOKEN');
  assert.equal((await t.plugin(token, 'GET', '/api/books')).status, 401, 'a revoked token is refused before anything else, even a member route');
  for (const headers of [{ authorization: 'Bearer short' }, { authorization: `Bearer ${'A'.repeat(43)}` }, { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }, { authorization: '' }, { authorization: 'Bearer' }, { authorization: `bearer ${token}` }]) {
    assert.equal((await raw(t.port, 'GET', '/api/v1', { headers })).status, 401, JSON.stringify(headers));
  }
  // the list shows it as revoked
  assert.equal((await t.member('GET', '/api/plugins')).json.grants[0].revoked, true);
});

test('acceptance 4: /api/v1 needs a bearer token: a cookie, even one holding a valid token, is never accepted, and no write happens', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'] });
  const before = await snapshot(t.root, { skipStoryforge: true });
  for (const [method, p, body] of [['GET', '/api/v1/books', undefined], ['POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: 'x' }]]) {
    const r = await raw(t.port, method, p, { body, headers: { cookie: `sf_session=${token}; sf_share=${token}`, 'content-type': 'application/json', 'x-storyforge': '1' } });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  assert.deepEqual(await snapshot(t.root, { skipStoryforge: true }), before);
});

test('the plugin request is for loopback clients with our own Host: a foreign Host is refused', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  assert.equal((await raw(t.port, 'GET', '/api/v1', { headers: { authorization: `Bearer ${token}` }, host: 'evil.example:80' })).status, 403);
});

// ---------------------------------------------------------------- acceptance 5: the integrations module

test('acceptance 5: with the integrations module off every API v1 call is 403 MODULE_OFF and nothing is written', async () => {
  const t = await bootPersonal({ profile: 'j02-modules-off' });
  const { token } = await t.grant({ permissions: ['read', 'propose', 'events'] });
  assert.equal((await t.plugin(token, 'GET', '/api/v1')).status, 200);
  const saved = await t.member('PUT', '/api/profile', { modules: { integrations: false } });
  assert.equal(saved.status, 200, saved.text);
  const before = await snapshot(t.root, { skipStoryforge: true });
  for (const [method, p, body] of [['GET', '/api/v1', undefined], ['GET', '/api/v1/books', undefined], ['GET', `/api/v1/books/${SLUG}`, undefined], ['POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: 'x' }], ['GET', '/api/v1/webhooks', undefined]]) {
    const r = await t.plugin(token, method, p, { body });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(r.json.module, 'integrations');
  }
  assert.deepEqual(await snapshot(t.root, { skipStoryforge: true }), before);
  const prefs = (await t.member('GET', '/api/preferences')).json;
  assert.ok(prefs.moduleIds.includes('integrations'));
  assert.equal(prefs.modules.integrations.on, false);
});

test('the integrations module is listed with the others, on by default', async () => {
  const t = await bootPersonal();
  const prefs = (await t.member('GET', '/api/preferences')).json;
  assert.equal(prefs.moduleIds.at(-1), 'integrations');
  assert.equal(prefs.modules.integrations.on, true);
});

// ---------------------------------------------------------------- the plugin's own webhooks (events permission)

test('events permission: a plugin subscribes for itself, sees only its own, cannot ask for content or the local network, and cannot widen its books', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const books = (await t.member('GET', '/api/books')).json;
  const [a, b] = books;
  const { token } = await t.grant({ plugin: 'hooker', permissions: ['read', 'events'], books: [a.slug] });
  const other = await t.grant({ plugin: 'other', permissions: ['events'], books: 'all' });
  const mk = (tok, body) => t.plugin(tok, 'POST', '/api/v1/webhooks', { body });
  const made = await mk(token, { url: 'http://127.0.0.1:9/hook', events: ['scene.saved'] });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.secret, /^[0-9a-f]{64}$/);
  assert.equal(made.json.webhook.plugin, 'hooker');
  assert.deepEqual(made.json.webhook.books, [a.slug], 'defaults to the granted books');
  assert.equal(made.json.webhook.include_content, false);
  assert.equal((await mk(token, { url: 'http://127.0.0.1:9/hook', events: ['scene.saved'], include_content: true })).json.code, 'CONTENT_NOT_ALLOWED');
  assert.equal((await mk(token, { url: 'http://10.0.0.5/hook', events: ['scene.saved'], allow_local: true })).json.code, 'LOCAL_NOT_ALLOWED');
  assert.equal((await mk(token, { url: 'http://127.0.0.1:9/hook', events: ['scene.saved'], books: [b.slug] })).status, 403);
  assert.equal((await mk(token, { url: 'http://127.0.0.1:9/hook', events: ['scene.saved'], books: 'all' })).status, 403);
  assert.equal((await mk(token, { url: 'http://example.com/hook', events: ['scene.saved'] })).json.code, 'REFUSED_INSECURE');
  assert.equal((await mk(token, { url: 'http://127.0.0.1:9/hook', events: ['nope'] })).status, 400);
  const mine = await t.plugin(token, 'GET', '/api/v1/webhooks');
  assert.equal(mine.json.webhooks.length, 1);
  assert.equal(mine.text.includes(made.json.secret), false, 'the secret is never shown again');
  const theirs = await mk(other.token, { url: 'http://127.0.0.1:9/other', events: ['scene.saved'] });
  assert.equal((await t.plugin(token, 'DELETE', `/api/v1/webhooks/${theirs.json.webhook.id}`)).status, 404, 'another plugin\'s subscription is not yours to revoke');
  assert.equal((await t.plugin(token, 'DELETE', `/api/v1/webhooks/${made.json.webhook.id}`)).status, 200);
  // a read-only token has no webhook routes
  const ro = await t.grant({ plugin: 'ro', permissions: ['read'] });
  assert.equal((await t.plugin(ro.token, 'GET', '/api/v1/webhooks')).status, 403);
});

// ---------------------------------------------------------------- a library: manifests

test('the scanner skips _plugins/ and a manifest problem is shown with the manifest', async () => {
  const t = await bootPersonal({ manifests: { good: MANIFEST(), newer: MANIFEST({ plugin: 'newer', id: 'note_01S8000000000000000000WF02', api: 2 }), broken: MANIFEST({ plugin: 'broken', id: 'note_01S8000000000000000000WF03', permissions: '[read, delete]' }) } });
  const books = (await t.member('GET', '/api/books')).json;
  assert.deepEqual(books.map((b) => b.slug), [SLUG], '_plugins/ is not a book');
  const list = (await t.member('GET', '/api/plugins')).json;
  const by = Object.fromEntries(list.manifests.map((m) => [m.plugin, m]));
  assert.deepEqual(by['word-frequency'].problems, []);
  assert.deepEqual(by.newer.problems.map((p) => p.code), ['W315']);
  assert.deepEqual(by.broken.problems.map((p) => `${p.code} ${p.location}`), ['E102 permissions[1]']);
});
