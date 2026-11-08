// Which page a URL shows. Pure, so it can be tested without a browser.

/** The project tabs, in order. `path` is appended to /books/:id. */
export const PROJECT_TABS = [
  { key: 'manuscript', label: 'Manuscript', path: '' },
  { key: 'plan', label: 'Plan', path: '/plan' },
  { key: 'codex', label: 'Codex', path: '/codex' },
  { key: 'timeline', label: 'Timeline', path: '/timeline' },
  { key: 'continuity', label: 'Continuity', path: '/continuity' },
  { key: 'places', label: 'Places', path: '/places' },
  { key: 'notes', label: 'Notes', path: '/notes' },
];

/** Further project pages (M07-J02), shown after the tabs above: the Insights dashboard and the revision Tasks, and the AI Workspace (M12, gated by the `workspace` module). */
export const MORE_TABS = [
  { key: 'insights', label: 'Insights', path: '/insights' },
  { key: 'tasks', label: 'Tasks', path: '/tasks' },
  { key: 'workspace', label: 'AI Workspace', path: '/workspace' },
];

/** The module a project tab belongs to (M07-J04): with the module off the tab disappears. `insights` and `tasks` are J02's pages, gated by id so they follow once they exist. */
const TAB_MODULES = { plan: 'planner', timeline: 'timeline', continuity: 'continuity', notes: 'research', insights: 'insights', tasks: 'tasks', workspace: 'workspace' };
/** @param {string} tab a PROJECT_TABS key @returns {string | null} */
export const tabModule = (tab) => TAB_MODULES[tab] ?? null;

/** Tabs that stay while any one of several modules is on: the Plan tab is the canvas page, so the planner or the board module keeps it (M10). */
const TAB_ANY_MODULES = { plan: ['planner', 'board'] };
/**
 * Is the tab shown? A tab with no module always is; a tab with several modules when any is on; otherwise when its one module is on.
 * @param {string} tab a PROJECT_TABS key @param {(id: string) => boolean} moduleOn
 */
export function tabVisible(tab, moduleOn) {
  const any = TAB_ANY_MODULES[tab];
  if (any) return any.some((id) => moduleOn(id));
  const id = tabModule(tab);
  return id === null || moduleOn(id);
}

/** Old addresses that now show another tab (the Canvas tab became the Plan tab): their path segment -> the tab key. */
const TAB_ALIASES = { canvas: 'plan' };

/**
 * Where an old address should be replaced by: `/books/:id/canvas?canvas=x` -> `/books/:id/plan?canvas=x` (the search is kept as it is). Null when the address is current.
 * @param {string} pathname @param {string} [search] @returns {string | null}
 */
export function redirectFor(pathname, search = '') {
  const m = /^\/books\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m || !Object.hasOwn(TAB_ALIASES, m[2])) return null;
  const t = PROJECT_TABS.find((x) => x.key === TAB_ALIASES[m[2]]);
  return `/books/${m[1]}${t ? t.path : ''}${search}`;
}

const PLACEHOLDER_TABS = [...PROJECT_TABS.filter((t) => t.path !== ''), ...MORE_TABS].map((t) => t.key);

/** @param {string} bookId @param {string} tab a PROJECT_TABS key */
export function tabHref(bookId, tab) {
  const t = [...PROJECT_TABS, ...MORE_TABS].find((x) => x.key === tab);
  return `/books/${encodeURIComponent(bookId)}${t ? t.path : ''}`;
}

/**
 * @param {string} pathname
 * @param {string} [search]
 * @returns {{ name: 'library' } | { name: 'settings' } | { name: 'members' } | { name: 'book', bookId: string, sceneId: string | null, file: string | null } | { name: 'tab', bookId: string, tab: string } | { name: 'notfound' }}
 */
export function parseRoute(pathname, search = '') {
  if (pathname === '/' || pathname === '') return { name: 'library' };
  if (pathname === '/settings' || pathname === '/settings/') return { name: 'settings' };
  if (pathname === '/settings/members' || pathname === '/settings/members/') return { name: 'members' };
  const m = /^\/books\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return { name: 'notfound' };
  let bookId;
  try {
    bookId = decodeURIComponent(m[1]);
  } catch {
    return { name: 'notfound' };
  }
  if (m[2] === undefined) {
    const params = new URLSearchParams(search);
    return { name: 'book', bookId, sceneId: params.get('scene'), file: params.get('file') };
  }
  if (PLACEHOLDER_TABS.includes(m[2])) return { name: 'tab', bookId, tab: m[2] };
  if (Object.hasOwn(TAB_ALIASES, m[2])) return { name: 'tab', bookId, tab: TAB_ALIASES[m[2]] }; // the old address; App replaces the URL (redirectFor)
  return { name: 'notfound' };
}
