// Story Planner M1 (ADR 0003): the link and scene-plan kinds. Each case edits a temp copy of valid/salt-orchard and compares diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-planner-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
const put = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
async function added(edit) {
  const root = copy();
  const base = keys(await validate(root));
  await edit(root);
  const now = keys(await validate(root));
  return now.filter((k) => !base.includes(k));
}

const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const LINK = 'planning/links/key-therefore-ferry.md';
const link = ({ id = 'note_01S50000000000000000000K01', slug = 'key-therefore-ferry', from = KEY, to = FERRY, relation = 'therefore' } = {}) => `---
schema: storyforge.link/v1
id: ${id}
slug: ${slug}
from: ${from}
to: ${to}
relation: ${relation}
created: 2026-11-05
---

The key failing forces Maren onto the ferry.
`;
const PLAN = 'planning/scene-plans/the-key.md';
const plan = ({ id = 'note_01S50000000000000000000P01', scene = KEY, extra = '' } = {}) => `---
schema: storyforge.scene-plan/v1
id: ${id}
scene: ${scene}
goal: Prove the harbour key opens the sea gate.
characters: [maren-hollis, pell]
${extra}---

Notes.
`;

test('a well-formed link and scene plan add no diagnostics', async () => {
  assert.deepEqual(await added((root) => { put(root, LINK, link()); put(root, PLAN, plan()); }), []);
});

test('a link with no rationale body is fine', async () => {
  assert.deepEqual(await added((root) => put(root, LINK, link().split('---\n\n')[0] + '---\n')), []);
});

test('every relation word is accepted; another word is E102 at relation', async () => {
  for (const relation of ['therefore', 'but', 'enables', 'reveals', 'motivates', 'prevents', 'foreshadows', 'pays_off', 'parallel', 'other']) {
    assert.deepEqual(await added((root) => put(root, LINK, link({ relation }))), [], relation);
  }
  assert.deepEqual(await added((root) => put(root, LINK, link({ relation: 'causes' }))), [`E102 | ${LINK} | relation`]);
});

test('E301: a link whose from or to is not in the book', async () => {
  const ghost = 'scene_01S5000000000000000000ZZZZ';
  assert.deepEqual(await added((root) => put(root, LINK, link({ from: ghost }))), [`E301 | ${LINK} | from`]);
  assert.deepEqual(await added((root) => put(root, LINK, link({ to: ghost }))), [`E301 | ${LINK} | to`]);
});

test('E211: a link from a scene to itself', async () => {
  assert.deepEqual(await added((root) => put(root, LINK, link({ to: KEY }))), [`E211 | ${LINK} | to`]);
});

test('W316: a second live link with the same from, to and relation; a different relation is fine; an archived twin is ignored', async () => {
  const two = 'planning/links/key-therefore-ferry-2.md';
  assert.deepEqual(await added((root) => { put(root, LINK, link()); put(root, two, link({ id: 'note_01S50000000000000000000K02', slug: 'key-therefore-ferry-2' })); }), [`W316 | ${two} | relation`]);
  assert.deepEqual(await added((root) => { put(root, LINK, link()); put(root, two, link({ id: 'note_01S50000000000000000000K02', slug: 'key-therefore-ferry-2', relation: 'but' })); }), []);
  assert.deepEqual(await added((root) => { put(root, LINK, link()); put(root, `archive/${two}`, link({ id: 'note_01S50000000000000000000K02', slug: 'key-therefore-ferry-2' })); }), []);
});

test('W317: two live scene plans naming one scene; an archived twin is ignored', async () => {
  const two = 'planning/scene-plans/the-key-2.md';
  assert.deepEqual(await added((root) => { put(root, PLAN, plan()); put(root, two, plan({ id: 'note_01S50000000000000000000P02' })); }), [`W317 | ${two} | scene`]);
  assert.deepEqual(await added((root) => { put(root, PLAN, plan()); put(root, `archive/${two}`, plan({ id: 'note_01S50000000000000000000P02' })); }), []);
});

test('a scene plan: unknown scene or character is E301, a stray key is I401, a non-text field is E102', async () => {
  assert.deepEqual(await added((root) => put(root, PLAN, plan({ scene: 'scene_01S5000000000000000000ZZZZ' }))), [`E301 | ${PLAN} | scene`]);
  assert.deepEqual(await added((root) => put(root, PLAN, plan().replace('[maren-hollis, pell]', '[nobody-here]'))), [`E301 | ${PLAN} | characters[0]`]);
  assert.deepEqual(await added((root) => put(root, PLAN, plan({ extra: 'mood: tense\n' }))), [`I401 | ${PLAN} | mood`]);
  assert.deepEqual(await added((root) => put(root, PLAN, plan({ extra: 'stakes: [a, b]\n' }))), [`E102 | ${PLAN} | stakes`]);
});
