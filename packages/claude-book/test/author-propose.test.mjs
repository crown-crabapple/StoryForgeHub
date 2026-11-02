// M05-J06 acceptance 6 (propose-state) and section 4: `propose-state --chapter n --from chapter-NN-ledgers.json` creates suggestion documents of mode state / canon,
// one per target file, and changes nothing else. Accepting them is tested through the app in apps/server/test/suggest-propose.test.mjs.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 3 and 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validate } from '../../format/src/index.mjs';
import { run as runInProcess } from '../src/index.mjs';
import { abs } from './helpers.mjs';
import { ARRIVAL, LEDGERS, scratch, setup, sha, suggestionsIn } from './author-helpers.mjs';

const BRASS_KEY = 'planning/threads/brass-key.md';
const BRASS_KEY_ID = 'thread_01S5000000000000000000000T';
const none = { added: [], removed: [], changed: [] };
const ledgersFile = (data = LEDGERS) => scratch('chapter-01-ledgers.json', `${JSON.stringify(data, null, 2)}\n`);
const proposed = (s) => s.text.slice(s.text.indexOf('```diff'));

test('propose-state from a sample ledgers JSON: only new files under suggestions/, every existing file byte-identical, framework untouched', async () => {
  const { book, go } = setup();
  const brassBefore = fs.readFileSync(abs(book, BRASS_KEY));
  const { status, bookD, fwD, r } = go('propose-state', { chapter: 1, extra: ['--from', ledgersFile()] });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD.changed, []);
  assert.deepEqual(bookD.removed, []);
  const files = bookD.added.filter((p) => p.endsWith('.md'));
  assert.ok(files.length >= 4, `expected 4 suggestions, got ${files}`);
  assert.deepEqual(files.filter((p) => !p.startsWith('suggestions/')), [], 'nothing created outside suggestions/');
  assert.deepEqual(bookD.added.filter((p) => !p.endsWith('.md') && !/^suggestions(\/\d{4})?$/.test(p)), []);
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.removed, []);
  assert.ok(fs.readFileSync(abs(book, BRASS_KEY)).equals(brassBefore), 'the existing thread is untouched until accepted');
  assert.ok(!fs.existsSync(abs(book, 'planning/timeline/chapter-01-state.md')), 'the proposed event does not exist yet');
});

test('propose-state: the suggestions are the expected ones (state event, planted thread, payoff hunk, canon seed entry), all source claude-book, one per target file', async () => {
  const { book, go } = setup();
  assert.equal(go('propose-state', { chapter: 1, extra: ['--from', ledgersFile()] }).status, 0);
  const all = await suggestionsIn(book);
  for (const s of all) {
    assert.equal(s.fm.schema, 'storyforge.suggestion/v1');
    assert.equal(s.fm.source, 'claude-book');
    assert.equal(s.fm.status, 'pending');
    assert.ok(['state', 'canon'].includes(s.fm.mode), `mode ${s.fm.mode}`);
    assert.match(s.fm.id, /^note_[0-9A-Z]{26}$/);
  }
  assert.equal(new Set(all.map((s) => s.fm.target_path)).size, all.length, 'one suggestion per target file');

  // new timeline event holding the chapter's state items (no event titled "Chapter 1" exists in the fixture)
  const event = all.find((s) => s.fm.target_path === 'planning/timeline/chapter-01-state.md');
  assert.ok(event, `event suggestion among ${all.map((s) => s.fm.target_path)}`);
  assert.equal(event.fm.mode, 'state');
  assert.equal(event.fm.target, '');
  assert.equal(event.fm.base_sha256, '');
  const ev = proposed(event);
  assert.ok(ev.includes('storyforge.event/v1'));
  assert.ok(ev.includes('maren-hollis') && ev.includes('location') && ev.includes('port-aldine'), 'state_events carried over');
  assert.ok(ev.includes('learns'), 'knowledge becomes a learns item');
  assert.ok(ev.includes(ARRIVAL), 'scenes = the chapter scenes');
  const order = Number(/^\+order: (\d+)/m.exec(ev)?.[1]);
  assert.ok(order > 300, `order ${order} comes after the last existing event (300)`);

  // plant -> new thread file
  const plant = all.find((s) => /^planning\/threads\/.+\.md$/.test(s.fm.target_path) && s.fm.target === '');
  assert.ok(plant, 'thread plant suggestion');
  assert.equal(plant.fm.mode, 'state');
  assert.ok(proposed(plant).includes('status: planted'));
  assert.ok(proposed(plant).includes(ARRIVAL), "setup = the chapter's first scene");
  assert.ok(proposed(plant).includes('The glass of the ticket hut'));

  // payoff -> hunk on the existing thread
  const payoff = all.find((s) => s.fm.target === BRASS_KEY_ID);
  assert.ok(payoff, 'payoff suggestion on brass-key');
  assert.equal(payoff.fm.target_path, BRASS_KEY);
  assert.equal(payoff.fm.base_sha256, sha(fs.readFileSync(abs(book, BRASS_KEY))));
  assert.ok(payoff.fm.hunks.length >= 1);
  assert.ok(proposed(payoff).split('\n').some((l) => l.startsWith('+') && l.includes(ARRIVAL)), 'payoff += scene');

  // unknown slug -> canon-mode seed entry, never canon status
  const seed = all.find((s) => s.fm.mode === 'canon');
  assert.ok(seed, 'canon-mode suggestion');
  assert.equal(seed.fm.target, '');
  assert.match(seed.fm.target_path, /^codex\/.+the-ticket-hut\.md$/);
  assert.ok(proposed(seed).includes('status: seed'));
  assert.ok(!/status: canon/.test(proposed(seed)));
  assert.ok(proposed(seed).includes('Proposed from chapter 1'));
  assert.equal(all.filter((s) => s.fm.mode === 'canon').length, 1, 'only unknown_slugs produce canon-mode suggestions');
});

