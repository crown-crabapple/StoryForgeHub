import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { INVALID, listDirs, readExpected } from './helpers.mjs';

// Every code in FORMAT-v1 section 11. Reads only expected.json files.
const SPEC_CODES = [
  'E006', 'E100', 'E101', 'E102', 'E103', 'E201', 'E202', 'E203', 'E204', 'E205', 'E206', 'E207',
  'E208', 'E209', 'E301', 'E302', 'W101', 'W201', 'W202', 'W203', 'W204', 'W301', 'W302', 'W303',
  'W304', 'W305', 'W306', 'I401',
  'I402',
];

const covered = new Map(); // code -> case names
for (const name of listDirs(INVALID)) {
  for (const d of readExpected(path.join(INVALID, name)).diagnostics) {
    if (!covered.has(d.code)) covered.set(d.code, []);
    covered.get(d.code).push(name);
  }
}

for (const code of SPEC_CODES) {
  test(`${code} appears in at least one invalid case`, () => {
    assert.ok(covered.has(code), `no invalid/*/expected.json lists ${code}`);
  });
}

test('every case folder expects the code it is named after', () => {
  for (const name of listDirs(INVALID)) {
    const head = name.split('-')[0];
    assert.ok(covered.get(head)?.includes(name), `${name} does not expect ${head}`);
  }
});

test('expected.json files only use codes defined in the spec', () => {
  for (const code of covered.keys()) assert.ok(SPEC_CODES.includes(code), `unknown code ${code}`);
});

test('every expected diagnostic has code, file and location', () => {
  for (const name of listDirs(INVALID)) {
    for (const d of readExpected(path.join(INVALID, name)).diagnostics) {
      assert.match(d.code, /^[EWI]\d{3}$/);
      assert.equal(typeof d.file, 'string');
      assert.equal(typeof d.location, 'string');
      assert.ok(!d.file.includes('\\'));
    }
  }
});
