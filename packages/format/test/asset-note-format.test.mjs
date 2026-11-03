// M08-J03: the asset note (storyforge.asset-note/v1) under assets/drafts/ and the activity/ai-usage.md table (a plain storyforge.doc/v1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';

const temps = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const NOTE = (extra = '') => `---\nschema: storyforge.asset-note/v1\nid: note_01J00000000000000000000001\nasset: cover-20261103-091500-1.png\nprompt: "A lighthouse"\nprovider: P\nmodel: m\nlocality: local\ncreated: 2026-11-03T09:15:00.000Z\nsha256: ${'a'.repeat(64)}\n${extra}---\nA draft.\n`;

function book(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-asset-'));
  temps.push(root);
  fs.cpSync(new URL('../fixtures/valid/salt-orchard', import.meta.url), root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const codes = async (root, file) => (await validate(root)).diagnostics.filter((d) => d.file.endsWith(file)).map((d) => `${d.code}:${d.location}`);

test('a well-formed asset note under assets/drafts/ is clean', async () => {
  assert.deepEqual(await codes(book({ 'assets/drafts/cover-20261103-091500-1.md': NOTE() }), 'cover-20261103-091500-1.md'), []);
});

test('an asset note with a bad locality or a missing sha256 is E102; one outside assets/drafts/ is W201', async () => {
  const bad = NOTE().replace('locality: local', 'locality: nearby');
  assert.deepEqual(await codes(book({ 'assets/drafts/x.md': bad }), 'x.md'), ['E102:locality']);
  const noSha = NOTE().replace(/sha256: .*\n/, '');
  assert.deepEqual(await codes(book({ 'assets/drafts/y.md': noSha }), 'y.md'), ['E102:sha256']);
  assert.deepEqual(await codes(book({ 'notes-elsewhere.md': NOTE() }), 'notes-elsewhere.md'), ['W201:schema']);
});

test('activity/ai-usage.md is an ordinary storyforge.doc/v1 file', async () => {
  const text = `---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000002\ntitle: AI usage\n---\n\n| Date | Profile | Locality | Requests | Prompt tokens | Completion tokens | Estimated |\n|---|---|---|---|---|---|---|\n| 2026-11-03 | P | local | 1 | 2 | 3 | 0 |\n`;
  assert.deepEqual(await codes(book({ 'activity/ai-usage.md': text }), 'ai-usage.md'), []);
});
