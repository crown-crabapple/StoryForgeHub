// Settings -> Books. Rename a book's title (POST /api/books/:id/title; only the title line of book.md changes, the folder name stays) and put a standalone
// book into a series (POST /api/books/:id/move-to-series, through the Move to series dialog).
import { useId, useState } from 'react';
import { postJson, useApi } from '../api.js';
import { MoveToSeriesDialog } from '../library/MoveToSeriesDialog.jsx';

/** @param {string} bookId @param {string} title @returns {Promise<{ ok: boolean, title?: string, message?: string }>} */
export async function saveTitle(bookId, title) {
  try {
    const r = await postJson(`/api/books/${encodeURIComponent(bookId)}/title`, { title });
    if (r.status === 200 && r.json?.ok) return { ok: true, title: r.json.title };
    return { ok: false, message: r.json?.message ?? `Not saved (${r.status}).` };
  } catch {
    return { ok: false, message: 'The server could not be reached.' };
  }
}

/**
 * One book's row: a "Book title" field with Save, and "Move to series…" when the book is standalone.
 * @param {{ book: { id: string, title: string, series: string | null }, onRenamed: (title: string) => void, onMove: () => void }} props
 */
function BookRow({ book, onRenamed, onMove }) {
  const id = useId();
  const [value, setValue] = useState(book.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const dirty = value.trim() !== book.title;

  async function save(e) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    const r = await saveTitle(book.id, value);
    setBusy(false);
    if (r.ok) {
      setValue(r.title ?? value.trim());
      onRenamed(r.title ?? value.trim());
    } else {
      setError(r.message ?? 'Not saved.');
    }
  }

  return (
    <li className="book-admin-row">
      <form onSubmit={save} noValidate>
        <div className="field">
          <label htmlFor={`${id}-title`}>
            Book title <span className="muted">({book.title})</span>
          </label>
          <input
            id={`${id}-title`}
            type="text"
            value={value}
            maxLength={120}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            {...(error ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-error` } : {})}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="field-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="submit" className="btn" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {!book.series && (
            <button type="button" className="btn" onClick={onMove}>
              Move to series…
            </button>
          )}
        </div>
      </form>
    </li>
  );
}

/**
 * The section from what the server answered (also used by tests).
 * @param {{ books: { id: string, title: string, series: string | null }[], series: { slug: string, title: string | null }[], status?: string | null,
 *   onRenamed?: (book: { id: string }, title: string) => void, onMoved?: (result: any) => void }} props
 */
export function BookAdminView({ books, series, status = null, onRenamed = () => {}, onMoved = () => {} }) {
  const [moving, setMoving] = useState(/** @type {{ id: string, title: string } | null} */ (null));
  return (
    <section aria-labelledby="book-admin-heading" className="pref-section">
      <h2 id="book-admin-heading">Books</h2>
      <p className="muted">
        Rename a book, or put a standalone book into a series. A new title changes only the title in book.md; the book&apos;s folder keeps its name. To start a series, use New series on the Library page.
      </p>
      {books.length === 0 ? (
        <p className="muted">No books yet.</p>
      ) : (
        <ul className="book-admin-list">
          {books.map((b) => (
            <BookRow key={`${b.id}:${b.title}`} book={b} onRenamed={(title) => onRenamed(b, title)} onMove={() => setMoving({ id: b.id, title: b.title })} />
          ))}
        </ul>
      )}
      {status && <p role="status">{status}</p>}
      {moving && (
        <MoveToSeriesDialog
          book={moving}
          series={series}
          onClose={() => setMoving(null)}
          onMoved={(r) => {
            setMoving(null);
            onMoved(r);
          }}
        />
      )}
    </section>
  );
}

/** Settings -> Books. */
export function BookAdminSettings() {
  const [rev, setRev] = useState(0);
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const { data: books } = useApi('/api/books', String(rev));
  const { data: library } = useApi('/api/library', String(rev));
  const list = (Array.isArray(books) ? books : []).map((/** @type {any} */ b) => ({ id: b.id, title: b.title ?? b.slug ?? b.id, series: b.series ?? null }));
  return (
    <BookAdminView
      books={list}
      series={library?.series ?? []}
      status={status}
      onRenamed={(_book, title) => {
        setStatus(`Renamed to ${title}.`);
        setRev((n) => n + 1);
      }}
      onMoved={(r) => {
        setStatus(`Moved to ${r.seriesSlug} as book ${r.seriesNumber}.`);
        setRev((n) => n + 1);
      }}
    />
  );
}
