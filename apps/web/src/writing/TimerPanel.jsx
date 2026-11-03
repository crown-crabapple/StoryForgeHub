import { useId, useState } from 'react';
import { Link } from '../router.jsx';
import { useTimers } from './TimerProvider.jsx';
import { clockText, minutesLeft, parseMinutes, parseWordTarget, remainingMs } from './timers.js';

const NAME = { sprint: 'Sprint', timer: 'Timer' };

/**
 * The time left while a timer runs, in the corner of the project nav: a link back to the Insights page where it is controlled. Draws nothing when no timer runs.
 * @param {{ insightsHref: string }} props
 */
export function TimerChip({ insightsHref }) {
  const { timer } = useTimers();
  if (!timer) return null;
  return (
    <Link to={insightsHref} className="ins-chip" aria-label={`${NAME[timer.kind]} ${timer.status === 'paused' ? 'paused' : 'running'}, ${minutesLeft(timer)} ${minutesLeft(timer) === 1 ? 'minute' : 'minutes'} left. Open it`}>
      <span aria-hidden="true">{clockText(remainingMs(timer))}</span>
    </Link>
  );
}

/**
 * A timer that is running or paused: the time left (the clock itself is not a live region: the minutes are announced in the shared one), Pause / Resume, Finish now, Abandon.
 * Presentational. @param {{ timer: import('./timers.js').Timer, here: boolean, onPause: () => void, onResume: () => void, onFinish: () => void, onAbandon: () => void }} props
 */
export function TimerRunning({ timer, here, onPause, onResume, onFinish, onAbandon }) {
  return (
    <section className="ins-timer" aria-label={`${NAME[timer.kind]} in progress`}>
      <h3>{NAME[timer.kind]}</h3>
      <p className="ins-clock">
        <span role="timer" aria-label="Time left">
          {clockText(remainingMs(timer))}
        </span>{' '}
        <span className="muted">{timer.status === 'paused' ? 'paused' : 'left'}</span>
      </p>
      {timer.wordTarget && <p className="muted">Word target: {timer.wordTarget.toLocaleString('en-US')}</p>}
      {!here && <p className="muted">This one is running for another book.</p>}
      <div className="ins-timer-actions">
        {timer.status === 'paused' ? (
          <button type="button" className="btn" onClick={onResume}>
            Resume
          </button>
        ) : (
          <button type="button" className="btn" onClick={onPause}>
            Pause
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onFinish}>
          Finish now
        </button>
        <button type="button" className="btn" onClick={onAbandon}>
          Abandon
        </button>
      </div>
      <p className="muted ins-note">Finishing adds one row to this month&apos;s sessions file. Abandoning writes nothing.</p>
    </section>
  );
}

/**
 * Start a sprint (N minutes, an optional word target) or a plain timer, and run it: time left, Pause / Resume, Finish now, Abandon. Everything is a real button or field, so it all works
 * from the keyboard; the time left is announced once a minute in the shared live region (not here, so it is not read twice). Finishing writes a row of that kind to the book's sessions
 * file; abandoning writes nothing.
 * @param {{ bookId: string }} props
 */
export function TimerPanel({ bookId }) {
  const { timer, start, pause, resume, finishNow, abandon } = useTimers();
  const id = useId();
  const [kind, setKind] = useState('sprint');
  const [minutes, setMinutes] = useState('25');
  const [words, setWords] = useState('');
  const [error, setError] = useState(null);

  if (timer) return <TimerRunning timer={timer} here={timer.bookId === bookId} onPause={pause} onResume={resume} onFinish={() => void finishNow()} onAbandon={abandon} />;

  const submit = (e) => {
    e.preventDefault();
    const m = parseMinutes(minutes);
    const w = kind === 'sprint' ? parseWordTarget(words) : null;
    if (m === null) return setError('Enter a whole number of minutes from 1 to 240.');
    if (w === undefined) return setError('The word target is a whole number of words, or leave it empty.');
    setError(null);
    start({ kind, minutes: m, bookId, wordTarget: w });
  };
  return (
    <section className="ins-timer" aria-label="Sprint and timer">
      <h3>Sprint or timer</h3>
      <form onSubmit={submit} noValidate>
        <fieldset className="ins-kinds">
          <legend className="sr-only">Kind</legend>
          {['sprint', 'timer'].map((k) => (
            <label key={k} className="ins-radio">
              <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} /> {k === 'sprint' ? 'Sprint' : 'Timer'}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-min`}>Minutes</label>
          <input id={`${id}-min`} type="number" min="1" max="240" step="1" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-invalid={error && parseMinutes(minutes) === null ? 'true' : 'false'} aria-describedby={error ? `${id}-err` : undefined} />
        </div>
        {kind === 'sprint' && (
          <div className="field">
            <label htmlFor={`${id}-words`}>Word target (optional)</label>
            <input id={`${id}-words`} type="number" min="1" step="1" inputMode="numeric" value={words} onChange={(e) => setWords(e.target.value)} />
          </div>
        )}
        {error && (
          <p id={`${id}-err`} className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary">
          Start
        </button>
      </form>
      <p className="muted ins-note">A sprint counts toward the words you write; a timer is a plain countdown. Both can be paused.</p>
    </section>
  );
}
