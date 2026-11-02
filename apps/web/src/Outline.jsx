import { useState } from 'react';
import { Link } from './router.jsx';
import { BookIcon, ChevronDownIcon, FolderIcon } from './shell/icons.jsx';
import { RowMenu } from './structure/RowMenu.jsx';
import { actKey, chapterKey, readCollapsed, writeCollapsed } from './structure/collapse.js';
import { STATUSES, actName, archivedName, archivedScenes, chapterName, povInitial, wordsOf } from './structure/helpers.js';
import { useStructure } from './structure/useStructure.jsx';

const sceneHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}`;

/** Up/Down move between scene links in the rail; Enter opens the focused link (native). Plain Tab works too. */
function moveBetweenScenes(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
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

function SceneRow({ book, scene, next, activeId, chapterNode, act, start }) {
  const name = scene.title || 'Untitled scene';
  const items = [
    { label: 'Rename...', run: () => start({ type: 'rename-scene', scene }) },
    { label: 'Status', items: STATUSES.map((status) => ({ label: status, current: scene.status === status, run: () => start({ type: 'status', scene, status }) })) },
    { label: 'Add scene after', run: () => start({ type: 'add-scene', chapter: chapterNode.chapter, act, after: scene.id }) },
    { label: 'Split here...', run: () => start({ type: 'split', scene }) },
    { label: 'Merge with next', disabled: !next, run: () => start({ type: 'merge', scene, next }) },
    { label: 'Edit raw file…', run: () => start({ type: 'raw-file', scene }) },
    { label: 'Archive', run: () => start({ type: 'archive-scene', scene }) },
  ];
  return (
    <li className="outline-scene-item">
      <StatusDot status={scene.status} />
      <Link to={sceneHref(book.id, scene.id)} data-scene-link="" className="outline-row outline-scene" aria-current={scene.id === activeId ? 'page' : undefined}>
        <span className="outline-label">{scene.title || <span className="muted">Untitled scene</span>}</span>
        {scene.problem && (
          <span className="badge badge-error" title={scene.problem.message}>
            can't be read
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
export function Outline({ book, activeId = null, onChanged }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(book.id));
  const { start, ui } = useStructure({ book, activeId, onChanged });

  const toggle = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(book.id, next);
      return next;
    });

  return (
    <div className="outline" onKeyDown={moveBetweenScenes}>
      <h2 className="rail-heading">{book.title ?? book.slug ?? book.id}</h2>
      <ul className="outline-acts">
        {book.acts.map((act) => {
          const actCollapsed = collapsed.has(actKey(act.act));
          const aName = actName(act);
          const lastChapter = act.chapters[act.chapters.length - 1];
          return (
            <li key={act.act}>
              <div className="outline-row outline-act">
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
                  return (
                    <li key={ch.chapter}>
                      <div className="outline-row outline-chapter">
                        <Toggle collapsed={chCollapsed} onToggle={() => toggle(chapterKey(ch.chapter))} name={cName}>
                          <BookIcon width={15} height={15} />
                          <span className="outline-stack">
                            <span className="outline-label" title={cName}>{cName}</span>
                            <span className="outline-words">
                              {ch.scenes.length} {ch.scenes.length === 1 ? 'scene' : 'scenes'}, {wordsOf(ch.scenes)}w
                            </span>
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
                            { label: 'Archive chapter', run: () => start({ type: 'archive-chapter', chapter: ch, name: cName }) },
                          ]}
                        />
                      </div>
                      <ul hidden={chCollapsed}>
                        {ch.scenes.map((s, i) => (
                          <SceneRow key={s.id} book={book} scene={s} next={ch.scenes[i + 1] ?? null} activeId={activeId} chapterNode={ch} act={act.act} start={start} />
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
