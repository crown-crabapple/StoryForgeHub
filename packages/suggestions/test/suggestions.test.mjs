// M05-J06 section 7: the pure suggestion package. buildSuggestion / parseSuggestion / applyHunk / setHunkStatus / suggestionPath.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 1, 1.1, 1.2, 7 and acceptance 2 and 4.
// The oracle is independent of the product: expected bytes are made by splicing the original's lines in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as S from '../src/index.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const CREATED = '2026-11-02T14:03:22Z';
const ARRIVAL_LF = [
  '---', 'schema: storyforge.scene/v1', 'id: scene_01S50000000000000000000002', 'title: Arrival', '---',
  'The ferry nudged the jetty and the ferryman threw her bag ashore.', '',
  'In the glass of the ticket hut she caught her own face, green eyes ringed with salt, and looked away.', '',
  'Past the dunes lay the orchard, half under water.', '',
].join('\n');
// 1-based line numbers of the three prose lines in ARRIVAL_*
const L1 = 6, L2 = 8, L3 = 10;
const NEW1 = 'The ferry bumped the jetty and the ferryman flung her bag ashore.';
const NEW2 = 'In the glass of the ticket hut she caught her own face, grey eyes ringed with salt, and looked away.';
const NEW3 = 'Past the dunes lay the orchard, half drowned.';

/** Split into lines the way the contract counts them (a final line ending does not start another line). */
function linesOf(text, eol) {
  const parts = text.split(eol);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
/** Oracle: replace `count` lines starting at 1-based `line` with `newLines`; keeps the file's own line ending and trailing-newline state. */
function splice(text, line, count, newLines) {
  const eol = eolOf(text);
  const trailing = text.endsWith(eol);
  const ls = linesOf(text, eol);
  ls.splice(line - 1, count, ...newLines);
  return ls.join(eol) + (trailing ? eol : '');
}
/** Oracle: single-line replacements [[line, text]] (same line count). */
const mutate = (text, edits) => {
  const eol = eolOf(text);
  const trailing = text.endsWith(eol);
  const ls = linesOf(text, eol);
  for (const [line, t] of edits) ls[line - 1] = t;
  return ls.join(eol) + (trailing ? eol : '');
};
const build = (base, proposed, extra = {}) =>
  S.buildSuggestion({
    id: 'note_01S5000000000000000000000S',
    targetId: 'scene_01S50000000000000000000002',
    targetPath: 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md',
    baseBytes: Buffer.from(base),
    proposedBytes: Buffer.from(proposed),
    source: 'claude-book',
    mode: 'suggest',
    created: CREATED,
    ...extra,
  });
const threeEdits = (base) => mutate(base, [[L1, NEW1], [L2, NEW2], [L3, NEW3]]);
const applyOk = (base, parsed, id) => {
  const r = S.applyHunk(Buffer.from(base), parsed, id);
  assert.equal(r.ok, true, `applyHunk ${id}: ${JSON.stringify(r)}`);
  return r;
};
const str = (b) => Buffer.from(b).toString('utf8');

test('three separated changed lines make three one-line hunks h1..h3 with the right line numbers and original hashes', () => {
  const { text, hunks } = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF));
  assert.equal(hunks.length, 3);
  const p = S.parseSuggestion(text);
  assert.deepEqual(p.hunks.map((h) => [h.id, h.line, h.lines, h.status]), [['h1', L1, 1, 'pending'], ['h2', L2, 1, 'pending'], ['h3', L3, 1, 'pending']]);
  const orig = linesOf(ARRIVAL_LF, '\n');
  p.hunks.forEach((h) => {
    assert.deepEqual(h.originalLines, [orig[h.line - 1]]);
    assert.equal(h.original_sha256, sha(orig[h.line - 1]));
    assert.equal(h.newLines.length, 1);
  });
  assert.deepEqual(p.hunks.map((h) => h.newLines[0]), [NEW1, NEW2, NEW3]);
  assert.match(text, /^@@ -6,1 \+6,1 @@ h1$/m);
  assert.match(text, /^@@ -8,1 \+8,1 @@ h2$/m);
});

