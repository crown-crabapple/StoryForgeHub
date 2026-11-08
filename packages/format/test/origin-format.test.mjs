// M12 W6: a scene's optional `origin` (ai | author; the author is meant when it is absent): E102 for any other value, nothing for the two valid ones.
// Each case edits a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

const SCENE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';

const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
/** The diagnostics a line `origin: <value>` adds to the scene. */
async function added(value) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-origin-'));
  const root = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), root, { recursive: true });
  const before = keys(await validate(root));
  const file = path.join(root, ...SCENE.split('/'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('summary: Maren', `origin: ${value}\nsummary: Maren`));
  return keys(await validate(root)).filter((k) => !before.includes(k));
}

test('origin: ai and origin: author add no diagnostics (a scene without origin is the author\'s)', async () => {
  assert.deepEqual(await added('ai'), []);
  assert.deepEqual(await added('author'), []);
});

test('any other origin is E102 at origin', async () => {
  assert.deepEqual(await added('robot'), [`E102 | ${SCENE} | origin`]);
  assert.deepEqual(await added('AI'), [`E102 | ${SCENE} | origin`]);
});
