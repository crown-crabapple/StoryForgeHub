// M13-J04: EPUBCheck on the server, with a fake runner and fake detectors (no Java is needed): the tools settings and status routes (admin only), the validation job lifecycle (completed,
// failed, unavailable, cancelled, one per book), the exact bytes that were checked in /file and /report, the checks/epub route, and the policy class of every new route.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { outcomeOf } from '@storyforge/format';
import { userConfigDir } from '@storyforge/store';
import { WRITE_CLASSES, allowed, classifyRead } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { createEpubValidations, epubValidations } from '../src/epub-validations.mjs';
import { createTools, tools } from '../src/tools.mjs';
import { BOOK, SCENE, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const B = `/api/books/${BOOK}`;
const V = `${B}/export/validations`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------------------------------------------ fakes

/** A toValidation like the real one for the fields the server relies on (messages keep the scene or chapter the test gives them). */
function fakeToValidation({ run, artifact }) {
  const base = { schema: 'storyforge.validation/v1', validator: 'epubcheck', artifact, report: null };
  if (!run.ok) {
    const outcome = run.kind === 'unavailable' ? 'unavailable' : run.kind === 'cancelled' ? 'cancelled' : 'error';
    return { ...base, validatorVersion: null, checkedAt: null, outcome, messages: [], detail: run.detail };
  }
  const messages = run.report.messages.map((m) => ({ code: m.ID, severity: m.severity.toLowerCase(), message: m.message, location: m.location ?? null, sceneId: m.sceneId ?? null, chapterId: m.chapterId ?? null }));
  return { ...base, validatorVersion: run.report.checker.checkerVersion, checkedAt: '2026-01-01T00:00:00.000Z', outcome: outcomeOf(messages), messages, detail: null };
}

/** The runner of a test: what it was called with, and what it answers (a function of the call). */
function fakeRunner(answer) {
  const calls = [];
  const fn = async (args) => {
    calls.push({ ...args, bytesCopy: Buffer.from(args.epubBytes) });
    return answer(args, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const okReport = (messages = []) => ({ ok: true, report: { checker: { checkerVersion: '5.4.0', nMessages: messages.length }, messages }, stdout: '', stderr: '', exitCode: messages.length > 0 ? 1 : 0, elapsedMs: 5 });
const READY = {
  detectJava: async ({ javaPath }) => ({ state: 'ready', path: javaPath, version: '21', reason: null }),
  detectEpubCheck: async ({ jarPath }) => ({ state: 'ready', path: jarPath, version: '5.4.0', reason: null }),
};

let scratch;
let javaFile;
let jarFile;
beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-j04-'));
  javaFile = path.join(scratch, process.platform === 'win32' ? 'java.exe' : 'java');
  jarFile = path.join(scratch, 'epubcheck.jar');
  await fs.writeFile(javaFile, '');
  await fs.writeFile(jarFile, '');
  tools.setHooks({ env: {}, ...READY });
});
afterEach(async () => {
  for (const id of lastIds.splice(0)) epubValidations.cancel(BOOK, id);
  epubValidations.setHooks({ runEpubCheck: null, toValidation: null, explainEpubCheck: null });
  tools.setHooks({ env: null, detectJava: null, detectEpubCheck: null });
  await fs.rm(scratch, { recursive: true, force: true });
});

const lastIds = [];
/** A personal server whose tools point at the scratch java and jar. */
async function boot() {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const put = await t.member('PUT', '/api/tools', { java: javaFile, epubcheckJar: jarFile });
  assert.equal(put.status, 200, put.text);
  return t;
}

async function start(t, body = {}) {
  const r = await t.member('POST', V, body);
  if (r.json?.validationId) lastIds.push(r.json.validationId);
  return r;
}
async function until(t, id, ok = (s) => s.state !== 'running') {
  for (let i = 0; i < 1000; i += 1) {
    const r = await t.member('GET', `${V}/${id}`);
    assert.equal(r.status, 200, r.text);
    if (ok(r.json)) return r.json;
    await sleep(5);
  }
  throw new Error('the validation never reached the expected state');
}

// ------------------------------------------------------------------------------------------------------------------------------ tools

test('GET /api/tools: nulls when nothing is saved; PUT saves, merges and clears; the file is tools.json in the user config folder', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  assert.deepEqual((await t.member('GET', '/api/tools')).json, { java: null, epubcheckJar: null });
  const first = await t.member('PUT', '/api/tools', { java: javaFile });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { java: javaFile, epubcheckJar: null });
  const second = await t.member('PUT', '/api/tools', { epubcheckJar: jarFile });
  assert.deepEqual(second.json, { java: javaFile, epubcheckJar: jarFile });
  assert.deepEqual((await t.member('GET', '/api/tools')).json, { java: javaFile, epubcheckJar: jarFile });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(userConfigDir(), 'tools.json'), 'utf8')), { java: javaFile, epubcheckJar: jarFile });
  const cleared = await t.member('PUT', '/api/tools', { java: null });
  assert.deepEqual(cleared.json, { java: null, epubcheckJar: jarFile });
});

