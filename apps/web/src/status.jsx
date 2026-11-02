// Polls GET /api/status every 3 seconds (no websockets) and shares the latest answer with the whole app.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const POLL_MS = 3000;
const StatusContext = createContext(null);

export function StatusProvider({ children }) {
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { headers: { accept: 'application/json' } });
      if (res.ok) setStatus(await res.json());
    } catch {
      // the server is not reachable; keep the last answer
    }
  }, []);

  useEffect(() => {
    let stop = false;
    let timer;
    const tick = async () => {
      await load();
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  const value = useMemo(() => ({ status, reload: load }), [status, load]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

/** @returns {{ status: any, reload: () => Promise<void> }} status is null until the first answer. */
export function useStatus() {
  return useContext(StatusContext) ?? { status: null, reload: async () => {} };
}

/** Worst first: what needs the author's attention outranks what is merely busy. */
const ORDER = ['invalid', 'error', 'stale', 'missing', 'building', 'fresh'];

/** One state for the whole library: the worst book state. */
export function worstState(books) {
  if (!books || books.length === 0) return null;
  for (const s of ORDER) if (books.some((b) => b.index === s)) return s;
  return 'stale';
}

/** A change signature for one book: when it differs, the book's data is worth fetching again. */
export function bookVersion(status, bookId) {
  const b = status?.books?.find((x) => x.book_id === bookId);
  return b ? `${b.index}|${b.last_reconciled_at ?? ''}|${(b.invalid_paths ?? []).join(',')}` : '';
}

/** A change signature for the whole library: when it differs, the list of books is worth fetching again. */
export function libraryVersion(status) {
  return (status?.books ?? []).map((b) => `${b.book_id}|${b.last_reconciled_at ?? ''}`).join(';');
}
