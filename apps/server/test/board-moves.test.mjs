// M04-J03 acceptance 4: board drag-and-drop is the M03-J03 move. Same route, `expect` (409 on stale), exact Undo
// (POST ops/:opId/restore, byte-identical) and the git-diff pattern (only position lines and paths change).
// Contract: docs/contracts/M04-J03-board-outline-threads.md sections 2.1, 3 and 4.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { copyFixture } from './helpers.mjs';
import {
  ARRIVAL, BOOK, FERRY, GRAFTING, KEY, LOWTIDE, ORIGINAL_ORDER, PROLOGUE, WALL,
  apiOrder, closeAll, freshBook, move, readAll, scenesById, send, startApi,
} from './move-helpers.mjs';

after(closeAll);

const ACT1 = 'manuscript/act-01-low-water';
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const restore = (port, opId) => send(port, 'POST', `/api/books/${BOOK}/ops/${encodeURIComponent(opId)}/restore`, { body: {} });
/** `expect` as the board builds it from a dry run (the files the drop would touch, with their hashes). */
const expectFrom = (plan) => plan.json.changes.map((c) => ({ path: c.from, sha256: c.before_sha256 })).filter((e) => e.sha256);
const sameFiles = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of paths');
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical`);
};

// ---------------------------------------------------------------- expect / 409

test('board drop: dry run first, then apply with expect from the dry run succeeds', async () => {
  const ctx = await freshBook();
  const target = { chapter: 3, after: LOWTIDE };
  const plan = await move(ctx.port, KEY, { ...target, dryRun: true });
  assert.equal(plan.status, 200, plan.text);
  const before = await readAll(ctx.root);
  const expect = expectFrom(plan);
  assert.ok(expect.length >= 1);
  sameFiles(before, await readAll(ctx.root)); // dry run wrote nothing
  const r = await move(ctx.port, KEY, { ...target, expect });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await apiOrder(ctx.port)).map((s) => s.id), [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, KEY, WALL]);
});

test('board drop with a stale expect (file edited after the preview) is 409 CONFLICT and writes nothing', async () => {
  const ctx = await freshBook();
  const target = { chapter: 3, after: LOWTIDE };
  const expect = expectFrom(await move(ctx.port, KEY, { ...target, dryRun: true }));
  const rel = `${ACT1}/ch-001-the-drowned-rows/0020-the-key.md`;
  const file = path.join(ctx.root, ...rel.split('/'));
  await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nEdited elsewhere.\n`);
  const before = await readAll(ctx.root);
  const r = await move(ctx.port, KEY, { ...target, expect });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'CONFLICT');
  assert.deepEqual(r.json.changed, [rel]);
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- board gestures as moves

test('Alt+Right equivalent: a card moves to the END of the next chapter (after = its last scene)', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, ARRIVAL, { chapter: 2, after: GRAFTING });
  assert.equal(r.status, 200, r.text);
  const order = await apiOrder(ctx.port);
  assert.deepEqual(order.map((s) => s.id), [PROLOGUE, KEY, FERRY, GRAFTING, ARRIVAL, LOWTIDE, WALL]);
  assert.equal(order.find((s) => s.id === ARRIVAL).chapter, 2);
  assert.deepEqual(await errorsOf(ctx.root), []);
});

test('Alt+Left equivalent: a card moves to the end of the previous chapter', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, FERRY, { chapter: 1, after: KEY });
  assert.equal(r.status, 200, r.text);
  const order = await apiOrder(ctx.port);
  assert.deepEqual(order.map((s) => s.id), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
  assert.equal(order.find((s) => s.id === FERRY).chapter, 1);
});

test('dragging the only card out of a chapter leaves the (empty) chapter on the board', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, PROLOGUE, { chapter: 1, after: KEY });
  assert.equal(r.status, 200, r.text);
  const book = (await send(ctx.port, 'GET', `/api/books/${BOOK}`)).json;
  const ch0 = book.acts.flatMap((a) => a.chapters).find((c) => c.chapter === 0);
  assert.ok(ch0, 'chapter 0 is still listed');
  assert.deepEqual(ch0.scenes, []);
});

