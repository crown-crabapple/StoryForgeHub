import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { INVALID, listDirs, readExpected, keysOf, SEVERITY_BY_LETTER } from './helpers.mjs';

// The contract's case table. If a case directory disappears this test fails,
// so a defect cannot be "fixed" by deleting its fixture.
const CONTRACT_CASES = [
  'E006-future-schema', 'E100-bad-yaml', 'E100-unclosed-fence', 'E101-anchor', 'E101-tag',
  'E102-missing-field', 'E102-bad-id', 'E102-scalar-for-list', 'E102-bad-enum', 'E103-path-escape',
  'E201-duplicate-id', 'E202-duplicate-series-number', 'E203-duplicate-book-slug',
  'E204-duplicate-sequence', 'E205-act-mismatch', 'E206-act-decreases', 'E207-duplicate-chapter-md',
  'E208-duplicate-slug', 'E301-broken-body-link', 'E301-broken-reference', 'E301-missing-cite',
  'E302-wrong-kind', 'W101-too-deep', 'W201-misfiled-scene', 'W201-entry-type-folder',
  'W202-prefix-mismatch', 'W203-bad-filename', 'W204-bom', 'W301-previous-slug',
  'W302-paid-no-payoff', 'W303-archived-target', 'I401-unknown-field', 'I402-cross-book',
];

test('invalid fixture set matches the contract case table', () => {
  assert.deepEqual(listDirs(INVALID), [...CONTRACT_CASES].sort());
});

for (const name of CONTRACT_CASES) {
  test(`invalid/${name}`, async () => {
    const dir = path.join(INVALID, name);
    const expected = readExpected(dir);
    assert.ok(expected.diagnostics.length > 0, 'case must expect at least one diagnostic');

    const result = await validate(dir);

    // exact set of (code, file, location): nothing missing, nothing extra, no duplicates
    assert.deepEqual(keysOf(result.diagnostics), keysOf(expected.diagnostics));

    // the case's headline code (from its folder name) is among the results
    const headline = name.split('-')[0];
    assert.ok(result.diagnostics.some((d) => d.code === headline), `expected a ${headline}`);

    for (const d of result.diagnostics) {
      assert.equal(d.severity, SEVERITY_BY_LETTER[d.code[0]], `${d.code} severity`);
      assert.ok(!d.file.includes('\\'), `${d.file} must use forward slashes`);
      assert.equal(typeof d.message, 'string');
    }
  });
}
