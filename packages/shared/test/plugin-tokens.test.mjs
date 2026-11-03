// M08-J02 security core: plugin tokens (stored as hashes, scoped, revocable) and the plugin route policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPluginTokens, SharedDataError } from '../src/index.mjs';
import { bearerOf, decidePlugin } from '../../../apps/server/src/plugin-policy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-plugin-'));
const BOOKS = { book_01S5000000000000000000000A: 'salt-orchard', book_01S5000000000000000000000B: 'low-tide' };
const slugOf = (x) => BOOKS[x] ?? (Object.values(BOOKS).includes(x) ? x : null);

test('grant: token shown once, stored only as a hash, scoped, revocable; bad grants refused', async () => {
  const dir = tmp();
  const t = await openPluginTokens(dir);
  assert.equal((await t.grant({ plugin: 'Bad Name', permissions: ['read'], books: 'all' })).ok, false);
  assert.equal((await t.grant({ plugin: 'wf', permissions: ['write'], books: 'all' })).ok, false, 'no write permission exists');
  assert.equal((await t.grant({ plugin: 'wf', permissions: [], books: 'all' })).ok, false);
  assert.equal((await t.grant({ plugin: 'wf', permissions: ['read'], books: [] })).ok, false);
  const g = await t.grant({ plugin: 'word-frequency', permissions: ['read', 'read'], books: ['salt-orchard'] });
  assert.equal(g.ok, true);
  assert.deepEqual(g.grant.permissions, ['read']);
  await t.flush();
  const onDisk = fs.readFileSync(path.join(dir, 'plugin-tokens.json'), 'utf8');
  assert.equal(onDisk.includes(g.token), false, 'the token itself is never stored');
  assert.equal(JSON.stringify(t.list()).includes('token_hash'), false, 'listing hides the hash');
  assert.equal((await t.resolve(g.token))?.plugin, 'word-frequency');
  const reopened = await openPluginTokens(dir);
  assert.equal((await reopened.resolve(g.token))?.id, g.grant.id, 'survives a restart');
  await reopened.revoke(g.grant.id);
  assert.equal(await reopened.resolve(g.token), null, 'revoked');
  assert.equal(await reopened.resolve(g.token.slice(0, -1) + (g.token.endsWith('A') ? 'B' : 'A')), null, 'tampered');
  assert.equal(await reopened.resolve(''), null);
});

test('a damaged token file stops instead of resetting', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'plugin-tokens.json'), '{"version":1,"tokens":[{"id":"x"}]}');
  await assert.rejects(openPluginTokens(dir), SharedDataError);
});

test('policy: v1 only, permission per route, granted books only, never the member API', () => {
  const read = { id: 'tok_X', plugin: 'p', permissions: ['read'], books: ['salt-orchard'], created: 0, last_used: null, revoked: false };
  const propose = { ...read, permissions: ['propose', 'read'] };
  const A = 'book_01S5000000000000000000000A';
  const B = 'book_01S5000000000000000000000B';
  const ok = (g, m, p) => decidePlugin(g, m, p, slugOf).ok;
  assert.equal(decidePlugin(null, 'GET', '/api/v1', slugOf).status, 401);
  assert.equal(ok(read, 'GET', '/api/v1'), true);
  assert.equal(ok(read, 'GET', `/api/v1/books/${A}`), true);
  assert.equal(ok(read, 'GET', '/api/v1/books/salt-orchard/scenes/scene_X'), true, 'by slug too');
  assert.equal(ok(read, 'GET', `/api/v1/books/${B}`), false, 'not granted');
  assert.equal(ok(read, 'GET', '/api/v1/books/nope'), false, 'unknown book');
  assert.equal(ok(read, 'POST', `/api/v1/books/${A}/proposals`), false, 'read cannot propose');
  assert.equal(ok(propose, 'POST', `/api/v1/books/${A}/proposals`), true);
  assert.equal(ok(propose, 'POST', `/api/v1/books/${B}/proposals`), false);
  assert.equal(ok(read, 'POST', '/api/v1/webhooks'), false, 'events permission needed');
  for (const [m, p] of [['GET', `/api/books/${A}`], ['PUT', `/api/books/${A}/scenes/scene_X/body`], ['GET', `/api/books/${A}/receipts`], ['GET', `/api/books/${A}/export`],
    ['POST', '/api/shared/invites'], ['GET', '/api/ai/profiles'], ['PUT', `/api/v1/books/${A}`], ['DELETE', `/api/v1/books/${A}/scenes/scene_X`], ['GET', `/api/v1/books/${A}/receipts`], ['GET', '/api/v10']]) {
    assert.equal(ok({ ...propose, permissions: ['events', 'propose', 'read'], books: 'all' }, m, p), false, `${m} ${p}`);
  }
  assert.equal(decidePlugin(read, 'GET', '/api/v1/books/%E0%A4%A', slugOf).status, 400, 'malformed escapes are refused');
});

test('bearerOf: absent → null; malformed → empty string (refused as an unknown token)', () => {
  assert.equal(bearerOf({ headers: {} }), null);
  assert.equal(bearerOf({ headers: { authorization: 'Bearer abc_DEF-123' } }), 'abc_DEF-123');
  assert.equal(bearerOf({ headers: { authorization: 'Basic Zm9vOmJhcg==' } }), '');
  assert.equal(bearerOf({ headers: { authorization: 'Bearer a b' } }), '');
});
