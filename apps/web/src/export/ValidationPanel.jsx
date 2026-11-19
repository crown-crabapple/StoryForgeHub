import { Link } from '../router.jsx';
import { LIMITS_SENTENCE, groupMessages, locationText, outcomeView, sourceLink } from './validation.js';

/** One message: the plain explanation when there is one, the original code and EPUBCheck's own words, where it is, and a link to the scene or chapter. */
function Message({ message, explanations, found, bookId }) {
  const explanation = explanations?.[message.code];
  const where = locationText(message.location);
  const link = sourceLink(message, found, bookId);
  return (
    <li className="validation-message">
      {explanation && <p className="validation-explanation">{explanation}</p>}
      <p className="secondary">
        <code>{message.code}</code> {message.message}
      </p>
      {where && <p className="secondary validation-where">{where}</p>}
      {link && (link.href ? (
        <p>
          <Link className="btn btn-small" to={link.href}>
            {link.label}
          </Link>
        </p>
      ) : (
        <p className="secondary">{link.label}</p>
      ))}
    </li>
  );
}

/**
 * The EPUB check in the Export dialog. While it runs: "Checking the EPUB…" with Cancel. When it has finished: the outcome in words, the reason when the check did not run, the messages
 * by severity, Download EPUB (always: a failed check never hides the file) and Download report, and the limits sentence under the outcome.
 * @param {{
 *   phase: 'running' | 'done', job?: any, bookId: string, cancelling?: boolean, canCancel?: boolean, busy?: boolean,
 *   onCancel?: () => void, onDownloadFile?: () => void, onDownloadReport?: () => void
 * }} props `job` is the answer of GET /api/books/:b/export/validations/:id (result, explanations, sources, chapters).
 */
export function ValidationPanel({ phase, job = null, bookId, cancelling = false, canCancel = true, busy = false, onCancel = () => {}, onDownloadFile = () => {}, onDownloadReport = () => {} }) {
  if (phase === 'running') {
    return (
      <section className="validation-panel" aria-label="EPUBCheck">
        <p role="status" className="validation-running">
          Checking the EPUB…
        </p>
        <button type="button" className="btn" disabled={cancelling || !canCancel} onClick={onCancel}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
        <p className="secondary validation-limits">{LIMITS_SENTENCE}</p>
      </section>
    );
  }
  const result = job?.result ?? null;
  const view = outcomeView(result?.outcome);
  const reason = result?.outcome === 'unavailable' || result?.outcome === 'error' || result?.outcome === 'cancelled' ? (result?.detail ?? null) : null;
  const { groups, total, hidden } = groupMessages(result?.messages ?? []);
  return (
    <section className="validation-panel" aria-label="EPUBCheck">
      <h3>EPUBCheck</h3>
      <p role="status" className={`validation-outcome validation-${view.tone}`} data-outcome={result?.outcome ?? 'error'}>
        <strong>{view.word}</strong>
        {result?.validatorVersion ? <span className="secondary"> (EPUBCheck {result.validatorVersion})</span> : null}
      </p>
      {result === null && <p className="field-error">The check could not run, and there is no result. The EPUB is still below.</p>}
      {reason && <p className={result.outcome === 'error' ? 'field-error' : 'secondary'}>{reason}</p>}
      {result?.outcome === 'unavailable' && (
        <p>
          Set it up in <Link to="/settings">Settings</Link>.
        </p>
      )}
      <p className="secondary validation-limits">{LIMITS_SENTENCE}</p>
      {total > 0 && (
        <div className="validation-messages">
          <p>{total === 1 ? '1 message' : `${total} messages`}</p>
          {groups.map((g) => (
            <section key={g.key || 'other'} aria-label={g.label}>
              <h4>
                {g.label} ({g.items.length})
              </h4>
              <ul className="validation-list">
                {g.items.map((m, i) => (
                  <Message key={`${m.code}-${i}`} message={m} explanations={job?.explanations} found={job} bookId={bookId} />
                ))}
              </ul>
            </section>
          ))}
          {hidden > 0 && <p className="secondary">{hidden} more messages are in the report.</p>}
        </div>
      )}
      <div className="validation-downloads">
        <button type="button" className="btn" disabled={busy} onClick={onDownloadFile}>
          Download EPUB
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onDownloadReport}>
          Download report
        </button>
      </div>
    </section>
  );
}