test('PUT /api/tools: 400 for a relative path, a wrong file name, a missing file, an unknown field, an empty body or a wrong type; nothing is saved', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const notJava = path.join(scratch, 'node.exe');
  const notJar = path.join(scratch, 'epubcheck.zip');
  await fs.writeFile(notJava, '');
  await fs.writeFile(notJar, '');
  const bad = [
    { java: 'java' },
    { java: path.join('..', 'java') },
    { java: notJava },
    { java: path.join(scratch, process.platform === 'win32' ? 'java.exe' : 'java', 'gone', 'java') },
    { java: path.join(scratch, 'missing', 'java') },
    { epubcheckJar: 'epubcheck.jar' },
    { epubcheckJar: notJar },
    { epubcheckJar: path.join(scratch, 'missing.jar') },
    { epubcheckJar: scratch },
    { java: 5 },
    { epubcheckJar: true },
    { java: javaFile, other: 'x' },
    { java: `${javaFile}\0` },
    {},
  ];
  for (const body of bad) {
    const r = await t.member('PUT', '/api/tools', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.json.error, 'bad_request');
  }
  // one bad field refuses the whole request: the good one is not saved either
  assert.equal((await t.member('PUT', '/api/tools', { java: javaFile, epubcheckJar: notJar })).status, 400);
  assert.deepEqual((await t.member('GET', '/api/tools')).json, { java: null, epubcheckJar: null });
});

test('GET /api/tools/status uses the detectors: ready, java missing, no jar; EPUBCheck is only checked when Java works', async () => {
  const t = await boot();
  const seen = [];
  tools.setHooks({
    detectJava: async (a) => (seen.push(['java', a.javaPath]), { state: 'ready', path: a.javaPath, version: '21', reason: null }),
    detectEpubCheck: async (a) => (seen.push(['epubcheck', a.java, a.jarPath]), { state: 'ready', path: a.jarPath, version: '5.4.0', reason: null }),
  });
  const ready = await t.member('GET', '/api/tools/status');
  assert.equal(ready.status, 200, ready.text);
  assert.deepEqual(ready.json, { java: { state: 'ready', path: javaFile, version: '21', reason: null }, epubcheck: { state: 'ready', path: jarFile, version: '5.4.0', reason: null } });
  assert.deepEqual(seen, [['java', javaFile], ['epubcheck', javaFile, jarFile]]);

  seen.length = 0;
  tools.setHooks({ detectJava: async (a) => ({ state: 'unavailable', path: a.javaPath, version: null, reason: 'Java 8 or newer is needed (found 7).' }) });
  const noJava = (await t.member('GET', '/api/tools/status')).json;
  assert.equal(noJava.java.state, 'unavailable');
  assert.equal(noJava.java.reason, 'Java 8 or newer is needed (found 7).');
  assert.equal(noJava.epubcheck.state, 'unavailable');
  assert.deepEqual(seen, [], 'EPUBCheck is not run without Java');

  await t.member('PUT', '/api/tools', { epubcheckJar: null });
  tools.setHooks({ ...READY });
  const noJar = (await t.member('GET', '/api/tools/status')).json;
  assert.equal(noJar.java.state, 'ready');
  assert.deepEqual(noJar.epubcheck, { state: 'unavailable', path: null, version: null, reason: 'EPUBCheck is not set up. Choose the epubcheck.jar file in Settings.' });
});

