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

const STORY = 'planning/story.md';
const story = ({ id = 'note_01S50000000000000000000S01', extra = '' } = {}) => `---
schema: storyforge.story-plan/v1
id: ${id}
premise: An apprentice finds the harbour key opens the wrong door.
protagonist: maren-hollis
${extra}---

Free story notes.
`;

test('a story plan at planning/story.md adds no diagnostics; a plan with no fields and no body is fine', async () => {
  assert.deepEqual(await added((root) => put(root, STORY, story())), []);
  assert.deepEqual(await added((root) => put(root, STORY, '---\nschema: storyforge.story-plan/v1\nid: note_01S50000000000000000000S01\n---\n')), []);
});

test('E301: a story plan whose protagonist is not an entry of the book', async () => {
  assert.deepEqual(await added((root) => put(root, STORY, story().replace('maren-hollis', 'nobody-here'))), [`E301 | ${STORY} | protagonist`]);
});

test('story plan: a stray key is I401, a non-text field is E102', async () => {
  assert.deepEqual(await added((root) => put(root, STORY, story({ extra: 'mood: tense\n' }))), [`I401 | ${STORY} | mood`]);
  assert.deepEqual(await added((root) => put(root, STORY, story({ extra: 'stakes: [a, b]\n' }))), [`E102 | ${STORY} | stakes`]);
});

test('W318: a story plan anywhere but planning/story.md; an archived one is ignored', async () => {
  const other = 'planning/story-2.md';
  assert.deepEqual(await added((root) => { put(root, STORY, story()); put(root, other, story({ id: 'note_01S50000000000000000000S02' })); }), [`W318 | ${other} | schema`]);
  assert.deepEqual(await added((root) => put(root, STORY, story())), []);
  assert.deepEqual(await added((root) => put(root, `archive/${STORY}`, story())), []);
});

// ---- M3: character arcs
const MAREN = 'entry_01S5000000000000000000000G';
const ARC = 'planning/arcs/maren-hollis.md';
const arc = ({ id = 'note_01S50000000000000000000A01', character = MAREN, extra = '', milestones = `milestones:\n  - scene: ${KEY}\n    pressure: Time runs out.\n  - scene: ${FERRY}\n` } = {}) => `---
schema: storyforge.arc/v1
id: ${id}
slug: maren-hollis
character: ${character}
arc_type: positive
want: To learn what the key opens.
${milestones}${extra}---

Notes.
`;
const only = (list, file) => list.filter((k) => k.includes(`| ${file} |`));

test('a well-formed arc adds no diagnostics, with or without milestones', async () => {
  assert.deepEqual(await added((root) => put(root, ARC, arc())), []);
  assert.deepEqual(await added((root) => put(root, ARC, arc({ milestones: '' }))), []);
  assert.deepEqual(await added((root) => put(root, ARC, arc({ milestones: 'milestones: []\n' }))), []);
});

test('arc: unknown character is E301, a scene id is E302, a stray key is I401, a bad arc_type is E102', async () => {
  assert.deepEqual(await added((root) => put(root, ARC, arc({ character: 'entry_01S5000000000000000000ZZZZ' }))), [`E301 | ${ARC} | character`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc({ character: KEY }))), [`E302 | ${ARC} | character`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc({ extra: 'mood: tense\n' }))), [`I401 | ${ARC} | mood`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc().replace('arc_type: positive', 'arc_type: sideways'))), [`E102 | ${ARC} | arc_type`]);
});

test('arc milestones: E102 at the item or its key, I401 for an unknown key', async () => {
  const ms = (body) => ({ milestones: `milestones:\n${body}` });
  assert.deepEqual(await added((root) => put(root, ARC, arc(ms('  - just text\n')))), [`E102 | ${ARC} | milestones[0]`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc(ms(`  - scene: ${KEY}\n  - pressure: no scene\n`)))), [`E102 | ${ARC} | milestones[1].scene`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc(ms(`  - scene: ${KEY}\n    cost: [a, b]\n`)))), [`E102 | ${ARC} | milestones[0].cost`]);
  assert.deepEqual(await added((root) => put(root, ARC, arc(ms(`  - scene: ${KEY}\n    mood: tense\n`)))), [`I401 | ${ARC} | milestones[0].mood`]);
});

test('E301: a milestone whose scene is not in the book; W303 for an archived scene', async () => {
  const ghost = 'scene_01S5000000000000000000ZZZZ';
  assert.deepEqual(await added((root) => put(root, ARC, arc({ milestones: `milestones:\n  - scene: ${KEY}\n  - scene: ${ghost}\n` }))), [`E301 | ${ARC} | milestones[1].scene`]);
  const old = 'scene_01S50000000000000000000ARC';
  const got = await added((root) => {
    put(root, ARC, arc({ milestones: `milestones:\n  - scene: ${old}\n` }));
    put(root, 'archive/manuscript/act-01-one/ch-001-one/0090-old.md', `---\nschema: storyforge.scene/v1\nid: ${old}\ntitle: Old\nact: 1\nchapter: 1\nsequence: 90\nstatus: drafting\n---\nOld.\n`);
  });
  assert.deepEqual(only(got, ARC), [`W303 | ${ARC} | milestones[0].scene`]);
});

test('W319: a second live arc for one character, on the later file; an archived twin is ignored', async () => {
  const two = 'planning/arcs/maren-hollis-2.md';
  const second = arc({ id: 'note_01S50000000000000000000A02' }).replace('slug: maren-hollis', 'slug: maren-hollis-2');
  assert.deepEqual(await added((root) => { put(root, ARC, arc()); put(root, two, second); }), [`W319 | ${two} | character`]);
  assert.deepEqual(await added((root) => { put(root, ARC, arc()); put(root, `archive/${two}`, second); }), []);
});

test('arc: a series-shared character id resolves (tidewater, book low-tide), no E301', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-arc-'));
  const dest = path.join(base, 'tidewater');
  fs.cpSync(path.join(VALID, 'tidewater'), dest, { recursive: true });
  const before = keys(await validate(dest));
  put(dest, 'tidewater/low-tide/planning/arcs/ilse-hollis.md', `---
schema: storyforge.arc/v1
id: note_01W10000000000000000000A01
slug: ilse-hollis
character: entry_01W10000000000000000000003
arc_type: flat
milestones:
  - scene: scene_01W1000000000000000000000B
    choice: Opens the ledger.
---
`);
  assert.deepEqual(keys(await validate(dest)).filter((k) => !before.includes(k)), []);
});
