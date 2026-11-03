// M07-J03a acceptance (contract section 8, items 1, 2, 5 and 6) through the real server: shared mode on temp folders and a copy of salt-orchard, four users
// (owner, editor, reviewer, viewer) plus share links, the route policy, the auth rules, the audit chain, and personal mode unchanged.
// Every request carries Origin and x-storyforge like the browser app does. Servers listen on 127.0.0.1 only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, createAudit, openSettings, openSharedData } from '../../../packages/shared/src/index.mjs';
import { WRITE_CLASSES, allowed, classifyRead } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { createServer } from '../src/server.mjs';
import { createSharedGate } from '../src/shared-gate.mjs';
import { SHARED_ROUTES, matchSharedRoute } from '../src/shared-routes.mjs';
import { makeHome } from './ai-helpers.mjs';
import { REPO_ROOT, close, copyFixture, listen, snapshot } from './helpers.mjs';
import { MAIN, killAll, spawnMain, waitFor } from './proc-helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const OTHER_BOOK = 'book_01S5000000000000000000000B';
const SCENE = 'scene_01S50000000000000000000002';
const DAY = 24 * 60 * 60 * 1000;
const PW = 'correct horse battery';
const SECRET_PROSE = 'ZEBRA-PROSE-NEVER-IN-AUDIT';

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
  await killAll();
});

