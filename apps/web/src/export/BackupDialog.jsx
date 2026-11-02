import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { backupUrl, fetchDownload, saveBlob } from './requests.js';

/**
 * The Back up book dialog: a zip of the whole book folder (manuscript, codex, notes, archive, assets), downloaded. Receipts (provenance) are left
 * out unless ticked. Restore it later from the library page.
 * @param {{ book: { id: string, slug?: string | null }, onClose: () => void, fetchImpl?: typeof fetch }} props
 */
export function BackupDialog({ book, onClose, fetchImpl }) {
  const [provenance, setProvenance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await fetchDownload(backupUrl(book.id, { provenance }), `${book.slug ?? 'book'}-backup.zip`, fetchImpl);
    setBusy(false);
    if (!r.ok) {
      setProblem(r.message);
      return;
    }
    saveBlob(r.blob, r.filename);
    onClose();
  }

  return (
    <Dialog label="Back up book" onClose={onClose} className="backup-dialog">
      <h2>Back up book</h2>
      <form onSubmit={submit} noValidate>
        <p>
          This saves every file of the book in one .zip file. You can restore it from the library page, on this or another computer.
        </p>
        <div className="field">
          <label className="choice">
            <input type="checkbox" checked={provenance} onChange={(e) => setProvenance(e.target.checked)} />
            <span>Include receipts (provenance)</span>
          </label>
          <p className="secondary field-hint">Receipts are the records in the provenance folder. Leave this off to keep them out of the copy.</p>
        </div>
        {problem && (
          <p role="alert" className="field-error">
            {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Backing up…' : 'Back up'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
