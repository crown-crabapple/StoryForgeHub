// M07-J02 acceptance 4: timers on a fake clock. Sprint (with a word target), plain timer, pause and resume, abandon (no row), the once-a-minute announcement,
// the row's `end` (start plus time actually spent) and the announcement helper. No DOM, no real time.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MS_MINUTE, announceText, clockText, createTimers, finishRow, parseMinutes, parseWordTarget } from '../src/writing/timers.js';

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);

/** A fake clock with a fake one-second interval: `advance(ms)` moves time forward and runs every tick that falls due, in order. */
function world() {
  let now = T0;
  /** @type {{ fn: () => void, every: number, next: number, id: number } | null} */
  let job = null;
  let ids = 0;
  const said = [];
  const rows = [];
  let answer = (row) => ({ minutes: Math.round((Date.parse(row.end) - Date.parse(row.start)) / MS_MINUTE), added: 120 });
  const timers = createTimers({
    clock: () => now,
    schedule: (fn, every) => {
      job = { fn, every, next: now + every, id: ++ids };
      return job.id;
    },
    unschedule: (id) => {
      if (job?.id === id) job = null;
    },
    announce: (t) => said.push(t),
    report: async (row, timer) => {
      rows.push({ row, timer });
      return answer(row);
    },
  });
  return {
    timers, said, rows,
    setAnswer: (fn) => (answer = fn),
    running: () => job !== null,
    async advance(ms) {
      const end = now + ms;
      while (job && job.next <= end) {
        now = job.next;
        job.next += job.every;
        job.fn();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

describe('sprint', () => {
  test('a 3 minute sprint with a word target: starts, announces once a minute, finishes at zero and reports one row of kind sprint', async () => {
    const w = world();
    assert.equal(w.timers.start({ kind: 'sprint', minutes: 3, bookId: 'book_1', wordTarget: 300, scene: 'scene_A' }), true);
    assert.deepEqual(w.said, ['Sprint started: 3 minutes, target 300 words.']);
    await w.advance(59_000);
    assert.equal(w.said.length, 1, 'nothing before the minute is up');
    await w.advance(1_000);
    assert.deepEqual(w.said.slice(1), ['2 minutes left.']);
    await w.advance(60_000);
    assert.deepEqual(w.said.slice(2), ['1 minute left.']);
    assert.equal(w.rows.length, 0);
    await w.advance(59_000);
    assert.equal(w.rows.length, 0, 'one second to go');
    await w.advance(1_000);
    await Promise.resolve();
    assert.equal(w.rows.length, 1);
    assert.deepEqual(w.rows[0].row, { start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:03:00Z', kind: 'sprint', scenes: ['scene_A'] });
    assert.equal(w.timers.get(), null);
    assert.equal(w.running(), false, 'the tick stops');
    assert.equal(w.said.at(-1), 'Sprint finished: 3 minutes. 120 words added, target 300.');
  });

  test('the word target is reported against the words the server counted', async () => {
    const w = world();
    w.setAnswer(() => ({ minutes: 1, added: 400 }));
    w.timers.start({ kind: 'sprint', minutes: 1, bookId: 'book_1', wordTarget: 300 });
    await w.advance(MS_MINUTE);
    await Promise.resolve();
    assert.match(w.said.at(-1), /400 words added, target 300: reached\.$/);
  });

  test('the scenes seen while it ran go in the row, each once', async () => {
    const w = world();
    w.timers.start({ kind: 'sprint', minutes: 2, bookId: 'book_1', scene: 'scene_A' });
    await w.advance(30_000);
    w.timers.noteScene('scene_B');
    w.timers.noteScene('scene_B');
    w.timers.noteScene('scene_A');
    await w.advance(90_000);
    await Promise.resolve();
    assert.deepEqual(w.rows[0].row.scenes, ['scene_A', 'scene_B']);
  });

  test('only one timer at a time', () => {
    const w = world();
    assert.equal(w.timers.start({ kind: 'sprint', minutes: 5, bookId: 'b' }), true);
    assert.equal(w.timers.start({ kind: 'timer', minutes: 5, bookId: 'b' }), false);
  });
});

describe('timer: pause and resume', () => {
  test('time spent paused is not time spent: the row ends where the active time ends', async () => {
    const w = world();
    w.timers.start({ kind: 'timer', minutes: 4, bookId: 'book_1' });
    await w.advance(90_000);
    w.timers.pause();
    assert.equal(w.timers.get().status, 'paused');
    assert.match(w.said.at(-1), /^Timer paused\. 3 minutes left\.$/);
    await w.advance(10 * MS_MINUTE);
    assert.equal(w.timers.get().activeMs, 90_000, 'a paused timer does not move');
    assert.equal(w.said.filter((s) => /left\.$/.test(s) && !/paused/.test(s)).length, 1, 'and announces nothing while paused');
    w.timers.resume();
    assert.equal(w.said.at(-1), 'Timer resumed.');
    await w.advance(150_000);
    await w.advance(0);
    await Promise.resolve();
    assert.equal(w.rows.length, 1);
    assert.deepEqual(w.rows[0].row, { start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:04:00Z', kind: 'timer', scenes: [] });
    assert.equal(w.timers.get(), null);
  });

  test('pause twice and resume twice are harmless; a paused timer can be finished early and reports the time spent', async () => {
    const w = world();
    w.timers.start({ kind: 'timer', minutes: 25, bookId: 'book_1' });
    await w.advance(5 * MS_MINUTE);
    w.timers.pause();
    w.timers.pause();
    w.timers.resume();
    w.timers.resume();
    await w.advance(2 * MS_MINUTE);
    w.timers.pause();
    const written = await w.timers.finishNow();
    assert.deepEqual(w.rows[0].row, { start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:07:00Z', kind: 'timer', scenes: [] });
    assert.equal(written.minutes, 7);
    assert.equal(w.timers.get(), null);
  });
});

describe('abandon writes nothing', () => {
  test('abandoning a running sprint reports no row, stops the tick and says so', async () => {
    const w = world();
    w.timers.start({ kind: 'sprint', minutes: 10, bookId: 'book_1' });
    await w.advance(5 * MS_MINUTE);
    w.timers.abandon();
    assert.equal(w.rows.length, 0);
    assert.equal(w.timers.get(), null);
    assert.equal(w.running(), false);
    assert.equal(w.said.at(-1), 'Sprint stopped. Nothing was recorded.');
    await w.advance(20 * MS_MINUTE);
    assert.equal(w.rows.length, 0, 'still nothing, however long we wait');
  });

  test('abandoning a paused timer reports no row either; a start after it works', async () => {
    const w = world();
    w.timers.start({ kind: 'timer', minutes: 10, bookId: 'book_1' });
    await w.advance(3 * MS_MINUTE);
    w.timers.pause();
    w.timers.abandon();
    assert.equal(w.rows.length, 0);
    assert.equal(w.timers.start({ kind: 'timer', minutes: 1, bookId: 'book_1' }), true);
  });

  test('"Finish now" in the first seconds records nothing (too short), and says so', async () => {
    const w = world();
    w.timers.start({ kind: 'sprint', minutes: 10, bookId: 'book_1' });
    await w.advance(10_000);
    assert.equal(await w.timers.finishNow(), null);
    assert.equal(w.rows.length, 0);
    assert.match(w.said.at(-1), /too short to record/);
  });

  test('a report that fails is said, not hidden; the timer is over either way', async () => {
    const w = world();
    w.setAnswer(() => null);
    w.timers.start({ kind: 'timer', minutes: 1, bookId: 'book_1' });
    await w.advance(MS_MINUTE);
    await Promise.resolve();
    assert.match(w.said.at(-1), /could not be saved/);
    assert.equal(w.timers.get(), null);
  });
});

describe('listeners and helpers', () => {
  test('subscribers see every change, including the end', async () => {
    const w = world();
    const seen = [];
    const off = w.timers.subscribe((t) => seen.push(t?.status ?? null));
    w.timers.start({ kind: 'timer', minutes: 1, bookId: 'b' });
    await w.advance(2_000);
    w.timers.pause();
    w.timers.resume();
    await w.advance(58_000);
    assert.deepEqual([seen[0], seen.at(-1)], ['running', null]);
    assert.ok(seen.includes('paused'));
    off();
  });

  test('clockText, parseMinutes, parseWordTarget', () => {
    assert.equal(clockText(25 * MS_MINUTE), '25:00');
    assert.equal(clockText(61_000), '1:01');
    assert.equal(clockText(500), '0:01');
    assert.equal(clockText(3_661_000), '1:01:01');
    assert.equal(parseMinutes('25'), 25);
    assert.equal(parseMinutes(' 7 '), 7);
    for (const bad of ['0', '241', '2.5', '-3', 'ten', '', null]) assert.equal(parseMinutes(bad), null, String(bad));
    assert.equal(parseWordTarget(''), null);
    assert.equal(parseWordTarget('300'), 300);
    for (const bad of ['0', '-1', 'x', '2.5']) assert.equal(parseWordTarget(bad), undefined, bad);
    assert.equal(finishRow({ activeMs: 29_999 }), null);
  });

  test('announceText puts the sentence in the shared live region (the toast stack) and does nothing when there is none', () => {
    const children = [];
    const host = { appendChild: (c) => children.push(c) };
    const doc = { getElementById: (id) => (id === 'toast-stack' ? host : null), createElement: () => ({ remove() {} }) };
    assert.equal(announceText('2 minutes left.', doc), true);
    assert.equal(children[0].textContent, '2 minutes left.');
    assert.equal(children[0].className, 'sr-only');
    assert.equal(announceText('x', { getElementById: () => null, createElement: () => ({}) }), false);
    assert.equal(announceText('x', null), false);
  });
});