/** One request the way the browser app sends it: Origin and the write guard on every non-GET. */
function call(port, method, pathname, { cookie, body, headers = {}, origin = `http://127.0.0.1:${port}`, guard = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}` };
    if (method !== 'GET') {
      if (origin) h.Origin = origin;
      if (guard) Object.assign(h, { 'content-type': 'application/json', 'x-storyforge': '1' });
    }
    if (cookie) h.Cookie = cookie;
    Object.assign(h, headers);
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        const setCookie = res.headers['set-cookie'] ?? [];
        resolve({ status: res.statusCode, headers: res.headers, text, json, setCookie });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** `name=value` of the cookie a response set (for the next request's Cookie header). */
const cookieOf = (r, name) => {
  const line = r.setCookie.find((c) => c.startsWith(`${name}=`));
  assert.ok(line, `no ${name} cookie in ${JSON.stringify(r.setCookie)}`);
  return line.split(';')[0];
};
const tokenOf = (link) => link.split('#token=')[1];

/**
 * A shared-mode server over a copy of salt-orchard, shared data in its own temp folder (never inside the library), a controllable clock, and - with
 * `users` - the owner (set up over HTTP) plus an editor, a reviewer and a viewer (each invited by the owner and accepted over HTTP) and two share links.
 */
async function boot({ users = true, webRoot } = {}) {
  const root = await copyFixture('valid/salt-orchard');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-data-'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const now = () => clock.now();
  const data = await openSharedData(dir, { now });
  const settings = await openSettings(dir);
  const audit = createAudit(dir, { now });
  const gate = createSharedGate({ data, publicUrl: null, bindHost: '127.0.0.1', aiForMembers: () => settings.get().ai_for_members, audit: (e) => audit.append(e) });
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  const server = createServer({ repository, webRoot, shared: { gate, data, settings, audit: (e) => audit.append(e), publicUrl: null } });
  servers.push(server);
  const port = await listen(server);
  const t = { root, dir, clock, data, settings, audit, port, repository, c: {}, call: (m, p, o) => call(port, m, p, o) };
  if (!users) return t;

  const init = await data.initOwner('ilse', 'Ilse');
  assert.equal(init.ok, true);
  const setup = await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
  assert.equal(setup.status, 200, setup.text);
  t.c.owner = cookieOf(setup, 'sf_session');
  t.users = {};
  for (const role of ['editor', 'reviewer', 'viewer']) {
    const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role } });
    assert.equal(inv.status, 201, inv.text);
    assert.match(inv.json.link, /^http:\/\/127\.0\.0\.1:\d+\/invite#token=[A-Za-z0-9_-]{43}$/);
    const acc = await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: `${role}-user`, display_name: `The ${role}`, password: PW } });
    assert.equal(acc.status, 200, acc.text);
    t.c[role] = cookieOf(acc, 'sf_session');
    t.users[role] = acc.json.user;
  }
  const mk = async (scope) => {
    const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope, expires_days: 30 } });
    assert.equal(sh.status, 201, sh.text);
    assert.match(sh.json.link, /\/s#token=/);
    const used = await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } });
    assert.equal(used.status, 200, used.text);
    return cookieOf(used, 'sf_share');
  };
  t.c.share = await mk('read');
  t.c.exportShare = await mk('export');
  return t;
}

const sceneSha = async (t) => (await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie: t.c.owner })).json.sha256;
const libSnapshot = (t) => snapshot(t.root, { skipStoryforge: true });

// Representative write request per route: [method, url, expected route name, expected class].
const ROUTES = [
  ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, 'body', 'write'],
  ['POST', `/api/books/${BOOK}/scenes`, 'create', 'write'],
  ['POST', `/api/books/${BOOK}/scenes/${SCENE}/archive`, 'archive', 'write'],
  ['POST', `/api/books/${BOOK}/scenes/${SCENE}/fields`, 'scene-fields', 'write'],
  ['POST', `/api/books/${BOOK}/chapters`, 'chapter-create', 'write'],
  ['POST', `/api/books/${BOOK}/entries`, 'entry-create', 'write'],
  ['POST', `/api/books/${BOOK}/threads`, 'thread-create', 'write'],
  ['POST', `/api/books/${BOOK}/events`, 'event-create', 'write'],
  ['POST', `/api/books/${BOOK}/notes`, 'note-create', 'write'],
  ['POST', `/api/books/${BOOK}/goal`, 'goal', 'write'],
  ['POST', `/api/books/${BOOK}/check`, 'check-scene', 'write'],
  ['POST', `/api/books/${BOOK}/receipts/flush`, 'receipts-flush', 'write'],
  ['POST', `/api/books/${BOOK}/suggestions/sug_X`, 'suggestion-decide', 'write'],
  ['POST', '/api/index/rebuild', 'index-rebuild', 'write'],
  ['POST', `/api/books/${BOOK}/ai/send`, 'ai-send', 'ai'],
  ['POST', `/api/books/${BOOK}/ai/apply`, 'ai-apply', 'ai'],
  ['POST', '/api/library/open', 'library-open', 'admin'],
  ['POST', '/api/books', 'book-create', 'admin'],
  ['POST', '/api/recover', 'recover', 'admin'],
  ['POST', `/api/books/${BOOK}/repair`, 'repair', 'admin'],
  ['POST', '/api/ai/profiles', 'ai-profile-create', 'admin'],
  ['PUT', '/api/shared/members/usr_01S5000000000000000000000A', 'shared-member-role', 'admin'],
  ['DELETE', '/api/shared/members/usr_01S5000000000000000000000A', 'shared-member-remove', 'admin'],
  ['POST', '/api/shared/invites', 'shared-invite-create', 'admin'],
  ['DELETE', '/api/shared/invites/inv_01S5000000000000000000000A', 'shared-invite-revoke', 'admin'],
  ['POST', '/api/shared/shares', 'shared-share-create', 'admin'],
  ['DELETE', '/api/shared/shares/shr_01S5000000000000000000000A', 'shared-share-revoke', 'admin'],
  ['PUT', '/api/shared/settings', 'shared-settings', 'admin'],
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8, item 1: role fixtures and the route policy
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('policy: every route matchWriteRoute / matchSharedRoute can return is classified, and every GET path classifies', async () => {
  const src = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/router.mjs'), 'utf8');
  const sharedSrc = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/shared-routes.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('export function matchWriteRoute'), src.indexOf('const isObject'));
  const named = new Set([...fn.matchAll(/route: '([a-z-]+)'/g)].map((m) => m[1]));
  for (const k of ['context', 'send', 'apply', 'discard']) if (fn.includes('`ai-${d}`') && fn.includes(`'${k}'`)) named.add(`ai-${k}`);
  assert.ok(named.size >= 60, `routes found: ${named.size}`);
  assert.ok(named.has('ai-send') && named.has('ai-discard'));
  for (const n of named) assert.ok(WRITE_CLASSES[n], `write route ${n} has no class in policy.mjs (shared mode would refuse it)`);
  for (const n of [...sharedSrc.matchAll(/route: '([a-z-]+)'/g)].map((m) => m[1])) assert.ok(WRITE_CLASSES[n] === 'admin', `shared route ${n} is admin`);
  assert.deepEqual([...SHARED_ROUTES].sort(), [...sharedSrc.matchAll(/route: '([a-z-]+)'/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort());
  for (const k of Object.keys(WRITE_CLASSES)) assert.ok(named.has(k) || SHARED_ROUTES.includes(k), `policy.mjs lists ${k}, which no router can return`);
  for (const [method, url, route, cls] of ROUTES) {
    const m = matchSharedRoute(method, url) ?? matchWriteRoute(method, url);
    assert.equal(m?.route, route, `${method} ${url}`);
    assert.equal(WRITE_CLASSES[route], cls, route);
  }
  // personal mode has no /api/shared routes through the ordinary router
  assert.equal(matchWriteRoute('POST', '/api/shared/invites'), null);

  // GET: every first segment and every book sub-route handleApi answers classifies (an unknown path is refused in shared mode)
  const api = src.slice(src.indexOf('export async function handleApi'), src.indexOf('export function matchWriteRoute') - 400);
  const firsts = new Set([...api.matchAll(/\ba === '([a-z-]+)'/g)].map((m) => m[1]));
  const subs = new Set([...api.matchAll(/\bc === '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(firsts.size >= 8 && subs.size >= 20, `found ${firsts.size} / ${subs.size}`);
  for (const a of firsts) {
    const probes = [`/api/${a}`, `/api/${a}/x`, `/api/${a}/status`, `/api/${a}/last`, `/api/${a}/recent`, `/api/${a}/profiles`];
    assert.ok(probes.some((p) => classifyRead(p) !== null), `no GET /api/${a}... classifies`);
  }
  for (const c of subs) assert.notEqual(classifyRead(`/api/books/${BOOK}/${c}`), null, c);
  assert.equal(classifyRead('/api/books/b/backup').cls, 'admin');
  assert.equal(classifyRead('/api/books/b/repair/plan').cls, 'admin');
  assert.equal(classifyRead('/api/books/b/export').cls, 'export');
  assert.equal(classifyRead('/api/recover/last').cls, 'admin');
  assert.equal(classifyRead('/api/ai/profiles').cls, 'admin');
  assert.equal(classifyRead('/api/library/recent').cls, 'admin');
  assert.equal(classifyRead('/api/shared/members').cls, 'admin');
  assert.equal(classifyRead('/api/nonsense'), null);
  assert.equal(classifyRead('/etc/passwd'), null);
});

test('policy: the class table by role (comment and suggest have no routes yet; their rule is the policy itself)', () => {
  const u = (role) => ({ kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role });
  const share = { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read'] };
  const table = {
    read: { owner: 1, editor: 1, reviewer: 1, viewer: 1 },
    comment: { owner: 1, editor: 1, reviewer: 1, viewer: 0 },
    suggest: { owner: 1, editor: 1, reviewer: 1, viewer: 0 },
    write: { owner: 1, editor: 1, reviewer: 0, viewer: 0 },
    admin: { owner: 1, editor: 0, reviewer: 0, viewer: 0 },
  };
  for (const [cls, row] of Object.entries(table)) {
    for (const [role, ok] of Object.entries(row)) assert.equal(allowed(u(role), cls, { book: BOOK }), Boolean(ok), `${role} ${cls}`);
    assert.equal(allowed(null, cls, { book: BOOK }), false, `anonymous ${cls}`);
  }
  for (const cls of ['comment', 'suggest', 'write', 'admin', 'ai']) assert.equal(allowed(share, cls, { book: BOOK }), false, `share ${cls}`);
  assert.equal(allowed(share, 'read', { book: OTHER_BOOK }), false);
  assert.equal(allowed(share, 'export', { book: BOOK }), false);
  assert.equal(allowed({ ...share, scope: ['read', 'export'] }, 'export', { book: BOOK }), true);
  assert.equal(allowed({ ...share, scope: ['read', 'export'] }, 'export', { book: OTHER_BOOK }), false);
  assert.equal(allowed(u('editor'), 'ai', { book: BOOK, aiForMembers: false }), false);
  assert.equal(allowed(u('editor'), 'ai', { book: BOOK, aiForMembers: true }), true);
  assert.equal(allowed(u('reviewer'), 'ai', { book: BOOK, aiForMembers: true }), false);
  assert.equal(allowed(u('owner'), 'ai', { book: BOOK, aiForMembers: false }), true);
  assert.equal(allowed(u('owner'), 'nonsense', { book: BOOK }), false);
});

test('roles: viewer, reviewer, share and anonymous are refused every write, editor is refused admin, and each refusal leaves every library file unchanged', async () => {
  const t = await boot();
  const before = await libSnapshot(t);
  const sha = await sceneSha(t);
  const bodyFor = (route) => (route === 'body' ? { body: `${SECRET_PROSE}\n`, base_sha256: sha } : {});
  // one request the owner could make for real, tried by everyone who must not
  for (const [who, cookie] of [['viewer', t.c.viewer], ['reviewer', t.c.reviewer], ['share', t.c.share], ['export share', t.c.exportShare], ['anonymous', undefined]]) {
    for (const [method, url, route] of ROUTES) {
      const r = await t.call(method, url, { cookie, body: bodyFor(route) });
      assert.equal(r.status, who === 'anonymous' ? 401 : 403, `${who} ${method} ${url}: ${r.text}`);
    }
  }
  for (const [method, url, route, cls] of ROUTES.filter((x) => x[3] === 'admin')) {
    const r = await t.call(method, url, { cookie: t.c.editor, body: bodyFor(route) });
    assert.equal(r.status, 403, `editor ${method} ${url} (${cls}): ${r.text}`);
  }
  // admin reads
  for (const url of ['/api/shared/members', '/api/shared/invites', '/api/shared/shares', '/api/shared/settings', '/api/ai/profiles', '/api/recover/last', '/api/library/recent', `/api/books/${BOOK}/backup`, `/api/books/${BOOK}/repair/plan`]) {
    for (const [who, cookie] of [['editor', t.c.editor], ['reviewer', t.c.reviewer], ['viewer', t.c.viewer], ['share', t.c.share]]) {
      assert.equal((await t.call('GET', url, { cookie })).status, 403, `${who} GET ${url}`);
    }
    assert.equal((await t.call('GET', url)).status, 401, `anonymous GET ${url}`);
  }
  assert.deepEqual(await libSnapshot(t), before, 'a refusal changes no library file');
  const audit = (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(audit.some((a) => a.event === 'write.body.refused' && a.result === 403 && a.target === `${BOOK}/${SCENE}`), 'refusals by signed-in people are audited');
});

test('roles: unclassified and unknown routes are refused in shared mode, even for the owner', async () => {
  const t = await boot();
  const before = await libSnapshot(t);
  assert.equal((await t.call('GET', '/api/nonsense', { cookie: t.c.owner })).status, 403);
  assert.equal((await t.call('POST', '/api/nonsense', { cookie: t.c.owner, body: {} })).status, 405);
  assert.equal((await t.call('POST', '/api/shared/everything', { cookie: t.c.owner, body: {} })).status, 405);
  assert.equal((await t.call('GET', '/api/shared/nonsense', { cookie: t.c.owner })).status, 404);
  assert.deepEqual(await libSnapshot(t), before);
});

test('roles: a share reads its own book (and exports only with the export scope) and nothing else', async () => {
  const t = await boot();
  for (const cookie of [t.c.share, t.c.exportShare]) {
    assert.equal((await t.call('GET', `/api/books/${BOOK}`, { cookie })).status, 200);
    assert.equal((await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie })).status, 200);
    assert.equal((await t.call('GET', `/api/books/${OTHER_BOOK}`, { cookie })).status, 403, 'another book');
    assert.equal((await t.call('GET', '/api/books', { cookie })).status, 403, 'the library list');
    assert.equal((await t.call('GET', '/api/library', { cookie })).status, 403);
    assert.equal((await t.call('GET', '/api/search?q=salt', { cookie })).status, 403);
    assert.equal((await t.call('GET', '/api/health', { cookie })).status, 200);
    const me = await t.call('GET', '/api/auth/me', { cookie });
    assert.deepEqual(me.json.share.book, BOOK);
    assert.equal(me.json.user, null);
  }
  assert.equal((await t.call('GET', `/api/books/${BOOK}/export?format=markdown`, { cookie: t.c.share })).status, 403, 'read-only share cannot export');
  assert.notEqual((await t.call('GET', `/api/books/${BOOK}/export?format=markdown`, { cookie: t.c.exportShare })).status, 403, 'an export share can');
  assert.equal((await t.call('GET', `/api/books/${OTHER_BOOK}/export?format=markdown`, { cookie: t.c.exportShare })).status, 403);
  // a revoked share stops at once
  const shares = (await t.call('GET', '/api/shared/shares', { cookie: t.c.owner })).json.shares;
  assert.equal(shares.length, 2);
  for (const s of shares) assert.equal((await t.call('DELETE', `/api/shared/shares/${s.id}`, { cookie: t.c.owner })).status, 200);
  assert.equal((await t.call('GET', `/api/books/${BOOK}`, { cookie: t.c.share })).status, 401);
  // a share that expired stops too
  const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope: ['read'], expires_days: 1 } });
  const used = await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } });
  const cookie = cookieOf(used, 'sf_share');
  assert.equal((await t.call('GET', `/api/books/${BOOK}`, { cookie })).status, 200);
  t.clock.t += 2 * DAY;
  assert.equal((await t.call('GET', `/api/books/${BOOK}`, { cookie })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } })).status, 410);
});

test('roles: an editor saves a scene; the owner reaches admin; AI follows the owner setting; the library file really changes', async () => {
  const t = await boot();
  const sha = await sceneSha(t);
  const r = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: `${SECRET_PROSE}\n`, base_sha256: sha } });
  assert.equal(r.status, 200, r.text);
  const scene = (await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie: t.c.viewer })).json;
  assert.equal(scene.body, `${SECRET_PROSE}\n`, 'a viewer reads what the editor saved');
  // same JSON for every role on a read
  const forOwner = (await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie: t.c.owner })).text;
  assert.equal((await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie: t.c.reviewer })).text, forOwner);
  // AI: editors only when the owner allows it
  const send = (cookie) => t.call('POST', `/api/books/${BOOK}/ai/send`, { cookie, body: {} });
  assert.equal((await send(t.c.editor)).status, 403);
  assert.notEqual((await send(t.c.owner)).status, 403);
  assert.equal((await t.call('PUT', '/api/shared/settings', { cookie: t.c.owner, body: { ai_for_members: 'yes' } })).status, 400);
  assert.equal((await t.call('PUT', '/api/shared/settings', { cookie: t.c.owner, body: { ai_for_members: true } })).status, 200);
  assert.deepEqual((await t.call('GET', '/api/shared/settings', { cookie: t.c.owner })).json, { ai_for_members: true });
  assert.notEqual((await send(t.c.editor)).status, 403);
  assert.equal((await send(t.c.reviewer)).status, 403);
  assert.equal((await send(t.c.viewer)).status, 403);
  assert.equal((await t.call('GET', '/api/shared/members', { cookie: t.c.owner })).json.members.length, 4);
  // changing a role takes effect on the next request
  const members = (await t.call('GET', '/api/shared/members', { cookie: t.c.owner })).json.members;
  const ed = members.find((m) => m.username === 'editor-user');
  assert.equal((await t.call('PUT', `/api/shared/members/${ed.user}`, { cookie: t.c.owner, body: { role: 'viewer' } })).status, 200);
  const sha2 = await sceneSha(t);
  assert.equal((await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: 'x\n', base_sha256: sha2 } })).status, 403);
  assert.equal((await t.call('PUT', `/api/shared/members/${ed.user}`, { cookie: t.c.owner, body: { role: 'wizard' } })).status, 400);
  // removing a member ends their sessions
  assert.equal((await t.call('DELETE', `/api/shared/members/${ed.user}`, { cookie: t.c.owner })).status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: t.c.editor })).json.user, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8, item 2: auth
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('auth: a wrong password and an unknown user get the same response shape', async () => {
  const t = await boot();
  const wrong = await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: 'definitely not it' } });
  const unknown = await t.call('POST', '/api/auth/login', { body: { username: 'nobody-here', password: 'definitely not it' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.text, unknown.text);
  assert.equal(wrong.setCookie.length, 0);
  assert.deepEqual(Object.keys(wrong.headers).sort(), Object.keys(unknown.headers).sort());
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ILSE', password: PW } })).status, 200, 'user names are case-insensitive');
});

test('auth: five failures per user name in 15 minutes lock that name out (429), and the window passes', async () => {
  const t = await boot();
  for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: `wrong password ${i}` } })).status, 401);
  const blocked = await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW } });
  assert.equal(blocked.status, 429, 'even the right password is refused while locked');
  assert.equal(blocked.json.code, 'RATE_LIMITED');
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW } })).status, 200, 'other names are not locked');
  t.clock.t += 16 * 60 * 1000;
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW } })).status, 200);
});

test('auth: twenty failures from one address lock that address, whatever the name', async () => {
  const t = await boot({ users: false });
  for (let i = 0; i < 20; i++) assert.equal((await t.call('POST', '/api/auth/login', { body: { username: `ghost-${i}`, password: 'wrong password' } })).status, 401, `try ${i}`);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ghost-new', password: 'wrong password' } })).status, 429);
});

test('auth: a session expires after 14 days idle, and after 30 days in all however busy', async () => {
  const t = await boot();
  const me = (cookie) => t.call('GET', '/api/auth/me', { cookie });
  const login = async () => cookieOf(await t.call('POST', '/api/auth/login', { body: { username: 'viewer-user', password: PW } }), 'sf_session');
  const idle = await login();
  assert.equal((await me(idle)).json.user.username, 'viewer-user');
  t.clock.t += SESSION_IDLE_MS - 1000;
  assert.equal((await me(idle)).json.user.username, 'viewer-user', 'just inside the idle limit (and it counts as use)');
  t.clock.t += SESSION_IDLE_MS + 1000;
  assert.equal((await me(idle)).json.user, null, 'idle for more than 14 days');

  const busy = await login();
  for (let i = 0; i < 3; i++) {
    t.clock.t += 9 * DAY; // 27 days, always in use
    assert.equal((await me(busy)).json.user.username, 'viewer-user');
  }
  t.clock.t += 4 * DAY; // 31 days since login, 4 idle
  assert.ok(31 * DAY > SESSION_ABSOLUTE_MS);
  assert.equal((await me(busy)).json.user, null, 'past the absolute limit');
  assert.equal((await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: busy, body: { body: 'x\n', base_sha256: 'a'.repeat(64) } })).status, 401);
});

test('auth: the session cookie is HttpOnly, SameSite=Strict, Path=/ and only a hash of it is stored', async () => {
  const t = await boot();
  const r = await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW } });
  const line = r.setCookie.find((c) => c.startsWith('sf_session='));
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(line.includes(flag), flag);
  assert.ok(!line.includes('Secure'), 'no Secure on plain http');
  const token = line.split(';')[0].split('=')[1];
  for (const f of ['sessions.json', 'users.json', 'invites.json', 'shares.json']) assert.ok(!(await fs.readFile(path.join(t.dir, f), 'utf8')).includes(token), `${f} holds no raw token`);
});

test('auth: logout kills the session; a password change kills every other session', async () => {
  const t = await boot();
  const login = async () => cookieOf(await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW } }), 'sf_session');
  const a = await login();
  const b = await login();
  assert.equal((await t.call('POST', '/api/auth/logout', { cookie: a, body: {} })).status, 200);
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: a })).json.user, null, 'logged out');
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: b })).json.user.username, 'editor-user', 'the other session is untouched');
  const bad = await t.call('POST', '/api/auth/password', { cookie: b, body: { current: 'not my password', next: 'a brand new password' } });
  assert.equal(bad.status, 401);
  const c = await login();
  const ok = await t.call('POST', '/api/auth/password', { cookie: b, body: { current: PW, next: 'a brand new password' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: c })).json.user, null, 'another session ended with the password change');
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: b })).json.user, null, 'and so did the old cookie of the one that changed it');
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: cookieOf(ok, 'sf_session') })).json.user.username, 'editor-user', 'the changer is signed in again');
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW } })).status, 401, 'the old password is gone');
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: 'a brand new password' } })).status, 200);
  assert.equal((await t.call('POST', '/api/auth/password', { cookie: b, body: { current: 'x', next: 'y' } })).status, 401, 'a dead cookie cannot change anything');
  assert.equal((await t.call('POST', '/api/auth/password', { body: { current: 'x', next: 'y' } })).status, 401);
});

test('auth: a write without the x-storyforge header, or with a wrong, missing or null Origin, is refused', async () => {
  const t = await boot();
  const sha = await sceneSha(t);
  const before = await libSnapshot(t);
  const body = { body: `${SECRET_PROSE}\n`, base_sha256: sha };
  const url = `/api/books/${BOOK}/scenes/${SCENE}/body`;
  const attempts = [
    ['no x-storyforge header', { guard: false, headers: { 'content-type': 'application/json' } }],
    ['no JSON content type', { headers: { 'content-type': 'text/plain' } }],
    ['another origin', { origin: 'http://evil.example' }],
    ['the same host, another port', { origin: `http://127.0.0.1:${t.port + 1}` }],
    ['no Origin', { origin: null }],
    ['Origin null', { origin: 'null' }],
  ];
  for (const [what, o] of attempts) {
    const r = await t.call('PUT', url, { cookie: t.c.owner, body, ...o });
    assert.equal(r.status, 403, `${what}: ${r.text}`);
  }
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW }, origin: 'http://evil.example' })).status, 403, 'login needs the Origin too');
  assert.equal((await t.call('GET', url.replace('/body', ''), { cookie: t.c.owner, headers: { Host: 'evil.example' } })).status, 403, 'a Host that is not ours');
  assert.deepEqual(await libSnapshot(t), before);
  assert.equal((await t.call('PUT', url, { cookie: t.c.owner, body })).status, 200, 'the same request done right works');
});

