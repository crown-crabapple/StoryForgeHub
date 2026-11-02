import { useState } from 'react';
import { Link } from '../router.jsx';
import { sceneHref } from '../codex/model.js';
import { TimelineChart } from './TimelineChart.jsx';
import { filterEvents, namesOf, orderLabel, timelineHref, whenLabel } from './model.js';

/** "Told early" / "Told late" badges: information only. @param {{ event: any }} props */
export function TellBadges({ event }) {
  return (
    <>
      {event.told_early && (
        <span className="tag tl-told" title="The book tells this before an event that happens earlier in story time (a flash-forward). Information only.">
          told early
        </span>
      )}
      {event.told_late && (
        <span className="tag tl-told" title="The book tells this after an event that happens later in story time (a flashback). Information only.">
          told late
        </span>
      )}
    </>
  );
}

/**
 * One event: title, when (and date), who, where, the scenes it is told in (links into the manuscript with their chapter), and the told-early / told-late badges.
 * In Story time the card can be dragged to a new place, or moved with Alt+Up / Alt+Down.
 * @param {{ bookId: string, event: any, entries: any[], selected?: boolean, draggable?: boolean, onSelect?: (id: string) => void, onMoveStep?: (id: string, dir: -1 | 1) => void,
 *   onDragStart?: (id: string) => void, onDragEnd?: () => void }} props
 */
