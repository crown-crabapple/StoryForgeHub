import { useState } from 'react';
import { CoverCard, SkeletonCard } from './CoverCard.jsx';
import { SORTS, STATUS_FILTERS, filterBooks, groupBooks } from './filter.js';
import { NewBookFlow, OpenFolderFlow, RestoreFlow } from './StartFlows.jsx';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const FILTER_LABEL = 'Filter by title, series or pen name';
const DEFAULT_FILTERS = { text: '', status: 'all', showArchived: false, sort: 'series' };

function Section({ id, title, status, count, children }) {
  return (
    <section className="library-section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        {status && <span className="badge">{status}</span>}
        <span className="secondary">{plural(count, 'book')}</span>
      </div>
      <ul className="card-grid">{children}</ul>
    </section>
  );
}

/**
 * The library page. Presentational: everything arrives by props, so tests can render it with fixtures.
 * @param {{
 *   books: any[] | null,
 *   library?: { root?: string, series?: { slug: string, title: string | null, status: string | null }[] } | null,
 *   error?: string | null,
 *   loading?: boolean,
 *   onRetry?: () => void,
 *   search?: { query: string, hits: Record<string, any> | null, searching?: boolean, failed?: boolean, onClear?: () => void } | null,
 *   initial?: Partial<typeof DEFAULT_FILTERS>,
 * }} props
 *   `search`: the top-bar query and its per-book content matches (see mergeSearchHits); null when no search is active.
 *   `initial`: starting filter state (for tests; the page owns the state).
 */
export function LibraryPage({ books, library = null, error = null, loading = false, onRetry, search = null, initial }) {
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS, ...initial });
  /** Which Start dialog is open: null, 'new' or 'open'. */
  const [dialog, setDialog] = useState(null);
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const query = search?.query ?? '';
  const hits = query !== '' ? (search?.hits ?? null) : null;
  const shown = books ? filterBooks(books, { query: filters.text, status: filters.status, showArchived: filters.showArchived, sort: filters.sort, hits }) : [];
  const { sections, standalone } = groupBooks(shown, library?.series ?? [], filters.sort);
  const clear = () => {
    setFilters({ ...DEFAULT_FILTERS });
    search?.onClear?.();
  };
  const cardProps = (b) => ({ book: b, match: hits ? hits[b.id] : null, query });
  const hasBooks = books !== null && books !== undefined && books.length > 0;

  return (
    <main id="main" tabIndex={-1} className="page library-page">
      <header className="page-head">
        <h1>Library</h1>
        {books && <span className="secondary">{plural(books.length, 'book')}</span>}
        <button type="button" className="btn page-head-action" onClick={() => setDialog('restore')}>
          Restore from backup…
        </button>
      </header>
      <section aria-labelledby="start-heading" className="start-section">
        <h2 id="start-heading">Start something new</h2>
        <div className="start-actions">
          <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>
            New book…
          </button>
          <button type="button" className="btn" onClick={() => setDialog('open')}>
            Open folder…
          </button>
        </div>
      </section>

      {error && (
        <div role="alert" className="library-error">
          <p className="error">{error}</p>
          {onRetry && (
            <button type="button" className="btn" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {loading && !books && !error && (
        <div role="status" aria-label="Loading the library">
          <ul className="card-grid">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </ul>
        </div>
      )}

      {books && books.length === 0 && !error && (
        <section className="empty-state" aria-labelledby="empty-heading">
          <h2 id="empty-heading">No books here yet.</h2>
          {library?.root && (
            <p className="secondary">
              Library folder: <code>{library.root}</code>
            </p>
          )}
          <p className="secondary">Use <strong>New book…</strong> above to start one, or <strong>Open folder…</strong> to open a folder that already has books.</p>
        </section>
      )}

      {hasBooks && (
        <>
          <div className="toolbar">
            <input
              type="search"
              className="toolbar-filter"
              aria-label={FILTER_LABEL}
              placeholder={FILTER_LABEL}
              value={filters.text}
              onChange={(e) => set({ text: e.target.value })}
            />
            <div className="chips" role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map((s) => (
                <button key={s.key} type="button" className="chip" aria-pressed={filters.status === s.key} onClick={() => set({ status: s.key })}>
                  {s.label}
                </button>
              ))}
            </div>
            <label className="toolbar-check">
              <input type="checkbox" checked={filters.showArchived} onChange={(e) => set({ showArchived: e.target.checked })} /> Show archived
            </label>
            <label className="toolbar-sort">
              <span className="secondary">Sort</span>
              <select value={filters.sort} onChange={(e) => set({ sort: e.target.value })}>
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {query !== '' && search?.searching && (
            <p role="status" className="muted">
              Searching inside books…
            </p>
          )}
          {query !== '' && search?.failed && (
            <p role="status" className="error">
              Searching inside books failed, so every book is shown.
            </p>
          )}

          {shown.length === 0 ? (
            <section className="empty-state" aria-labelledby="nomatch-heading">
              <h2 id="nomatch-heading">No books match</h2>
              <p>
                <button type="button" className="btn" onClick={clear}>
                  Clear filters
                </button>
              </p>
            </section>
          ) : (
            <>
              {sections.map((s) => (
                <Section key={s.slug} id={`series-${s.slug}`} title={s.title} status={s.status} count={s.books.length}>
                  {s.books.map((b) => (
                    <CoverCard key={b.id} {...cardProps(b)} />
                  ))}
                </Section>
              ))}
              {standalone.length > 0 && (
                <Section id="standalone-heading" title="Standalone" count={standalone.length}>
                  {standalone.map((b) => (
                    <CoverCard key={b.id} {...cardProps(b)} />
                  ))}
                </Section>
              )}
            </>
          )}
        </>
      )}

      {dialog === 'new' && <NewBookFlow onClose={() => setDialog(null)} />}
      {dialog === 'open' && <OpenFolderFlow onClose={() => setDialog(null)} />}
      {dialog === 'restore' && <RestoreFlow onClose={() => setDialog(null)} />}
    </main>
  );
}
