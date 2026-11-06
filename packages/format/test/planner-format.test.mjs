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

// ---- M4: structures and beat sheets
const STRUCT = 'planning/structures/main-three-act.md';
const B1 = 'note_01S50000000000000000000B01';
const B2 = 'note_01S50000000000000000000B02';
const structure = ({ id = 'note_01S50000000000000000000B00', extra = '', beats = `beats:\n  - id: ${B1}\n    name: Opening image\n    purpose: Show the world before it changes.\n    question: What does normal look like?\n    position: about 1%\n    state: done\n    scenes: [${KEY}, ${FERRY}]\n  - id: ${B2}\n    name: Inciting event\n    scenes: [${KEY}]\n` } = {}) => `---
schema: storyforge.structure/v1
id: ${id}
slug: main-three-act
name: Main structure
template: three-act
template_version: 1
${beats}${extra}---

Notes.
`;
const beatsOf = (body) => ({ beats: `beats:\n${body}` });
const sameFile = (list, file) => list.filter((k) => k.includes(`| ${file} |`));

test('a well-formed structure adds no diagnostics, with or without beats', async () => {
  assert.deepEqual(await added((root) => put(root, STRUCT, structure())), []);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure({ beats: '' }))), []);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure({ beats: 'beats: []\n' }))), []);
});

test('structure: a stray key is I401, a non-list beats is E102, a bad template_version is E102', async () => {
  assert.deepEqual(await added((root) => put(root, STRUCT, structure({ extra: 'mood: tense\n' }))), [`I401 | ${STRUCT} | mood`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure({ beats: 'beats: text\n' }))), [`E102 | ${STRUCT} | beats`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure().replace('template_version: 1', 'template_version: one'))), [`E102 | ${STRUCT} | template_version`]);
});

test('beats: E102 at the item or its key, I401 for an unknown key', async () => {
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf('  - just text\n')))), [`E102 | ${STRUCT} | beats[0]`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n  - name: No id\n`)))), [`E102 | ${STRUCT} | beats[1].id`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf('  - id: B1\n    name: One\n')))), [`E102 | ${STRUCT} | beats[0].id`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n`)))), [`E102 | ${STRUCT} | beats[0].name`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    purpose: [a, b]\n`)))), [`E102 | ${STRUCT} | beats[0].purpose`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    state: finished\n`)))), [`E102 | ${STRUCT} | beats[0].state`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    scenes: ${KEY}\n`)))), [`E102 | ${STRUCT} | beats[0].scenes`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    scenes: [${KEY}, 7]\n`)))), [`E102 | ${STRUCT} | beats[0].scenes[1]`]);
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    mood: tense\n`)))), [`I401 | ${STRUCT} | beats[0].mood`]);
});

test('beats: more than 50 scenes in one beat is E102', async () => {
  const many = Array.from({ length: 51 }, () => KEY).join(', ');
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    scenes: [${many}]\n`)))), [`E102 | ${STRUCT} | beats[0].scenes`]);
});

test('E102: a beat id used twice, in one file or across live structures; archived structures are ignored', async () => {
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n  - id: ${B1}\n    name: Two\n`)))), [`E102 | ${STRUCT} | beats[1].id`]);
  const two = 'planning/structures/main-three-act-2.md';
  const second = structure({ id: 'note_01S50000000000000000000B03' }).replace('slug: main-three-act', 'slug: main-three-act-2');
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, two, second); }), [`E102 | ${two} | beats[0].id`, `E102 | ${two} | beats[1].id`]);
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, `archive/${two}`, second); }), []);
});

test('E301: a beat scene that is not in the book; W303 for an archived scene', async () => {
  const ghost = 'scene_01S5000000000000000000ZZZZ';
  assert.deepEqual(await added((root) => put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    scenes: [${KEY}, ${ghost}]\n`)))), [`E301 | ${STRUCT} | beats[0].scenes[1]`]);
  const old = 'scene_01S50000000000000000000ARC';
  const got = await added((root) => {
    put(root, STRUCT, structure(beatsOf(`  - id: ${B1}\n    name: One\n    scenes: [${old}]\n`)));
    put(root, 'archive/manuscript/act-01-one/ch-001-one/0090-old.md', `---\nschema: storyforge.scene/v1\nid: ${old}\ntitle: Old\nact: 1\nchapter: 1\nsequence: 90\nstatus: drafting\n---\nOld.\n`);
  });
  assert.deepEqual(sameFile(got, STRUCT), [`W303 | ${STRUCT} | beats[0].scenes[0]`]);
});

test('story plan primary_structure: a live structure is clean, missing is E301, archived is W303', async () => {
  const withPrimary = (id) => story({ extra: `primary_structure: ${id}\n` });
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, STORY, withPrimary('note_01S50000000000000000000B00')); }), []);
  assert.deepEqual(await added((root) => put(root, STORY, withPrimary('note_01S5000000000000000000ZZZZ'))), [`E301 | ${STORY} | primary_structure`]);
  assert.deepEqual(await added((root) => { put(root, `archive/${STRUCT}`, structure()); put(root, STORY, withPrimary('note_01S50000000000000000000B00')); }), [`W303 | ${STORY} | primary_structure`]);
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

