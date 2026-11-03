import { useState } from 'react';
import { useApi } from '../api.js';
import { sendRequest } from '../continuity/requests.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { NewTaskDialog, TasksPage } from './TasksPage.jsx';
import { createTaskRequest, explainTaskFailure, parseTasksSearch, statusRequest, taskUrl, tasksPageHref, tasksUrl } from './model.js';

/**
 * /books/:id/tasks. Fetches the list and the open task (again after every write and on the status poll); the open task is kept in the URL (?task=). Changing a status edits one line
 * of that task's file; New task writes one new file; nothing else is ever written here.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function TasksView({ bookId, search = '' }) {
  const { status } = useStatus();
  const { track } = useWrites();
  const navigate = useNavigate();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const url = parseTasksSearch(search);
  const { data, error, loading } = useApi(tasksUrl(bookId), version);
  const { data: opened } = useApi(url.task ? taskUrl(bookId, url.task) : null, version);
  const [filter, setFilter] = useState({ status: url.status ?? '', source: '', label: '' });
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
  async function setStatus(to) {
    if (!url.task) return;
    setBusy(true);
    const { status: st, json } = await write(statusRequest(bookId, url.task, to));
    setBusy(false);
    if (st === 200) {
      setNotice(`Marked ${to}.`);
      setBump((n) => n + 1);
    } else setNotice(`Not changed: ${explainTaskFailure(st, json)}`);
  }
  async function make({ title, notes }) {
    setBusy(true);
    const { status: st, json } = await write(createTaskRequest(bookId, { title, ...(notes.trim() ? { notes } : {}) }));
    setBusy(false);
    if (st === 201) {
      setDialog(null);
      setNotice('Task made.');
      setBump((n) => n + 1);
      navigate(tasksPageHref(bookId, json?.id ?? null));
    } else setDialog({ error: explainTaskFailure(st, json) });
  }
  return (
    <>
      <TasksPage
        bookId={bookId}
        data={data}
        filter={filter}
        selectedId={url.task}
        opened={opened}
        busy={busy}
        notice={notice}
        handlers={{
          onFilter: (patch) => setFilter((f) => ({ ...f, ...patch })),
          onSelect: (id) => navigate(tasksPageHref(bookId, id)),
          onStatus: setStatus,
          onNew: () => setDialog({ error: null }),
        }}
      />
      {dialog && <NewTaskDialog busy={busy} error={dialog.error} onSubmit={make} onClose={() => setDialog(null)} />}
    </>
  );
}
