// Who is using the app (M07-J03a). On startup GET /api/auth/me: personal mode answers 404 (it has no accounts), and then nothing changes anywhere.
// In shared mode it says who is signed in (a user, or a read-only share link) or that nobody is, and whether the owner still has to finish setup.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** @typedef {{ mode: 'loading' | 'personal' | 'shared', user: { id: string, username: string, display_name: string, role: string } | null, share: { book: string, scope: string[] } | null, needsOwner: boolean, refresh: () => Promise<void> }} Session */

const PERSONAL = { mode: 'personal', user: null, share: null, needsOwner: false };
/** Without a provider (a part rendered alone) the app is in personal mode. @type {import('react').Context<Session>} */
const SessionContext = createContext(/** @type {Session} */ ({ ...PERSONAL, refresh: async () => {} }));

/** What GET /api/auth/me says now; `prev` is kept when the server cannot be reached. @param {any} prev */
async function readSession(prev) {
  try {
    const res = await fetch('/api/auth/me', { headers: { accept: 'application/json' } });
    if (!res.ok) return PERSONAL; // 404: personal mode
    const j = await res.json();
    if (j?.mode !== 'shared') return PERSONAL;
    return { mode: 'shared', user: j.user ?? null, share: j.share ?? null, needsOwner: Boolean(j.needs_owner) };
  } catch {
    return prev.mode === 'loading' ? PERSONAL : prev; // not reachable: keep what we knew
  }
}

export function SessionProvider({ children }) {
  const [state, setState] = useState(/** @type {any} */ ({ ...PERSONAL, mode: 'loading' }));
  const refresh = useCallback(async () => setState(await readSession(state)), [state]);
  useEffect(() => {
    let live = true;
    readSession({ mode: 'loading' }).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  const shared = state.mode === 'shared';
  useEffect(() => {
    // a session that ended while the window was in the background shows the login page when the author comes back
    if (!shared) return undefined;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [shared, refresh]);
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** @returns {Session} */
export const useSession = () => useContext(SessionContext);

/** The token in the address (`#token=...`), which a browser never sends to the server in a request; null when there is none. @param {string} [hash] */
export function tokenFromHash(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  const m = /^#token=([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1] : null;
}

/** Drop the token from the address bar once it is in memory. */
export function forgetHash() {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export const ROLE_WORDS = { owner: 'Owner', editor: 'Editor', reviewer: 'Reviewer', viewer: 'Viewer' };
