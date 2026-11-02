// M05-J01 acceptance 7: repository.getContinuity(bookId), GET /api/books/:b/continuity, and the CLI
//   node apps/server/src/main.mjs continuity --library <path> [--book <slug>] [--json]     exit 0 without error findings, 1 with.
// Contract: docs/contracts/M05-J01-continuity-rules.md sections 4 and 6.7.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkContinuity } from '../../../packages/continuity/src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';
import { runCli, killAll } from './proc-helpers.mjs';
import { BOOK, UNKNOWN_BOOK, closeAll, freshBook, send } from './move-helpers.mjs';

after(async () => {
  await closeAll();
  await killAll();
});

const MAREN = 'codex/characters/maren-hollis.md';
const u = (b = BOOK) => `/api/books/${b}/continuity`;
const put = async (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, text);
};
const EVENTS = {
  'planning/timeline/pell-dies.md': `---
schema: storyforge.event/v1
id: event_01T6000000000000000000AA01
slug: pell-dies
title: Pell dies
order: 9000
state:
  - { slug: pell, event: died }
---
Pell dies.
`,
  'planning/timeline/pell-dines.md': `---
schema: storyforge.event/v1
id: event_01T6000000000000000000AA02
slug: pell-dines
title: Pell dines
order: 9100
characters: [pell]
---
Pell dines.
`,
};
const addErrorFinding = async (root) => {
  for (const [rel, text] of Object.entries(EVENTS)) await put(root, rel, text);
};

/** Every array called `findings` anywhere in a parsed --json document (its top-level shape is the CLI's business). */
function findingsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findingsIn(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'findings' && Array.isArray(v)) out.push(...v);
      else findingsIn(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- repository + route

test('GET /continuity returns the ContinuityResult of the book (same as the engine), 200 json', async () => {
  const { root, port } = await freshBook();
  const res = await send(port, 'GET', u());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const engine = JSON.parse(JSON.stringify(await checkContinuity(root)));
  assert.deepEqual(res.json, engine);
  assert.equal(res.json.engine_version, 1);
  for (const k of ['findings', 'suppressed', 'stale_exceptions', 'skipped']) assert.ok(Array.isArray(res.json[k]), k);
  const cf1 = res.json.findings.filter((f) => f.rule === 'CF1');
  assert.equal(cf1.length, 1);
  assert.equal(cf1[0].subject.slug, 'maren-hollis');
  assert.equal(cf1[0].sources[0].file, MAREN);
  assert.equal(cf1[0].sources[1].line, 17);
});

test('repository.getContinuity(bookId) resolves to the same result as the route', async () => {
  const { port, repo } = await freshBook();
  const viaRepo = JSON.parse(JSON.stringify(await repo.getContinuity(BOOK)));
  assert.deepEqual(viaRepo, (await send(port, 'GET', u())).json);
});

test('GET /continuity for an unknown book is 404, like the other routes', async () => {
  const { port } = await freshBook();
  const res = await send(port, 'GET', u(UNKNOWN_BOOK));
  assert.equal(res.status, 404);
  assert.equal((await send(port, 'GET', `/api/books/${UNKNOWN_BOOK}/threads`)).status, 404, 'sanity: same status as a sibling route');
});

test('the route recomputes from the files: editing the canon value changes the answer', async () => {
  const { root, port } = await freshBook();
  assert.equal((await send(port, 'GET', u())).json.findings.filter((f) => f.rule === 'CF1').length, 1);
  const f = path.join(root, ...MAREN.split('/'));
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('Eyes: Grey', 'Eyes: Green'));
  assert.equal((await send(port, 'GET', u())).json.findings.filter((f2) => f2.rule === 'CF1').length, 0);
});

test('the route shows a suppressed finding after an exception file appears', async () => {
  const { root, port } = await freshBook();
  const fp = (await send(port, 'GET', u())).json.findings.find((f) => f.rule === 'CF1').fingerprint;
  await put(root, 'planning/continuity/maren-eyes.md', `---
schema: storyforge.continuity-exception/v1
id: note_01T6000000000000000000AA03
slug: maren-eyes
fingerprint: ${fp}
rule: CF1
title: Green on purpose
created: "2026-11-02"
---
Deliberate.
`);
  const res = (await send(port, 'GET', u())).json;
  assert.equal(res.findings.filter((f) => f.rule === 'CF1').length, 0);
  assert.equal(res.suppressed.length, 1);
  assert.equal(res.suppressed[0].finding.fingerprint, fp);
});

test('GET /continuity writes nothing to the book', async () => {
  const { root, port } = await freshBook();
  const before = await snapshot(root, { skipStoryforge: true });
  await send(port, 'GET', u());
  await send(port, 'GET', u());
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

// ---------------------------------------------------------------- CLI

test('CLI: a book whose findings are only warnings exits 0 and names both sources in plain text', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const r = await runCli(['continuity', '--library', root]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /maren-hollis\.md/);
  assert.match(r.stdout, /0010-arrival\.md/);
  assert.match(r.stdout, /CF1/i);
});

test('CLI: error-severity findings exit 1', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await addErrorFinding(root);
  const r = await runCli(['continuity', '--library', root]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stdout, /pell-dines\.md/);
});

test('CLI --json prints parseable JSON containing the finding, and exit code follows the same rule', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const warn = await runCli(['continuity', '--library', root, '--json']);
  assert.equal(warn.code, 0, warn.output);
  const parsed = JSON.parse(warn.stdout);
  const engine = await checkContinuity(root);
  const fps = findingsIn(parsed).map((f) => f.fingerprint);
  assert.deepEqual(fps, engine.findings.map((f) => f.fingerprint));
  assert.ok(fps.length >= 1);

  await addErrorFinding(root);
  const err = await runCli(['continuity', '--library', root, '--json']);
  assert.equal(err.code, 1, err.output);
  assert.ok(findingsIn(JSON.parse(err.stdout)).some((f) => f.severity === 'error' && f.rule.startsWith('TL1')));
});

test('CLI --book <slug> selects the book', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const r = await runCli(['continuity', '--library', root, '--book', 'salt-orchard', '--json']);
  assert.equal(r.code, 0, r.output);
  assert.ok(findingsIn(JSON.parse(r.stdout)).some((f) => f.rule === 'CF1'));
});

test('CLI is read-only: every file byte-identical afterwards, no lock file left behind', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const before = await snapshot(root);
  const r = await runCli(['continuity', '--library', root, '--json']);
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(await snapshot(root), before);
});

test('CLI works while another process holds the library lock (it does not need the lock)', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await fs.writeFile(path.join(root, '.storyforge-lock'), JSON.stringify({ pid: process.pid, started: 'x' }));
  const r = await runCli(['continuity', '--library', root]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /maren-hollis\.md/);
});
