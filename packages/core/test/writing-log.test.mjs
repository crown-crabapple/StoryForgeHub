// M03-J04 acceptance 1 (writing log) and 2 (goal + streak), pure parts:
//   wordDelta (word-level diff using countWords tokens), parse/apply of activity/writing-log.md, computeStreak.
// The route-level parts (PUT body `words`, activity route, goal route) are in apps/server/test/j04-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { countWords } from '../src/index.mjs';
import { wordDelta, FALLBACK_TOKENS } from '../src/word-delta.mjs';
import { addDays, applyToWritingLog, computeStreak, localDate, newWritingLog, parseWritingLog } from '../src/writing-log.mjs';
import { FLUSH_MS, createActivity } from '../src/activity.mjs';
import { copyFixture } from './helpers.mjs';

// ------------------------------------------------------------------ wordDelta

const DELTA_TABLE = [
  ['identical', 'one two three', 'one two three', 0, 0],
  ['both empty', '', '', 0, 0],
  ['from empty', '', 'one two three', 3, 0],
  ['to empty', 'one two three', '', 0, 3],
  ['append', 'one two', 'one two three four', 2, 0],
  ['prepend', 'three four', 'one two three four', 2, 0],
  ['insert in the middle', 'one four', 'one two three four', 2, 0],
  ['delete in the middle', 'one two three four', 'one four', 0, 2],
  ['replace one word', 'the quick fox', 'the slow fox', 1, 1],
  ['replace everything', 'a b c', 'x y', 2, 3],
  ['whitespace-only change', 'one two', 'one   two\n\n', 0, 0],
  ['paragraph break added', 'one two', 'one\n\ntwo', 0, 0],
  ['repeated words: one more', 'a a a', 'a a a a', 1, 0],
  ['repeated words: one fewer', 'a a a a', 'a a a', 0, 1],
  ['punctuation is part of the token', 'end.', 'end', 1, 1],
  ['case matters', 'Hello world', 'hello world', 1, 1],
  // a moved block is one removal plus one insertion of the block (LCS keeps the longer common run)
  ['moved block of 3 words', 'A B C D E F', 'D E F A B C', 3, 3],
  ['moved single word to the end', 'a b c d', 'b c d a', 1, 1],
  ['swap two adjacent words', 'one two', 'two one', 1, 1],
  ['Unicode: CJK run is one token', '潮が引く、そして戻る。', '潮が引く、そして戻る。 and back', 2, 0],
  ['Unicode: accents are not normalised', 'café au lait', 'café au lait', 1, 1],
  ['Unicode: emoji and ZWJ stay inside their token', 'go 👩‍🚀 now', 'go 👩‍🚀 now again', 1, 0],
  ['Unicode: no-break space is whitespace for \\S+', 'one two', 'one two three', 1, 0],
  ['HTML comments are excluded', 'one two', 'one two <!-- note: lots of extra words here -->', 0, 0],
  ['multi-line comment excluded', 'one', 'one <!-- a\nb\nc -->', 0, 0],
  ['words moved into a comment count as removed', 'one two three', 'one <!-- two three -->', 0, 2],
  ['fenced code is excluded', 'one', 'one\n\n```\ncode words here\n```\n', 0, 0],
  ['words moved into a code fence count as removed', 'one two', 'one\n```\ntwo\n```\n', 0, 1],
  ['CRLF line endings do not create words', 'one\r\ntwo', 'one\ntwo', 0, 0],
];

for (const [name, a, b, added, removed] of DELTA_TABLE) {
  test(`wordDelta: ${name}`, () => {
    assert.deepEqual(wordDelta(a, b), { added, removed });
  });
}

test('wordDelta: added - removed always equals the change in countWords', () => {
  const pairs = [
    ['The ferry nudged the jetty.\n\nShe looked away.', 'The ferry bumped the jetty twice.\n\nShe never looked away at all.'],
    ['a b c d e f g', 'g f e d c b a'],
    ['<!-- c --> x y z', 'x <!-- d e --> y'],
    ['', 'new'],
  ];
  for (const [a, b] of pairs) {
    const d = wordDelta(a, b);
    assert.equal(d.added - d.removed, countWords(b) - countWords(a), JSON.stringify([a, b]));
    assert.ok(d.added >= 0 && d.removed >= 0);
  }
});

