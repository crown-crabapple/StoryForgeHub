// What the Tasks page shows and sends, worked out from the API answers. Pure: no DOM, no fetch.
//   GET  /api/books/:b/tasks        -> { tasks: [{ id, slug, title, status, source: { kind, code, fingerprint }, targets: [{ id, line, quote }], created, labels, path }], counts, labels }
//   GET  /api/books/:b/tasks/:id    -> { task, notes, targets: [{ id, kind, title, path, found, reason, message, selection: { line, file_line, from, to, text } | null, changed }] }
//   POST /api/books/:b/tasks        { from?, fingerprint?, sceneId?, finding?, title?, notes?, labels?, targets? }
//   POST /api/books/:b/tasks/:id/status { status }
import { codexHref } from '../codex/model.js';
import { viewHref } from '../planning/model.js';
import { timelineHref } from '../timeline/model.js';

const enc = encodeURIComponent;

export const STATUSES = [
  { key: 'open', label: 'Open' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' },
  { key: 'dropped', label: 'Dropped' },
];
export const SOURCES = [
  { key: 'continuity', label: 'Continuity' },
  { key: 'check', label: 'Check' },
  { key: 'manual', label: 'Manual' },
];
export const statusLabel = (key) => STATUSES.find((s) => s.key === key)?.label ?? key;
export const sourceLabel = (key) => SOURCES.find((s) => s.key === key)?.label ?? key;

/** GET: the tasks. @param {string} bookId */
export const tasksUrl = (bookId) => `/api/books/${enc(bookId)}/tasks`;
/** GET: one task, opened. @param {string} bookId @param {string} id */
export const taskUrl = (bookId, id) => `/api/books/${enc(bookId)}/tasks/${enc(id)}`;
/** /books/:id/tasks with an optional selected task. @param {string} bookId @param {string | null} [task] */
export const tasksPageHref = (bookId, task = null) => `/books/${enc(bookId)}/tasks${task ? `?task=${enc(task)}` : ''}`;
/** @param {string} search the query string @returns {{ task: string | null, status: string | null }} */
export function parseTasksSearch(search = '') {
  const p = new URLSearchParams(search);
  const status = p.get('status');
  return { task: p.get('task') || null, status: STATUSES.some((s) => s.key === status) ? status : null };
}

/** POST: make a task. @param {string} bookId @param {Record<string, any>} body */
export const createTaskRequest = (bookId, body) => ({ method: /** @type {const} */ ('POST'), url: tasksUrl(bookId), body });
/** POST: change a task's status. @param {string} bookId @param {string} id @param {string} status */
export const statusRequest = (bookId, id, status) => ({ method: /** @type {const} */ ('POST'), url: `${tasksUrl(bookId)}/${enc(id)}/status`, body: { status } });

/** The tasks a filter keeps: `status` ('' = all), `source` ('' = all), `label` ('' = all, compared case-insensitively). @param {any[]} tasks @param {{ status?: string, source?: string, label?: string }} [f] */
export function filterTasks(tasks, { status = '', source = '', label = '' } = {}) {
  const fold = (s) => s.trim().toLowerCase();
  return tasks.filter((t) => (!status || t.status === status) && (!source || t.source.kind === source) && (!label || t.labels.some((l) => fold(l) === fold(label))));
}

/**
 * Where "Open" goes for one target of an opened task. A scene that is found opens with its quote selected (`select=from-to`, offsets in the body, and the line); a scene whose quote is not
 * found opens plain with a notice that says so; a target that is not a scene opens in its own place. Null when the target no longer exists.
 * @param {string} bookId @param {{ id: string, kind: string | null, found: boolean, selection: { line: number, from: number, to: number } | null }} t
 */
export function openTargetHref(bookId, t) {
  if (t.kind === null) return null;
  if (t.kind === 'entry') return codexHref(bookId, { entry: t.id });
  if (t.kind === 'event') return timelineHref(bookId, { event: t.id });
  if (t.kind === 'thread') return viewHref(bookId, 'threads', { thread: t.id });
  const p = new URLSearchParams({ scene: t.id });
  if (t.found && t.selection) {
    p.set('line', String(t.selection.line));
    p.set('select', `${t.selection.from}-${t.selection.to}`);
  } else if (!t.found) p.set('notice', 'quote-not-found');
  return `/books/${enc(bookId)}?${p.toString()}`;
}

/** The selection a URL asks the editor to make: `select=from-to`, or null. @param {string} search @returns {{ from: number, to: number } | null} */
export function parseSelect(search = '') {
  const m = /^(\d{1,9})-(\d{1,9})$/.exec(new URLSearchParams(search).get('select') ?? '');
  return m && Number(m[2]) >= Number(m[1]) ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

/** The sentence a page shows when it was opened with a `notice`. @param {string} search */
export function noticeText(search = '') {
  return new URLSearchParams(search).get('notice') === 'quote-not-found' ? 'The text this task points at can no longer be found in this scene. It was probably reworded, or it now occurs in more than one place, so StoryForge did not guess. The scene is open.' : null;
}

/** The next status buttons for a task: what the author can do from its status. @param {string} status */
export function statusActions(status) {
  if (status === 'open') return [{ to: 'doing', label: 'Start' }, { to: 'done', label: 'Mark done' }, { to: 'dropped', label: 'Drop' }];
  if (status === 'doing') return [{ to: 'done', label: 'Mark done' }, { to: 'open', label: 'Back to open' }, { to: 'dropped', label: 'Drop' }];
  return [{ to: 'open', label: 'Reopen' }];
}

/** The sentence after a refusal. @param {number} status @param {any} json */
export function explainTaskFailure(status, json) {
  if (json?.code === 'TASK_EXISTS') return 'This finding already has an open task.';
  if (json?.code === 'FINDING_NOT_FOUND') return 'This finding is gone: the text or the facts changed. Reload the page.';
  if (json?.code === 'REFUSED_UNSIMPLE_FIELD') return 'The status line of this task file was edited by hand into something the app will not rewrite. Change it in the file.';
  if (status === 0) return 'The server could not be reached.';
  if (status === 403) return 'The server refused the request.';
  if (status === 404) return 'That task is not there any more. Reload the page.';
  return json?.message ?? `The change was not made (${json?.code ?? status}).`;
}
