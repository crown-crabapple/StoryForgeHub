// M08-J02 in shared mode (contract section 2): only the owner grants tokens and webhooks; a plugin token is not a member; every plugin call is audited
// (`plugin.<route>`, token id, result); the Host check still applies and the Origin and write-header checks do not; cookies and bearer tokens never stand in for each other.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { snapshot } from './helpers.mjs';
import { BOOK, SCENE, boot, closeAll } from './shared-helpers.mjs';
import { raw } from './plugin-helpers.mjs';

after(closeAll);

let t;
before(async () => {
  t = await boot();
});

const auditLines = async () => (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const SLUG = 'salt-orchard';
/** A plugin request: a bearer token, nothing else (no cookie, no Origin, no write header). */
const plugin = (token, method, p, body, extra = {}) =>
  raw(t.port, method, p, { body, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra } });
const grant = async (body = { plugin: 'sharer', permissions: ['read', 'propose', 'events'], books: 'all' }) => {
  const r = await t.call('POST', '/api/plugins/grants', { cookie: t.c.owner, body });
  assert.equal(r.status, 201, r.text);
  return r.json;
};

test('only the owner grants, lists and revokes plugin tokens and webhooks; everyone else is refused and nothing is stored', async () => {
  const body = { plugin: 'sharer', permissions: ['read'], books: 'all' };
  for (const role of ['editor', 'editor2', 'reviewer', 'viewer', 'share', 'exportShare']) {
    for (const [method, p, b] of [['POST', '/api/plugins/grants', body], ['GET', '/api/plugins', undefined], ['DELETE', '/api/plugins/grants/tok_ABC', undefined], ['POST', '/api/webhooks', { url: 'http://127.0.0.1:9/', events: ['scene.saved'], books: 'all' }], ['GET', '/api/webhooks', undefined], ['DELETE', '/api/webhooks/whk_ABC', undefined]]) {
      const r = await t.call(method, p, { cookie: t.c[role], body: b });
      assert.equal(r.status, 403, `${role} ${method} ${p}`);
    }
  }
  for (const [method, p, b] of [['POST', '/api/plugins/grants', body], ['GET', '/api/plugins', undefined], ['POST', '/api/webhooks', { url: 'http://127.0.0.1:9/', events: ['scene.saved'], books: 'all' }]]) {
    const r = await t.call(method, p, { body: b });
    assert.ok([401, 403].includes(r.status), `anonymous ${method} ${p}: ${r.status}`);
  }
  await assert.rejects(fs.readFile(path.join(t.dir, 'plugin-tokens.json')), /ENOENT/, 'nothing was stored by the refused calls');
  await assert.rejects(fs.readFile(path.join(t.dir, 'webhooks.json')), /ENOENT/);
});

test('the owner grants: the token is kept in the shared-data folder (hash only), the call is audited, and the audit never holds the token', async () => {
  const { token, grant: g } = await grant();
  const stored = await fs.readFile(path.join(t.dir, 'plugin-tokens.json'), 'utf8');
  assert.equal(stored.includes(token), false);
  assert.match(stored, new RegExp(g.id));
  const lines = await auditLines();
  const line = lines.findLast((l) => l.event === 'admin.plugin-grant');
  assert.ok(line, 'admin.plugin-grant is in the audit');
  assert.equal(line.actor, t.users.owner.id);
  assert.equal(line.result, 201);
  assert.equal(JSON.stringify(lines).includes(token), false);
  const listed = await t.call('GET', '/api/plugins', { cookie: t.c.owner });
  assert.equal(listed.status, 200);
  assert.equal(listed.text.includes(token), false);
  const hook = await t.call('POST', '/api/webhooks', { cookie: t.c.owner, body: { url: 'http://127.0.0.1:9/', events: ['scene.saved'], books: 'all' } });
  assert.equal(hook.status, 201, hook.text);
  assert.ok((await auditLines()).some((l) => l.event === 'admin.webhook-create' && l.result === 201));
  assert.equal(JSON.stringify(await auditLines()).includes(hook.json.secret), false, 'the audit never holds a webhook secret');
  assert.equal((await t.call('DELETE', `/api/webhooks/${hook.json.webhook.id}`, { cookie: t.c.owner })).status, 200);
  assert.equal((await t.call('DELETE', `/api/plugins/grants/${g.id}`, { cookie: t.c.owner })).status, 200);
  assert.equal((await plugin(token, 'GET', '/api/v1')).status, 401, 'revoked in shared mode too');
});

