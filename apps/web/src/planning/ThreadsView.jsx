import { useState } from 'react';
import { LEGACY_STATES, THREAD_STATES, stateLabel, visibleThreads } from './model.js';

/** The state of a thread as a chip with its text (colour is never the only cue). @param {{ state: string | null }} props */
export function StateChip({ state }) {
  return (
    <span className="thread-state" data-state={state ?? 'none'}>
      {stateLabel(state)}
    </span>
  );
}

/** The counts of a thread's lists: "S 1 · D 0 · P 1". @param {{ counts: { S: number, D: number, P: number } }} props */
export function ThreadCounts({ counts }) {
  return (
    <span className="thread-counts" aria-label={`${counts.S} setup, ${counts.D} development, ${counts.P} payoff`}>
      <span title="Setup scenes">S {counts.S}</span>
      <span title="Development scenes">D {counts.D}</span>
      <span title="Payoff scenes">P {counts.P}</span>
    </span>
  );
}

/**
 * The lifecycle suggestions of a thread: buttons only, nothing changes until one is pressed.
 * @param {{ thread: import('./model.js').ThreadRow, onSuggest?: (thread: any, to: string) => void }} props
 */
export function Suggestions({ thread, onSuggest }) {
  if (!onSuggest || thread.suggestions.length === 0) return null;
  return (
    <div className="lifecycle" role="group" aria-label={`Suggestions for ${thread.title}`}>
      {thread.suggestions.map((s) => (
        <button key={s.to} type="button" className="btn lifecycle-suggest" data-to={s.to} onClick={() => onSuggest(thread, s.to)}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The threads of the book: title, kind, state chip, counts (S setup, D development, P payoff) and "last touched in Ch N". Filter by state; sorted by
 * where the first setup scene sits in the book. Selecting a thread opens it in the inspector.
 * @param {{ model: ReturnType<typeof import('./model.js').buildModel>, selectedId?: string | null, initialState?: string,
 *   onSelect?: (thread: any) => void, onNewThread?: () => void, onSuggest?: (thread: any, to: string) => void }} props
 */
export function ThreadsView({ model, selectedId = null, initialState = 'all', onSelect, onNewThread, onSuggest }) {
  const [state, setState] = useState(initialState);
  const list = visibleThreads(model.threads, { state });
  const present = new Set(model.threads.map((t) => t.status));
  const states = [...THREAD_STATES, ...LEGACY_STATES.filter((s) => present.has(s))];
  return (
    <div className="threads-view">
      <div className="filter-bar">
        <label>
          <span className="form-label">State</span>
          <select name="state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {stateLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted" role="status">
          {list.length} {list.length === 1 ? 'thread' : 'threads'}
        </span>
        {onNewThread && (
          <button type="button" className="btn btn-primary" onClick={onNewThread}>
            New thread
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="muted">{model.threads.length === 0 ? 'This book has no plot threads yet. Start one with New thread.' : 'No threads in that state.'}</p>
      ) : (
        <ul className="thread-list">
          {list.map((t) => (
            <li key={t.id} className="thread-row" data-thread-id={t.id}>
              <button type="button" className="thread-row-main" aria-pressed={t.id === selectedId ? 'true' : 'false'} onClick={() => onSelect?.(t)}>
                <span className="thread-row-title">{t.title}</span>
                <span className="thread-row-kind muted">{t.kind ?? 'no kind'}</span>
                <StateChip state={t.status} />
                <ThreadCounts counts={t.counts} />
                <span className="thread-row-last muted">{t.lastTouched ? `Last touched in ${t.lastTouched.label}` : 'Not in any scene yet'}</span>
              </button>
              <Suggestions thread={t} onSuggest={onSuggest} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
