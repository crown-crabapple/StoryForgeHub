// The offline bar of shared mode (M08-J04 contract section 3): "Offline: 2 scenes waiting to save" while the browser holds unsent saves, and the sending of them when the
// server can be reached again. It only ever sends through the normal save route (see editor/offline-queue.js); personal mode has no queue and draws nothing.
import { useCallback, useEffect, useState } from 'react';
import { getOfflineQueue, queueLabel } from '../editor/offline-queue.js';
import { Link } from '../router.jsx';
import { useSession } from './session.jsx';

const RETRY_MS = 20_000;

/** What a drain left to tell the author. @param {import('../editor/offline-queue.js').DrainResult[]} results */
export function summarise(results) {
  const saved = results.filter((r) => r.outcome === 'saved').length;
  const stale = results.filter((r) => r.outcome === 'stale');
  return { saved, stale };
}

/**
 * The bar itself. The wrapper is always a polite live region, so a change of the count is read out.
 * @param {{ count: number, notice?: { saved: number, stale: { bookId: string, sceneId: string, kept?: boolean }[] } | null, onDismiss?: () => void }} props
 */
export function OfflineBarView({ count, notice = null, onDismiss }) {
  const showNotice = notice !== null && (notice.saved > 0 || notice.stale.length > 0);
  return (
    <div className="offline-bar" role="status" aria-live="polite" aria-atomic="true" data-testid="offline-bar">
      {count > 0 && (
        <p className="banner banner-warning offline-count" data-testid="offline-count">
          {queueLabel(count)}
        </p>
      )}
      {showNotice && (
        <div className="banner offline-notice">
          {notice.saved > 0 && <p>{notice.saved === 1 ? 'One scene that was waiting is saved.' : `${notice.saved} scenes that were waiting are saved.`}</p>}
          {notice.stale.length > 0 && (
            <>
              <p>
                {notice.stale.length === 1 ? 'A scene was changed by someone else while you were offline.' : `${notice.stale.length} scenes were changed by someone else while you were offline.`} Your text was not lost: it is kept as a suggestion to review.
              </p>
              <ul>
                {notice.stale.map((r) => (
                  <li key={`${r.bookId}/${r.sceneId}`}>
                    <Link to={`/books/${encodeURIComponent(r.bookId)}?scene=${encodeURIComponent(r.sceneId)}`}>Open the scene to compare</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Connected: counts the queue, and drains it on start, when the browser says it is back online, and every 20 seconds while anything waits. Shared mode only. */
export function OfflineQueueBar() {
  const session = useSession();
  const shared = session.mode === 'shared' && session.user !== null;
  const [count, setCount] = useState(0);
  const [notice, setNotice] = useState(/** @type {any} */ (null));

  const drain = useCallback(async () => {
    const queue = getOfflineQueue();
    const results = await queue.drain();
    const { saved, stale } = summarise(results);
    if (saved > 0 || stale.length > 0) setNotice((prev) => ({ saved: (prev?.saved ?? 0) + saved, stale: [...(prev?.stale ?? []), ...stale] }));
  }, []);

  useEffect(() => {
    if (!shared) return undefined;
    const queue = getOfflineQueue();
    let live = true;
    const unsubscribe = queue.subscribe((n) => live && setCount(n));
    void queue.count().then((n) => live && setCount(n));
    const first = setTimeout(() => void drain(), 0);
    const onOnline = () => void drain();
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => {
      void queue.count().then((n) => n > 0 && drain());
    }, RETRY_MS);
    return () => {
      live = false;
      clearTimeout(first);
      unsubscribe();
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [shared, drain]);

  if (!shared) return null;
  return <OfflineBarView count={count} notice={notice} onDismiss={() => setNotice(null)} />;
}
