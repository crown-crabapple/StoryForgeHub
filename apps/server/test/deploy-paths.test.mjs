// M08-J01 contract section 5.4 and 5.5: the same sample project through both deployment paths, and no telemetry in either.
//   personal: the launcher's start command (`node apps/server/src/main.mjs --library <folder>`; the launcher only adds --open, which starts a browser and is left out here)
//   shared:   deploy/entrypoint.mjs with the container's environment (host 127.0.0.1)
// Each gets its own copy of salt-orchard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { MAIN, runCli, waitFor } from './proc-helpers.mjs';
import { BOOK } from './ai-helpers.mjs';
import { snapshot } from './helpers.mjs';
import { PW, call, cookieOf } from './shared-helpers.mjs';
import { PRELOAD_URL, containerEnv, makeDirs, spawnTracked, startEntry, stopEntries, tokenOf } from './deploy-helpers.mjs';

after(stopEntries);

/** The launcher's start command on `library`; resolves with `.port`. */
async function startPersonal(library, env = process.env) {
  const proc = spawnTracked(env, [MAIN, '--library', library, '--port', '0']);
  const early = proc.exited.then((r) => {
    throw new Error(`the server exited before it was ready (${JSON.stringify(r)}):\n${proc.output()}`);
  });
  const m = await Promise.race([waitFor(() => /StoryForge serving [^\n]*\nhttp:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.stdout()), { what: 'the "StoryForge serving" line' }), early]);
  proc.port = Number(m[1]);
  return proc;
}

/** Shared mode through the entrypoint, owner logged in; resolves with `.port` and `.cookie`. */
async function startShared(dirs, env = {}) {
  const entry = await startEntry(containerEnv(dirs, { STORYFORGE_OWNER: 'ilse', ...env }));
  const token = tokenOf(entry.stdout());
  assert.ok(token, `a setup link in the log:\n${entry.output()}`);
  const done = await call(entry.port, 'POST', '/api/auth/setup', { body: { token, password: PW } });
  assert.equal(done.status, 200, done.text);
  entry.cookie = cookieOf(done, 'sf_session');
  return entry;
}

const errorsIn = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

/** Open the book, check diagnostics, make a backup through the API and restore it into a new folder with the CLI. @returns {Promise<string>} the restored folder */
async function openValidateBackupRestore(label, library, port, cookie) {
  const get = (p) => call(port, 'GET', p, { cookie });
  const books = await get('/api/books');
  assert.equal(books.status, 200, `${label}: ${books.text}`);
  assert.ok(books.json.some((b) => b.id === BOOK), `${label}: the sample book is listed`);
  const book = await get(`/api/books/${BOOK}`);
  assert.equal(book.status, 200, `${label}: the book opens`);
  assert.ok(book.json.acts?.length > 0, `${label}: the book has its structure`);
  const diagnostics = await get(`/api/books/${BOOK}/diagnostics`);
  assert.equal(diagnostics.status, 200);
  assert.deepEqual(diagnostics.json, [], `${label}: validate through the API gives no diagnostics`);
  assert.deepEqual(await errorsIn(library), [], `${label}: validate on the folder gives 0 errors`);

  const backup = await get(`/api/books/${BOOK}/backup`);
  assert.equal(backup.status, 200, `${label}: backup`);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), `sf-deploy-${label}-`));
  const zip = path.join(out, 'backup.zip');
  await fs.writeFile(zip, backup.bytes);
  const restored = path.join(out, 'restored');
  const r = await runCli(['restore', '--from', zip, '--to', restored]);
  assert.equal(r.code, 0, `${label}: restore: ${r.output}`);
  assert.deepEqual(await errorsIn(restored), [], `${label}: the restored folder validates`);
  return restored;
}

test('the same sample project through the personal path and the container entrypoint: both open it, validate clean, and their backups restore byte-identically', { timeout: 120000 }, async () => {
  const personalLib = (await makeDirs()).library;
  const sharedDirs = await makeDirs();

  const personal = await startPersonal(personalLib);
  const restoredPersonal = await openValidateBackupRestore('personal', personalLib, personal.port);
  await personal.stop();

  const shared = await startShared(sharedDirs);
  const restoredShared = await openValidateBackupRestore('shared', sharedDirs.library, shared.port, shared.cookie);
  await shared.stop();

  const a = await snapshot(restoredPersonal, { skipStoryforge: true });
  const b = await snapshot(restoredShared, { skipStoryforge: true });
  assert.ok(Object.keys(a).length > 10, 'the restore holds the book files');
  assert.deepEqual(b, a, 'the two restores are byte-identical');
  // the accounts never end up in a book backup
  assert.ok(!Object.keys(b).some((k) => /users\.json|sessions\.json|audit\.jsonl/.test(k)));
});

test('no telemetry: both start-ups (personal and container shared) make zero outbound connections under the network recorder', { timeout: 120000 }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-net-'));
  const recorded = (log) => fs.readFile(log, 'utf8').then((t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l)), () => []);
  const withRecorder = (env, log) => ({ ...env, SF_NET_LOG: log, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${PRELOAD_URL}`.trim() });

  // positive control: the recorder really sees a call made by a process started the same way
  const controlLog = path.join(work, 'control.jsonl');
  const control = spawnTracked(withRecorder(process.env, controlLog), ['-e', "fetch('http://127.0.0.1:9/').catch(() => {}); setTimeout(() => process.exit(0), 300)"]);
  await control.exited;
  assert.deepEqual((await recorded(controlLog)).map((e) => e.api), ['fetch'], 'the recorder sees an outbound call');

  const personalLog = path.join(work, 'personal.jsonl');
  const personal = await startPersonal((await makeDirs()).library, withRecorder(process.env, personalLog));
  for (const p of ['/api/health', '/api/books', '/api/library', '/api/status']) assert.ok((await call(personal.port, 'GET', p)).status < 500, p);
  await personal.stop();
  assert.deepEqual(await recorded(personalLog), [], 'personal mode: zero outbound connections');

  const sharedLog = path.join(work, 'shared.jsonl');
  const shared = await startShared(await makeDirs(), withRecorder({}, sharedLog));
  for (const p of ['/api/health', '/api/books', '/api/auth/me', '/api/status']) assert.ok((await call(shared.port, 'GET', p, { cookie: shared.cookie })).status < 500, p);
  assert.match(shared.stdout(), /Shared mode/, 'the shared start-up ran (setup, init and serve)');
  await shared.stop();
  assert.deepEqual(await recorded(sharedLog), [], 'shared mode through the entrypoint: zero outbound connections');
});
