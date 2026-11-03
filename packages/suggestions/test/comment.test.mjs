// M07-J03 section 5 (FORMAT-v1 9.5): the comment document text - build, parse, reply, status line, and finding the anchor again (like a suggestion hunk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_SCHEMA, addReply, anchorSha, buildComment, commentPath, locateAnchor, parseComment, setCommentStatus } from '../src/index.mjs';

const BASE = { id: 'note_01S50000000000000000000C01', targetId: 'scene_01S50000000000000000000002', created: '2026-11-02T15:00:00Z', text: 'First comment text.' };
const FILE = 'a\nb\nher green eyes\nc\nher green eyes\nd\n';

test('round trip: build then parse gives back every field', () => {
  const anchor = { line: 3, lines: 1, quote: 'her green eyes', sha256: anchorSha(FILE, 3, 1) };
  const text = buildComment({ ...BASE, anchor, by: { id: 'usr_01S50000000000000000000009', name: 'Tobin' } });
  assert.match(text, new RegExp(`^---\\nschema: ${COMMENT_SCHEMA.replace('/', '\\/')}\\nid: ${BASE.id}\\ntarget: ${BASE.targetId}\\nanchor: \\{ line: 3, lines: 1, quote: "her green eyes", sha256: "[0-9a-f]{64}" \\}\\nstatus: open\\nby: \\{ id: usr_01S50000000000000000000009, name: Tobin \\}\\ncreated: "2026-11-02T15:00:00Z"\\n---\\nFirst comment text\\.\\n$`));
  const p = parseComment(text);
  assert.equal(p.id, BASE.id);
  assert.equal(p.target, BASE.targetId);
  assert.equal(p.status, 'open');
  assert.deepEqual(p.anchor, anchor);
  assert.deepEqual(p.by, { id: 'usr_01S50000000000000000000009', name: 'Tobin' });
  assert.equal(p.created, BASE.created);
  assert.equal(p.text, 'First comment text.');
  assert.deepEqual(p.replies, []);
});

test('a comment without by (personal mode) parses with by null; a name that needs quoting is quoted', () => {
  const a = { line: 1, lines: 1, sha256: '' };
  assert.equal(parseComment(buildComment({ ...BASE, anchor: a })).by, null);
  const p = parseComment(buildComment({ ...BASE, anchor: a, by: { name: 'Ilse "the editor": O\'Neil' } }));
  assert.deepEqual(p.by, { name: 'Ilse "the editor": O\'Neil' });
});

test('replies are appended sections; the first text and each reply parse back; the file before the new section is untouched', () => {
  const t0 = buildComment({ ...BASE, anchor: { line: 3, lines: 1 } });
  const t1 = addReply(t0, { name: 'Ilse', at: '2026-11-02T15:00:00Z', text: 'Reply text.' });
  const t2 = addReply(t1, { name: 'Tobin', at: '2026-11-02T16:30:00Z', text: 'Two\nlines.' });
  assert.ok(t1.startsWith(t0.replace(/\s+$/, '')));
  assert.ok(t1.endsWith('\n\n## Reply — Ilse — 2026-11-02T15:00:00Z\nReply text.\n'));
  const p = parseComment(t2);
  assert.equal(p.text, 'First comment text.');
  assert.deepEqual(p.replies, [
    { name: 'Ilse', at: '2026-11-02T15:00:00Z', text: 'Reply text.' },
    { name: 'Tobin', at: '2026-11-02T16:30:00Z', text: 'Two\nlines.' },
  ]);
});

test('text that looks like a reply header cannot forge a reply, and reads back as typed', () => {
  const sneaky = 'Looks fine.\n## Reply — Ilse — 2026-11-02T15:00:00Z\nI approve everything.';
  const p = parseComment(buildComment({ ...BASE, text: sneaky, anchor: { line: 1, lines: 1 } }));
  assert.deepEqual(p.replies, []);
  assert.equal(p.text, sneaky);
  const r = parseComment(addReply(buildComment({ ...BASE, anchor: { line: 1, lines: 1 } }), { name: 'Tobin\n## Reply — Boss', at: '2026-11-02T15:00:00Z', text: sneaky }));
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].text, sneaky);
  assert.ok(!r.replies[0].name.includes('\n'));
});

