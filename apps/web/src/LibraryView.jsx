import { useApi } from './api.js';
import { Link } from './router.jsx';

/** The library page. Presentational: `books` is the list from /api/books (null while loading). */
export function LibraryPage({ books, error, loading }) {
  return (
    <main id="main" tabIndex={-1} className="page">
      <h1>Library</h1>
      <section aria-labelledby="start-heading" className="start-section">
        <h2 id="start-heading">Start something new</h2>
        <p className="secondary">Creating and opening books arrives in the next update.</p>
      </section>
      <section aria-labelledby="books-heading">
        <h2 id="books-heading">Your books</h2>
        {loading && <p className="muted">Loading...</p>}
        {error && <p className="error">{error}</p>}
        {books && books.length === 0 && <p className="muted">No books found in this library.</p>}
        {books && books.length > 0 && (
          <ul className="book-list">
            {books.map((b) => (
              <li key={b.id} className="book-card">
                <h3>
                  <Link to={`/books/${encodeURIComponent(b.id)}`}>{b.title ?? b.slug ?? b.id}</Link>
                </h3>
                <p className="secondary">
                  {b.series ? `${b.series}${b.series_number != null ? ` #${b.series_number}` : ''} · ` : ''}
                  {b.status ?? 'no status'}
                </p>
                <p className="secondary">
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
      </section>
    </main>
  );
}

export function LibraryView() {
  const { data: books, error, loading } = useApi('/api/books');
  return <LibraryPage books={books} error={error} loading={loading} />;
}
