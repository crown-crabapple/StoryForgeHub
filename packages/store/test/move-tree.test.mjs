// moveTree: move a whole folder (a book) inside a library in one step, or not at all; and recovery of a
// moveTree journal entry left pending by a crash.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { moveTree } from '../src/index.mjs';
import { __faults } from '../src/faults.mjs';
import { listJournal, makeOpId, writeJournal } from '../src/journal.mjs';
import { recoverRoot } from '../src/recover.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const COVERS = 'valid/covers';
const exists = (p) => fs.stat(p).then(() => true, () => false);
const withoutStoryforge = (snap) => Object.fromEntries(Object.entries(snap).filter(([rel]) => !rel.startsWith('.storyforge/')));
const ownFiles = async (dir) => withoutStoryforge(await snapshot(dir));
const outsideStoryforge = ownFiles;

afterEach(() => {
  __faults.at = null;
  __faults.mode = 'throw';
});

test('moves a folder: contents identical, old place gone, journal entry archived as done', async () => {
  const root = await copyFixture(COVERS);
  const before = await ownFiles(path.join(root, 'north-road'));
  assert.ok(Object.keys(before).length > 3);

  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');
  assert.equal(r.path, 'harbour-lights/north-road');

  assert.equal(await exists(path.join(root, 'north-road')), false);
  assert.deepEqual(await ownFiles(path.join(root, 'harbour-lights', 'north-road')), before);

  assert.deepEqual(await listJournal(root, { live: true }), [], 'no live journal entry left');
  const mine = (await listJournal(root)).find((e) => e.opId === r.opId);
  assert.ok(mine, 'entry archived');
  assert.equal(mine.state, 'done');
  assert.equal(mine.op, 'moveTree');
  assert.deepEqual(mine.move, { from: 'north-road', to: 'harbour-lights/north-road' });
});

test('refuses FOLDER_EXISTS when the new place exists, and moves nothing', async () => {
  const root = await copyFixture(COVERS);
  await fs.mkdir(path.join(root, 'harbour-lights', 'north-road'));
  const before = await outsideStoryforge(root);
  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FOLDER_EXISTS');
  assert.deepEqual(await outsideStoryforge(root), before);
});

test('refuses NO_SUCH_FOLDER when the source is missing (or is a file)', async () => {
  const root = await copyFixture(COVERS);
  const a = await moveTree(root, 'no-such-book', 'harbour-lights/no-such-book');
  assert.equal(a.code, 'NO_SUCH_FOLDER');
  const b = await moveTree(root, 'library.md', 'harbour-lights/library.md');
  assert.equal(b.code, 'NO_SUCH_FOLDER');
  assert.equal(await exists(path.join(root, 'harbour-lights', 'library.md')), false);
});

test('refuses NO_PARENT when the parent of the new place does not exist', async () => {
  const root = await copyFixture(COVERS);
  const before = await outsideStoryforge(root);
  const r = await moveTree(root, 'north-road', 'no-such-series/north-road');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_PARENT');
  assert.deepEqual(await outsideStoryforge(root), before);
});

test('refuses OUTSIDE_ROOT for `..` paths and the .storyforge folder, either side', async () => {
  const root = await copyFixture(COVERS);
  const before = await outsideStoryforge(root);
  for (const [from, to] of [
    ['north-road', '../north-road'],
    ['north-road', 'harbour-lights/../../x'],
    ['../north-road', 'harbour-lights/north-road'],
    ['north-road', '.storyforge/x'],
    ['north-road', '.STORYFORGE/x'],
    ['.storyforge/trash', 'harbour-lights/trash'],
  ]) {
    const r = await moveTree(root, from, to);
    assert.equal(r.ok, false, `${from} -> ${to}`);
    // a path with `..` is not a clean relative path; the contract allows either refusal, never a move
    assert.ok(['OUTSIDE_ROOT', 'BAD_ARGS'].includes(r.code), `${from} -> ${to}: ${r.code}`);
    if (from.startsWith('.storyforge') || to.toLowerCase().startsWith('.storyforge')) assert.equal(r.code, 'OUTSIDE_ROOT');
  }
  assert.deepEqual(await outsideStoryforge(root), before);
});

test('refuses BAD_ARGS for same path, into itself, and malformed arguments', async () => {
  const root = await copyFixture(COVERS);
  const before = await outsideStoryforge(root);
  for (const [from, to] of [
    ['north-road', 'north-road'],
    ['north-road', 'north-road/inner'],
    ['', 'x'],
    ['north-road', ''],
    [undefined, 'x'],
    ['north-road', null],
    ['north-road', 'harbour-lights\\north-road'],
    ['north-road', '/abs/north-road'],
  ]) {
    const r = await moveTree(root, from, to);
    assert.equal(r.ok, false, `${from} -> ${to}`);
    assert.equal(r.code, 'BAD_ARGS', `${from} -> ${to}`);
  }
  assert.deepEqual(await outsideStoryforge(root), before);
});

