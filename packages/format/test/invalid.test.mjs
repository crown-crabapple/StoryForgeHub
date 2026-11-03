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
  'E102-event-date', 'E103-absolute-link', 'E301-research-source',
  'E201-duplicate-id', 'E202-duplicate-series-number', 'E203-duplicate-book-slug',
  'E204-duplicate-sequence', 'E205-act-mismatch', 'E206-act-decreases', 'E207-duplicate-chapter-md',
  'E208-duplicate-slug', 'E301-broken-body-link', 'E301-broken-reference', 'E301-missing-cite',
  'E302-wrong-kind', 'W101-too-deep', 'W201-misfiled-scene', 'W201-entry-type-folder',
  'W202-prefix-mismatch', 'W203-bad-filename', 'W204-bom', 'W301-previous-slug',
  'W302-paid-no-payoff', 'W303-archived-target', 'I401-unknown-field', 'I402-cross-book',
  'W201-thread-folder', 'W201-event-folder', 'W201-scene-outside-manuscript', 'E301-unknown-pen-name',
  'E209-duplicate-type', 'W304-shared-alias', 'W305-self-relation',
  'W306-planted-no-setup', 'E102-event-state', 'E301-event-state', 'E302-event-state', 'W307-duplicate-exception', 'W306-developed-no-develop', 'E301-develop-missing-scene',
  'E302-develop-wrong-kind', 'W308-suggestion-target-missing', 'E102-suggestion-hunk',
  // M07-J01: shared worlds, cross-book links, labels, typed fields, user templates
  'E210-book-series-slug', 'E303-cross-book-missing', 'W309-shadowed-entry', 'W311-unknown-label', 'W312-field-kind', 'I403-type-override',
  'E102-label-duplicate', 'E102-label-color', 'E102-field-kind', 'E102-field-choices', 'E102-template-shape',
  'E301-shared-private-link', 'E302-cross-book-reference', 'E208-shared-duplicate-slug', 'W303-cross-book-archived',
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

test('invalid/E006-future-schema: the v2 scene is listed as unsupported-schema and not ordered', async () => {
  const book = (await validate(path.join(INVALID, 'E006-future-schema'))).books[0];
  const b = 'manuscript/act-01-one/ch-001-one/0020-b.md';
  const ex = book.excluded.find((e) => e.path === b);
  assert.ok(ex, 'E006 scene must appear in excluded');
  assert.equal(ex.reason, 'unsupported-schema');
  assert.ok(!book.order.some((s) => s.path === b));
});

test('invalid/W201-scene-outside-manuscript: stray scene is excluded, not ordered', async () => {
  const book = (await validate(path.join(INVALID, 'W201-scene-outside-manuscript'))).books[0];
  const p = 'planning/drafts/0010-stray.md';
  assert.ok(!book.order.some((s) => s.path === p), 'must not be in order');
  assert.equal(book.order.length, 2);
  const ex = book.excluded.find((e) => e.path === p);
  assert.ok(ex, 'must appear in excluded');
  assert.equal(ex.reason, 'outside-manuscript');
});
