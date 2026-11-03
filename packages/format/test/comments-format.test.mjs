// M07-J03 section 5 (FORMAT-v1 9.5): the comment kind (E102, W314, W201) and the optional `by` on suggestions and receipts.
// Each case edits a temp copy of valid/salt-orchard and compares the diagnostics with the untouched copy's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-j03-'));
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

const SCENE = 'scene_01S50000000000000000000002';
const COMMENT = 'comments/2026/20261102-150000-green-eyes.md';
const comment = ({ target = SCENE, anchor = '{ line: 14, lines: 1, quote: "her green eyes", sha256: "" }', status = 'open', by = '{ id: usr_01S50000000000000000000009, name: "Tobin" }' } = {}) => `---
schema: storyforge.comment/v1
id: note_01S50000000000000000000C01
target: ${target}
anchor: ${anchor}
status: ${status}
${by === null ? '' : `by: ${by}\n`}created: "2026-11-02T15:00:00Z"
---
First comment text.

## Reply — Ilse — 2026-11-02T15:00:00Z
Reply text.
`;

test('a well-formed comment adds no diagnostics', async () => {
  assert.deepEqual(await added((root) => put(root, COMMENT, comment())), []);
});

test('a comment without by (personal mode) adds no diagnostics', async () => {
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ by: null }))), []);
});

test('W314: a comment whose target is no document of the book', async () => {
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ target: 'scene_01S5000000000000000000ZZZZ' }))), [`W314 | ${COMMENT} | target`]);
});

test('W201: a comment outside comments/', async () => {
  const rel = 'research/a-comment.md';
  assert.deepEqual(await added((root) => put(root, rel, comment())), [`W201 | ${rel} | schema`]);
});

for (const [name, anchor] of [
  ['line 0', '{ line: 0, lines: 1 }'],
  ['lines missing', '{ line: 3 }'],
  ['quote not text', '{ line: 3, lines: 1, quote: 5 }'],
  ['sha256 not hex', '{ line: 3, lines: 1, sha256: "xyz" }'],
]) {
  test(`E102 at anchor: ${name}`, async () => {
    assert.deepEqual(await added((root) => put(root, COMMENT, comment({ anchor }))), [`E102 | ${COMMENT} | anchor`]);
  });
}

test('E102: anchor missing, anchor not a mapping, bad status, bad by', async () => {
  const noAnchor = comment().replace(/^anchor: .*\n/m, '');
  assert.deepEqual(await added((root) => put(root, COMMENT, noAnchor)), [`E102 | ${COMMENT} | anchor`]);
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ anchor: '"line 3"' }))), [`E102 | ${COMMENT} | anchor`]);
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ status: 'closed' }))), [`E102 | ${COMMENT} | status`]);
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ by: '{ id: usr_x }' }))), [`E102 | ${COMMENT} | by`]);
  assert.deepEqual(await added((root) => put(root, COMMENT, comment({ by: '"Tobin"' }))), [`E102 | ${COMMENT} | by`]);
});

test('a suggestion may have source reviewer and a by; a bad by is E102', async () => {
  const sug = (source, by) => `---
schema: storyforge.suggestion/v1
id: note_01S50000000000000000000S01
target: ${SCENE}
target_path: ""
base_sha256: ""
source: ${source}
mode: suggest
by: ${by}
status: pending
hunks:
  - { id: h1, line: 1, lines: 1, original_sha256: "", status: pending }
---
\`\`\`diff
@@ -1,1 +1,1 @@ h1
-a
+b
\`\`\`
`;
  const rel = 'suggestions/2026/20261102-150000-x.md';
  assert.deepEqual(await added((root) => put(root, rel, sug('reviewer', '{ id: usr_a, name: "Ilse" }'))), []);
  assert.deepEqual(await added((root) => put(root, rel, sug('reviewer', '[1]'))), [`E102 | ${rel} | by`]);
});
