// AI Activity (M12): everything AI connections (plugin tokens, MCP clients) changed in this book, newest first, each with Undo. It sits at the end of the Insights
// page: nothing new in the navigation, and Insights is where the author already looks at what happened in the book. The list is GET /api/books/:b/ai-activity (read
// from the op journal); Undo is the same op restore route every other undo uses, so a change that was edited since is refused with the server's own message.
import { useState } from 'react';
import { useApi } from '../api.js';
import { explainFailure } from '../structure/helpers.js';
import { sendRequest, undoOpRequest } from '../continuity/requests.js';
import { useWrites } from '../shell/writes.jsx';

/** @param {string} bookId */
export const aiActivityUrl = (bookId) => `/api/books/${encodeURIComponent(bookId)}/ai-activity`;

/** "2026-11-07 14:03" from an ISO time (UTC), or the text as it came. @param {string} at */
export const whenText = (at) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? `${at.slice(0, 10)} ${at.slice(11, 16)} UTC` : at);

/** The name of a connection as the author knows it: the `mcp-` prefix is how Settings stores it. @param {{ kind?: string, name?: string }} actor */
export const actorName = (actor) => (actor?.name ?? 'an AI connection').replace(/^mcp-/, '');

/**
 * The list from the server's answer (also used by tests).
 * @param {{ items: any[] | null, readOnly?: boolean, error?: string | null, busy?: string | null, message?: string | null, onUndo?: (item: any) => void }} props `items` null while loading
 */
export function AiActivityView({ items, error = null, busy = null, message = null, onUndo = () => {}, onArchive = () => {}, readOnly = false }) {
  return (
    <section aria-labelledby="ai-activity-h" className="ai-activity">
      <h2 id="ai-activity-h">AI Activity</h2>
      <p className="muted">Everything an AI connection changed in this book, newest first. Undo puts a change back, as long as the file has not been edited since.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="muted">
          {message}
        </p>
      )}
      {items === null && !error ? (
        <p className="muted">Loading…</p>
      ) : items !== null && items.length === 0 ? (
        <p className="muted">No AI connection has changed this book yet.</p>
      ) : (
        <ul className="ai-profile-list ai-activity-list">
          {(items ?? []).map((it) => (
            <li key={it.opId} className="ai-profile-row ai-activity-row">
              <p>
                <strong>{actorName(it.actor)}</strong> <span className="muted">{whenText(it.at)}</span>
              </p>
              <p>{it.summary}</p>
              {it.undone ? (
                <p className="muted">Undone.</p>
              ) : readOnly ? null : it.archivable ? (
                // a scene or chapter the AI created: a created file cannot be undone, so the author archives it (nothing is deleted)
                <button type="button" className="btn btn-small" disabled={busy !== null} aria-label={`Archive: ${it.summary}`} onClick={() => onArchive(it)}>
                  {busy === it.opId ? 'Archiving…' : 'Archive'}
                </button>
              ) : it.undoable ? (
                <button type="button" className="btn btn-small" disabled={busy !== null} aria-label={`Undo: ${it.summary}`} onClick={() => onUndo(it)}>
                  {busy === it.opId ? 'Undoing…' : 'Undo'}
                </button>
              ) : (
                <p className="muted">This change cannot be undone automatically.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The AI Activity section of a book's Insights page. @param {{ bookId: string, version?: string }} props `version`: changes when the book does, to reload the list; `readOnly` (a viewer or reviewer) hides Undo and Archive */
export function AiActivityPanel({ bookId, version = '', readOnly = false }) {
  const { track } = useWrites();
  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [message, setMessage] = useState(/** @type {string | null} */ (null));
  const { data, error } = useApi(aiActivityUrl(bookId), `${version}|${bump}`);
  async function undo(/** @type {any} */ item) {
    setBusy(item.opId);
    setMessage(null);
    const { status, json } = await track(bookId, () => sendRequest(undoOpRequest(bookId, item.opId)));
    setBusy(null);
    setMessage(status === 200 ? 'Undone.' : `Not undone: ${explainFailure(status, json)}`);
    setBump((n) => n + 1);
  }
  /** Archive a scene or chapter the AI created, through the app's own archive routes (a scene needs its current sha256). */
  async function archive(/** @type {any} */ item) {
    setBusy(item.opId);
    setMessage(null);
    const base = `/api/books/${encodeURIComponent(bookId)}`;
    let request = { method: 'POST', url: `${base}/chapters/${encodeURIComponent(String(item.target?.id))}/archive`, body: {} };
    if (item.target?.kind === 'scene') {
      const fresh = await fetch(`${base}/scenes/${encodeURIComponent(item.target.id)}`, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
      request = { method: 'POST', url: `${base}/scenes/${encodeURIComponent(item.target.id)}/archive`, body: { base_sha256: fresh?.sha256 ?? '' } };
    }
    const { status, json } = await track(bookId, () => sendRequest(request));
    setBusy(null);
    setMessage(status === 200 ? 'Archived. It is in the archive folder; nothing was deleted.' : `Not archived: ${explainFailure(status, json)}`);
    setBump((n) => n + 1);
  }
  return <AiActivityView items={data?.activity ?? null} error={error} busy={busy} message={message} onUndo={undo} onArchive={archive} readOnly={readOnly} />;
}
