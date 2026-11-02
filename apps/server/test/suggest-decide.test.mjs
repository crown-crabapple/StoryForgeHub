// M05-J06 acceptance 2, 3, 4 and 7 (suggestion half): deciding suggestion hunks over HTTP.
//   POST /api/books/:b/suggestions/:id/hunks/:h { decision: 'accept' | 'decline' }
//   POST /api/books/:b/suggestions/:id          { decision: 'accept' | 'decline' }       (all pending hunks)
//   Undo = POST /api/books/:b/ops/:opId/restore
// The suggestion is written by suggest-helpers.mjs from the contract's layout (not by the product); expected scene bytes are spliced from the original here.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 1, 1.2, 6 (items 2, 3, 4, 7).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { __hooks } from '../../../packages/core/src/hooks.mjs';
import { validate } from '../../../packages/format/src/index.mjs';
import { closeAll, freshBook, send } from './move-helpers.mjs';
import {
  A, ARRIVAL, ARRIVAL_PATH, NEW, SUG, SUG_ID, SUG_PATH, changedContent, fmOf, insertBefore, linesOf, opIdOf, readBytes, readText, replaceLines, sha, tree, withSuggestion,
} from './suggest-helpers.mjs';

after(closeAll);
afterEach(() => {
  __hooks.onProvenance = undefined;
});

const post = (port, url, body) => send(port, 'POST', url, { body });
const accept = (port, h) => post(port, SUG.decideHunk(SUG_ID, h), { decision: 'accept' });
const decline = (port, h) => post(port, SUG.decideHunk(SUG_ID, h), { decision: 'decline' });
const statuses = async (root) => fmOf(await readText(root, SUG_PATH)).hunks.map((h) => [h.id, h.status]);
const events = () => {
  const seen = [];
  __hooks.onProvenance = (e) => seen.push(e);
  return seen;
};

test('the fixture lines the tests splice are really lines 15, 17 and 19 of Arrival', async () => {
  const { root } = await freshBook('valid/salt-orchard', withSuggestion());
  const ls = linesOf(await readText(root, ARRIVAL_PATH));
  assert.match(ls[A.L1 - 1], /^The ferry nudged the jetty/);
  assert.match(ls[A.L2 - 1], /green eyes ringed with salt/);
  assert.match(ls[A.L3 - 1], /^Past the dunes lay/);
});

test('accept h2: only line 17 changes, rest of Arrival byte-identical; suggestion is partial; Undo restores both files byte-identically', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  const sugBefore = await readBytes(root, SUG_PATH);
  const before = await tree(root);

  const r = await accept(port, 'h2');
  assert.equal(r.status, 200, r.text);

  const expected = replaceLines(sceneBefore.toString('utf8'), { [A.L2]: NEW[17] });
  assert.equal(await readText(root, ARRIVAL_PATH), expected);
  assert.deepEqual(await statuses(root), [['h1', 'pending'], ['h2', 'accepted'], ['h3', 'pending']]);
  assert.equal(fmOf(await readText(root, SUG_PATH)).status, 'partial');
  const h2 = fmOf(await readText(root, SUG_PATH)).hunks.find((h) => h.id === 'h2');
  assert.ok(h2.decided, 'decided timestamp recorded');
  // nothing else in the book changed
  assert.deepEqual(changedContent(before, await tree(root)), [ARRIVAL_PATH, SUG_PATH].sort());

  // journaled: the response names an op that Undo can restore
  const op = opIdOf(r);
  assert.equal(typeof op, 'string', `undo op in response: ${r.text}`);
  const u = await post(port, SUG.restore(op), {});
  assert.equal(u.status, 200, u.text);
  assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore), 'scene byte-identical after Undo');
  assert.ok((await readBytes(root, SUG_PATH)).equals(sugBefore), 'suggestion byte-identical after Undo');
  assert.deepEqual(changedContent(before, await tree(root)), []);
});

test('accepting the hunks one after another (h1, h3, h2) ends accepted with the fully proposed scene; line numbers recorded in the suggestion do not matter', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const pristine = await readText(root, ARRIVAL_PATH);
  for (const h of ['h1', 'h3', 'h2']) assert.equal((await accept(port, h)).status, 200, h);
  assert.equal(await readText(root, ARRIVAL_PATH), replaceLines(pristine, { 15: NEW[15], 17: NEW[17], 19: NEW[19] }));
  assert.equal(fmOf(await readText(root, SUG_PATH)).status, 'accepted');
  assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.severity === 'error'), []);
});

test('POST on the suggestion with accept applies every pending hunk (and skips hunks already decided)', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const pristine = await readText(root, ARRIVAL_PATH);
  assert.equal((await decline(port, 'h1')).status, 200);
  const r = await post(port, SUG.decide(SUG_ID), { decision: 'accept' });
  assert.equal(r.status, 200, r.text);
  assert.equal(await readText(root, ARRIVAL_PATH), replaceLines(pristine, { 17: NEW[17], 19: NEW[19] }));
  assert.deepEqual(await statuses(root), [['h1', 'declined'], ['h2', 'accepted'], ['h3', 'accepted']]);
});

