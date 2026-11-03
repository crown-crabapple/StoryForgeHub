import { useState } from 'react';
import { sendRequest } from '../continuity/requests.js';
import { Link } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { createTaskRequest, explainTaskFailure, tasksPageHref } from './model.js';

/**
 * "Make a task" for one finding: writes one task file (planning/tasks/<slug>.md) and never touches prose. The same finding cannot make a second open task: the existing one is offered
 * instead. `source`: `{ from: 'continuity', fingerprint }` or `{ from: 'check', sceneId, finding }`. Says what happened in a status line with a link to the task.
 * @param {{ bookId: string, source: Record<string, any>, onChanged?: () => void, label?: string }} props
 */
export function MakeTaskButton({ bookId, source, onChanged, label = 'Make a task' }) {
  const { track } = useWrites();
  const [state, setState] = useState(/** @type {null | { kind: 'made' | 'exists' | 'error', id?: string, text: string }} */ (null));
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    const { status, json } = await track(bookId, () => sendRequest(createTaskRequest(bookId, source)));
    setBusy(false);
    if (status === 201) {
      setState({ kind: 'made', id: json?.id, text: 'Task made. Your text was not changed.' });
      onChanged?.();
    } else if (json?.code === 'TASK_EXISTS') setState({ kind: 'exists', id: json?.existing?.id, text: 'This finding already has an open task.' });
    else setState({ kind: 'error', text: explainTaskFailure(status, json) });
  }
  return (
    <span className="mt">
      <button type="button" className="btn" disabled={busy} onClick={make}>
        {label}
      </button>
      {state && (
        <span className={state.kind === 'error' ? 'error mt-text' : 'muted mt-text'} role={state.kind === 'error' ? 'alert' : 'status'}>
          {' '}
          {state.text}
          {state.id && (
            <>
              {' '}
              <Link to={tasksPageHref(bookId, state.id)}>{state.kind === 'exists' ? 'Open the task' : 'Open it'}</Link>
            </>
          )}
        </span>
      )}
    </span>
  );
}
