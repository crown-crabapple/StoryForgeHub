import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunk, buildSuggestion, parseSuggestion, setHunkStatus, suggestionPath } from '../src/index.mjs';

const base = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''].join('\n');
const proposed = ['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine', ''].join('\n');
const make = (b = base, p = proposed) =>
  buildSuggestion({
    id: 'note_01X',
    targetId: 'scene_01X',
    targetPath: 'a.md',
    baseBytes: Buffer.from(b),
    proposedBytes: Buffer.from(p),
    source: 'ai',
    mode: 'suggest',
    created: '2026-11-02T14:03:22Z',
    ai: { provider: 'mock', model: 'm', locality: 'local', context_sha256: 'abc' },
  });

test('build splits into hunks and parses back', () => {
  const { text, hunks } = make();
  assert.equal(hunks.length, 2);
  assert.deepEqual(parseSuggestion(text).hunks.map((h) => [h.id, h.line, h.lines]), [['h1', 2, 1], ['h2', 8, 1]]);
  assert.equal(parseSuggestion(text).fm.ai.locality, 'local');
});

test('NO_CHANGE', () => {
  assert.throws(() => make(base, base), { code: 'NO_CHANGE' });
});

test('apply one hunk changes only its lines; moved lines are found; edited lines are stale', () => {
  const p = parseSuggestion(make().text);
  const r = applyHunk(Buffer.from(base), p, 'h2');
  assert.equal(r.ok, true);
  assert.equal(r.bytes.toString(), ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine', ''].join('\n'));
  const moved = applyHunk(Buffer.from(`new top\n${base}`), p, 'h2');
  assert.equal(moved.ok && moved.at, 9);
  assert.deepEqual(applyHunk(Buffer.from(base.replace('eight', 'edited')), p, 'h2'), { ok: false, code: 'SUGGESTION_STALE' });
});

test('CRLF files keep their line ending', () => {
  const crlf = base.replace(/\n/g, '\r\n');
  const p = parseSuggestion(make(crlf, proposed.replace(/\n/g, '\r\n')).text);
  const r = applyHunk(Buffer.from(crlf), p, 'h1');
  assert.equal(r.bytes.toString(), crlf.replace('two', 'TWO'));
});

test('setHunkStatus updates the hunk and the derived status', () => {
  const { text } = make();
  const t1 = setHunkStatus(text, ['h2'], 'accepted', '2026-11-02T14:05:00Z');
  assert.match(t1, /^status: partial$/m);
  assert.equal(parseSuggestion(t1).hunks[1].decided, '2026-11-02T14:05:00Z');
  assert.match(setHunkStatus(t1, ['h1'], 'accepted', 'x'), /^status: accepted$/m);
  assert.match(setHunkStatus(text, ['h1', 'h2'], 'declined', 'x'), /^status: declined$/m);
});

test('pure insertion is anchored; new file from empty base', () => {
  const t = make('a\nb\n', 'a\nx\nb\n');
  assert.equal(applyHunk(Buffer.from('a\nb\n'), parseSuggestion(t.text), 'h1').bytes.toString(), 'a\nx\nb\n');
  const n = buildSuggestion({ id: 'note_01X', targetId: '', targetPath: 'x.md', baseBytes: Buffer.from(''), proposedBytes: Buffer.from('hello\nworld\n'), source: 'claude-book', mode: 'state', created: '2026-11-02T14:03:22Z' });
  assert.equal(applyHunk(Buffer.from(''), parseSuggestion(n.text), 'h1').bytes.toString(), 'hello\nworld\n');
});

test('suggestionPath', () => {
  assert.equal(suggestionPath('2026-11-02T14:03:22Z', 'Fix the Eyes!'), 'suggestions/2026/20261102-140322-fix-the-eyes.md');
});
