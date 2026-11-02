import { useApi } from './api.js';
import { Link } from './router.jsx';

export function LibraryView() {
  const { data: books, error, loading } = useApi('/api/books');
  return (
    <main className="page">
      <h1>Library</h1>
      {loading && <p className="muted">Loading...</p>}
      {error && <p className="error">{error}</p>}
      {books && books.length === 0 && <p className="muted">No books found in this library.</p>}
      {books && books.length > 0 && (
        <ul className="book-list">
          {books.map((b) => (
            <li key={b.id} className="book-card">
              <h2>
                <Link to={`/books/${encodeURIComponent(b.id)}`}>{b.title ?? b.slug ?? b.id}</Link>
              </h2>
              <p className="muted">
                {b.series ? `${b.series}${b.series_number != null ? ` #${b.series_number}` : ''} · ` : ''}
                {b.status ?? 'no status'}
              </p>
              <p className="muted">
                {b.scene_count} scenes · {b.word_count.toLocaleString()} words
              </p>
              <p>
                <span className={b.error_count ? 'badge badge-error' : 'badge'}>{b.error_count} errors</span>{' '}
                <span className={b.warning_count ? 'badge badge-warn' : 'badge'}>{b.warning_count} warnings</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
