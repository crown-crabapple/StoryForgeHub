// M07-J03 security core: passwords, tokens, sessions, rate limits, setup, invites, shares and the last-owner rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionTable, hashPassword, openSharedData, passwordProblem, SharedDataError, verifyPassword } from '../src/index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-shared-'));
const clock = (t = 1_800_000_000_000) => {
  const c = { t, now: () => c.t };
  return c;
};
const PW = 'correct horse battery';

async function withOwner() {
  const dir = tmp();
  const c = clock();
  const data = await openSharedData(dir, { now: c.now });
  const init = await data.initOwner('ilse', 'Ilse');
  assert.equal(init.ok, true);
  const done = await data.completeSetup(init.token, PW);
  assert.equal(done.ok, true);
  return { dir, c, data };
}

test('passwords: scrypt round trip, wrong password, tampered or absurd records never verify', async () => {
  const rec = await hashPassword(PW);
  assert.equal(rec.alg, 'scrypt');
  assert.equal(await verifyPassword(PW, rec), true);
  assert.equal(await verifyPassword('wrong password!', rec), false);
  assert.equal(await verifyPassword(PW, { ...rec, hash: rec.hash.slice(0, -2) + 'AA' }), false);
  assert.equal(await verifyPassword(PW, { ...rec, N: 1 << 24 }), false, 'an N above the bound is refused, not run');
  assert.equal(await verifyPassword(PW, null), false);
  assert.equal(await verifyPassword('', rec), false);
  assert.match(String(passwordProblem('short', 'ilse')), /at least/);
  assert.match(String(passwordProblem('ilseilseilse', 'ilseilseilse')), /user name/);
  assert.equal(passwordProblem(PW, 'ilse'), null);
});

test('setup: one owner, single-use 30-minute link, nothing works before it', async () => {
  const dir = tmp();
  const c = clock();
  const data = await openSharedData(dir, { now: c.now });
  assert.equal(data.needsOwner, true);
  const init = await data.initOwner('ilse');
  assert.equal((await data.initOwner('other')).ok, false, 'a second owner init is refused');
  assert.equal((await data.login('ilse', PW, 'a')).ok, false, 'no password yet');
  c.t += 31 * 60 * 1000;
  assert.equal((await data.completeSetup(init.token, PW)).code, 'GONE', 'expired link');
  const dir2 = tmp();
  const d2 = await openSharedData(dir2, { now: c.now });
  const i2 = await d2.initOwner('ilse');
  const [a, b] = await Promise.all([d2.completeSetup(i2.token, PW), d2.completeSetup(i2.token, 'another password 2')]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'a setup link works once, even for two requests at the same moment');
  assert.equal(d2.needsOwner, false);
  assert.equal((await d2.initOwner('ilse')).code, 'EXISTS', 'no new link once the owner has a password');
});

test('setup: a lapsed link can be reissued for the same pending owner only, and the old link stops working', async () => {
  const c = clock();
  const data = await openSharedData(tmp(), { now: c.now });
  const first = await data.initOwner('ilse');
  c.t += 31 * 60 * 1000;
  assert.equal((await data.initOwner('someone-else')).code, 'EXISTS', 'a different name cannot take over');
  const again = await data.initOwner('ilse');
  assert.equal(again.ok, true);
  assert.equal(again.reissued, true);
  assert.equal((await data.completeSetup(first.token, PW)).code, 'GONE');
  assert.equal((await data.completeSetup(again.token, PW)).ok, true);
});

test('resetOwner: only an enabled owner; clears the password and every session; the new setup link works once', async () => {
  const { data } = await withOwner();
  const owner = await data.login('ilse', PW, 'a');
  const inv = await data.createInvite({ role: 'editor', by: owner.user.id });
  await data.acceptInvite(inv.token, { username: 'tobin', display_name: 'Tobin', password: 'tobins password' });
  assert.equal((await data.resetOwner('tobin')).code, 'NOT_OWNER');
  assert.equal((await data.resetOwner('nobody')).code, 'NOT_OWNER');
  const r = await data.resetOwner('ILSE');
  assert.equal(r.ok, true);
  assert.equal(await data.resolveSession(owner.token), null, 'sessions ended');
  assert.equal((await data.login('ilse', PW, 'b')).ok, false, 'the old password is gone');
  assert.equal((await data.completeSetup(r.token, 'a brand new password')).ok, true);
  assert.equal((await data.completeSetup(r.token, 'again again again')).code, 'GONE');
  assert.equal((await data.login('ilse', 'a brand new password', 'c')).ok, true);
});

test('login: same answer for unknown user and wrong password; rate limit; sessions resolve and end', async () => {
  const { c, data } = await withOwner();
  const unknown = await data.login('nobody', PW, '10.0.0.1');
  const wrong = await data.login('ilse', 'not the password', '10.0.0.2');
  assert.deepEqual(unknown, wrong);
  const ok = await data.login('ILSE', PW, '10.0.0.3');
  assert.equal(ok.ok, true);
  assert.equal((await data.resolveSession(ok.token))?.role, 'owner');
  for (let i = 0; i < 5; i++) await data.login('ilse', 'nope nope nope', '10.0.0.4'); // the success above cleared the earlier failure
  assert.equal((await data.login('ilse', PW, '10.0.0.5')).code, 'RATE_LIMITED', '5 failures per name lock the name');
  c.t += 15 * 60 * 1000;
  assert.equal((await data.login('ilse', PW, '10.0.0.5')).ok, true, 'the window passes');
  await data.logout(ok.token);
  assert.equal(await data.resolveSession(ok.token), null);
});

