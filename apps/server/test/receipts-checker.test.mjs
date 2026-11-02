// Self-test of the independent chain checker used by the M05-J07 acceptance tests (receipts-helpers.mjs): it must accept a hand-built, contract-shaped chain,
// name every section 6 code when that chain is damaged in exactly one way, and attribute lines correctly. Nothing here touches the product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blameOracle, chainOf, checkChain, codesOf, readReceipts, replay, diffHunks, splitLines } from './receipts-helpers.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const T = 'scene_01S50000000000000000000002';
const id = (n) => `rcpt_01S5000000000000000000000${n}`;

/** A receipt file, written the way section 1.1 shows it. */
function receiptText({ n, op, actor, before, after, parents, diff, ranges }) {
  const fm = [
    '---',
    'schema: storyforge.receipt/v1',
    `id: ${id(n)}`,
    `at: "2026-11-02T14:0${n}:00.000Z"`,
    `actor: ${actor}`,
    `operation: ${op}`,
    'workflow: editor',
    `target: { id: ${T}, path: manuscript/a/0010-arrival.md }`,
    `before_sha256: "${before}"`,
    `after_sha256: "${after}"`,
    `ranges: ${JSON.stringify(ranges ?? [])}`,
    `parents: ${JSON.stringify(parents ?? [])}`,
    '---',
    'Summary line.',
    '',
    '```diff',
    ...(diff ?? []),
    '```',
    '',
  ];
  return fm.join('\n');
}

async function book(texts) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-chk-'));
  const putObject = async (t) => {
    const h = sha(t);
    await fs.mkdir(path.join(root, 'provenance', 'objects', h.slice(0, 2)), { recursive: true });
    await fs.writeFile(path.join(root, 'provenance', 'objects', h.slice(0, 2), h), t);
    return h;
  };
  const states = [texts.v0, texts.v1, texts.v2];
  for (const t of states) await putObject(t);
  const hs = states.map(sha);
  const write = async (n, text) => {
    const dir = path.join(root, 'provenance', '2026', '11');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id(n)}.md`), text);
    return sha(Buffer.from(text));
  };
  const r1 = receiptText({ n: 1, op: 'baseline', actor: 'system', before: '', after: hs[0], diff: ['@@ -0,0 +1,3 @@', ...splitLines(texts.v0).map((l) => `+${l}`)] });
  const s1 = await write(1, r1);
  const r2 = receiptText({ n: 2, op: 'author.edit', actor: 'author', before: hs[0], after: hs[1], parents: [{ id: id(1), sha256: s1 }], diff: ['@@ -2,1 +2,1 @@', '-two', '+TWO'], ranges: [{ before: [2, 2], after: [2, 2] }] });
  const s2 = await write(2, r2);
  const r3 = receiptText({ n: 3, op: 'suggestion.accept', actor: 'ai', before: hs[1], after: hs[2], parents: [{ id: id(2), sha256: s2 }], diff: ['@@ -3,1 +3,2 @@', '-three', '+3', '+3b'], ranges: [{ before: [3, 3], after: [3, 4] }] });
  await write(3, r3);
  return { root, hs, files: { 1: r1, 2: r2, 3: r3 } };
}
const TEXTS = { v0: 'one\ntwo\nthree\n', v1: 'one\nTWO\nthree\n', v2: 'one\nTWO\n3\n3b\n' };

test('a well-formed chain (replace, replace-with-insert) has no problems and its blame names the right receipts', async () => {
  const { root } = await book(TEXTS);
  assert.deepEqual(await checkChain(root, { [T]: Buffer.from(TEXTS.v2) }), []);
  const chain = chainOf(await readReceipts(root), T);
  assert.deepEqual(chain.map((r) => r.fm.operation), ['baseline', 'author.edit', 'suggestion.accept']);
  const objs = new Map(Object.values(TEXTS).map((t) => [sha(t), Buffer.from(t)]));
  const { lines, owners } = blameOracle(chain, (h) => objs.get(h));
  assert.deepEqual(lines, ['one', 'TWO', '3', '3b']);
  assert.deepEqual(owners.map((o) => o.fm.operation), ['baseline', 'author.edit', 'suggestion.accept', 'suggestion.accept']);
});

test('replay handles a pure insertion by its new-side position and reports a "-" line that is not in the before text', () => {
  const hunks = diffHunks('```diff\n@@ -2,0 +3,2 @@\n+x\n+y\n```');
  assert.deepEqual(replay(['a', 'b', 'c'], hunks).lines, ['a', 'b', 'x', 'y', 'c']);
  const bad = diffHunks('```diff\n@@ -1,1 +1,1 @@\n-nope\n+yes\n```');
  assert.equal(replay(['a'], bad).mismatch.length, 1);
});

test('one flipped byte in a receipt: RCPT_PARENT_ALTERED only', async () => {
  const { root } = await book(TEXTS);
  const f = path.join(root, 'provenance', '2026', '11', `${id(1)}.md`);
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('Summary line.', 'Summary lime.'));
  assert.deepEqual(codesOf(await checkChain(root)), ['RCPT_PARENT_ALTERED']);
});

test('a deleted object: RCPT_OBJECT_MISSING only; a changed object: RCPT_OBJECT_ALTERED', async () => {
  const a = await book(TEXTS);
  const h = a.hs[2];
  await fs.rm(path.join(a.root, 'provenance', 'objects', h.slice(0, 2), h));
  assert.deepEqual(codesOf(await checkChain(a.root)), ['RCPT_OBJECT_MISSING']);
  const b = await book(TEXTS);
  await fs.appendFile(path.join(b.root, 'provenance', 'objects', h.slice(0, 2), h), 'x');
  assert.ok(codesOf(await checkChain(b.root)).includes('RCPT_OBJECT_ALTERED'));
});

test('a removed receipt: RCPT_PARENT_MISSING; a wrong diff: RCPT_DIFF_MISMATCH; a gap: RCPT_CHAIN_GAP; a scene that moved on: RCPT_UNRECORDED; garbage: RCPT_MALFORMED', async () => {
  const a = await book(TEXTS);
  await fs.rm(path.join(a.root, 'provenance', '2026', '11', `${id(2)}.md`));
  assert.ok(codesOf(await checkChain(a.root)).includes('RCPT_PARENT_MISSING'));

  const b = await book(TEXTS);
  const f3 = path.join(b.root, 'provenance', '2026', '11', `${id(3)}.md`);
  await fs.writeFile(f3, (await fs.readFile(f3, 'utf8')).replace('+3b', '+4b')); // last receipt: no child, no parent hash breaks
  assert.deepEqual(codesOf(await checkChain(b.root)), ['RCPT_DIFF_MISMATCH']);

  const c = await book(TEXTS);
  const f3c = path.join(c.root, 'provenance', '2026', '11', `${id(3)}.md`);
  await fs.writeFile(f3c, (await fs.readFile(f3c, 'utf8')).replace(`before_sha256: "${c.hs[1]}"`, `before_sha256: "${c.hs[0]}"`));
  assert.ok(codesOf(await checkChain(c.root)).includes('RCPT_CHAIN_GAP'));

  const d = await book(TEXTS);
  assert.deepEqual(codesOf(await checkChain(d.root, { [T]: Buffer.from('something else\n') })), ['RCPT_UNRECORDED']);

  const e = await book(TEXTS);
  await fs.writeFile(path.join(e.root, 'provenance', '2026', '11', `${id(3)}.md`), 'no front matter at all\n');
  assert.ok(codesOf(await checkChain(e.root)).includes('RCPT_MALFORMED'));
});