test('front matter carries the documented fields; base_sha256 is the sha256 of the base bytes', () => {
  const ai = { provider: 'mock', model: 'm1', locality: 'local', context_sha256: 'ab'.repeat(32) };
  const { text } = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF), { rationale: 'Tighten the eyes.', source: 'ai', ai });
  const p = S.parseSuggestion(text);
  assert.equal(p.fm.schema, 'storyforge.suggestion/v1');
  assert.equal(p.fm.id, 'note_01S5000000000000000000000S');
  assert.equal(p.fm.target, 'scene_01S50000000000000000000002');
  assert.equal(p.fm.target_path, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md');
  assert.equal(p.fm.base_sha256, sha(ARRIVAL_LF));
  assert.equal(p.fm.source, 'ai');
  assert.equal(p.fm.mode, 'suggest');
  assert.equal(p.fm.status, 'pending');
  assert.equal(String(p.fm.created), CREATED);
  assert.deepEqual({ ...p.fm.ai }, ai);
  assert.match(p.rationale, /Tighten the eyes\./);
});

test('no ai block unless one was given', () => {
  const { text } = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF));
  assert.equal(S.parseSuggestion(text).fm.ai, undefined);
});

test('adjacent changed lines are one hunk; an unchanged line between makes two', () => {
  const adjacent = mutate(ARRIVAL_LF, [[L1, 'A.'], [L1 + 1, 'B.']]);
  let p = S.parseSuggestion(build(ARRIVAL_LF, adjacent).text);
  assert.deepEqual(p.hunks.map((h) => [h.line, h.lines]), [[L1, 2]]);
  const gap = mutate(ARRIVAL_LF, [[L1, 'A.'], [L1 + 2, 'B.']]);
  p = S.parseSuggestion(build(ARRIVAL_LF, gap).text);
  assert.deepEqual(p.hunks.map((h) => [h.line, h.lines]), [[L1, 1], [L1 + 2, 1]]);
});

test('accepting one hunk changes only that hunk range; every other byte is the original', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const r = applyOk(ARRIVAL_LF, p, 'h2');
  assert.equal(str(r.bytes), mutate(ARRIVAL_LF, [[L2, NEW2]]));
});

test('applying every hunk in turn (each on the previous result) reproduces the proposed bytes, in any order', () => {
  const proposed = threeEdits(ARRIVAL_LF);
  const p = S.parseSuggestion(build(ARRIVAL_LF, proposed).text);
  for (const order of [['h1', 'h2', 'h3'], ['h3', 'h2', 'h1'], ['h2', 'h3', 'h1']]) {
    let cur = ARRIVAL_LF;
    for (const id of order) cur = str(applyOk(cur, p, id).bytes);
    assert.equal(cur, proposed, `order ${order}`);
  }
});

test('line counts that change (insert, delete, grow, shrink) still round-trip through applyHunk, in any order', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
  const cases = {
    grow: ['a', 'B1', 'B2', 'B3', 'c', 'd', 'e', 'F', 'g', 'h', 'i', 'J'],
    shrink: ['a', 'c', 'd', 'e', 'f', 'g', 'H', 'j'],
    insertOnly: ['a', 'b', 'NEW', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    deleteOnly: ['a', 'b', 'c', 'e', 'f', 'g', 'h', 'i', 'j'],
    appendEnd: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'TAIL'],
    prependStart: ['HEAD', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  };
  for (const [name, ls] of Object.entries(cases)) {
    const proposed = ls.join('\n') + '\n';
    const p = S.parseSuggestion(build(base, proposed).text);
    assert.ok(p.hunks.length >= 1, name);
    const ids = p.hunks.map((h) => h.id);
    for (const order of [ids, [...ids].reverse()]) {
      let cur = base;
      for (const id of order) cur = str(applyOk(cur, p, id).bytes);
      assert.equal(cur, proposed, `${name} ${order}`);
    }
  }
});

