// OAuth 2.1 for the MCP service (oauth-routes.mjs): discovery (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), the owner's consent, the code
// exchange with PKCE, MCP with the access token, refresh rotation, revocation (RFC 7009 and Settings), and the refusals. Personal mode for the flow (the consent
// routes use the member write headers there), shared mode for "only the owner approves" and the public address.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { closeAll, raw } from './plugin-helpers.mjs';
import { bootPersonal } from './plugin-helpers.mjs';
import { boot as bootShared, closeAll as closeShared } from './shared-helpers.mjs';

after(async () => {
  await closeAll();
  await closeShared();
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = () => crypto.randomBytes(48).toString('base64url');
const challengeOf = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSONH = { 'content-type': 'application/json' };
const MEMBER = { 'content-type': 'application/json', 'x-storyforge': '1' };

/** Register a client as claude.ai does. */
async function register(t, extra = {}) {
  const r = await raw(t.port, 'POST', '/oauth/register', { headers: JSONH, body: { client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

/** The authorize query a client sends. */
const authorizeQuery = (client, v, extra = {}) =>
  new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 'st-123', resource: `http://127.0.0.1:${extra.port}/mcp`, ...extra.q }).toString();

/** Run the whole sign-in: register, consent (approve), exchange. Returns the tokens and what came back. */
async function connect(t, { name = 'claude', permissions = ['read', 'propose'], books = 'all' } = {}) {
  const client = await register(t);
  const v = verifier();
  const q = authorizeQuery(client, v, { port: t.port });
  const info = await raw(t.port, 'GET', `/api/oauth/request?${q}`);
  assert.equal(info.status, 200, info.text);
  const ok = await raw(t.port, 'POST', '/api/oauth/approve', { headers: MEMBER, body: { request: q, name, permissions, books } });
  assert.equal(ok.status, 200, ok.text);
  const back = new URL(ok.json.redirect);
  const tok = await raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: v, resource: `http://127.0.0.1:${t.port}/mcp` }) });
  assert.equal(tok.status, 200, tok.text);
  return { client, info: info.json, back, tokens: tok.json, grant: ok.json.grant, v, q };
}

let rpcId = 1;
const mcp = (t, token, method, params) =>
  raw(t.port, 'POST', '/mcp', { headers: { ...JSONH, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) } });

