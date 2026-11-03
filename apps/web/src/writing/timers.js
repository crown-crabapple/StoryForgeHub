// Sprints and timers (M07-J02 section 2). Pure state, a clock that is passed in, and a small controller that needs no DOM: tests drive it with a fake clock.
//   Sprint: N minutes with an optional word target. Timer: a plain countdown. Both can be paused and resumed.
//   Finishing one (the countdown reaching zero, or "Finish now") reports one row { start, end, kind, scenes }; `end` is `start` plus the time that was actually spent, pauses left out.
//   Abandoning one reports nothing. The time left is announced once a minute (politely, in the shared live region).

export const MS_MINUTE = 60_000;
export const KINDS = /** @type {const} */ (['sprint', 'timer']);
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 240;
/** Under half a minute of real time there is nothing worth a row (the server rounds a session to whole minutes, at least 1). */
export const MIN_REPORT_MS = 30_000;

/**
 * @typedef {{ kind: 'sprint' | 'timer', bookId: string, status: 'running' | 'paused' | 'done', startedAt: number, plannedMs: number, activeMs: number,
 *   lastAt: number, wordTarget: number | null, scenes: string[], announced: number }} Timer
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A whole number of minutes from 1 to 240, or null. @param {unknown} v */
export function parseMinutes(v) {
  const n = typeof v === 'number' ? v : /^\s*\d{1,3}\s*$/.test(String(v)) ? Number(String(v)) : NaN;
  return Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null;
}

