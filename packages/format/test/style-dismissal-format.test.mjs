// M13-J03: the style dismissal document (planning/style/<slug>.md, schema storyforge.style-dismissal/v1): E102, W201, W307.
// Each case edits a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, STYLE_RULE_IDS } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-sty-'));
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

const FILE = 'planning/style/had-had.md';
const dismissal = ({ slug = 'had-had', n = '01', fp = 'sty-0123456789abcdef', rule = 'repeated-words', scene = 'scene_01S5000000000000000000AA01', text = '"had had"', body = 'Intentional.\n', extra = '' } = {}) =>
  `---\nschema: storyforge.style-dismissal/v1\nid: note_01S50000000000000000000A${n}\nslug: ${slug}\nfingerprint: ${fp}\nrule: ${rule}\nscene: ${scene}\ntext: ${text}\ncreated: 2026-11-18\n${extra}---\n${body}`;

test('a well formed dismissal, with or without a note, is clean', async () => {
  assert.deepEqual(await added((root) => put(root, FILE, dismissal())), []);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ body: '' }))), []);
  for (const rule of STYLE_RULE_IDS) assert.deepEqual(await added((root) => put(root, FILE, dismissal({ rule }))), [], rule);
});

test('E102: each bad field is reported at that field', async () => {
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ fp: 'cf1-0123456789abcdef' }))), [`E102 | ${FILE} | fingerprint`]);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ fp: 'sty-xyz' }))), [`E102 | ${FILE} | fingerprint`]);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ rule: 'textlint-rule-anything' }))), [`E102 | ${FILE} | rule`]);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ scene: 'scene_nope' }))), [`E102 | ${FILE} | scene`]);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ scene: 'chapter_01S5000000000000000000AA01' }))), [`E102 | ${FILE} | scene`]);
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ text: '5' }))), [`E102 | ${FILE} | text`]);
});

test('E102: each required field is needed', async () => {
  for (const field of ['slug', 'fingerprint', 'rule', 'scene', 'text']) {
    const lines = dismissal().split('\n').filter((l) => !l.startsWith(`${field}:`)).join('\n');
    const r = await added((root) => put(root, FILE, lines));
    assert.ok(r.includes(`E102 | ${FILE} | ${field}`), `${field}: ${JSON.stringify(r)}`);
  }
});

test('I401: an unknown field is flagged', async () => {
  assert.deepEqual(await added((root) => put(root, FILE, dismissal({ extra: 'colour: red\n' }))), [`I401 | ${FILE} | colour`]);
});

test('W201: a dismissal outside planning/style/ is misfiled', async () => {
  assert.deepEqual(await added((root) => put(root, 'planning/had-had.md', dismissal())), ['W201 | planning/had-had.md | schema']);
});

test('W307: two live dismissals with one fingerprint warn on each, at fingerprint', async () => {
  const r = await added((root) => {
    put(root, 'planning/style/one.md', dismissal({ slug: 'one', n: '01' }));
    put(root, 'planning/style/two.md', dismissal({ slug: 'two', n: '02' }));
  });
  assert.deepEqual(r, ['W307 | planning/style/one.md | fingerprint', 'W307 | planning/style/two.md | fingerprint']);
});

test('W307 negative: other fingerprints, an archived copy, or a continuity exception with another prefix do not warn', async () => {
  assert.deepEqual(await added((root) => {
    put(root, 'planning/style/one.md', dismissal({ slug: 'one', n: '01' }));
    put(root, 'planning/style/two.md', dismissal({ slug: 'two', n: '02', fp: 'sty-fedcba9876543210' }));
  }), []);
  assert.deepEqual(await added((root) => {
    put(root, 'planning/style/one.md', dismissal({ slug: 'one', n: '01' }));
    put(root, 'archive/planning/style/one.md', dismissal({ slug: 'one', n: '03' }));
  }), []);
});
