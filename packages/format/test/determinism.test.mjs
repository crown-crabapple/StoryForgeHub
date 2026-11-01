import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { ALL_FIXTURE_ROOTS, hashTree, compareDiagnostics } from './helpers.mjs';

const roots = ALL_FIXTURE_ROOTS();

test('fixture roots were found', () => {
  assert.ok(roots.length >= 36, `found ${roots.length}`);
});

for (const root of roots) {
  const label = path.relative(path.dirname(path.dirname(root)), root).replaceAll('\\', '/');

  test(`${label}: same folder twice gives identical JSON`, async () => {
    const a = JSON.stringify(await validate(root));
    const b = JSON.stringify(await validate(root));
    assert.equal(a, b);
  });

  test(`${label}: validate modifies no file; diagnostics sorted and unique`, async () => {
    const before = hashTree(root);
    const result = await validate(root);
    const after = hashTree(root);
    assert.deepEqual(after, before);
    const sorted = [...result.diagnostics].sort(compareDiagnostics);
    assert.deepEqual(result.diagnostics, sorted, 'diagnostics must be sorted by file, location, code');
    const keys = result.diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`);
    assert.equal(new Set(keys).size, keys.length, 'each (code, file, location) appears once');
  });
}
