// Which page a URL shows. Pure, so it can be tested without a browser.

/** The project tabs, in order. `path` is appended to /books/:id. */
export const PROJECT_TABS = [
  { key: 'manuscript', label: 'Manuscript', path: '' },
  { key: 'codex', label: 'Codex', path: '/codex' },
  { key: 'timeline', label: 'Timeline', path: '/timeline' },
  { key: 'continuity', label: 'Continuity', path: '/continuity' },
  { key: 'places', label: 'Places', path: '/places' },
  { key: 'notes', label: 'Notes', path: '/notes' },
];

/** Further project pages (M07-J02), shown after the tabs above: the Insights dashboard and the revision Tasks. */
export const MORE_TABS = [
  { key: 'insights', label: 'Insights', path: '/insights' },
  { key: 'tasks', label: 'Tasks', path: '/tasks' },
];

/** The module a project tab belongs to (M07-J04): with the module off the tab disappears. `insights` and `tasks` are J02's pages, gated by id so they follow once they exist. */
const TAB_MODULES = { timeline: 'timeline', continuity: 'continuity', notes: 'research', insights: 'insights', tasks: 'tasks' };
/** @param {string} tab a PROJECT_TABS key @returns {string | null} */
export const tabModule = (tab) => TAB_MODULES[tab] ?? null;

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
  return { name: 'notfound' };
}
