// M07-J03b UI logic with no browser: what each role may do (the server is the authority; the UI only hides), the requests, the words, and the save
// controller's shared-mode stale path (409 STALE keeps the buffer as a suggestion; personal mode is untouched).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEARTBEAT_MS, abilities, alsoHereText, commentCreateRequest, commentReplyRequest, commentStatusRequest, commentsUrl, explainCommentFailure, presenceRequest, readComment, splitComments, suggestRequest } from '../src/collab/model.js';
import { createSaveController, DEBOUNCE_MS } from '../src/editor/save-controller.js';
import { readReceipt } from '../src/receipts/model.js';

const shared = (role) => ({ mode: 'shared', user: role ? { role } : null, share: role ? null : { book: 'b', scope: ['read'] } });

test('abilities: personal mode is one implicit owner; in shared mode the role decides; a share link only reads', () => {
  const personal = abilities({ mode: 'personal', user: null, share: null });
  assert.deepEqual([personal.readOnly, personal.comment, personal.suggest, personal.decide, personal.present], [false, true, false, true, false]);
  const owner = abilities(shared('owner'));
  const editor = abilities(shared('editor'));
  assert.deepEqual([owner.readOnly, owner.comment, owner.decide, owner.present], [false, true, true, true]);
  assert.deepEqual([editor.readOnly, editor.comment, editor.suggest, editor.decide], [false, true, false, true]);
  const reviewer = abilities(shared('reviewer'));
  assert.deepEqual([reviewer.readOnly, reviewer.comment, reviewer.suggest, reviewer.decide], [true, true, true, false], 'a reviewer reads, comments and suggests; cannot decide');
  const viewer = abilities(shared('viewer'));
  assert.deepEqual([viewer.readOnly, viewer.comment, viewer.suggest, viewer.decide], [true, false, false, false]);
  const share = abilities(shared(null));
  assert.deepEqual([share.readOnly, share.comment, share.suggest, share.decide, share.present], [true, false, false, false, false]);
  assert.equal(abilities(undefined).decide, true, 'no session at all is personal mode (a part rendered alone)');
});

test('requests: shapes the server routes expect', () => {
  assert.equal(commentsUrl('book_1', 'scene 1'), '/api/books/book_1/comments?target=scene%201');
  assert.deepEqual(commentCreateRequest('b', { target: 's', line: 19, lines: 2, quote: 'q', text: 't' }), { method: 'POST', url: '/api/books/b/comments', body: { target: 's', line: 19, lines: 2, quote: 'q', text: 't' } });
  assert.deepEqual(commentCreateRequest('b', { target: 's', line: 1, lines: 1, text: 't' }).body, { target: 's', line: 1, lines: 1, text: 't' });
  assert.deepEqual(commentReplyRequest('b', 'note_1', 'hi'), { method: 'POST', url: '/api/books/b/comments/note_1/replies', body: { text: 'hi' } });
  assert.deepEqual(commentStatusRequest('b', 'note_1', 'resolved'), { method: 'POST', url: '/api/books/b/comments/note_1', body: { status: 'resolved' } });
  assert.deepEqual(suggestRequest('b', { target: 's', from: 3, to: 9, replacement: 'new', rationale: '  why ' }), { method: 'POST', url: '/api/books/b/suggestions', body: { target: 's', proposedRange: { from: 3, to: 9, replacement: 'new' }, rationale: 'why' } });
  assert.equal('source' in suggestRequest('b', { target: 's', from: 0, to: 1, replacement: 'x' }).body, false, 'the client never names the source: the server decides it from the role');
  assert.deepEqual(presenceRequest('b', 's'), { method: 'POST', url: '/api/books/b/presence', body: { scene: 's' } });
  assert.deepEqual(presenceRequest('b', null).body, { scene: null });
  assert.equal(HEARTBEAT_MS, 20_000);
});

test('words: also in this scene, comment shapes, failures', () => {
  assert.equal(alsoHereText([]), '');
  assert.equal(alsoHereText([{ name: 'Ilse' }]), 'Ilse is also in this scene');
  assert.equal(alsoHereText([{ name: 'Ilse' }, { name: 'Tobin' }]), 'Ilse and Tobin are also in this scene');
  assert.equal(alsoHereText([{ name: 'Ilse' }, { name: 'Tobin' }, { name: 'Mara' }]), 'Ilse, Tobin and Mara are also in this scene');
  assert.equal(alsoHereText([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]), 'A, B and 2 others are also in this scene');
  assert.equal(alsoHereText([{ name: 'Ilse' }, { name: 'Ilse' }]), 'Ilse is also in this scene', 'two tabs of one person are one person');
  const c = readComment({ id: 'note_1', status: 'open', by: { name: 'Mara' }, created: '2026-11-02T15:00:00Z', text: 'x', anchor: { quote: 'q' }, line: 19, anchored: true, replies: [{ name: 'Ilse', at: '2026-11-02T16:00:00Z', text: 'r' }] });
  assert.deepEqual([c.by, c.quote, c.line, c.anchored, c.replies.length], ['Mara', 'q', 19, true, 1]);
  assert.deepEqual(readComment({}), { id: '', status: 'open', by: null, created: '', text: '', quote: '', line: null, anchored: false, replies: [] });
  const list = [readComment({ id: 'b', line: 30 }), readComment({ id: 'a', line: 4 }), readComment({ id: 'c', status: 'resolved', line: 1 })];
  const { open, resolved } = splitComments(list);
  assert.deepEqual(open.map((x) => x.id), ['a', 'b'], 'open comments in file order');
  assert.deepEqual(resolved.map((x) => x.id), ['c']);
  assert.match(explainCommentFailure(403, null), /role/);
  assert.match(explainCommentFailure(0, null), /could not be reached/);
  assert.match(explainCommentFailure(409, { code: 'NO_CHANGE' }), /same text/);
});

