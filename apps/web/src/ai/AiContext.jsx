// The optional AI workshop inside one book page (M05-J04). Nothing AI-related is drawn, and nothing is sent anywhere, until the book has an active provider
// profile (set up under Settings). The provider tells the editor whether to show "AI workshop" and "Rewrite with AI...".
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { AiPanel } from './AiPanel.jsx';
import { aiUrl } from './requests.js';
import { RewriteDialog } from './RewriteDialog.jsx';

const AiContext = createContext(null);
const NONE = { available: false, active: null, records: false, open: false, toggle: () => {}, setScene: () => {}, startRewrite: () => {} };

/**
 * @param {{ book: any, children: import('react').ReactNode }} props
 */
export function AiProvider({ book, children }) {
  const [bump, setBump] = useState(0);
  const { data: status } = useApi(aiUrl.bookStatus(book.id), String(bump));
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState(/** @type {{ id: string, title: string, path: string } | null} */ (null));
  const [rewrite, setRewrite] = useState(/** @type {{ sceneId: string, from: number, to: number, text: string } | null} */ (null));
  const active = status?.active ?? null;
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const startRewrite = useCallback((selection) => setRewrite(selection), []);
  const value = useMemo(
    () => ({ available: active !== null, active, records: status?.records === true, open, toggle, setScene, startRewrite }),
    [active, status, open, toggle, startRewrite],
  );
  return (
    <AiContext.Provider value={value}>
      {children}
      {active && open && <AiPanel book={book} active={active} records={status?.records === true} scene={scene} onClose={() => setOpen(false)} onSettingsChanged={() => setBump((n) => n + 1)} />}
      {active && rewrite && <RewriteDialog book={book} active={active} records={status?.records === true} scene={scene} rewrite={rewrite} onClose={() => setRewrite(null)} />}
    </AiContext.Provider>
  );
}

/** @returns {typeof NONE} always safe to call; `available` is false outside a book page or when AI is off for the book */
export function useAi() {
  return useContext(AiContext) ?? NONE;
}
