import { useState } from 'react';
import { PovChip } from '../Outline.jsx';
import { Link } from '../router.jsx';
import { STATUSES } from '../structure/helpers.js';
import { LabelChips } from '../world/LabelChip.jsx';
import { LabelFilter } from '../world/LabelChip.jsx';
import { planHref } from '../planner/requests.js';
import { BadgeChips, ThreadTags } from './BoardView.jsx';
import { badgeChips, beatGroups, primaryStructure } from './badges.js';
import { chapterShort, outlineRows, sceneHref, sceneKeep } from './model.js';
import './plan-badges.css';

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
 *   onSetFields?: (card: any, patch: { summary?: string, status?: string }) => void, badges?: any }} props
 * With `badges` (the Story Planner projection) the table gains a Plan column, Arc and Beat filters and a Group by Chapter | Beat choice.
 */
export function OutlineView({ bookId, model, initialFilters = {}, onSetFields, badges = null }) {
  const [filters, setFilters] = useState({ status: initialFilters.status ?? '', pov: initialFilters.pov ?? '', thread: initialFilters.thread ?? '', label: initialFilters.label ?? '', arc: '', beat: '' });
  const [group, setGroup] = useState('chapter');
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const structure = primaryStructure(badges);
  const cols = badges ? 8 : 7;
  const groups = outlineRows(model, { ...filters, badges });
  const byBeat = badges && structure && group === 'beat' ? beatGroups(model, badges, sceneKeep({ ...filters, badges })) : null;
  const shown = byBeat ? new Set(byBeat.flatMap((g) => g.scenes.map((s) => s.id))).size : groups.reduce((n, g) => n + g.chapters.reduce((m, c) => m + c.scenes.length, 0), 0);
  const filtering = Boolean(filters.status || filters.pov || filters.thread || filters.label || (badges && (filters.arc || filters.beat)));
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
        {badges && (
          <label>
            <span className="form-label">Arc</span>
            <select name="arc" value={filters.arc} onChange={(e) => set('arc', e.target.value)}>
              <option value="">All arcs</option>
              {(badges.arcs ?? []).map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {badges && structure && (
          <label>
            <span className="form-label">Beat</span>
            <select name="beat" value={filters.beat} onChange={(e) => set('beat', e.target.value)}>
              <option value="">All beats</option>
              {(structure.beats ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {badges && structure && (
          <label>
            <span className="form-label">Group by</span>
            <select name="group" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="chapter">Chapter</option>
              <option value="beat">Beat</option>
            </select>
          </label>
        )}
        {filtering && (
          <button type="button" className="btn" onClick={() => setFilters({ status: '', pov: '', thread: '', label: '', arc: '', beat: '' })}>
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
            {badges && <th scope="col">Plan</th>}
          </tr>
        </thead>
        {byBeat
          ? byBeat
              .filter((g) => !g.none || g.scenes.length > 0)
              .map((g) => (
                <tbody key={g.key} data-beat={g.none ? undefined : g.key} data-no-beat={g.none ? 'true' : undefined}>
                  <tr className="outline-table-act">
                    <th scope="colgroup" colSpan={cols}>
                      {g.name}{' '}
                      <span className="muted">
                        ({g.scenes.length} {g.scenes.length === 1 ? 'scene' : 'scenes'})
                      </span>
                    </th>
                  </tr>
                  {g.scenes.length === 0 && (
                    <tr>
                      <td colSpan={cols} className="muted pb-group-empty">
                        No scenes yet
                      </td>
                    </tr>
                  )}
                  {g.scenes.map((card) => (
                    <SceneRow key={card.id} bookId={bookId} card={card} onSetFields={onSetFields} labelDefs={model.labelDefs} badges={badges} />
                  ))}
                </tbody>
              ))
          : groups.map(({ act, chapters }) => (
              <tbody key={act.act} data-act={act.act}>
                <tr className="outline-table-act">
                  <th scope="colgroup" colSpan={cols}>
                    {act.name}
                  </th>
                </tr>
                {chapters.map(({ chapter, scenes, words }) => (
                  <ChapterRows key={chapter.chapter} bookId={bookId} chapter={chapter} scenes={scenes} words={words} onSetFields={onSetFields} labelDefs={model.labelDefs} badges={badges} />
                ))}
              </tbody>
            ))}
      </table>
      {(byBeat ? shown === 0 : groups.length === 0) && <p className="muted">{filtering ? 'No scenes match these filters.' : 'This book has no scenes yet.'}</p>}
    </div>
  );
}

function ChapterRows({ bookId, chapter, scenes, words, onSetFields, labelDefs, badges }) {
  return (
    <>
      <tr className="outline-table-chapter" data-chapter={chapter.chapter}>
        <th scope="rowgroup" colSpan={5}>
          {chapter.name}
        </th>
        <td className="outline-table-total" colSpan={badges ? 3 : 2}>
          {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}, {words} words
        </td>
      </tr>
      {scenes.map((card) => (
        <SceneRow key={card.id} bookId={bookId} card={card} onSetFields={onSetFields} labelDefs={labelDefs} badges={badges} />
      ))}
    </>
  );
}

const PLAN_FACE = { purpose: false, links: true, beats: true, milestones: true, missing: false };

function SceneRow({ bookId, card, onSetFields, labelDefs, badges }) {
  return (
    <tr className="outline-table-scene" data-scene-id={card.id}>
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
      {badges && (
        <td className="pb-plan-cell">
          <BadgeChips chips={badgeChips(badges, card, PLAN_FACE)} />
          <Link to={planHref(bookId, { view: 'flow', node: card.id })} aria-label={`Open ${card.title || 'Untitled scene'} in Plan`}>
            Open in Plan
          </Link>
        </td>
      )}
    </tr>
  );
}