test('wordDelta: symmetric (swapping old and new swaps added and removed)', () => {
  const a = 'one two three four five';
  const b = 'one 2 three five six seven';
  const f = wordDelta(a, b);
  const r = wordDelta(b, a);
  assert.deepEqual({ added: r.removed, removed: r.added }, f);
});

test('wordDelta: a series of saves sums to the same as one diff over a pure append/trim sequence', () => {
  const steps = ['one', 'one two', 'one two three four', 'one two three', 'one two three five six'];
  let added = 0;
  let removed = 0;
  for (let i = 1; i < steps.length; i++) {
    const d = wordDelta(steps[i - 1], steps[i]);
    added += d.added;
    removed += d.removed;
  }
  // +1 +2 -1 then (-0 +2): a, r per step: (1,0) (2,0) (0,1) (2,0)
  assert.deepEqual({ added, removed }, { added: 5, removed: 1 });
  assert.equal(added - removed, countWords(steps.at(-1)) - countWords(steps[0]));
});

test('wordDelta: above the token cap it falls back to max(0, new-old) / max(0, old-new)', () => {
  const n = FALLBACK_TOKENS; // old changed region alone is over the cap together with the new one
  const old = Array.from({ length: n }, (_, i) => `a${i}`).join(' ');
  const grown = Array.from({ length: n + 500 }, (_, i) => `b${i}`).join(' ');
  assert.deepEqual(wordDelta(old, grown), { added: 500, removed: 0 });
  assert.deepEqual(wordDelta(grown, old), { added: 0, removed: 500 });
  const same = Array.from({ length: n }, (_, i) => `c${i}`).join(' ');
  assert.deepEqual(wordDelta(old, same), { added: 0, removed: 0 });
});

test('wordDelta: a large body with a small edit stays exact and fast (common prefix/suffix are skipped)', () => {
  const words = Array.from({ length: 60_000 }, (_, i) => `w${i}`);
  const a = words.join(' ');
  const edited = [...words];
  edited.splice(30_000, 1, 'changed', 'twice');
  const t = Date.now();
  assert.deepEqual(wordDelta(a, edited.join(' ')), { added: 2, removed: 1 });
  assert.ok(Date.now() - t < 5000);
});

// ------------------------------------------------------------------ writing log file

const HEAD = '---\nschema: storyforge.doc/v1\nid: note_01S50000000000000000000ZZ1\ntitle: Writing log\n---\n';
const TABLE = '| Date | Words added | Words removed | Minutes | Sessions |\n|---|---|---|---|---|\n';

test('parseWritingLog reads the rows of the FORMAT-v1 9.1 example', () => {
  const text = `${HEAD}${TABLE}| 2026-11-01 | 642 | 87 | 95 | 3 |\n`;
  assert.deepEqual(parseWritingLog(text), [{ date: '2026-11-01', added: 642, removed: 87, minutes: 95, sessions: 3, ai: 0 }]);
});

test('parseWritingLog skips header, separator, prose and unparseable rows; accepts CRLF and loose spacing', () => {
  const text = [
    HEAD + 'Some prose the author added.\n',
    TABLE.trimEnd(),
    '|2026-10-30|1|2|3|4|',
    '| yesterday | lots | few | ? | ? |',
    '| 2026-10-31 | 5 | 6 |',
    '| 2026-11-01 | -4 | 0 | 0 | 0 |',
    '| 2026-11-02 | 1.5 | 0 | 0 | 0 |',
    '| 2026-11-03 | 7 | 8 | 9 | 10 |\r',
    '',
  ].join('\n');
  assert.deepEqual(parseWritingLog(text).map((r) => r.date), ['2026-10-30', '2026-11-03']);
  assert.deepEqual(parseWritingLog(text)[1], { date: '2026-11-03', added: 7, removed: 8, minutes: 9, sessions: 10, ai: 0 });
});

test('parseWritingLog: empty input and a file with no table give no rows', () => {
  assert.deepEqual(parseWritingLog(''), []);
  assert.deepEqual(parseWritingLog(HEAD + 'just words\n'), []);
});