test('HEAD is answered like GET with no body (uptime monitors, curl -I), and passes no check a GET would not', async () => {
  const webRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const t = await boot({ webRoot });
  const bare = { origin: null, guard: false }; // what curl -I sends: no Origin, no write header
  for (const p of ['/', '/api/health']) {
    const get = await t.call('GET', p);
    const head = await t.call('HEAD', p, bare);
    assert.equal(head.status, 200, `HEAD ${p}: ${head.status}`);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.text, '');
  }
  assert.equal((await t.call('HEAD', `/api/books/${BOOK}/scenes/${SCENE}`, bare)).status, 401);
  assert.equal((await t.call('HEAD', `/api/books/${BOOK}/scenes/${SCENE}`, { ...bare, cookie: t.c.owner })).status, 200);
  assert.equal((await t.call('HEAD', '/', { ...bare, headers: { Host: 'evil.example' } })).status, 403);
});

test('auth: the last owner cannot be removed or demoted, an owner cannot be invited, and a second owner can step in', async () => {
  const t = await boot();
  const members = (await t.call('GET', '/api/shared/members', { cookie: t.c.owner })).json.members;
  const me = members.find((m) => m.role === 'owner');
  const demote = await t.call('PUT', `/api/shared/members/${me.user}`, { cookie: t.c.owner, body: { role: 'editor' } });
  assert.equal(demote.status, 409);
  assert.equal(demote.json.code, 'LAST_OWNER');
  assert.equal((await t.call('DELETE', `/api/shared/members/${me.user}`, { cookie: t.c.owner })).json.code, 'LAST_OWNER');
  assert.equal((await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'owner' } })).status, 400);
  const ed = members.find((m) => m.username === 'editor-user');
  assert.equal((await t.call('PUT', `/api/shared/members/${ed.user}`, { cookie: t.c.owner, body: { role: 'owner' } })).status, 200);
  assert.equal((await t.call('PUT', `/api/shared/members/${me.user}`, { cookie: t.c.editor, body: { role: 'viewer' } })).status, 200, 'the new owner may demote the first');
  assert.equal((await t.call('GET', '/api/auth/me', { cookie: t.c.owner })).json.user.role, 'viewer');
  assert.equal((await t.call('DELETE', `/api/shared/members/${ed.user}`, { cookie: t.c.editor })).json.code, 'LAST_OWNER');
});

