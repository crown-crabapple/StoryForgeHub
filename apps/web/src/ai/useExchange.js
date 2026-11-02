// Preview, then send, one AI request for a book: the state shared by the chat panel and the rewrite dialog.
// Nothing is sent by preview(); send() sends exactly the previewed package and, for a cloud provider, asks first (unless the author chose "don't ask again" for this book).
import { useCallback, useState } from 'react';
import { cloudRemembered } from './model.js';
import { aiRequest, aiUrl, problemText } from './requests.js';

/** @param {string} bookId */
export function useExchange(bookId) {
  const [pkg, setPkg] = useState(/** @type {any} */ (null));
  const [result, setResult] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [pendingCloud, setPendingCloud] = useState(false);

  /** Forget the preview and any answer (the instruction or the files changed). */
  const reset = useCallback(() => {
    setPkg(null);
    setResult(null);
    setError(null);
    setPendingCloud(false);
  }, []);

  /** @param {Record<string, unknown>} body the context request: { task, files, selection?, instruction } */
  const preview = useCallback(
    async (body) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const r = await aiRequest('POST', aiUrl.context(bookId), body);
        if (r.status === 200) {
          setPkg(r.json);
          return r.json;
        }
        setPkg(null);
        setError(problemText(r));
      } catch {
        setError('The server could not be reached.');
      } finally {
        setBusy(false);
      }
      return null;
    },
    [bookId],
  );

  const doSend = useCallback(
    async (current, confirmCloud, includeContext) => {
      setBusy(true);
      setError(null);
      try {
        const r = await aiRequest('POST', aiUrl.send(bookId), { contextId: current.contextId, ...(confirmCloud ? { confirmCloud: true } : {}), ...(includeContext ? { includeContext: true } : {}) });
        if (r.status === 200) {
          setResult(r.json);
          return r.json;
        }
        setError(problemText(r));
      } catch {
        setError('The server could not be reached.');
      } finally {
        setBusy(false);
      }
      return null;
    },
    [bookId],
  );

  /** @param {{ includeContext?: boolean }} [options] */
  const send = useCallback(
    async ({ includeContext = false } = {}) => {
      if (!pkg) return null;
      if (pkg.provider.locality === 'cloud' && !cloudRemembered(bookId)) {
        setPendingCloud(true);
        return null;
      }
      return doSend(pkg, pkg.provider.locality === 'cloud', includeContext);
    },
    [pkg, bookId, doSend],
  );

  /** The author said yes to the cloud dialog. @param {{ includeContext?: boolean }} [options] */
  const confirmCloud = useCallback(
    async ({ includeContext = false } = {}) => {
      setPendingCloud(false);
      return pkg ? doSend(pkg, true, includeContext) : null;
    },
    [pkg, doSend],
  );
  const cancelCloud = useCallback(() => setPendingCloud(false), []);

  return { pkg, result, busy, error, setError, pendingCloud, preview, send, confirmCloud, cancelCloud, reset };
}