test('a `before` hook that throws gives ROLLED_BACK and the folder stays at the old place', async () => {
  const root = await copyFixture(COVERS);
  const before = await ownFiles(path.join(root, 'north-road'));
  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road', {
    async before() {
      throw new Error('watch release failed');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROLLED_BACK');
  assert.match(r.message, /watch release failed/);
  assert.deepEqual(await ownFiles(path.join(root, 'north-road')), before);
  assert.equal(await exists(path.join(root, 'harbour-lights', 'north-road')), false);
  assert.deepEqual(await listJournal(root, { live: true }), [], 'entry settled');
  assert.equal((await listJournal(root)).find((e) => e.opId === r.opId)?.state, 'rolledBack');
});

test('the `before` hook receives the absolute path of the folder and runs before the rename', async () => {
  const root = await copyFixture(COVERS);
  let seen = null;
  let atOldWhenCalled = null;
  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road', {
    async before(fromAbs) {
      seen = fromAbs;
      atOldWhenCalled = await exists(fromAbs);
    },
  });
  assert.equal(r.ok, true);
  assert.equal(path.resolve(seen), path.resolve(root, 'north-road'));
  assert.equal(atOldWhenCalled, true);
});

test('fault before-tree-move: the folder stays at the old place and the journal says rolledBack', async () => {
  const root = await copyFixture(COVERS);
  const before = await ownFiles(path.join(root, 'north-road'));
  __faults.at = 'before-tree-move';
  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROLLED_BACK');
  assert.deepEqual(await ownFiles(path.join(root, 'north-road')), before);
  assert.equal(await exists(path.join(root, 'harbour-lights', 'north-road')), false);
  const entry = (await listJournal(root)).find((e) => e.opId === r.opId);
  assert.equal(entry?.state, 'rolledBack');
});

// ---- recovery of a pending moveTree entry

async function pendingMove(root, from, to) {
  const opId = makeOpId();
  await writeJournal(root, { opId, op: 'moveTree', args: { from, to }, at: new Date().toISOString(), state: 'pending', files: [], move: { from, to } });
  return opId;
}

test('recovery: pending moveTree with the folder at the new place -> completed', async () => {
  const root = await copyFixture(COVERS);
  const opId = await pendingMove(root, 'north-road', 'harbour-lights/north-road');
  await fs.rename(path.join(root, 'north-road'), path.join(root, 'harbour-lights', 'north-road'));
  const report = await recoverRoot(root);
  assert.deepEqual(report.completed.map((e) => e.opId), [opId]);
  assert.deepEqual(report.rolledBack, []);
  assert.deepEqual(report.needsAttention, []);
  assert.equal(await exists(path.join(root, 'harbour-lights', 'north-road')), true, 'recovery never moves it back');
  assert.equal((await listJournal(root)).find((e) => e.opId === opId).state, 'completed');
});

test('recovery: pending moveTree with the folder at the old place -> rolledBack', async () => {
  const root = await copyFixture(COVERS);
  const opId = await pendingMove(root, 'north-road', 'harbour-lights/north-road');
  const report = await recoverRoot(root);
  assert.deepEqual(report.rolledBack.map((e) => e.opId), [opId]);
  assert.deepEqual(report.completed, []);
  assert.deepEqual(report.needsAttention, []);
  assert.equal(await exists(path.join(root, 'north-road')), true);
  assert.equal(await exists(path.join(root, 'harbour-lights', 'north-road')), false);
  assert.equal((await listJournal(root)).find((e) => e.opId === opId).state, 'rolledBack');
});

test('recovery: pending moveTree with the folder at neither place -> needsAttention, entry stays pending', async () => {
  const root = await copyFixture(COVERS);
  const opId = await pendingMove(root, 'north-road', 'harbour-lights/north-road');
  await fs.rename(path.join(root, 'north-road'), path.join(root, 'elsewhere'));
  const report = await recoverRoot(root);
  assert.deepEqual(report.needsAttention.map((e) => e.opId), [opId]);
  assert.match(report.needsAttention[0].reason, /neither/);
  assert.deepEqual(report.completed, []);
  assert.deepEqual(report.rolledBack, []);
  assert.equal((await listJournal(root, { live: true })).find((e) => e.opId === opId).state, 'pending');
});

test('recovery: pending moveTree with the folder at both places -> needsAttention', async () => {
  const root = await copyFixture(COVERS);
  const opId = await pendingMove(root, 'north-road', 'harbour-lights/north-road');
  await fs.mkdir(path.join(root, 'harbour-lights', 'north-road'));
  const report = await recoverRoot(root);
  assert.deepEqual(report.needsAttention.map((e) => e.opId), [opId]);
  assert.match(report.needsAttention[0].reason, /both/);
});
