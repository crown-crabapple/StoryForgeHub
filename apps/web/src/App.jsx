import { Link, useLocation } from './router.jsx';
import { LibraryView } from './LibraryView.jsx';
import { BookView } from './BookView.jsx';

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
      {view}
    </>
  );
}