test('a detector that throws or answers nonsense is reported as unavailable, never as ready', async () => {
  const t = await boot();
  tools.setHooks({ detectJava: async () => { throw new Error('boom'); }, detectEpubCheck: async () => ({ state: 'maybe' }) });
  const bad = (await t.member('GET', '/api/tools/status')).json;
  assert.equal(bad.java.state, 'unavailable');
  assert.match(bad.java.reason, /boom/);
  tools.setHooks({ detectJava: READY.detectJava });
  const odd = (await t.member('GET', '/api/tools/status')).json;
  assert.equal(odd.epubcheck.state, 'unavailable');
});

test('discovery order: tools.json, then STORYFORGE_JAVA / STORYFORGE_EPUBCHECK_JAR, then JAVA_HOME/bin/java, then java on PATH', async () => {
  const javaHome = path.join(scratch, 'jdk');
  await fs.mkdir(path.join(javaHome, 'bin'), { recursive: true });
  const homeJava = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  await fs.writeFile(homeJava, '');
  const envJava = path.join(scratch, 'env-java');
  const asked = [];
  const make = (env, saved) => createTools({
    env, platform: process.platform, readConfig: async () => saved, writeConfig: async () => ({ ok: true }),
    detectJava: async (a) => (asked.push(a.javaPath), { state: 'ready', path: a.javaPath, version: '17', reason: null }),
    detectEpubCheck: async (a) => ({ state: 'ready', path: a.jarPath, version: '5.4.0', reason: null }),
  });
  await make({ STORYFORGE_JAVA: envJava, JAVA_HOME: javaHome }, { java: javaFile, epubcheckJar: jarFile }).status();
  await make({ STORYFORGE_JAVA: envJava, JAVA_HOME: javaHome }, null).status();
  await make({ JAVA_HOME: javaHome }, null).status();
  await make({ JAVA_HOME: path.join(scratch, 'no-such-jdk') }, null).status();
  await make({}, null).status();
  assert.deepEqual(asked, [javaFile, envJava, homeJava, 'java', 'java']);
  const jarFromEnv = await make({ STORYFORGE_EPUBCHECK_JAR: jarFile }, null).status();
  assert.equal(jarFromEnv.epubcheck.path, jarFile);
  const jarSaved = await make({ STORYFORGE_EPUBCHECK_JAR: path.join(scratch, 'other.jar') }, { epubcheckJar: jarFile }).status();
  assert.equal(jarSaved.epubcheck.path, jarFile);
  assert.equal((await make({}, null).status()).epubcheck.state, 'unavailable');
});

// ------------------------------------------------------------------------------------------------------------------------------ policy and route tables