test('a receipt shows who did it (by) when it has one', () => {
  assert.deepEqual(readReceipt({ id: 'rcpt_1', actor: 'author', by: { id: 'usr_1', name: 'Tobin' } }).by, { name: 'Tobin' });
  assert.equal(readReceipt({ id: 'rcpt_1', actor: 'author' }).by, null);
});

// ------------------------------------------------------------------ the save controller in shared mode

const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
function noTimers() {
  return { setTimeout: () => 0, clearTimeout: () => {} };
}

test('shared mode: a 409 STALE puts the controller in conflict with the suggestion id and the current text; autosave stops; the buffer is kept', async () => {
  const puts = [];
  const fetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return respond(409, { error: 'STALE', code: 'STALE', current: { sha256: 'sha-theirs', body: 'their text\n' }, kept: true, suggestion: { id: 'note_SUG', path: 'suggestions/2026/x.md' } });
    }
    return respond(200, { sha256: 'sha-theirs', body: 'their text\n' });
  };
  const c = createSaveController({ bookId: 'b', sceneId: 's', text: 'base\n', sha256: 'sha-0', fetch, timers: noTimers(), shared: true });
  c.edit('my text\n');
  await c.saveNow();
  const snap = c.snapshot();
  assert.equal(snap.state, 'conflict');
  assert.deepEqual(snap.conflict, { currentSha256: 'sha-theirs', currentText: 'their text\n', stale: true, suggestionId: 'note_SUG' });
  assert.equal(snap.text, 'my text\n', 'the buffer is still the author text');
  assert.equal(puts.length, 1);
  await c.saveNow();
  assert.equal(puts.length, 1, 'no further save while the conflict is open');
  // "Use their version" when the text was kept: the buffer is replaced by the file
  const r = await c.adoptDisk({ preserve: false });
  assert.equal(r.ok, true);
  assert.equal(c.snapshot().state, 'clean');
  assert.equal(c.snapshot().text, 'their text\n');
  assert.equal(c.snapshot().baseSha256, 'sha-theirs');
});

test('personal mode: the plain 409 conflict has no suggestion id and no stale flag (unchanged)', async () => {
  const fetch = async (url, init = {}) => (init.method === 'PUT' ? respond(409, { error: 'conflict', current: { sha256: 'sha-x', body: 'disk\n' } }) : respond(200, { sha256: 'sha-x', body: 'disk\n' }));
  const c = createSaveController({ bookId: 'b', sceneId: 's', text: 'base\n', sha256: 'sha-0', fetch, timers: noTimers() });
  c.edit('mine\n');
  await c.saveNow();
  assert.deepEqual(c.snapshot().conflict, { currentSha256: 'sha-x', currentText: 'disk\n' });
});

test('shared mode: a change seen on disk while the buffer is dirty is sent as a save at once (the server keeps both); a clean buffer just reloads; personal mode still goes to conflict', async () => {
  const mk = (shared) => {
    const log = [];
    const fetch = async (url, init = {}) => {
      if (init.method === 'PUT') {
        log.push('PUT');
        return respond(409, { error: 'STALE', current: { sha256: 'sha-d', body: 'disk\n' }, suggestion: { id: 'note_S' } });
      }
      log.push('GET');
      return respond(200, { sha256: 'sha-d', body: 'disk\n' });
    };
    return { log, c: createSaveController({ bookId: 'b', sceneId: 's', text: 'base\n', sha256: 'sha-0', fetch, timers: noTimers(), shared }) };
  };
  const a = mk(true);
  a.c.edit('mine\n');
  const r = await a.c.checkDisk();
  await settle();
  assert.equal(r.action, 'ignored');
  assert.deepEqual(a.log, ['GET', 'PUT']);
  assert.equal(a.c.snapshot().state, 'conflict');
  assert.equal(a.c.snapshot().conflict?.suggestionId, 'note_S');

  const clean = mk(true);
  const r2 = await clean.c.checkDisk();
  assert.equal(r2.action, 'reload');
  assert.deepEqual(clean.log, ['GET'], 'nothing to save: no PUT');

  const p = mk(false);
  p.c.edit('mine\n');
  const r3 = await p.c.checkDisk();
  assert.equal(r3.action, 'conflict');
  assert.deepEqual(p.log, ['GET'], 'personal mode: no automatic save, the author chooses');
  assert.equal(p.c.snapshot().conflict?.stale, undefined);
  assert.ok(DEBOUNCE_MS > 0);
});
