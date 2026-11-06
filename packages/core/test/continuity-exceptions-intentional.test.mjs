// Story Planner M6 (ADR 0003): createContinuityException accepts an optional `intentional` flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';

test('createContinuityException: intentional true is written, false is not, a non-boolean is BAD_ARGS', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  const { findings } = await repo.getContinuity(BOOK);
  assert.ok(findings.length >= 1);
  const fp = findings[0].fingerprint;

  for (const bad of ['yes', 1, {}]) {
    const r = await repo.createContinuityException(BOOK, { fingerprint: fp, rationale: 'On purpose.', intentional: bad });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS');
  }

  const plain = await repo.createContinuityException(BOOK, { fingerprint: fp, rationale: 'On purpose.', intentional: false, dryRun: true });
  assert.equal(plain.ok, true);
  assert.ok(!plain.text.includes('intentional'));

  const r = await repo.createContinuityException(BOOK, { fingerprint: fp, rationale: 'On purpose.', intentional: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(await fs.readFile(path.join(root, ...r.file.split('/')), 'utf8'), /^intentional: true$/m);
  const after = await repo.getContinuity(BOOK);
  assert.equal(after.suppressed.find((s) => s.finding.fingerprint === fp).exception.intentional, true);
});
