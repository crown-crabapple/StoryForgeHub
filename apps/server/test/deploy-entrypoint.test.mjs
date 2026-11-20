// M08-J01 contract section 5.1: deploy/entrypoint.mjs, spawned with the environment the container sets, on temp folders for /library, /config and
// /shared-data and a copy of the salt-orchard fixture as the library (the host is overridden to 127.0.0.1; no Docker, nothing else is bound).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkOwner, planStart } from '../../../deploy/entrypoint.mjs';
import { closeAll, freshDatabaseUrl, HOSTED, importInto, tempDir } from './db-helpers.mjs';
import { REPO_ROOT } from './helpers.mjs';
import { PW, call, cookieOf } from './shared-helpers.mjs';
import { containerEnv, makeDirs, runEntry, startEntry, stopEntries, tokenOf } from './deploy-helpers.mjs';

after(stopEntries);
after(closeAll);

const PUBLIC = 'https://write.example.org';
const viaProxy = { headers: { Host: 'write.example.org' } }; // what the reverse proxy forwards

test('planStart: the defaults of the container, and every refusal', () => {
  assert.deepEqual(planStart({}), { ok: true, mode: 'shared', host: '0.0.0.0', port: '4317', library: '/library', sharedData: '/shared-data', publicUrl: null, owner: null, database: false, libraryId: null });
  const personal = planStart({ STORYFORGE_MODE: 'personal', STORYFORGE_OWNER: 'ilse', STORYFORGE_PUBLIC_URL: PUBLIC });
  assert.deepEqual(personal, { ok: true, mode: 'personal', host: '127.0.0.1', port: '4317', library: '/library', sharedData: '/shared-data', publicUrl: null, owner: null, database: false, libraryId: null });
  const shared = planStart({ STORYFORGE_OWNER: 'ilse', STORYFORGE_PUBLIC_URL: PUBLIC, STORYFORGE_PORT: '5000', STORYFORGE_HOST: '127.0.0.1' });
  assert.deepEqual(shared, { ok: true, mode: 'shared', host: '127.0.0.1', port: '5000', library: '/library', sharedData: '/shared-data', publicUrl: PUBLIC, owner: 'ilse', database: false, libraryId: null });
  assert.match(planStart({ STORYFORGE_MODE: 'personal', STORYFORGE_HOST: '0.0.0.0' }).message, /refused in personal mode/);
  assert.equal(planStart({ STORYFORGE_MODE: 'personal', STORYFORGE_HOST: 'localhost' }).ok, true);
  assert.match(planStart({ STORYFORGE_MODE: 'team' }).message, /personal or shared/);
  for (const port of ['abc', '70000', '-1', '4317.5']) assert.match(planStart({ STORYFORGE_PORT: port }).message, /STORYFORGE_PORT/, port);
});

test('planStart: STORYFORGE_DATABASE switches database mode on, STORYFORGE_LIBRARY_ID picks the library and is validated', () => {
  const url = 'postgres://u:p@db.example.org/sf';
  const plain = planStart({ STORYFORGE_DATABASE: url });
  assert.equal(plain.ok, true);
  assert.equal(plain.database, true);
  assert.equal(plain.libraryId, null, 'no id given: the server default (main) applies');
  assert.equal(planStart({ STORYFORGE_DATABASE: '   ' }).database, false, 'a blank URL is no database');
  const named = planStart({ STORYFORGE_DATABASE: url, STORYFORGE_LIBRARY_ID: 'my-lib-2' });
  assert.equal(named.ok, true);
  assert.equal(named.database, true);
  assert.equal(named.libraryId, 'my-lib-2');
  assert.equal(planStart({ STORYFORGE_DATABASE: url, STORYFORGE_LIBRARY_ID: 'a'.repeat(63) }).ok, true, '63 characters is the longest id');
  assert.deepEqual(planStart({ STORYFORGE_LIBRARY_ID: 'main' }), { ok: false, message: 'STORYFORGE_LIBRARY_ID only works with STORYFORGE_DATABASE' });
  assert.equal(planStart({ STORYFORGE_LIBRARY_ID: 'main', STORYFORGE_DATABASE: '  ' }).ok, false, 'a blank database URL does not enable the id');
  for (const id of ['Main', '-main', 'a_b', 'a b', 'a/b', '../x', 'a'.repeat(64)]) {
    const r = planStart({ STORYFORGE_DATABASE: url, STORYFORGE_LIBRARY_ID: id });
    assert.equal(r.ok, false, id);
    assert.match(r.message, /STORYFORGE_LIBRARY_ID/, id);
  }
});