test('repeated lines: all hunks together reproduce the proposal and the diff is deterministic', () => {
  const base = 'x\ny\nx\ny\nx\ny\n';
  const proposed = 'x\ny\nx\n';
  const a = build(base, proposed).text;
  assert.equal(a, build(base, proposed).text);
  const p = S.parseSuggestion(a);
  let cur = base;
  for (const h of p.hunks) cur = str(applyOk(cur, p, h.id).bytes);
  assert.equal(cur, proposed);
});

test('determinism: the same inputs give byte-identical text', () => {
  const a = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF), { rationale: 'r' });
  const b = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF), { rationale: 'r' });
  assert.equal(a.text, b.text);
});

test('NO_CHANGE: an identical proposal is refused', () => {
  assert.throws(() => build(ARRIVAL_LF, ARRIVAL_LF), (e) => e.code === 'NO_CHANGE');
});

test('CRLF base: original_sha256 hashes the line text; accept keeps every other CRLF and changes only the range', () => {
  const crlf = ARRIVAL_LF.replace(/\n/g, '\r\n');
  const p = S.parseSuggestion(build(crlf, threeEdits(crlf)).text);
  assert.equal(p.hunks.length, 3);
  assert.equal(p.hunks[1].original_sha256, sha(linesOf(crlf, '\r\n')[L2 - 1]));
  const out = str(applyOk(crlf, p, 'h2').bytes);
  assert.equal(out, mutate(crlf, [[L2, NEW2]]));
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced');
});

test('CRLF base with an LF proposal (alternative text typed elsewhere): only the changed lines become hunks and the file stays CRLF', () => {
  const crlf = ARRIVAL_LF.replace(/\n/g, '\r\n');
  const p = S.parseSuggestion(build(crlf, threeEdits(ARRIVAL_LF)).text);
  assert.deepEqual(p.hunks.map((h) => h.line), [L1, L2, L3]);
  assert.equal(str(applyOk(crlf, p, 'h1').bytes), mutate(crlf, [[L1, NEW1]]));
});

test('a file without a trailing newline keeps that state when its last line is replaced', () => {
  const base = 'one\ntwo\nthree';
  const p = S.parseSuggestion(build(base, 'one\ntwo\nTHREE').text);
  assert.equal(str(applyOk(base, p, p.hunks[p.hunks.length - 1].id).bytes), 'one\ntwo\nTHREE');
});

test('non-ASCII text is preserved outside the range and hashed as UTF-8', () => {
  const base = 'café au lait\n“quoted” line\nnaïve end\n';
  const proposed = 'café au lait\n“quoted” CHANGED\nnaïve end\n';
  const p = S.parseSuggestion(build(base, proposed).text);
  assert.equal(p.hunks[0].original_sha256, sha('“quoted” line'));
  assert.equal(str(applyOk(base, p, 'h1').bytes), proposed);
});

test('stale: the hunk original lines were edited, so applyHunk refuses with SUGGESTION_STALE; untouched hunks still apply', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const edited = mutate(ARRIVAL_LF, [[L2, 'In the glass of the ticket hut she saw herself, green eyes ringed with salt.']]);
  const r = S.applyHunk(Buffer.from(edited), p, 'h2');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUGGESTION_STALE');
  assert.equal(S.applyHunk(Buffer.from(edited), p, 'h1').ok, true);
});

test('moved but unique: lines inserted above shift the hunk; it is accepted at the new place and nothing else changes', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const shifted = splice(ARRIVAL_LF, L1, 0, ['A new opening line.', '']);
  const r = applyOk(shifted, p, 'h2');
  assert.equal(r.at, L2 + 2);
  assert.equal(str(r.bytes), mutate(shifted, [[L2 + 2, NEW2]]));
});