test('newWritingLog is a storyforge.doc/v1 titled "Writing log" with the table header and no rows', () => {
  const text = newWritingLog();
  assert.match(text, /^---\nschema: storyforge\.doc\/v1\nid: note_[0-9A-HJKMNP-TV-Z]{26}\ntitle: Writing log\n---\n/);
  assert.ok(text.includes(TABLE.trimEnd()));
  assert.deepEqual(parseWritingLog(text), []);
  assert.equal(newWritingLog('note_01S50000000000000000000ZZ9').includes('id: note_01S50000000000000000000ZZ9\n'), true);
});

test('applyToWritingLog creates today\'s row at the end of a new log and accumulates in place', () => {
  let text = newWritingLog('note_01S50000000000000000000ZZ9');
  text = applyToWritingLog(text, '2026-11-01', { added: 10, removed: 2 });
  assert.deepEqual(parseWritingLog(text), [{ date: '2026-11-01', added: 10, removed: 2, minutes: 0, sessions: 0, ai: 0 }]);
  text = applyToWritingLog(text, '2026-11-01', { added: 5, minutes: 20, sessions: 1 });
  assert.deepEqual(parseWritingLog(text), [{ date: '2026-11-01', added: 15, removed: 2, minutes: 20, sessions: 1, ai: 0 }]);
});

test('applyToWritingLog: every other line stays byte-identical (earlier rows, unparseable rows, prose, front matter)', () => {
  const before =
    `${HEAD}\nIntro the author wrote.\n\n${TABLE}` +
    '| 2026-10-29 | 100 | 5 | 30 | 1 |\n' +
    '| not a date | x | y | z | w |\n' +
    '|2026-10-30|  200 |  0 | 10 | 1 |\n' +
    '| 2026-11-01 | 642 | 87 | 95 | 3 |\n' +
    '\nTrailing notes.\n';
  const after = applyToWritingLog(before, '2026-11-01', { added: 8, removed: 1, minutes: 5, sessions: 1 });
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(b.length, a.length);
  const changed = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.deepEqual(changed, [['| 2026-11-01 | 642 | 87 | 95 | 3 |', '| 2026-11-01 | 650 | 88 | 100 | 4 |']]);
});

test('applyToWritingLog: a new day goes after existing rows, a past day slots before later ones; others untouched', () => {
  const base = `${HEAD}${TABLE}| 2026-10-29 | 1 | 0 | 0 | 0 |\n| 2026-10-31 | 2 | 0 | 0 | 0 |\n`;
  const later = applyToWritingLog(base, '2026-11-01', { added: 3 });
  assert.deepEqual(parseWritingLog(later).map((r) => r.date), ['2026-10-29', '2026-10-31', '2026-11-01']);
  assert.ok(later.startsWith(base), 'existing bytes are a prefix');
  const middle = applyToWritingLog(base, '2026-10-30', { added: 9 });
  assert.deepEqual(parseWritingLog(middle).map((r) => r.date), ['2026-10-29', '2026-10-30', '2026-10-31']);
  for (const line of base.split('\n')) assert.ok(middle.split('\n').includes(line), line);
});

test('applyToWritingLog keeps CRLF files CRLF and changes only the one row', () => {
  const before = `${HEAD}${TABLE}| 2026-10-31 | 2 | 0 | 0 | 0 |\n| 2026-11-01 | 3 | 1 | 4 | 1 |\n`.replace(/\n/g, '\r\n');
  const after = applyToWritingLog(before, '2026-11-01', { added: 1 });
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF introduced');
  assert.ok(after.includes('| 2026-11-01 | 4 | 1 | 4 | 1 |\r\n'));
  assert.ok(after.includes('| 2026-10-31 | 2 | 0 | 0 | 0 |\r\n'));
  const newDay = applyToWritingLog(before, '2026-11-02', { added: 6 });
  assert.ok(!/[^\r]\n/.test(newDay), 'no bare LF introduced for a new row either');
  assert.ok(newDay.startsWith(before));
});

test('applyToWritingLog: a file with no table gets one appended; existing text is kept', () => {
  const before = `${HEAD}Hand written notes only.\n`;
  const after = applyToWritingLog(before, '2026-11-01', { added: 4, removed: 0, minutes: 2, sessions: 1 });
  assert.ok(after.startsWith(before));
  assert.deepEqual(parseWritingLog(after), [{ date: '2026-11-01', added: 4, removed: 0, minutes: 2, sessions: 1, ai: 0 }]);
});