test('auth: expired, revoked and reused invites are refused (410); an invite needs a valid user name and password', async () => {
  const t = await boot();
  const mk = async (body = { role: 'viewer' }) => (await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body })).json;
  const accept = (token, name = 'newcomer') => t.call('POST', '/api/auth/invite/accept', { body: { token, username: name, display_name: 'New', password: PW } });

  const fresh = await mk({ role: 'reviewer', expires_days: 2 });
  assert.deepEqual(Object.keys((await t.call('GET', `/api/auth/invite?token=${tokenOf(fresh.link)}`)).json).sort(), ['expires', 'role']);
  assert.equal((await accept(tokenOf(fresh.link), 'x')).status, 400, 'user name too short');
  assert.equal((await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(fresh.link), username: 'newcomer', password: 'short' } })).status, 400);
  assert.equal((await accept(tokenOf(fresh.link), 'editor-user')).status, 400, 'a taken name');
  const ok = await accept(tokenOf(fresh.link));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.role, 'reviewer');
  assert.equal((await accept(tokenOf(fresh.link), 'second-try')).status, 410, 'reused');
  assert.equal((await t.call('GET', `/api/auth/invite?token=${tokenOf(fresh.link)}`)).status, 410);

  const revoked = await mk();
  assert.equal((await t.call('DELETE', `/api/shared/invites/${revoked.invite.id}`, { cookie: t.c.owner })).status, 200);
  assert.equal((await accept(tokenOf(revoked.link), 'third-try')).status, 410, 'revoked');

  const old = await mk({ role: 'viewer', expires_days: 1 });
  t.clock.t += 2 * DAY;
  assert.equal((await accept(tokenOf(old.link), 'fourth-try')).status, 410, 'expired');
  assert.equal((await t.call('GET', '/api/auth/invite?token=nonsense')).status, 410);
  assert.equal((await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'viewer', expires_days: 31 } })).status, 400, 'at most 30 days');
  assert.equal((await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope: 'read' } })).status, 400, 'a share needs an expiry');
  assert.equal((await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope: 'read', expires_days: 91 } })).status, 400, 'at most 90 days');
  assert.equal((await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: 'nonsense', scope: 'read', expires_days: 3 } })).status, 400);
  const invites = (await t.call('GET', '/api/shared/invites', { cookie: t.c.owner })).json.invites;
  assert.ok(invites.every((i) => !('token_hash' in i) && !('token' in i)), 'no token or hash is ever listed');
});

