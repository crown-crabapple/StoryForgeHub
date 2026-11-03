import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { setReadConcurrency } from '../src/fs.mjs';
import { ALL_FIXTURE_ROOTS } from './helpers.mjs';

// The concurrent read path must give byte-identical JSON to a one-by-one read, on every fixture.
for (const root of ALL_FIXTURE_ROOTS()) {
  const label = path.relative(path.dirname(path.dirname(root)), root).replaceAll('\\', '/');
  test(`${label}: concurrent validate equals sequential validate`, async () => {
    setReadConcurrency(1);
    let sequential;
    try {
      sequential = JSON.stringify(await validate(root));
    } finally {
      setReadConcurrency(24);
    }
    const parallel = JSON.stringify(await validate(root));
    assert.equal(parallel, sequential);
  });
}