test('applyToWritingLog: idempotent shape - applying a zero delta to an existing row changes nothing', () => {
  const before = `${HEAD}${TABLE}| 2026-11-01 | 3 | 1 | 4 | 1 |\n`;
  assert.equal(applyToWritingLog(before, '2026-11-01', {}), before);
});

test('applyToWritingLog: Unicode prose around the table survives byte-for-byte', () => {
  const prose = '\n潮が引く — “quoted” — café\n\n';
  const before = `${HEAD}${prose}${TABLE}| 2026-10-31 | 2 | 0 | 0 | 0 |\n`;
  const after = applyToWritingLog(before, '2026-11-01', { added: 1 });
  assert.ok(Buffer.from(after).includes(Buffer.from(prose)));
});

test('a log written by the app validates clean and its removal loses no manuscript text', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const base = (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort();
  let text = newWritingLog();
  text = applyToWritingLog(text, '2026-10-31', { added: 400, removed: 20, minutes: 45, sessions: 2 });
  text = applyToWritingLog(text, '2026-11-01', { added: 5 });
  await fs.mkdir(path.join(root, 'activity'));
  const file = path.join(root, 'activity', 'writing-log.md');
  await fs.writeFile(file, text);
  const withLog = await validate(root);
  assert.deepEqual(withLog.diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort(), base);
  const order = withLog.books[0].order.map((s) => s.id);
  await fs.rm(path.join(root, 'activity'), { recursive: true });
  const without = await validate(root);
  assert.deepEqual(without.books[0].order.map((s) => s.id), order);
  assert.deepEqual(without.diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort(), base);
});

// ------------------------------------------------------------------ dates

test('addDays crosses month, year and leap-day boundaries', () => {
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-11-01', 0), '2026-11-01');
});

test('localDate uses the local calendar date of the given instant', () => {
  const d = new Date(2026, 10, 1, 23, 59, 59); // local time
  assert.equal(localDate(d), '2026-11-01');
  assert.equal(localDate(new Date(2026, 10, 2, 0, 0, 1)), '2026-11-02');
  assert.equal(localDate(new Date(2026, 0, 5, 12)), '2026-01-05');
});

// ------------------------------------------------------------------ streak (acceptance 2)

const day = (date, added, removed = 0) => ({ date, added, removed });

test('computeStreak: 0 without a goal, with an invalid goal, and with no rows', () => {
  const rows = [day('2026-11-01', 900)];
  assert.equal(computeStreak(rows, null, '2026-11-01'), 0);
  assert.equal(computeStreak(rows, undefined, '2026-11-01'), 0);
  assert.equal(computeStreak(rows, 0, '2026-11-01'), 0);
  assert.equal(computeStreak(rows, 1.5, '2026-11-01'), 0);
  assert.equal(computeStreak([], 500, '2026-11-01'), 0);
});

test('computeStreak: consecutive days ending today with net >= goal', () => {
  const rows = [day('2026-10-30', 500), day('2026-10-31', 700), day('2026-11-01', 500)];
  assert.equal(computeStreak(rows, 500, '2026-11-01'), 3);
});

test('computeStreak: today still short of the goal does not break a streak ending yesterday', () => {
  const rows = [day('2026-10-30', 600), day('2026-10-31', 600), day('2026-11-01', 100)];
  assert.equal(computeStreak(rows, 500, '2026-11-01'), 2);
  assert.equal(computeStreak([day('2026-10-31', 600)], 500, '2026-11-01'), 1);
});

test('computeStreak: a gap day ends the streak; older days do not count', () => {
  const rows = [day('2026-10-20', 900), day('2026-10-21', 900), day('2026-10-23', 900), day('2026-10-24', 900), day('2026-10-25', 900)];
  assert.equal(computeStreak(rows, 500, '2026-10-25'), 3);
});

test('computeStreak: a streak that last met the goal two days ago is 0', () => {
  assert.equal(computeStreak([day('2026-10-30', 900)], 500, '2026-11-01'), 0);
});

