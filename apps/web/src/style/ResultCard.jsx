// One style finding of a scan as a card (M13-J03 section 9): rule and category, where it is, the flagged text marked, the message, Open, one button per replacement (applied
// through POST /scenes/:s/apply-finding, then Undo), Dismiss with an optional note, and for advice the related occurrences as links. Presentational.
import { useState } from 'react';
import { replaceLabel } from '../grammar/RailGrammar.jsx';
import { Link } from '../router.jsx';
import { categoryLabel, isAcrossScenes, openHref, placeOf, ruleLabel } from './model.js';

/**
 * @param {{
 *   bookId: string, finding: any, chapters: Record<string, any> | undefined,
 *   status?: { phase: 'idle' | 'busy' | 'applied', replacement?: string, error?: string | null },
 *   sceneChanged?: boolean,
 *   onApply: (f: any, index: number) => void, onUndo: (f: any) => void, onDismiss: (f: any, note: string) => void,
 * }} props `sceneChanged`: a replacement in this scene was applied since the scan, so the offsets of the other findings of the scene are out of date
 */
export function ResultCard({ bookId, finding, chapters, status = { phase: 'idle' }, sceneChanged = false, onApply, onUndo, onDismiss }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const place = placeOf(chapters, finding.sceneId);
  const related = Array.isArray(finding.related) ? finding.related : [];
  const busy = status.phase === 'busy';
  const applied = status.phase === 'applied';
  const noteId = `${finding.id}-note`;
  return (
    <li className="cf-card st-card" data-severity={finding.severity} data-rule={finding.ruleId} data-category={finding.category}>
      <div className="cf-card-head">
        <span className="cf-dot" data-severity={finding.severity} aria-hidden="true" />
        <span className="cf-sev">
          {ruleLabel(finding.ruleId)} · {categoryLabel(finding.category)}
        </span>
        {finding.advisory && <span className="badge st-advice">Advice</span>}
        {isAcrossScenes(finding) && <span className="badge">Across scenes</span>}
      </div>
      <p className="muted st-place">
        {place.chapter ? `${place.chapter} · ` : ''}
        {place.scene}
      </p>
      <p className="st-passage">
        <mark>{finding.original}</mark>
      </p>
      <p className="muted gr-message">{finding.message}</p>
      {related.length > 0 && (
        <ul className="st-related" aria-label="Other places">
          {related.map((r) => (
            <li key={`${r.sceneId}|${r.from}|${r.to}`}>
              <Link className="btn btn-small" to={openHref(bookId, r.sceneId, r.from, r.to)}>
                {`${placeOf(chapters, r.sceneId).scene}: “${r.text}”`}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {applied ? (
        <p role="status" className="st-applied">
          Applied{status.replacement === '' ? ': deleted' : `: ‘${status.replacement}’`}.{' '}
          <button type="button" className="btn btn-small" onClick={() => onUndo(finding)}>
            Undo
          </button>
        </p>
      ) : (
        <>
          {sceneChanged && <p className="muted">This scene changed after the scan. Run the scan again to change it from here.</p>}
          <div className="cf-actions">
            <Link className="btn btn-small" to={openHref(bookId, finding.sceneId, finding.range.from, finding.range.to)}>
              Open
            </Link>
            {finding.replacements.map((r, i) => (
              <button key={`${i}|${r}`} type="button" className="btn btn-small" disabled={busy || sceneChanged} onClick={() => onApply(finding, i)}>
                {replaceLabel(r)}
              </button>
            ))}
            <button type="button" className="btn btn-small" disabled={busy} aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
              Dismiss
            </button>
          </div>
          {asking && (
            <div className="st-dismiss">
              <label htmlFor={noteId}>Note (optional)</label>
              <input id={noteId} type="text" value={note} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} />{' '}
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => onDismiss(finding, note.trim())}>
                Dismiss this suggestion
              </button>
            </div>
          )}
        </>
      )}
      {status.error && (
        <p role="alert" className="form-error">
          {status.error}
        </p>
      )}
    </li>
  );
}
