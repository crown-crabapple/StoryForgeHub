import { useEffect, useState } from 'react';
import { useApi } from './api.js';
import { Link } from './router.jsx';
import { useSearchQuery } from './searchQuery.jsx';

/** A letter or digit, ignoring case and accents: the same folding the search index uses. */
const fold = (ch) => ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);

/**
 * Split a snippet into plain pieces and matched pieces. The server sends plain text; the match is
 * found here (whole-term prefixes, accent- and case-insensitive) and rendered as <mark> elements.
 * Text is only ever rendered as React text, so nothing in a snippet is interpreted as HTML.
 * @returns {{ text: string, hit: boolean }[]}
 */
export function highlight(snippet, query) {
  const chars = Array.from(snippet);
  let folded = '';
  const owner = []; // folded index -> index into chars
  chars.forEach((ch, i) => {
    for (const f of fold(ch)) {
      folded += f;
      owner.push(i);
    }
  });
  const marked = new Array(chars.length).fill(false);
  for (const raw of query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    const term = fold(raw);
    if (term === '') continue;
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      if (at > 0 && isWordChar(folded[at - 1])) continue;
      for (let k = at; k < at + term.length; k++) marked[owner[k]] = true;
    }
  }
  const pieces = [];
  chars.forEach((ch, i) => {
    const last = pieces[pieces.length - 1];
    if (last && last.hit === marked[i]) last.text += ch;
    else pieces.push({ text: ch, hit: marked[i] });
  });
  return pieces;
}

function Hit({ hit, query, onPick }) {
  const title = hit.title || hit.id;
  const openable = hit.kind === 'scene' && hit.book_id;
  return (
    <li className="search-hit">
      <div>
        {openable ? (
          <Link to={`/books/${encodeURIComponent(hit.book_id)}?scene=${encodeURIComponent(hit.id)}`} onClick={onPick}>
            {title}
          </Link>
        ) : (
          <strong>{title}</strong>
        )}{' '}
        <span className="badge">{hit.kind}</span>
      </div>
      <div className="muted search-snippet">
        {highlight(hit.snippet, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
      </div>
    </li>
  );
}

export function SearchBox() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim().slice(0, 200)), 200);
    return () => clearTimeout(t);
  }, [text]);
  const shared = useSearchQuery();
  const { setQuery: publish, resetKey } = shared;
  useEffect(() => {
    publish(query);
  }, [query, publish]);
  const [seenReset, setSeenReset] = useState(resetKey);
  if (seenReset !== resetKey) {
    setSeenReset(resetKey);
    setText('');
  }
  const { data: hits, error, loading } = useApi(query ? `/api/search?q=${encodeURIComponent(query)}` : null);
  const showPanel = open && query !== '' && text.trim() !== '';
  return (
    <div className="search">
      <input
        type="search"
        aria-label="Search the library"
        placeholder="Search"
        maxLength={200}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {showPanel && (
        <div className="search-panel" role="region" aria-label="Search results">
          {loading && <p className="muted">Searching...</p>}
          {error && <p className="error">{error}</p>}
          {hits && hits.length === 0 && <p className="muted">Nothing found.</p>}
          {hits && hits.length > 0 && (
            <ul>
              {hits.map((h) => (
                <Hit key={`${h.book_id}-${h.id}`} hit={h} query={query} onPick={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
