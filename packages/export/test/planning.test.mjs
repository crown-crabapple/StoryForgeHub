import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planningFiles, planningZip } from '../src/planning.mjs';
import { readZip } from './helpers.mjs';

const sample = () => ({
  book: { title: 'Salt Orchard', slug: 'salt-orchard' },
  story: { fields: { premise: 'A ferry town.', logline: 'One night.', primary_structure: 'st1' }, body: 'Notes here.' },
  scenes: [
    { id: 's1', title: 'Arrival', act: 1, chapter: 1, sequence: 1, summary: 'She lands.', plan: { goal: 'Find her aunt', turn: 'No aunt' } },
    { id: 's2', title: 'The Ferry', act: 1, chapter: 2, sequence: 2, summary: '', plan: null },
  ],
  arcs: [{ character: { name: 'Mara' }, arc_type: 'growth', fields: { start_state: 'Closed', end_state: 'Open', want: 'Home' }, milestones: [{ scene_title: 'Arrival', pressure: 'Lost', choice: 'Stay' }] }],
  relationships: [{ name: 'Mara & Jon', a: { name: 'Mara' }, b: { name: 'Jon' }, baseline: 'Strangers', end_state: 'Allies', developments: [{ scene_title: 'The Ferry', change: 'Trust', a_view: 'Wary' }] }],
  structure: { name: 'Three act', beats: [{ name: 'Setup', purpose: 'Introduce', question: 'Who?', scenes: [{ title: 'Arrival' }] }] },
  synopses: [{ slug: 'short', type: 'short', name: 'Short', body: 'It begins.' }],
  clues: [{ fact: 'The key is brass', kind: 'object', planted: [{ title: 'Arrival' }], revealed: { title: 'The Ferry' }, red_herring: true, knowers: [{ who: { name: 'Mara', reader: false }, scene: { title: 'The Ferry' }, how: 'finds it', reliable: false }] }],
  links: [
    { from_title: 'Arrival', to_title: 'The Ferry', relation: 'causes', branch: null, rationale: 'She must leave.' },
    { from_title: 'Arrival', to_title: 'The Ferry', relation: 'blocks', branch: 'ferry-sinks', rationale: null },
  ],
});
const get = (files, p) => files.find((f) => f.path === p).text;

test('full sample: file list and key lines', () => {
  const files = planningFiles(sample());
  assert.deepEqual(files.map((f) => f.path), ['story-plan.md', 'outline.md', 'characters.md', 'structure.md', 'synopses/short.md', 'clues.md', 'links.md']);
  for (const f of files) {
    assert.ok(!f.text.includes('\r'));
    assert.ok(f.text.endsWith('\n') && !f.text.endsWith('\n\n'));
  }
  assert.match(get(files, 'story-plan.md'), /- Premise: A ferry town\./);
  const o = get(files, 'outline.md');
  assert.match(o, /## Act 1\n\n### Chapter 1\n\n\*\*Arrival\*\* — She lands\.\n\n- Goal: Find her aunt\n- Turn: No aunt/);
  assert.match(o, /### Chapter 2\n\n\*\*The Ferry\*\*\n/);
  const c = get(files, 'characters.md');
  assert.match(c, /### Mara/);
  assert.match(c, /- Start: Closed/);
  assert.match(c, /1\. Arrival\n {3}- Pressure: Lost/);
  assert.match(c, /## Relationships[\s\S]*### Mara & Jon[\s\S]*- Baseline: Strangers[\s\S]*- End state: Allies/);
  assert.match(get(files, 'structure.md'), /## Three act[\s\S]*### Setup[\s\S]*- Scenes: Arrival/);
  assert.match(get(files, 'synopses/short.md'), /^# Short\n\nIt begins\./);
  const cl = get(files, 'clues.md');
  assert.match(cl, /- Planted in: Arrival/);
  assert.match(cl, /- Red herring: yes/);
  assert.match(cl, /Mara in The Ferry \(finds it\) \[unreliable\]/);
  const l = get(files, 'links.md');
  assert.match(l, /## Main plan\n\n- Arrival → causes → The Ferry\n {2}She must leave\./);
  assert.match(l, /## Branch: ferry-sinks\n\n- Arrival → blocks → The Ferry/);
});

test('empty data: placeholders, no synopses files', () => {
  const files = planningFiles({ book: { title: 'T', slug: 't' }, story: null, scenes: [], arcs: [], relationships: [], structure: null, synopses: [], clues: [], links: [] });
  assert.deepEqual(files.map((f) => f.path), ['story-plan.md', 'outline.md', 'characters.md', 'structure.md', 'clues.md', 'links.md']);
  assert.match(get(files, 'story-plan.md'), /Nothing planned yet\./);
  assert.match(get(files, 'outline.md'), /Nothing planned yet\./);
  assert.equal(get(files, 'characters.md').match(/Nothing planned yet\./g).length, 2);
  assert.match(get(files, 'structure.md'), /No primary structure\./);
  assert.match(get(files, 'clues.md'), /Nothing planned yet\./);
  assert.match(get(files, 'links.md'), /Nothing planned yet\./);
});

test('deterministic output and zip entries', () => {
  const a = planningZip(sample());
  const b = planningZip(sample());
  assert.ok(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)));
  assert.equal(a.filename, 'salt-orchard-planning.zip');
  const names = readZip(Buffer.from(a.bytes)).entries.map((e) => e.name);
  assert.deepEqual(names, planningFiles(sample()).map((f) => `salt-orchard-planning/${f.path}`));
});