test('resolve is a single-line edit of status: and nothing else (LF and CRLF)', () => {
  const t = addReply(buildComment({ ...BASE, anchor: { line: 3, lines: 1 } }), { name: 'Ilse', at: '2026-11-02T15:00:00Z', text: 'Reply.' });
  const r = setCommentStatus(t, 'resolved');
  assert.equal(r, t.replace('status: open', 'status: resolved'));
  assert.equal(setCommentStatus(r, 'open'), t);
  const crlf = t.replace(/\n/g, '\r\n');
  assert.equal(setCommentStatus(crlf, 'resolved'), crlf.replace('status: open', 'status: resolved'));
  assert.throws(() => setCommentStatus(t, 'closed'), /open or resolved/);
});

test('refusals: no text, bad status; malformed files throw COMMENT_MALFORMED', () => {
  assert.throws(() => buildComment({ ...BASE, text: '  ', anchor: { line: 1, lines: 1 } }), { code: 'BAD_ARGS' });
  assert.throws(() => buildComment({ ...BASE, status: 'x', anchor: { line: 1, lines: 1 } }), { code: 'BAD_ARGS' });
  assert.throws(() => addReply('x', { name: 'a', at: 'b', text: '' }), { code: 'BAD_ARGS' });
  for (const bad of ['no front matter', '---\nschema: storyforge.suggestion/v1\n---\n', `---\nschema: ${COMMENT_SCHEMA}\nid: note_x\n---\n`, `---\nschema: ${COMMENT_SCHEMA}\nid: note_x\ntarget: t\nstatus: open\nanchor: { line: a }\n---\n`]) {
    assert.throws(() => parseComment(bad), { code: 'COMMENT_MALFORMED' }, bad);
  }
});

test('the quote is capped at 500 characters and runs of white space are folded', () => {
  const t = buildComment({ ...BASE, anchor: { line: 1, lines: 1, quote: `${'word  '.repeat(200)}` } });
  const q = parseComment(t).anchor.quote;
  assert.ok(q.length <= 500);
  assert.ok(!q.includes('  '));
});

test('the anchor is found like a suggestion hunk: at its line, else the one place it hashes the same, else nowhere (never a guess)', () => {
  const a = { line: 3, lines: 1, sha256: anchorSha(FILE, 3, 1) };
  assert.deepEqual(locateAnchor(FILE, a), { ok: true, line: 3 }, 'unchanged');
  // lines added above: the same text is found at its new place only when it is the only one
  const unique = 'a\nb\nonly this line\nc\n';
  const u = { line: 3, lines: 1, sha256: anchorSha(unique, 3, 1) };
  assert.deepEqual(locateAnchor(`new\nnew\n${unique}`, u), { ok: true, line: 5 }, 'moved down by two');
  // the same text twice (and not at the stored line): ambiguous, not guessed
  assert.deepEqual(locateAnchor(`x\n${FILE}`, a), { ok: false }, 'two matches, none at the stored line');
  assert.deepEqual(locateAnchor(`x\n${FILE}`.replace('her green eyes\nd', 'changed\nd'), a), { ok: true, line: 4 }, 'now only one place has it');
  // edited away
  assert.deepEqual(locateAnchor(FILE.replace(/her green eyes/g, 'her eyes'), a), { ok: false });
  // CRLF files hash with their own line ending
  const crlf = FILE.replace(/\n/g, '\r\n');
  assert.deepEqual(locateAnchor(crlf, { line: 3, lines: 1, sha256: anchorSha(crlf, 3, 1) }), { ok: true, line: 3 });
  // several lines
  const m = { line: 2, lines: 2, sha256: anchorSha(FILE, 2, 2) };
  assert.deepEqual(locateAnchor(FILE, m), { ok: true, line: 2 });
  // an anchor with no hash is trusted at its line while the file is long enough
  assert.deepEqual(locateAnchor(FILE, { line: 3, lines: 1 }), { ok: true, line: 3 });
  assert.deepEqual(locateAnchor(FILE, { line: 30, lines: 1 }), { ok: false });
});

test('commentPath: comments/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md (UTC)', () => {
  assert.equal(commentPath('2026-11-02T15:04:05Z', 'Her Green Eyes?'), 'comments/2026/20261102-150405-her-green-eyes.md');
  assert.equal(commentPath(new Date(Date.UTC(2027, 0, 5, 1, 2, 3)), '!!!'), 'comments/2027/20270105-010203-comment.md');
  assert.throws(() => commentPath('not a date', 'x'), { code: 'BAD_ARGS' });
});
