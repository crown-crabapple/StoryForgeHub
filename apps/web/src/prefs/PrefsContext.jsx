// Preferences for the whole app (M07-J04): the resolved appearance, the modules, the profile in use. The server resolves the layers (built-in, library, book, profile) and
// answers GET /api/preferences; this provider fetches it, turns it into CSS variables (one <style> element, so the first server render and the browser agree) and
// offers `save` for the profile. A profile is stored per machine and never touches a book.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { postJson, putJson, useApi } from '../api.js';
import { useLocation } from '../router.jsx';
import { parseRoute } from '../routes.js';
import { bindingsFor } from '../shortcuts/registry.js';
import { DEFAULT_TYPOGRAPHY, cssText, cssVariables, effectiveLayout, schemeOf } from './appearance.js';

/** The modules, in the order Settings lists them (the same ids as @storyforge/format MODULE_IDS; a test compares them). */
export const MODULES = [
  { id: 'ai', label: 'AI', note: 'Rewrites and chat with a model you set up. Off: the AI transport is never called.' },
  { id: 'continuity', label: 'Continuity', note: 'The Continuity page and the continuity section of the right rail.' },
  { id: 'receipts', label: 'Receipts', note: 'The provenance ledger. Off: no new receipts, and the chain gets a gap.' },
  { id: 'suggestions', label: 'Suggestions', note: 'Proposed changes you accept or decline, in the right rail.' },
  { id: 'timeline', label: 'Timeline', note: 'The Timeline page and the events section of the right rail.' },
  { id: 'board', label: 'Board', note: 'The Board view in planning.' },
  { id: 'threads', label: 'Threads', note: 'Plot threads and their marks.' },
  { id: 'insights', label: 'Insights', note: 'The Insights page.' },
  { id: 'tasks', label: 'Tasks', note: 'The Tasks page.' },
  { id: 'research', label: 'Research', note: 'The Notes page and the research section of the right rail.' },
];

/** What the app looks like before the server has answered (and when it cannot): the reference look, every module on. */
export const DEFAULT_EFFECTIVE = Object.freeze({
  theme: 'dark',
  typography: DEFAULT_TYPOGRAPHY,
  layout: { name: 'Writing' },
  shortcuts: {},
  modules: Object.fromEntries(MODULES.map((m) => [m.id, true])),
  labels: {},
  export: {},
});

const PrefsContext = createContext(null);
const NO_ENTRIES = Object.freeze({});

/** @param {string | null} bookId */
const urlFor = (bookId) => `/api/preferences${bookId ? `?book=${encodeURIComponent(bookId)}` : ''}`;

/**
 * @param {{ children: import('react').ReactNode, bookId?: string | null, initial?: any }} props
 *   `initial`: a GET /api/preferences answer to start from (no request is made; used for the first render and in tests).
 */
