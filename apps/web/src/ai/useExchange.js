// Preview, then send, one AI request for a book: the state shared by the chat panel and the rewrite dialog.
// Nothing is sent by preview(); send() sends exactly the previewed package and, for a cloud provider, asks first (unless the author chose "don't ask again" for this book).
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudRemembered } from './model.js';
import { aiGet, aiRequest, aiUrl, problemText } from './requests.js';

const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} bookId */
export function useExchange(bookId) {
  const [pkg, setPkg] = useState(/** @type {any} */ (null));
  const [result, setResult] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [pendingCloud, setPendingCloud] = useState(false);
  // M08-J03: the reply streams in. `streamText` is what has arrived so far: it is shown, never applied; Cancel throws it away.
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const live = useRef(true);
  const cancelled = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Forget the preview and any answer (the instruction or the files changed). */
  const reset = useCallback(() => {
    setPkg(null);
    setResult(null);
    setError(null);
    setPendingCloud(false);
    setStreamText('');
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
      setStreamText('');
      cancelled.current = false;
      try {
        const r = await aiRequest('POST', aiUrl.send(bookId), { contextId: current.contextId, stream: true, ...(confirmCloud ? { confirmCloud: true } : {}), ...(includeContext ? { includeContext: true } : {}) });
        if (r.status === 200) {
          setResult(r.json);
          return r.json;
        }
        if (r.status !== 202) {
          setError(problemText(r));
          return null;
        }
        // streaming: read what has arrived until the server says it is finished, failed or cancelled
        setStreaming(true);
        let from = 0;
        while (live.current && !cancelled.current) {
          await sleep(POLL_MS);
          const p = await aiGet(aiUrl.stream(bookId, current.contextId, from));
          if (cancelled.current || !live.current) break;
          if (p.status !== 200) {
            setError(problemText(p));
            break;
          }
          from = p.json.length;
          if (p.json.text) setStreamText((t) => t + p.json.text);
          if (p.json.state === 'done') {
            setResult(p.json.result);
            return p.json.result;
          }
          if (p.json.state === 'error') {
            setError(p.json.error?.message ?? 'The provider stopped before the reply was complete. Nothing was kept.');
            break;
          }
          if (p.json.state === 'cancelled') break;
        }
      } catch {
        setError('The server could not be reached.');
      } finally {
        setStreaming(false);
        setStreamText('');
        setBusy(false);
      }
      return null;
    },
    [bookId],
  );

  /** Stop a reply that is still arriving. What arrived is thrown away; nothing is applied, suggested or saved. */
  const cancel = useCallback(async () => {
    const id = pkg?.contextId;
    cancelled.current = true;
    setStreaming(false);
    setStreamText('');
    setBusy(false);
    if (id) await aiRequest('POST', aiUrl.cancel(bookId), { contextId: id }).catch(() => {});
  }, [bookId, pkg]);

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

  return { pkg, result, busy, error, setError, pendingCloud, streaming, streamText, cancel, preview, send, confirmCloud, cancelCloud, reset };
}