// ---- M5: relationships
const PELL = 'entry_01S5000000000000000000000K';
const REL = 'planning/relationships/maren-hollis-and-pell.md';
const rel = ({ id = 'note_01S50000000000000000000R01', a = MAREN, b = PELL, slug = 'maren-hollis-and-pell', extra = '', developments = `developments:\n  - scene: ${KEY}\n    change: Pell lends Maren the key.\n    a_view: Maren trusts Pell.\n    b_view: Pell fears Maren.\n  - scene: ${FERRY}\n    change: Maren pays for passage.\n` } = {}) => `---
schema: storyforge.relationship/v1
id: ${id}
slug: ${slug}
a: ${a}
b: ${b}
baseline: Wary of each other.
end_state: Allies.
${developments}${extra}---

Notes.
`;
const devs = (body) => ({ developments: `developments:\n${body}` });

test('a well-formed relationship adds no diagnostics, with or without developments', async () => {
  assert.deepEqual(await added((root) => put(root, REL, rel())), []);
  assert.deepEqual(await added((root) => put(root, REL, rel({ developments: '' }))), []);
  assert.deepEqual(await added((root) => put(root, REL, rel({ developments: 'developments: []\n' }))), []);
});

test('relationship: unknown entry is E301, a scene id is E302, a stray key is I401', async () => {
  assert.deepEqual(await added((root) => put(root, REL, rel({ a: 'entry_01S5000000000000000000ZZZZ' }))), [`E301 | ${REL} | a`]);
  assert.deepEqual(await added((root) => put(root, REL, rel({ b: KEY }))), [`E302 | ${REL} | b`]);
  assert.deepEqual(await added((root) => put(root, REL, rel({ extra: 'mood: tense\n' }))), [`I401 | ${REL} | mood`]);
});

test('E212: a relationship whose a and b are the same entry', async () => {
  assert.deepEqual(await added((root) => put(root, REL, rel({ b: MAREN }))), [`E212 | ${REL} | b`]);
});

test('relationship developments: E102 at the item or its key, I401 for an unknown key', async () => {
  assert.deepEqual(await added((root) => put(root, REL, rel(devs('  - just text\n')))), [`E102 | ${REL} | developments[0]`]);
  assert.deepEqual(await added((root) => put(root, REL, rel(devs('  - change: no scene\n')))), [`E102 | ${REL} | developments[0].scene`]);
  assert.deepEqual(await added((root) => put(root, REL, rel(devs(`  - scene: ${KEY}\n`)))), [`E102 | ${REL} | developments[0].change`]);
  assert.deepEqual(await added((root) => put(root, REL, rel(devs(`  - scene: ${KEY}\n    change: [a, b]\n`)))), [`E102 | ${REL} | developments[0].change`]);
  assert.deepEqual(await added((root) => put(root, REL, rel(devs(`  - scene: ${KEY}\n    change: x\n    a_view: [a]\n`)))), [`E102 | ${REL} | developments[0].a_view`]);
  assert.deepEqual(await added((root) => put(root, REL, rel(devs(`  - scene: ${KEY}\n    change: x\n    mood: tense\n`)))), [`I401 | ${REL} | developments[0].mood`]);
});

test('E301: a development whose scene is not in the book; W303 for an archived scene', async () => {
  const ghost = 'scene_01S5000000000000000000ZZZZ';
  assert.deepEqual(await added((root) => put(root, REL, rel(devs(`  - scene: ${ghost}\n    change: x\n`)))), [`E301 | ${REL} | developments[0].scene`]);
  const old = 'scene_01S50000000000000000000ARC';
  const got = await added((root) => {
    put(root, REL, rel(devs(`  - scene: ${old}\n    change: x\n`)));
    put(root, 'archive/manuscript/act-01-one/ch-001-one/0090-old.md', `---\nschema: storyforge.scene/v1\nid: ${old}\ntitle: Old\nact: 1\nchapter: 1\nsequence: 90\nstatus: drafting\n---\nOld.\n`);
  });
  assert.deepEqual(only(got, REL), [`W303 | ${REL} | developments[0].scene`]);
});

test('W320: two live relationships for one pair in either order, on the later file; an archived twin is ignored', async () => {
  const two = 'planning/relationships/pell-and-maren-hollis.md';
  const second = rel({ id: 'note_01S50000000000000000000R02', a: PELL, b: MAREN, slug: 'pell-and-maren-hollis' });
  assert.deepEqual(await added((root) => { put(root, REL, rel()); put(root, two, second); }), [`W320 | ${two} | b`]);
  assert.deepEqual(await added((root) => { put(root, REL, rel()); put(root, `archive/${two}`, second); }), []);
});

// ---- M5: links to beats
const LINK_BEAT = 'planning/links/key-enables-inciting-event.md';
test('a link may end at a beat of a live structure, from or to, mixed with scenes', async () => {
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', to: B2, relation: 'enables' })); }), []);
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', from: B1, to: B2 })); }), []);
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', from: B2, to: KEY })); }), []);
});

test('a link to a beat of an archived structure is W303; an unknown beat id is E301; a beat from == to is E211', async () => {
  assert.deepEqual(await added((root) => { put(root, `archive/${STRUCT}`, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', to: B2 })); }), [`W303 | ${LINK_BEAT} | to`]);
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', to: 'note_01S5000000000000000000ZZZZ' })); }), [`E301 | ${LINK_BEAT} | to`]);
  assert.deepEqual(await added((root) => { put(root, STRUCT, structure()); put(root, LINK_BEAT, link({ slug: 'key-enables-inciting-event', from: B2, to: B2 })); }), [`E211 | ${LINK_BEAT} | to`]);
});

test('beat ids resolve only in links: a scene-plan or arc pointing at a beat id is still E301/E302', async () => {
  const got = await added((root) => { put(root, STRUCT, structure()); put(root, PLAN, plan({ scene: B2 })); });
  assert.deepEqual(only(got, PLAN), [`E301 | ${PLAN} | scene`]);
});
