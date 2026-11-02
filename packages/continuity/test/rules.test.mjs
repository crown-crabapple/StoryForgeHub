// M05-J01 acceptance 4 (independent oracle): every rule and sub-rule, one positive and near-miss negatives each,
// on small synthetic books built in the test (not the implementer's fixtures). Also canonical-input filtering and sort order (section 2.2).
// Contract: docs/contracts/M05-J01-continuity-rules.md sections 2, 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContinuity } from '../src/index.mjs';
import { KNIFE, MAREN, ORCHARD, PELL, PORT, TOBIN, buildBook, files, id, ofRule } from './helpers.mjs';

const SOURCE_KINDS = ['entry', 'scene', 'event', 'thread', 'research'];
const ROLES = ['canon', 'text', 'event', 'thread', 'note'];

/** Run the engine and check every finding is well formed (section 2 shape). */
async function run(book) {
  const r = await checkContinuity(book);
  assert.equal(r.engine_version, 1);
  for (const k of ['findings', 'suppressed', 'stale_exceptions', 'skipped']) assert.ok(Array.isArray(r[k]), k);
  const seen = new Set();
  for (const f of r.findings) {
    assert.match(f.fingerprint, /^[a-z0-9]{2,4}-[0-9a-f]{16}$/);
    assert.ok(f.fingerprint.startsWith(`${f.rule.toLowerCase()}-`), `fingerprint ${f.fingerprint} starts with rule ${f.rule}`);
    assert.ok(!seen.has(f.fingerprint), 'fingerprints are unique');
    seen.add(f.fingerprint);
    assert.ok(Number.isInteger(f.rule_version) && f.rule_version >= 1);
    assert.ok(['error', 'warning', 'info'].includes(f.severity));
    assert.ok(f.title && !f.title.includes('\n'));
    assert.ok(f.message);
    assert.ok(['entry', 'thread', 'event', 'scene'].includes(f.subject.kind));
    assert.ok(f.subject.id);
    assert.ok(f.sources.length >= 1);
    for (const s of f.sources) {
      assert.ok(ROLES.includes(s.role), `role ${s.role}`);
      assert.ok(SOURCE_KINDS.includes(s.kind), `kind ${s.kind}`);
      assert.ok(s.id && s.file && !s.file.includes('\\'), `file ${s.file}`);
      assert.ok(Number.isInteger(s.line) && s.line >= 1, `line ${s.line} in ${s.file}`);
      assert.equal(typeof s.heading, 'string');
      assert.equal(typeof s.location, 'string');
      assert.ok(s.excerpt.length <= 160);
      assert.ok(s.range === null || (s.range.from >= 0 && s.range.to >= s.range.from));
    }
  }
  return r;
}
const count = async (book, prefix) => ofRule(await run(book), prefix).length;

const sc = (n, body, extra = {}) => ({ n, pov: 'maren-hollis', characters: ['maren-hollis'], body, ...extra });

// ====================================================================== CF1

const CF1_ENTRIES = [MAREN, TOBIN];

