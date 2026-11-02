import { useId, useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { goalLine, goalPercent, parseGoal, signed, streakLabel } from './goal.js';
import { useWriting } from './WritingContext.jsx';

/** The small dialog behind "Set a daily goal": one number. @param {{ current: number | null, onSave: (n: number) => Promise<{ ok: boolean, message?: string }>, onClose: () => void }} props */
export function GoalDialog({ current, onSave, onClose }) {
  const id = useId();
  const [text, setText] = useState(current ? String(current) : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const n = parseGoal(text);
    if (n === null) {
      setError('Enter a whole number of words, 1 or more.');
      return;
    }
    setBusy(true);
    const r = await onSave(n);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.message ?? 'The goal was not saved.');
  };
  return (
    <Dialog label="Daily word goal" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Daily word goal</h2>
        <div className="field">
          <label htmlFor={id}>Words per day</label>
          <input id={id} type="number" min="1" step="1" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={error ? 'true' : 'false'} />
          <p className="field-hint">Saved in book.md as daily_word_goal.</p>
        </div>
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
            Save goal
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The goal card at the top of the right rail: today's words against the daily goal (a progress bar), this session's words and the streak.
 * Numbers come from the server's writing log and update live from each save's `words`.
 */
export function GoalCard() {
  const { activity, session, setGoal } = useWriting();
  const [dialog, setDialog] = useState(false);
  const today = activity?.today ?? { added: 0, removed: 0, net: 0, minutes: 0, sessions: 0 };
  const goal = activity?.goal ?? null;
  const streak = streakLabel(activity?.streak ?? 0);
  const percent = goalPercent(today.net, goal);
  const line = goalLine(today, goal);
  return (
    <section className="goal-card" aria-label="Daily goal">
      <p className="goal-line">{line}</p>
      {goal && (
        <div
          className="goal-bar"
          role="progressbar"
          aria-label="Today's words against the daily goal"
          aria-valuemin={0}
          aria-valuemax={goal}
          aria-valuenow={Math.max(0, Math.min(goal, today.net))}
          aria-valuetext={`${today.net} of ${goal} words`}
        >
          <span className="goal-bar-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className="goal-meta">
        <span className="goal-session">This session {signed(session.net)}</span>
        {streak && <span className="goal-streak">Streak {streak}</span>}
      </p>
      <button type="button" className="link-button" onClick={() => setDialog(true)}>
        {goal ? 'Change daily goal' : 'Set a daily goal'}
      </button>
      {dialog && <GoalDialog current={goal} onSave={setGoal} onClose={() => setDialog(false)} />}
    </section>
  );
}
