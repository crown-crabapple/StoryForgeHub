// A small link between the open scene editor and the manuscript menus (which live elsewhere in the page):
// "Split here" asks the editor for its caret line and to save first; "Edit raw file" asks it to save first.
import { createContext, useContext, useMemo, useRef } from 'react';

/**
 * @typedef {{ sceneId: string, caretLine: () => number | null, flush: () => Promise<{ saved: boolean }>, isConflict?: () => boolean,
 *   jumpToLine?: (line: number) => void, baseSha?: () => string | null, text?: () => string, selection?: () => { from: number, to: number, text: string } | null,
 *   reload?: () => Promise<{ action: string }>, setContinuityMarks?: (marks: any[]) => void,
 *   selectRange?: (line: number, from: number, to: number) => void,
 *   grammar?: { snapshot: () => { state: string, reason: string | null, findings: any[], checkedAt: string | null } | null, subscribe: (fn: () => void) => () => void },
 *   applyFinding?: (id: string, index: number) => { ok: boolean, code?: string }, selectBodyRange?: (from: number, to: number) => void,
 *   checkNow?: () => void, ignoreFinding?: (id: string) => void, reloadGrammarSettings?: () => void }} EditorHandle
 *   `jumpToLine` moves the caret to a 1-based line and focuses the editor; `baseSha` / `text` are the file hash and text the editor last saved
 *   or loaded / its current text; `reload` re-reads the file after something else changed it (a restored revision).
 * `setContinuityMarks(marks)` draws the dotted underline of the continuity findings (decoration only; the text is never changed); `selectRange(line, from, to)` selects columns
 * from..to of a 1-based line and scrolls there (M05-J02).
 * Grammar checks (M13-J02): `grammar.snapshot()` is the controller's `{ state, reason, findings, checkedAt }` (the same object until it changes), or null while checks are off for the book;
 * `grammar.subscribe(fn)` calls `fn()` when that changes, including when checks are turned on or off. `applyFinding(id, index)` applies a replacement as an ordinary author edit,
 * `selectBodyRange(from, to)` selects text by offsets in the editor text, `checkNow()` runs a check at once, `ignoreFinding(id)` hides one occurrence for the session, and
 * `reloadGrammarSettings()` reads the book's checks settings again and reconfigures the checker (after the dictionary or a rule changed).
 */

const BridgeContext = createContext(null);
const NONE = { current: () => null, register: () => () => {}, setContinuityMarks: () => {}, subscribe: () => () => {} };

export function EditorBridgeProvider({ children }) {
  const ref = useRef(/** @type {EditorHandle | null} */ (null));
  const marks = useRef(/** @type {{ sceneId: string, marks: any[] } | null} */ (null));
  const listeners = useRef(new Set());
  const value = useMemo(
    () => ({
      current: () => ref.current,
      /** `fn()` runs whenever an editor registers or unregisters. @param {() => void} fn @returns {() => void} unsubscribe */
      subscribe(fn) {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      /** The continuity marks of a scene: drawn now if that scene is open, and when it opens later. @param {string} sceneId @param {any[]} list */
      setContinuityMarks(sceneId, list) {
        marks.current = { sceneId, marks: list };
        if (ref.current?.sceneId === sceneId) ref.current.setContinuityMarks?.(list);
      },
      /** @param {EditorHandle} handle @returns {() => void} unregister */
      register(handle) {
        ref.current = handle;
        if (marks.current && marks.current.sceneId === handle.sceneId) handle.setContinuityMarks?.(marks.current.marks);
        for (const fn of [...listeners.current]) fn();
        return () => {
          if (ref.current === handle) {
            ref.current = null;
            for (const fn of [...listeners.current]) fn();
          }
        };
      },
    }),
    [],
  );
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

/** @returns {{ current: () => EditorHandle | null, register: (h: EditorHandle) => () => void, subscribe: (fn: () => void) => () => void, setContinuityMarks: (sceneId: string, marks: any[]) => void }} the open editor, if any (always safe to call) */
export function useEditorBridge() {
  return useContext(BridgeContext) ?? NONE;
}