describe('discovery', () => {
  test('a 401 from /mcp names the protected resource metadata, which names this server as the authorization server', async () => {
    const t = await bootPersonal();
    const origin = `http://127.0.0.1:${t.port}`;
    const r = await mcp(t, null, 'initialize');
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], `Bearer realm="storyforge", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const m = await raw(t.port, 'GET', p);
      assert.equal(m.status, 200, p);
      assert.equal(m.json.resource, `${origin}/mcp`);
      assert.deepEqual(m.json.authorization_servers, [origin]);
      assert.equal(m.headers['access-control-allow-origin'], '*');
    }
    const as = await raw(t.port, 'GET', '/.well-known/oauth-authorization-server');
    assert.equal(as.status, 200);
    assert.equal(as.json.issuer, origin);
    assert.equal(as.json.authorization_endpoint, `${origin}/oauth/authorize`);
    assert.equal(as.json.token_endpoint, `${origin}/oauth/token`);
    assert.equal(as.json.registration_endpoint, `${origin}/oauth/register`);
    assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
    assert.ok(!as.json.scopes_supported.includes('events'));
    const pre = await raw(t.port, 'OPTIONS', '/oauth/token', { headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
  });

  test('the consent page itself is the web app (a static route), and never framed by another site', async () => {
    const webRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-oauth-web-'));
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>StoryForge</title>');
    const t = await bootPersonal({ webRoot });
    const r = await raw(t.port, 'GET', '/oauth/authorize?client_id=x');
    assert.equal(r.status, 200);
    assert.match(r.text, /StoryForge/);
    assert.equal(r.headers['x-frame-options'], 'DENY', 'never framed by another site');
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
  });
});

describe('registration', () => {
  test('https and loopback redirect URIs register; anything else is refused', async () => {
    const t = await bootPersonal();
    const c = await register(t);
    assert.match(c.client_id, /^sfc_/);
    assert.equal(c.token_endpoint_auth_method, 'none');
    assert.equal(c.client_secret, undefined);
    await register(t, { redirect_uris: ['http://127.0.0.1:33418/callback'] });
    for (const bad of [['http://evil.example/cb'], ['https://x.example/cb#frag'], ['javascript:alert(1)'], [], 'https://x.example/cb']) {
      const r = await raw(t.port, 'POST', '/oauth/register', { headers: JSONH, body: { client_name: 'X', redirect_uris: bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.error, 'invalid_redirect_uri');
    }
    const implicit = await raw(t.port, 'POST', '/oauth/register', { headers: JSONH, body: { redirect_uris: [REDIRECT], response_types: ['token'] } });
    assert.equal(implicit.status, 400);
    const formBody = await raw(t.port, 'POST', '/oauth/register', { headers: FORM, body: form({ redirect_uris: REDIRECT }) });
    assert.equal(formBody.status, 400);
  });

  test('registration is rate limited', async () => {
    const t = await bootPersonal();
    let last;
    for (let i = 0; i < 12; i++) last = await raw(t.port, 'POST', '/oauth/register', { headers: JSONH, body: { redirect_uris: [REDIRECT] } });
    assert.equal(last.status, 429);
  });
});

describe('the sign-in', () => {
  test('consent shows the app, the books and a free name; approve redirects with a code, state and iss; the code buys tokens that work on /mcp', async () => {
    const t = await bootPersonal();
    const { info, back, tokens, grant } = await connect(t);
    assert.equal(info.client.name, 'Claude');
    assert.equal(info.client.redirect_host, 'claude.ai');
    assert.equal(info.name, 'claude');
    assert.deepEqual(info.permissions.ticked, ['read', 'propose']);
    assert.ok(info.books.some((b) => b.slug === 'salt-orchard'));
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'st-123');
    assert.equal(back.searchParams.get('iss'), `http://127.0.0.1:${t.port}`);
    assert.match(tokens.access_token, /^sfat_/);
    assert.match(tokens.refresh_token, /^sfrt_/);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    assert.equal(tokens.scope, 'propose read');
    assert.equal(grant.plugin, 'mcp-claude');

    const init = await mcp(t, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0' } });
    assert.equal(init.status, 200, init.text);
    const books = await mcp(t, tokens.access_token, 'tools/call', { name: 'codex_list_books', arguments: {} });
    assert.equal(books.status, 200, books.text);
    assert.equal(books.json.result.isError, undefined, books.text);
    const names = (await mcp(t, tokens.access_token, 'tools/list')).json.result.tools.map((x) => x.name);
    assert.ok(names.includes('codex_propose_edit'), 'propose was granted');
    assert.ok(!names.includes('codex_save_canvas'), 'canvas was not');

    // the connection is an ordinary AI connection in Settings
    const list = await t.member('GET', '/api/plugins');
    assert.ok(list.json.grants.some((g) => g.id === grant.id && g.plugin === 'mcp-claude' && g.last_used !== null));
    // a second sign-in of the same app suggests a new name
    const again = await register(t);
    const info2 = await raw(t.port, 'GET', `/api/oauth/request?${authorizeQuery(again, verifier(), { port: t.port })}`);
    assert.equal(info2.json.name, 'claude-2');
  });

  test('an access token is for /mcp only: API v1 refuses it', async () => {
    const t = await bootPersonal();
    const { tokens } = await connect(t);
    const r = await raw(t.port, 'GET', '/api/v1/books', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(r.status, 401);
  });

  test('a code is spent once, and needs the right verifier, client and redirect URI', async () => {
    const t = await bootPersonal();
    const client = await register(t);
    const other = await register(t);
    const v = verifier();
    const q = authorizeQuery(client, v, { port: t.port });
    const codeOf = async () => new URL((await raw(t.port, 'POST', '/api/oauth/approve', { headers: MEMBER, body: { request: q, name: `c${crypto.randomBytes(3).toString('hex')}`, permissions: ['read'], books: 'all' } })).json.redirect).searchParams.get('code');
    const exchange = (code, o = {}) => raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: v, ...o }) });

    assert.equal((await exchange(await codeOf(), { code_verifier: verifier() })).json.error, 'invalid_grant', 'wrong verifier');
    assert.equal((await exchange(await codeOf(), { client_id: other.client_id })).json.error, 'invalid_grant', 'another client');
    assert.equal((await exchange(await codeOf(), { redirect_uri: 'https://claude.ai/other' })).json.error, 'invalid_grant', 'another redirect URI');
    assert.equal((await exchange(await codeOf(), { resource: 'https://elsewhere.example/mcp' })).json.error, 'invalid_target');
    const code = await codeOf();
    assert.equal((await exchange(code)).status, 200);
    assert.equal((await exchange(code)).json.error, 'invalid_grant', 'spent');
    assert.equal((await exchange(code, { client_id: 'sfc_nobodynobodynobodyno' })).status, 401, 'unknown client');
    assert.equal((await raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'password', client_id: client.client_id }) })).json.error, 'unsupported_grant_type');
  });

  test('a bad client or redirect URI is never redirected to; other problems go back to the app; deny sends access_denied', async () => {
    const t = await bootPersonal();
    const client = await register(t);
    const v = verifier();
    const unknown = await raw(t.port, 'GET', `/api/oauth/request?${authorizeQuery({ client_id: 'sfc_nobodynobodynobodyno' }, v, { port: t.port })}`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, 'BAD_CLIENT');
    assert.equal(unknown.json.redirect, undefined);
    const wrongBack = await raw(t.port, 'GET', `/api/oauth/request?${authorizeQuery(client, v, { port: t.port, q: { redirect_uri: 'https://evil.example/cb' } })}`);
    assert.equal(wrongBack.json.code, 'BAD_CLIENT');
    assert.equal(wrongBack.json.redirect, undefined);
    const noPkce = await raw(t.port, 'GET', `/api/oauth/request?${authorizeQuery(client, v, { port: t.port, q: { code_challenge_method: 'plain' } })}`);
    assert.equal(noPkce.json.code, 'BAD_REQUEST');
    assert.equal(new URL(noPkce.json.redirect).searchParams.get('error'), 'invalid_request');
    assert.equal(new URL(noPkce.json.redirect).searchParams.get('state'), 'st-123');

    const q = authorizeQuery(client, v, { port: t.port });
    const no = await raw(t.port, 'POST', '/api/oauth/deny', { headers: MEMBER, body: { request: q } });
    assert.equal(no.status, 200);
    const back = new URL(no.json.redirect);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
    assert.equal((await t.member('GET', '/api/plugins')).json.grants.length, 0, 'deny makes no connection');
  });

  test('approve checks the name, the permissions and the books like Settings does', async () => {
    const t = await bootPersonal();
    const client = await register(t);
    const q = authorizeQuery(client, verifier(), { port: t.port });
    const approve = (o) => raw(t.port, 'POST', '/api/oauth/approve', { headers: MEMBER, body: { request: q, name: 'claude', permissions: ['read'], books: 'all', ...o } });
    assert.equal((await approve({ name: 'Bad Name' })).status, 400);
    assert.equal((await approve({ permissions: ['propose'] })).status, 400, 'read is required');
    assert.equal((await approve({ permissions: ['read', 'events'] })).status, 400, 'no webhook events');
    assert.equal((await approve({ books: ['no-such-book'] })).json.code, 'UNKNOWN_BOOK');
    assert.equal((await approve({ books: ['salt-orchard'] })).status, 200);
    assert.equal((await approve({})).json.code, 'NAME_TAKEN');
    // without the write header the browser guard refuses it
    assert.equal((await raw(t.port, 'POST', '/api/oauth/approve', { headers: JSONH, body: { request: q, name: 'x', permissions: ['read'], books: 'all' } })).status, 403);
  });
});

