import { Link } from '../router.jsx';
import { highlight } from '../SearchBox.jsx';
import { coverColors } from './cover-palette.js';
import { bookLabel } from './filter.js';

const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** What the badge says and what to fix, for a cover that is set but cannot be shown. */
const COVER_PROBLEMS = {
  missing: {
    label: 'Cover not found',
    hint: 'The image named by cover: in book.md is not in the book. Add the file or fix the path in book.md.',
  },
  unsupported: {
    label: 'Cover type not supported',
    hint: 'Covers must be .png, .jpg, .jpeg, .webp or .gif files under 10 MB (SVG is never shown). Change cover: in book.md.',
  },
  outside: {
    label: 'Cover must be in assets/',
    hint: "cover: in book.md must name a file inside the book's assets/ folder. Change the path in book.md.",
  },
};

/** The 2:3 cover: the book's image, or a cover generated from its title and pen name. */
export function Cover({ book }) {
  const title = book.title ?? book.slug ?? book.id;
  if (book.cover_state === 'image' && book.cover_url) {
    return <img className="cover cover-image" src={book.cover_url} alt={`Cover of ${title}`} loading="lazy" />;
  }
  const { background, color } = coverColors(book);
  return (
    <div className="cover cover-generated" role="img" aria-label={`Generated cover for ${title}`} style={{ backgroundColor: background, color }}>
      <span className="cover-title">{title}</span>
      <span className="cover-rule" style={{ backgroundColor: color }} />
      {book.pen_name_display && <span className="cover-pen">{book.pen_name_display}</span>}
    </div>
  );
}

function WordProgress({ words, target }) {
  if (!(target > 0)) return <span className="card-words">{plural(words, 'word')}</span>;
  const label = `${fmt(words)} of ${fmt(target)} words`;
  const now = Math.min(words, target);
  return (
    <span className="card-progress">
      <span className="progress" role="progressbar" aria-label="Words written toward the target" aria-valuemin={0} aria-valuemax={target} aria-valuenow={now} aria-valuetext={label}>
        <span className="progress-fill" style={{ width: `${Math.round((now / target) * 100)}%` }} />
      </span>
      <span className="card-words">{label}</span>
    </span>
  );
}

/**
 * One book. The whole card is a single link (nothing interactive inside it).
 * @param {{ book: any, match?: { count: number, snippet: string | null, indexing: boolean } | null, query?: string }} props
 *   `match` is the book's content-search result while a search is active.
 */
export function CoverCard({ book, match = null, query = '' }) {
  const title = book.title ?? book.slug ?? book.id;
  const problem = COVER_PROBLEMS[book.cover_state];
  const attention = book.index_state === 'invalid' || book.error_count > 0;
  const label = book.series ? bookLabel(book) : null;
  const titleId = `card-title-${book.id}`;
  return (
    <li className="card-item">
      <Link to={`/books/${encodeURIComponent(book.id)}`} className="cover-card" aria-labelledby={titleId}>
        <Cover book={book} />
        <span className="card-body">
          {label && <span className="card-label">{label}</span>}
          <span id={titleId} className="card-title">
            {title}
          </span>
          {book.subtitle && <span className="card-subtitle">{book.subtitle}</span>}
          {book.pen_name_display && <span className="card-pen secondary">{book.pen_name_display}</span>}
          <span className="card-badges">
            {book.status && <span className={`badge status-${book.status}`}>{book.status}</span>}
            {book.archived && <span className="badge">Archived</span>}
            {attention && <span className="badge badge-error">Needs attention</span>}
            {book.error_count > 0 && <span className="badge badge-error">{plural(book.error_count, 'error')}</span>}
            {book.warning_count > 0 && <span className="badge badge-warn">{plural(book.warning_count, 'warning')}</span>}
            {problem && (
              <span className="badge badge-warn" title={problem.hint}>
                {problem.label}
              </span>
            )}
          </span>
          <WordProgress words={book.word_count ?? 0} target={book.word_target} />
          <span className="card-scenes secondary">{plural(book.scene_count ?? 0, 'scene')}</span>
          {match && (
            <span className="card-match">
              {match.indexing ? (
                <span className="muted">Indexing…</span>
              ) : (
                <>
                  <span className="card-match-count">{plural(match.count, 'match', 'matches')}</span>
                  {match.snippet && (
                    <span className="card-snippet muted">
                      {highlight(match.snippet, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/** A placeholder card of the same size while the library loads. */
export function SkeletonCard() {
  return (
    <li className="card-item skeleton" aria-hidden="true">
      <span className="cover-card">
        <span className="cover" />
        <span className="card-body">
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-short" />
        </span>
      </span>
    </li>
  );
}