test('moved and ambiguous (original lines appear twice, neither at the recorded line) is stale and returns no bytes', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const orig = linesOf(ARRIVAL_LF, '\n')[L2 - 1];
  const t = mutate(ARRIVAL_LF, [[L2, 'Something else entirely.']]) + `\n${orig}\n\n${orig}\n`;
  const r = S.applyHunk(Buffer.from(t), p, 'h2');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUGGESTION_STALE');
  assert.equal(r.bytes, undefined);
});

test('duplicates elsewhere do not matter while the recorded line still hashes to original_sha256', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const orig = linesOf(ARRIVAL_LF, '\n')[L2 - 1];
  const r = applyOk(ARRIVAL_LF + `${orig}\n`, p, 'h2');
  assert.equal(r.at, L2);
});

test('applyHunk on an unknown hunk id does not succeed', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  let r;
  try {
    r = S.applyHunk(Buffer.from(ARRIVAL_LF), p, 'h99');
  } catch {
    return; // throwing is an acceptable refusal
  }
  assert.notEqual(r.ok, true);
});

test('applyHunk does not modify the bytes it was given', () => {
  const p = S.parseSuggestion(build(ARRIVAL_LF, threeEdits(ARRIVAL_LF)).text);
  const input = Buffer.from(ARRIVAL_LF);
  const copy = Buffer.from(input);
  applyOk(input, p, 'h1');
  assert.ok(input.equals(copy));
});

test('setHunkStatus: one accepted hunk makes the suggestion partial; the other hunks and the diff block are untouched', () => {
  const { text } = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF), { rationale: 'Why.' });
  const t2 = S.setHunkStatus(text, ['h2'], 'accepted', '2026-11-02T14:05:00Z');
  const p = S.parseSuggestion(t2);
  assert.deepEqual(p.hunks.map((h) => h.status), ['pending', 'accepted', 'pending']);
  assert.equal(p.fm.status, 'partial');
  assert.equal(String(p.fm.hunks.find((h) => h.id === 'h2').decided), '2026-11-02T14:05:00Z');
  assert.equal(p.fm.hunks.find((h) => h.id === 'h1').decided, undefined);
  const before = S.parseSuggestion(text);
  const key = (h) => [h.id, h.line, h.lines, h.original_sha256, h.originalLines, h.newLines];
  assert.deepEqual(p.hunks.map(key), before.hunks.map(key));
  const bodyOf = (t) => t.slice(t.indexOf('\n---', 4) + 4);
  assert.equal(bodyOf(t2), bodyOf(text));
});

test('setHunkStatus: all accepted -> accepted; all declined -> declined; several ids in one call or across calls', () => {
  const { text } = build(ARRIVAL_LF, threeEdits(ARRIVAL_LF));
  const acc = S.parseSuggestion(S.setHunkStatus(text, ['h1', 'h2', 'h3'], 'accepted', CREATED));
  assert.equal(acc.fm.status, 'accepted');
  assert.deepEqual(acc.hunks.map((h) => h.status), ['accepted', 'accepted', 'accepted']);
  const dec = S.parseSuggestion(S.setHunkStatus(text, ['h1', 'h2', 'h3'], 'declined', CREATED));
  assert.equal(dec.fm.status, 'declined');
  const twoStep = S.parseSuggestion(S.setHunkStatus(S.setHunkStatus(text, ['h1'], 'accepted', CREATED), ['h2', 'h3'], 'accepted', CREATED));
  assert.equal(twoStep.fm.status, 'accepted');
});

test('suggestionPath(created, slug) is suggestions/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md', () => {
  assert.equal(S.suggestionPath('2026-11-02T14:03:22Z', 'arrival-eyes'), 'suggestions/2026/20261102-140322-arrival-eyes.md');
  assert.equal(S.suggestionPath('2027-01-01T00:00:00Z', 'x'), 'suggestions/2027/20270101-000000-x.md');
});
