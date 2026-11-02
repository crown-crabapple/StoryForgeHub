// M05-J06 acceptance 6 (publish) and 7 (publish provenance): `publish --scene <id> --from <file> --expect-sha256 <hash> --confirm` replaces the scene BODY,
// front matter byte-for-byte, through the store, only with --confirm and a matching current hash; otherwise exit 1 and nothing is written.
// --confirm and --expect-sha256 are never defaulted.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 3 and 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validate } from '../../format/src/index.mjs';
import { run as runInProcess } from '../src/index.mjs';
import { abs } from './helpers.mjs';
import { ARRIVAL, ARRIVAL_PATH, GRAFTING, GRAFTING_PATH, frontOf, scratch, setup, sha } from './author-helpers.mjs';

const NEW_BODY = 'The ferry bumped the jetty.\n\nShe stepped ashore without looking back.\n';
const none = { added: [], removed: [], changed: [] };

test('publish with the current hash and --confirm replaces only the body; front matter bytes kept; only the scene changes in the book', async () => {
  const { book, go } = setup();
  const file = abs(book, ARRIVAL_PATH);
  const before = fs.readFileSync(file);
  const from = scratch('body.md', NEW_BODY);
  const { status, bookD, fwD, r } = go('publish', { extra: ['--scene', ARRIVAL, '--from', from, '--expect-sha256', sha(before), '--confirm'] });
  assert.equal(status, 0, r.stderr + r.stdout);
  const after = fs.readFileSync(file);
  const front = Buffer.from(frontOf(before.toString('utf8')), 'utf8');
  assert.ok(after.subarray(0, front.length).equals(front), 'front matter is byte-identical');
  assert.equal(after.subarray(front.length).toString('utf8'), NEW_BODY);
  assert.deepEqual(bookD.added, []);
  assert.deepEqual(bookD.removed, []);
  assert.deepEqual(bookD.changed, [ARRIVAL_PATH]);
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.removed, []);
  assert.deepEqual((await validate(book)).diagnostics.filter((d) => d.severity === 'error'), []);
});

test('publish on a CRLF scene keeps the CRLF front matter byte for byte', () => {
  const { book, go } = setup();
  const file = abs(book, GRAFTING_PATH);
  const before = fs.readFileSync(file);
  assert.ok(before.includes('\r\n'), 'fixture scene is CRLF');
  const from = scratch('body.md', NEW_BODY);
  const { status, bookD, r } = go('publish', { extra: ['--scene', GRAFTING, '--from', from, '--expect-sha256', sha(before), '--confirm'] });
  assert.equal(status, 0, r.stderr + r.stdout);
  const after = fs.readFileSync(file);
  const front = Buffer.from(frontOf(before.toString('utf8')), 'utf8');
  assert.ok(after.subarray(0, front.length).equals(front), 'CRLF front matter byte-identical');
  assert.equal(after.subarray(front.length).toString('utf8').replace(/\r\n/g, '\n'), NEW_BODY);
  assert.deepEqual(bookD.changed, [GRAFTING_PATH]);
});

test('publish without --confirm is refused (exit 1) and nothing is written', () => {
  const { book, go } = setup();
  const before = fs.readFileSync(abs(book, ARRIVAL_PATH));
  const from = scratch('body.md', NEW_BODY);
  const { status, bookD, fwD } = go('publish', { extra: ['--scene', ARRIVAL, '--from', from, '--expect-sha256', sha(before)] });
  assert.equal(status, 1);
  assert.deepEqual(bookD, none);
  assert.deepEqual(fwD.changed, []);
  assert.ok(fs.readFileSync(abs(book, ARRIVAL_PATH)).equals(before));
});

test('publish with a stale hash is refused (exit 1) and nothing is written, even with --confirm', () => {
  const { book, go } = setup();
  const before = fs.readFileSync(abs(book, ARRIVAL_PATH));
  const from = scratch('body.md', NEW_BODY);
  const stale = sha('some earlier version of the scene');
  const { status, bookD, r } = go('publish', { extra: ['--scene', ARRIVAL, '--from', from, '--expect-sha256', stale, '--confirm'] });
  assert.equal(status, 1, r.stderr + r.stdout);
  assert.deepEqual(bookD, none);
  assert.ok(fs.readFileSync(abs(book, ARRIVAL_PATH)).equals(before));
});