test('policy: the tools routes are admin, the validation start and cancel and the remembered choice are write, the reads of a validation are read and never for a share link', () => {
  assert.equal(WRITE_CLASSES['tools-save'], 'admin');
  for (const r of ['book-checks-epub', 'validation-start', 'validation-cancel']) assert.equal(WRITE_CLASSES[r], 'write', r);
  assert.equal(classifyRead('/api/tools').cls, 'admin');
  assert.equal(classifyRead('/api/tools/status').cls, 'admin');
  assert.equal(classifyRead('/api/tools/other'), null);
  for (const p of ['', '/val_X', '/val_X/file', '/val_X/report']) {
    const c = classifyRead(`${B}/export/validations${p}`);
    assert.deepEqual([c.cls, c.book, c.shareable], ['read', BOOK, false], p);
  }
  assert.equal(classifyRead(`${B}/export`).cls, 'export');
  const user = (role) => ({ kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role });
  const share = { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read', 'export'] };
  for (const role of ['viewer', 'reviewer', 'editor']) assert.equal(allowed(user(role), 'admin'), false, `${role} tools`);
  assert.equal(allowed(user('owner'), 'admin'), true);
  assert.equal(allowed(user('viewer'), 'write', { book: BOOK }), false);
  assert.equal(allowed(user('editor'), 'write', { book: BOOK }), true);
  assert.equal(allowed(share, 'read', { book: BOOK, shareable: false }), false);
  assert.equal(allowed(share, 'admin'), false);
});

test('route table: every new route is matched exactly and nothing else is', () => {
  const m = (method, url) => matchWriteRoute(method, url);
  assert.deepEqual(m('PUT', '/api/tools'), { route: 'tools-save' });
  assert.equal(m('POST', '/api/tools'), null);
  assert.equal(m('DELETE', '/api/tools'), null);
  assert.deepEqual(m('POST', `${B}/checks/epub`), { route: 'book-checks-epub', bookId: BOOK });
  assert.deepEqual(m('POST', `${V}`), { route: 'validation-start', bookId: BOOK });
  assert.deepEqual(m('POST', `${V}/val_X/cancel`), { route: 'validation-cancel', bookId: BOOK, validationId: 'val_X' });
  for (const [method, url] of [['POST', `${V}/val_X`], ['POST', `${V}/val_X/file`], ['DELETE', `${V}/val_X`], ['PUT', `${V}`], ['POST', `${V}/val_X/cancel/x`], ['POST', `${B}/checks/epub/x`], ['GET', `${V}`]]) {
    assert.equal(m(method, url), null, `${method} ${url}`);
  }
});

// ------------------------------------------------------------------------------------------------------------------------------ jobs

test('a clean check: 202, then completed/passed; /file is the exact EPUB the runner got and its hash is in the result; /report holds result, explanations and the checker block', async () => {
  const t = await boot();
  const runner = fakeRunner(() => okReport());
  epubValidations.setHooks({ runEpubCheck: runner, toValidation: fakeToValidation, explainEpubCheck: () => null });
  const r = await start(t);
  assert.equal(r.status, 202, r.text);
  assert.match(r.json.validationId, /^val_[0-9a-f]{20}$/);
  const done = await until(t, r.json.validationId);
  assert.equal(done.state, 'completed');
  assert.equal(done.result.outcome, 'passed');
  assert.equal(done.result.validator, 'epubcheck');
  assert.equal(done.filename, 'salt-orchard.epub');
  assert.deepEqual(done.explanations, {});

  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.java, javaFile);
  assert.equal(call.jar, jarFile);
  assert.equal(call.name, 'book.epub');
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(Object.keys(call).sort().join(), ['bytesCopy', 'epubBytes', 'jar', 'java', 'name', 'signal'].sort().join(), 'only fixed arguments go to the runner');

  const file = await t.member('GET', `${V}/${r.json.validationId}/file`);
  assert.equal(file.status, 200);
  assert.deepEqual(file.bytes, call.bytesCopy, 'the exact bytes that were checked');
  assert.equal(sha(file.bytes), done.result.artifact.sha256);
  assert.equal(file.headers['content-type'], 'application/epub+zip');
  assert.equal(file.headers['content-disposition'], 'attachment; filename="salt-orchard.epub"');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.equal(file.headers['cache-control'], 'no-store');
  assert.equal(file.headers['content-security-policy'], "default-src 'none'; sandbox");
  // the same bytes as a plain export of the same options
  const plain = await t.member('GET', `${B}/export?format=epub&sceneTitles=0`);
  assert.deepEqual(plain.bytes, file.bytes);

  const report = await t.member('GET', `${V}/${r.json.validationId}/report`);
  assert.equal(report.status, 200);
  assert.match(report.headers['content-disposition'], /^attachment; filename="salt-orchard-epubcheck-report\.json"$/);
  assert.match(report.headers['content-type'], /^application\/json/);
  const body = JSON.parse(report.text);
  assert.deepEqual(Object.keys(body).sort(), ['checker', 'explanations', 'result']);
  assert.equal(body.result.outcome, 'passed');
  assert.equal(body.checker.checkerVersion, '5.4.0');
});

