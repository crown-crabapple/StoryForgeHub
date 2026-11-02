// Tracks writes made from this browser (archive, repair apply) so the save indicator tells the truth.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { NO_WRITES, writeFinished, writeStarted } from './save-state.js';

const WritesContext = createContext(null);

export function WritesProvider({ children }) {
  const [writes, setWrites] = useState(NO_WRITES);
  const [editor, setEditor] = useState(null);
  const track = useCallback(async (bookId, run) => {
    setWrites(writeStarted);
    let status = null;
    try {
      const result = await run();
      status = result?.status ?? null;
      return result;
    } finally {
      setWrites((s) => writeFinished(s, bookId, status, new Date().toISOString()));
    }
  }, []);
  const value = useMemo(() => ({ writes, track, editor, setEditor }), [writes, track, editor]);
  return <WritesContext.Provider value={value}>{children}</WritesContext.Provider>;
}

/**
 * @returns {{ writes: import('./save-state.js').WriteState, track: (bookId: string | null, run: () => Promise<{ status: number }>) => Promise<any>,
 *   editor: import('./save-state.js').EditorSave | null, setEditor: (e: import('./save-state.js').EditorSave | null) => void }}
 * `editor` is what the open scene editor reports about its own saving (null when none is open).
 * Without a provider (tests) writes are empty and track just runs the call.
 */
export function useWrites() {
  return useContext(WritesContext) ?? { writes: NO_WRITES, track: (_bookId, run) => run(), editor: null, setEditor: () => {} };
}