test('auth: the owner setup link works once, only before it expires, and the setup needs a valid password', async () => {
  const t = await boot({ users: false });
  assert.equal((await t.call('GET', '/api/auth/me')).json.needs_owner, true);
  const init = await t.data.initOwner('ilse', 'Ilse');
  assert.equal((await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: 'short' } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/setup', { body: { token: 'x'.repeat(43), password: PW } })).status, 410);
  const ok = await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.role, 'owner');
  assert.equal((await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: PW } })).status, 410, 'once');
  assert.equal((await t.call('GET', '/api/auth/me')).json.needs_owner, false);
  const t2 = await boot({ users: false });
  const init2 = await t2.data.initOwner('ilse', 'Ilse');
  t2.clock.t += 31 * 60 * 1000;
  assert.equal((await t2.call('POST', '/api/auth/setup', { body: { token: init2.token, password: PW } })).status, 410, 'after 30 minutes');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8, item 5: the audit chain
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const cli = (args, { env = {}, timeout = 30000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

test('audit: the session is on the record, the chain verifies, no secret or prose is in it, and editing one line breaks it at that line', async () => {
  const t = await boot();
  const sha = await sceneSha(t);
  await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: `${SECRET_PROSE}\n`, base_sha256: sha } });
  await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.viewer, body: { body: 'no\n', base_sha256: sha } });
  await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: 'a wrong password' } });
  await t.call('POST', '/api/auth/logout', { cookie: t.c.viewer, body: {} });
  const members = (await t.call('GET', '/api/shared/members', { cookie: t.c.owner })).json.members;
  await t.call('PUT', `/api/shared/members/${members.find((m) => m.username === 'reviewer-user').user}`, { cookie: t.c.owner, body: { role: 'viewer' } });
  const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'viewer' } });
  await t.call('DELETE', `/api/shared/invites/${inv.json.invite.id}`, { cookie: t.c.owner });
  await t.call('PUT', '/api/shared/settings', { cookie: t.c.owner, body: { ai_for_members: true } });

  const file = path.join(t.dir, 'audit.jsonl');
  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  const events = lines.map((l) => l.event);
  for (const e of ['setup.complete', 'invite.create', 'invite.accept', 'share.create', 'share.used', 'login.fail', 'logout', 'member.role', 'invite.revoke', 'settings.update', 'write.body', 'write.body.refused']) {
    assert.ok(events.includes(e), `event ${e} in ${events.join(' ')}`);
  }
  const saved = lines.find((l) => l.event === 'write.body');
  assert.equal(saved.actor, t.users.editor.id);
  assert.equal(saved.target, `${BOOK}/${SCENE}`);
  assert.equal(saved.result, 200);
  assert.match(saved.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(lines[0].prev, '0'.repeat(64));
  lines.forEach((l, i) => assert.equal(l.seq, i + 1));
  assert.ok(lines.every((l) => Object.keys(l).every((k) => ['seq', 'at', 'actor', 'event', 'target', 'ip', 'result', 'prev'].includes(k))));
  assert.ok(!text.includes(SECRET_PROSE), 'no manuscript text');
  assert.ok(!text.includes(PW) && !text.includes('a wrong password'), 'no password');
  for (const c of Object.values(t.c)) assert.ok(!text.includes(c.split('=')[1]), 'no session or share token');

  assert.deepEqual(await t.audit.verify(), { ok: true, lines: lines.length });
  const good = await cli(['audit', 'verify', '--shared-data', t.dir]);
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /chain is intact/);

  // change one line (the editor's save looks like a viewer's), keep the file otherwise identical
  const raw = text.split('\n');
  const i = lines.findIndex((l) => l.event === 'write.body');
  raw[i] = raw[i].replace('"result":200', '"result":403');
  assert.notEqual(raw[i], text.split('\n')[i]);
  await fs.writeFile(file, raw.join('\n'));
  const bad = await cli(['audit', 'verify', '--shared-data', t.dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, new RegExp(`AUDIT_CHAIN_BROKEN at line ${i + 1}\\b`), bad.stderr);

  // remove a whole line: the chain breaks at the gap
  const without = text.split('\n');
  without.splice(3, 1);
  await fs.writeFile(file, without.join('\n'));
  const gap = await cli(['audit', 'verify', '--shared-data', t.dir]);
  assert.equal(gap.code, 1);
  assert.match(gap.stderr, /AUDIT_CHAIN_BROKEN at line \d+/);

  // a cut-off last line is reported as such
  await fs.writeFile(file, text.slice(0, -15));
  const cut = await cli(['audit', 'verify', '--shared-data', t.dir]);
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /AUDIT_TAIL_TRUNCATED/);
});

