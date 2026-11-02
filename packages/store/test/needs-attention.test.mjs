import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/index.mjs';
import { OPS, copyFixture, expectedStates, readOrNull, snapshot } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'fixtures', 'crash-child.mjs');
const THIRD = Buffer.from('a third version, typed by a human after the crash\n');
const REL = 'research/tidal-ranges.md';

function crash(root, at, op) {
  const child = spawnSync(process.execPath, [CHILD, JSON.stringify({ root, at, op })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 86, `child exit code (stderr: ${child.stderr})`);
}

// after-tmp: target still holds the old bytes and a tmp exists.
// after-rename: target holds the new bytes. In both cases a third version matches neither.
for (const at of ['after-tmp', 'after-rename']) {
  test(`needsAttention: single write crashed at ${at}, target edited to a third version`, async () => {
    const root = await copyFixture('valid/salt-orchard');
    crash(root, at, 'write');
    await fs.writeFile(path.join(root, REL), THIRD);
    const before = await snapshot(root);

    const store = await openStore(root); // runs recovery once
    const report = await store.recover();

    assert.equal(report.needsAttention.length, 1);
    assert.ok(JSON.stringify(report.needsAttention).includes(REL), 'report names the file');
    assert.deepEqual(report.completed, []);
    assert.deepEqual(report.rolledBack, []);

    // The target is untouched, and so is everything else (touch nothing).
    assert.equal(Buffer.compare(await readOrNull(path.join(root, REL)), THIRD), 0);
    const after = await snapshot(root);
    for (const [rel, sha] of Object.entries(before)) {
      if (rel.startsWith('.storyforge/journal/')) continue;
      assert.equal(after[rel], sha, `${rel} must be untouched`);
    }
    for (const rel of Object.keys(before)) assert.ok(rel in after, `${rel} must not disappear`);

    // The journal entry stays pending.
    const entries = await store.journal();
    assert.equal(entries[0].state, 'pending');
  });
}

test('needsAttention in a batch blocks auto-restore of the files already renamed', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { old, neu } = await expectedStates(root, 'batch');
  crash(root, 'after-rename', 'batch');

  // Find files the crash left old and renamed; edit one of the still-old ones.
  const rels = OPS.batch.rels;
  const done = [];
  const notDone = [];
  for (const rel of rels) {
    const cur = await readOrNull(path.join(root, rel));
    if (Buffer.compare(cur, neu[rel]) === 0) done.push(rel);
    else {
      assert.equal(Buffer.compare(cur, old[rel]), 0);
      notDone.push(rel);
    }
  }
  assert.ok(done.length >= 1 && notDone.length >= 1, 'the crash left a mixed batch on disk');
  const edited = notDone[0];
  await fs.writeFile(path.join(root, edited), THIRD);

  const store = await openStore(root);
  const report = await store.recover();
  assert.ok(report.needsAttention.length >= 1);
  assert.ok(JSON.stringify(report.needsAttention).includes(edited));

  assert.equal(Buffer.compare(await readOrNull(path.join(root, edited)), THIRD), 0);
  for (const rel of done) {
    assert.equal(Buffer.compare(await readOrNull(path.join(root, rel)), neu[rel]), 0, `${rel} not auto-restored`);
  }
  assert.equal((await store.journal())[0].state, 'pending');
});