test('a failed check: messages, plain explanations for the known codes only, scene sources; the file is still downloadable', async () => {
  const t = await boot();
  const messages = [
    { ID: 'RSC-007', severity: 'ERROR', message: 'Referenced resource "a.png" could not be found.', location: { path: 'OEBPS/chapter-001.xhtml', line: 12, column: 4 }, sceneId: SCENE },
    { ID: 'OPF-099', severity: 'WARNING', message: 'Something odd.', location: null },
    { ID: 'RSC-001', severity: 'FATAL', message: 'Chapter missing.', location: { path: 'OEBPS/chapter-002.xhtml', line: 1, column: 1 }, chapterId: 'chap_01S5000000000000000000000X' },
  ];
  epubValidations.setHooks({
    runEpubCheck: fakeRunner(() => okReport(messages)),
    toValidation: fakeToValidation,
    explainEpubCheck: (code) => (code === 'RSC-007' ? 'A file the book points at is missing.' : null),
  });
  const r = await start(t);
  const done = await until(t, r.json.validationId);
  assert.equal(done.state, 'completed');
  assert.equal(done.result.outcome, 'failed');
  assert.equal(done.result.messages.length, 3);
  assert.deepEqual(done.explanations, { 'RSC-007': 'A file the book points at is missing.' });
  const scene = (await t.repository.listLiveScenes(BOOK)).scenes.find((s) => s.id === SCENE);
  assert.deepEqual(done.sources, { [SCENE]: { title: scene.title, chapterLabel: scene.chapterLabel } });
  assert.deepEqual(Object.keys(done.chapters), ['chap_01S5000000000000000000000X'], 'a chapter-only message has a chapters entry');
  assert.equal((await t.member('GET', `${V}/${r.json.validationId}/file`)).status, 200);
  assert.equal((await t.member('GET', `${V}/${r.json.validationId}/report`)).status, 200);
});

test('Java or EPUBCheck missing: the job completes with outcome unavailable and the reason, the runner is never called, the file is downloadable', async () => {
  const t = await boot();
  const runner = fakeRunner(() => okReport());
  epubValidations.setHooks({ runEpubCheck: runner, toValidation: fakeToValidation });
  tools.setHooks({ detectJava: async (a) => ({ state: 'unavailable', path: a.javaPath, version: null, reason: 'Java was not found at that path.' }) });
  const a = await start(t);
  const javaGone = await until(t, a.json.validationId);
  assert.equal(javaGone.state, 'completed');
  assert.equal(javaGone.result.outcome, 'unavailable');
  assert.equal(javaGone.result.detail, 'Java was not found at that path.');

  tools.setHooks({ ...READY, detectEpubCheck: async (x) => ({ state: 'unavailable', path: x.jarPath, version: null, reason: 'That is not EPUBCheck 5.' }) });
  const b = await start(t);
  const jarGone = await until(t, b.json.validationId);
  assert.equal(jarGone.result.outcome, 'unavailable');
  assert.equal(jarGone.result.detail, 'That is not EPUBCheck 5.');
  assert.equal(runner.calls.length, 0);
  const file = await t.member('GET', `${V}/${b.json.validationId}/file`);
  assert.equal(file.status, 200);
  assert.equal(sha(file.bytes), jarGone.result.artifact.sha256);
});

