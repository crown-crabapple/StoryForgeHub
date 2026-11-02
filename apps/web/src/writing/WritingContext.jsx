// What the right rail and the editor share while a book is open: today's writing totals (goal card), the writing session, and
// the live text of the open scene. Without a provider (tests, other pages) everything is inert.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { postJson } from '../api.js';
import { applyWords } from './goal.js';
import { createSessionTracker } from './session-tracker.js';

const WritingContext = createContext(null);
const NONE = {
  bookId: null,
  activity: null,
  session: { active: false, net: 0 },
  liveBody: null,
  revisionTick: 0,
  reportEdit: () => {},
  applySaved: () => {},
  setLiveBody: () => {},
  bumpRevisions: () => {},
  refresh: () => {},
  setGoal: async () => ({ ok: false, message: 'No book is open.' }),
};

export const ACTIVITY_REFRESH_MS = 60_000;

const bookUrl = (bookId, tail) => `/api/books/${encodeURIComponent(bookId)}${tail}`;

export function WritingProvider({ bookId, children }) {
  const [activity, setActivity] = useState(null);
  const [session, setSession] = useState({ active: false, net: 0 });
  const [liveBody, setLiveBody] = useState(null);
  const [revisionTick, setRevisionTick] = useState(0);
  const tracker = useRef(null);

  /** The server's totals, or null (the card keeps what it has; the next refresh tries again). */
  const load = useCallback(async () => {
    try {
      const res = await fetch(bookUrl(bookId, '/activity?days=30'), { headers: { accept: 'application/json' } });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }, [bookId]);
  const refresh = useCallback(async () => {
    const a = await load();
    if (a) setActivity(a);
  }, [load]);

  useEffect(() => {
    let live = true;
    const pull = () =>
      load().then((a) => {
        if (live && a) setActivity(a);
      });
    void pull();
    const id = setInterval(pull, ACTIVITY_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  useEffect(() => {
    // the page may be closing: keepalive lets the request finish
    const report = (minutes) => {
      fetch(bookUrl(bookId, '/activity/session'), {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
        body: JSON.stringify({ minutes }),
      })
        .then(() => refresh())
        .catch(() => {});
    };
    const t = createSessionTracker({ report, onChange: setSession });
    tracker.current = t;
    const onHide = () => {
      if (document.visibilityState === 'hidden') t.end();
    };
    const onPageHide = () => t.end();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      t.end();
      t.dispose();
      tracker.current = null;
    };
  }, [bookId, refresh]);

  const value = useMemo(
    () => ({
      bookId,
      activity,
      session,
      liveBody,
      revisionTick,
      reportEdit: () => tracker.current?.edit(),
      applySaved(words) {
        if (!words) return;
        tracker.current?.words(words);
        setActivity((a) => (a ? applyWords(a, words) : a));
      },
      setLiveBody,
      bumpRevisions: () => setRevisionTick((n) => n + 1),
      refresh,
      async setGoal(n) {
        try {
          const { status, json } = await postJson(bookUrl(bookId, '/goal'), { daily_word_goal: n });
          if (status === 200) {
            await refresh();
            return { ok: true };
          }
          return { ok: false, message: json?.message ?? `The goal was not saved (${json?.code ?? status}).` };
        } catch {
          return { ok: false, message: 'The server could not be reached.' };
        }
      },
    }),
    [bookId, activity, session, liveBody, revisionTick, refresh],
  );
  return <WritingContext.Provider value={value}>{children}</WritingContext.Provider>;
}

/** @returns {typeof NONE} */
export function useWriting() {
  return useContext(WritingContext) ?? NONE;
}