const SHARED_FIXTURE = path.join(HOSTED, 'shared-data');
const dbPlan = (url, sharedData) => planStart({ STORYFORGE_DATABASE: url, STORYFORGE_SHARED_DATA: sharedData });

test('checkOwner (file mode): reads the owner from the shared folder; an empty folder has none', async () => {
  const withOwner = await tempDir('sf-co-file-');
  await fs.cp(SHARED_FIXTURE, withOwner, { recursive: true });
  assert.deepEqual(await checkOwner(planStart({ STORYFORGE_SHARED_DATA: withOwner }), {}), { ok: true, hasOwner: true });
  const empty = await tempDir('sf-co-file-empty-');
  assert.deepEqual(await checkOwner(planStart({ STORYFORGE_SHARED_DATA: empty }), {}), { ok: true, hasOwner: false });
});

test('checkOwner (database mode): an empty folder next to a database that has an owner is filled from it and is not ownerless', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url, { sharedData: SHARED_FIXTURE });
  const folder = await tempDir('sf-co-db-empty-');
  assert.deepEqual(await fs.readdir(folder), []);
  assert.deepEqual(await checkOwner(dbPlan(url, folder), { STORYFORGE_DATABASE: url }), { ok: true, hasOwner: true });
  const names = await fs.readdir(folder);
  assert.ok(names.includes('users.json') && names.includes('members.json'), `the folder now holds the shared files: ${names.join(', ')}`);
});

test('checkOwner (database mode): a folder of accounts the database never saw is refused and left untouched', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url); // library only, no shared data
  const folder = await tempDir('sf-co-db-unseen-');
  const body = '{"version":1,"users":[]}\n';
  await fs.writeFile(path.join(folder, 'users.json'), body);
  const r = await checkOwner(dbPlan(url, folder), { STORYFORGE_DATABASE: url });
  assert.equal(r.ok, false);
  assert.match(r.message, /users\.json/);
  assert.equal(await fs.readFile(path.join(folder, 'users.json'), 'utf8'), body, 'the folder file is unchanged');
  assert.deepEqual(await fs.readdir(folder), ['users.json']);
});

test('checkOwner (database mode): no shared data anywhere means no owner', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const folder = await tempDir('sf-co-db-none-');
  assert.deepEqual(await checkOwner(dbPlan(url, folder), { STORYFORGE_DATABASE: url }), { ok: true, hasOwner: false });
});

test('the entrypoint refuses (exit 2, nothing started) a personal mode on a public address, an unknown mode, and a shared mode with no owner', async () => {
  const dirs = await makeDirs();
  const wide = await runEntry(containerEnv(dirs, { STORYFORGE_MODE: 'personal', STORYFORGE_HOST: '0.0.0.0' }));
  assert.equal(wide.code, 2, wide.output);
  assert.match(wide.stderr, /refused in personal mode/);
  assert.equal((await runEntry(containerEnv(dirs, { STORYFORGE_MODE: 'team' }))).code, 2);
  const noOwner = await runEntry(containerEnv(dirs, { STORYFORGE_OWNER: '' }));
  assert.equal(noOwner.code, 2, noOwner.output);
  assert.match(noOwner.stderr, /STORYFORGE_OWNER/);
  assert.equal(await fs.readFile(path.join(dirs.library, '.storyforge-lock'), 'utf8').catch(() => null), null, 'no server ran, so no lock');
});