test('CF1: pov paragraph with a conflicting colour is reported with canon first, text second', async () => {
  const r = await run(buildBook({ entries: CF1_ENTRIES, scenes: [sc(1, 'Her green eyes narrowed against the glare.')] }));
  const f = ofRule(r, 'CF1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].subject.slug, 'maren-hollis');
  assert.deepEqual(f[0].sources.map((s) => s.role), ['canon', 'text']);
  assert.equal(f[0].sources[0].location, 'fields.Eyes');
  assert.equal(f[0].sources[1].id, id('scene', 1));
});

test('CF1: paragraph attributed by a link, pov being someone else', async () => {
  const body = '[[maren-hollis|Maren]] turned slowly, green eyes wide.';
  const r = await run(buildBook({ entries: CF1_ENTRIES, scenes: [{ n: 1, pov: 'tobin-reyes', characters: ['tobin-reyes', 'maren-hollis'], body }] }));
  assert.equal(ofRule(r, 'CF1').length, 1);
});

test('CF1: paragraph attributed by alias', async () => {
  const body = 'Mare blinked, her green eyes stinging.';
  const r = await run(buildBook({ entries: CF1_ENTRIES, scenes: [{ n: 1, pov: 'tobin-reyes', characters: ['tobin-reyes', 'maren-hollis'], body }] }));
  assert.equal(ofRule(r, 'CF1').length, 1);
});

test('CF1: hair label uses the same colour vocabulary', async () => {
  const hair = { ...MAREN, fields: { Hair: 'Black' } };
  assert.equal(await count(buildBook({ entries: [hair], scenes: [sc(1, 'She pushed back her red hair.')] }), 'CF1'), 1);
  assert.equal(await count(buildBook({ entries: [hair], scenes: [sc(1, 'She pushed back her black hair.')] }), 'CF1'), 0);
});

test('CF1: one finding per conflicting scene, each with its own fingerprint', async () => {
  const r = await run(buildBook({ entries: CF1_ENTRIES, scenes: [sc(1, 'Green eyes.'), sc(2, 'Blue eyes.'), sc(3, 'Grey eyes.')] }));
  const f = ofRule(r, 'CF1');
  assert.equal(f.length, 2);
  assert.notEqual(f[0].fingerprint, f[1].fingerprint);
  assert.deepEqual(f.map((x) => x.sources[1].id).sort(), [id('scene', 1), id('scene', 2)]);
});

for (const [label, body, entries, extra] of [
  ['"green scarf" is not eyes', 'Her green scarf trailed in the water.', CF1_ENTRIES],
  ['same colour', 'Her grey eyes narrowed.', CF1_ENTRIES],
  ['synonym gray = grey', 'Her gray eyes narrowed.', CF1_ENTRIES],
  ['mixed case value', 'Her GREY eyes narrowed.', CF1_ENTRIES],
  ['paragraph also mentions another character by name', 'Tobin Reyes watched Maren Hollis and her green eyes.', CF1_ENTRIES],
  ['pov paragraph that mentions another character by link', 'She met [[tobin-reyes]] and her green eyes stung.', CF1_ENTRIES],
  ['entry is not a character of the scene', '[[maren-hollis]] had green eyes.', CF1_ENTRIES, { pov: 'tobin-reyes', characters: ['tobin-reyes'] }],
  ['paragraph attributed to nobody (pov is another character)', 'The gull had green eyes.', CF1_ENTRIES, { pov: 'tobin-reyes', characters: ['tobin-reyes', 'maren-hollis'] }],
  ['multi-word field value has no single-word vocabulary match', 'Her blue eyes.', [{ ...MAREN, fields: { Eyes: 'Grey or green' } }]],
  ['label without a vocabulary', 'Her mauve eyes.', [{ ...MAREN, fields: { Gaze: 'Grey' } }]],
  ['colour not in the vocabulary (no _types)', 'Her mauve eyes.', CF1_ENTRIES],
]) {
  test(`CF1 negative: ${label}`, async () => {
    const scene = { ...sc(1, body), ...(extra ?? {}) };
    assert.equal(await count(buildBook({ entries: entries, scenes: [scene] }), 'CF1'), 0);
  });
}

test('CF1: _types values extend the vocabulary (mauve is a word only when the type says so)', async () => {
  const types = [{ n: 1, type: 'character', fields: ['Eyes'], values: 'values:\n  Eyes: [grey, green, mauve]\n' }];
  const r = await run(buildBook({ entries: CF1_ENTRIES, types, scenes: [sc(1, 'Her mauve eyes.')] }));
  assert.equal(ofRule(r, 'CF1').length, 1);
});

test('CF1: canon research note that links the entry and states another value (role note)', async () => {
  const book = buildBook({ entries: CF1_ENTRIES, notes: [{ n: 1, canon: true, links: ['maren-hollis'], body: 'Notes on Maren.\n\nEyes: Blue' }] });
  const f = ofRule(await run(book), 'CF1');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].sources.map((s) => s.role), ['canon', 'note']);
  assert.equal(f[0].sources[1].kind, 'research');
  assert.match(f[0].sources[1].excerpt, /Eyes: Blue/);
  assert.equal(f[0].sources[1].line, 10);
});