describe('refresh and revocation', () => {
  test('a refresh token rotates: the new pair works, the old refresh token does not', async () => {
    const t = await bootPersonal();
    const { client, tokens } = await connect(t);
    const refresh = (rt) => raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id }) });
    const r = await refresh(tokens.refresh_token);
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.json.access_token, tokens.access_token);
    assert.equal((await mcp(t, r.json.access_token, 'tools/list')).status, 200);
    assert.equal((await refresh(tokens.refresh_token)).json.error, 'invalid_grant', 'the old refresh token is spent');
    assert.equal((await refresh(r.json.refresh_token)).status, 200);
  });

  test('revoking the connection in Settings ends its tokens at once', async () => {
    const t = await bootPersonal();
    const { client, tokens, grant } = await connect(t);
    assert.equal((await t.member('DELETE', `/api/plugins/grants/${grant.id}`)).status, 200);
    const r = await mcp(t, tokens.access_token, 'tools/list');
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /error="invalid_token"/);
    const again = await raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }) });
    assert.equal(again.json.error, 'invalid_grant');
  });

  test('the app revoking its refresh token (RFC 7009) removes the connection', async () => {
    const t = await bootPersonal();
    const { client, tokens, grant } = await connect(t);
    const r = await raw(t.port, 'POST', '/oauth/revoke', { headers: FORM, body: form({ token: tokens.refresh_token, client_id: client.client_id }) });
    assert.equal(r.status, 200);
    assert.equal((await mcp(t, tokens.access_token, 'tools/list')).status, 401);
    assert.ok((await t.member('GET', '/api/plugins')).json.grants.find((g) => g.id === grant.id).revoked);
  });

  test('a confidential client authenticates with HTTP Basic, and only that way', async () => {
    const t = await bootPersonal();
    const client = await register(t, { token_endpoint_auth_method: 'client_secret_basic' });
    assert.match(client.client_secret, /^sfcs_/);
    const v = verifier();
    const q = authorizeQuery(client, v, { port: t.port });
    const code = async () => new URL((await raw(t.port, 'POST', '/api/oauth/approve', { headers: MEMBER, body: { request: q, name: `b${crypto.randomBytes(3).toString('hex')}`, permissions: ['read'], books: 'all' } })).json.redirect).searchParams.get('code');
    const basic = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
    const noSecret = await raw(t.port, 'POST', '/oauth/token', { headers: FORM, body: form({ grant_type: 'authorization_code', code: await code(), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: v }) });
    assert.equal(noSecret.status, 401);
    const ok = await raw(t.port, 'POST', '/oauth/token', { headers: { ...FORM, authorization: basic }, body: form({ grant_type: 'authorization_code', code: await code(), redirect_uri: REDIRECT, code_verifier: v }) });
    assert.equal(ok.status, 200, ok.text);
  });
});

