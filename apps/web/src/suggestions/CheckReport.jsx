import { Link } from '../router.jsx';
import { SourceLink } from '../continuity/ShowBoth.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { SEVERITY_LABEL } from '../continuity/model.js';
import { checkOpenHref } from './model.js';
import { MakeTaskButton } from '../tasks/MakeTaskButton.jsx';

/** One finding of the report: severity word, code, message, the evidence line, and an Open link to file:line. Presentational. */
export function CheckFinding({ bookId, scene, finding: f }) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  const open =
    f.file === scene.path ? (
      <SourceLink bookId={bookId} source={{ kind: 'scene', id: scene.id, file: f.file, line: f.line ?? 1 }} className="btn btn-small">
        Open
      </SourceLink>
    ) : (
      <Link to={checkOpenHref(bookId, f, scene)} className="btn btn-small">
        Open
      </Link>
    );
  return (
    <li className="cf-card ck-finding" data-severity={f.severity} data-kind={f.kind}>
      <div className="cf-card-head">
        <span className="cf-dot" data-severity={f.severity} aria-hidden="true" />
        <span className="cf-sev">{SEVERITY_LABEL[f.severity] ?? f.severity}</span>
        <span className="tag">{f.kind === 'continuity' ? 'Continuity' : 'Check'}</span>
        <strong className="cf-card-title">{f.code}</strong>
      </div>
      <p>{f.message}</p>
      {f.evidence && <blockquote className="ck-evidence">{f.evidence}</blockquote>}
      <p className="muted ck-where">
        <code>{where}</code> {open}
      </p>
      <p>
        <MakeTaskButton bookId={bookId} source={{ from: 'check', sceneId: scene.id, finding: f }} />
      </p>
    </li>
  );
}

/**
 * The report of "Check scene": counts, then every finding with its evidence and an Open link. It only reports: nothing here changes text, and the check wrote nothing.
 * @param {{ bookId: string, report: { scene: { id: string, title: string, path: string }, at: string, findings: any[], summary: any } }} props
 */
export function CheckReport({ bookId, report }) {
  const s = report.summary;
  return (
    <div className="ck-report" aria-label="Check report">
      <p className="ck-summary" role="status">
        {s.total === 0 ? 'No problems found in this scene.' : `${s.total} ${s.total === 1 ? 'finding' : 'findings'}: ${s.errors} ${s.errors === 1 ? 'error' : 'errors'}, ${s.warnings} ${s.warnings === 1 ? 'warning' : 'warnings'}, ${s.infos} info.`}
      </p>
      <p className="muted">Checked locally, with no AI. Nothing was written and no text was changed.</p>
      {report.findings.length > 0 && (
        <ul className="cf-cards" aria-label="Check findings">
          {report.findings.map((f, i) => (
            <CheckFinding key={`${f.code}|${f.file}|${f.line}|${i}`} bookId={bookId} scene={report.scene} finding={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The report in a window. `report` is null while the check runs; `error` is a failure text. @param {{ bookId: string, sceneTitle: string, report: any | null, error?: string | null, onClose: () => void }} props */
export function CheckDialog({ bookId, sceneTitle, report, error = null, onClose }) {
  return (
    <Dialog label="Check report" onClose={onClose} className="dialog-wide">
      <h2>Check scene: {sceneTitle || 'Untitled scene'}</h2>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : report ? (
        <CheckReport bookId={bookId} report={report} />
      ) : (
        <p role="status" className="muted">
          Checking…
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
