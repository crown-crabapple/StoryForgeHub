// Which page a URL shows. Pure, so it can be tested without a browser.

/** The project tabs, in order. `path` is appended to /books/:id. */
export const PROJECT_TABS = [
  { key: 'manuscript', label: 'Manuscript', path: '' },
  { key: 'codex', label: 'Codex', path: '/codex' },
  { key: 'timeline', label: 'Timeline', path: '/timeline' },
  { key: 'places', label: 'Places', path: '/places' },
  { key: 'notes', label: 'Notes', path: '/notes' },
];

const PLACEHOLDER_TABS = PROJECT_TABS.filter((t) => t.path !== '').map((t) => t.key);

/** @param {string} bookId @param {string} tab a PROJECT_TABS key */
export function tabHref(bookId, tab) {
  const t = PROJECT_TABS.find((x) => x.key === tab);
  return `/books/${encodeURIComponent(bookId)}${t ? t.path : ''}`;
}

/**
 * @param {string} pathname
 * @param {string} [search]
 * @returns {{ name: 'library' } | { name: 'book', bookId: string, sceneId: string | null, file: string | null } | { name: 'tab', bookId: string, tab: string } | { name: 'notfound' }}
 */
export function parseRoute(pathname, search = '') {
  if (pathname === '/' || pathname === '') return { name: 'library' };
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
