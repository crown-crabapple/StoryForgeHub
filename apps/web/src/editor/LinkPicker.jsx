import { useMemo, useState } from 'react';
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
 * A small picker of Codex entries, threads and events. Choosing one calls `onPick(slug)`.
 * @param {{ objects: any[] | null, selectedText: string, onPick: (slug: string) => void, onClose: () => void }} props
 */
export function LinkPicker({ objects, selectedText, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => filterObjects(objects ?? [], query), [objects, query]);
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
              if (e.key === 'Enter' && matches[0]) {
                e.preventDefault();
                onPick(matches[0].slug);
              }
            }}
          />
        </label>
      </div>
      {objects === null && <p className="muted">Loading…</p>}
      {objects !== null && matches.length === 0 && <p className="muted">Nothing found.</p>}
      <ul className="picker-list">
        {matches.map((o) => (
          <li key={o.id}>
            <button type="button" className="picker-item" onClick={() => onPick(o.slug)}>
              <span className="picker-title">{o.title ?? o.slug}</span>
              <span className="muted">
                {KIND_LABEL[o.kind] ?? o.kind}
                {o.type ? ` · ${o.type}` : ''} · {o.slug}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