test('audit: concurrent requests keep one unbroken chain', async () => {
  const t = await boot();
  const sha = await sceneSha(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: i % 2 ? t.c.viewer : t.c.reviewer, body: { body: 'x\n', base_sha256: sha } })));
  const v = await t.audit.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.lines >= 12 + 8);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8, item 6 and section 1: personal mode unchanged, and the command line
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('personal mode: no auth routes, no shared routes, no policy, and the same writes work with no login', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const server = createServer({ repository: createFsRepository(root, { watch: false, pollMs: 0 }) });
  servers.push(server);
  const port = await listen(server);
  const get = (p) => call(port, 'GET', p);
  assert.equal((await get('/api/auth/me')).status, 404, 'the web app reads 404 as: personal mode');
  assert.equal((await call(port, 'POST', '/api/auth/login', { body: { username: 'a', password: 'b' } })).status, 405);
  assert.equal((await get('/api/shared/members')).status, 404);
  assert.equal((await call(port, 'POST', '/api/shared/invites', { body: { role: 'viewer' } })).status, 405);
  assert.equal((await call(port, 'PUT', '/api/shared/settings', { body: { ai_for_members: true } })).status, 405);
  const scene = (await get(`/api/books/${BOOK}/scenes/${SCENE}`)).json;
  const r = await call(port, 'PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { origin: null, body: { body: 'personal\n', base_sha256: scene.sha256 } });
  assert.equal(r.status, 200, 'no Origin and no login needed in personal mode');
  assert.equal((await call(port, 'GET', '/api/library', { headers: { Host: 'evil.example' } })).status, 403, 'the loopback Host guard is unchanged');
});