test('a run that crashes, times out or returns nonsense is state failed with outcome error, never a pass', async () => {
  const t = await boot();
  for (const run of [{ ok: false, kind: 'crashed', detail: 'Java stopped with code 3.' }, { ok: false, kind: 'timeout', detail: 'It took too long.' }, { ok: false, kind: 'bad-output', detail: 'No report.' }]) {
    epubValidations.setHooks({ runEpubCheck: fakeRunner(() => run), toValidation: fakeToValidation });
    const r = await start(t);
    const done = await until(t, r.json.validationId);
    assert.equal(done.state, 'failed', run.kind);
    assert.equal(done.result.outcome, 'error');
    assert.equal(done.result.detail, run.detail);
  }
  // a runner that throws is the same
  epubValidations.setHooks({ runEpubCheck: async () => { throw new Error('spawn exploded'); }, toValidation: fakeToValidation });
  const r = await start(t);
  const done = await until(t, r.json.validationId);
  assert.equal(done.state, 'failed');
  assert.equal(done.result.outcome, 'error');
  assert.match(done.result.detail, /spawn exploded/);
});

test('one validation per book: a second start is 409 VALIDATION_RUNNING with the running id; cancel stops the run (the signal fires) and the result is cancelled', async () => {
  const t = await boot();
  let aborted = false;
  const runner = fakeRunner(({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => {
    aborted = true;
    resolve({ ok: false, kind: 'cancelled', detail: 'stopped' });
  })));
  epubValidations.setHooks({ runEpubCheck: runner, toValidation: fakeToValidation });
  const first = await start(t);
  assert.equal(first.status, 202);
  const running = await until(t, first.json.validationId, () => true);
  assert.equal(running.state, 'running');
  assert.equal(running.result, null);

  const second = await start(t);
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.code, 'VALIDATION_RUNNING');
  assert.equal(second.json.validationId, first.json.validationId);
  assert.equal((await t.member('GET', `${V}/${first.json.validationId}/report`)).status, 409, 'no report until it finishes');
  assert.equal((await t.member('GET', `${V}/${first.json.validationId}/file`)).status, 200, 'the file is there from the start');

  const cancelled = await t.member('POST', `${V}/${first.json.validationId}/cancel`, {});
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.deepEqual(cancelled.json, { ok: true, cancelled: true, state: 'cancelled' });
  assert.equal(aborted, true);
  const done = await until(t, first.json.validationId);
  assert.equal(done.state, 'cancelled');
  assert.equal(done.result.outcome, 'cancelled');
  assert.equal((await t.member('GET', `${V}/${first.json.validationId}/file`)).status, 200, 'a cancelled check still has its file');
  const again = await t.member('POST', `${V}/${first.json.validationId}/cancel`, {});
  assert.deepEqual(again.json, { ok: true, cancelled: false, state: 'cancelled' });

  // a new one can start now; and the earlier result is gone (never reused for other bytes)
  epubValidations.setHooks({ runEpubCheck: fakeRunner(() => okReport()) });
  const next = await start(t);
  assert.equal(next.status, 202);
  assert.equal((await t.member('GET', `${V}/${first.json.validationId}`)).status, 404);
  assert.equal((await until(t, next.json.validationId)).result.outcome, 'passed');
});

test('a result is tied to its bytes: a later export gets a new validation with its own hash; unknown ids and other books are 404', async () => {
  const t = await boot();
  epubValidations.setHooks({ runEpubCheck: fakeRunner(() => okReport()), toValidation: fakeToValidation });
  const a = await start(t, { sceneTitles: false });
  const doneA = await until(t, a.json.validationId);
  const b = await start(t, { sceneTitles: true });
  const doneB = await until(t, b.json.validationId);
  assert.notEqual(doneA.result.artifact.sha256, doneB.result.artifact.sha256, 'different options, different bytes, different validation');
  const fileB = await t.member('GET', `${V}/${b.json.validationId}/file`);
  assert.equal(sha(fileB.bytes), doneB.result.artifact.sha256);
  for (const p of ['/val_nope', '/val_nope/file', '/val_nope/report']) assert.equal((await t.member('GET', `${V}${p}`)).status, 404, p);
  assert.equal((await t.member('POST', `${V}/val_nope/cancel`, {})).status, 404);
  assert.equal((await t.member('GET', `/api/books/book_01S5000000000000000000NONE/export/validations/${b.json.validationId}`)).status, 404);
  assert.equal((await t.member('POST', '/api/books/book_01S5000000000000000000NONE/export/validations', {})).status, 404);
});

