// M07-J02 acceptance 2: a revision task made from a finding opens its source and finishes without changing prose.
//   POST /api/books/:b/tasks                 { from: 'continuity', fingerprint } | { from: 'check', sceneId, finding } | { title, targets?, notes?, labels? }
//   GET  /api/books/:b/tasks[?status=&label=&source=]    GET /api/books/:b/tasks/:id (the task and where each target is now)
//   POST /api/books/:b/tasks/:id/status      { status: open | doing | done | dropped }  (a single-line front-matter edit)
// Contract: docs/contracts/M07-J02-goals-analytics-tasks.md section 4 and acceptance 2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { ARRIVAL, BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(closeAll);

const FP = 'cf1-e85d78f4354c4ffc';
const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const u = (...p) => `/api/books/${BOOK}/tasks${p.length ? `/${p.join('/')}` : ''}`;
const isReceipt = (p) => p.startsWith('provenance/');
/** The whole book except receipts: path -> Buffer. */
const book = async (root) => new Map([...(await readAll(root))].filter(([p]) => !isReceipt(p)));
const changedPaths = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((p) => !a.has(p) || !b.has(p) || !a.get(p).equals(b.get(p))).sort();
const errorKeys = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}|${d.file}|${d.location}`);

test('2. a task from a continuity finding: made, opened (scene and selection), marked done; every other file stays byte for byte', async () => {
  const ctx = await freshBook();
  const errorsBefore = await errorKeys(ctx.root);
  const s0 = await book(ctx.root);

  const made = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(made.json.file, `planning/tasks/${made.json.slug}.md`);
  const s1 = await book(ctx.root);
  assert.deepEqual(changedPaths(s0, s1), [made.json.file], 'making a task writes exactly one new file');
  assert.deepEqual(await errorKeys(ctx.root), errorsBefore, 'no new validation errors');
  const diags = (await validate(ctx.root)).diagnostics.filter((d) => d.file === made.json.file);
  assert.deepEqual(diags, [], 'the task file is clean');

  // the file: front matter in the contract's shape, the finding's message and quotes copied into the body
  const raw = s1.get(made.json.file).toString('utf8');
  assert.match(raw, /^---\nschema: storyforge\.task\/v1\nid: note_/);
  assert.match(raw, /\nstatus: open\n/);
  assert.match(raw, new RegExp(`\\nsource: \\{ kind: continuity, code: "CF1", fingerprint: ${FP} \\}\\n`));
  assert.match(raw, new RegExp(`\\n  - \\{ id: ${ARRIVAL}, line: 17, quote: "green eyes", sha256: [0-9a-f]{64} \\}\\n`));
  assert.match(raw, /green eyes ringed with salt/, 'the evidence is in the notes');

  // open: the scene and the selection
  const opened = await send(ctx.port, 'GET', u(made.json.id));
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.task.status, 'open');
  assert.equal(opened.json.targets.length, 1);
  const t = opened.json.targets[0];
  assert.deepEqual([t.id, t.kind, t.path, t.found, t.changed], [ARRIVAL, 'scene', ARRIVAL_PATH, true, false]);
  assert.deepEqual([t.selection.text, t.selection.file_line, t.selection.line], ['green eyes', 17, 3]);
  const scene = (await send(ctx.port, 'GET', `/api/books/${BOOK}/scenes/${ARRIVAL}`)).json;
  assert.equal(scene.body.slice(t.selection.from, t.selection.to), 'green eyes', 'from / to are offsets in the scene body');
  assert.deepEqual(changedPaths(s1, await book(ctx.root)), [], 'opening writes nothing');

  // by id or by slug; unknown ones are 404
  assert.equal((await send(ctx.port, 'GET', u(made.json.slug))).status, 200);
  assert.equal((await send(ctx.port, 'GET', u('note_01ZZZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);

  // the same finding cannot make a second open task: the existing one is offered
  const again = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'TASK_EXISTS');
  assert.equal(again.json.existing.id, made.json.id);
  assert.deepEqual(changedPaths(s1, await book(ctx.root)), [], 'the refused request wrote nothing');

  // doing, then done: one line of the task file changes, nothing else in the book
  const doing = await send(ctx.port, 'POST', u(made.json.id, 'status'), { body: { status: 'doing' } });
  assert.equal(doing.status, 200, doing.text);
  const done = await send(ctx.port, 'POST', u(made.json.slug, 'status'), { body: { status: 'done' } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.status, 'done');
  const s2 = await book(ctx.root);
  assert.deepEqual(changedPaths(s0, s2), [made.json.file], 'every file but the task is unchanged');
  const before = s1.get(made.json.file).toString('utf8').split('\n');
  const after = s2.get(made.json.file).toString('utf8').split('\n');
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((l, i) => (l === before[i] ? null : l)).filter(Boolean), ['status: done'], 'a single front-matter line changed');
  assert.equal(s2.get(ARRIVAL_PATH).toString('utf8'), s0.get(ARRIVAL_PATH).toString('utf8'), 'the prose is byte for byte what it was');
  assert.deepEqual(await errorKeys(ctx.root), errorsBefore);

  // same status again is a no-op; a bad status is refused; the list and its counts follow
  assert.equal((await send(ctx.port, 'POST', u(made.json.id, 'status'), { body: { status: 'done' } })).status, 200);
  assert.deepEqual(changedPaths(s2, await book(ctx.root)), []);
  assert.equal((await send(ctx.port, 'POST', u(made.json.id, 'status'), { body: { status: 'finished' } })).status, 400);
  const list = (await send(ctx.port, 'GET', u())).json;
  assert.deepEqual(list.counts, { open: 0, doing: 0, done: 1, dropped: 0, total: 1 });
  assert.equal((await send(ctx.port, 'GET', `${u()}?status=open`)).json.tasks.length, 0);
  assert.equal((await send(ctx.port, 'GET', `${u()}?status=done&source=continuity`)).json.tasks.length, 1);
  assert.equal((await send(ctx.port, 'GET', `${u()}?source=manual`)).json.tasks.length, 0);
  assert.equal((await send(ctx.port, 'GET', `${u()}?status=weird`)).status, 400);

  // a finished finding may make a new task
  const second = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal(second.status, 201, second.text);
  assert.notEqual(second.json.slug, made.json.slug);
});

test('2. an unknown fingerprint makes nothing (404 FINDING_NOT_FOUND); bad bodies are 400; the write guard still applies', async () => {
  const ctx = await freshBook();
  const s0 = await book(ctx.root);
  const nf = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: 'cf1-0123456789abcdef' } });
  assert.equal(nf.status, 404);
  assert.equal(nf.json.code, 'FINDING_NOT_FOUND');
  assert.equal((await send(ctx.port, 'POST', u(), { body: { from: 'continuity' } })).status, 400);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { from: 'nowhere' } })).status, 400);
  assert.equal((await send(ctx.port, 'POST', u(), { body: {} })).status, 400, 'a manual task needs a title');
  assert.equal((await send(ctx.port, 'POST', u(), { body: { title: 'x\ny' } })).status, 400);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { title: 'x', targets: [{ id: 'scene_01ZZZZZZZZZZZZZZZZZZZZZZZZ' }] } })).status, 400);
  assert.equal((await send(ctx.port, 'POST', `/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/tasks`, { body: { title: 'x' } })).status, 404);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { title: 'x' }, headers: { 'content-type': 'application/json' } })).status, 403, 'no x-storyforge header');
  assert.deepEqual(changedPaths(s0, await book(ctx.root)), []);
});

test('manual tasks: any title, optional targets, labels, notes; the slug is made unique; the file validates', async () => {
  const ctx = await freshBook();
  const body = { title: "Ilse's eyes: grey in ch 2, green in ch 9", notes: 'Pick one and fix the other.', labels: ['Eyes'], targets: [{ id: ARRIVAL, line: 17, quote: 'green eyes' }] };
  const a = await send(ctx.port, 'POST', u(), { body });
  assert.equal(a.status, 201, a.text);
  const b = await send(ctx.port, 'POST', u(), { body: { title: body.title } });
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.slug, `${a.json.slug}-2`);
  const list = (await send(ctx.port, 'GET', u())).json;
  assert.deepEqual(list.tasks.map((t) => [t.source.kind, t.status]), [['manual', 'open'], ['manual', 'open']]);
  assert.deepEqual(list.labels, ['Eyes']);
  assert.equal((await send(ctx.port, 'GET', `${u()}?label=eyes`)).json.tasks.length, 1, 'labels compare case-insensitively');
  const opened = (await send(ctx.port, 'GET', u(a.json.id))).json;
  assert.equal(opened.notes.trim(), 'Pick one and fix the other.');
  assert.equal(opened.targets[0].found, true);
  const noTarget = (await send(ctx.port, 'GET', u(b.json.id))).json;
  assert.deepEqual(noTarget.targets, []);
  const diags = (await validate(ctx.root)).diagnostics.filter((d) => d.file.startsWith('planning/tasks/'));
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), []);
  // a dry run writes nothing and shows the file
  const s0 = await book(ctx.root);
  const dry = await send(ctx.port, 'POST', u(), { body: { title: 'Dry', dryRun: true } });
  assert.equal(dry.status, 201);
  assert.equal(dry.json.dryRun, true);
  assert.match(dry.json.text, /^---\nschema: storyforge\.task\/v1/);
  assert.deepEqual(changedPaths(s0, await book(ctx.root)), []);
});

test('opening a target: the line first, then the one place the quote occurs; moved text is found, reworded or doubled text is not guessed', async () => {
  const ctx = await freshBook();
  const made = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal(made.status, 201);
  const file = path.join(ctx.root, ...ARRIVAL_PATH.split('/'));
  const original = await fs.readFile(file, 'utf8');
  const open = async () => (await send(ctx.port, 'GET', u(made.json.id))).json.targets[0];

  // text moved down two lines: the line no longer holds the quote, the quote is still in one place
  await fs.writeFile(file, original.replace('\n---\n', '\n---\nA new first line.\nAnother.\n'));
  let t = await open();
  assert.equal(t.found, true);
  assert.equal(t.selection.text, 'green eyes');
  assert.equal(t.selection.file_line, 19);
  assert.equal(t.changed, true, 'the scene changed since the task was made');

  // the quote now occurs twice, on other lines: not guessed
  await fs.writeFile(file, `${original}\nShe had green eyes, everyone said so.\n`);
  t = await open();
  assert.equal(t.found, true, 'the line still holds it');
  assert.equal(t.selection.file_line, 17);
  await fs.writeFile(file, original.replace('green eyes ringed', 'eyes ringed').replace('\n---\n', '\n---\nShe had green eyes, and green eyes.\n'));
  t = await open();
  assert.equal(t.found, false);
  assert.equal(t.reason, 'several');
  assert.equal(t.selection, null);
  assert.match(t.message, /did not guess/);
  assert.equal(t.id, ARRIVAL, 'the scene still opens');

  // reworded: not found, and it says so
  await fs.writeFile(file, original.replace('green eyes', 'jade eyes'));
  t = await open();
  assert.equal(t.found, false);
  assert.equal(t.reason, 'not_found');
  assert.match(t.message, /can no longer be found/);

  // the scene is gone: the target is reported missing, the task still opens
  await fs.rm(file);
  t = await open();
  assert.equal(t.found, false);
  assert.equal(t.reason, 'missing');
});

test('a task from an author-check finding: source check, the same finding cannot make two open tasks, and a check finding for a continuity fingerprint offers the continuity task', async () => {
  const ctx = await freshBook();
  const report = (await send(ctx.port, 'POST', `/api/books/${BOOK}/check`, { body: { sceneId: ARRIVAL } })).json;
  assert.ok(report.findings.length > 0, 'the check reports something for Arrival');
  const f = report.findings.find((x) => x.kind === 'continuity');
  assert.ok(f, 'a continuity finding in the report');
  const s0 = await book(ctx.root);

  const made = await send(ctx.port, 'POST', u(), { body: { from: 'check', sceneId: ARRIVAL, finding: f } });
  assert.equal(made.status, 201, made.text);
  const task = (await send(ctx.port, 'GET', u(made.json.id))).json;
  assert.deepEqual([task.task.source.kind, task.task.source.code, task.task.source.fingerprint], ['check', 'CF1', FP]);
  assert.equal(task.targets[0].found, true);
  assert.deepEqual(changedPaths(s0, await book(ctx.root)), [made.json.file]);
  const dup = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal(dup.status, 409, 'the continuity page sees the check task');
  assert.equal(dup.json.existing.id, made.json.id);

  // a finding with no fingerprint (a validator diagnostic) gets a chk- fingerprint made from its content: the same one cannot make two tasks
  const diag = { severity: 'warning', kind: 'diagnostic', code: 'W999', file: ARRIVAL_PATH, line: 17, range: null, evidence: 'green eyes ringed with salt', message: 'Something to look at.' };
  const one = await send(ctx.port, 'POST', u(), { body: { from: 'check', sceneId: ARRIVAL, finding: diag } });
  assert.equal(one.status, 201, one.text);
  const t1 = (await send(ctx.port, 'GET', u(one.json.id))).json;
  assert.match(t1.task.source.fingerprint, /^chk-[0-9a-f]{16}$/);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { from: 'check', sceneId: ARRIVAL, finding: diag } })).status, 409);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { from: 'check', sceneId: ARRIVAL, finding: { code: 'x' } } })).status, 400);
  assert.equal((await send(ctx.port, 'POST', u(), { body: { from: 'check', sceneId: 'scene_01ZZZZZZZZZZZZZZZZZZZZZZZZ', finding: diag } })).status, 404);
});

test('legacy planning/tasks docs stay plain docs: not listed as tasks, not converted, not touched', async () => {
  const legacy = '---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000009\ntitle: Old task list\n---\n- [ ] fix the ferry\n';
  const ctx = await freshBook('valid/salt-orchard', async (root) => {
    await fs.mkdir(path.join(root, 'planning/tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'planning/tasks/old-list.md'), legacy);
  });
  const list = (await send(ctx.port, 'GET', u())).json;
  assert.deepEqual(list.tasks, []);
  assert.equal((await send(ctx.port, 'GET', u('note_01J00000000000000000000009'))).status, 404);
  const made = await send(ctx.port, 'POST', u(), { body: { title: 'Fresh one' } });
  assert.equal(made.status, 201);
  assert.equal(await fs.readFile(path.join(ctx.root, 'planning/tasks/old-list.md'), 'utf8'), legacy);
  assert.deepEqual((await send(ctx.port, 'GET', u())).json.tasks.map((t) => t.title), ['Fresh one']);
});

test('a task made by mistake is dropped, not deleted: the file stays, its status says dropped, nothing else moves', async () => {
  const ctx = await freshBook();
  const s0 = await book(ctx.root);
  const made = await send(ctx.port, 'POST', u(), { body: { from: 'continuity', fingerprint: FP } });
  assert.equal((await send(ctx.port, 'POST', u(made.json.id, 'status'), { body: { status: 'dropped' } })).status, 200);
  assert.deepEqual(changedPaths(s0, await book(ctx.root)), [made.json.file]);
  assert.deepEqual((await send(ctx.port, 'GET', u())).json.counts, { open: 0, doing: 0, done: 0, dropped: 1, total: 1 });
});
