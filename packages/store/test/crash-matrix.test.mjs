import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/index.mjs';
import { FAULT_POINTS, classify, copyFixture, expectedStates, snapshot, strayTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'fixtures', 'crash-child.mjs');
const OP_NAMES = ['create', 'write', 'move', 'batch'];

for (const op of OP_NAMES) {
  for (const at of FAULT_POINTS) {
    test(`crash matrix: ${op} killed at ${at} recovers to all-old or all-new`, async () => {
      const root = await copyFixture('valid/salt-orchard');
      const { old, neu } = await expectedStates(root, op);
      const before = await snapshot(root);

      const child = spawnSync(process.execPath, [CHILD, JSON.stringify({ root, at, op })], {
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(child.status, 86, `child exit code (stderr: ${child.stderr})`);

      // Parent opens the store, which runs recovery.
      const store = await openStore(root);

      const state = await classify(root, old, neu);
      assert.notEqual(state, 'mixed', 'files must be byte-identical all-old or all-new, never partial or missing');

      // No tmp file left outside the trash.
      assert.deepEqual(await strayTmp(root), []);

      // Untouched project files are unchanged (everything outside .storyforge and the op's files).
      const after = await snapshot(root);
      for (const [rel, sha] of Object.entries(before)) {
        if (rel.startsWith('.storyforge/') || rel in old) continue;
        assert.equal(after[rel], sha, `${rel} must be untouched`);
      }

      // Journal: every entry ended completed or rolledBack; the state matches what is on disk.
      const entries = await store.journal();
      assert.ok(entries.length >= 1, 'a journal entry exists');
      for (const e of entries) assert.ok(['completed', 'rolledBack'].includes(e.state), `journal state was ${e.state}`);
      assert.equal(entries[0].state, state === 'new' ? 'completed' : 'rolledBack');

      // Single-file ops: the outcome is fixed by the fault point (recovery table in the contract).
      if (op !== 'batch') {
        const rolledForward = at === 'after-rename' || at === 'before-done';
        assert.equal(state, rolledForward ? 'new' : 'old');
      }

      // A second recovery is a no-op.
      const again = await store.recover();
      assert.deepEqual(again.needsAttention, []);
      assert.equal(await classify(root, old, neu), state);
    });
  }
}