test('strict bodies: 400 for unknown fields, summary and evidence, wrong types; nothing starts', async () => {
  const t = await boot();
  const runner = fakeRunner(() => okReport());
  epubValidations.setHooks({ runEpubCheck: runner, toValidation: fakeToValidation });
  for (const body of [{ include: 'summary' }, { include: 'evidence' }, { include: 'nonsense' }, { format: 'epub' }, { sceneTitles: 1 }, { excludeStatuses: 'final' }, { excludeStatuses: ['a b'] }, { scenes: [5] }, { scenes: ['../x'] }, { page: 'a4' }]) {
    const r = await start(t, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
  }
  assert.equal((await t.member('POST', `${V}/val_X/cancel`, { x: 1 })).status, 400);
  assert.equal(runner.calls.length, 0);
  const ok = await start(t, { sceneTitles: true, excludeStatuses: ['final'], include: 'manuscript' });
  assert.equal(ok.status, 202, ok.text);
  await until(t, ok.json.validationId);
});

test('finished validations are kept for 30 minutes (injectable clock) and then forgotten', async () => {
  let now = 1_000_000;
  const jobs = createEpubValidations({ now: () => now, tools, runEpubCheck: fakeRunner(() => okReport()), toValidation: fakeToValidation });
  const repository = { listLiveScenes: async () => ({ ok: true, scenes: [] }) };
  const started = jobs.start({ repository, bookId: BOOK, file: { bytes: Buffer.from('epub'), filename: 'x.epub' }, sourceMap: {} });
  assert.equal(started.ok, true);
  assert.equal(jobs.start({ repository, bookId: BOOK, file: { bytes: Buffer.from('other'), filename: 'x.epub' }, sourceMap: {} }).code, 'VALIDATION_RUNNING');
  for (let i = 0; i < 200 && jobs.status(BOOK, started.validationId).state === 'running'; i += 1) await sleep(5);
  assert.notEqual(jobs.status(BOOK, started.validationId), null);
  now += 29 * 60 * 1000;
  assert.notEqual(jobs.status(BOOK, started.validationId), null);
  now += 2 * 60 * 1000;
  assert.equal(jobs.status(BOOK, started.validationId), null);
  assert.equal(jobs.file(BOOK, started.validationId), null);
});

// ------------------------------------------------------------------------------------------------------------------------------ checks/epub

test('POST checks/epub: saves checks.epub.validate in book.md, shows in the effective preferences, unchanged the second time, 400 for each bad body, 404 for an unknown book', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const defaults = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(defaults.json.effective.checks.epub.validate, false);
  const on = await t.member('POST', `${B}/checks/epub`, { validate: true });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.json, { ok: true, epub: { validate: true } });
  assert.equal((await t.member('GET', `/api/preferences?book=${BOOK}`)).json.effective.checks.epub.validate, true);
  assert.match(await fs.readFile(path.join(t.root, 'book.md'), 'utf8'), /epub:\n\s+validate: true/);
  const same = await t.member('POST', `${B}/checks/epub`, { validate: true });
  assert.deepEqual(same.json, { ok: true, epub: { validate: true }, unchanged: true });
  const off = await t.member('POST', `${B}/checks/epub`, { validate: false });
  assert.deepEqual(off.json, { ok: true, epub: { validate: false } });
  for (const body of [{}, { validate: 'yes' }, { validate: true, other: 1 }, { enabled: true }]) assert.equal((await t.member('POST', `${B}/checks/epub`, body)).status, 400, JSON.stringify(body));
  assert.equal((await t.member('POST', '/api/books/book_01S5000000000000000000NONE/checks/epub', { validate: true })).status, 404);
});