test('computeStreak uses net words (added - removed), and the boundary net == goal counts', () => {
  assert.equal(computeStreak([day('2026-11-01', 800, 300)], 500, '2026-11-01'), 1);
  assert.equal(computeStreak([day('2026-11-01', 800, 301)], 500, '2026-11-01'), 0);
  assert.equal(computeStreak([day('2026-11-01', 1000, 2000)], 1, '2026-11-01'), 0);
});

test('computeStreak crosses month and year boundaries and ignores row order', () => {
  const rows = [day('2027-01-01', 50), day('2026-12-30', 50), day('2026-12-31', 50)];
  assert.equal(computeStreak(rows, 50, '2027-01-01'), 3);
});

test('computeStreak sums duplicate rows for the same date', () => {
  assert.equal(computeStreak([day('2026-11-01', 300), day('2026-11-01', 300)], 500, '2026-11-01'), 1);
});

test('streak over a log text: parse then compute (unparseable rows skipped)', () => {
  const text =
    `${HEAD}${TABLE}| 2026-10-30 | 500 | 0 | 10 | 1 |\n| ??? | ??? | ??? | ??? | ??? |\n| 2026-10-31 | 500 | 0 | 10 | 1 |\n`;
  assert.equal(computeStreak(parseWritingLog(text), 500, '2026-11-01'), 2);
});

// ------------------------------------------------------------------ the server-side tally (fake clock, fake timers)

const LOG_FILE = 'activity/writing-log.md';

/** A fake clock and fake timers: nothing here waits or reads the real time. */
function fakeTime(startMs) {
  let t = startMs;
  const timers = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    timers,
    api: {
      setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false, unref() {} }; timers.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; },
    },
    live: () => timers.filter((x) => !x.cleared),
  };
}

async function activitySetup({ goal = null, start = new Date(2026, 10, 1, 12, 0, 0).getTime() } = {}) {
  const root = await copyFixture('valid/salt-orchard');
  const time = fakeTime(start);
  const written = [];
  const activity = createActivity({
    rootOf: () => root,
    readGoal: async () => goal,
    afterWrite: (b) => written.push(b),
    now: time.now,
    timers: time.api,
  });
  const read = () => fs.readFile(path.join(root, LOG_FILE), 'utf8').catch(() => null);
  return { root, time, activity, written, read };
}

test('activity: FLUSH_MS is 60 seconds', () => {
  assert.equal(FLUSH_MS, 60_000);
});

test("activity: recorded words stay in memory until the flush timer fires; then the file is created with today's row", async () => {
  const { activity, time, read, written } = await activitySetup();
  activity.record('b', { added: 120, removed: 20 });
  activity.record('b', { added: 30, removed: 0 });
  assert.equal(await read(), null, 'nothing written yet');
  assert.equal(time.live().length, 1, 'one flush timer, not one per save');
  assert.equal(time.live()[0].ms, FLUSH_MS);

  time.live()[0].fn();
  await activity.flush();
  const text = await read();
  assert.match(text, /^---\nschema: storyforge\.doc\/v1\nid: note_[0-9A-HJKMNP-TV-Z]{26}\ntitle: Writing log\n---\n/);
  assert.deepEqual(parseWritingLog(text), [{ date: '2026-11-01', added: 150, removed: 20, minutes: 0, sessions: 0, ai: 0 }]);
  assert.deepEqual(written, ['b']);
});

test('activity: a zero delta schedules nothing and writes nothing', async () => {
  const { activity, time, read } = await activitySetup();
  activity.record('b', { added: 0, removed: 0 });
  assert.equal(time.live().length, 0);
  await activity.flush();
  assert.equal(await read(), null);
});

test('activity: session reports add minutes and one session each', async () => {
  const { activity, read } = await activitySetup();
  activity.session('b', 25);
  activity.session('b', 5);
  await activity.flush();
  assert.deepEqual(parseWritingLog(await read()), [{ date: '2026-11-01', added: 0, removed: 0, minutes: 30, sessions: 2, ai: 0 }]);
});

