import { Dialog } from '../shell/Dialog.jsx';

const MAX_DIFF_LINES = 200;

/** What a change does to its file, in words. */
export function changeKind(c) {
  if (c.from === null || c.from === undefined) return 'New file';
  if (c.from === c.to) return 'Edit';
  if (c.to.startsWith('archive/') && !c.from.startsWith('archive/')) return 'Archive';
  if (c.from.startsWith('archive/') && !c.to.startsWith('archive/')) return 'Restore';
  return 'Move';
}

const lineClass = (line) => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
};

/** A unified diff, one line per row. The leading + / - stays visible, so colour is never the only cue. */
export function DiffView({ diff, label }) {
  const all = diff.replace(/\n$/, '').split('\n');
  const lines = all.slice(0, MAX_DIFF_LINES);
  return (
    <pre className="diff" tabIndex={0} aria-label={label}>
      {lines.map((line, i) => (
        <span key={i} className={`diff-line ${lineClass(line)}`}>
          {line === '' ? ' ' : line}
          {'\n'}
        </span>
      ))}
      {all.length > lines.length && <span className="diff-line diff-meta">{`... ${all.length - lines.length} more lines${'\n'}`}</span>}
    </pre>
  );
}

/**
 * The list of files a command would change, each with its diff (when the server gave one).
 * `preview`: { title, changes, notes?, error?, code?, extraAction? }. Nothing is written until Apply.
 */
export function PreviewDialog({ preview, busy, onApply, onCancel }) {
  const { title, changes = [], notes = [], error = null, extraAction = null } = preview;
  return (
    <Dialog label={`Preview: ${title}`} onClose={onCancel} className="preview-dialog">
      <h2>{title}</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!error && changes.length === 0 && <p className="muted">Nothing would change.</p>}
      {changes.length > 0 && (
        <>
          <p className="muted">
            {changes.length === 1 ? '1 file' : `${changes.length} files`} would change. Nothing is written until you press Apply.
          </p>
          <ul className="preview-files">
            {changes.map((c) => (
              <li key={`${c.from}>${c.to}`} className="preview-file">
                <div className="preview-file-head">
                  <strong>{changeKind(c)}</strong>{' '}
                  <code>{c.from === c.to || c.from === null || c.from === undefined ? c.to : `${c.from} -> ${c.to}`}</code>
                </div>
                {c.diff ? <DiffView diff={c.diff} label={`Changes to ${c.to}`} /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {notes.length > 0 && (
        <div className="preview-notes">
          <p>{notes[0].heading}</p>
          <ul>
            {notes[0].items.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="dialog-actions">
        {extraAction && (
          <button type="button" className="btn" onClick={extraAction.run} disabled={busy}>
            {extraAction.label}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy || Boolean(error) || changes.length === 0}>
          Apply
        </button>
      </div>
    </Dialog>
  );
}
