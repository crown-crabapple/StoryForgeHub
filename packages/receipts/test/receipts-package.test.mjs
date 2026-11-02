import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiff, blame, buildReceipt, lineDiff, lineage, objectPath, parseReceipt, receiptPath, sha256Hex, verifyChain } from '@storyforge/receipts';

const ID = (n) => `rcpt_${String(n).padStart(26, '0')}`;
const t0 = '2026-11-02T14:05:00.000Z';
const at = (n) => new Date(Date.parse(t0) + n * 1000).toISOString();

test('lineDiff and applyDiff replay exactly, for LF, CRLF, missing newline and empty files', () => {
  const cases = [
    ['a\nb\nc\n', 'a\nB\nc\nd\n'],
    ['a\r\nb\r\n', 'a\r\nx\r\nb\r\n'],
    ['a\nb', 'a\nb\n'],
    ['', 'one\ntwo\n'],
    ['one\ntwo\n', ''],
    ['a\nb\n', 'a\r\nb\r\n'],
    ['same\n', 'same\n'],
    ['x\ny\nz\n', 'x\nz\n'],
  ];
  for (const [a, b] of cases) {
    const d = lineDiff(a, b);
    assert.equal(d.exact, true, JSON.stringify([a, b]));
    assert.equal(applyDiff(a, d.diff).toString('utf8'), b);
  }
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(d.ranges, [{ before: [2, 2], after: [2, 2] }]);
});

test('buildReceipt and parseReceipt round-trip; a bad schema is RCPT_MALFORMED', () => {
  const before = 'a\nb\n';
  const after = 'a\nB\n';
  const built = buildReceipt({
    id: ID(1), at: t0, actor: 'ai', operation: 'suggestion.accept', workflow: 'ai-rewrite', target: { id: 'scene_X', path: 'manuscript/a.md' },
    before_sha256: sha256Hex(before), after_sha256: sha256Hex(after), beforeBytes: before, afterBytes: after,
    ai: { provider: 'Local mock', model: 'mock-1', locality: 'local', suggestion: 'note_1', hunks: ['h2'], acceptance: 'accepted' }, prompt: 'Make it shorter',
  });
  const p = parseReceipt(built.text);
  assert.equal(p.operation, 'suggestion.accept');
  assert.equal(p.ai.provider, 'Local mock');
  assert.deepEqual(p.ai.hunks, ['h2']);
  assert.equal(p.prompt, 'Make it shorter');
  assert.match(p.summary, /accepted 1 change/);
  assert.equal(applyDiff(before, p.diff).toString(), after);
  assert.equal(receiptPath(t0, ID(1)), `provenance/2026/11/${ID(1)}.md`);
  assert.equal(objectPath('ab12'), 'provenance/objects/ab/ab12');
  assert.throws(() => parseReceipt(built.text.replace('storyforge.receipt/v1', 'nope')), { code: 'RCPT_MALFORMED' });
});

/** A three-receipt chain for one scene. */
function chain() {
  const texts = ['---\nid: s\n---\nline one\nline two\nline three\n', '---\nid: s\n---\nline one\nline TWO\nline three\n', '---\nid: s\n---\nline one\nline TWO\nline 3\n'];
  const objects = new Map(texts.map((t) => [sha256Hex(t), Buffer.from(t)]));
  const files = [];
  let parent = null;
  const specs = [
    ['baseline', 'system', 'editor', '', texts[0]],
    ['suggestion.accept', 'ai', 'ai-rewrite', texts[0], texts[1]],
    ['author.edit', 'author', 'editor', texts[1], texts[2]],
  ];
  specs.forEach(([operation, actor, workflow, b, a], i) => {
    const r = buildReceipt({
      id: ID(i + 1), at: at(i), actor, operation, workflow, target: { id: 'scene_X', path: 'manuscript/a.md' }, before_sha256: b === '' ? '' : sha256Hex(b), after_sha256: sha256Hex(a),
      beforeBytes: b, afterBytes: a, parents: parent ? [parent] : [],
      ...(operation === 'suggestion.accept' ? { ai: { provider: 'Local mock', model: 'mock-1', locality: 'local', acceptance: 'accepted', hunks: ['h1'] } } : {}),
    });
    files.push({ path: receiptPath(at(i), ID(i + 1)), bytes: Buffer.from(r.text) });
    parent = { id: ID(i + 1), sha256: r.sha256 };
  });
  return { texts, objects, files };
}

test('verifyChain: a clean chain is ok; each tampering is reported and nothing else', () => {
  const { objects, files } = chain();
  const objectBytes = (sha) => objects.get(sha) ?? null;
  assert.deepEqual(verifyChain({ receipts: files, objectBytes }).problems, []);

  const altered = files.map((f, i) => (i === 0 ? { ...f, bytes: Buffer.from(f.bytes.toString().replace('First seen', 'Seen first')) } : f));
  assert.deepEqual(verifyChain({ receipts: altered, objectBytes }).problems.map((p) => p.code), ['RCPT_PARENT_ALTERED']);

  assert.deepEqual(verifyChain({ receipts: files.slice(1), objectBytes }).problems.map((p) => p.code), ['RCPT_PARENT_MISSING']);

  const [, second] = [...objects.keys()];
  const gone = (sha) => (sha === second ? null : objects.get(sha) ?? null);
  assert.ok(verifyChain({ receipts: files, objectBytes: gone }).problems.every((p) => p.code === 'RCPT_OBJECT_MISSING'));

  const bad = (sha) => (sha === second ? Buffer.from('tampered') : objects.get(sha) ?? null);
  assert.ok(verifyChain({ receipts: files, objectBytes: bad }).problems.some((p) => p.code === 'RCPT_OBJECT_ALTERED'));

  const gap = files.filter((_, i) => i !== 1).map((f, i) => (i === 1 ? { ...f, bytes: Buffer.from(f.bytes.toString().replace(/parents:[\s\S]*?\n(?=---)/, 'parents: []\n')) } : f));
  assert.ok(verifyChain({ receipts: gap, objectBytes }).problems.some((p) => p.code === 'RCPT_CHAIN_GAP'));

  const mismatch = files.map((f, i) => (i === 2 ? { ...f, bytes: Buffer.from(f.bytes.toString().replace('+line 3', '+line 4')) } : f));
  assert.ok(verifyChain({ receipts: mismatch, objectBytes }).problems.some((p) => p.code === 'RCPT_DIFF_MISMATCH'));

  assert.deepEqual(verifyChain({ receipts: [{ path: 'provenance/x.md', bytes: Buffer.from('nope') }], objectBytes }).problems.map((p) => p.code), ['RCPT_MALFORMED']);
});

test('lineage and blame', () => {
  const { objects, files, texts } = chain();
  const receipts = files.map((f) => ({ ...parseReceipt(f.bytes), path: f.path }));
  const steps = lineage(receipts);
  assert.deepEqual(steps.map((s) => s.label), ['Author wrote (baseline)', 'Author accepted lines 5–5', 'Author revised lines 6–6']);
  const objectBytes = (sha) => objects.get(sha) ?? null;
  const rows = blame({ receipts, objectBytes, currentBytes: texts[2], fromLine: 1, toLine: 9 });
  assert.deepEqual(rows.slice(3).map((r) => r.label), ['Author-written', 'Author text edited with AI', 'Author-written']);
  assert.equal(rows[5].receiptId, ID(3));
  const pending = blame({ receipts, objectBytes, currentBytes: `${texts[2]}extra\n` });
  assert.equal(pending.at(-1).unrecorded, true);
});
