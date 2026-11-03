import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { postJson } from '../api.js';
import { useLocation } from '../router.jsx';
import { parseRoute } from '../routes.js';
import { announceText, createTimers } from './timers.js';

const TimersContext = createContext(null);

const IDLE = { timer: null, start: () => false, pause: () => {}, resume: () => {}, finishNow: () => Promise.resolve(null), abandon: () => {} };

const clock = () => Date.now();

/** The real clock, the real interval, the shared live region and the session route. */
function makeTimers() {
  return createTimers({
    clock,
    schedule: (fn, ms) => window.setInterval(fn, ms),
    unschedule: (id) => window.clearInterval(id),
    announce: (text) => announceText(text),
    report: async (row, t) => {
      const r = await postJson(`/api/books/${encodeURIComponent(t.bookId)}/activity/session`, row);
      return r.status === 200 ? (r.json?.row ?? null) : null;
    },
  });
}

/**
 * The one sprint or timer of this browser tab, kept above the pages so it goes on running while the author moves between them. Its minute announcements go to the shared polite
 * live region; finishing reports one row to POST /api/books/:b/activity/session; abandoning reports nothing. The scenes opened while it runs go in the row.
 */
export function TimerProvider({ children }) {
  const [ctl] = useState(() => (typeof window === 'undefined' ? null : makeTimers()));
  const [timer, setTimer] = useState(null);
  useEffect(() => ctl?.subscribe(setTimer), [ctl]);
  const { pathname, search } = useLocation();
  const route = parseRoute(pathname, search);
  const sceneId = route.name === 'book' && route.bookId === timer?.bookId ? route.sceneId : null;
  useEffect(() => {
    if (sceneId) ctl?.noteScene(sceneId);
  }, [ctl, sceneId, timer?.bookId]);
  const value = useMemo(
    () => ({
      timer,
      start: (p) => ctl?.start(p) ?? false,
      pause: () => ctl?.pause(),
      resume: () => ctl?.resume(),
      finishNow: () => ctl?.finishNow() ?? Promise.resolve(null),
      abandon: () => ctl?.abandon(),
    }),
    [ctl, timer],
  );
  return <TimersContext.Provider value={value}>{children}</TimersContext.Provider>;
}

/** The running timer (or null) and the controls. Without a provider (tests) nothing runs. */
export function useTimers() {
  return useContext(TimersContext) ?? IDLE;
}
