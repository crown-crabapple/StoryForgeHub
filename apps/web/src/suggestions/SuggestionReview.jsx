import { STATUS_LABEL, hunkSides, lineRange, outcomeText, providerLine, sourceLabelOf } from './model.js';

/** The words of one column; changed words are marked (<del> in the original, <ins> in the proposal), never by colour alone. */
function Words({ parts }) {
  return (
    <pre className="sg-text">
      {parts.map((p, i) => (p.type === 'del' ? <del key={i}>{p.text}</del> : p.type === 'add' ? <ins key={i}>{p.text}</ins> : <span key={i}>{p.text}</span>))}
    </pre>
  );
}

/**
 * One hunk: its line range, status chip, the original and the proposed text side by side with the changed words marked, and Accept / Decline while it is pending.
 * @param {{ hunk: any, newFile?: boolean, busy?: boolean, handlers?: { onAccept?: (id: string) => void, onDecline?: (id: string) => void } }} props
 */
export function HunkView({ hunk, newFile = false, busy = false, handlers = {} }) {
  const sides = hunkSides(hunk);
  const pending = hunk.status === 'pending';
  return (
    <li className="sg-hunk" data-status={hunk.status} aria-label={`Hunk ${hunk.id}`}>
      <div className="sg-hunk-head">
        <strong>{newFile ? 'New file' : lineRange(hunk)}</strong>
        <span className="sg-chip" data-status={hunk.status}>
          {STATUS_LABEL[hunk.status] ?? hunk.status}
        </span>
        {pending && hunk.stale === true && (
          <span className="sg-chip" data-status="stale" title="The original lines are not in the file any more">
            Out of date
          </span>
        )}
      </div>
      <div className="sg-sides">
        <div className="sg-side" role="group" aria-label="Original">
          <h3>Original</h3>
          {hunk.originalLines.length === 0 ? <p className="muted">{newFile ? '(the file does not exist yet)' : '(nothing)'}</p> : <Words parts={sides.before} />}
        </div>
        <div className="sg-side" role="group" aria-label="Proposed">
          <h3>Proposed</h3>
          <Words parts={sides.after} />
        </div>
      </div>
      {pending && (handlers.onAccept || handlers.onDecline) && (
        <div className="sg-actions">
          <button type="button" className="btn btn-small btn-primary" disabled={busy || hunk.stale === true} aria-label={`Accept hunk ${hunk.id}`} onClick={() => handlers.onAccept?.(hunk.id)}>
            Accept
          </button>
          <button type="button" className="btn btn-small" disabled={busy} aria-label={`Decline hunk ${hunk.id}`} onClick={() => handlers.onDecline?.(hunk.id)}>
            Decline
          </button>
        </div>
      )}
      {!pending && hunk.decided && <p className="muted sg-decided">{hunk.status === 'accepted' ? 'Accepted' : 'Declined'} {hunk.decided}</p>}
    </li>
  );
}

/**
 * The review of one suggestion: where it comes from (source badge; for AI the provider, model and locality), what it would change, every hunk side by side with Accept / Decline,
 * and Accept all / Decline all. Presentational: `suggestion` is GET /suggestions/:id; the handlers do the writing. Nothing here changes text.
 * @param {{ suggestion: any, busy?: boolean, error?: string | null,
 *   handlers?: { onAccept?: (hunkId: string) => void, onDecline?: (hunkId: string) => void, onAcceptAll?: () => void, onDeclineAll?: () => void } }} props
 */
export function SuggestionReview({ suggestion: s, busy = false, error = null, handlers = {} }) {
  const pending = s.hunks.filter((h) => h.status === 'pending');
  const provider = s.source === 'ai' ? providerLine(s.ai) : null;
  const decided = pending.length === 0;
  return (
    <article className="sg-review" aria-label="Suggestion">
      <header>
        <p className="sg-meta">
          <span className="sg-source" data-source={s.source}>
            {sourceLabelOf(s.source)}
          </span>
          {provider && <span className="muted sg-provider">{provider}</span>}
          <span className="sg-chip" data-status={s.status}>
            {STATUS_LABEL[s.status] ?? s.status}
          </span>
        </p>
        <h2>{s.target_title ?? (s.new_file ? s.target_path || 'New file' : 'Missing file')}</h2>
        {s.target_missing && <p className="error">The file this suggestion is for is no longer part of the book.</p>}
        {s.rationale && <p className="muted sg-rationale">{s.rationale}</p>}
        <p className="muted sg-advice">Nothing changes in your text until you accept a part.</p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!decided && (handlers.onAcceptAll || handlers.onDeclineAll) && (
        <div className="sg-actions sg-all">
          <button type="button" className="btn btn-primary" disabled={busy || s.hunks.some((h) => h.status === 'pending' && h.stale === true)} onClick={() => handlers.onAcceptAll?.()}>
            Accept all
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => handlers.onDeclineAll?.()}>
            Decline all
          </button>
        </div>
      )}
      {decided && <p className="muted sg-outcome">Decided: {outcomeText(s)}.</p>}
      <ol className="sg-hunks" aria-label="Changes">
        {s.hunks.map((h) => (
          <HunkView key={h.id} hunk={h} newFile={s.new_file === true} busy={busy} handlers={handlers} />
        ))}
      </ol>
    </article>
  );
}
