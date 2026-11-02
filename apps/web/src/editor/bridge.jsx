// A small link between the open scene editor and the manuscript menus (which live elsewhere in the page):
// "Split here" asks the editor for its caret line and to save first; "Edit raw file" asks it to save first.
import { createContext, useContext, useMemo, useRef } from 'react';

/** @typedef {{ sceneId: string, caretLine: () => number | null, flush: () => Promise<{ saved: boolean }> }} EditorHandle */

const BridgeContext = createContext(null);
const NONE = { current: () => null, register: () => () => {} };

export function EditorBridgeProvider({ children }) {
  const ref = useRef(/** @type {EditorHandle | null} */ (null));
  const value = useMemo(
    () => ({
      current: () => ref.current,
      /** @param {EditorHandle} handle @returns {() => void} unregister */
      register(handle) {
        ref.current = handle;
        return () => {
          if (ref.current === handle) ref.current = null;
        };
      },
    }),
    [],
  );
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

/** @returns {{ current: () => EditorHandle | null, register: (h: EditorHandle) => () => void }} the open editor, if any (always safe to call) */
export function useEditorBridge() {
  return useContext(BridgeContext) ?? NONE;
}
