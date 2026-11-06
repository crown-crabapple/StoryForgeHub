import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { ToastFrame } from '../shell/ToastStack.jsx';
import { useWrites } from '../shell/writes.jsx';
import { slugify } from '../structure/helpers.js';
import { acknowledgeRequest, archiveExceptionRequest, explainContinuityFailure, sendRequest, undoOpRequest } from './requests.js';

const TOAST_MS = 12000;

/**
 * "Acknowledge…": why this finding is fine. The rationale is required (nothing is sent without it). Presentational: `onSubmit({ rationale, title, intentional })` returns an error text or null.
 * @param {{ finding: { title: string, rule: string }, busy?: boolean, error?: string | null, onSubmit: (v: { rationale: string, title: string, intentional: boolean }) => void, onClose: () => void }} props
 */
export function AcknowledgeDialog({ finding, busy = false, error = null, onSubmit, onClose }) {
  const [rationale, setRationale] = useState('');
  const [title, setTitle] = useState(finding.title);
  const [intentional, setIntentional] = useState(false);
  const [touched, setTouched] = useState(false);
  const missing = rationale.trim() === '';
  const slug = slugify(title.trim() === '' ? finding.title : title);
  return (
    <Dialog label="Acknowledge finding" onClose={onClose}>
      <h2>Acknowledge this finding</h2>
      <p className="muted">{finding.title}</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (missing) return;
          onSubmit({ rationale: rationale.trim(), title: title.trim(), intentional });
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Why is this fine? (required)</span>
            <textarea name="rationale" rows={4} value={rationale} onChange={(e) => setRationale(e.target.value)} aria-required="true" aria-invalid={touched && missing ? 'true' : undefined} aria-describedby={touched && missing ? 'cf-rationale-error' : undefined} />
          </label>
          {touched && missing && (
            <p id="cf-rationale-error" role="alert" className="error">
              Write why this is fine.
            </p>
          )}
        </div>
        <div className="form-row">
          <label>
            <span className="form-label">Title</span>
            <input type="text" name="title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <div className="form-row">
          <label>
            <input type="checkbox" name="intentional" checked={intentional} onChange={(e) => setIntentional(e.target.checked)} /> <span>This is on purpose</span>
          </label>
        </div>
        <p className="muted form-hint">
          This creates <code>planning/continuity/{slug}.md</code> — a Markdown file you can edit or delete. It hides only this finding; if the facts change, a new finding appears.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The message under a finished write, with Undo when there is something to undo. */
export function Toast({ toast, onUndo, onDismiss }) {
  return (
    <ToastFrame>
      <span>{toast.message}</span>
      {toast.undo && (
        <button type="button" className="btn toast-button" onClick={onUndo}>
          Undo
        </button>
      )}
      <button type="button" className="btn toast-button" onClick={onDismiss}>
        Dismiss
      </button>
    </ToastFrame>
  );
}

/**
 * The three writes of the continuity review: acknowledge (a dialog, then the exception file), restore a finding and remove a stale exception (both archive the file).
 * Each shows a toast with Undo. Undo of either is the server's restore of that operation (the new file goes away again; an archived one comes back byte for byte).
 * `onChanged` runs after every write (and undo) so the lists load again. Returns `{ acknowledge, restore, remove, ui }`; render `ui` once.
 * @param {{ bookId: string, onChanged?: () => void }} p
 */
export function useContinuityActions({ bookId, onChanged }) {
  const { track } = useWrites();
  const [dialog, setDialog] = useState(null); // { finding, error }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const showToast = (next) => {
    clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  };
  const write = (r) => track(bookId, () => sendRequest(r));

  async function submit({ rationale, title, intentional }) {
    const finding = dialog?.finding;
    if (!finding) return;
    setBusy(true);
    const { status, json } = await write(acknowledgeRequest(bookId, { fingerprint: finding.fingerprint, rationale, title, intentional }));
    setBusy(false);
    if (status === 201 || status === 200) {
      setDialog(null);
      showToast({ message: `${intentional ? 'Marked as intentional' : 'Acknowledged'}. The finding is hidden; Restore it from Acknowledged any time.`, undo: json?.opId ? { opId: json.opId } : null });
      onChanged?.();
    } else {
      setDialog((d) => (d ? { ...d, error: explainContinuityFailure(status, json) } : d));
      if (status === 404 || status === 409) onChanged?.();
    }
  }

  /** Archive an exception (Restore finding / Remove). */
  async function archive(slug, message) {
    const { status, json } = await write(archiveExceptionRequest(bookId, slug));
    if (status === 200) {
      showToast({ message, undo: json?.opId ? { opId: json.opId } : null });
      onChanged?.();
    } else {
      showToast({ message: `Not changed: ${explainContinuityFailure(status, json)}` });
      if (status === 404) onChanged?.();
    }
  }

  async function undo() {
    const u = toast?.undo;
    if (!u) return;
    setToast(null);
    const { status, json } = await write(undoOpRequest(bookId, u.opId));
    if (status === 200) {
      showToast({ message: 'Undone.' });
      onChanged?.();
    } else {
      showToast({ message: `Could not undo: ${explainContinuityFailure(status, json)}` });
    }
  }

  const ui = (
    <>
      {dialog && <AcknowledgeDialog key={dialog.finding.fingerprint} finding={dialog.finding} busy={busy} error={dialog.error} onSubmit={submit} onClose={() => setDialog(null)} />}
      {toast && <Toast toast={toast} onUndo={undo} onDismiss={() => setToast(null)} />}
    </>
  );
  return {
    acknowledge: (finding) => setDialog({ finding, error: null }),
    restore: (slug) => archive(slug, 'The finding is back. Its exception file is in archive/.'),
    remove: (slug) => archive(slug, 'Removed. The exception file is in archive/.'),
    ui,
  };
}
