// M12 W3: a scene's optional `cast` list ([{ entry, role }], role pov | appears | mentioned, at most one pov): E102 for shape problems and a second pov,
// E301 for an entry that does not resolve (the usual unresolved-reference diagnostic), E302 for a target that is not an entry.
// Each case edits a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAST_ROLES, validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

const SCENE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const MAREN = 'entry_01S5000000000000000000000G';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-cast-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
/** The diagnostics a scene `cast` block adds (the lines are the block's YAML, already indented under `cast:`). */
async function added(lines) {
  const root = copy();
  const base = keys(await validate(root));
  const file = path.join(root, ...SCENE.split('/'));
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('summary: Maren', `cast:\n${lines.map((l) => `  ${l}`).join('\n')}\nsummary: Maren`));
  return keys(await validate(root)).filter((k) => !base.includes(k));
}

test('the cast roles are pov, appears and mentioned', () => {
  assert.deepEqual(CAST_ROLES, ['pov', 'appears', 'mentioned']);
});

test('a valid cast (by slug or by id, one pov) adds no diagnostics; so does an empty list', async () => {
  assert.deepEqual(await added(['- { entry: maren-hollis, role: pov }', '- { entry: tobin-reyes, role: appears }', '- { entry: pell, role: mentioned }']), []);
  assert.deepEqual(await added([`- { entry: ${MAREN}, role: pov }`]), []);
  assert.deepEqual(await added(['- entry: maren-hollis', '  role: appears']), []);
  const root = copy();
  const base = keys(await validate(root));
  const file = path.join(root, ...SCENE.split('/'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('summary: Maren', 'cast: []\nsummary: Maren'));
  assert.deepEqual(keys(await validate(root)).filter((k) => !base.includes(k)), []);
});

test('an entry that resolves to nothing is E301 at cast[i].entry', async () => {
  const got = await added(['- { entry: maren-hollis, role: pov }', '- { entry: nobody-here, role: appears }']);
  assert.deepEqual(got, [`E301 | ${SCENE} | cast[1].entry`]);
});

test('an entry that is a scene, not an entry, is E302', async () => {
  const got = await added(['- { entry: scene_01S50000000000000000000002, role: appears }']);
  assert.deepEqual(got, [`E302 | ${SCENE} | cast[0].entry`]);
});

test('two pov items are E102 on the second; a bad role, a missing entry and a non-mapping are E102 too', async () => {
  assert.deepEqual(await added(['- { entry: maren-hollis, role: pov }', '- { entry: tobin-reyes, role: pov }']), [`E102 | ${SCENE} | cast[1].role`]);
  assert.deepEqual(await added(['- { entry: maren-hollis, role: star }']), [`E102 | ${SCENE} | cast[0].role`]);
  assert.deepEqual(await added(['- { role: appears }']), [`E102 | ${SCENE} | cast[0].entry`]);
  assert.deepEqual(await added(['- maren-hollis']), [`E102 | ${SCENE} | cast[0]`]);
});

test('cast must be a list', async () => {
  const root = copy();
  const base = keys(await validate(root));
  const file = path.join(root, ...SCENE.split('/'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('summary: Maren', 'cast: maren-hollis\nsummary: Maren'));
  assert.deepEqual(keys(await validate(root)).filter((k) => !base.includes(k)), [`E102 | ${SCENE} | cast`]);
});
