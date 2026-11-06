// Story Planner M6 (ADR 0003): the planner rule family in GET /continuity, and the `intentional` flag on POST /continuity/exceptions.
//   GET  /api/books/:b/continuity
//   POST /api/books/:b/continuity/exceptions | /api/books/:b/tasks
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(async () => {
  await closeAll();
});

const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const get = (port, url) => send(port, 'GET', url);
const continuity = async (port) => (await get(port, u('continuity'))).json;
const planner = () => freshBook('valid/planner');
const isPlan = (f) => /^PL[1-4]$/.test(f.rule);

test('GET /continuity: the planner fixture yields PL findings with codes, subjects, sources and stable fingerprints', async () => {
  const { port } = await planner();
  const a = await continuity(port);
  const plan = a.findings.filter(isPlan);
  assert.ok(plan.length > 0, 'the planner fixture has at least one plan finding');
  for (const f of plan) {
    assert.match(f.fingerprint, new RegExp(`^${f.rule.toLowerCase()}-[0-9a-f]{16}$`));
    assert.equal(f.rule_version, 1);
    assert.ok(['info', 'warning'].includes(f.severity), `${f.rule} is never an error`);
    assert.ok(f.subject && typeof f.subject.id === 'string');
    assert.ok(f.sources.length >= 1 && typeof f.sources[0].file === 'string');
    assert.doesNotMatch(f.message, /missing from the story/i);
  }
  const b = await continuity(port);
  assert.deepEqual(b.findings.filter(isPlan).map((f) => f.fingerprint), plan.map((f) => f.fingerprint), 'same fingerprints on a second read');
});

test('POST /continuity/exceptions: intentional true is written and reported; a non-boolean is a 400 that writes nothing', async () => {
  const { port, root } = await planner();
  const f = (await continuity(port)).findings.find(isPlan);
  const before = await readAll(root);
  const bad = await post(port, u('continuity', 'exceptions'), { fingerprint: f.fingerprint, rationale: 'On purpose.', intentional: 'yes' });
  assert.equal(bad.status, 400);
  assert.deepEqual([...(await readAll(root)).keys()].sort(), [...before.keys()].sort());

  const ok = await post(port, u('continuity', 'exceptions'), { fingerprint: f.fingerprint, rationale: 'On purpose.', intentional: true });
  assert.equal(ok.status, 201);
  const text = (await readAll(root)).get(ok.json.file).toString('utf8');
  assert.match(text, /^intentional: true$/m);
  const after2 = await continuity(port);
  assert.ok(!after2.findings.some((x) => x.fingerprint === f.fingerprint));
  const s = after2.suppressed.find((x) => x.finding.fingerprint === f.fingerprint);
  assert.equal(s.exception.intentional, true);
});

test('POST /continuity/exceptions: without intentional the file has no flag and the exception reports false', async () => {
  const { port, root } = await planner();
  const f = (await continuity(port)).findings.find(isPlan);
  const ok = await post(port, u('continuity', 'exceptions'), { fingerprint: f.fingerprint, rationale: 'Fine for now.' });
  assert.equal(ok.status, 201);
  assert.doesNotMatch((await readAll(root)).get(ok.json.file).toString('utf8'), /intentional/);
  const s = (await continuity(port)).suppressed.find((x) => x.finding.fingerprint === f.fingerprint);
  assert.equal(s.exception.intentional, false);
});

test('POST /tasks from a plan finding: the task names the finding code and fingerprint', async () => {
  const { port } = await planner();
  const f = (await continuity(port)).findings.find(isPlan);
  const r = await post(port, u('tasks'), { from: 'continuity', fingerprint: f.fingerprint });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const t = (await get(port, u('tasks'))).json;
  const list = Array.isArray(t) ? t : t.tasks;
  const task = list.find((x) => x.source?.fingerprint === f.fingerprint);
  assert.ok(task, 'the new task is listed');
  assert.equal(task.source.code, f.rule);
});
