// M08-J01 contract section 5.2: `shared reset-owner --owner <name>` (operator recovery for a lost owner password).
// Real processes, loopback only: the CLI refuses while the library is locked and for a non-owner, clears the owner's password and every session,
// prints a setup link that works once, and writes `owner.reset` to the audit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFixture } from './helpers.mjs';
import { killAll, runCli, spawnMain, waitFor } from './proc-helpers.mjs';
import { PW, call, cookieOf } from './shared-helpers.mjs';

after(killAll);

const tokenOf = (text) => /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

async function start(lib, dir) {
  const proc = spawnMain(['--library', lib, '--port', '0', '--shared', '--shared-data', dir]);
  const m = await waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.stdout()), { what: 'ready line' });
  return { proc, port: Number(m[1]) };
}

test('shared reset-owner: refused while the library is locked and for a non-owner; clears password and sessions; the setup link works once; owner.reset is audited', async () => {
  const lib = await copyFixture('valid/salt-orchard');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-reset-owner-'));
  const args = (owner, extra = []) => ['shared', 'reset-owner', '--owner', owner, '--library', lib, '--shared-data', dir, '--public-url', 'https://write.example.org', ...extra];

  const init = await runCli(['shared', 'init', '--owner', 'ilse', '--library', lib, '--shared-data', dir]);
  assert.equal(init.code, 0, init.output);

  // owner sets a password; a second member exists
  let s = await start(lib, dir);
  const setup = await call(s.port, 'POST', '/api/auth/setup', { body: { token: tokenOf(init.stdout), password: PW } });
  assert.equal(setup.status, 200, setup.text);
  const ownerCookie = cookieOf(setup, 'sf_session');
  const login2 = await call(s.port, 'POST', '/api/auth/login', { body: { username: 'ilse', password: PW } });
  const secondCookie = cookieOf(login2, 'sf_session');
  const inv = await call(s.port, 'POST', '/api/shared/invites', { cookie: ownerCookie, body: { role: 'editor' } });
  assert.equal(inv.status, 201, inv.text);
  const acc = await call(s.port, 'POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: 'writer', display_name: 'Writer', password: PW } });
  assert.equal(acc.status, 200, acc.text);

  // 1. the server is running: the library is locked, so nothing changes
  const locked = await runCli(args('ilse'));
  assert.equal(locked.code, 3, locked.output);
  assert.match(locked.stderr, /stop it first/);
  assert.equal((await call(s.port, 'GET', '/api/auth/me', { cookie: ownerCookie })).json.user?.username, 'ilse', 'the owner is still signed in');
  await s.proc.stop();

  // 2. a non-owner (and an unknown name) is refused, nothing changes
  const before = await fs.readFile(path.join(dir, 'users.json'), 'utf8');
  for (const name of ['writer', 'nobody']) {
    const r = await runCli(args(name));
    assert.equal(r.code, 1, r.output);
    assert.match(r.stderr, /no enabled owner has that user name/);
    assert.equal(tokenOf(r.stdout), undefined, 'no link for a non-owner');
  }
  assert.equal((await runCli(['shared', 'reset-owner', '--library', lib, '--shared-data', dir])).code, 2, 'needs --owner');
  assert.equal(await fs.readFile(path.join(dir, 'users.json'), 'utf8'), before);

  // 3. the owner is reset: a link is printed
  const reset = await runCli(args('ilse'));
  assert.equal(reset.code, 0, reset.output);
  assert.match(reset.stdout, /https:\/\/write\.example\.org\/setup#token=/);
  const token = tokenOf(reset.stdout);
  assert.ok(token);
  assert.ok(!(await fs.readFile(path.join(dir, 'setup.json'), 'utf8')).includes(token), 'only the hash of the token is stored');
  assert.ok(!(await fs.readFile(path.join(dir, 'users.json'), 'utf8')).includes('"pw":{'), 'no stored password for the owner');

  // 4. restart: the old sessions are gone, the old password no longer logs in, the new link sets a new password once
  s = await start(lib, dir);
  assert.equal((await call(s.port, 'GET', '/api/auth/me', { cookie: ownerCookie })).json.user, null, 'old session');
  assert.equal((await call(s.port, 'GET', '/api/auth/me', { cookie: secondCookie })).json.user, null, 'second session');
  assert.equal((await call(s.port, 'POST', '/api/auth/login', { body: { username: 'ilse', password: PW } })).status, 401, 'old password');
  const NEW = 'a different long passphrase';
  const done = await call(s.port, 'POST', '/api/auth/setup', { body: { token, password: NEW } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await call(s.port, 'POST', '/api/auth/setup', { body: { token, password: NEW } })).status, 410, 'the link works once');
  assert.equal((await call(s.port, 'POST', '/api/auth/login', { body: { username: 'ilse', password: NEW } })).status, 200, 'new password');
  assert.equal((await call(s.port, 'POST', '/api/auth/login', { body: { username: 'writer', password: PW } })).status, 200, 'the other member is untouched');
  await s.proc.stop();

  // 5. the audit names the reset, and the chain is intact
  const audit = (await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const resets = audit.filter((e) => e.event === 'owner.reset');
  assert.equal(resets.length, 1);
  assert.equal(resets[0].target, 'ilse');
  assert.equal((await runCli(['audit', 'verify', '--shared-data', dir])).code, 0);
});

test('shared reset-owner is listed in the help', async () => {
  const help = await runCli(['--help']);
  assert.match(help.stdout, /^ {2}shared reset-owner /m);
});
