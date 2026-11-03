import { useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';

const KIND_LABEL = { entry: 'Codex', thread: 'Thread', event: 'Event' };

/** Case-insensitive match on title, slug and type. @param {any[]} objects @param {string} query */
export function filterObjects(objects, query) {
  const q = query.trim().toLowerCase();
  const withSlug = objects.filter((o) => typeof o.slug === 'string' && o.slug !== '');
  if (q === '') return withSlug;
  return withSlug.filter((o) => `${o.title ?? ''} ${o.slug} ${o.type ?? ''} ${KIND_LABEL[o.kind] ?? o.kind}`.toLowerCase().includes(q));
}

/**
 * The groups a picker lists, in the order the contract gives: this book's targets, its series' shared entries, then other books' entries written
 * `[[book-slug:slug]]`. Each group is { key, title, items: [{ id, kind, slug, title, type, link, ref }] } where `ref` is what goes inside the brackets.
 * `targets` is GET /api/books/:b/link-targets; without it the group is the plain `objects` of the book.
 * @param {any | null} targets @param {any[] | null} objects @param {string} query
 */
export function pickerGroups(targets, objects, query) {
  if (!targets) {
    const items = filterObjects(objects ?? [], query).map((o) => ({ ...o, ref: o.slug }));
    return items.length > 0 ? [{ key: 'book', title: null, items }] : [];
  }
  const asItems = (rows) => filterObjects(rows, query).map((o) => ({ ...o, ref: o.link.replace(/^\[\[|\]\]$/g, '') }));
  const groups = [{ key: 'book', title: 'This book', items: asItems(targets.book ?? []) }];
  if (targets.series) groups.push({ key: 'series', title: `Series: ${targets.series.title ?? targets.series.slug} (shared)`, items: asItems(targets.series.items) });
  for (const b of targets.books ?? []) groups.push({ key: `book:${b.slug}`, title: `Other book: ${b.title ?? b.slug}`, items: asItems(b.items) });
  return groups.filter((g) => g.items.length > 0);
}

/**
 * A small picker of Codex entries, threads and events: this book's, then its series' shared entries, then other books' (as `[[book-slug:slug]]`). Choosing one calls
 * `onPick(ref)` with the text that goes between the brackets (`slug`, or `book-slug:slug` for another book).
 * `bookId` makes the picker load the targets of that book; without it only `objects` are offered.
 * @param {{ objects: any[] | null, bookId?: string | null, targets?: any | null, selectedText: string, onPick: (ref: string) => void, onClose: () => void }} props
 */
export function LinkPicker({ objects, bookId = null, targets: given = null, selectedText, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const loaded = useApi(given || !bookId ? null : `/api/books/${encodeURIComponent(bookId)}/link-targets`);
  const targets = given ?? loaded.data ?? null;
  const groups = useMemo(() => pickerGroups(targets, objects, query), [targets, objects, query]);
  const first = groups[0]?.items[0] ?? null;
  const waiting = targets === null && (objects === null || (bookId !== null && loaded.loading && (objects ?? []).length === 0));
  return (
    <Dialog label="Link to Codex or thread" onClose={onClose} className="link-picker">
      <h2>Link to Codex or thread</h2>
      <p className="muted">{selectedText ? `Links the selected text "${selectedText.length > 40 ? `${selectedText.slice(0, 40)}…` : selectedText}".` : 'Inserts a link at the cursor.'}</p>
      <div className="form-row">
        <label>
          <span className="form-label">Find an entry, thread or event</span>
          <input
            type="text"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && first) {
                e.preventDefault();
                onPick(first.ref);
              }
            }}
          />
        </label>
      </div>
      {waiting && <p className="muted">Loading…</p>}
      {!waiting && groups.length === 0 && <p className="muted">Nothing found.</p>}
      {groups.map((g) => (
        <section key={g.key} className="picker-group" aria-label={g.title ?? 'Entries'}>
          {g.title && <h3 className="picker-group-title">{g.title}</h3>}
          <ul className="picker-list">
            {g.items.map((o) => (
              <li key={`${g.key}:${o.id}`}>
                <button type="button" className="picker-item" onClick={() => onPick(o.ref)}>
                  <span className="picker-title">{o.title ?? o.slug}</span>
                  <span className="muted">
                    {KIND_LABEL[o.kind] ?? o.kind}
                    {o.type ? ` · ${o.type}` : ''} · {o.ref}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