test('accept all then Undo returns both files to the exact original bytes', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  const sugBefore = await readBytes(root, SUG_PATH);
  const r = await post(port, SUG.decide(SUG_ID), { decision: 'accept' });
  assert.equal(r.status, 200, r.text);
  assert.ok(!(await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore));
  const u = await post(port, SUG.restore(opIdOf(r)), {});
  assert.equal(u.status, 200, u.text);
  assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore));
  assert.ok((await readBytes(root, SUG_PATH)).equals(sugBefore));
});

test('accepting a hunk on a CRLF scene keeps CRLF everywhere and changes only the range', async () => {
  const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
  const { root, port } = await freshBook('valid/salt-orchard', async (r) => {
    const f = path.join(r, ...ARRIVAL_PATH.split('/'));
    await fs.writeFile(f, crlf(await fs.readFile(f, 'utf8')));
    await withSuggestion()(r); // suggestion made against the CRLF file
  });
  const before = await readText(root, ARRIVAL_PATH);
  assert.ok(before.includes('\r\n'));
  const r = await accept(port, 'h2');
  assert.equal(r.status, 200, r.text);
  const after = await readText(root, ARRIVAL_PATH);
  assert.equal(after, replaceLines(before, { [A.L2]: NEW[17] }));
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF');
});

test('decline all: the scene is byte-for-byte unchanged and only the suggestion file changes', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const before = await tree(root);
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  const r = await post(port, SUG.decide(SUG_ID), { decision: 'decline' });
  assert.equal(r.status, 200, r.text);
  assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore));
  const after = await tree(root);
  assert.deepEqual(changedContent(before, after), [SUG_PATH]);
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)), [], 'no file created');
  assert.deepEqual(Object.keys(before).filter((k) => !(k in after)), [], 'no file removed');
  assert.deepEqual(await statuses(root), [['h1', 'declined'], ['h2', 'declined'], ['h3', 'declined']]);
  assert.equal(fmOf(await readText(root, SUG_PATH)).status, 'declined');
});

test('decline one hunk: the scene is untouched, the others stay pending, status is partial or pending (not accepted)', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  assert.equal((await decline(port, 'h3')).status, 200);
  assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore));
  assert.deepEqual(await statuses(root), [['h1', 'pending'], ['h2', 'pending'], ['h3', 'declined']]);
  assert.notEqual(fmOf(await readText(root, SUG_PATH)).status, 'accepted');
});

test('decline works even when the target no longer matches (declining never needs the target)', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => replaceLines(t, { 17: 'Entirely different.' }) }));
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  assert.equal((await decline(port, 'h2')).status, 200);
  assert.ok((await readBytes(root, ARRIVAL_PATH)).equals(sceneBefore));
});

test('stale: the hunk original lines were edited elsewhere -> 409 SUGGESTION_STALE and nothing is written', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => replaceLines(t, { 17: 'In the glass of the hut she saw herself, green eyes and salt.' }) }));
  const before = await tree(root);
  const r = await accept(port, 'h2');
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'SUGGESTION_STALE');
  assert.deepEqual(changedContent(before, await tree(root)), [], 'no file changed');
  assert.deepEqual(await statuses(root), [['h1', 'pending'], ['h2', 'pending'], ['h3', 'pending']]);
});

test('stale hunk does not block the other hunks of the same suggestion', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => replaceLines(t, { 17: 'Changed by the author.' }) }));
  const sceneBefore = (await readText(root, ARRIVAL_PATH));
  assert.equal((await accept(port, 'h2')).status, 409);
  const r = await accept(port, 'h3');
  assert.equal(r.status, 200, r.text);
  assert.equal(await readText(root, ARRIVAL_PATH), replaceLines(sceneBefore, { 19: NEW[19] }));
});

test('accept all with one stale hunk writes nothing at all (409 SUGGESTION_STALE)', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => replaceLines(t, { 19: 'Changed by the author.' }) }));
  const before = await tree(root);
  const r = await post(port, SUG.decide(SUG_ID), { decision: 'accept' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'SUGGESTION_STALE');
  assert.deepEqual(changedContent(before, await tree(root)), []);
});

test('moved but unique: lines were added above, the hunk is accepted at its new place and nothing else changes', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => insertBefore(t, 15, ['A line added after the suggestion was made.', '']) }));
  const moved = await readText(root, ARRIVAL_PATH);
  const r = await accept(port, 'h2');
  assert.equal(r.status, 200, r.text);
  assert.equal(await readText(root, ARRIVAL_PATH), replaceLines(moved, { 19: NEW[17] }), 'old line 17 is now line 19');
});

test('accepting with no body decision, or a bad decision, is refused and writes nothing', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const before = await tree(root);
  for (const body of [{}, { decision: 'maybe' }]) {
    const r = await post(port, SUG.decideHunk(SUG_ID, 'h1'), body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
  }
  const unknownHunk = await post(port, SUG.decideHunk(SUG_ID, 'h99'), { decision: 'accept' });
  assert.ok(unknownHunk.status >= 400 && unknownHunk.status < 500, `unknown hunk -> ${unknownHunk.status}`);
  const unknownSug = await post(port, SUG.decide('note_01S5ZZZZZZZZZZZZZZZZZZZZZZ'), { decision: 'accept' });
  assert.equal(unknownSug.status, 404);
  assert.deepEqual(changedContent(before, await tree(root)), []);
});

