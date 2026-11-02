import { useState } from 'react';
import { useApi } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { SuggestionReview } from './SuggestionReview.jsx';
import { outcomeText, providerLine, sourceLabelOf, splitSuggestions, suggestionUrl, suggestionsUrl } from './model.js';
import { useSuggestionActions } from './useSuggestionActions.jsx';

/** One suggestion as a row: source badge (and the AI provider), the date, how many parts wait, and a Review button. Presentational. */
export function SuggestionRow({ suggestion: s, onReview }) {
  const waiting = s.pending;
  return (
    <li className="sg-row" data-status={s.status}>
      <div className="sg-row-head">
        <span className="sg-source" data-source={s.source}>
          {sourceLabelOf(s.source)}
        </span>
        <span className="muted">{String(s.created).slice(0, 10)}</span>
      </div>
      {s.source === 'ai' && providerLine(s.ai) && <p className="muted sg-row-provider">{providerLine(s.ai)}</p>}
      <p className="sg-row-count">{waiting > 0 ? `${waiting} of ${s.hunks.length} ${s.hunks.length === 1 ? 'change' : 'changes'} waiting` : `Decided: ${outcomeText(s)}`}</p>
      {onReview && (
        <button type="button" className="btn btn-small" onClick={() => onReview(s.id)}>
          {waiting > 0 ? 'Review' : 'View'}
        </button>
      )}
    </li>
  );
}

/**
 * The review window for one suggestion: loads it (again after every write) and shows the side-by-side review with Accept / Decline per change and Accept all / Decline all.
 * @param {{ bookId: string, suggestionId: string, version?: string, actions: ReturnType<typeof useSuggestionActions>, onClose: () => void }} props
 */
export function SuggestionDialog({ bookId, suggestionId, version = '', actions, onClose }) {
  const { data, error } = useApi(suggestionUrl(bookId, suggestionId), `${version}|${actions.stamp}`);
  return (
    <Dialog label="Review suggestion" onClose={onClose} className="dialog-wide sg-dialog">
      {data ? (
        <SuggestionReview
          suggestion={data}
          busy={actions.busy}
          error={actions.error}
          handlers={{
            onAccept: (h) => actions.decide(suggestionId, 'accept', h),
            onDecline: (h) => actions.decide(suggestionId, 'decline', h),
            onAcceptAll: () => actions.decide(suggestionId, 'accept'),
            onDeclineAll: () => actions.decide(suggestionId, 'decline'),
          }}
        />
      ) : (
        <p className="muted">{error ?? 'Loading…'}</p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The "Suggestions" section of the editor rail (M05-J06): the open suggestions for the scene (count badge), each with Review; decided ones stay listed under "Decided" with
 * their outcome. Advice only: nothing here changes the scene until the author accepts a change in the review.
 * @param {{ book: any, scene: any, version?: string, onChanged?: () => void }} props
 */
export function RailSuggestions({ book, scene, version = '', onChanged }) {
  const [openId, setOpenId] = useState(/** @type {string | null} */ (null));
  const actions = useSuggestionActions({ bookId: book.id, onChanged });
  const { data } = useApi(suggestionsUrl(book.id, { target: scene.id }), `${version}|${actions.stamp}`);
  const list = data?.suggestions ?? null;
  const { open, decided } = splitSuggestions(list ?? []);
  const title = (
    <>
      Suggestions
      {open.length > 0 && (
        <>
          {' '}
          <span className="badge" aria-label={`${open.length} pending ${open.length === 1 ? 'suggestion' : 'suggestions'}`}>
            {open.length}
          </span>
        </>
      )}
    </>
  );
  return (
    <InspectorSection title={title}>
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : open.length === 0 ? (
        <p className="muted">No pending suggestions for this scene.</p>
      ) : (
        <ul className="sg-rows" aria-label="Pending suggestions">
          {open.map((s) => (
            <SuggestionRow key={s.id} suggestion={s} onReview={setOpenId} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details className="sg-decided-list">
          <summary>Decided ({decided.length})</summary>
          <ul className="sg-rows" aria-label="Decided suggestions">
            {decided.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} onReview={setOpenId} />
            ))}
          </ul>
        </details>
      )}
      {openId && <SuggestionDialog key={openId} bookId={book.id} suggestionId={openId} version={version} actions={actions} onClose={() => setOpenId(null)} />}
      {actions.ui}
    </InspectorSection>
  );
}