test('personal mode: serve refuses --host other than 127.0.0.1 and the shared-only flags without --shared (exit 2); nothing is created', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const before = await snapshot(root);
  for (const extra of [['--host', '0.0.0.0'], ['--host', '::1'], ['--host=192.0.2.7'], ['--public-url', 'https://example.org'], ['--shared-data', path.join(os.tmpdir(), 'sf-nope')]]) {
    const r = await cli(['--library', root, '--port', '0', ...extra]);
    assert.equal(r.code, 2, `${extra.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /--host|only works with --shared/);
  }
  assert.deepEqual(await snapshot(root), before, 'no lock file, no shared data');
});

test('personal mode: a running serve answers on 127.0.0.1 and has no auth routes', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const proc = spawnMain(['--library', root, '--port', '0']);
  const m = await waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.stdout()), { what: 'ready line' });
  const port = Number(m[1]);
  assert.equal((await call(port, 'GET', '/api/auth/me')).status, 404);
  assert.equal((await call(port, 'GET', '/api/health')).status, 200);
  assert.ok(!/Shared mode/.test(proc.output()));
  await proc.stop();
});

test('shared CLI: init prints the setup link, serve --shared refuses a missing owner, a damaged file, and a folder inside the library (exit 2); the whole flow works', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const home = await makeHome();
  const env = home.env;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-cli-'));
  const lib = ['--library', root];
  const before = await snapshot(root);

  const noOwner = await cli(['serve', ...lib, '--port', '0', '--shared', '--shared-data', dir], { env });
  assert.equal(noOwner.code, 2);
  assert.match(noOwner.stderr, /shared init --owner/);
  const inside = await cli(['serve', ...lib, '--port', '0', '--shared', '--shared-data', path.join(root, 'accounts')], { env });
  assert.equal(inside.code, 2);
  assert.match(inside.stderr, /must not be inside the library/);
  assert.equal((await cli(['shared', 'init', '--owner', 'ilse', ...lib, '--shared-data', path.join(root, 'accounts')], { env })).code, 2);
  assert.equal((await cli(['shared', 'init', ...lib, '--shared-data', dir], { env })).code, 2, 'needs --owner');
  assert.equal((await cli(['shared', 'init', '--owner', 'A', ...lib, '--shared-data', dir], { env })).code, 2, 'bad user name');

  const init = await cli(['shared', 'init', '--owner', 'ilse', ...lib, '--shared-data', dir, '--port', '4999'], { env });
  assert.equal(init.code, 0, init.stderr);
  const link = /(http:\/\/127\.0\.0\.1:4999\/setup#token=([A-Za-z0-9_-]{43}))/.exec(init.stdout);
  assert.ok(link, init.stdout);
  assert.ok(!(await fs.readFile(path.join(dir, 'setup.json'), 'utf8')).includes(link[2]), 'only the hash of the setup token is stored');
  const withUrl = await cli(['shared', 'init', '--owner', 'other', ...lib, '--shared-data', dir, '--public-url', 'https://write.example.org/ignored/path'], { env });
  assert.equal(withUrl.code, 1, 'a second owner init is refused');
  assert.match(withUrl.stderr, /already has an owner/);
  assert.equal((await cli(['shared', 'init', '--owner', 'other', ...lib, '--shared-data', dir, '--public-url', 'ftp://x'], { env })).code, 2);

  // a default shared-data folder lives in the config folder, named by the library hash, never in the library
  const dflt = await cli(['shared', 'init', '--owner', 'ilse', ...lib, '--public-url', 'https://write.example.org'], { env });
  assert.equal(dflt.code, 0, dflt.stderr);
  assert.match(dflt.stdout, /https:\/\/write\.example\.org\/setup#token=/);
  const shared = path.join(home.configDir, 'shared');
  const [hash] = await fs.readdir(shared);
  assert.match(hash, /^[0-9a-f]{16}$/);

  // serve --shared: the owner finishes setup in the browser flow, logs in, and the audit log verifies from the CLI
  const proc = spawnMain([...lib, '--port', '0', '--shared', '--shared-data', dir]);
  const m = await waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.stdout()), { what: 'ready line' });
  const port = Number(m[1]);
  assert.match(proc.stdout(), /Shared mode/);
  const me = await call(port, 'GET', '/api/auth/me');
  assert.deepEqual(me.json, { mode: 'shared', user: null, share: null, needs_owner: true });
  assert.equal((await call(port, 'GET', '/api/books')).status, 401);
  const done = await call(port, 'POST', '/api/auth/setup', { body: { token: link[2], password: PW } });
  assert.equal(done.status, 200, done.text);
  const cookie = cookieOf(done, 'sf_session');
  const books = await call(port, 'GET', '/api/books', { cookie });
  assert.equal(books.status, 200);
  assert.ok(books.json.length >= 1);
  await proc.stop();
  const verify = await cli(['audit', 'verify', '--shared-data', dir]);
  assert.equal(verify.code, 0, verify.stderr);
  const byLibrary = await cli(['audit', 'verify', ...lib], { env });
  assert.equal(byLibrary.code, 0, 'by library: the default folder, which was never started, has no events yet');

  // a damaged shared-data file stops the server (exit 2) and is left exactly as it was
  const users = path.join(dir, 'users.json');
  await fs.writeFile(users, '{ this is not json');
  const broken = await cli(['serve', ...lib, '--port', '0', '--shared', '--shared-data', dir], { env });
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /users\.json/);
  assert.equal(await fs.readFile(users, 'utf8'), '{ this is not json', 'never reset');
  assert.equal((await cli(['audit', 'verify'], { env })).code, 2, 'no library and no folder: usage');
  assert.deepEqual(Object.keys(await snapshot(root)).filter((k) => !before[k] && !k.startsWith('.storyforge')), [], 'serving adds only its own index and lock to the library: no accounts, no audit');
});

test('shared CLI: the default shared-data folder is named by the library path hash', async () => {
  const { defaultSharedDir, sharedDirProblem } = await import('../src/shared-cli.mjs');
  const a = defaultSharedDir('/some/library');
  assert.match(path.basename(a), /^[0-9a-f]{16}$/);
  assert.notEqual(a, defaultSharedDir('/some/other'));
  assert.equal(a, defaultSharedDir('/some/library/'));
  assert.ok(sharedDirProblem('/some/library/accounts', '/some/library'));
  assert.ok(sharedDirProblem('/some/library', '/some/library'));
  assert.equal(sharedDirProblem('/some/library-accounts', '/some/library'), null);
});