test('every plugin call is audited with its route, the token id and the result: reads, a proposal, refusals and an unknown token', async () => {
  const { token, grant: g } = await grant({ plugin: 'auditee', permissions: ['read', 'propose'], books: 'all' });
  const before = (await auditLines()).length;
  const scene = (await plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/${SCENE}`)).json;
  assert.equal((await plugin(token, 'GET', '/api/v1/books')).status, 200);
  assert.equal((await plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: scene.body.replace('ferry', 'raft') })).status, 201);
  assert.equal((await plugin(token, 'GET', `/api/books/${BOOK}`)).status, 403);
  assert.equal((await plugin(token, 'PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'x', base_sha256: scene.sha256 })).status, 403);
  assert.equal((await plugin('A'.repeat(43), 'GET', '/api/v1')).status, 401);
  const lines = (await auditLines()).slice(before);
  const mine = lines.filter((l) => l.actor === g.id);
  assert.deepEqual(mine.map((l) => [l.event, l.result]), [['plugin.scene', 200], ['plugin.books', 200], ['plugin.proposals', 201], ['plugin.other', 403], ['plugin.other', 403]]);
  assert.ok(mine[0].target.startsWith(SLUG), 'the target names the book and scene');
  const unknown = lines.find((l) => l.actor === 'plugin:unknown');
  assert.equal(unknown.event, 'plugin.root');
  assert.equal(unknown.result, 401);
  assert.ok(unknown.ip, 'an unknown token is audited with the address it came from');
  assert.equal(JSON.stringify(lines).includes(token), false);
  // the proposal is by the plugin, not by any person
  const sugg = (await t.call('GET', `/api/books/${BOOK}/suggestions?state=open`, { cookie: t.c.owner })).json.suggestions.find((s) => s.plugin === 'auditee');
  assert.equal(sugg.source, 'plugin');
  assert.deepEqual(sugg.by, { name: 'auditee' });
});

test('a plugin token is not a member: no member route, admin route or share route answers it, even with a role-holder\'s Host and headers', async () => {
  const { token } = await grant({ plugin: 'nonmember', permissions: ['read', 'propose', 'events'], books: 'all' });
  const before = await snapshot(t.root, { skipStoryforge: true });
  for (const [method, p, body] of [['GET', `/api/books/${BOOK}`, undefined], ['GET', '/api/shared/members', undefined], ['POST', '/api/shared/invites', { role: 'owner' }], ['POST', '/api/plugins/grants', { plugin: 'x', permissions: ['read'], books: 'all' }], ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'x', base_sha256: 'a'.repeat(64) }], ['GET', '/api/auth/me', undefined]]) {
    const r = await plugin(token, method, p, body, method === 'GET' ? {} : { 'x-storyforge': '1', origin: `http://127.0.0.1:${t.port}` });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
  }
  assert.deepEqual(await snapshot(t.root, { skipStoryforge: true }), before);
});

test('the Host check still applies to a bearer request; the Origin and write-header checks do not', async () => {
  const { token } = await grant({ plugin: 'hostcheck', permissions: ['read', 'propose'], books: 'all' });
  const wrongHost = await raw(t.port, 'GET', '/api/v1', { headers: { authorization: `Bearer ${token}` }, host: 'evil.example:80' });
  assert.equal(wrongHost.status, 403);
  // a hostile page's Origin on a bearer write changes nothing: bearer requests carry no cookie, so there is no ambient authority to protect
  const scene = (await plugin(token, 'GET', `/api/v1/books/${SLUG}/scenes/${SCENE}`)).json;
  const withOrigin = await plugin(token, 'POST', `/api/v1/books/${SLUG}/proposals`, { target: SCENE, text: scene.body.replace('ferry', 'barge') }, { origin: 'http://evil.example' });
  assert.equal(withOrigin.status, 201, withOrigin.text);
});

test('a token is never accepted as a cookie, and a cookie is never accepted on /api/v1: the owner\'s session adds nothing to a plugin call', async () => {
  const { token } = await grant({ plugin: 'cookies', permissions: ['read'], books: 'all' });
  const before = await snapshot(t.root, { skipStoryforge: true });
  // the token in the cookies the app uses
  for (const name of ['sf_session', 'sf_share']) {
    const member = await t.call('GET', `/api/books/${BOOK}`, { cookie: `${name}=${token}` });
    assert.ok([401, 403].includes(member.status), `${name}: ${member.status}`);
    const v1 = await t.call('GET', '/api/v1/books', { cookie: `${name}=${token}` });
    assert.equal(v1.status, 401, `${name} on /api/v1`);
  }
  // the owner's cookie on /api/v1 with no bearer: refused, GET or write, nothing written
  assert.equal((await t.call('GET', '/api/v1/books', { cookie: t.c.owner })).status, 401);
  const noBearer = await t.call('POST', `/api/v1/books/${SLUG}/proposals`, { cookie: t.c.owner, body: { target: SCENE, text: 'x' } });
  assert.equal(noBearer.status, 401);
  // the owner's cookie WITH a read-only bearer: the bearer decides, so a write is refused (the cookie is never read)
  const both = await t.call('POST', `/api/v1/books/${SLUG}/proposals`, { cookie: t.c.owner, body: { target: SCENE, text: 'x' }, headers: { authorization: `Bearer ${token}` } });
  assert.equal(both.status, 403);
  assert.equal(both.json.code, 'PLUGIN_SCOPE');
  const member = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.owner, body: { body: 'x', base_sha256: 'a'.repeat(64) }, headers: { authorization: `Bearer ${token}` } });
  assert.equal(member.status, 403, 'a bearer header turns the request into a plugin request, whatever cookie came with it');
  assert.deepEqual(await snapshot(t.root, { skipStoryforge: true }), before);
});
