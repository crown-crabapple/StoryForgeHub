// M12 W4: planning/continuity/settings.md (storyforge.continuity-settings/v1: overdue_chapters, severity) and the optional `fact` wording on a learns / knows state item.
// Each case adds a file to (or edits) a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_SEVERITIES, validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-cset-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
const FILE = 'planning/continuity/settings.md';
/** The diagnostics a settings file with this front matter adds. */
async function added(front, rel = FILE) {
  const root = copy();
  const base = keys(await validate(root));
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nschema: storyforge.continuity-settings/v1\nid: note_01T6000000000000000000000A\n${front}---\n`);
  return keys(await validate(root)).filter((k) => !base.includes(k));
}

test('the severity words are error, warning, info and off', () => {
  assert.deepEqual(SETTINGS_SEVERITIES, ['error', 'warning', 'info', 'off']);
});

test('a valid settings file, and an empty one, add no diagnostics', async () => {
  assert.deepEqual(await added('overdue_chapters: 8\nseverity:\n  CS1: warning\n  TH2: off\n  PL1: info\n'), []);
  assert.deepEqual(await added(''), []);
});

test('a bad overdue_chapters, severity word or rule key is E102', async () => {
  assert.deepEqual(await added('overdue_chapters: 0\n'), [`E102 | ${FILE} | overdue_chapters`]);
  assert.deepEqual(await added('overdue_chapters: many\n'), [`E102 | ${FILE} | overdue_chapters`]);
  assert.deepEqual(await added('severity:\n  CS1: loud\n'), [`E102 | ${FILE} | severity.CS1`]);
  assert.deepEqual(await added('severity:\n  nonsense: off\n'), [`E102 | ${FILE} | severity.nonsense`]);
  assert.deepEqual(await added('severity: off\n'), [`E102 | ${FILE} | severity`]);
});

test('settings anywhere but planning/continuity/settings.md is W201', async () => {
  assert.deepEqual(await added('overdue_chapters: 8\n', 'planning/continuity/other.md'), ['W201 | planning/continuity/other.md | schema']);
});

test('a learns item may keep its wording as `fact` (one line of text); other state words take none', async () => {
  const withState = async (item) => {
    const root = copy();
    const base = keys(await validate(root));
    const rel = 'planning/timeline/fact-wording.md';
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nschema: storyforge.event/v1\nid: event_01T6000000000000000000000B\nslug: fact-wording\ntitle: Fact wording\norder: 900\nstate:\n  - ${item}\n---\n`);
    return keys(await validate(root)).filter((k) => !base.includes(k));
  };
  assert.deepEqual(await withState('{ slug: maren-hollis, event: learns, value: the-key-fits, fact: "The key fits the sluice" }'), []);
  assert.deepEqual(await withState('{ slug: maren-hollis, event: learns, value: the-key-fits }'), []);
  assert.deepEqual(await withState('{ slug: maren-hollis, event: learns, value: the-key-fits, fact: "" }'), ['E102 | planning/timeline/fact-wording.md | state[0].fact']);
  assert.deepEqual(await withState('{ slug: maren-hollis, event: died, fact: "x" }'), ['E102 | planning/timeline/fact-wording.md | state[0].fact']);
});
