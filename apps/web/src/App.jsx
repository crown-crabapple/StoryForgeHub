import { Link, useLocation } from './router.jsx';
import { LibraryView } from './LibraryView.jsx';
import { BookView } from './BookView.jsx';
import { useApi } from './api.js';

/** Shown when the startup recovery pass rolled an interrupted save back or needs the author's eyes. */
function RecoverBanner() {
  const { data: report } = useApi('/api/recover/last');
  if (!report) return null;
  const rolledBack = report.rolledBack ?? [];
  const needsAttention = report.needsAttention ?? [];
  if (rolledBack.length === 0 && needsAttention.length === 0) return null;
  const label = (item) => `${item.op ?? 'operation'} ${item.opId}${item.files?.length ? ` (${item.files.join(', ')})` : ''}`;
  return (
    <aside role="alert" className="recover-banner">
      <strong>StoryForge recovered from an interrupted save.</strong>
      {rolledBack.length > 0 && (
        <>
          <p>Rolled back to the previous version (nothing was lost):</p>
          <ul>
            {rolledBack.map((item) => (
              <li key={item.opId}>{label(item)}</li>
            ))}
          </ul>
        </>
      )}
      {needsAttention.length > 0 && (
        <>
          <p>Needs your attention (these files were left untouched):</p>
          <ul>
            {needsAttention.map((item) => (
              <li key={item.opId}>
                {label(item)}
                {item.reason ? ` - ${item.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

export function App() {
  const { pathname, search } = useLocation();
  const match = /^\/books\/([^/]+)\/?$/.exec(pathname);
  let view;
  if (pathname === '/' || pathname === '') view = <LibraryView />;
  else if (match) {
    const bookId = decodeURIComponent(match[1]);
    const sceneId = new URLSearchParams(search).get('scene');
    view = <BookView bookId={bookId} sceneId={sceneId} />;
  } else {
    view = (
      <main className="page">
        <h1>Not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          StoryForge
        </Link>
      </header>
      <RecoverBanner />
      {view}
    </>
  );
}
