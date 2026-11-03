// The server's writing log: per book and local date, words added / removed (from body saves) and minutes / sessions (from client
// reports) are kept in memory and flushed to activity/writing-log.md through the store: at most every flushMs, and on close.
import { openStore } from '@storyforge/store';
import { LOG_PATH, applyToWritingLog, computeStreak, localDate, newWritingLog, parseWritingLog } from './writing-log.mjs';
import { SESSIONS_DIR, appendSession, isoSecond, newSessionsFile, parseSessions, sessionsPath } from './sessions.mjs';

export const FLUSH_MS = 60_000;

const ZERO = () => ({ added: 0, removed: 0, minutes: 0, sessions: 0 });
const sum = (a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed, minutes: a.minutes + b.minutes, sessions: a.sessions + b.sessions });

/**
 * @param {{
 *   rootOf: (bookPath: string) => string,
 *   readGoal: (bookPath: string) => Promise<number | null>,
 *   afterWrite?: (bookPath: string) => void,
 *   now?: () => number | Date,
 *   flushMs?: number,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void },
 * }} deps
 */
export function createActivity({ rootOf, readGoal, afterWrite = () => {}, now = () => Date.now(), flushMs = FLUSH_MS, timers }) {
  const t = timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const clock = () => new Date(Number(now()));
  /** @type {Map<string, Map<string, ReturnType<typeof ZERO>>>} book path -> date -> totals not yet in the file */
  const pending = new Map();
  let timer = null;
  let flushing = Promise.resolve();
  let closed = false;
  /** @type {Map<string, { at: number, added: number, removed: number }[]>} book path -> the saves of the last day (for the Added / Removed of a session row) */
  const saves = new Map();

  function schedule() {
    if (timer !== null || closed) return;
    timer = t.setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    timer?.unref?.();
  }

  function add(bookPath, date, delta) {
    let days = pending.get(bookPath);
    if (!days) pending.set(bookPath, (days = new Map()));
    days.set(date, sum(days.get(date) ?? ZERO(), { ...ZERO(), ...delta }));
    schedule();
  }

  async function flushBook(bookPath, days) {
    const store = await openStore(rootOf(bookPath), { recover: false });
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await store.read(LOG_PATH);
      let text = cur ? cur.bytes.toString('utf8') : newWritingLog();
      for (const [date, delta] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) text = applyToWritingLog(text, date, delta);
      const r = await store.write(LOG_PATH, Buffer.from(text, 'utf8'), { baseSha256: cur ? cur.sha256 : null });
      if (r.ok) {
        afterWrite(bookPath);
        return true;
      }
      if (r.code !== 'CONFLICT' && r.code !== 'EXISTS') return false;
    }
    return false;
  }

  /** Write everything pending. Totals that could not be written stay pending. */
  function flush() {
    flushing = flushing.then(async () => {
      if (timer !== null) {
        t.clearTimeout(timer);
        timer = null;
      }
      for (const [bookPath, days] of [...pending]) {
        const taken = new Map(days);
        pending.delete(bookPath);
        let ok;
        try {
          ok = await flushBook(bookPath, taken);
        } catch {
          ok = false;
        }
        if (!ok) for (const [date, delta] of taken) add(bookPath, date, delta);
      }
    });
    return flushing;
  }

  return {
    /** A body save changed the text by these words. */
    record(bookPath, { added, removed }) {
      if (!added && !removed) return;
      add(bookPath, localDate(clock()), { added, removed });
      const at = clock().getTime();
      const list = (saves.get(bookPath) ?? []).filter((x) => at - x.at < 86_400_000);
      list.push({ at, added, removed });
      saves.set(bookPath, list);
    },
    /** The client reports a finished session of `minutes` (>= 1). */
    session(bookPath, minutes) {
      add(bookPath, localDate(clock()), { minutes, sessions: 1 });
    },
    /**
     * Append one row to activity/sessions/<YYYY>/<YYYY-MM>.md (through the store, at once). Added / Removed are the saves this server saw between
     * start and end. A row of kind `session` also counts in the writing log (minutes, sessions); sprints and timers are detail only.
     * @param {string} bookPath @param {{ start: number, end: number, kind: 'session'|'sprint'|'timer', scenes: string[] }} r start / end in ms
     * @returns {Promise<{ ok: boolean, row?: import('./sessions.mjs').SessionRow, path?: string }>}
     */
    async appendSession(bookPath, { start, end, kind, scenes }) {
      const minutes = Math.max(1, Math.round((end - start) / 60_000));
      let added = 0;
      let removed = 0;
      for (const x of saves.get(bookPath) ?? []) {
        if (x.at >= start && x.at <= end) {
          added += x.added;
          removed += x.removed;
        }
      }
      const row = { start: isoSecond(start), end: isoSecond(end), minutes, added, removed, kind, scenes };
      const rel = sessionsPath(start);
      const store = await openStore(rootOf(bookPath), { recover: false });
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await store.read(rel);
        const text = cur ? cur.bytes.toString('utf8') : newSessionsFile(rel.slice(rel.lastIndexOf('/') + 1, -3));
        const r = await store.write(rel, Buffer.from(appendSession(text, row), 'utf8'), { baseSha256: cur ? cur.sha256 : null });
        if (r.ok) {
          afterWrite(bookPath);
          if (kind === 'session') add(bookPath, localDate(new Date(start)), { minutes, sessions: 1 });
          return { ok: true, row, path: rel };
        }
        if (r.code !== 'CONFLICT' && r.code !== 'EXISTS') break;
      }
      return { ok: false };
    },
    /** Every session row of the book, oldest file first (rows the app cannot parse are skipped). @param {string} bookPath */
    async sessions(bookPath) {
      const store = await openStore(rootOf(bookPath), { recover: false });
      const rows = [];
      const years = (await store.list(SESSIONS_DIR)).filter((e) => e.isDirectory && /^d{4}$/.test(e.name)).map((e) => e.name).sort();
      for (const y of years) {
        const files = (await store.list(`${SESSIONS_DIR}/${y}`)).filter((e) => !e.isDirectory && /^d{4}-d{2}.md$/.test(e.name)).map((e) => e.name).sort();
        for (const f of files) {
          const got = await store.read(`${SESSIONS_DIR}/${y}/${f}`);
          if (got) rows.push(...parseSessions(got.bytes.toString('utf8')));
        }
      }
      return rows;
    },
    /** Every day of the writing log (the file's rows plus what is still in memory), oldest first: [{ date, added, removed, net, minutes, sessions }]. @param {string} bookPath */
    async allDays(bookPath) {
      await flushing;
      const store = await openStore(rootOf(bookPath), { recover: false });
      const file = await store.read(LOG_PATH);
      const rows = new Map();
      for (const r of file ? parseWritingLog(file.bytes.toString('utf8')) : []) rows.set(r.date, sum(rows.get(r.date) ?? ZERO(), r));
      for (const [date, d] of pending.get(bookPath) ?? []) rows.set(date, sum(rows.get(date) ?? ZERO(), d));
      return [...rows].map(([date, r]) => ({ date, added: r.added, removed: r.removed, net: r.added - r.removed, minutes: r.minutes, sessions: r.sessions })).sort((a, b) => (a.date < b.date ? -1 : 1));
    },
    flush,
    /** Flush and stop timers (the repository is closing). */
    async close() {
      await flush();
      closed = true;
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
    },
    /**
     * Totals per day: the file's rows plus what is still in memory.
     * @param {string} bookPath
     * @param {{ days?: number }} [opts]
     * @returns {Promise<{ goal: number | null, today: object, days: object[], streak: number }>}
     */
    async read(bookPath, { days = 30 } = {}) {
      await flushing; // a flush in progress lands first, so its totals are neither missed nor counted twice
      const store = await openStore(rootOf(bookPath), { recover: false });
      const file = await store.read(LOG_PATH);
      const rows = new Map();
      for (const r of file ? parseWritingLog(file.bytes.toString('utf8')) : []) rows.set(r.date, sum(rows.get(r.date) ?? ZERO(), r));
      for (const [date, d] of pending.get(bookPath) ?? []) rows.set(date, sum(rows.get(date) ?? ZERO(), d));
      const today = localDate(clock());
      const goal = await readGoal(bookPath);
      const asDay = (date, r) => ({ date, added: r.added, removed: r.removed, net: r.added - r.removed, minutes: r.minutes, sessions: r.sessions });
      const all = [...rows].map(([date, r]) => asDay(date, r));
      const from = localDate(new Date(clock().getTime() - (Math.max(1, days) - 1) * 86_400_000));
      const shown = all.filter((d) => d.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1));
      return { goal, today: asDay(today, rows.get(today) ?? ZERO()), days: shown, streak: computeStreak(all, goal, today) };
    },
  };
}