test('the decide routes are write-guarded: without the x-storyforge header nothing is written', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const before = await tree(root);
  const r = await send(port, 'POST', SUG.decideHunk(SUG_ID, 'h2'), { headers: { 'content-type': 'application/json' }, body: { decision: 'accept' } });
  assert.ok(r.status === 403 || r.status === 400 || r.status === 405, `status ${r.status}`);
  const r2 = await send(port, 'POST', SUG.decide(SUG_ID), { headers: { 'content-type': 'application/json' }, body: { decision: 'accept' } });
  assert.ok(r2.status === 403 || r2.status === 400 || r2.status === 405, `status ${r2.status}`);
  assert.deepEqual(changedContent(before, await tree(root)), []);
});

// ---- 7: provenance hook shapes ---------------------------------------------------------------------------------------

test('provenance: accepting a hunk reports suggestion.accept with ids, hashes before/after and the diff', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const sceneBefore = await readBytes(root, ARRIVAL_PATH);
  const seen = events();
  const r = await accept(port, 'h2');
  assert.equal(r.status, 200, r.text);
  const ev = seen.filter((e) => e.kind === 'suggestion.accept');
  assert.equal(ev.length, 1, JSON.stringify(seen.map((e) => e.kind)));
  const e = ev[0];
  assert.equal(e.suggestionId, SUG_ID);
  assert.deepEqual(e.hunkIds, ['h2']);
  assert.ok([ARRIVAL, ARRIVAL_PATH].includes(e.target), `target ${e.target}`);
  assert.equal(e.before_sha256, sha(sceneBefore));
  assert.equal(e.after_sha256, sha(await readBytes(root, ARRIVAL_PATH)));
  assert.equal(typeof e.diff, 'string');
  assert.ok(e.diff.includes(NEW[17]), 'diff carries the new line');
  assert.ok(e.diff.includes('green eyes ringed with salt'), 'diff carries the original line');
});

test('provenance: accept all reports every hunk id in one event', async () => {
  const { port } = await freshBook('valid/salt-orchard', withSuggestion());
  const seen = events();
  assert.equal((await post(port, SUG.decide(SUG_ID), { decision: 'accept' })).status, 200);
  const ev = seen.filter((e) => e.kind === 'suggestion.accept');
  assert.equal(ev.length, 1);
  assert.deepEqual([...ev[0].hunkIds].sort(), ['h1', 'h2', 'h3']);
});

test('provenance: declining reports suggestion.decline; the target hash is unchanged; a stale accept reports no accept', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', withSuggestion());
  const seen = events();
  const sceneSha = sha(await readBytes(root, ARRIVAL_PATH));
  assert.equal((await decline(port, 'h1')).status, 200);
  const ev = seen.filter((e) => e.kind === 'suggestion.decline');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].suggestionId, SUG_ID);
  assert.deepEqual(ev[0].hunkIds, ['h1']);
  assert.ok([ARRIVAL, ARRIVAL_PATH].includes(ev[0].target));
  assert.equal(ev[0].before_sha256, sceneSha);
  assert.equal(ev[0].after_sha256, sceneSha);
  assert.equal(typeof ev[0].diff, 'string');

  const stale = await freshBook('valid/salt-orchard', withSuggestion({ mutateScene: (t) => replaceLines(t, { 17: 'Changed.' }) }));
  const seen2 = events();
  assert.equal((await accept(stale.port, 'h2')).status, 409);
  assert.deepEqual(seen2.filter((e) => e.kind === 'suggestion.accept'), []);
});

// ---- listing (route names are the implementation's: GET .../suggestions[?state=open|decided&target=<id>]) -----------------

const idsIn = (r) => (r.json?.suggestions ?? []).map((s) => s.id ?? s.fm?.id);

test('listing: a pending suggestion is open (and filterable by target); once every hunk is decided it moves to decided', async () => {
  const { port } = await freshBook('valid/salt-orchard', withSuggestion());
  const get = (q = '') => send(port, 'GET', SUG.list() + q);
  let r = await get();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(idsIn(r), [SUG_ID]);
  assert.deepEqual(idsIn(await get('?state=open')), [SUG_ID]);
  assert.deepEqual(idsIn(await get('?state=decided')), []);
  assert.deepEqual(idsIn(await get('?target=' + ARRIVAL)), [SUG_ID]);
  assert.deepEqual(idsIn(await get('?target=scene_01S50000000000000000000003')), []);
  const one = await send(port, 'GET', SUG.one(SUG_ID));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.id ?? one.json.fm?.id, SUG_ID);

  assert.equal((await post(port, SUG.decide(SUG_ID), { decision: 'decline' })).status, 200);
  assert.deepEqual(idsIn(await get('?state=open')), []);
  assert.deepEqual(idsIn(await get('?state=decided')), [SUG_ID]);
  assert.equal((await send(port, 'GET', SUG.one('note_01S5ZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);
});
