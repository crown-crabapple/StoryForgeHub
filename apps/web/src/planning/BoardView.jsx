import { useRef, useState } from 'react';
import { PovChip, StatusDot } from '../Outline.jsx';
import { LabelChips, LabelFilter } from '../world/LabelChip.jsx';
import { hasLabel } from '../world/model.js';
import { Link } from '../router.jsx';
import { RowMenu } from '../structure/RowMenu.jsx';
import { useShortcuts } from '../shortcuts/ShortcutsContext.jsx';
import { dropTarget, halfOf, keyboardTarget } from '../structure/move-target.js';
import { ROLES, chapterShiftTarget, sceneHref } from './model.js';

const DRAG_TYPE = 'application/x-storyforge-card';

/** The thread tags of a card: the thread's title and, for each list it names the scene in, a small S / D / P marker. @param {{ tags: import('./model.js').Tag[] }} props */
export function ThreadTags({ tags }) {
  if (tags.length === 0) return null;
  return (
    <ul className="card-tags" aria-label="Plot threads">
      {tags.map((t) => (
        <li key={t.thread_id} className="thread-tag" data-thread-id={t.thread_id}>
          <span className="thread-tag-title">{t.title}</span>
          {t.roles.map((r) => (
            <abbr key={r} className="thread-role" data-role={r} title={ROLES.find((x) => x.key === r)?.label}>
              {r}
            </abbr>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * One card: title (a link to the scene in the Write view), summary or "No summary yet", status dot and label, POV initial, word count, thread tags.
 * @param {{ bookId: string, card: import('./model.js').Card, dropMark?: 'before' | 'after' | null, dragging?: boolean,
 *   onDragStart?: (e: any, card: any) => void, onEdit?: (card: any) => void, onMoveDialog?: (card: any) => void, labelDefs?: any[] | null }} props
 *   A scene's labels show as chips under its summary.
 */
export function BoardCard({ bookId, card, dropMark = null, dragging = false, onDragStart, onEdit, onMoveDialog, labelDefs = null }) {
  const name = card.title || 'Untitled scene';
  const items = [
    ...(onEdit ? [{ label: 'Edit card...', run: () => onEdit(card) }] : []),
    ...(onMoveDialog ? [{ label: 'Move...', run: () => onMoveDialog(card) }] : []),
  ];
  return (
    <li className={`board-card${dragging ? ' is-dragging' : ''}`} data-scene-id={card.id} draggable={onDragStart ? 'true' : undefined} onDragStart={onDragStart ? (e) => onDragStart(e, card) : undefined}>
      {dropMark && <span className="drop-line" data-position={dropMark} aria-hidden="true" />}
      <div className="board-card-head">
        <Link to={sceneHref(bookId, card.id)} draggable={false} className="board-card-title" data-scene-link="">
          {card.title || <span className="muted">Untitled scene</span>}
        </Link>
        {items.length > 0 && <RowMenu name={name} items={items} scope="board card" />}
      </div>
      <p className={card.summary === '' ? 'board-card-summary muted' : 'board-card-summary'}>{card.summary === '' ? 'No summary yet' : card.summary}</p>
      <div className="board-card-meta">
        <span className="board-card-status">
          <StatusDot status={card.status} />
          <span>{card.status ?? 'no status'}</span>
        </span>
        <PovChip pov={card.pov} />
        <span className="board-card-words">{card.word_count} words</span>
      </div>
      <LabelChips labels={card.labels} defs={labelDefs} label={`Labels of ${name}`} />
      <ThreadTags tags={card.tags} />
    </li>
  );
}

/**
 * The corkboard: act headings, one column per chapter, cards in book order. Drag a card between or within columns (the same move as in the
 * manuscript tree: the server checks what you saw, neighbours are renumbered after a preview, Undo restores it exactly); Alt+Left / Alt+Right moves the focused
 * card to the end of the previous / next chapter, Alt+Up / Alt+Down one slot, and "Move..." in the card menu does it without dragging.
 * Presentational: the page gives `onMove(card, target)` (target = { chapter, act, after, text }), `onNewCard(chapter)`, `onEdit(card)`, `onMoveDialog(card)`.
 * @param {{ bookId: string, model: ReturnType<typeof import('./model.js').buildModel>,
 *   onMove?: (card: any, target: any) => void, onNewCard?: (chapter: any) => void, onEdit?: (card: any) => void, onMoveDialog?: (card: any) => void }} props
 */
export function BoardView({ bookId, model, onMove, onNewCard, onEdit, onMoveDialog }) {
  const shortcuts = useShortcuts(); // the card-moving keys come from the shortcut registry (M07-J04)
  const [dragId, setDragId] = useState(null);
  const [drop, setDrop] = useState(null);
  const [live, setLive] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const dragRef = useRef(null);
  const root = useRef(null);
  const book = model.book;

  const endDrag = () => {
    dragRef.current = null;
    setDragId(null);
    setDrop(null);
  };
  function beginDrag(e, card) {
    e.dataTransfer.setData(DRAG_TYPE, card.id);
    e.dataTransfer.effectAllowed = 'move';
    dragRef.current = card.id;
    setDragId(card.id);
    setLive(`Picked up ${card.title || 'Untitled scene'}. Drag over a card to place it before or after, or over a column to put it at the end.`);
  }
  /** What is under the pointer: a card (and which half) or a column. */
  function overOf(e) {
    const el = e.target instanceof Element ? e.target : null;
    const row = el?.closest('[data-scene-id]');
    if (row) return { kind: 'scene', sceneId: row.dataset.sceneId, half: halfOf(e.clientY, row.getBoundingClientRect()) };
    const col = el?.closest('[data-chapter-column]');
    if (col) return { kind: 'chapter', chapter: Number(col.dataset.chapterColumn) };
    return null;
  }
  function onDragOver(e) {
    if (!dragRef.current) return;
    const over = overOf(e);
    const target = over ? dropTarget(book, dragRef.current, over) : null;
    if (target && !target.noop) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    } else {
      e.dataTransfer.dropEffect = 'none';
    }
    const same = (a, b) => (!a && !b) || (a && b && a.text === b.text && a.noop === b.noop);
    setDrop((prev) => (same(prev, target) ? prev : target));
    const text = target ? (target.noop ? 'Drop here to leave it where it is.' : `${target.text}.`) : '';
    setLive((prev) => (prev === text ? prev : text));
  }
  function onDrop(e) {
    const id = dragRef.current;
    if (!id) return;
    e.preventDefault();
    const over = overOf(e);
    const target = over ? dropTarget(book, id, over) : null;
    endDrag();
    const card = model.sceneById.get(id);
    if (target && !target.noop && card) onMove?.(card, target);
  }
  function onDragLeave(e) {
    if (!root.current?.contains(e.relatedTarget)) setDrop(null);
  }
  /** board.moveUp / moveDown / chapterBack / chapterForward (Alt+arrows unless rebound) on a card. */
  function onKeyDown(e) {
    const command = shortcuts.commandFor(e.nativeEvent ?? e, 'board');
    if (command === null) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el || el.closest('[role="menu"]')) return;
    const row = el.closest('[data-scene-id]');
    const card = row ? model.sceneById.get(row.dataset.sceneId) : null;
    if (!card) return;
    e.preventDefault();
    const sideways = command === 'board.chapterBack' || command === 'board.chapterForward';
    const target = sideways ? chapterShiftTarget(book, card.id, command === 'board.chapterBack' ? 'left' : 'right') : keyboardTarget(book, card.id, command === 'board.moveUp' ? 'up' : 'down');
    if (!target) {
      const name = card.title || 'Untitled scene';
      setLive(
        command === 'board.chapterBack' ? `${name} is already in the first chapter.` : command === 'board.chapterForward' ? `${name} is already in the last chapter.` : `${name} is already ${command === 'board.moveUp' ? 'first' : 'last'} in the book.`,
      );
      return;
    }
    onMove?.(card, target);
  }

  const endTarget = drop && !drop.noop && drop.indicator.kind === 'end' ? drop.chapter : null;

  return (
    <div className="board" ref={root} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave} onDragEnd={endDrag}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="board-live">
        {live}
      </div>
      {(model.labelDefs ?? []).length + model.scenes.filter((s) => s.labels.length > 0).length > 0 && (
        <form className="filter-bar" onSubmit={(e) => e.preventDefault()} aria-label="Board filters">
          <LabelFilter defs={model.labelDefs} used={model.scenes.map((s) => s.labels)} value={labelFilter} onChange={setLabelFilter} />
          {labelFilter !== '' && (
            <button type="button" className="btn" onClick={() => setLabelFilter('')}>
              Clear filter
            </button>
          )}
        </form>
      )}
      {model.acts.length === 0 && <p className="muted">This book has no chapters yet.</p>}
      {model.acts.map((act) => (
        <section key={act.act} className="board-act" aria-label={act.name}>
          <h2 className="board-act-title">{act.name}</h2>
          <div className="board-columns">
            {act.chapters.map((ch) => (
              <section
                key={ch.chapter}
                className={`board-column${endTarget === ch.chapter ? ' is-drop-target' : ''}`}
                data-chapter-column={ch.chapter}
                aria-label={ch.name}
              >
                <header className="board-column-head">
                  <h3>{ch.name}</h3>
                  <span className="muted">
                    {ch.scenes.length} {ch.scenes.length === 1 ? 'card' : 'cards'}, {ch.words}w
                  </span>
                </header>
                <ul className="board-cards">
                  {ch.scenes.filter((card) => hasLabel(card, labelFilter)).map((card) => (
                    <BoardCard
                      key={card.id}
                      bookId={bookId}
                      card={card}
                      dropMark={drop && !drop.noop && drop.indicator.sceneId === card.id ? drop.indicator.kind : null}
                      dragging={dragId === card.id}
                      onDragStart={onMove ? beginDrag : undefined}
                      onEdit={onEdit}
                      onMoveDialog={onMoveDialog}
                      labelDefs={model.labelDefs}
                    />
                  ))}
                </ul>
                {ch.scenes.length === 0 && <p className="board-empty muted">No cards in this chapter yet.</p>}
                {onNewCard && (
                  <button type="button" className="btn board-add" onClick={() => onNewCard(ch)}>
                    Add a card
                  </button>
                )}
              </section>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
