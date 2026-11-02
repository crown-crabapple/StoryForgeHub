// What the save indicator says, derived from real state only. Pure, so every state is testable.

/**
 * @typedef {{ inflight: number, conflictBook: string | null, lastWriteAt: string | null }} WriteState
 * @typedef {{ kind: 'readonly' | 'saving' | 'conflict' | 'saved' | 'checking' | 'dirty' | 'offline' | 'changed-outside' | 'error', at: string | null }} SaveView
 * @typedef {{ bookId: string, state: 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'offline' | 'error', savedAt: string | null }} EditorSave  what the open scene editor reports (M03-J02)
 */

/** @type {WriteState} */
export const NO_WRITES = { inflight: 0, conflictBook: null, lastWriteAt: null };

/** A write starts. @param {WriteState} s @returns {WriteState} */
export function writeStarted(s) {
  return { ...s, inflight: s.inflight + 1 };
}

/**
 * A write finished with an HTTP status (null = it never got an answer). 2xx = saved; 409 = the file changed
 * outside; anything else leaves the indicator as it was.
 * @param {WriteState} s @param {string | null} bookId @param {number | null} status @param {string} now ISO time
 * @returns {WriteState}
 */
export function writeFinished(s, bookId, status, now) {
  const next = { ...s, inflight: Math.max(0, s.inflight - 1) };
  if (status !== null && status >= 200 && status < 300) {
    next.lastWriteAt = now;
    if (next.conflictBook === bookId) next.conflictBook = null;
  } else if (status === 409) {
    next.conflictBook = bookId;
  }
  return next;
}

/**
 * @param {{ bookId: string | null, writes: WriteState, lastReconciledAt: string | null, editor?: EditorSave | null }} input
 *   `editor`: the open scene's save state. Its dirty / saving / offline / conflict / error states outrank everything else.
 * @returns {SaveView}
 */
export function deriveSave({ bookId, writes, lastReconciledAt, editor = null }) {
  if (!bookId) return { kind: 'readonly', at: null };
  const own = editor && editor.bookId === bookId ? editor : null;
  if (own) {
    if (own.state === 'conflict') return { kind: 'changed-outside', at: null };
    if (own.state === 'offline') return { kind: 'offline', at: null };
    if (own.state === 'error') return { kind: 'error', at: null };
    if (own.state === 'saving') return { kind: 'saving', at: null };
    if (own.state === 'dirty') return { kind: 'dirty', at: null };
  }
  if (writes.inflight > 0) return { kind: 'saving', at: null };
  if (writes.conflictBook === bookId) return { kind: 'conflict', at: null };
  const times = [writes.lastWriteAt, lastReconciledAt, own?.savedAt ?? null].filter(Boolean);
  if (times.length === 0) return { kind: 'checking', at: null };
  const at = times.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));
  return { kind: 'saved', at };
}
