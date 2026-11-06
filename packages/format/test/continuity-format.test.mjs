// M05-J01 acceptance 5 (validator part): event `state` (E102 / E301 / E302), `_types` `values` (E102), continuity exceptions
// (E102, W307, W201). Contract: docs/contracts/M05-J01-continuity-rules.md sections 1.1-1.3.
// Each case edits a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { INVALID, VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-m05-'));
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

// ---------------------------------------------------------------- event state

const EVENT = 'planning/timeline/the-tide-turns.md';
const event = (...items) => `---
schema: storyforge.event/v1
id: event_01S5000000000000000000AA01
slug: the-tide-turns
title: The tide turns
order: 120
state:
${items.map((i) => `  - ${i}`).join('\n')}
---
Text.
`;
const withState = (...items) => added((root) => put(root, EVENT, event(...items)));

test('event state: every documented event kind with valid values adds no diagnostics', async () => {
  assert.deepEqual(
    await withState(
      '{ slug: pell, event: died }',
      '{ slug: pell, event: revived }',
      '{ slug: grafting-knife, event: destroyed }',
      '{ slug: ferry-bell, event: lost }',
      '{ slug: saltmarks, event: found }',
      '{ slug: grafting-knife, event: holder, value: maren-hollis }',
      '{ slug: ferry-bell, event: holder, value: "" }',
      '{ slug: maren-hollis, event: location, value: port-aldine }',
      '{ slug: grafting-knife, event: location, value: salt-orchard }',
      '{ slug: maren-hollis, event: learns, value: the-key-opens-the-sluice }',
      '{ slug: tobin-reyes, event: knows, value: the-key-opens-the-sluice }',
    ),
    [],
  );
});

test('event without a state list is still valid', async () => {
  assert.deepEqual(
    await added((root) => put(root, EVENT, '---\nschema: storyforge.event/v1\nid: event_01S5000000000000000000AA01\nslug: the-tide-turns\ntitle: The tide turns\norder: 120\n---\nText.\n')),
    [],
  );
});

for (const [label, items, where] of [
  ['unknown event', ['{ slug: pell, event: vanished }'], 'state[0].event'],
  ['missing event', ['{ slug: pell }'], 'state[0].event'],
  ['died with a value', ['{ slug: pell, event: died, value: port-aldine }'], 'state[0].value'],
  ['found with a value', ['{ slug: ferry-bell, event: found, value: x }'], 'state[0].value'],
  ['holder without a value', ['{ slug: grafting-knife, event: holder }'], 'state[0].value'],
  ['location without a value', ['{ slug: maren-hollis, event: location }'], 'state[0].value'],
  ['learns without a value', ['{ slug: maren-hollis, event: learns }'], 'state[0].value'],
  ['knows with a non-slug fact key', ['{ slug: maren-hollis, event: knows, value: "Not A Slug" }'], 'state[0].value'],
  ['learns with a non-slug fact key', ['{ slug: maren-hollis, event: learns, value: "UPPER_case" }'], 'state[0].value'],
  ['error is reported at the right index', ['{ slug: pell, event: died }', '{ slug: pell, event: vanished }'], 'state[1].event'],
]) {
  test(`E102 state: ${label}`, async () => {
    assert.deepEqual(await withState(...items), [`E102 | ${EVENT} | ${where}`]);
  });
}

for (const [label, items, where] of [
  ['slug is not an entry', ['{ slug: nobody, event: died }'], 'state[0].slug'],
  ['holder value is not an entry', ['{ slug: grafting-knife, event: holder, value: nobody }'], 'state[0].value'],
  ['location value is not an entry', ['{ slug: maren-hollis, event: location, value: nowhere }'], 'state[0].value'],
]) {
  test(`E301 state: ${label}`, async () => {
    assert.deepEqual(await withState(...items), [`E301 | ${EVENT} | ${where}`]);
  });
}

for (const [label, items, where] of [
  ['died on an object', ['{ slug: grafting-knife, event: died }'], 'state[0].slug'],
  ['revived on a location', ['{ slug: port-aldine, event: revived }'], 'state[0].slug'],
  ['holder on a character', ['{ slug: pell, event: holder, value: maren-hollis }'], 'state[0].slug'],
  ['holder value is a location', ['{ slug: grafting-knife, event: holder, value: port-aldine }'], 'state[0].value'],
  ['location on a lore entry', ['{ slug: saltmarks, event: location, value: port-aldine }'], 'state[0].slug'],
  ['location value is a character', ['{ slug: maren-hollis, event: location, value: pell }'], 'state[0].value'],
  ['learns on an object', ['{ slug: grafting-knife, event: learns, value: a-fact }'], 'state[0].slug'],
]) {
  test(`E302 state: ${label}`, async () => {
    assert.deepEqual(await withState(...items), [`E302 | ${EVENT} | ${where}`]);
  });
}

test('contract fixtures invalid/E102-event-state, E301-event-state, E302-event-state exist and expect their code at state[...]', () => {
  for (const code of ['E102', 'E301', 'E302']) {
    const dir = path.join(INVALID, `${code}-event-state`);
    assert.ok(fs.existsSync(dir), `${code}-event-state exists`);
    const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    assert.ok(exp.diagnostics.length >= 1);
    assert.ok(exp.diagnostics.some((d) => d.code === code && /^state\[\d+\]\.(event|slug|value)$/.test(d.location)), `${code} at state[i]`);
  }
});

