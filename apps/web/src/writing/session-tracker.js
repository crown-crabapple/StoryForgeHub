// A writing session as the author sees it: it starts at the first edit and ends after 10 minutes without edits, on leaving the
// book or when the page is hidden. Pure: the clock and timers are injected, so it runs under node --test.

export const IDLE_MS = 10 * 60_000;

/**
 * @param {{ report: (minutes: number) => void, now?: () => number,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void }, idleMs?: number,
 *   onChange?: (s: { active: boolean, net: number }) => void }} options  `report(minutes)` runs once per finished session (minutes >= 1).
 */
export function createSessionTracker({ report, now = () => Date.now(), timers, idleMs = IDLE_MS, onChange }) {
  const t = timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let startedAt = null;
  let lastEditAt = 0;
  let timer = null;
  let net = 0;
  const emit = () => onChange?.({ active: startedAt !== null, net });

  function end() {
    if (startedAt === null) return null;
    if (timer !== null) t.clearTimeout(timer);
    timer = null;
    const minutes = Math.max(1, Math.round((lastEditAt - startedAt) / 60_000));
    startedAt = null;
    report(minutes);
    emit();
    return minutes;
  }

  return {
    /** The author changed the text. The first edit starts a session; every edit restarts the 10-minute idle timer. */
    edit() {
      const at = now();
      if (startedAt === null) {
        startedAt = at;
        net = 0;
      }
      lastEditAt = at;
      if (timer !== null) t.clearTimeout(timer);
      timer = t.setTimeout(() => {
        timer = null;
        end();
      }, idleMs);
      emit();
    },
    /** A save reported these words: they count towards "This session". */
    words({ added, removed }) {
      net += (added || 0) - (removed || 0);
      emit();
    },
    /** The session ends now (leaving the book, page hidden). Returns the minutes reported, or null if no session was running. */
    end,
    /** Stop timers without reporting. */
    dispose() {
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
      startedAt = null;
    },
    snapshot: () => ({ active: startedAt !== null, net, startedAt }),
  };
}