for (const [label, note] of [
  ['non-canon note', { n: 1, canon: false, links: ['maren-hollis'], body: 'Eyes: Blue' }],
  ['note without the canon flag', { n: 1, links: ['maren-hollis'], body: 'Eyes: Blue' }],
  ['canon note that does not link the entry', { n: 1, canon: true, links: ['tobin-reyes'], body: 'Eyes: Blue' }],
  ['canon note with the same value', { n: 1, canon: true, links: ['maren-hollis'], body: 'Eyes: grey' }],
]) {
  test(`CF1 negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: CF1_ENTRIES, notes: [note] }), 'CF1'), 0);
  });
}

// ====================================================================== canonical inputs only

test('archived scenes and variants are not canonical text', async () => {
  const book = buildBook({
    entries: CF1_ENTRIES,
    scenes: [sc(1, 'Quiet.'), sc(2, 'Her green eyes.', { archived: true }), sc(3, 'Her green eyes.', { variantOf: 1 })],
  });
  assert.equal(await count(book, 'CF1'), 0);
});

// ====================================================================== TL1

const ev = (n, slug, order, extra = {}) => ({ n, slug, order, ...extra });
const TL_ENTRIES = [MAREN, PELL, KNIFE, PORT, ORCHARD, TOBIN];

test('TL1a: character present in a later event after dying (error, sources: the death, the later event)', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'pell-dies', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'pell-dines', 20, { characters: ['pell'] })],
  });
  const f = ofRule(await run(book), 'TL1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  const fs = files(f[0]);
  assert.equal(fs[0], 'planning/timeline/pell-dies.md');
  assert.ok(fs.includes('planning/timeline/pell-dines.md'));
  assert.equal(f[0].sources[0].location, 'state[0]');
  assert.equal(f[0].sources[0].role, 'event');
});

test('TL1a: the later appearance can be a state subject, or a scene the event lists', async () => {
  const viaState = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'pell-dies', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'pell-moves', 20, { state: ['{ slug: pell, event: location, value: port-aldine }'] })],
  });
  assert.equal(await count(viaState, 'TL1'), 1);
  const viaScene = buildBook({
    entries: TL_ENTRIES,
    scenes: [{ n: 1, pov: 'pell', characters: ['pell'], body: 'Pell speaks.' }],
    events: [ev(1, 'pell-dies', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'the-speech', 20, { scenes: [1] })],
  });
  assert.equal(await count(viaScene, 'TL1'), 1);
});

test('TL1a: a destroyed object named in a later event state', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'knife-breaks', 10, { state: ['{ slug: grafting-knife, event: destroyed }'] }), ev(2, 'knife-used', 20, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] })],
  });
  const f = ofRule(await run(book), 'TL1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
});

for (const [label, events] of [
  ['revived in between', [ev(1, 'a', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'b', 15, { state: ['{ slug: pell, event: revived }'] }), ev(3, 'c', 20, { characters: ['pell'] })]],
  ['appears only before the death', [ev(1, 'a', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'b', 5, { characters: ['pell'] })]],
  ['the death event itself lists the character', [ev(1, 'a', 10, { characters: ['pell'], state: ['{ slug: pell, event: died }'] })]],
  ['someone else is present after the death', [ev(1, 'a', 10, { state: ['{ slug: pell, event: died }'] }), ev(2, 'b', 20, { characters: ['maren-hollis'] })]],
]) {
  test(`TL1a negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'TL1'), 0);
  });
}

test('TL1b: same character at two locations at equal order (via location state)', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [
      ev(1, 'at-port', 10, { state: ['{ slug: maren-hollis, event: location, value: port-aldine }'] }),
      ev(2, 'at-orchard', 10, { state: ['{ slug: maren-hollis, event: location, value: salt-orchard }'] }),
    ],
  });
  const f = ofRule(await run(book), 'TL1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  assert.deepEqual([...new Set(files(f[0]))].sort(), ['planning/timeline/at-orchard.md', 'planning/timeline/at-port.md']);
});

test('TL1b: via characters + exactly one location', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'at-port', 10, { characters: ['maren-hollis'], locations: ['port-aldine'] }), ev(2, 'at-orchard', 10, { characters: ['maren-hollis'], locations: ['salt-orchard'] })],
  });
  assert.equal(await count(book, 'TL1'), 1);
});

