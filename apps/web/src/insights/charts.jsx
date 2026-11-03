import { useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { barSize, fmt, heatLevel, labelIndexes, nextCell, firstCell } from './model.js';

/** A plain table: the accessible form of every chart. @param {{ caption: string, head: string[], rows: (string | number)[][] }} props */
export function DataTable({ caption, head, rows }) {
  return (
    <div className="ins-table-wrap">
      <table className="ins-table">
        <caption className="muted">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={`${h}|${i}`} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{typeof cell === 'number' ? fmt(cell) : cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One chart with its heading, a "Show as table" button (aria-pressed) and the table form. `chart` is the SVG; `table` is a <DataTable/>. With `empty` set the message is shown instead.
 * @param {{ title: string, id: string, note?: string, empty?: string | null, chart: import('react').ReactNode, table: import('react').ReactNode, defaultTable?: boolean }} props
 */
export function ChartFrame({ title, id, note = '', empty = null, chart, table, defaultTable = false }) {
  const [asTable, setAsTable] = useState(defaultTable);
  return (
    <section className="ins-chart" aria-labelledby={`${id}-h`}>
      <div className="ins-chart-head">
        <h3 id={`${id}-h`}>{title}</h3>
        {!empty && (
          <button type="button" className="btn btn-small" aria-pressed={asTable ? 'true' : 'false'} onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Show as chart' : 'Show as table'}
          </button>
        )}
      </div>
      {note && <p className="muted ins-note">{note}</p>}
      {empty ? <p className="muted">{empty}</p> : asTable ? table : chart}
    </section>
  );
}

const CW = 560;
const CH = 150;
const CM = { left: 36, right: 8, top: 8, bottom: 22 };

/**
 * Columns, one per item (chapters, days, events by chapter). An item with an `href` is a link to its source. Tick labels are sparse; every column has its value in its name.
 * @param {{ label: string, items: { key: string, label: string, value: number, href?: string | null, name: string }[], tickLabel?: (item: any, i: number) => string }} props
 */
export function ColumnChart({ label, items, tickLabel = (it) => it.label }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  const w = (CW - CM.left - CM.right) / Math.max(1, items.length);
  const h = CH - CM.top - CM.bottom;
  const ticks = new Set(labelIndexes(items.length, 8));
  return (
    <svg className="ins-svg" viewBox={`0 0 ${CW} ${CH}`} role="group" aria-label={label}>
      <line className="ins-axis" x1={CM.left} y1={CH - CM.bottom} x2={CW - CM.right} y2={CH - CM.bottom} />
      <text className="ins-tick" x={CM.left - 6} y={CM.top + 8} textAnchor="end">
        {fmt(max)}
      </text>
      <text className="ins-tick" x={CM.left - 6} y={CH - CM.bottom} textAnchor="end">
        0
      </text>
      {items.map((it, i) => {
        const bh = barSize(it.value, max, h);
        const x = CM.left + i * w;
        const bar = <rect className="ins-bar" x={x + w * 0.12} y={CH - CM.bottom - bh} width={Math.max(1, w * 0.76)} height={bh} />;
        return it.href ? (
          <Link key={it.key} to={it.href} className="ins-link" aria-label={it.name}>
            <rect className="ins-hit" x={x} y={CM.top} width={w} height={h} />
            {bar}
          </Link>
        ) : (
          <g key={it.key}>
            <title>{it.name}</title>
            {bar}
          </g>
        );
      })}
      {items.map((it, i) =>
        ticks.has(i) ? (
          <text key={`t${it.key}`} className="ins-tick" x={CM.left + i * w + w / 2} y={CH - 6} textAnchor="middle">
            {tickLabel(it, i)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

const RH = 28;

/**
 * Horizontal bars, one per row: label, bar, value. A row with an `href` is a link to its source.
 * @param {{ label: string, rows: { key: string, label: string, value: number, text?: string, href?: string | null, name: string }[] }} props
 */
export function BarList({ label, rows }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const LW = 150;
  const VW = 90;
  const bw = CW - LW - VW - 8;
  return (
    <svg className="ins-svg" viewBox={`0 0 ${CW} ${Math.max(1, rows.length) * RH + 4}`} role="group" aria-label={label}>
      {rows.map((r, i) => {
        const y = i * RH + 2;
        const body = (
          <>
            <rect className="ins-hit" x={0} y={y} width={CW} height={RH - 2} />
            <text className="ins-label" x={0} y={y + 17}>
              {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
            </text>
            <rect className="ins-track" x={LW} y={y + 6} width={bw} height={12} rx={3} />
            <rect className="ins-bar" x={LW} y={y + 6} width={barSize(r.value, max, bw)} height={12} rx={3} />
            <text className="ins-value" x={CW} y={y + 17} textAnchor="end">
              {r.text ?? fmt(r.value)}
            </text>
          </>
        );
        return r.href ? (
          <Link key={r.key} to={r.href} className="ins-link" aria-label={r.name}>
            {body}
          </Link>
        ) : (
          <g key={r.key}>
            <title>{r.name}</title>
            {body}
          </g>
        );
      })}
    </svg>
  );
}

const CELL = 22;
const HEAD = 24;
const LEFT = 150;

/**
 * The heat map: characters down, chapters across, the number of scenes in each cell. A cell with scenes is a link (to this page with that cell selected: one tab stop, arrow keys move
 * between the cells that have scenes, Enter opens the cell's scenes below the map). Rows are links to the entry. Series entries are badged.
 * @param {{ bookId: string, chapters: { chapter: number, label: string }[], rows: { id: string, name: string, shared: boolean, total: number, cells: number[] }[],
 *   selected: { id: string, chapter: number } | null, cellHref: (id: string, chapter: number) => string,
 *   chapterShort: (c: any) => string, entryHref: (id: string) => string }} props
 */
export function HeatMap({ chapters, rows, selected, cellHref, chapterShort, entryHref }) {
  const grid = rows.map((r) => r.cells);
  const max = Math.max(0, ...grid.flat());
  const start = firstCell(grid);
  const selectedAt = selected ? { row: rows.findIndex((r) => r.id === selected.id), col: chapters.findIndex((c) => c.chapter === selected.chapter) } : null;
  const [rove, setRove] = useState(/** @type {{ row: number, col: number } | null} */ (null));
  const tab = rove ?? (selectedAt && selectedAt.row >= 0 && selectedAt.col >= 0 ? selectedAt : start);
  const svgRef = useRef(null);
  const width = LEFT + chapters.length * CELL + 8;
  const height = HEAD + rows.length * CELL + 4;
  const focusCell = (c) => {
    setRove(c);
    svgRef.current?.querySelector(`[data-cell="${c.row}:${c.col}"]`)?.focus();
  };
  return (
    <div className="ins-heat-scroll">
      <svg
        ref={svgRef}
        className="ins-svg ins-heat"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label="Heat map of characters by chapter. Each cell is the number of scenes; press a cell for its scenes. Use the table for the same facts."
      >
        {chapters.map((c, i) => (
          <text key={c.chapter} className="ins-tick" x={LEFT + i * CELL + CELL / 2} y={HEAD - 8} textAnchor="middle">
            {chapters.length > 24 && i % Math.ceil(chapters.length / 24) !== 0 ? '' : c.chapter}
          </text>
        ))}
        {rows.map((r, ri) => (
          <g key={r.id}>
            <Link to={entryHref(r.id)} className="ins-link" aria-label={`${r.name}${r.shared ? ' (series entry)' : ''}, in ${r.total} ${r.total === 1 ? 'scene' : 'scenes'}`}>
              <text className="ins-label" x={0} y={HEAD + ri * CELL + 15}>
                {(r.name.length > 20 ? `${r.name.slice(0, 19)}…` : r.name) + (r.shared ? ' ◆' : '')}
              </text>
            </Link>
            {r.cells.map((n, ci) => {
              const x = LEFT + ci * CELL;
              const y = HEAD + ri * CELL;
              if (n === 0) return <rect key={ci} className="ins-cell" data-level="0" x={x + 1} y={y + 1} width={CELL - 2} height={CELL - 2} rx={3} aria-hidden="true" />;
              const on = selected?.id === r.id && selected.chapter === chapters[ci].chapter;
              return (
                <Link
                  key={ci}
                  to={cellHref(r.id, chapters[ci].chapter)}
                  data-cell={`${ri}:${ci}`}
                  tabIndex={tab && tab.row === ri && tab.col === ci ? 0 : -1}
                  aria-current={on ? 'true' : undefined}
                  aria-label={`${r.name}, ${chapterShort(chapters[ci])}: ${n} ${n === 1 ? 'scene' : 'scenes'}`}
                  className="ins-cell-btn"
                  onFocus={() => setRove({ row: ri, col: ci })}
                  onKeyDown={(e) => {
                    const next = nextCell(grid, ri, ci, e.key);
                    if (next) {
                      e.preventDefault();
                      focusCell(next);
                    }
                  }}
                >
                  <rect className="ins-cell" data-level={heatLevel(n, max)} data-on={on ? 'true' : undefined} x={x + 1} y={y + 1} width={CELL - 2} height={CELL - 2} rx={3} />
                  <text className="ins-cell-n" x={x + CELL / 2} y={y + 15} textAnchor="middle">
                    {n}
                  </text>
                </Link>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * The thread matrix: threads down, chapters across; a cell shows which of planted / developed / paid (S, D, P) the thread has there. Rows are links to the thread.
 * @param {{ chapters: { chapter: number, label: string }[], rows: { id: string, title: string, cells: number[][], planted: number, developed: number, paid: number }[], threadHref: (id: string) => string }} props
 */
export function ThreadMatrix({ chapters, rows, threadHref }) {
  const width = LEFT + chapters.length * CELL + 8;
  const height = HEAD + rows.length * CELL + 4;
  return (
    <div className="ins-heat-scroll">
      <svg className="ins-svg ins-heat" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="group" aria-label="Plot threads by chapter: S planted, D developed, P paid. Use the table for the same facts.">
        {chapters.map((c, i) => (
          <text key={c.chapter} className="ins-tick" x={LEFT + i * CELL + CELL / 2} y={HEAD - 8} textAnchor="middle">
            {chapters.length > 24 && i % Math.ceil(chapters.length / 24) !== 0 ? '' : c.chapter}
          </text>
        ))}
        {rows.map((t, ri) => (
          <g key={t.id}>
            <Link to={threadHref(t.id)} className="ins-link" aria-label={`${t.title}: planted ${t.planted}, developed ${t.developed}, paid ${t.paid}`}>
              <text className="ins-label" x={0} y={HEAD + ri * CELL + 15}>
                {t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title}
              </text>
            </Link>
            {t.cells.map((c, ci) => {
              const letters = `${c[0] ? 'S' : ''}${c[1] ? 'D' : ''}${c[2] ? 'P' : ''}`;
              const any = c[0] + c[1] + c[2] + c[3] > 0;
              return (
                <g key={ci} aria-hidden="true">
                  <rect className="ins-cell" data-level={any ? (letters ? 3 : 1) : 0} x={LEFT + ci * CELL + 1} y={HEAD + ri * CELL + 1} width={CELL - 2} height={CELL - 2} rx={3} />
                  {any && (
                    <text className="ins-cell-n" x={LEFT + ci * CELL + CELL / 2} y={HEAD + ri * CELL + 15} textAnchor="middle">
                      {letters || '·'}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
