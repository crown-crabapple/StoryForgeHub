import { useRef } from 'react';
import { Link } from '../router.jsx';
import { researchForEntry } from '../notes/model.js';
import { LabelFilter } from '../world/LabelChip.jsx';
import { SCOPES } from '../world/model.js';
import { CodexCard } from './CodexCard.jsx';
import { EntryInspector } from './EntryInspector.jsx';
import { SORTS, STATUS_FILTERS, filterEntries, headerCounts, nextCardIndex, nextTabIndex, sidebarRows, sortEntries, tabId, typeTitle } from './model.js';

/**
 * The Codex page (reference: design/screens/Codex.dc.html): the section tab bar (All, one tab per type, Archived), the header with filters, the card grid and the
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
 *   linkOf?: (ref: string) => { href: string, name?: string | null } | null, // where a cross-book [[link]] in an entry leads (it opens that book on that entry)
 *   actions?: ((entry: any) => { onEdit?: () => void, onEditText?: () => void, onChangeSlug?: () => void, onArchive?: () => void, onRestore?: () => void, onMoveToSeries?: () => void, onCopyIntoBook?: () => void }) | null, // the inspector's buttons for the entry it shows
 *   editor?: import('react').ReactNode,  // replaces the header and the grid while an entry's text is being edited
 *   notes?: any[] | null,                 // GET /notes `notes` (M04-J04): the inspector then shows each entry's Research section
 *   lockedType?: string | null,           // the Places tab: only this type's tab is drawn and the page is titled "Places"
 *   series?: { slug: string, title?: string | null } | null, // GET /codex/entries `series`: the book is in a series, so the All / This book / Shared filter shows
 *   scope?: string, onScope?: (scope: string) => void,
 *   labelDefs?: any[] | null, label?: string, onLabel?: (name: string) => void, // the label chips and the label filter
 *   banner?: import('react').ReactNode,   // a message above the cards (for example the W309 of a copy)
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
  linkOf,
  actions = null,
  editor = null,
  notes = null,
  lockedType = null,
  series = null,
  scope = 'all',
  onScope,
  labelDefs = null,
  label = '',
  onLabel,
  banner = null,
}) {
  const gridRef = useRef(null);
  const tabsRef = useRef(null);
  const rows = sidebarRows(types, entries).filter((r) => lockedType === null || r.key === lockedType);
  // the header counts the entries of the sidebar row, before the search and status chips narrow the grid
  const ofRow = filterEntries(entries, { type: typeKey });
  const shown = sortEntries(filterEntries(entries, { type: typeKey, status, query, textIds: searchText ? textIds : null, scope, label }), sort);
  const counts = headerCounts(ofRow);
  const selected = entries.find((e) => e.id === selectedId && shown.some((s) => s.id === e.id)) ?? shown[0] ?? null;
  const filtered = query.trim() !== '' || status !== 'all' || scope !== 'all' || label !== '';
  const act = selected && actions ? actions(selected) : {};

  // the tab that is selected; when no row matches the typeKey the first tab is the one in the tab order
  const activeKey = rows.some((r) => r.key === typeKey) ? typeKey : (rows[0]?.key ?? typeKey);

  function onTabKeyDown(e) {
    const tabs = [...(tabsRef.current?.querySelectorAll('[role="tab"]') ?? [])];
    const at = tabs.indexOf(e.target);
    if (at < 0) return;
    const next = nextTabIndex(at, e.key, tabs.length);
    if (next !== at) {
      e.preventDefault();
      tabs[next].focus();
      onTypeChange?.(rows[next].key);
    }
  }

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
      <div className="codex-tabbar">
        <div role="tablist" aria-label="Codex sections" className="codex-tabs" ref={tabsRef} onKeyDown={onTabKeyDown}>
          {rows.map((r) => {
            const on = r.key === activeKey;
            return (
              <button
                type="button"
                role="tab"
                key={r.key}
                id={tabId(r.key)}
                className="codex-tab"
                data-kind={r.kind}
                aria-selected={on ? 'true' : 'false'}
                aria-controls="codex-tabpanel"
                tabIndex={on ? 0 : -1}
                onClick={() => onTypeChange?.(r.key)}
              >
                <span>{r.label}</span>
                <span className="codex-tab-count">{r.count}</span>
              </button>
            );
          })}
        </div>
        {lockedType !== null && (
          <Link className="codex-tab-link" to={`/books/${encodeURIComponent(bookId)}/codex`}>
            The whole Codex
          </Link>
        )}
        {onNewType && lockedType === null && (
          <button type="button" className="btn codex-new-type" onClick={onNewType}>
            New type…
          </button>
        )}
      </div>

      <div role="tabpanel" id="codex-tabpanel" aria-labelledby={tabId(activeKey)} className="codex-body">
        <main id="main" tabIndex={-1} className="codex-main">
          {editor ?? (
            <>
              <div className="codex-head">
                <h1>{lockedType === null ? typeTitle(typeKey, types) : 'Places'}</h1>
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
                {series && (
                  <div className="chips" role="group" aria-label="Where">
                    {SCOPES.map((s) => (
                      <button type="button" key={s.key} className="chip" aria-pressed={s.key === scope ? 'true' : 'false'} onClick={() => onScope?.(s.key)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
                {onLabel && <LabelFilter defs={labelDefs} used={entries.map((e) => e.labels ?? [])} value={label} onChange={onLabel} />}
                <div className="chips" role="group" aria-label="Status">
                  {STATUS_FILTERS.map((s) => (
                    <button type="button" key={s.key} className="chip" aria-pressed={s.key === status ? 'true' : 'false'} onClick={() => onStatus?.(s.key)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {banner}

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
                      labelDefs={labelDefs}
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
            research={notes && selected ? researchForEntry(notes, selected) : null}
            onEdit={selected && !selected.archived ? act.onEdit : undefined}
            onEditText={selected && !selected.archived ? act.onEditText : undefined}
            onChangeSlug={selected && !selected.archived ? act.onChangeSlug : undefined}
            onArchive={selected && !selected.archived ? act.onArchive : undefined}
            onRestore={selected?.archived ? act.onRestore : undefined}
            onMoveToSeries={selected && !selected.archived ? act.onMoveToSeries : undefined}
            onCopyIntoBook={selected && !selected.archived ? act.onCopyIntoBook : undefined}
            labelDefs={labelDefs}
            linkOf={linkOf}
          />
        </aside>
      </div>
    </div>
  );
}