for (const [label, events] of [
  ['same location twice (simultaneous in one place)', [ev(1, 'a', 10, { state: ['{ slug: maren-hollis, event: location, value: port-aldine }'] }), ev(2, 'b', 10, { state: ['{ slug: maren-hollis, event: location, value: port-aldine }'] })]],
  ['different orders', [ev(1, 'a', 10, { state: ['{ slug: maren-hollis, event: location, value: port-aldine }'] }), ev(2, 'b', 11, { state: ['{ slug: maren-hollis, event: location, value: salt-orchard }'] })]],
  ['different characters', [ev(1, 'a', 10, { state: ['{ slug: maren-hollis, event: location, value: port-aldine }'] }), ev(2, 'b', 10, { state: ['{ slug: tobin-reyes, event: location, value: salt-orchard }'] })]],
  ['characters with two locations are not placed anywhere', [ev(1, 'a', 10, { characters: ['maren-hollis'], locations: ['port-aldine', 'salt-orchard'] }), ev(2, 'b', 10, { characters: ['maren-hollis'], locations: ['port-aldine'] })]],
]) {
  test(`TL1b negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'TL1'), 0);
  });
}

test('TL1c: higher order with an earlier date', async () => {
  const book = buildBook({ entries: TL_ENTRIES, events: [ev(1, 'first', 10, { date: '1998-07-21' }), ev(2, 'second', 20, { date: '1998-07-01' })] });
  const f = ofRule(await run(book), 'TL1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].sources.length, 2);
});

for (const [label, events] of [
  ['dates ascending', [ev(1, 'a', 10, { date: '1998-07-01' }), ev(2, 'b', 20, { date: '1998-07-21' })]],
  ['equal dates', [ev(1, 'a', 10, { date: '1998-07-01' }), ev(2, 'b', 20, { date: '1998-07-01' })]],
  ['compared at the shorter precision (1998-07-21 vs 1998-07)', [ev(1, 'a', 10, { date: '1998-07-21' }), ev(2, 'b', 20, { date: '1998-07' })]],
  ['year only vs later full date in the same year', [ev(1, 'a', 10, { date: '1998' }), ev(2, 'b', 20, { date: '1998-03-04' })]],
  ['an event without a date is skipped', [ev(1, 'a', 10, { date: '1998-07-21' }), ev(2, 'b', 20), ev(3, 'c', 30, { date: '1999' })]],
]) {
  test(`TL1c negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'TL1'), 0);
  });
}

// ====================================================================== KN1

const FACT = 'the-key-opens-the-sluice';
const learns = (who) => `{ slug: ${who}, event: learns, value: ${FACT} }`;
const knows = (who) => `{ slug: ${who}, event: knows, value: ${FACT} }`;

test('KN1: knows with no learns at all (error)', async () => {
  const f = ofRule(await run(buildBook({ entries: TL_ENTRIES, events: [ev(1, 'a', 10, { state: [knows('maren-hollis')] })] })), 'KN1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].sources[0].file, 'planning/timeline/a.md');
  assert.equal(f[0].sources[0].location, 'state[0]');
});

test('KN1: learns only at a later order -> sources are the knows item then the learns item', async () => {
  const f = ofRule(await run(buildBook({ entries: TL_ENTRIES, events: [ev(1, 'a', 10, { state: [knows('maren-hollis')] }), ev(2, 'b', 20, { state: [learns('maren-hollis')] })] })), 'KN1');
  assert.equal(f.length, 1);
  assert.deepEqual(files(f[0]), ['planning/timeline/a.md', 'planning/timeline/b.md']);
});

test('KN1: only a different character learned it -> still reported', async () => {
  const f = ofRule(await run(buildBook({ entries: TL_ENTRIES, events: [ev(1, 'a', 5, { state: [learns('tobin-reyes')] }), ev(2, 'b', 10, { state: [knows('maren-hollis')] })] })), 'KN1');
  assert.equal(f.length, 1);
});

for (const [label, events] of [
  ['learned at a strictly lower order', [ev(1, 'a', 5, { state: [learns('maren-hollis')] }), ev(2, 'b', 10, { state: [knows('maren-hollis')] })]],
  ['learned at equal order counts as known', [ev(1, 'a', 10, { state: [learns('maren-hollis')] }), ev(2, 'b', 10, { state: [knows('maren-hollis')] })]],
  ['learned and known in the same event', [ev(1, 'a', 10, { state: [learns('maren-hollis'), knows('maren-hollis')] })]],
]) {
  test(`KN1 negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'KN1'), 0);
  });
}

// ====================================================================== ST1

test('ST1a: lost object is given a holder later (warning)', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'lost', 10, { state: ['{ slug: grafting-knife, event: lost }'] }), ev(2, 'held', 20, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] })],
  });
  const f = ofRule(await run(book), 'ST1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.deepEqual(files(f[0]).slice(0, 2), ['planning/timeline/lost.md', 'planning/timeline/held.md']);
});

for (const [label, events] of [
  ['found before the holder', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: lost }'] }), ev(2, 'b', 15, { state: ['{ slug: grafting-knife, event: found }'] }), ev(3, 'c', 20, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] })]],
  ['holder cleared to nobody after loss', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: lost }'] }), ev(2, 'b', 20, { state: ['{ slug: grafting-knife, event: holder, value: "" }'] })]],
  ['holder before it was lost', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }), ev(2, 'b', 20, { state: ['{ slug: grafting-knife, event: lost }'] })]],
]) {
  test(`ST1a negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'ST1'), 0);
  });
}

