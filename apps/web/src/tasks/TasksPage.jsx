import { useId, useRef, useState } from 'react';
import { nextRowIndex } from '../continuity/model.js';
import { Link } from '../router.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { STATUSES, SOURCES, filterTasks, openTargetHref, sourceLabel, statusActions, statusLabel } from './model.js';

/** The window behind "New task": a title and some notes. @param {{ busy?: boolean, error?: string | null, onSubmit: (v: { title: string, notes: string }) => void, onClose: () => void }} props */
export function NewTaskDialog({ busy = false, error = null, onSubmit, onClose }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const missing = title.trim() === '';
  return (
    <Dialog label="New task" onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!missing) onSubmit({ title: title.trim(), notes });
        }}
      >
        <h2>New task</h2>
        <div className="field">
          <label htmlFor={`${id}-title`}>What needs doing?</label>
          <input id={`${id}-title`} type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" aria-required="true" aria-invalid={touched && missing ? 'true' : 'false'} aria-describedby={touched && missing ? `${id}-err` : undefined} />
          {touched && missing && (
            <p id={`${id}-err`} className="error" role="alert">
              Give the task a title.
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-notes`}>Notes (optional)</label>
          <textarea id={`${id}-notes`} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="field-hint">Saved as a Markdown file in planning/tasks/. It never changes your text.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Make task
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** One opened task: its status actions, where it came from, its notes and its targets, each with Open. @param {{ bookId: string, opened: any, busy?: boolean, onStatus: (to: string) => void }} props */
export function TaskDetail({ bookId, opened, busy = false, onStatus }) {
  if (!opened) return <p className="muted">Select a task to see it.</p>;
  const { task, notes, targets } = opened;
  return (
    <article className="cf-detail" aria-label={task.title}>
      <header>
        <p className="muted cf-detail-kind">
          <span className="tag">{statusLabel(task.status)}</span> {sourceLabel(task.source.kind)}
          {task.source.code ? ` · ${task.source.code}` : ''}
        </p>
        <h2>{task.title}</h2>
      </header>
      <div className="cf-actions">
        {statusActions(task.status).map((a, i) => (
          <button key={a.to} type="button" className={i === 0 ? 'btn btn-primary' : 'btn'} disabled={busy} onClick={() => onStatus(a.to)}>
            {a.label}
          </button>
        ))}
      </div>
      {task.source.fingerprint && (
        <p className="cf-fingerprint">
          <span className="muted">Finding </span>
          <code>{task.source.fingerprint}</code>
        </p>
      )}
      {notes.trim() !== '' && (
        <>
          <h3>Notes</h3>
          <p className="tk-notes">{notes.trim()}</p>
        </>
      )}
      <h3>Where</h3>
      {targets.length === 0 ? (
        <p className="muted">This task points at no text.</p>
      ) : (
        <ul className="cf-source-list">
          {targets.map((t, i) => {
            const href = openTargetHref(bookId, t);
            return (
              <li key={`${t.id}|${i}`}>
                <span className="cf-source-label">{t.title ?? t.id}</span>{' '}
                {href ? (
                  <Link to={href} className="btn btn-small" aria-label={`Open ${t.title ?? 'target'}${t.found && t.selection ? ' at the text' : ''}`}>
                    Open
                  </Link>
                ) : null}
                {t.selection && <span className="muted"> line {t.selection.file_line}: “{t.selection.text}”</span>}
                {t.message && <span className="muted tk-warn" role="status"> {t.message}</span>}
                {t.changed && <span className="muted"> The scene has changed since this task was made.</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted">
        File: <code>{task.path}</code>
      </p>
    </article>
  );
}

/**
 * The Tasks page (/books/:id/tasks): filters (status with counts, source, label) on the left, the tasks in the middle (one row in the tab order; ↑ ↓ Home End move, Enter opens),
 * one opened task on the right. Presentational: everything arrives by props.
 * @param {{ bookId: string, data: { tasks: any[], counts: Record<string, number>, labels: string[] }, filter?: { status: string, source: string, label: string }, selectedId?: string | null, opened?: any | null,
 *   busy?: boolean, notice?: string | null, handlers?: { onFilter?: (patch: Record<string, string>) => void, onSelect?: (id: string) => void, onStatus?: (to: string) => void, onNew?: () => void } }} props
 */
export function TasksPage({ bookId, data, filter = { status: '', source: '', label: '' }, selectedId = null, opened = null, busy = false, notice = null, handlers = {} }) {
  const rows = filterTasks(data.tasks, filter);
  const listRef = useRef(null);
  const selectedAt = rows.findIndex((r) => r.id === selectedId);
  const [focusAt, setFocusAt] = useState(/** @type {number | null} */ (null));
  const tabAt = focusAt !== null ? Math.min(focusAt, rows.length - 1) : Math.max(0, selectedAt);
  const set = (patch) => handlers.onFilter?.(patch);
  return (
    <div className="nt cf">
      <aside aria-label="Task filters" className="codex-sidebar">
        <h2 className="codex-sidebar-title">Tasks</h2>
        <button type="button" className="codex-cat" aria-current={filter.status === '' ? 'true' : undefined} onClick={() => set({ status: '' })}>
          <span>All</span>
          <span className="codex-cat-count">{data.counts.total}</span>
        </button>
        {STATUSES.map((s) => (
          <button key={s.key} type="button" className="codex-cat" aria-current={filter.status === s.key ? 'true' : undefined} onClick={() => set({ status: s.key })}>
            <span>{s.label}</span>
            <span className="codex-cat-count">{data.counts[s.key]}</span>
          </button>
        ))}
        <h2 className="codex-sidebar-title cf-side-title">Source</h2>
        <div className="cf-subject">
          <select aria-label="Source" value={filter.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">Any source</option>
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <h2 className="codex-sidebar-title cf-side-title">Label</h2>
        <div className="cf-subject">
          <select aria-label="Label" value={filter.label} onChange={(e) => set({ label: e.target.value })}>
            <option value="">Any label</option>
            {data.labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="nt-main">
        <div className="codex-head">
          <h1>{filter.status ? statusLabel(filter.status) : 'Tasks'}</h1>
          <span className="codex-counts">{rows.length === 1 ? '1 task' : `${rows.length} tasks`}</span>
          {handlers.onNew && (
            <button type="button" className="btn btn-primary page-head-action" onClick={handlers.onNew}>
              New task
            </button>
          )}
        </div>
        <p className="muted cf-advice">Tasks are to-dos for your revision. Making, opening or finishing one never changes your prose.</p>
        {notice && (
          <p className="muted" role="status">
            {notice}
          </p>
        )}
        {rows.length === 0 ? (
          <div className="empty-state">
            <h2>No tasks.</h2>
            <p>{data.counts.total === 0 ? 'Make a task from a continuity finding or an author check, or press New task.' : 'No task matches these filters.'}</p>
          </div>
        ) : (
          <ul
            className="nt-list cf-list"
            aria-label="Tasks"
            ref={listRef}
            onKeyDown={(e) => {
              const buttons = [...(listRef.current?.querySelectorAll('button.cf-row') ?? [])];
              const current = buttons.indexOf(document.activeElement);
              const next = nextRowIndex(current < 0 ? Math.max(tabAt, 0) : current, e.key, buttons.length);
              if (next === null) return;
              e.preventDefault();
              setFocusAt(next);
              buttons[next]?.focus();
            }}
          >
            {rows.map((t, i) => (
              <li key={t.id}>
                <button type="button" className="nt-row cf-row" tabIndex={i === tabAt ? 0 : -1} aria-current={t.id === selectedId ? 'true' : undefined} onClick={() => handlers.onSelect?.(t.id)} onFocus={() => setFocusAt(i)}>
                  <span className="nt-row-title">{t.title}</span>
                  <span className="nt-row-meta">
                    <span className="tag">{statusLabel(t.status)}</span>
                    <span className="muted">{sourceLabel(t.source.kind)}</span>
                    {t.labels.map((l) => (
                      <span key={l} className="tag">
                        {l}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <aside aria-label="Task" className="nt-view">
        <TaskDetail key={opened?.task.id ?? 'none'} bookId={bookId} opened={opened} busy={busy} onStatus={(to) => handlers.onStatus?.(to)} />
      </aside>
    </div>
  );
}
