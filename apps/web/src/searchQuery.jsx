// The top-bar search query, shared so the library page can filter its cards by content matches.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const NOOP = { query: '', setQuery: () => {}, clear: () => {}, resetKey: 0 };
const SearchQueryContext = createContext(NOOP);

export function SearchQueryProvider({ children }) {
  const [query, setQuery] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const clear = useCallback(() => {
    setQuery('');
    setResetKey((k) => k + 1);
  }, []);
  const value = useMemo(() => ({ query, setQuery, clear, resetKey }), [query, clear, resetKey]);
  return <SearchQueryContext.Provider value={value}>{children}</SearchQueryContext.Provider>;
}

/** @returns {{ query: string, setQuery: (q: string) => void, clear: () => void, resetKey: number }} query is the debounced, trimmed text of the top-bar search box. */
export function useSearchQuery() {
  return useContext(SearchQueryContext);
}