test('moving a card never changes its summary, status, POV, thread tags or body', async () => {
  const ctx = await freshBook();
  const before = scenesById(await readAll(ctx.root)).get(KEY);
  await move(ctx.port, KEY, { chapter: 3, after: LOWTIDE });
  const after = scenesById(await readAll(ctx.root)).get(KEY);
  const keep = (fm) => fm.split(/\r?\n/).filter((l) => /^(summary|status|pov|plot_threads|characters|locations|title):/.test(l));
  assert.deepEqual(keep(after.fm), keep(before.fm));
  assert.ok(keep(before.fm).some((l) => l.startsWith('summary:')), 'fixture scene has a summary');
  assert.equal(after.body, before.body);
});

// ---------------------------------------------------------------- exact Undo

async function roundTrip(scene, body) {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await move(ctx.port, scene, body);
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string');
  assert.notDeepEqual([...(await readAll(ctx.root)).keys()].sort(), [...original.keys()].sort());
  const u = await restore(ctx.port, r.json.opId);
  assert.equal(u.status, 200, u.text);
  sameFiles(original, await readAll(ctx.root));
  assert.deepEqual((await apiOrder(ctx.port)).map((s) => s.id), ORIGINAL_ORDER);
  assert.deepEqual(await errorsOf(ctx.root), []);
}

test('Undo after a board move between chapters is byte-identical', () => roundTrip(ARRIVAL, { chapter: 2, after: GRAFTING }));
test('Undo after a board move across acts is byte-identical', () => roundTrip(WALL, { chapter: 2, after: FERRY }));
test('Undo after a board move within a column is byte-identical', () => roundTrip(GRAFTING, { chapter: 2, after: null }));
test('Undo of a board move of the CRLF grafting scene is byte-identical', () => roundTrip(GRAFTING, { chapter: 1, after: KEY }));

test('Undo is refused with 409 after an external edit to a touched file, and nothing is written', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, ARRIVAL, { chapter: 2, after: GRAFTING });
  const moved = scenesById(await readAll(ctx.root)).get(ARRIVAL).path;
  const file = path.join(ctx.root, ...moved.split('/'));
  await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nEdited elsewhere.\n`);
  const before = await readAll(ctx.root);
  const u = await restore(ctx.port, r.json.opId);
  assert.equal(u.status, 409, u.text);
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- git-diff pattern

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

test('git diff after board moves shows only renames and act/chapter/sequence lines', { skip: gitOk ? false : 'git is not on PATH' }, async () => {
  const root = await copyFixture('valid/salt-orchard');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'StoryForge Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.storyforge/\n.storyforge-lock\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'before');
  const { port } = await startApi(root);
  for (const [scene, body] of [[KEY, { chapter: 3, after: LOWTIDE }], [ARRIVAL, { chapter: 2, after: GRAFTING }], [WALL, { chapter: 1, after: null }]]) {
    const r = await move(port, scene, body);
    assert.equal(r.status, 200, r.text);
  }
  git(root, 'add', '-A');
  const names = git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--name-status').trim().split('\n').filter(Boolean);
  assert.ok(names.length >= 3);
  for (const line of names) {
    const [status, ...paths] = line.split('\t');
    assert.match(status, /^(R\d+|M)$/, line);
    for (const p of paths) assert.match(p, /^manuscript\/.+\/\d+-[^/]+\.md$/, p);
  }
  const patch = git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--unified=0', '--no-color');
  const changed = patch.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
  assert.ok(changed.length > 0);
  for (const l of changed) assert.match(l, /^[-+](act|chapter|sequence):[ \t]*-?\d+[ \t]*\r?$/, `only position lines: ${JSON.stringify(l)}`);
  assert.equal(git(root, 'diff', '--cached', '--name-only', '--', ':!manuscript').trim(), '');
});
