// M05-J06 acceptance 1 (app half) and 7 (check.report): POST /api/books/:b/check { sceneId } is a report only.
//   -> { scene, at, findings: [{ severity, kind: 'diagnostic'|'continuity', code, file, line, range, evidence, message, fingerprint? }], summary }
// No model call, no write: the whole book tree (bytes, mtimes, file list) is identical afterwards and the network recorder (M05-J04) sees zero calls.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 2 and 6.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { __hooks } from '../../../packages/core/src/hooks.mjs';
import { validate } from '../../../packages/format/src/index.mjs';
import { freshLibrary, makeHome, setupProvider, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { closeAll, freshBook, send } from './move-helpers.mjs';
import { ARRIVAL, ARRIVAL_PATH, BOOK, CF1, KEY, SUG, changedPaths, linesOf, readText, tree } from './suggest-helpers.mjs';

after(async () => {
  await stopAll();
  await closeAll();
});
afterEach(() => {
  __hooks.onProvenance = undefined;
});

const findCf1 = (report) => report.findings.find((f) => f.fingerprint === CF1);

test('check Arrival on salt-orchard: the CF1 finding carries file:line evidence; book tree identical afterwards; no model call, zero network calls', async () => {
  const mock = await startMockProvider({ reply: 'SHOULD NEVER BE ASKED' });
  try {
    const library = await freshLibrary();
    const home = await makeHome();
    const app = await startApp({ library, home, net: true });
    await setupProvider(app, { baseUrl: mock.baseUrl }); // a provider IS configured, so a model call would be possible
    const before = await tree(library);

    const r = await app.post(SUG.check(), { sceneId: ARRIVAL });
    assert.equal(r.status, 200, r.text);
    const report = r.json;
    assert.ok(Array.isArray(report.findings));
    assert.equal(typeof report.at, 'string');
    assert.ok(report.summary && typeof report.summary === 'object', 'summary present');
    assert.ok(JSON.stringify(report.scene).includes(ARRIVAL), 'report names the scene');

    const cf1 = findCf1(report);
    assert.ok(cf1, `CF1 finding present in ${JSON.stringify(report.findings.map((f) => f.fingerprint ?? f.code))}`);
    assert.equal(cf1.kind, 'continuity');
    assert.equal(cf1.code, 'CF1');
    assert.equal(cf1.severity, 'warning');
    assert.equal(cf1.file, ARRIVAL_PATH);
    assert.equal(cf1.line, 17);
    // the evidence is the real text of that line in the file
    const line17 = linesOf(await readText(library, ARRIVAL_PATH))[16];
    assert.ok(cf1.evidence.includes('green eyes ringed with salt') && line17.includes(cf1.evidence.trim()), `evidence ${cf1.evidence}`);
    assert.ok(cf1.range && Number.isInteger(cf1.range.from) && cf1.range.to > cf1.range.from, 'range');
    assert.equal(typeof cf1.message, 'string');

    // read-only: bytes, mtimes and the file list of the whole book (bookkeeping folder aside) are untouched
    assert.deepEqual(changedPaths(before, await tree(library)), []);
    // no model call
    assert.equal(mock.calls.length, 0, 'the provider was never called');
    assert.deepEqual(await app.netCalls(), [], 'zero outbound network calls');
    await app.stop();
  } finally {
    await mock.close();
  }
});

test('check works with no provider configured and a different scene has no CF1', async () => {
  const library = await freshLibrary();
  const app = await startApp({ library, home: await makeHome(), net: true });
  const r = await app.post(SUG.check(), { sceneId: KEY });
  assert.equal(r.status, 200, r.text);
  assert.equal(findCf1(r.json), undefined);
  assert.deepEqual(await app.netCalls(), []);
  await app.stop();
});

test('check reports the validator diagnostics of the scene (code, severity, file, line) and writes nothing', async () => {
  const library = await freshLibrary();
  const file = path.join(library, ...ARRIVAL_PATH.split('/'));
  await fs.appendFile(file, '\nHe met [[ghost-person]] there.\n');
  const expected = (await validate(library)).diagnostics.filter((d) => d.file === ARRIVAL_PATH);
  assert.ok(expected.length >= 1, 'oracle: the validator flags the broken link');
  const app = await startApp({ library, home: await makeHome(), net: true });
  const before = await tree(library);
  const r = await app.post(SUG.check(), { sceneId: ARRIVAL });
  assert.equal(r.status, 200, r.text);
  for (const d of expected) {
    const line = Number(/line (\d+)/.exec(d.location ?? '')?.[1]);
    const f = r.json.findings.find((x) => x.kind === 'diagnostic' && x.code === d.code && x.file === d.file && x.line === line);
    assert.ok(f, `diagnostic ${d.code} ${d.file}:${line} in report`);
    assert.equal(f.severity, d.severity);
    assert.equal(typeof f.message, 'string');
  }
  assert.deepEqual(changedPaths(before, await tree(library)), []);
  assert.deepEqual(await app.netCalls(), []);
  await app.stop();
});

test('check refuses an unknown scene (404) and a missing sceneId (4xx) and writes nothing', async () => {
  const library = await freshLibrary();
  const app = await startApp({ library, home: await makeHome() });
  const before = await tree(library);
  const unknown = await app.post(SUG.check(), { sceneId: 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ' });
  assert.equal(unknown.status, 404, unknown.text);
  const missing = await app.post(SUG.check(), {});
  assert.ok(missing.status >= 400 && missing.status < 500, `status ${missing.status}`);
  const noBook = await app.post(SUG.check('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), { sceneId: ARRIVAL });
  assert.equal(noBook.status, 404);
  assert.deepEqual(changedPaths(before, await tree(library)), []);
  await app.stop();
});

test('check is a POST behind the write guard (no x-storyforge header -> refused)', async () => {
  const { port } = await freshBook();
  const r = await send(port, 'POST', SUG.check(), { headers: { 'content-type': 'application/json' }, body: { sceneId: ARRIVAL } });
  assert.ok([400, 403, 405].includes(r.status), `status ${r.status}`);
});

test('provenance: check emits exactly one check.report event naming the scene, and no other kind', async () => {
  const { root, port } = await freshBook();
  const before = await tree(root);
  const seen = [];
  __hooks.onProvenance = (e) => seen.push(e);
  const r = await send(port, 'POST', SUG.check(BOOK), { body: { sceneId: ARRIVAL } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(seen.map((e) => e.kind), ['check.report']);
  assert.ok(JSON.stringify(seen[0]).includes(ARRIVAL), 'event names the scene');
  assert.deepEqual(changedPaths(before, await tree(root)), [], 'read-only in-process too');
});
