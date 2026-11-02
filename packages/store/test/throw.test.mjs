import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore, __faults } from '../src/index.mjs';
import { FAULT_POINTS, OPS, classify, copyFixture, expectedStates, readOrNull, strayTmp } from './helpers.mjs';

const OP_NAMES = ['create', 'write', 'move', 'batch'];

/** Find `.storyforge/trash/<opId>/<rel>` for any opId (directories only; ignores loose files). */
async function trashCopies(root, rel) {
  const trash = path.join(root, '.storyforge', 'trash');
  const found = [];
  for (const e of await fs.readdir(trash, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const b = await readOrNull(path.join(trash, e.name, ...rel.split('/')));
    if (b) found.push(b);
  }
  return found;
}

for (const op of OP_NAMES) {
  for (const at of FAULT_POINTS) {
    test(`throw mode: ${op} faulted at ${at} returns a failure and leaves files old`, async () => {
      const root = await copyFixture('valid/salt-orchard');
      const store = await openStore(root);
      const { old, neu } = await expectedStates(root, op);

      let result;
      __faults.at = at;
      __faults.mode = 'throw';
      try {
        result = await OPS[op].run(store);
      } finally {
        __faults.at = null;
      }
      assert.ok(result && result.ok === false, 'call returns a failure result');
      assert.equal(typeof result.code, 'string');

      assert.equal(await classify(root, old, neu), 'old');
      assert.deepEqual(await strayTmp(root), []);

      // Once the old file has been copied to the trash (after-trash onward), the copy is there.
      if (at !== 'after-journal' && op !== 'create') {
        const sources = op === 'move' ? [OPS.move.rels[0]] : OPS[op].rels;
        for (const rel of sources) {
          const copies = await trashCopies(root, rel);
          assert.ok(copies.some((c) => Buffer.compare(c, old[rel]) === 0), `trash holds a copy of ${rel}`);
        }
      }

      // Re-opening (recovery) keeps everything old and leaves nothing pending.
      const reopened = await openStore(root);
      assert.equal(await classify(root, old, neu), 'old');
      for (const e of await reopened.journal()) assert.notEqual(e.state, 'pending');
    });
  }
}
