import { useEffect, useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { StateChip } from './ThreadsView.jsx';
import { ROLES, matrixCell, sceneHref } from './model.js';

/** The menu of one cell: "Mark as setup / development / payoff" for an empty cell, "Remove" for a filled one. Escape closes it. */
function CellMenu({ thread, card, cell, onMark, onClose }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeRef.current(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  const name = card.title || 'Untitled scene';
  const filled = cell.roles.length > 0;
  const pick = (list, present) => {
    onClose(true);
    onMark(thread, list, card.id, present);
  };
  return (
    <ul
      ref={ref}
      role="menu"
      aria-label={`${thread.title} in ${name}`}
      className="matrix-menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const nodes = [...ref.current.querySelectorAll('button')];
          const at = nodes.indexOf(document.activeElement);
          const next = nodes[(at + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
    >
      {filled
        ? ROLES.filter((r) => cell.roles.includes(r.key)).map((r) => (
            <li key={r.list} role="none">
              <button type="button" role="menuitem" onClick={() => pick(r.list, false)}>
                {cell.roles.length === 1 ? 'Remove' : `Remove from ${r.label}`}
              </button>
            </li>
          ))
        : ROLES.map((r) => (
            <li key={r.list} role="none">
              <button type="button" role="menuitem" onClick={() => pick(r.list, true)}>
                {r.verb}
              </button>
            </li>
          ))}
    </ul>
  );
}

/**
 * The phone form of the matrix (M08-J04): the 2D table does not fit 360 px, so each thread is a heading with the scenes that use it in book order and the role in each
 * (setup, development, payoff). Read only; the table is the place to mark. Shown below 768 px; the table is shown from 768 px up (responsive.css).
 * @param {{ bookId: string, model: ReturnType<typeof import('./model.js').buildModel> }} props
 */
export function MatrixList({ bookId, model }) {
  return (
    <div className="matrix-list" data-testid="matrix-list">
      {model.threads.map((t) => {
        const used = model.scenes.map((card) => ({ card, cell: matrixCell(model, t, card.id) })).filter((x) => x.cell.roles.length > 0 || x.cell.dot);
        return (
          <section key={t.id} className="matrix-thread" aria-label={`Scenes of ${t.title}`}>
            <h2 className="matrix-thread-title">
              {t.title} <StateChip state={t.status} />
            </h2>
            {used.length === 0 ? (
              <p className="muted">No scene uses this thread yet.</p>
            ) : (
              <ul>
                {used.map(({ card, cell }) => (
                  <li key={card.id}>
                    <Link to={sceneHref(bookId, card.id)}>{card.title || <span className="muted">Untitled scene</span>}</Link>
                    <span className="muted"> {cell.roles.length > 0 ? cell.roles.map((r) => ROLES.find((x) => x.key === r).label).join(', ') : "named in the scene's own thread list"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The scene-by-thread matrix: scenes down in book order (grouped by chapter), threads across, each header with its state chip. A cell shows S / D / P from the
 * thread's lists, or a dot when only the scene's own `plot_threads` names the thread. Pressing a cell opens its menu.
 * `onMark(thread, list, sceneId, present)` edits the thread file (present = add).
 * @param {{ bookId: string, model: ReturnType<typeof import('./model.js').buildModel>, onMark?: (thread: any, list: string, sceneId: string, present: boolean) => void }} props
 */
export function MatrixView({ bookId, model, onMark }) {
  const [open, setOpen] = useState(null); // `${threadId}|${sceneId}`
  const triggers = useRef(new Map());
  const close = (refocus) => {
    const key = open;
    setOpen(null);
    if (refocus && key) setTimeout(() => triggers.current.get(key)?.focus(), 0);
  };
  if (model.threads.length === 0) return <p className="muted">This book has no plot threads yet. Create one in the Threads list.</p>;
  const columns = model.threads;
  return (
    <>
      <MatrixList bookId={bookId} model={model} />
      <div className="matrix-wrap">
      <table className="matrix" aria-label="Scenes by plot thread">
        <thead>
          <tr>
            <th scope="col" className="matrix-corner">
              Scene
            </th>
            {columns.map((t) => (
              <th key={t.id} scope="col" className="matrix-col" data-thread-id={t.id}>
                <span className="matrix-col-title">{t.title}</span>
                <StateChip state={t.status} />
              </th>
            ))}
          </tr>
        </thead>
        {model.chapters.map((ch) => (
          <tbody key={ch.chapter} data-chapter={ch.chapter}>
            <tr className="matrix-chapter">
              <th scope="rowgroup" colSpan={columns.length + 1}>
                {ch.name}
              </th>
            </tr>
            {ch.scenes.map((card) => (
              <tr key={card.id} data-scene-id={card.id}>
                <th scope="row" className="matrix-scene">
                  <Link to={sceneHref(bookId, card.id)}>{card.title || <span className="muted">Untitled scene</span>}</Link>
                </th>
                {columns.map((t) => {
                  const cell = matrixCell(model, t, card.id);
                  const key = `${t.id}|${card.id}`;
                  const text = cell.roles.length > 0 ? cell.roles.join(' ') : cell.dot ? '•' : '';
                  const label =
                    cell.roles.length > 0
                      ? `${t.title} in ${card.title || 'Untitled scene'}: ${cell.roles.map((r) => ROLES.find((x) => x.key === r).label).join(', ')}`
                      : cell.dot
                        ? `${t.title} in ${card.title || 'Untitled scene'}: named in the scene's own thread list`
                        : `${t.title} in ${card.title || 'Untitled scene'}: not used`;
                  return (
                    <td key={t.id} className="matrix-cell" data-roles={cell.roles.join('')} data-dot={cell.dot ? 'true' : undefined}>
                      {onMark ? (
                        <>
                          <button
                            type="button"
                            className="matrix-button"
                            aria-label={label}
                            aria-haspopup="menu"
                            aria-expanded={open === key}
                            ref={(el) => {
                              if (el) triggers.current.set(key, el);
                              else triggers.current.delete(key);
                            }}
                            onClick={() => setOpen(open === key ? null : key)}
                          >
                            <span aria-hidden="true">{text}</span>
                          </button>
                          {open === key && <CellMenu thread={t} card={card} cell={cell} onMark={onMark} onClose={close} />}
                        </>
                      ) : (
                        <span aria-label={label}>{text}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      </div>
    </>
  );
}