describe('shared mode', () => {
  test('only the owner sees the consent request and approves; the others are refused', async () => {
    const t = await bootShared();
    const r = await t.call('POST', '/oauth/register', { origin: null, guard: false, headers: JSONH, body: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] } });
    assert.equal(r.status, 201, r.text);
    const q = new URLSearchParams({ response_type: 'code', client_id: r.json.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', state: 's' }).toString();
    assert.equal((await t.call('GET', `/api/oauth/request?${q}`)).status, 401, 'signed out');
    assert.equal((await t.call('GET', `/api/oauth/request?${q}`, { cookie: t.c.editor })).status, 403, 'an editor');
    assert.equal((await t.call('POST', '/api/oauth/approve', { cookie: t.c.editor, body: { request: q, name: 'chatgpt', permissions: ['read'], books: 'all' } })).status, 403);
    assert.equal((await t.call('GET', `/api/oauth/request?${q}`, { cookie: t.c.owner })).status, 200);
    const ok = await t.call('POST', '/api/oauth/approve', { cookie: t.c.owner, body: { request: q, name: 'chatgpt', permissions: ['read'], books: 'all' } });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(new URL(ok.json.redirect).searchParams.get('code'));
    // another site cannot make the owner's browser approve: the Origin check of shared mode applies
    assert.equal((await t.call('POST', '/api/oauth/approve', { cookie: t.c.owner, origin: 'https://evil.example', body: { request: q, name: 'evil', permissions: ['read'], books: 'all' } })).status, 403);
  });
});