test('propose-state: the book still validates with the same diagnostics as before (suggestion documents are valid)', async () => {
  const { book, go } = setup();
  const baseline = (await validate(book)).diagnostics;
  assert.equal(go('propose-state', { chapter: 1, extra: ['--from', ledgersFile()] }).status, 0);
  assert.deepEqual((await validate(book)).diagnostics, baseline);
});

test('propose-state with only unknown_slugs creates only canon suggestions; with nothing to propose it creates nothing', async () => {
  const { book, go } = setup();
  const empty = { chapter: '1', cast: [], knowledge: [], state_events: [], ledger_items: [], unknown_slugs: [] };
  const r0 = go('propose-state', { chapter: 1, extra: ['--from', ledgersFile(empty)] });
  assert.ok(r0.status === 0 || r0.status === 1, `exit ${r0.status}`);
  assert.deepEqual(r0.bookD, none);
  const only = go('propose-state', { chapter: 1, extra: ['--from', ledgersFile({ ...empty, unknown_slugs: ['the-ticket-hut'] })] });
  assert.equal(only.status, 0, only.r.stderr);
  const all = await suggestionsIn(book);
  assert.deepEqual(all.map((s) => s.fm.mode), ['canon']);
});

test('propose-state refuses unusable input (not JSON, missing file, chapter without scenes) and writes nothing', () => {
  const { go } = setup();
  const notJson = scratch('chapter-01-ledgers.json', 'this is not json');
  for (const [chapter, extra] of [[1, ['--from', notJson]], [1, ['--from', notJson + '.missing']], [1, []], [99, ['--from', ledgersFile()]]]) {
    const { status, bookD, fwD } = go('propose-state', { chapter, extra });
    assert.ok(status === 1 || status === 2, `exit ${status} for ${extra}`);
    assert.deepEqual(bookD, none);
    assert.deepEqual(fwD.changed, []);
  }
});

test('propose-state never invents an event for an unknown character: items naming a slug that is not an entry are skipped, not written', async () => {
  const { book, go } = setup();
  const data = { ...LEDGERS, unknown_slugs: [], ledger_items: [], knowledge: [], state_events: [{ slug: 'nobody-here', event: 'died' }, { slug: 'maren-hollis', event: 'location', value: 'port-aldine' }] };
  assert.equal(go('propose-state', { chapter: 1, extra: ['--from', ledgersFile(data)] }).status, 0);
  const text = (await suggestionsIn(book)).map((s) => s.text).join('\n');
  assert.ok(!text.includes('nobody-here'));
  assert.ok(text.includes('port-aldine'));
});

test('provenance: every created suggestion is reported once as suggestion.create', async () => {
  const { book, fw } = setup();
  const seen = [];
  let err = '';
  const code = await runInProcess(['propose-state', '--book', book, '--framework', fw, '--chapter', '1', '--from', ledgersFile()], { stdout() {}, stderr: (s) => (err += s), env: { ...process.env }, provenance: (e) => seen.push(e) });
  assert.equal(code, 0, err);
  const all = await suggestionsIn(book);
  assert.equal(seen.length, all.length);
  assert.deepEqual(seen.map((e) => e.kind), all.map(() => 'suggestion.create'));
  assert.deepEqual(seen.map((e) => e.suggestionId).sort(), all.map((s) => s.fm.id).sort());
});
