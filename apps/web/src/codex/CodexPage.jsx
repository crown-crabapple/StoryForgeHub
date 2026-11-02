import { useRef } from 'react';
import { CodexCard } from './CodexCard.jsx';
import { EntryInspector } from './EntryInspector.jsx';
import { SORTS, STATUS_FILTERS, filterEntries, headerCounts, nextCardIndex, sidebarRows, sortEntries, typeTitle } from './model.js';

/**
 * The Codex page (reference: design/screens/Codex.dc.html): the "Story bible" sidebar, the header with filters, the card grid and the
 * inspector. Presentational: everything arrives by props, so tests can render it with fixture JSON.
 *
 * @param {{
 *   bookId: string,
 *   types: { type: string, name: string, plural: string, builtin?: boolean }[],
 *   entries: any[],                       // GET /codex/entries `entries`
 *   chapters: { chapter: number, label?: string, scene_ids?: string[] }[],
 *   typeKey: string,                      // 'all' | 'archived' | a type
 *   selectedId?: string | null,
 *   query?: string, status?: string, sort?: string, searchText?: boolean, textIds?: Set<string> | null,
 *   onTypeChange?: (key: string) => void, onSelect?: (entryId: string) => void, onQuery?: (q: string) => void,
 *   onStatus?: (key: string) => void, onSort?: (key: string) => void, onSearchText?: (on: boolean) => void,
 *   onNewEntry?: () => void, onNewType?: () => void,
 *   resolve?: (ref: string) => { id: string } | null,
 *   actions?: ((entry: any) => { onEdit?: () => void, onEditText?: () => void, onChangeSlug?: () => void, onArchive?: () => void, onRestore?: () => void }) | null, // the inspector's buttons for the entry it shows
 *   editor?: import('react').ReactNode,  // replaces the header and the grid while an entry's text is being edited
 * }} props
 */
export function CodexPage({
  bookId,
  types,
  entries,
  chapters,
  typeKey,
  selectedId = null,
  query = '',
  status = 'all',
  sort = 'name',
  searchText = false,
  textIds = null,
  onTypeChange,
  onSelect,
  onQuery,
  onStatus,
  onSort,
  onSearchText,
  onNewEntry,
  onNewType,
  resolve,
  actions = null,
  editor = null,
}) {
  const gridRef = useRef(null);
  const rows = sidebarRows(types, entries);
  // the header counts the entries of the sidebar row, before the search and status chips narrow the grid
  const ofRow = filterEntries(entries, { type: typeKey });
  const shown = sortEntries(filterEntries(entries, { type: typeKey, status, query, textIds: searchText ? textIds : null }), sort);
  const counts = headerCounts(ofRow);
  const selected = entries.find((e) => e.id === selectedId && shown.some((s) => s.id === e.id)) ?? shown[0] ?? null;
  const filtered = query.trim() !== '' || status !== 'all';
  const act = selected && actions ? actions(selected) : {};

  function onGridKeyDown(e) {
    const cards = [...(gridRef.current?.querySelectorAll('.codex-card') ?? [])];
    const at = cards.indexOf(e.target);
    if (at < 0) return;
    const top = cards[0].offsetTop;
    const columns = cards.filter((c) => c.offsetTop === top).length;
    const next = nextCardIndex(at, e.key, columns, cards.length);
    if (next !== at) {
      e.preventDefault();
      cards[next].focus();
    }
  }

  return (
    <div className="codex">
      <aside aria-label="Codex categories" className="codex-sidebar">
        <h2 className="codex-sidebar-title">Story bible</h2>
        {rows.map((r) => (
          <button
            type="button"
            key={r.key}
            className="codex-cat"
            data-kind={r.kind}
            aria-current={r.key === typeKey ? 'true' : undefined}
            onClick={() => onTypeChange?.(r.key)}
          >
            <span>{r.label}</span>
            <span className="codex-cat-count">{r.count}</span>
          </button>
        ))}
        {onNewType && (
          <button type="button" className="btn codex-new-type" onClick={onNewType}>
            New type…
          </button>
        )}
      </aside>

      <main id="main" tabIndex={-1} className="codex-main">
        {editor ?? (
          <>
            <div className="codex-head">
              <h1>{typeTitle(typeKey, types)}</h1>
              <span className="codex-counts">{counts.text}</span>
              {onNewEntry && (
                <button type="button" className="btn btn-primary codex-new" onClick={onNewEntry}>
                  New entry
                </button>
              )}
            </div>

            <div className="toolbar codex-toolbar">
              <input
                type="search"
                className="toolbar-filter"
                aria-label="Search entries"
                placeholder="Search entries"
                value={query}
                onChange={(e) => onQuery?.(e.target.value)}
              />
              {onSearchText && (
                <label className="toolbar-check">
                  <input type="checkbox" checked={searchText} onChange={(e) => onSearchText(e.target.checked)} /> Search text too
                </label>
              )}
              <label className="toolbar-sort">
                Sort
                <select value={sort} onChange={(e) => onSort?.(e.target.value)}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="chips" role="group" aria-label="Status">
                {STATUS_FILTERS.map((s) => (
                  <button type="button" key={s.key} className="chip" aria-pressed={s.key === status ? 'true' : 'false'} onClick={() => onStatus?.(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="empty-state">
                <h2>{filtered ? 'No entries match.' : typeKey === 'archived' ? 'Nothing is archived.' : 'No entries here yet.'}</h2>
                <p>
                  {filtered
                    ? 'Clear the search or the status filter to see more.'
                    : typeKey === 'archived'
                      ? 'Entries you archive wait here until you restore them.'
                      : 'Add the first one with New entry.'}
                </p>
              </div>
            ) : (
              <div className="codex-grid" ref={gridRef} onKeyDown={onGridKeyDown}>
                {shown.map((e) => (
                  <CodexCard
                    key={e.id}
                    entry={e}
                    chapters={chapters}
                    types={types}
                    selected={selected?.id === e.id}
                    tabIndex={(selected ?? shown[0]).id === e.id ? 0 : -1}
                    onSelect={() => onSelect?.(e.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <aside aria-label="Entry details" className="codex-detail">
        <EntryInspector
          bookId={bookId}
          entry={selected}
          chapters={chapters}
          types={types}
          resolve={resolve}
          onSelect={onSelect}
          onEdit={selected && !selected.archived ? act.onEdit : undefined}
          onEditText={selected && !selected.archived ? act.onEditText : undefined}
          onChangeSlug={selected && !selected.archived ? act.onChangeSlug : undefined}
          onArchive={selected && !selected.archived ? act.onArchive : undefined}
          onRestore={selected?.archived ? act.onRestore : undefined}
        />
      </aside>
    </div>
  );
}