/** An optional word target: a whole number >= 1, or null (nothing typed). `undefined` when what was typed is not a number. @param {unknown} v */
export function parseWordTarget(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = /^\s*\d{1,7}\s*$/.test(String(v)) ? Number(String(v)) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** @param {{ kind: 'sprint' | 'timer', minutes: number, bookId: string, now: number, wordTarget?: number | null, scene?: string | null }} p @returns {Timer} */
export function startTimer({ kind, minutes, bookId, now, wordTarget = null, scene = null }) {
  return { kind, bookId, status: 'running', startedAt: now, plannedMs: minutes * MS_MINUTE, activeMs: 0, lastAt: now, wordTarget: kind === 'sprint' ? wordTarget : null, scenes: scene ? [scene] : [], announced: minutes };
}

/** The timer with its clock brought up to `now` (a paused or finished timer does not move). @param {Timer} t @param {number} now @returns {Timer} */
export function advance(t, now) {
  if (t.status !== 'running') return t;
  const activeMs = Math.min(t.plannedMs, t.activeMs + Math.max(0, now - t.lastAt));
  return { ...t, activeMs, lastAt: now, status: activeMs >= t.plannedMs ? 'done' : 'running' };
}

/** @param {Timer} t @param {number} now */
export const pause = (t, now) => (t.status === 'running' ? { ...advance(t, now), status: /** @type {const} */ ('paused') } : t);
/** @param {Timer} t @param {number} now @returns {Timer} */
export const resume = (t, now) => (t.status === 'paused' ? { ...t, status: 'running', lastAt: now } : t);
/** The scene being worked on is part of the row. @param {Timer} t @param {string | null | undefined} sceneId */
export const noteScene = (t, sceneId) => (sceneId && !t.scenes.includes(sceneId) ? { ...t, scenes: [...t.scenes, sceneId] } : t);

/** @param {Timer} t */
export const remainingMs = (t) => Math.max(0, t.plannedMs - t.activeMs);
/** Whole minutes left, rounded up: 1 until the very last moment. @param {Timer} t */
export const minutesLeft = (t) => Math.ceil(remainingMs(t) / MS_MINUTE);

/** "24:09" or "1:02:03". @param {number} ms */
export function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

const NAME = { sprint: 'Sprint', timer: 'Timer' };

/** What is said when the timer starts. @param {Timer} t */
export const startMessage = (t) => `${NAME[t.kind]} started: ${plural(Math.round(t.plannedMs / MS_MINUTE), 'minute')}${t.wordTarget ? `, target ${plural(t.wordTarget, 'word')}` : ''}.`;

/**
 * The sentence to announce now, or null: once a minute, when the whole minutes left drop below the last one announced. Returns the timer with `announced` updated.
 * @param {Timer} t @returns {{ timer: Timer, message: string | null }}
 */
export function minuteAnnouncement(t) {
  if (t.status !== 'running') return { timer: t, message: null };
  const left = minutesLeft(t);
  if (left >= t.announced || left < 1) return { timer: t, message: null };
  return { timer: { ...t, announced: left }, message: `${plural(left, 'minute')} left.` };
}

/** The row for the server: start and end as UTC ISO times to the second, `end` = start + time spent. Null when too little time was spent. @param {Timer} t */
export function finishRow(t) {
  if (t.activeMs < MIN_REPORT_MS) return null;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { start: iso(t.startedAt), end: iso(t.startedAt + t.activeMs), kind: t.kind, scenes: t.scenes };
}

/** The sentence after a finished timer was reported. @param {Timer} t @param {{ added?: number, minutes?: number } | null} row what the server wrote */
export function finishedMessage(t, row) {
  const mins = row?.minutes ?? Math.max(1, Math.round(t.activeMs / MS_MINUTE));
  const words = row && typeof row.added === 'number' ? ` ${plural(row.added, 'word')} added${t.wordTarget ? `, target ${t.wordTarget}${row.added >= t.wordTarget ? ': reached' : ''}` : ''}.` : '';
  return `${NAME[t.kind]} finished: ${plural(mins, 'minute')}.${words}`;
}

/**
 * The timer in use: one at a time. `report(row, timer)` sends a finished timer's row and resolves with what the server wrote (or null); `announce(text)` speaks.
 * `schedule(fn, ms)` / `unschedule(id)` run the one-second tick (setInterval / clearInterval; a fake in tests).
 * @param {{ clock: () => number, schedule: (fn: () => void, ms: number) => any, unschedule: (id: any) => void, announce: (text: string) => void,
 *   report: (row: { start: string, end: string, kind: string, scenes: string[] }, timer: Timer) => Promise<{ added?: number, minutes?: number } | null> }} deps
 */
export function createTimers({ clock, schedule, unschedule, announce, report }) {
  /** @type {Timer | null} */
  let timer = null;
  let handle = null;
  /** @type {Set<(t: Timer | null) => void>} */
  const listeners = new Set();
  const set = (next) => {
    timer = next;
    for (const l of listeners) l(timer);
  };
  const stopTick = () => {
    if (handle !== null) unschedule(handle);
    handle = null;
  };

  async function finish(t) {
    stopTick();
    set(null);
    const row = finishRow(t);
    if (!row) {
      announce(`${NAME[t.kind]} stopped: too short to record.`);
      return null;
    }
    const written = await Promise.resolve()
      .then(() => report(row, t))
      .catch(() => null);
    announce(written ? finishedMessage(t, written) : `${NAME[t.kind]} finished, but the session could not be saved.`);
    return written;
  }

  function tick() {
    if (!timer) return;
    let next = advance(timer, clock());
    if (next.status === 'done') {
      void finish(next);
      return;
    }
    const m = minuteAnnouncement(next);
    next = m.timer;
    if (m.message) announce(m.message);
    set(next);
  }

  return {
    /** @param {{ kind: 'sprint' | 'timer', minutes: number, bookId: string, wordTarget?: number | null, scene?: string | null }} p */
    start(p) {
      if (timer) return false;
      const t = startTimer({ ...p, now: clock() });
      set(t);
      announce(startMessage(t));
      handle = schedule(tick, 1000);
      return true;
    },
    pause() {
      if (timer?.status !== 'running') return;
      set(pause(timer, clock()));
      announce(`${NAME[timer.kind]} paused. ${plural(minutesLeft(timer), 'minute')} left.`);
    },
    resume() {
      if (timer?.status !== 'paused') return;
      set(resume(timer, clock()));
      announce(`${NAME[timer.kind]} resumed.`);
    },
    /** Finish now: reports the time spent so far. */
    finishNow() {
      if (!timer) return Promise.resolve(null);
      return finish(advance(timer, clock()));
    },
    /** Stop without recording anything. */
    abandon() {
      if (!timer) return;
      const name = NAME[timer.kind];
      stopTick();
      set(null);
      announce(`${name} stopped. Nothing was recorded.`);
    },
    noteScene(sceneId) {
      if (timer) timer = noteScene(timer, sceneId);
    },
    tick,
    get: () => timer,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Say something in the shared polite live region (the toast stack, which is always on the page).
 * @param {string} text @param {{ getElementById: (id: string) => any, createElement: (tag: string) => any } | null} [doc]
 */
export function announceText(text, doc = typeof document === 'undefined' ? null : document) {
  const host = doc?.getElementById('toast-stack');
  if (!host) return false;
  const el = doc.createElement('div');
  el.className = 'sr-only';
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove?.(), 15_000);
  return true;
}