// ---------------------------------------------------------------- _types values

const TYPE = 'codex/_types/character.md';
const typeFile = (valuesYaml) => `---
schema: storyforge.codex-type/v1
id: note_01S5000000000000000000AA03
type: character
name: Character
plural: Characters
fields: [Eyes, Hair]
${valuesYaml}---
Text.
`;
const withValues = (v) => added((root) => put(root, TYPE, typeFile(v)));

test('_types values: a map of label -> list of words is valid; absent is valid', async () => {
  assert.deepEqual(await withValues('values:\n  Eyes: [grey, green, blue, brown, hazel]\n  Hair: [black, red]\n'), []);
  assert.deepEqual(await withValues(''), []);
});

for (const [label, yaml] of [
  ['values is a string', 'values: Eyes\n'],
  ['values is a list', 'values: [grey, green]\n'],
  ['a label maps to a string', 'values:\n  Eyes: grey\n'],
  ['a label maps to a list with a non-string', 'values:\n  Eyes: [grey, 3]\n'],
  ['a label maps to a nested map', 'values:\n  Eyes:\n    a: b\n'],
]) {
  test(`E102 _types: ${label}`, async () => {
    const r = await withValues(yaml);
    assert.equal(r.length, 1, JSON.stringify(r));
    assert.match(r[0], new RegExp(`^E102 \\| ${TYPE} \\| values`));
  });
}

// ---------------------------------------------------------------- continuity exceptions

const FP = 'cf1-3b9e0c1d2a4f5e6b';
const EXC = 'planning/continuity/maren-eyes.md';
const exc = ({ slug = 'maren-eyes', n = '04', fp = FP, rule = 'CF1', title = "Maren's eyes", body = 'The author means it.\n', drop = [] } = {}) => {
  const fm = { schema: 'storyforge.continuity-exception/v1', id: `note_01S5000000000000000000AA${n}`, slug, fingerprint: fp, rule, title, created: '"2026-11-02"' };
  for (const k of drop) delete fm[k];
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
};
const withExc = (opts, rel = EXC) => added((root) => put(root, rel, exc(opts)));

test('continuity exception: a well-formed exception adds no diagnostics (not a planning doc, no W201)', async () => {
  assert.deepEqual(await withExc({}), []);
});

for (const field of ['fingerprint', 'rule', 'title']) {
  test(`E102 exception: missing ${field}`, async () => {
    assert.deepEqual(await withExc({ drop: [field] }), [`E102 | ${EXC} | ${field}`]);
  });
}

for (const fp of ['CF1-3b9e0c1d2a4f5e6b', 'cf1-3b9e0c1d2a4f5e6', 'cf1-3b9e0c1d2a4f5e6b0', 'cf1-3B9E0C1D2A4F5E6B', 'cf1-zzzzzzzzzzzzzzzz', 'abcde-3b9e0c1d2a4f5e6b', 'c-3b9e0c1d2a4f5e6b', '3b9e0c1d2a4f5e6b', '""']) {
  test(`E102 exception: fingerprint ${fp} does not match the pattern`, async () => {
    assert.deepEqual(await withExc({ fp }), [`E102 | ${EXC} | fingerprint`]);
  });
}

for (const fp of ['cf1-3b9e0c1d2a4f5e6b', 'tl1-0000000000000000', 'ab-0123456789abcdef', 'abcd-0123456789abcdef']) {
  test(`exception fingerprint ${fp} is accepted`, async () => {
    assert.deepEqual(await withExc({ fp }), []);
  });
}

for (const [label, body] of [['empty', ''], ['whitespace only', '  \n\n']]) {
  test(`E102 exception: ${label} body (a rationale is required)`, async () => {
    const r = await withExc({ body });
    assert.equal(r.length, 1, JSON.stringify(r));
    assert.match(r[0], new RegExp(`^E102 \\| ${EXC} \\|`));
  });
}

test('continuity exception: intentional must be true or false', async () => {
  const withFlag = (v) => added((root) => put(root, EXC, exc({}).replace('created:', `intentional: ${v}\ncreated:`)));
  assert.deepEqual(await withFlag('true'), []);
  assert.deepEqual(await withFlag('false'), []);
  assert.deepEqual(await withFlag('"yes"'), [`E102 | ${EXC} | intentional`]);
});

test('W307: two exceptions with the same fingerprint warn on each, at fingerprint', async () => {
  const r = await added((root) => {
    put(root, 'planning/continuity/one.md', exc({ slug: 'one', n: '05' }));
    put(root, 'planning/continuity/two.md', exc({ slug: 'two', n: '06' }));
  });
  assert.deepEqual(r, ['W307 | planning/continuity/one.md | fingerprint', 'W307 | planning/continuity/two.md | fingerprint']);
});

test('W307 negative: different fingerprints do not warn', async () => {
  const r = await added((root) => {
    put(root, 'planning/continuity/one.md', exc({ slug: 'one', n: '05' }));
    put(root, 'planning/continuity/two.md', exc({ slug: 'two', n: '06', fp: 'cf1-3b9e0c1d2a4f5e6c' }));
  });
  assert.deepEqual(r, []);
});

test('W201: a continuity exception outside planning/continuity/ is misfiled', async () => {
  const r = await withExc({}, 'planning/maren-eyes.md');
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.match(r[0], /^W201 \| planning\/maren-eyes\.md \|/);
});