test("activity: a second flush updates today's row in place; earlier rows and unparseable rows stay byte-identical", async () => {
  const { activity, root, read } = await activitySetup();
  await fs.mkdir(path.join(root, 'activity'));
  const seeded =
    `${HEAD}\nMy own notes.\n\n${TABLE}| 2026-10-30 | 400 | 20 | 45 | 2 |\n| not a row at all |\n|2026-10-31|  10 | 0 | 5 | 1 |\n`;
  await fs.writeFile(path.join(root, LOG_FILE), seeded);
  activity.record('b', { added: 50, removed: 5 });
  await activity.flush();
  activity.record('b', { added: 7, removed: 1 });
  activity.session('b', 12);
  await activity.flush();
  const after = await read();
  assert.ok(after.startsWith(seeded), 'existing bytes are an exact prefix');
  assert.equal(after.slice(seeded.length), '| 2026-11-01 | 57 | 6 | 12 | 1 |\n');
});

test('activity: the day rolls over with the clock; each day gets its own row', async () => {
  const { activity, time, read } = await activitySetup({ start: new Date(2026, 10, 1, 23, 59, 0).getTime() });
  activity.record('b', { added: 10, removed: 0 });
  await activity.flush();
  time.advance(2 * 60_000); // past local midnight
  activity.record('b', { added: 4, removed: 1 });
  await activity.flush();
  assert.deepEqual(parseWritingLog(await read()).map((r) => [r.date, r.added, r.removed]), [['2026-11-01', 10, 0], ['2026-11-02', 4, 1]]);
});

test('activity: close() flushes what is pending and leaves no live timer', async () => {
  const { activity, time, read } = await activitySetup();
  activity.record('b', { added: 9, removed: 3 });
  await activity.close();
  assert.deepEqual(parseWritingLog(await read()).map((r) => [r.added, r.removed]), [[9, 3]]);
  assert.equal(time.live().length, 0);
});

test('activity: a failed flush keeps the totals pending (nothing lost) and a later flush writes them', async () => {
  const { activity, root, read } = await activitySetup();
  await fs.writeFile(path.join(root, 'activity'), 'in the way'); // activity/ is a file: the write cannot succeed
  activity.record('b', { added: 11, removed: 0 });
  await activity.flush();
  assert.equal((await activity.read('b')).today.added, 11, 'still counted from memory');
  await fs.rm(path.join(root, 'activity'));
  await activity.flush();
  assert.deepEqual(parseWritingLog(await read()).map((r) => r.added), [11]);
});

test('activity.read: file rows plus pending memory; today, days, goal and streak (fake dates)', async () => {
  const { activity, root } = await activitySetup({ goal: 500 });
  await fs.mkdir(path.join(root, 'activity'));
  await fs.writeFile(
    path.join(root, LOG_FILE),
    `${HEAD}${TABLE}| 2026-10-29 | 900 | 0 | 0 | 0 |\n| 2026-10-30 | 100 | 0 | 0 | 0 |\n| 2026-10-31 | 600 | 100 | 40 | 2 |\n`,
  );
  activity.record('b', { added: 520, removed: 10 });
  activity.session('b', 15);
  const r = await activity.read('b', { days: 30 });
  assert.equal(r.goal, 500);
  assert.deepEqual(r.today, { date: '2026-11-01', added: 520, removed: 10, net: 510, minutes: 15, sessions: 1, ai_words: 0 });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(r.days[2].net, 500);
  assert.equal(r.streak, 2, '10-31 (net 500) and 11-01 (net 510); 10-30 was short');
});

test('activity.read: days limits the window; no goal means streak 0; a quiet today is zeros', async () => {
  const { activity, root } = await activitySetup({ goal: null });
  await fs.mkdir(path.join(root, 'activity'));
  await fs.writeFile(path.join(root, LOG_FILE), `${HEAD}${TABLE}| 2026-10-01 | 900 | 0 | 0 | 0 |\n| 2026-10-31 | 900 | 0 | 0 | 0 |\n`);
  const r = await activity.read('b', { days: 7 });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-10-31']);
  assert.equal(r.streak, 0);
  assert.deepEqual(r.today, { date: '2026-11-01', added: 0, removed: 0, net: 0, minutes: 0, sessions: 0, ai_words: 0 });
});

