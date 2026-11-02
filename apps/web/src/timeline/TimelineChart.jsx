import { useState } from 'react';

const W = 560;
const H = 240;
const M = { left: 52, right: 16, top: 16, bottom: 44 };

/** Up to `max` evenly spaced whole numbers from 1 to `last` for an axis. */
export function ticksFor(last, max = 8) {
  const step = Math.max(1, Math.ceil(last / max));
  const out = [];
  for (let n = 1; n <= last; n += step) out.push(n);
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Story vs. book: a compact SVG plot, x = narrative position (the event's first scene in the manuscript), y = chronological rank (later is lower), one dot per placed
 * event. A dot is labelled on hover and on focus, and selects the event when pressed. "Show as table" swaps the plot for the same facts in a table (the accessible form).
 * Presentational: `model` is buildTimeline().
 * @param {{ model: { points: { id: string, title: string, x: number, y: number }[], maxPosition: number, maxRank: number, events: any[] }, selectedId?: string | null,
 *   table?: boolean, onTable?: (on: boolean) => void, onSelect?: (id: string) => void }} props
 */
export function TimelineChart({ model, selectedId = null, table = false, onTable, onSelect }) {
  const [hot, setHot] = useState(null);
  const { points, maxPosition, maxRank } = model;
  const x = (n) => M.left + (maxPosition <= 1 ? (W - M.left - M.right) / 2 : ((n - 1) / (maxPosition - 1)) * (W - M.left - M.right));
  const y = (n) => M.top + (maxRank <= 1 ? (H - M.top - M.bottom) / 2 : ((n - 1) / (maxRank - 1)) * (H - M.top - M.bottom));
  const shown = points.find((p) => p.id === (hot ?? selectedId)) ?? null;
  const placed = model.events.filter((e) => e.position !== null && e.order !== null);
  return (
    <section className="tl-chart" aria-label="Story time against book order">
      <div className="tl-chart-head">
        <h2>Story vs. book</h2>
        <button type="button" className="btn" aria-pressed={table ? 'true' : 'false'} onClick={() => onTable?.(!table)}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      {points.length === 0 ? (
        <p className="muted">No event is in the book yet, so there is nothing to plot. Link an event to a scene to see it here.</p>
      ) : table ? (
        <table className="tl-table">
          <caption className="muted">Each event that is in the book: where the book tells it, and where it falls in story time.</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Book position</th>
              <th scope="col">Story rank</th>
              <th scope="col">Order</th>
              <th scope="col">Told</th>
            </tr>
          </thead>
          <tbody>
            {[...placed].sort((a, b) => a.position - b.position || a.rank - b.rank).map((e) => (
              <tr key={e.id} aria-selected={e.id === selectedId ? 'true' : undefined}>
                <th scope="row">
                  <button type="button" className="tl-linklike" onClick={() => onSelect?.(e.id)}>
                    {e.title ?? e.slug}
                  </button>
                </th>
                <td>{e.position}</td>
                <td>{e.rank}</td>
                <td>{e.order}</td>
                <td>{e.told_early && e.told_late ? 'early and late' : e.told_early ? 'early' : e.told_late ? 'late' : 'in order'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg className="tl-svg" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Plot of story time against book order. Each dot is an event; use the table for the same facts.">
          <line className="tl-axis" x1={M.left} y1={H - M.bottom} x2={W - M.right} y2={H - M.bottom} />
          <line className="tl-axis" x1={M.left} y1={M.top} x2={M.left} y2={H - M.bottom} />
          {ticksFor(maxPosition).map((n) => (
            <g key={`x${n}`}>
              <line className="tl-grid" x1={x(n)} y1={M.top} x2={x(n)} y2={H - M.bottom} />
              <text className="tl-tick" x={x(n)} y={H - M.bottom + 16} textAnchor="middle">
                {n}
              </text>
            </g>
          ))}
          {ticksFor(maxRank).map((n) => (
            <g key={`y${n}`}>
              <line className="tl-grid" x1={M.left} y1={y(n)} x2={W - M.right} y2={y(n)} />
              <text className="tl-tick" x={M.left - 8} y={y(n) + 4} textAnchor="end">
                {n}
              </text>
            </g>
          ))}
          <text className="tl-axis-label" x={(M.left + W - M.right) / 2} y={H - 6} textAnchor="middle">
            Book order: first scene that tells the event
          </text>
          <text className="tl-axis-label" transform={`translate(12 ${(M.top + H - M.bottom) / 2}) rotate(-90)`} textAnchor="middle">
            Story time: earlier to later
          </text>
          {points.map((p) => (
            <a
              key={p.id}
              href={`#${p.id}`}
              className="tl-dot"
              data-selected={p.id === selectedId ? 'true' : undefined}
              aria-label={`${p.title}: book position ${p.x}, story rank ${p.y}`}
              onMouseEnter={() => setHot(p.id)}
              onMouseLeave={() => setHot(null)}
              onFocus={() => setHot(p.id)}
              onBlur={() => setHot(null)}
              onClick={(e) => {
                e.preventDefault();
                onSelect?.(p.id);
              }}
            >
              <circle cx={x(p.x)} cy={y(p.y)} r={p.id === selectedId ? 7 : 5.5} />
            </a>
          ))}
          {shown && (
            <text className="tl-label" x={Math.min(x(shown.x) + 10, W - 120)} y={Math.max(y(shown.y) - 10, 12)}>
              {shown.title}
            </text>
          )}
        </svg>
      )}
    </section>
  );
}
