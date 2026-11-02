// "Where did this come from?" asks about the selected editor lines; the server answers in file lines (front matter included).
// Found in the M05 coordinator's browser check: lines 1–5 of the editor were sent as file lines 1–5 (the front matter).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontMatterLines } from '../src/continuity/model.js';
import { editorRowsOf, fileLinesOf, readBlame, selectionLines } from '../src/receipts/model.js';

const FILE = ['---', 'schema: storyforge.scene/v1', 'title: Arrival', '---', 'One.', '', 'Two.', ''].join('\n');
const BODY = 'One.\n\nTwo.\n';

test('editor lines are shifted by the front matter before asking, and the rows come back in editor lines', () => {
  const front = frontMatterLines(FILE);
  assert.equal(front, 4);
  const asked = selectionLines(BODY, 0, BODY.length);
  assert.deepEqual(asked, { from: 1, to: 3 });
  assert.deepEqual(fileLinesOf(asked, front), { from: 5, to: 7 });
  const answer = { lines: [5, 6, 7].map((line) => ({ line, receiptId: line === 7 ? 'rcpt_b' : 'rcpt_a', actor: line === 7 ? 'ai' : 'author', label: line === 7 ? 'Author text edited with AI' : 'Author-written' })) };
  const rows = editorRowsOf(readBlame(answer), front);
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.receiptId]), [[1, 2, 'rcpt_a'], [3, 3, 'rcpt_b']]);
  assert.equal(FILE.split('\n')[fileLinesOf({ from: 3, to: 3 }, front).from - 1], 'Two.', 'editor line 3 is the file line the server is asked about');
});