test('sessions: 14 days idle, 30 days absolute, only hashes stored', async () => {
  const c = clock();
  const t = createSessionTable({ now: c.now });
  const { token } = t.create('usr_01HZZZZZZZZZZZZZZZZZZZZZZZ');
  assert.equal(JSON.stringify(t.snapshot()).includes(token), false, 'the token itself is never stored');
  c.t += 13 * 24 * 3600 * 1000;
  assert.ok(t.resolve(token).user);
  c.t += 13 * 24 * 3600 * 1000;
  assert.ok(t.resolve(token).user, 'used within 14 days: still alive');
  c.t += 5 * 24 * 3600 * 1000;
  assert.equal(t.resolve(token).user, null, 'past 30 days absolute');
  const s2 = t.create('usr_01HZZZZZZZZZZZZZZZZZZZZZZZ');
  c.t += 14 * 24 * 3600 * 1000;
  assert.equal(t.resolve(s2.token).user, null, '14 days idle');
  assert.equal(t.resolve('not-a-token').user, null);
});

test('password change and member removal end every session; the last owner is protected', async () => {
  const { data } = await withOwner();
  const owner = (await data.login('ilse', PW, 'a'));
  const inv = await data.createInvite({ role: 'editor', by: owner.user.id });
  const acc = await data.acceptInvite(inv.token, { username: 'tobin', display_name: 'Tobin', password: 'tobins password' });
  assert.equal(acc.ok, true);
  const t1 = await data.login('tobin', 'tobins password', 'b');
  const t2 = await data.login('tobin', 'tobins password', 'c');
  assert.equal((await data.changePassword(acc.user.id, 'tobins password', 'tobins new password')).ok, true);
  assert.equal(await data.resolveSession(t1.token), null);
  assert.equal(await data.resolveSession(t2.token), null);
  const t3 = await data.login('tobin', 'tobins new password', 'b');
  assert.equal((await data.removeMember(acc.user.id)).ok, true);
  assert.equal(await data.resolveSession(t3.token), null, 'removed member: session gone');
  assert.equal((await data.login('tobin', 'tobins new password', 'b')).ok, false, 'removed member cannot log in');
  assert.equal((await data.setRole(owner.user.id, 'editor')).code, 'LAST_OWNER');
  assert.equal((await data.removeMember(owner.user.id)).code, 'LAST_OWNER');
});

test('invites: role limits, expiry, revoke, single use even when accepted twice at once', async () => {
  const { c, data } = await withOwner();
  const by = (await data.login('ilse', PW, 'a')).user.id;
  assert.equal((await data.createInvite({ role: 'owner', by })).ok, false);
  assert.equal((await data.createInvite({ role: 'editor', by, expiresMs: 31 * 24 * 3600 * 1000 })).ok, false);
  const inv = await data.createInvite({ role: 'reviewer', by });
  assert.equal(JSON.stringify(data.listInvites()).includes(inv.token), false);
  const [a, b] = await Promise.all([
    data.acceptInvite(inv.token, { username: 'maren', display_name: 'Maren', password: 'marens password' }),
    data.acceptInvite(inv.token, { username: 'other', display_name: 'Other', password: 'others password' }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'one account per invite');
  const gone = await data.createInvite({ role: 'viewer', by });
  await data.revokeInvite(gone.invite.id);
  assert.equal((await data.acceptInvite(gone.token, { username: 'x-user', display_name: 'X', password: 'xxxxxxxxxxxx' })).code, 'GONE');
  const late = await data.createInvite({ role: 'viewer', by });
  c.t += 8 * 24 * 3600 * 1000;
  assert.equal((await data.acceptInvite(late.token, { username: 'y-user', display_name: 'Y', password: 'yyyyyyyyyyyy' })).code, 'GONE', '7-day default');
});

test('shares: one book, scope, expiry and revoke', async () => {
  const { c, data } = await withOwner();
  const by = (await data.login('ilse', PW, 'a')).user.id;
  const book = 'book_01S5000000000000000000000A';
  assert.equal((await data.createShare({ book, scope: ['read'], expiresMs: undefined, by })).ok, false, 'expiry required');
  assert.equal((await data.createShare({ book, scope: ['export'], expiresMs: 1000, by })).ok, false, 'read is required');
  const s = await data.createShare({ book, scope: ['read', 'export'], expiresMs: 24 * 3600 * 1000, by });
  assert.deepEqual(data.resolveShare(s.token), { kind: 'share', id: s.share.id, book, scope: ['export', 'read'] });
  c.t += 25 * 3600 * 1000;
  assert.equal(data.resolveShare(s.token), null, 'expired');
  const s2 = await data.createShare({ book, scope: ['read'], expiresMs: 24 * 3600 * 1000, by });
  await data.revokeShare(s2.share.id);
  assert.equal(data.resolveShare(s2.token), null, 'revoked');
});

test('files: secrets never stored in the clear; a damaged file stops shared mode instead of resetting', async () => {
  const { dir, data } = await withOwner();
  const login = await data.login('ilse', PW, 'a');
  await data.flush();
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.equal(all.includes(login.token), false);
  assert.equal(all.includes(PW), false);
  const reopened = await openSharedData(dir);
  assert.equal((await reopened.resolveSession(login.token))?.username, 'ilse', 'sessions survive a restart');
  fs.writeFileSync(path.join(dir, 'members.json'), '{"version":1,"members":[{"user":"x","role":"god"}]}');
  await assert.rejects(openSharedData(dir), SharedDataError);
  fs.writeFileSync(path.join(dir, 'users.json'), '{not json');
  await assert.rejects(openSharedData(dir), SharedDataError);
});
