import { useEffect, useRef, useState } from 'react';
import { useEditorBridge } from '../editor/bridge.jsx';
import { Toast } from '../continuity/useContinuityActions.jsx';
import { sendRequest } from '../continuity/requests.js';
import { useWrites } from '../shell/writes.jsx';
import { decideRequest, explainSuggestionFailure } from './model.js';

const TOAST_MS = 12000;

/**
 * Accept / decline of suggestions (M05-J06). Accept writes only the accepted lines of the target; decline writes only the suggestion file. After an accept a toast offers Undo
 * (the server's restore of that one operation: both files come back byte for byte). `onChanged` runs after every write and undo so lists load again.
 * Returns `{ decide, busy, error, clearError, stamp, ui }`: `decide(suggestionId, 'accept' | 'decline', hunkId?)` resolves true when it was applied; `stamp` changes after each write
 * (use it as a refresh key); render `ui` once.
 * @param {{ bookId: string, onChanged?: () => void }} p
 */
export function useSuggestionActions({ bookId, onChanged }) {
  const { track } = useWrites();
  const bridge = useEditorBridge();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [toast, setToast] = useState(/** @type {{ message: string, undo?: { opId: string } | null } | null} */ (null));
  const [stamp, setStamp] = useState(0);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const showToast = (next) => {
    clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  };
  const write = (r) => track(bookId, () => sendRequest(r));
  const afterWrite = async () => {
    setStamp((n) => n + 1);
    onChanged?.();
    await bridge.current()?.reload?.(); // an accepted hunk changed the open scene on disk
  };

  async function decide(suggestionId, decision, hunkId) {
    setBusy(true);
    setError(null);
    const { status, json } = await write(decideRequest(bookId, suggestionId, decision, hunkId));
    setBusy(false);
    if (status === 200) {
      const what = hunkId ? 'the change' : 'all changes';
      showToast({ message: decision === 'accept' ? `Accepted ${what}. Only those lines of the text changed.` : `Declined ${what}. Your text was not touched.`, undo: decision === 'accept' && json?.opId ? { opId: json.opId } : null });
      await afterWrite();
      return true;
    }
    setError(explainSuggestionFailure(status, json));
    if (status === 404 || status === 409) setStamp((n) => n + 1);
    return false;
  }

  async function undo() {
    const u = toast?.undo;
    if (!u) return;
    setToast(null);
    const { status, json } = await write({ method: 'POST', url: `/api/books/${encodeURIComponent(bookId)}/ops/${encodeURIComponent(u.opId)}/restore`, body: {} });
    if (status === 200) {
      showToast({ message: 'Undone. The text and the suggestion are exactly as before.' });
      await afterWrite();
    } else {
      showToast({ message: `Could not undo: ${json?.message ?? 'a file changed since'}.` });
    }
  }

  const ui = toast ? <Toast toast={toast} onUndo={undo} onDismiss={() => setToast(null)} /> : null;
  return { decide, busy, error, clearError: () => setError(null), stamp, ui };
}
