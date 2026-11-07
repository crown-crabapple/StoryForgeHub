import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { bookRows, characterRows, hiddenNote, seriesPlanUrl } from './series.js';
import { planHref } from './requests.js';
import './series.css';

/**
 * The Series section of the Overview: the books of the series in order with logline and overview synopsis, and the characters that have an arc in more than one book. Read-only.
 * @param {{ plan: { series: { slug: string, title: string }, books: any[], characters?: any[], hidden?: number }, bookId: string }} props
 */
export function SeriesPlan({ plan, bookId }) {
  const books = bookRows(plan, bookId);
  const characters = characterRows(plan);
  const note = hiddenNote(plan.hidden);
  return (
    <section aria-labelledby="plan-series-h" className="plan-block plan-series">
      <h2 id="plan-series-h">{`Series: ${plan.series.title}`}</h2>
      <p className="muted">Read-only. Each book&apos;s plan is edited in that book.</p>
      <table className="series-books">
        <caption className="series-hidden">Books in the series, in order</caption>
        <thead>
          <tr>
            <th scope="col">No.</th>
            <th scope="col">Book</th>
            <th scope="col">Logline</th>
            <th scope="col">Overview synopsis</th>
          </tr>
        </thead>
        <tbody>
          {books.map((b) => (
            <tr key={b.id} aria-current={b.current ? 'true' : undefined}>
              <td>{b.number ?? ''}</td>
              <th scope="row">
                <Link to={planHref(b.id)}>{b.title}</Link>
                {b.current && <span className="tag">{' this book'}</span>}
              </th>
              <td>{b.logline}</td>
              <td>
                {b.synopsis === null ? (
                  <span className="muted">No overview synopsis yet</span>
                ) : (
                  <details>
                    <summary>Show synopsis</summary>
                    <p className="series-synopsis">{b.synopsis}</p>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="muted">{note}</p>}
      <h3>Shared characters across books</h3>
      {characters.length === 0 ? (
        <p className="muted">No shared characters yet.</p>
      ) : (
        <ul className="series-characters">
          {characters.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              <ul>
                {c.books.map((b) => (
                  <li key={b.id}>{`${b.title}: ${b.text}`}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Series card of the Overview: nothing while loading, on a failed fetch or for a standalone book (`series: null`). @param {{ bookId: string }} props */
export function SeriesSection({ bookId }) {
  const { data, error } = useApi(seriesPlanUrl(bookId));
  if (error || !data || !data.series) return null;
  return <SeriesPlan plan={data} bookId={bookId} />;
}
