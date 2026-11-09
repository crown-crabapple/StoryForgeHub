// OAuth store (oauth.mjs): only hashes on disk, expiry of codes and tokens, a damaged file is never reset, and the client list stays bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCESS_TTL_MS, CODE_TTL_MS, MAX_CLIENTS, REFRESH_TTL_MS, SharedDataError, openOAuth } from '../src/index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-oauth-'));
const GRANT = 'tok_0123456789ABCDEFGHJKMNPQRS';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

test('secrets are stored only as hashes, and survive a reopen', async () => {
  const dir = tmp();
  const o = await openOAuth(dir);
  const c = await o.register({ name: 'Claude', redirect_uris: [REDIRECT], auth_method: 'client_secret_post' });
  assert.equal(c.ok, true);
  const pair = await o.issue(c.client.id, GRANT);
  await o.flush();
  const disk = fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8');
  for (const secret of [c.secret, pair.access_token, pair.refresh_token]) assert.ok(!disk.includes(secret));
  const again = await openOAuth(dir);
  assert.deepEqual(again.resolveAccess(pair.access_token), { grant: GRANT, client: c.client.id });
  assert.ok(again.authenticate(c.client.id, c.secret, 'client_secret_post'));
  assert.equal(again.authenticate(c.client.id, c.secret, 'client_secret_basic'), null, 'only the registered method');
  assert.equal(again.authenticate(c.client.id, undefined, 'none'), null);
});

test('codes, access tokens and refresh tokens expire', async () => {
  let clock = 1_000_000;
  const o = await openOAuth(tmp(), { now: () => clock });
  const c = await o.register({ name: 'X', redirect_uris: [REDIRECT] });
  const { verifier, challenge } = pkce();
  const code = o.issueCode({ client: c.client.id, redirect_uri: REDIRECT, explicit: true, challenge, grant: GRANT, resource: 'https://a/mcp', scope: 'read' });
  clock += CODE_TTL_MS;
  assert.equal(o.takeCode({ code, client: c.client.id, redirect_uri: REDIRECT, verifier }).ok, false);
  const pair = await o.issue(c.client.id, GRANT);
  clock += ACCESS_TTL_MS - 1;
  assert.ok(o.resolveAccess(pair.access_token));
  clock += 1;
  assert.equal(o.resolveAccess(pair.access_token), null);
  clock += REFRESH_TTL_MS;
  assert.equal((await o.refresh(pair.refresh_token, c.client.id, async () => true)).ok, false);
});

test('a damaged file throws and is left as it is', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'oauth.json'), '{"version":1,"clients":[{"id":"nope"}],"tokens":[]}');
  await assert.rejects(openOAuth(dir), SharedDataError);
  assert.match(fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8'), /nope/);
});

test('the client list is bounded: a client with no live token makes room, otherwise registration waits', async () => {
  const o = await openOAuth(tmp());
  const first = await o.register({ name: 'first', redirect_uris: [REDIRECT] });
  for (let i = 1; i < MAX_CLIENTS; i++) await o.issue((await o.register({ name: `c${i}`, redirect_uris: [REDIRECT] })).client.id, GRANT);
  const next = await o.register({ name: 'next', redirect_uris: [REDIRECT] });
  assert.equal(next.ok, true);
  assert.equal(o.client(first.client.id), null, 'the unused client was forgotten');
  await o.issue(next.client.id, GRANT);
  assert.equal((await o.register({ name: 'full', redirect_uris: [REDIRECT] })).ok, false);
});
