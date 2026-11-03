import { useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { GoalDialog } from './GoalsPanel.jsx';
import { InsightsPage } from './InsightsPage.jsx';
import { insightsUrl, parseInsightsSearch } from './model.js';
import { explainGoalFailure, removeGoalRequest, sendRequest, setGoalRequest } from './requests.js';

/**
 * /books/:id/insights. Fetches the numbers (again after every goal change and on the status poll), and the Codex entries once a heat-map cell is pressed (to name its scenes).
 * Adding or removing a goal writes only activity/goals.md.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL (?cell= selects a heat-map cell)
 */
export function InsightsView({ bookId, search = '' }) {
  const { status } = useStatus();
  const { track } = useWrites();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const { data, error, loading } = useApi(insightsUrl(bookId), version);
  const cell = parseInsightsSearch(search);
  const { data: codex } = useApi(cell ? `/api/books/${encodeURIComponent(bookId)}/codex/entries` : null, version);
  const [dialog, setDialog] = useState(null); // { error }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  if (loading && !data) {
    return (
      <main id="main" tabIndex={-1} className="page muted">
        Loading…
      </main>
    );
  }
  if (error) {
    return (
      <main id="main" tabIndex={-1} className="page error">
        {error}
      </main>
    );
  }
  if (!data) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  const write = (r) => track(bookId, () => sendRequest(r));
  async function add(goal) {
    setBusy(true);
    const { status: st, json } = await write(setGoalRequest(bookId, goal));
    setBusy(false);
    if (st === 200) {
      setDialog(null);
      setNotice('Goal added to activity/goals.md.');
      setBump((n) => n + 1);
    } else setDialog({ error: explainGoalFailure(st, json) });
  }
  async function remove(goal) {
    const { status: st, json } = await write(removeGoalRequest(bookId, goal.id));
    if (st === 200) {
      setNotice('Goal removed from activity/goals.md.');
      setBump((n) => n + 1);
    } else setNotice(`Not removed: ${explainGoalFailure(st, json)}`);
  }
  return (
    <>
      <InsightsPage
        bookId={bookId}
        data={data}
        entries={codex?.entries ?? null}
        entryChapters={codex?.chapters ?? null}
        cell={cell}
        goalHandlers={{ onAdd: () => setDialog({ error: null }), onRemove: remove }}
        extra={
          notice ? (
            <p className="muted" role="status">
              {notice}
            </p>
          ) : null
        }
      />
      {dialog && <GoalDialog scopes={data.progress.scopes ?? []} error={dialog.error} busy={busy} onSubmit={add} onClose={() => setDialog(null)} />}
    </>
  );
}
