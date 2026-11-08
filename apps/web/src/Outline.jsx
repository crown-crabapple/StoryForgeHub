import { useEffect, useRef, useState } from 'react';
import { Link } from './router.jsx';
import { BookIcon, ChevronDownIcon, FolderIcon } from './shell/icons.jsx';
import { RowMenu } from './structure/RowMenu.jsx';
import { actKey, chapterKey, readCollapsed, writeCollapsed } from './structure/collapse.js';
import { STATUSES, actName, archivedName, archivedScenes, chapterName, povInitial, wordsOf } from './structure/helpers.js';
import { useShortcuts } from './shortcuts/ShortcutsContext.jsx';
import { chapterDropTarget, dropTarget, halfOf, keyboardTarget } from './structure/move-target.js';
import { useStructure } from './structure/useStructure.jsx';
import { bookProgress, chapterProgress } from './writing/scene-context.js';

const EXPAND_MS = 600;
const DRAG_TYPE = 'application/x-storyforge-scene';
const CHAPTER_DRAG_TYPE = 'application/x-storyforge-chapter';
const findScene = (book, id) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).find((s) => s.id === id);

const sceneHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}`;

/** The book's words against its word target, under the rail heading (just the words when there is no target). */
function BookCount({ book }) {
  const words = book.word_count ?? 0;
  const p = bookProgress(words, book.word_target);
  const fmt = (n) => n.toLocaleString('en-US');
  if (!p) return <p className="rail-count">{fmt(words)} words</p>;
  return (
    <div className="rail-count">
      <p>
        {fmt(words)} / {fmt(p.target)} words
      </p>
      <span className="thin-bar" role="progressbar" aria-label="Book words against the word target" aria-valuemin={0} aria-valuemax={p.target} aria-valuenow={Math.min(words, p.target)} aria-valuetext={`${fmt(words)} of ${fmt(p.target)} words`}>
        <span className="thin-bar-fill" style={{ width: `${p.percent}%` }} />
      </span>
    </div>
  );
}

/** A thin bar under a chapter's count: how many of its scenes are final. */
function ChapterBar({ scenes }) {
  const { final, total, percent } = chapterProgress(scenes);
  if (total === 0) return null;
  return (
    <span className="thin-bar" role="progressbar" aria-label="Scenes final" aria-valuemin={0} aria-valuemax={total} aria-valuenow={final} aria-valuetext={`${final} of ${total} scenes final`} title={`${final}/${total} scenes final`}>
      <span className="thin-bar-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Up/Down move between scene links in the rail; Enter opens the focused link (native). Plain Tab works too. */
function moveBetweenScenes(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // Alt+Up / Alt+Down move the scene (see Outline)
  const links = [...e.currentTarget.querySelectorAll('a[data-scene-link]')].filter((l) => l.getClientRects().length > 0);
  const at = links.indexOf(document.activeElement);
  if (at === -1) return;
  const next = links[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/** A small dot for a scene's status: four lightness steps (the first is a ring), plus a text label for screen readers. */
export function StatusDot({ status }) {
  const known = STATUSES.includes(status) ? status : 'none';
  return (
    <span className="status" title={status ?? 'no status'}>
      <span className="status-dot" data-status={known} aria-hidden="true" />
      <span className="sr-only">Status: {status ?? 'none'}</span>
    </span>
  );
}

/** The POV initial in a small chip (the full slug is its text for screen readers and its tooltip). */
export function PovChip({ pov }) {
  if (!pov) return null;
  return (
    <span className="pov-chip" title={`POV: ${pov}`}>
      <span aria-hidden="true">{povInitial(pov)}</span>
      <span className="sr-only">POV {pov}</span>
    </span>
  );
}

/** The collapse toggle of an act or chapter row. Left collapses, Right expands (also native Enter / Space). */
function Toggle({ collapsed, onToggle, name, children }) {
  return (
    <button
      type="button"
      className="outline-toggle"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if ((e.key === 'ArrowLeft' && !collapsed) || (e.key === 'ArrowRight' && collapsed)) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <ChevronDownIcon width={13} height={13} className={collapsed ? 'chevron chevron-closed' : 'chevron'} />
      {children}
    </button>
  );
}

function SceneRow({ book, scene, next, activeId, chapterNode, act, start, dropMark = null, dragging = false, onDragStart }) {
  const name = scene.title || 'Untitled scene';
  const items = [
    { label: 'Rename...', run: () => start({ type: 'rename-scene', scene }) },
    { label: 'Status', items: STATUSES.map((status) => ({ label: status, current: scene.status === status, run: () => start({ type: 'status', scene, status }) })) },
    { label: 'Move...', run: () => start({ type: 'move', scene }) },
    { label: 'Add scene after', run: () => start({ type: 'add-scene', chapter: chapterNode.chapter, act, after: scene.id }) },
    { label: 'Split here...', run: () => start({ type: 'split', scene }) },
    { label: 'Merge with next', disabled: !next, run: () => start({ type: 'merge', scene, next }) },
    { label: 'Edit raw file…', run: () => start({ type: 'raw-file', scene }) },
    { label: 'Archive', run: () => start({ type: 'archive-scene', scene }) },
  ];
  return (
    <li
      className={`outline-scene-item${dragging ? ' is-dragging' : ''}`}
      data-scene-id={scene.id}
      draggable="true"
      onDragStart={onDragStart ? (e) => onDragStart(e, scene) : undefined}
    >
      {dropMark && <span className="drop-line" data-position={dropMark} aria-hidden="true" />}
      <StatusDot status={scene.status} />
      <Link to={sceneHref(book.id, scene.id)} data-scene-link="" draggable={false} className="outline-row outline-scene" aria-current={scene.id === activeId ? 'page' : undefined}>
        <span className="outline-label">{scene.title || <span className="muted">Untitled scene</span>}</span>
        {scene.problem && (
          <span className="badge badge-error" title={scene.problem.message}>
            can't be read
          </span>
        )}
        {scene.origin === 'ai' && scene.status === 'drafting' && (
          <span className="badge" title="Written by an AI and not accepted yet. Change its status to accept it.">
            AI draft
          </span>
        )}
        <span className="outline-words">{scene.word_count}w</span>
        <PovChip pov={scene.pov} />
      </Link>
      <RowMenu name={name} items={items} />
    </li>
  );
}

/** The Archived section: archived scenes of this book, each with Restore. Collapsed by default. */
function ArchivedSection({ book, start }) {
  const [open, setOpen] = useState(false);
  const entries = archivedScenes(book);
  if (entries.length === 0) return null;
  return (
    <section className="outline-archived" aria-label="Archived scenes">
      <button type="button" className="outline-toggle outline-archived-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon width={13} height={13} className={open ? 'chevron' : 'chevron chevron-closed'} />
        <span className="outline-label">Archived</span>
        <span className="outline-words">{entries.length}</span>
      </button>
      <ul hidden={!open} className="outline-archived-list">
        {entries.map((entry) => {
          const name = archivedName(entry.path);
          return (
            <li key={entry.path} className="outline-row outline-archived-item">
              <span className="outline-label" title={entry.path}>
                {name}
              </span>
              <button type="button" className="btn row-button" aria-label={`Restore ${name}`} onClick={() => start({ type: 'restore-scene', entry, name })}>
                Restore
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The manuscript tree (render it with `key={book.id}`: the remembered collapse state belongs to one book): acts, chapters and scenes with status, POV, word counts, collapse and row menus.
 * `onChanged` runs after any structure command wrote (the page reloads the book).
 * @param {{ book: any, activeId?: string | null, onChanged?: (info: any) => void }} props
 */
export function Outline({ book, activeId = null, onChanged, onPickScene = null }) {
  const shortcuts = useShortcuts(); // outline.moveUp / outline.moveDown come from the shortcut registry (M07-J04)
  const [collapsed, setCollapsed] = useState(() => readCollapsed(book.id));
  const [dragId, setDragId] = useState(null);
  const [dragChapter, setDragChapter] = useState(null);
  const [drop, setDrop] = useState(null);
  const [live, setLive] = useState('');
  const root = useRef(null);
  const dragRef = useRef(null);
  const hover = useRef({ key: null, timer: null });
  const focusAfter = useRef(null);

  const setCollapsedKeys = (change) =>
    setCollapsed((prev) => {
      const next = change(new Set(prev));
      writeCollapsed(book.id, next);
      return next;
    });

  const { start, ui, move, moveChapter } = useStructure({
    book,
    activeId,
    onChanged,
    onMoved: (sceneId, target) => {
      // the moved row keeps keyboard focus (its chapter and act are opened so it is visible)
      focusAfter.current = { id: sceneId, book };
      const name = findScene(book, sceneId)?.title || 'Untitled scene';
      setLive(target.text ? `${target.text.replace(/^Move /, 'Moved ')}.` : `Moved ${name}.`);
      setCollapsedKeys((keys) => {
        keys.delete(chapterKey(target.chapter));
        keys.delete(actKey(target.act));
        return keys;
      });
    },
  });

  useEffect(() => {
    const pending = focusAfter.current;
    if (!pending || pending.book === book) return; // wait for the reloaded book: the row is a new element after a move
    const id = pending.id;
    const link = root.current?.querySelector(`[data-scene-id="${id}"] a[data-scene-link]`);
    if (link && link.getClientRects().length > 0) {
      link.focus();
      focusAfter.current = null;
    }
  }, [book, collapsed]);

  useEffect(() => () => clearTimeout(hover.current.timer), []);

  const clearHover = () => {
    clearTimeout(hover.current.timer);
    hover.current = { key: null, timer: null };
  };
  const endDrag = () => {
    clearHover();
    dragRef.current = null;
    setDragId(null);
    setDragChapter(null);
    setDrop(null);
  };

  function beginDrag(e, scene) {
    e.dataTransfer.setData(DRAG_TYPE, scene.id);
    e.dataTransfer.effectAllowed = 'move';
    dragRef.current = { kind: 'scene', id: scene.id };
    setDragId(scene.id);
    setLive(`Picked up ${scene.title || 'Untitled scene'}. Drag over a scene to place it before or after, or over a chapter to put it at the end.`);
  }

  /** A whole chapter is picked up by its row (its scenes stay in it). */
  function beginChapterDrag(e, ch, name) {
    if (e.target instanceof Element && e.target.closest('[data-scene-id]')) return; // a scene row inside starts its own drag
    e.stopPropagation();
    e.dataTransfer.setData(CHAPTER_DRAG_TYPE, String(ch.chapter));
    e.dataTransfer.effectAllowed = 'move';
    dragRef.current = { kind: 'chapter', chapter: ch.chapter };
    setDragChapter(ch.chapter);
    setLive(`Picked up ${name}. Drag over a chapter to place it before or after, or over an act to put it at the end of that act.`);
  }

  /** For a dragged chapter: a chapter row (which half; its scenes count as after it) or an act row. */
  function chapterOverOf(e) {
    const el = e.target instanceof Element ? e.target : null;
    const chRow = el?.closest('[data-chapter-row]');
    if (chRow) return { kind: 'chapter', chapter: Number(chRow.dataset.chapterRow), half: halfOf(e.clientY, chRow.getBoundingClientRect()) };
    const item = el?.closest('[data-chapter-item]');
    if (item) return { kind: 'chapter', chapter: Number(item.dataset.chapterItem), half: 'after' };
    const actRow = el?.closest('[data-act-row]');
    if (actRow) return { kind: 'act', act: Number(actRow.dataset.actRow) };
    return null;
  }

  /** What a drop here would do, for whatever is being dragged. */
  function targetOf(e) {
    const d = dragRef.current;
    if (!d) return null;
    if (d.kind === 'chapter') return chapterDropTarget(book, d.chapter, chapterOverOf(e));
    const over = overOf(e);
    return over ? dropTarget(book, d.id, over) : null;
  }

  /** What is under the pointer: a scene row (and which half) or a chapter row. */
  function overOf(e) {
    const el = e.target instanceof Element ? e.target : null;
    const row = el?.closest('[data-scene-id]');
    if (row) return { kind: 'scene', sceneId: row.dataset.sceneId, half: halfOf(e.clientY, row.getBoundingClientRect()) };
    const ch = el?.closest('[data-chapter-row]');
    if (ch) return { kind: 'chapter', chapter: Number(ch.dataset.chapterRow) };
    return null;
  }

  /** A collapsed chapter (or act) opens after the pointer rests on its row for 600 ms. */
  function hoverExpand(e) {
    const el = e.target instanceof Element ? e.target : null;
    const chapterRow = el?.closest('[data-chapter-row]');
    const actRow = el?.closest('[data-act-row]');
    let key = null;
    if (chapterRow) key = chapterKey(Number(chapterRow.dataset.chapterRow));
    else if (actRow) key = actKey(Number(actRow.dataset.actRow));
    if (key === hover.current.key) return;
    clearHover();
    if (key === null) return;
    hover.current.key = key;
    hover.current.timer = setTimeout(() => {
      setCollapsedKeys((keys) => {
        keys.delete(key);
        return keys;
      });
    }, EXPAND_MS);
  }

  function onDragOver(e) {
    if (!dragRef.current) return;
    if (dragRef.current.kind === 'scene') hoverExpand(e); // a dragged chapter goes between chapters, so nothing needs opening
    const target = targetOf(e);
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
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const target = targetOf(e);
    endDrag();
    if (!target || target.noop) return;
    if (d.kind === 'chapter') {
      const ch = book.acts.flatMap((a) => a.chapters).find((c) => c.chapter === d.chapter);
      if (ch) void moveChapter(ch, { act: target.act, after: target.after });
      return;
    }
    const scene = findScene(book, d.id);
    if (scene) void move(scene, target);
  }

  function onDragLeave(e) {
    if (!root.current?.contains(e.relatedTarget)) {
      clearHover();
      setDrop(null);
    }
  }

  /** outline.moveUp / outline.moveDown (Alt+Up / Alt+Down unless rebound) on a scene row: one slot up or down in book order. */
  function onKeyDown(e) {
    const command = shortcuts.commandFor(e.nativeEvent ?? e, 'outline');
    if (command === 'outline.moveUp' || command === 'outline.moveDown') {
      const el = e.target instanceof Element ? e.target : null;
      const row = el && !el.closest('[role="menu"]') ? el.closest('[data-scene-id]') : null;
      if (row) {
        e.preventDefault();
        const scene = findScene(book, row.dataset.sceneId);
        if (!scene) return;
        const direction = command === 'outline.moveUp' ? 'up' : 'down';
        const target = keyboardTarget(book, scene.id, direction);
        if (!target) setLive(`${scene.title || 'Untitled scene'} is already ${direction === 'up' ? 'first' : 'last'} in the book.`);
        else void move(scene, target);
        return;
      }
    }
    moveBetweenScenes(e);
  }

  const toggle = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(book.id, next);
      return next;
    });

  const sceneDrop = dragChapter === null ? drop : null;
  const chapterDrop = dragChapter !== null && drop && !drop.noop ? drop.indicator : null;
  const endTarget = sceneDrop && !sceneDrop.noop && sceneDrop.indicator.kind === 'end' ? sceneDrop.chapter : null;
  const actTarget = chapterDrop?.kind === 'end' ? chapterDrop.act : null;

  /** The Read view: a plain click on a scene row scrolls the reading page there instead of opening the editor (a modified click still opens a new tab). */
  const pickScene = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest?.('[data-scene-link]');
    const id = link?.closest('[data-scene-id]')?.getAttribute('data-scene-id');
    if (!id) return;
    e.preventDefault();
    onPickScene(id);
  };

  return (
    <div className="outline" ref={root} onClickCapture={onPickScene ? pickScene : undefined} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave} onDragEnd={endDrag}>
      <div className="rail-head">
        <h2 className="rail-heading">{book.title ?? book.slug ?? book.id}</h2>
        <RowMenu name={book.title ?? book.slug ?? book.id} items={[{ label: 'Renumber chapters...', run: () => start({ type: 'renumber' }) }, { label: 'Tidy file names...', run: () => start({ type: 'tidy' }) }]} />
      </div>
      <BookCount book={book} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="move-live">
        {live}
      </div>
      <ul className="outline-acts">
        {book.acts.map((act) => {
          const actCollapsed = collapsed.has(actKey(act.act));
          const aName = actName(act);
          const lastChapter = act.chapters[act.chapters.length - 1];
          return (
            <li key={act.act}>
              <div className={`outline-row outline-act${actTarget === act.act ? ' is-drop-target' : ''}`} data-act-row={act.act} {...(actTarget === act.act ? { 'data-drop': 'end' } : {})}>
                <Toggle collapsed={actCollapsed} onToggle={() => toggle(actKey(act.act))} name={aName}>
                  <FolderIcon width={15} height={15} />
                  <span className="outline-label" title={aName}>{aName}</span>
                </Toggle>
                <span className="outline-words">{wordsOf(act.chapters.flatMap((c) => c.scenes))}w</span>
                <RowMenu
                  name={aName}
                  items={[
                    { label: 'Rename...', run: () => start({ type: 'rename-act', act }) },
                    { label: 'Add chapter', run: () => start({ type: 'add-chapter', act: act.act, ...(lastChapter ? { after: lastChapter.chapter } : {}) }) },
                  ]}
                />
              </div>
              <ul hidden={actCollapsed}>
                {act.chapters.map((ch) => {
                  const chCollapsed = collapsed.has(chapterKey(ch.chapter));
                  const cName = chapterName(ch);
                  const lastScene = ch.scenes[ch.scenes.length - 1];
                  const chapterMark = chapterDrop && chapterDrop.kind !== 'end' && chapterDrop.chapter === ch.chapter ? chapterDrop.kind : null;
                  return (
                    <li key={ch.chapter} className={`outline-chapter-item${dragChapter === ch.chapter ? ' is-dragging' : ''}`} data-chapter-item={ch.chapter}>
                      {chapterMark && <span className="drop-line drop-line-chapter" data-position={chapterMark} aria-hidden="true" />}
                      <div
                        className={`outline-row outline-chapter${endTarget === ch.chapter ? ' is-drop-target' : ''}`}
                        data-chapter-row={ch.chapter}
                        draggable="true"
                        onDragStart={(e) => beginChapterDrag(e, ch, cName)}
                        {...(endTarget === ch.chapter ? { 'data-drop': 'end' } : {})}
                      >
                        <Toggle collapsed={chCollapsed} onToggle={() => toggle(chapterKey(ch.chapter))} name={cName}>
                          <BookIcon width={15} height={15} />
                          <span className="outline-stack">
                            <span className="outline-label" title={cName}>{cName}</span>
                            <span className="outline-words">
                              {ch.scenes.length} {ch.scenes.length === 1 ? 'scene' : 'scenes'}, {wordsOf(ch.scenes)}w
                            </span>
                            <ChapterBar scenes={ch.scenes} />
                          </span>
                        </Toggle>
                        <button
                          type="button"
                          className="row-menu-button"
                          aria-label={`Add scene to ${cName}`}
                          onClick={() => start({ type: 'add-scene', chapter: ch.chapter, act: act.act, after: lastScene ? lastScene.id : null })}
                        >
                          <span aria-hidden="true">+</span>
                        </button>
                        <RowMenu
                          name={cName}
                          items={[
                            { label: 'Rename...', run: () => start({ type: 'rename-chapter', chapter: ch }) },
                            { label: 'Add scene', run: () => start({ type: 'add-scene', chapter: ch.chapter, act: act.act, after: lastScene ? lastScene.id : null }) },
                            { label: 'Add chapter after', run: () => start({ type: 'add-chapter', act: act.act, after: ch.chapter }) },
                            { label: 'Move to act...', run: () => start({ type: 'move-chapter', chapter: ch, name: cName }) },
                            { label: 'Renumber chapters...', run: () => start({ type: 'renumber' }) },
                            { label: 'Archive chapter', run: () => start({ type: 'archive-chapter', chapter: ch, name: cName }) },
                          ]}
                        />
                      </div>
                      <ul hidden={chCollapsed}>
                        {ch.scenes.map((s, i) => (
                          <SceneRow
                            key={s.id}
                            book={book}
                            scene={s}
                            next={ch.scenes[i + 1] ?? null}
                            activeId={activeId}
                            chapterNode={ch}
                            act={act.act}
                            start={start}
                            dropMark={sceneDrop && !sceneDrop.noop && sceneDrop.indicator.sceneId === s.id ? sceneDrop.indicator.kind : null}
                            dragging={dragId === s.id}
                            onDragStart={beginDrag}
                          />
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn row-button outline-new-act" onClick={() => start({ type: 'new-act' })}>
        New act
      </button>
      <ArchivedSection book={book} start={start} />
      {ui}
    </div>
  );
}