export function EventCard({ bookId, event, entries, selected = false, draggable = false, onSelect, onMoveStep, onDragStart, onDragEnd }) {
  const people = namesOf(event.characters, entries);
  const places = namesOf(event.locations, entries);
  const when = whenLabel(event);
  const live = event.scenes.filter((s) => s.state === 'live');
  return (
    <article
      className="tl-card"
      data-event={event.id}
      data-selected={selected ? 'true' : undefined}
      data-stale={event.stale ? 'true' : undefined}
      tabIndex={0}
      draggable={draggable || undefined}
      aria-label={`${event.title ?? event.slug}${when ? `, ${when}` : ''}`}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', event.id);
        onDragStart?.(event.id);
      } : undefined}
      onDragEnd={draggable ? () => onDragEnd?.() : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onMoveStep) {
          e.preventDefault();
          onMoveStep(event.id, e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(event.id);
        }
      }}
    >
      <div className="tl-card-head">
        <h3 className="tl-card-title">
          <button type="button" className="tl-title-button" onClick={() => onSelect?.(event.id)}>
            {event.title ?? event.slug}
          </button>
        </h3>
        <span className="tl-card-order" title="The order value in the file">
          {orderLabel(event.order)}
        </span>
      </div>
      {when && <p className="tl-card-when">{when}</p>}
      <TellBadges event={event} />
      {event.stale && <span className="tag tl-stale">file cannot be read: showing the last valid version</span>}
      {(people.length > 0 || places.length > 0) && (
        <dl className="tl-card-facts">
          {people.length > 0 && (
            <div>
              <dt>Who</dt>
              <dd>{people.join(', ')}</dd>
            </div>
          )}
          {places.length > 0 && (
            <div>
              <dt>Where</dt>
              <dd>{places.join(', ')}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="tl-card-scenes">
        {live.length === 0 ? (
          <span className="muted">Not in the book yet</span>
        ) : (
          <ul>
            {live.map((s) => (
              <li key={s.id}>
                <Link to={sceneHref(bookId, s.id)}>
                  {s.title || 'Untitled scene'}
                </Link>
                {s.chapter_label && <span className="muted"> · {s.chapter_label}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/** The Problems panel: what is wrong or unfinished, each with a way to open the event. @param {{ bookId: string, problems: any[], order?: string, onOpen?: (id: string) => void }} props */
export function ProblemsPanel({ bookId, problems, order = 'story', onOpen }) {
  if (problems.length === 0) return null;
  const real = problems.filter((p) => p.severity !== 'info').length;
  return (
    <details className="tl-problems" open={real > 0 || undefined}>
      <summary>
        Problems <span className="tl-count">{problems.length}</span>
      </summary>
      <ul>
        {problems.map((p, i) => (
          <li key={`${p.event_id}-${p.kind}-${p.code}-${p.location}-${i}`} className={`diag-${p.severity}`} data-kind={p.kind}>
            <strong>{p.code ?? 'Not placed'}</strong> <span>{p.title}</span>
            <div className="muted">{p.message}</div>
            {p.event_id && (
              <Link to={timelineHref(bookId, { event: p.event_id, order })} onClick={() => onOpen?.(p.event_id)}>
                Open the event
              </Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The right column for the selected event: facts, scenes, buttons. @param {{ bookId: string, event: any | null, entries: any[], handlers: Record<string, any> }} props */
export function EventDetail({ bookId, event, entries, handlers }) {
  if (!event) return <p className="muted">Select an event to see its details.</p>;
  const when = whenLabel(event);
  return (
    <div className="tl-detail">
      <h2>{event.title ?? event.slug}</h2>
      {when && <p>{when}</p>}
      <dl className="codex-facts">
        <div>
          <dt>Story time</dt>
          <dd>
            order {orderLabel(event.order)}
            {event.rank !== null && event.rank !== undefined ? `, rank ${event.rank}` : ''}
          </dd>
        </div>
        <div>
          <dt>Book order</dt>
          <dd>{event.position === null ? 'Not in the book yet' : `scene ${event.position}${event.chapter_label ? `, ${event.chapter_label}` : ''}`}</dd>
        </div>
        <div>
          <dt>Who</dt>
          <dd>{event.characters.length > 0 ? namesOf(event.characters, entries).join(', ') : <span className="muted">—</span>}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{event.locations.length > 0 ? namesOf(event.locations, entries).join(', ') : <span className="muted">—</span>}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>
            <code>{event.path}</code>
          </dd>
        </div>
      </dl>
      <h3 className="tl-subhead">Scenes</h3>
      {event.scenes.length === 0 ? (
        <p className="muted">No scene yet.</p>
      ) : (
        <ul className="tl-scene-list">
          {event.scenes.map((s) => (
            <li key={s.id}>
              {s.state === 'live' ? <Link to={sceneHref(bookId, s.id)}>{s.title || 'Untitled scene'}</Link> : <span>{s.title ?? s.id}</span>}
              {s.chapter_label && <span className="muted"> · {s.chapter_label}</span>}
              {s.state !== 'live' && <span className="tag">{s.state}</span>}
              {s.side !== 'both' && s.state === 'live' && <span className="tag" title={s.side === 'event' ? 'The scene does not list this event' : 'The event does not list this scene'}>one side</span>}
            </li>
          ))}
        </ul>
      )}
      {!event.stale && (
        <div className="codex-actions">
          {handlers.onEdit && (
            <button type="button" className="btn" onClick={() => handlers.onEdit(event)}>
              Edit fields…
            </button>
          )}
          {handlers.onScenes && (
            <button type="button" className="btn" onClick={() => handlers.onScenes(event)}>
              Scenes…
            </button>
          )}
          {handlers.onEditText && (
            <button type="button" className="btn" onClick={() => handlers.onEditText(event)}>
              Edit text…
            </button>
          )}
          {handlers.onArchive && (
            <button type="button" className="btn" onClick={() => handlers.onArchive(event)}>
              Archive…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Timeline page (/books/:id/timeline): Story time or Book order, the story-vs-book chart (with a table form), filters, the Problems panel and the event
 * cards. Presentational: everything arrives by props, so tests can render it with fixture JSON.
 * @param {{ bookId: string, data: any, model: ReturnType<typeof import('./model.js').buildTimeline>, order?: 'story' | 'book', filters?: any, selectedId?: string | null,
 *   table?: boolean, archived?: { id: string, title: string | null, slug: string | null }[], handlers?: Record<string, any> }} props
 *   handlers: onOrder(order), onFilters(next), onSelect(id), onTable(on), onNew(), onEdit(event), onScenes(event), onEditText(event), onArchive(event), onRestore(archived),
 *   onReorder(movedId, index), onMoveStep(id, dir)
 */
export function TimelinePage({ bookId, data, model, order = 'story', filters = {}, selectedId = null, table = false, archived = [], handlers = {}, editor = null }) {
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const entries = data?.entries ?? [];
  const keep = new Set(filterEvents(model.events, filters, data, model.problems).map((e) => e.id));
  const show = (list) => list.filter((e) => keep.has(e.id));
  const selected = model.events.find((e) => e.id === selectedId) ?? null;
  const active = [filters.character, filters.location, filters.thread, filters.unplacedOnly, filters.hasProblems].some(Boolean);
  const total = model.events.length;
  const reorderable = order === 'story' && !active && handlers.onReorder;
  const ordered = model.events.filter((e) => e.order !== null);

  // a plain function, not a component: a component defined here would be a new type on every render and remount the zone under the pointer mid-drag
  const drop = (index, key) => (
    <li
      key={key}
      className="tl-drop"
      data-over={over === index ? 'true' : undefined}
      aria-hidden="true"
      onDragOver={(e) => {
        if (dragId) {
          e.preventDefault();
          setOver(index);
        }
      }}
      onDragLeave={() => setOver((o) => (o === index ? null : o))}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain') || dragId;
        setDragId(null);
        setOver(null);
        if (id) handlers.onReorder(id, index);
      }}
    />
  );

  const cards = (list, { drag = false } = {}) => (
    <ol className="tl-list">
      {list.flatMap((e, i) => [
        drag ? drop(dropIndex(ordered, list, i, dragId), `drop-${e.id}`) : null,
        <li key={e.id} className="tl-item">
          <EventCard
            bookId={bookId}
            event={e}
            entries={entries}
            selected={e.id === selectedId}
            draggable={drag && !e.stale}
            onSelect={handlers.onSelect}
            onMoveStep={drag ? handlers.onMoveStep : undefined}
            onDragStart={setDragId}
            onDragEnd={() => {
              setDragId(null);
              setOver(null);
            }}
          />
        </li>,
      ])}
      {drag && list.length > 0 && drop(dropIndex(ordered, list, list.length, dragId), 'drop-end')}
    </ol>
  );

  return (
    <div className="tl">
      <main id="main" tabIndex={-1} className="tl-main">
        {editor ?? (
          <>
            <div className="codex-head">
              <h1>Timeline</h1>
              <span className="codex-counts">{total === 1 ? '1 event' : `${total} events`}</span>
              {handlers.onNew && (
                <button type="button" className="btn btn-primary codex-new" onClick={handlers.onNew}>
                  New event
                </button>
              )}
            </div>

            <div className="toolbar tl-toolbar">
              <div className="chips" role="group" aria-label="Order">
                <button type="button" className="chip" aria-pressed={order === 'story' ? 'true' : 'false'} onClick={() => handlers.onOrder?.('story')}>
                  Story time
                </button>
                <button type="button" className="chip" aria-pressed={order === 'book' ? 'true' : 'false'} onClick={() => handlers.onOrder?.('book')}>
                  Book order
                </button>
              </div>
              <label className="toolbar-sort">
                Character
                <select value={filters.character ?? ''} onChange={(e) => handlers.onFilters?.({ ...filters, character: e.target.value })}>
                  <option value="">Anyone</option>
                  {model.filters.characters.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toolbar-sort">
                Location
                <select value={filters.location ?? ''} onChange={(e) => handlers.onFilters?.({ ...filters, location: e.target.value })}>
                  <option value="">Anywhere</option>
                  {model.filters.locations.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toolbar-sort">
                Thread
                <select value={filters.thread ?? ''} onChange={(e) => handlers.onFilters?.({ ...filters, thread: e.target.value })}>
                  <option value="">Any thread</option>
                  {model.filters.threads.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toolbar-check">
                <input type="checkbox" checked={Boolean(filters.unplacedOnly)} onChange={(e) => handlers.onFilters?.({ ...filters, unplacedOnly: e.target.checked })} /> Unplaced only
              </label>
              <label className="toolbar-check">
                <input type="checkbox" checked={Boolean(filters.hasProblems)} onChange={(e) => handlers.onFilters?.({ ...filters, hasProblems: e.target.checked })} /> Has problems
              </label>
            </div>

            <ProblemsPanel bookId={bookId} problems={model.problems} order={order} onOpen={handlers.onSelect} />

            <TimelineChart model={model} selectedId={selectedId} table={table} onTable={handlers.onTable} onSelect={handlers.onSelect} />

            {total === 0 ? (
              <div className="empty-state">
                <h2>No events yet.</h2>
                <p>Add the first one with New event. An event is something that happens in your story, with the scenes that tell it.</p>
              </div>
            ) : order === 'story' ? (
              <div className="tl-groups" aria-label="Events in story time">
                {reorderable && <p className="muted tl-hint">Drag an event to a new place, or press Alt+Up or Alt+Down on a focused event. Only that event&apos;s order changes.</p>}
                {active && <p className="muted tl-hint">Filters are on, so the order cannot be changed here. Clear them to drag events.</p>}
                {model.story.map((g, gi) => {
                  const list = show(g.events);
                  if (list.length === 0) return null;
                  return (
                    <section key={`${g.when}-${gi}`} className="tl-group" aria-label={g.when ?? 'No date label'}>
                      <h2 className="tl-when">{g.when ?? 'No date label'}</h2>
                      {cards(list, { drag: Boolean(reorderable) })}
                    </section>
                  );
                })}
                {show(model.unordered).length > 0 && (
                  <section className="tl-group" aria-label="No valid order">
                    <h2 className="tl-when">No valid order</h2>
                    {cards(show(model.unordered))}
                  </section>
                )}
                {keep.size === 0 && <p className="muted">No event matches the filters.</p>}
              </div>
            ) : (
              <div className="tl-groups" aria-label="Events in book order">
                {show(model.book.placed).length > 0 && (
                  <section className="tl-group" aria-label="In the book">
                    <h2 className="tl-when">In the book</h2>
                    {cards(show(model.book.placed))}
                  </section>
                )}
                {show(model.book.unplaced).length > 0 && (
                  <section className="tl-group" aria-label="Not in the book yet">
                    <h2 className="tl-when">Not in the book yet</h2>
                    {cards(show(model.book.unplaced))}
                  </section>
                )}
                {keep.size === 0 && <p className="muted">No event matches the filters.</p>}
              </div>
            )}

            {archived.length > 0 && (
              <details className="tl-archived">
                <summary>Archived events ({archived.length})</summary>
                <ul>
                  {archived.map((a) => (
                    <li key={a.id}>
                      <span>{a.title ?? a.slug ?? a.id}</span>
                      {handlers.onRestore && (
                        <button type="button" className="btn row-button" onClick={() => handlers.onRestore(a)}>
                          Restore…
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </main>
      <aside aria-label="Event details" className="tl-aside">
        <EventDetail bookId={bookId} event={selected} entries={entries} handlers={handlers} />
      </aside>
    </div>
  );
}

/**
 * The place among the OTHER events (story time, without the dragged one) a drop zone in front of `list[i]` stands for. `all`: every event with a valid order in story time
 * (the list shown is a part of it when a group is narrower). Computed from the full order so a drop into a group lands in the right place overall.
 */
function dropIndex(all, list, i, dragId) {
  const before = i < list.length ? all.findIndex((e) => e.id === list[i].id) : all.findIndex((e) => e.id === list[list.length - 1].id) + 1;
  const without = all.filter((e) => e.id !== dragId);
  if (!dragId) return before;
  const dragAt = all.findIndex((e) => e.id === dragId);
  return dragAt >= 0 && dragAt < before ? before - 1 : Math.min(before, without.length);
}