test('activity.read: a missing log file reads as an empty history', async () => {
  const { activity } = await activitySetup({ goal: 100 });
  const r = await activity.read('b');
  assert.deepEqual(r.days, []);
  assert.equal(r.streak, 0);
});

test('activity: a log written by flush validates clean with the book', async () => {
  const { activity, root } = await activitySetup();
  const base = (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort();
  activity.record('b', { added: 5, removed: 1 });
  activity.session('b', 3);
  await activity.flush();
  assert.deepEqual((await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort(), base);
});

// ------------------------------------------------------------------ M12 W3: the optional AI words column

test('AI words: old rows parse with 0, a row with the trailing column carries it, and mixed rows share one table', () => {
  const text = '| Date | Words added | Words removed | Minutes | Sessions | AI words |\n|---|---|---|---|---|---|\n| 2026-11-01 | 10 | 2 | 5 | 1 |\n| 2026-11-02 | 7 | 0 | 3 | 1 | 250 |\n';
  assert.deepEqual(parseWritingLog(text), [
    { date: '2026-11-01', added: 10, removed: 2, minutes: 5, sessions: 1, ai: 0 },
    { date: '2026-11-02', added: 7, removed: 0, minutes: 3, sessions: 1, ai: 250 },
  ]);
});

test('AI words: the column is written only for a row that has AI words, and then the header and separator get it once; other rows stay as they were', () => {
  let text = newWritingLog('note_01S5000000000000000000AAAA');
  text = applyToWritingLog(text, '2026-11-01', { added: 10, removed: 2 });
  assert.doesNotMatch(text, /AI words/, 'no AI words, no column');
  const plain = text;
  text = applyToWritingLog(text, '2026-11-02', { ai: 300 });
  assert.match(text, /\| Date \| Words added \| Words removed \| Minutes \| Sessions \| AI words \|\n\|---\|---\|---\|---\|---\|---\|\n\| 2026-11-01 \| 10 \| 2 \| 0 \| 0 \|\n\| 2026-11-02 \| 0 \| 0 \| 0 \| 0 \| 300 \|\n/);
  assert.equal((text.match(/AI words/g) ?? []).length, 1);
  text = applyToWritingLog(text, '2026-11-02', { ai: 20, added: 1 });
  text = applyToWritingLog(text, '2026-11-01', { added: 5 });
  assert.deepEqual(parseWritingLog(text).map((r) => [r.date, r.added, r.ai]), [['2026-11-01', 15, 0], ['2026-11-02', 1, 320]]);
  assert.equal((text.match(/AI words/g) ?? []).length, 1, 'the header is changed once');
  assert.ok(text.includes('| 2026-11-01 | 15 | 2 | 0 | 0 |\n'), 'a row without AI words keeps five cells');
  // adding AI words to an existing 5-cell row
  assert.match(applyToWritingLog(plain, '2026-11-01', { ai: 9 }), /\| 2026-11-01 \| 10 \| 2 \| 0 \| 0 \| 9 \|\n/);
});

test('AI words: a CRLF file keeps its line endings, and a file with no table gets a table with the column', () => {
  const crlf = '---\r\nschema: storyforge.doc/v1\r\nid: note_01S5000000000000000000AAAA\r\ntitle: Writing log\r\n---\r\n\r\n| Date | Words added | Words removed | Minutes | Sessions |\r\n|---|---|---|---|---|\r\n| 2026-11-01 | 10 | 2 | 0 | 0 |\r\n';
  const out = applyToWritingLog(crlf, '2026-11-01', { ai: 40 });
  assert.ok(!/[^\r]\n/.test(out), 'every line break is still CRLF');
  assert.match(out, /\| Sessions \| AI words \|\r\n\|---\|---\|---\|---\|---\|---\|\r\n\| 2026-11-01 \| 10 \| 2 \| 0 \| 0 \| 40 \|\r\n/);
  const bare = applyToWritingLog('Notes only.\n', '2026-11-01', { ai: 7 });
  assert.match(bare, /Notes only\.\n\n\| Date \| Words added \| Words removed \| Minutes \| Sessions \| AI words \|\n\|---\|---\|---\|---\|---\|---\|\n\| 2026-11-01 \| 0 \| 0 \| 0 \| 0 \| 7 \|\n/);
});