test('shared mode: STORYFORGE_OWNER creates the owner once and prints the setup link once; health and /api/auth/me answer; a second start keeps the data and stays quiet', async () => {
  const dirs = await makeDirs();
  const env = containerEnv(dirs, { STORYFORGE_OWNER: 'ilse', STORYFORGE_PUBLIC_URL: PUBLIC });

  const first = await startEntry(env);
  const links = first.stdout().match(/https:\/\/write\.example\.org\/setup#token=[A-Za-z0-9_-]{43}/g) ?? [];
  assert.equal(links.length, 1, `one setup link in the log:\n${first.output()}`);
  assert.match(first.stdout(), /Shared mode: accounts and audit log in /);
  const token = tokenOf(links[0]);

  const health = await call(first.port, 'GET', '/api/health', viaProxy);
  assert.equal(health.status, 200, 'the liveness probe needs no login');
  assert.deepEqual(health.json, { ok: true }, 'and tells a signed-out caller nothing else (no library path, no version)');
  assert.equal((await call(first.port, 'GET', '/api/health', { headers: { Host: 'elsewhere.example' } })).status, 403, 'a Host that is not the public one is refused');
  const me = await call(first.port, 'GET', '/api/auth/me', viaProxy);
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.mode, 'shared');
  assert.equal(me.json.user, null);
  assert.equal(me.json.needs_owner, true, 'the owner exists but has not chosen a password yet');
  assert.equal((await call(first.port, 'GET', '/api/books', viaProxy)).status, 401, 'nothing without a login');

  const done = await call(first.port, 'POST', '/api/auth/setup', { ...viaProxy, origin: PUBLIC, body: { token, password: PW } });
  assert.equal(done.status, 200, done.text);
  const cookie = cookieOf(done, 'sf_session');
  assert.match(done.setCookie.join(';'), /Secure/, 'https public URL: the cookie is Secure');
  await first.stop();

  const users = await fs.readFile(path.join(dirs.shared, 'users.json'), 'utf8');
  const second = await startEntry(env);
  assert.ok(!/setup#token/.test(second.output()), `no second setup link:\n${second.output()}`);
  const again = await call(second.port, 'GET', '/api/auth/me', { ...viaProxy, cookie });
  assert.equal(again.json.user?.username, 'ilse', 'the session and the owner survive the restart');
  assert.equal(await fs.readFile(path.join(dirs.shared, 'users.json'), 'utf8'), users, 'the account data was not rewritten by the start');
  assert.equal((await call(second.port, 'POST', '/api/auth/login', { ...viaProxy, origin: PUBLIC, body: { username: 'ilse', password: PW } })).status, 200);
  assert.equal((await call(second.port, 'GET', '/api/books', { ...viaProxy, cookie })).status, 200);
  assert.equal((await call(second.port, 'GET', '/api/health', { ...viaProxy, cookie })).status, 200, 'health with a session');
  await second.stop();
});

test('personal mode: no accounts, loopback, and the owner variables are ignored', async () => {
  const dirs = await makeDirs();
  const entry = await startEntry(containerEnv(dirs, { STORYFORGE_MODE: 'personal', STORYFORGE_OWNER: 'ilse' }));
  assert.match(entry.stderr(), /ignored in personal mode/);
  assert.ok(!/Shared mode/.test(entry.stdout()));
  assert.equal((await call(entry.port, 'GET', '/api/health')).status, 200);
  assert.equal((await call(entry.port, 'GET', '/api/books')).status, 200, 'no login in personal mode');
  assert.deepEqual(await fs.readdir(dirs.shared), [], 'no shared data in personal mode');
  await entry.stop();
});

/** A free loopback port (bound and released at once). */
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test('the Dockerfile HEALTHCHECK command is healthy against a running entrypoint, with and without a public URL, and unhealthy with nothing listening', async () => {
  const docker = await fs.readFile(path.join(REPO_ROOT, 'deploy', 'Dockerfile'), 'utf8');
  const script = /^HEALTHCHECK .*? CMD node -e "(.*)"$/m.exec(docker)?.[1];
  assert.ok(script, 'a HEALTHCHECK that uses node -e');
  const probe = (env) => spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 20000 }).status;

  for (const publicUrl of [undefined, PUBLIC]) {
    const dirs = await makeDirs();
    const port = String(await freePort());
    const env = containerEnv(dirs, { STORYFORGE_OWNER: 'ilse', STORYFORGE_PORT: port, ...(publicUrl ? { STORYFORGE_PUBLIC_URL: publicUrl } : {}) });
    const entry = await startEntry(env);
    assert.equal(probe(env), 0, `healthy (public URL: ${publicUrl ?? 'none'})`);
    await entry.stop();
    assert.equal(probe(env), 1, 'nothing listening: unhealthy');
  }
});