test('ST1b: two different holders at equal order (warning)', async () => {
  const book = buildBook({
    entries: TL_ENTRIES,
    events: [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }), ev(2, 'b', 10, { state: ['{ slug: grafting-knife, event: holder, value: tobin-reyes }'] })],
  });
  const f = ofRule(await run(book), 'ST1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
});

for (const [label, events] of [
  ['same holder at equal order', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }), ev(2, 'b', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] })]],
  ['different holders at different orders (a hand-over)', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }), ev(2, 'b', 20, { state: ['{ slug: grafting-knife, event: holder, value: tobin-reyes }'] })]],
  ['empty holder at equal order is not a holder', [ev(1, 'a', 10, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }), ev(2, 'b', 10, { state: ['{ slug: grafting-knife, event: holder, value: "" }'] })]],
]) {
  test(`ST1b negative: ${label}`, async () => {
    assert.equal(await count(buildBook({ entries: TL_ENTRIES, events }), 'ST1'), 0);
  });
}

// ====================================================================== TH1

const TH_SCENES = [sc(1, 'One.'), sc(2, 'Two.'), sc(3, 'Three.')];

test('TH1a: payoff before setup in book order (error, sources setup scene then payoff scene)', async () => {
  const book = buildBook({ entries: [MAREN], scenes: TH_SCENES, threads: [{ n: 1, slug: 'the-key', status: 'paid', setup: [3], payoff: [1] }] });
  const f = ofRule(await run(book), 'TH1').filter((x) => x.severity === 'error');
  assert.equal(f.length, 1);
  assert.equal(f[0].subject.kind, 'thread');
  assert.equal(f[0].subject.slug, 'the-key');
  assert.deepEqual(f[0].sources.map((s) => s.id), [id('scene', 3), id('scene', 1)]);
});

test('TH1a uses book order, not scene number or file order of ids', async () => {
  // scene 9 sits in chapter 1 (read first), scene 2 in chapter 2 (read later); setup 9 / payoff 2 is fine, the reverse is not
  const scenes = [sc(9, 'Nine.', { ch: 1 }), sc(2, 'Two.', { ch: 2 })];
  const ok = buildBook({ entries: [MAREN], scenes, threads: [{ n: 1, slug: 'k', status: 'paid', setup: [9], payoff: [2] }] });
  const bad = buildBook({ entries: [MAREN], scenes, threads: [{ n: 1, slug: 'k', status: 'paid', setup: [2], payoff: [9] }] });
  assert.equal((await run(ok)).findings.filter((f) => f.severity === 'error').length, 0);
  assert.equal(ofRule(await run(bad), 'TH1').filter((f) => f.severity === 'error').length, 1);
});

