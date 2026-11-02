// "Add scenes, entries and notes by search" for the AI context: the files of this book, filtered as you type. Adds book-relative paths.
import { useState } from 'react';
import { useApi } from '../api.js';
import { bookRelative } from './model.js';

/**
 * @param {{ book: any, chosen: string[], onAdd: (file: { path: string, title: string }) => void }} props
 */
export function FilePicker({ book, chosen, onAdd }) {
  const [query, setQuery] = useState('');
  const base = `/api/books/${encodeURIComponent(book.id)}`;
  const { data: codex } = useApi(`${base}/codex/entries`);
  const { data: notes } = useApi(`${base}/notes`);
  const scenes = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).map((s) => ({ path: bookRelative(book.path, s.path), title: s.title, kind: 'scene' }));
  const entries = (codex?.entries ?? []).filter((e) => !e.archived).map((e) => ({ path: e.path, title: e.name, kind: 'entry' }));
  const docs = (notes?.notes ?? []).filter((n) => !n.archived).map((n) => ({ path: n.rel ?? n.path, title: n.title, kind: 'note' }));
  const q = query.trim().toLowerCase();
  const matches = q === '' ? [] : [...scenes, ...entries, ...docs].filter((f) => f.path && !chosen.includes(f.path) && (f.title ?? '').toLowerCase().includes(q)).slice(0, 8);
  return (
    <div className="ai-picker">
      <label className="ai-label" htmlFor="ai-picker-input">
        Add a scene, entry or note
      </label>
      <input id="ai-picker-input" type="search" value={query} placeholder="Search by title" onChange={(e) => setQuery(e.target.value)} />
      {matches.length > 0 && (
        <ul className="ai-picker-results" aria-label="Matches">
          {matches.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onAdd({ path: f.path, title: f.title });
                  setQuery('');
                }}
              >
                {f.title} <span className="badge">{f.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
