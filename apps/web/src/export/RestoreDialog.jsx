import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { FOLDER_RE, suggestFolder, uploadRestore } from './requests.js';

/**
 * The Restore from backup dialog: pick a backup .zip, name the new folder it goes into, upload. The folder must not exist yet; nothing that is already
 * in the library is touched. `onRestored({ bookId })` runs on success (the page then opens the book).
 * @param {{ onClose: () => void, onRestored?: (r: { bookId: string | null, diagnostics: any[] }) => void, fetchImpl?: typeof fetch }} props
 */
export function RestoreDialog({ onClose, onRestored, fetchImpl }) {
  const [file, setFile] = useState(null);
  const [folder, setFolder] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const folderOk = FOLDER_RE.test(folder);

  function pick(e) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setProblem(null);
    if (f && !touched) setFolder(suggestFolder(f.name));
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!file) {
      setProblem('Choose a backup file first.');
      return;
    }
    if (!folderOk) {
      setProblem('The folder name can only use a-z, 0-9 and hyphens (up to 60 characters).');
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await uploadRestore(file, folder, fetchImpl);
    if (r.ok) {
      onRestored?.(r);
      return;
    }
    setBusy(false);
    setProblem(r.message);
  }

  return (
    <Dialog label="Restore from backup" onClose={onClose} className="restore-dialog">
      <h2>Restore from backup</h2>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="restore-file">Backup file</label>
          <input id="restore-file" type="file" accept=".zip,application/zip" onChange={pick} />
        </div>
        <div className="field">
          <label htmlFor="restore-folder">New folder name</label>
          <input
            id="restore-folder"
            type="text"
            value={folder}
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            onChange={(e) => {
              setFolder(e.target.value);
              setTouched(true);
              setProblem(null);
            }}
            {...(folder !== '' && !folderOk ? { 'aria-invalid': 'true', 'aria-describedby': 'restore-folder-hint' } : { 'aria-describedby': 'restore-folder-hint' })}
          />
          <p id="restore-folder-hint" className="secondary field-hint">
            The book is restored into this new folder of your library. Use a-z, 0-9 and hyphens.
          </p>
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
            {busy ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