for (const [label, thread] of [
  ['payoff after setup', { n: 1, slug: 'k', status: 'paid', setup: [1], payoff: [3] }],
  ['earliest setup precedes earliest payoff even with a late setup too', { n: 1, slug: 'k', status: 'paid', setup: [1, 3], payoff: [2] }],
  ['setup and payoff in the same scene', { n: 1, slug: 'k', status: 'paid', setup: [2], payoff: [2] }],
]) {
  test(`TH1a negative: ${label}`, async () => {
    const r = await run(buildBook({ entries: [MAREN], scenes: TH_SCENES, threads: [thread] }));
    assert.equal(ofRule(r, 'TH1').filter((f) => f.severity === 'error').length, 0);
  });
}

for (const status of ['planted', 'developed', 'open']) {
  test(`TH1b: ${status} thread in a book with a final scene is reported once (info)`, async () => {
    const setup = status === 'open' ? {} : { setup: [1] };
    const book = buildBook({ entries: [MAREN], scenes: TH_SCENES, threads: [{ n: 1, slug: 'loose', status, ...setup, ...(status === 'developed' ? { develop: [2] } : {}) }] });
    const f = ofRule(await run(book), 'TH1');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'info');
    assert.equal(f[0].subject.slug, 'loose');
    assert.equal(f[0].sources[0].role, 'thread');
    assert.equal(f[0].sources[0].file, 'planning/threads/loose.md');
    assert.equal(f[0].sources[0].location, 'status');
  });
}

for (const status of ['unresolved', 'dropped', 'planned', 'abandoned']) {
  test(`TH1b negative: ${status} thread is intentional, no finding`, async () => {
    const book = buildBook({ entries: [MAREN], scenes: TH_SCENES, threads: [{ n: 1, slug: 'loose', status }] });
    assert.equal(await count(book, 'TH1'), 0);
  });
}

test('TH1b negative: paid thread, and an open thread in a book with no scenes', async () => {
  assert.equal(await count(buildBook({ entries: [MAREN], scenes: TH_SCENES, threads: [{ n: 1, slug: 'done', status: 'paid', setup: [1], payoff: [3] }] }), 'TH1'), 0);
  assert.equal(await count(buildBook({ entries: [MAREN], threads: [{ n: 1, slug: 'loose', status: 'open' }] }), 'TH1'), 0);
});

// ====================================================================== sort order (section 2.2)

const SEV = { error: 0, warning: 1, info: 2 };
const cmp = (a, b) =>
  SEV[a.severity] - SEV[b.severity] ||
  (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
  (a.sources[0].file < b.sources[0].file ? -1 : a.sources[0].file > b.sources[0].file ? 1 : 0) ||
  a.sources[0].line - b.sources[0].line ||
  (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);

function mixedBook() {
  return buildBook({
    entries: TL_ENTRIES,
    scenes: [sc(1, 'Her green eyes.'), sc(2, 'Her blue eyes.')],
    threads: [{ n: 1, slug: 'loose', status: 'open' }],
    events: [
      ev(1, 'pell-dies', 10, { state: ['{ slug: pell, event: died }'] }),
      ev(2, 'pell-dines', 20, { characters: ['pell'] }),
      ev(3, 'maren-knows', 30, { state: [knows('maren-hollis')] }),
      ev(4, 'knife-lost', 40, { state: ['{ slug: grafting-knife, event: lost }'] }),
      ev(5, 'knife-held', 50, { state: ['{ slug: grafting-knife, event: holder, value: maren-hollis }'] }),
    ],
  });
}

test('findings are sorted by severity, rule, first source file, line, fingerprint', async () => {
  const r = await run(mixedBook());
  const rules = r.findings.map((f) => f.rule.toUpperCase().slice(0, 3));
  assert.ok(r.findings.length >= 6, `expected CF1 x2, KN1, TL1, ST1, TH1: got ${r.findings.map((f) => f.rule).join(',')}`);
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(cmp(r.findings[i - 1], r.findings[i]) <= 0, `finding ${i - 1} (${r.findings[i - 1].rule}) sorts before ${i} (${r.findings[i].rule})`);
  }
  const firstOfEach = [];
  for (const x of rules) if (!firstOfEach.includes(x)) firstOfEach.push(x);
  assert.deepEqual(firstOfEach, ['KN1', 'TL1', 'CF1', 'ST1', 'TH1']);
});

test('input file order does not change the output (determinism across builds)', async () => {
  assert.deepEqual(await run(mixedBook()), await run(mixedBook()));
});
