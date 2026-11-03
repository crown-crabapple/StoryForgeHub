import { useState } from 'react';
import { PovChip } from '../Outline.jsx';
import { Link } from '../router.jsx';
import { STATUSES } from '../structure/helpers.js';
import { LabelChips } from '../world/LabelChip.jsx';
import { LabelFilter } from '../world/LabelChip.jsx';
import { ThreadTags } from './BoardView.jsx';
import { chapterShort, outlineRows, sceneHref } from './model.js';

/**
 * The summary of a row: its text with an Edit button; editing is one line (Enter saves, Escape cancels, leaving the box saves).
 * @param {{ card: any, onSave?: (card: any, summary: string) => void }} props
 */
function SummaryCell({ card, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.summary);
  const name = card.title || 'Untitled scene';
  const finish = (save) => {
    setEditing(false);
    const next = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (save && next !== card.summary) onSave?.(card, next);
    else setText(card.summary);
  };
  if (editing) {
    return (
      <input
        type="text"
        className="outline-edit"
        aria-label={`Summary of ${name}`}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <span className="outline-summary">
      <span className={card.summary === '' ? 'muted' : undefined}>{card.summary === '' ? 'No summary yet' : card.summary}</span>
      {onSave && (
        <button
          type="button"
          className="btn row-button"
          aria-label={`Edit summary of ${name}`}
          onClick={() => {
            setText(card.summary);
            setEditing(true);
          }}
        >
          Edit
        </button>
      )}
    </span>
  );
}

/**
 * The outline as a table: Chapter, Scene, Summary, POV, Status, Words, Threads, grouped by act and chapter (each chapter row has its totals). Rows link to
 * the scene in the Write view. Summary and status can be edited in place (`onSetFields(card, { summary } | { status })`). Filters: status, POV, thread, label. A scene's labels show as chips.
 * @param {{ bookId: string, model: ReturnType<typeof import('./model.js').buildModel>, initialFilters?: { status?: string, pov?: string, thread?: string },
 *   onSetFields?: (card: any, patch: { summary?: string, status?: string }) => void }} props
 */
export function OutlineView({ bookId, model, initialFilters = {}, onSetFields }) {
  const [filters, setFilters] = useState({ status: initialFilters.status ?? '', pov: initialFilters.pov ?? '', thread: initialFilters.thread ?? '', label: initialFilters.label ?? '' });
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const groups = outlineRows(model, filters);
  const shown = groups.reduce((n, g) => n + g.chapters.reduce((m, c) => m + c.scenes.length, 0), 0);
  const filtering = Boolean(filters.status || filters.pov || filters.thread || filters.label);
  return (
    <div className="outline-view">
      <form className="filter-bar" onSubmit={(e) => e.preventDefault()} aria-label="Outline filters">
        <label>
          <span className="form-label">Status</span>
          <select name="status" value={filters.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="form-label">POV</span>
          <select name="pov" value={filters.pov} onChange={(e) => set('pov', e.target.value)}>
            <option value="">All POVs</option>
            {model.povs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="form-label">Thread</span>
          <select name="thread" value={filters.thread} onChange={(e) => set('thread', e.target.value)}>
            <option value="">All threads</option>
            {model.threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <LabelFilter defs={model.labelDefs} used={model.scenes.map((s) => s.labels)} value={filters.label} onChange={(v) => set('label', v)} />
        {filtering && (
          <button type="button" className="btn" onClick={() => setFilters({ status: '', pov: '', thread: '', label: '' })}>
            Clear filters
          </button>
        )}
        <span className="muted" role="status">
          {shown} {shown === 1 ? 'scene' : 'scenes'}
          {filtering ? ' match' : ''}
        </span>
      </form>
      <table className="outline-table">
        <thead>
          <tr>
            <th scope="col">Chapter</th>
            <th scope="col">Scene</th>
            <th scope="col">Summary</th>
            <th scope="col">POV</th>
            <th scope="col">Status</th>
            <th scope="col">Words</th>
            <th scope="col">Threads</th>
          </tr>
        </thead>
        {groups.map(({ act, chapters }) => (
          <tbody key={act.act} data-act={act.act}>
            <tr className="outline-table-act">
              <th scope="colgroup" colSpan={7}>
                {act.name}
              </th>
            </tr>
            {chapters.map(({ chapter, scenes, words }) => (
              <ChapterRows key={chapter.chapter} bookId={bookId} chapter={chapter} scenes={scenes} words={words} onSetFields={onSetFields} labelDefs={model.labelDefs} />
            ))}
          </tbody>
        ))}
      </table>
      {groups.length === 0 && <p className="muted">{filtering ? 'No scenes match these filters.' : 'This book has no scenes yet.'}</p>}
    </div>
  );
}

function ChapterRows({ bookId, chapter, scenes, words, onSetFields, labelDefs }) {
  return (
    <>
      <tr className="outline-table-chapter" data-chapter={chapter.chapter}>
        <th scope="rowgroup" colSpan={5}>
          {chapter.name}
        </th>
        <td className="outline-table-total" colSpan={2}>
          {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}, {words} words
        </td>
      </tr>
      {scenes.map((card) => (
        <tr key={card.id} className="outline-table-scene" data-scene-id={card.id}>
          <td>{chapterShort(card.chapter)}</td>
          <th scope="row">
            <Link to={sceneHref(bookId, card.id)}>{card.title || <span className="muted">Untitled scene</span>}</Link>
            <LabelChips labels={card.labels} defs={labelDefs} label={`Labels of ${card.title || 'Untitled scene'}`} />
          </th>
          <td>
            <SummaryCell card={card} onSave={onSetFields ? (c, summary) => onSetFields(c, { summary }) : undefined} />
          </td>
          <td>{card.pov ? <PovChip pov={card.pov} /> : <span className="muted">-</span>}</td>
          <td>
            {onSetFields ? (
              <select aria-label={`Status of ${card.title || 'Untitled scene'}`} value={card.status ?? ''} onChange={(e) => onSetFields(card, { status: e.target.value })}>
                {card.status === null && <option value="">no status</option>}
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : (
              (card.status ?? 'no status')
            )}
          </td>
          <td className="outline-table-words">{card.word_count}</td>
          <td>
            <ThreadTags tags={card.tags} />
          </td>
        </tr>
      ))}
    </>
  );
}