export function PrefsProvider({ children, bookId = null, initial = null }) {
  const [rev, setRev] = useState(0);
  const [live, setLive] = useState(/** @type {ReturnType<typeof effectiveLayout> | null} */ (null));
  const fetched = useApi(initial ? null : urlFor(bookId), String(rev));
  // a book the server does not know (404) still gets the library and profile layers
  const fallback = useApi(!initial && fetched.data === null && !fetched.loading && bookId ? urlFor(null) : null, String(rev));
  const data = initial ?? fetched.data ?? fallback.data;

  const effective = data?.effective ?? DEFAULT_EFFECTIVE;
  const customThemes = data?.profile?.customThemes ?? NO_ENTRIES;
  const layouts = data?.profile?.layouts ?? NO_ENTRIES;
  const layout = useMemo(() => live ?? effectiveLayout(effective.layout, layouts), [live, effective, layouts]);
  const vars = useMemo(() => cssVariables(effective, { customThemes, layouts, layoutOverride: live }), [effective, customThemes, layouts, live]);
  const css = cssText(vars, schemeOf(effective, customThemes));
  const bindings = useMemo(() => bindingsFor(effective.shortcuts), [effective.shortcuts]);

  const reload = useCallback(() => setRev((n) => n + 1), []);
  /** Save part of the profile (a key set to null is removed). @param {Record<string, unknown>} patch @returns {Promise<{ ok: boolean, message?: string }>} */
  const save = useCallback(
    async (patch) => {
      const r = await putJson('/api/profile', patch);
      setLive(null);
      reload();
      return r.status === 200 ? { ok: true } : { ok: false, message: r.json?.message ?? `Not saved (${r.status}).` };
    },
    [reload],
  );
  /** @param {string} name @param {boolean} [create] */
  const switchProfile = useCallback(
    async (name, create = false) => {
      const r = await postJson('/api/profile/switch', { name, create });
      reload();
      return r.status === 200 ? { ok: true } : { ok: false, message: r.json?.message ?? `Could not switch (${r.status}).` };
    },
    [reload],
  );

  const profileLayout = data?.layers?.profile?.layout ?? NO_ENTRIES;
  const value = useMemo(
    () => ({
      loaded: data !== null,
      data,
      effective,
      sources: data?.sources ?? {},
      layers: data?.layers ?? { library: null, book: null, profile: {} },
      order: data?.order ?? null,
      warnings: data?.warnings ?? [],
      profile: { name: data?.profile?.name ?? 'default', names: data?.profile?.names ?? ['default'], customThemes, layouts },
      modules: data?.modules ?? {},
      /** Is this module on? (Everything is on until the server has answered.) @param {string} id */
      moduleOn: (id) => data?.modules?.[id]?.on !== false,
      bindings,
      layout,
      save,
      switchProfile,
      reload,
      /** Switch to a named layout. The page is not reloaded and no editor loses its text: only these variables change. @param {string} name */
      setLayout: (name) => save({ layout: { name } }),
      /** Drag or key a panel to a width; `commit` saves it to the profile. @param {'rail' | 'inspector'} which @param {number} width @param {boolean} commit */
      resizePanel(which, width, commit) {
        const next = effectiveLayout({ ...effective.layout, ...profileLayout, name: layout.name, rail: { ...layout.rail }, inspector: { ...layout.inspector }, [which]: { ...layout[which], width } }, layouts);
        setLive(commit ? null : next);
        if (commit) void save({ layout: { ...profileLayout, name: next.name, [which]: { ...(profileLayout[which] ?? {}), width: next[which].width } } });
      },
      /** @param {'rail' | 'inspector'} which @param {boolean} shown */
      setPanelShown: (which, shown) => save({ layout: { ...profileLayout, name: layout.name, [which]: { ...(profileLayout[which] ?? {}), shown } } }),
      /** Keep the layout as it is now under a new name. @param {string} name */
      saveLayoutAs: (name) => save({ layouts: { ...layouts, [name]: { rail: layout.rail, inspector: layout.inspector, pinned: layout.pinned } }, layout: { name } }),
    }),
    [data, effective, layout, bindings, layouts, customThemes, save, switchProfile, reload, profileLayout],
  );

  return (
    <PrefsContext.Provider value={value}>
      <style id="sf-prefs" data-profile={value.profile.name}>
        {css}
      </style>
      {children}
    </PrefsContext.Provider>
  );
}

/** The preferences provider the app uses: it follows the address bar to know which book's project layers apply. */
export function RoutedPrefsProvider({ children }) {
  const { pathname, search } = useLocation();
  const route = parseRoute(pathname, search);
  return <PrefsProvider bookId={route.name === 'book' || route.name === 'tab' ? route.bookId : null}>{children}</PrefsProvider>;
}

const FALLBACK = {
  loaded: false,
  data: null,
  effective: DEFAULT_EFFECTIVE,
  sources: {},
  layers: { library: null, book: null, profile: {} },
  order: null,
  warnings: [],
  profile: { name: 'default', names: ['default'], customThemes: {}, layouts: {} },
  modules: {},
  moduleOn: () => true,
  bindings: bindingsFor({}),
  layout: effectiveLayout({ name: 'Writing' }, {}),
  save: async () => ({ ok: false, message: 'Preferences are not available here.' }),
  switchProfile: async () => ({ ok: false, message: 'Preferences are not available here.' }),
  reload: () => {},
  setLayout: async () => ({ ok: false }),
  resizePanel: () => {},
  setPanelShown: async () => ({ ok: false }),
  saveLayoutAs: async () => ({ ok: false }),
};

/** @returns {typeof FALLBACK} the preferences (the reference look and every module on when there is no provider) */
export function usePrefs() {
  return useContext(PrefsContext) ?? FALLBACK;
}

/** Is a module on? @param {string} id */
export function useModule(id) {
  return usePrefs().moduleOn(id);
}
