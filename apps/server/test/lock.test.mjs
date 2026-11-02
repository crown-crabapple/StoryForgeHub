// M01-J04 acceptance 10: single-instance lock, with real main.mjs child processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFixture, request } from './helpers.mjs';
import { LOCK_NAME, deadPid, killAll, runCli, startServer, waitFor } from './proc-helpers.mjs';

after(killAll);

const lockPath = (root) => path.join(root, LOCK_NAME);
const readLock = async (root) => JSON.parse(await fs.readFile(lockPath(root), 'utf8'));
const exists = (p) => fs.access(p).then(() => true, () => false);

test('a running server holds the lock file { pid, hostname, started_at, port }', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  const lock = await waitFor(() => readLock(root), { what: 'lock file' });
  assert.equal(lock.pid, s.pid);
  assert.equal(lock.hostname, os.hostname());
  assert.equal(typeof lock.started_at, 'string');
  assert.equal(lock.port, s.port);
  const st = await request(s.port, 'GET', '/api/status');
  assert.equal(st.json.instance.pid, s.pid);
  assert.equal(st.json.instance.lock, 'held');
});

test('a second server on the same library exits 3 and names the holder', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const first = await startServer(root);
  const second = await runCli(['--library', root, '--port', '0']);
  assert.equal(second.code, 3, second.output);
  assert.ok(second.output.includes(String(first.pid)), `message names pid ${first.pid}: ${second.output}`);
  // the first server is unharmed and still owns the lock
  assert.equal((await readLock(root)).pid, first.pid);
  assert.equal((await request(first.port, 'GET', '/api/health')).status, 200);
});

test('a lock whose pid is dead is taken over and reported as taken-over', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const dead = await deadPid();
  await fs.writeFile(lockPath(root), JSON.stringify({ pid: dead, hostname: os.hostname(), started_at: '2020-01-01T00:00:00.000Z', port: 1 }));
  const s = await startServer(root);
  const lock = await readLock(root);
  assert.equal(lock.pid, s.pid, 'lock now names the new instance');
  const st = await request(s.port, 'GET', '/api/status');
  assert.equal(st.json.instance.lock, 'taken-over');
});

test('the lock file is not author data: it does not make the library invalid or show up in diagnostics', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  await waitFor(() => exists(lockPath(root)), { what: 'lock file' });
  const diags = (await request(s.port, 'GET', '/api/books/book_01S5000000000000000000000A/diagnostics')).json;
  assert.deepEqual(diags.filter((d) => d.file.includes('storyforge-lock')), []);
  await waitFor(async () => (await request(s.port, 'GET', '/api/status')).json.books[0]?.index === 'fresh', { what: 'fresh' });
});

test('lock is removed on clean shutdown (SIGINT)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows cannot deliver SIGINT/SIGTERM to a child process for a graceful shutdown; child.kill() is a hard kill');
    return;
  }
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  assert.ok(await exists(lockPath(root)));
  s.child.kill('SIGINT');
  await s.exited;
  assert.equal(await exists(lockPath(root)), false, 'lock released');
});

test('rebuild CLI refuses (exit 3) while a server holds the lock, and leaves the lock alone', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  const r = await runCli(['rebuild', '--library', root]);
  assert.equal(r.code, 3, r.output);
  assert.ok(r.output.includes(String(s.pid)), r.output);
  assert.equal((await readLock(root)).pid, s.pid);
});

test('rebuild CLI with no server running builds the index and releases the lock', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const r = await runCli(['rebuild', '--library', root]);
  assert.equal(r.code, 0, r.output);
  assert.equal(await exists(lockPath(root)), false, 'rebuild released the lock');
  assert.ok(await exists(path.join(root, '.storyforge')), 'index directory exists');
});

test('repair without --apply is read-only and works while a server holds the lock', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  const r = await runCli(['repair', '--library', root]);
  assert.equal(r.code, 0, r.output);
  assert.equal((await readLock(root)).pid, s.pid);
});

test('repair --apply refuses (exit 3) while a server holds the lock', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await startServer(root);
  const r = await runCli(['repair', '--library', root, '--apply']);
  assert.equal(r.code, 3, r.output);
});
