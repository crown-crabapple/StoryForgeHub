import { useMemo, useState } from 'react';
import { useApi } from './api.js';
import { LibraryPage } from './library/LibraryPage.jsx';
import { mergeSearchHits } from './library/filter.js';
import { useSearchQuery } from './searchQuery.jsx';
import { useStatus } from './status.jsx';

export { LibraryPage };

const SEARCH_LIMIT = 100;

/** Loads the library, and (while the top-bar search has text) which books have content matches. */
export function LibraryView() {
  const [attempt, setAttempt] = useState(0);
  const { data: books, error, loading } = useApi('/api/books', attempt);
  const { data: library } = useApi('/api/library', attempt);
  const { query, clear } = useSearchQuery();
  const { status } = useStatus();
  const { data: results, error: searchError, loading: searching } = useApi(query ? `/api/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}` : null);
  const hits = useMemo(() => {
    if (!query || !books || !results) return null;
    const states = Object.fromEntries((status?.books ?? []).map((b) => [b.book_id, b.index]));
    return mergeSearchHits(results, books, states);
  }, [query, books, results, status]);
  const search = query ? { query, hits, searching, failed: Boolean(searchError), onClear: clear } : null;
  return <LibraryPage books={books} library={library} error={error} loading={loading} onRetry={() => setAttempt((n) => n + 1)} search={search} />;
}