test('--expect-sha256 is never defaulted: omitting it is refused even with --confirm', () => {
  const { book, go } = setup();
  const before = fs.readFileSync(abs(book, ARRIVAL_PATH));
  const from = scratch('body.md', NEW_BODY);
  const { status, bookD } = go('publish', { extra: ['--scene', ARRIVAL, '--from', from, '--confirm'] });
  assert.ok(status === 1 || status === 2, `exit ${status}`);
  assert.deepEqual(bookD, none);
  assert.ok(fs.readFileSync(abs(book, ARRIVAL_PATH)).equals(before));
});

test('a second publish with the hash from before the first one is stale', () => {
  const { book, go } = setup();
  const before = fs.readFileSync(abs(book, ARRIVAL_PATH));
  const ok = go('publish', { extra: ['--scene', ARRIVAL, '--from', scratch('a.md', NEW_BODY), '--expect-sha256', sha(before), '--confirm'] });
  assert.equal(ok.status, 0, ok.r.stderr);
  const published = fs.readFileSync(abs(book, ARRIVAL_PATH));
  const again = go('publish', { extra: ['--scene', ARRIVAL, '--from', scratch('b.md', 'Another body.\n'), '--expect-sha256', sha(before), '--confirm'] });
  assert.equal(again.status, 1);
  assert.deepEqual(again.bookD, none);
  assert.ok(fs.readFileSync(abs(book, ARRIVAL_PATH)).equals(published));
});

test('publish of an unknown scene fails and writes nothing', () => {
  const { go } = setup();
  const { status, bookD } = go('publish', { extra: ['--scene', 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', '--from', scratch('b.md', 'x\n'), '--expect-sha256', sha('x'), '--confirm'] });
  assert.ok(status === 1 || status === 2);
  assert.deepEqual(bookD, none);
});

// ---- 7: provenance ---------------------------------------------------------------------------------------------------------

// The adapter does not depend on core: its provenance seam is the `provenance` option of run() (the app wires it to recordProvenance).
async function inProcess(args, provenance) {
  let out = '';
  let err = '';
  const code = await runInProcess(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), env: { ...process.env }, provenance });
  return { code, out, err };
}

test('provenance: a successful publish reports one publish event (scene, before and after hashes); a refused publish reports none', async () => {
  const { book, fw } = setup();
  const file = abs(book, ARRIVAL_PATH);
  const before = fs.readFileSync(file);
  const seen = [];
  const base = ['publish', '--book', book, '--framework', fw, '--scene', ARRIVAL, '--from', scratch('body.md', NEW_BODY)];

  const refused = await inProcess([...base, '--expect-sha256', sha(before)], (e) => seen.push(e)); // no --confirm
  assert.equal(refused.code, 1, refused.err + refused.out);
  assert.deepEqual(seen.filter((e) => e.kind === 'publish'), []);

  const ok = await inProcess([...base, '--expect-sha256', sha(before), '--confirm'], (e) => seen.push(e));
  assert.equal(ok.code, 0, ok.err + ok.out);
  const ev = seen.filter((e) => e.kind === 'publish');
  assert.equal(ev.length, 1, JSON.stringify(seen.map((e) => e.kind)));
  const dump = JSON.stringify(ev[0]);
  assert.ok(dump.includes(ARRIVAL) || dump.includes(ARRIVAL_PATH), 'event names the scene');
  assert.ok(dump.includes(sha(before)), 'event carries the hash before');
  assert.ok(dump.includes(sha(fs.readFileSync(file))), 'event carries the hash after');
});

test('provenance: check reports exactly one check.report event and writes no suggestion', async () => {
  const { book, fw } = setup();
  const seen = [];
  const r = await inProcess(['check', '--book', book, '--framework', fw, '--chapter', '1', '--no-style'], (e) => seen.push(e));
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(seen.map((e) => e.kind), ['check.report']);
  assert.ok(!fs.existsSync(abs(book, 'suggestions')));
});

test('provenance: suggest reports one suggestion.create event naming the new suggestion and its target', async () => {
  const { book, fw } = setup();
  const seen = [];
  const original = fs.readFileSync(abs(book, ARRIVAL_PATH), 'utf8');
  const from = scratch('alt.md', original.replace('green eyes', 'grey eyes'));
  const r = await inProcess(['suggest', '--book', book, '--framework', fw, '--scene', ARRIVAL, '--from', from], (e) => seen.push(e));
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.equal(seen[0].kind, 'suggestion.create');
  assert.equal(seen[0].target, ARRIVAL);
  assert.match(String(seen[0].suggestionId), /^note_/);
  assert.ok(fs.readFileSync(abs(book, String(seen[0].path)), 'utf8').includes(String(seen[0].suggestionId)), 'the event points at the created file');
  assert.ok(fs.readFileSync(abs(book, ARRIVAL_PATH), 'utf8') === original);
});
