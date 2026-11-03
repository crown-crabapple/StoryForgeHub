import { useId, useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { goalProgressText, goalTitle, projectionText, streakText } from './model.js';
import { goalFromForm } from './requests.js';

const KINDS = [['words', 'Words'], ['scenes', 'Scenes'], ['chapters', 'Chapters'], ['minutes', 'Minutes']];
const PERIODS = [['day', 'Per day'], ['week', 'Per week'], ['month', 'Per month'], ['total', 'In total']];

/** The window behind "Add a goal": kind, period, target, an optional due date (in total only) and an optional chapter or act. @param {{ scopes: { id: string, kind: string, name: string }[], error?: string | null, busy?: boolean, onSubmit: (goal: any) => void, onClose: () => void }} props */
export function GoalDialog({ scopes, error = null, busy = false, onSubmit, onClose }) {
  const id = useId();
  const [values, setValues] = useState({ kind: 'words', period: 'day', target: '', due: '', scope: '' });
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const shown = problem ?? error;
  return (
    <Dialog label="Add a goal" onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const r = goalFromForm(values);
          if (!r.ok) return setProblem(r.message);
          setProblem(null);
          onSubmit(r.goal);
        }}
      >
        <h2>Add a goal</h2>
        <div className="field">
          <label htmlFor={`${id}-kind`}>Count</label>
          <select id={`${id}-kind`} value={values.kind} onChange={set('kind')}>
            {KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-period`}>Over</label>
          <select id={`${id}-period`} value={values.period} onChange={set('period')}>
            {PERIODS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-target`}>Target</label>
          <input id={`${id}-target`} type="number" min="1" step="1" inputMode="numeric" value={values.target} onChange={set('target')} aria-invalid={shown ? 'true' : 'false'} aria-describedby={shown ? `${id}-err` : undefined} />
        </div>
        {values.period === 'total' && (
          <div className="field">
            <label htmlFor={`${id}-due`}>Due date (optional)</label>
            <input id={`${id}-due`} type="text" inputMode="numeric" placeholder="2027-03-01" value={values.due} onChange={set('due')} />
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-scope`}>Applies to</label>
          <select id={`${id}-scope`} value={values.scope} onChange={set('scope')}>
            <option value="">The whole book</option>
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <p className="field-hint">Saved in activity/goals.md, a Markdown file you can edit.</p>
        {shown && (
          <p id={`${id}-err`} className="error" role="alert">
            {shown}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Add goal
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Every goal with its progress bar (`role="progressbar"`), streak and, for a total goal with a due date, the projected finish. The goal that comes from book.md's daily_word_goal is
 * shown as one and cannot be removed here. `onAdd` opens the dialog; `onRemove(goal)` removes one from goals.md.
 * @param {{ goals: any[], onAdd?: () => void, onRemove?: (goal: any) => void }} props
 */
export function GoalsPanel({ goals, onAdd, onRemove }) {
  return (
    <section className="ins-goals" aria-labelledby="ins-goals-h">
      <div className="ins-chart-head">
        <h3 id="ins-goals-h">Goals</h3>
        {onAdd && (
          <button type="button" className="btn btn-small" onClick={onAdd}>
            Add a goal
          </button>
        )}
      </div>
      {goals.length === 0 ? (
        <p className="muted">No goals yet. A goal is a number to aim at: words a day, scenes a week, minutes in a chapter.</p>
      ) : (
        <ul className="ins-goal-list" aria-label="Goals">
          {goals.map((g) => (
            <li key={g.id} className="ins-goal">
              <div className="ins-goal-head">
                <strong>{goalTitle(g)}</strong>
                {g.scope_name && <span className="tag">{g.scope_name}</span>}
                {g.scope && !g.scope_found && <span className="tag">Chapter or act not found</span>}
                {g.legacy && <span className="tag">From book.md</span>}
              </div>
              <span
                className="progress"
                role="progressbar"
                aria-label={`Progress: ${goalTitle(g)}`}
                aria-valuemin={0}
                aria-valuemax={g.target}
                aria-valuenow={Math.min(g.value, g.target)}
                aria-valuetext={goalProgressText(g)}
              >
                <span className="progress-fill" style={{ width: `${g.percent}%` }} />
              </span>
              <p className="muted ins-goal-text">
                {goalProgressText(g)} ({g.percent}%){g.met ? ' · goal met' : ''}
                {g.streak > 0 ? ` · streak ${streakText(g.streak)}` : ''}
              </p>
              {projectionText(g) && <p className="muted ins-goal-text">{projectionText(g)}</p>}
              {onRemove && !g.legacy && (
                <button type="button" className="btn btn-small" aria-label={`Remove goal: ${goalTitle(g)}`} onClick={() => onRemove(g)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
