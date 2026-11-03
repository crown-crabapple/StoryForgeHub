import { useState } from 'react';
import { CompareView } from './ConflictPanel.jsx';

/**
 * Shared mode: someone saved this scene before you did (M07-J03b). Your text was not lost: the server kept it as a suggestion against their version, and nothing was
 * overwritten. Compare the two here, then merge by accepting the parts you want from the suggestion; or just carry on from their version.
 * @param {{ snapshot: import('./save-controller.js').SaveSnapshot, title: string, canReview: boolean, onReview: () => void, onUseCurrent: () => Promise<void> | void }} props
 */
export function StalePanel({ snapshot, title, canReview, onReview, onUseCurrent }) {
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const theirs = snapshot.conflict?.currentText ?? null;
  const kept = snapshot.conflict?.suggestionId != null;
  return (
    <section className="editor-notice editor-notice-danger" role="alert" aria-label="Someone saved this scene first">
      <p>
        <strong>Someone saved “{title || 'Untitled scene'}” while you were editing.</strong>{' '}
        {kept ? 'Your text was not lost: it was kept as a suggestion against their version, and their version was not touched.' : 'Their version was not touched, and your text is still here.'}
      </p>
      <div className="editor-notice-actions">
        <button type="button" className="btn" aria-expanded={comparing} onClick={() => setComparing((c) => !c)}>
          {comparing ? 'Hide comparison' : 'Compare'}
        </button>
        {kept && canReview && (
          <button type="button" className="btn btn-primary" onClick={onReview}>
            Review my changes
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUseCurrent();
            } finally {
              setBusy(false);
            }
          }}
        >
          Use their version
        </button>
      </div>
      {kept && !canReview && <p className="muted">An editor can merge your suggestion from the Suggestions list.</p>}
      {comparing && (theirs === null ? <p className="muted">Reading their version…</p> : <CompareView mine={snapshot.text} theirs={theirs} rightLabel="Their version (on disk)" />)}
    </section>
  );
}
