import { useState } from 'react';
import { useApi } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { BackupDialog } from './BackupDialog.jsx';
import { ExportDialog } from './ExportDialog.jsx';

/** The Export dialog with the book's statuses loaded. */
function ExportFlow({ bookId, onClose }) {
  const { data, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}`);
  if (loading) {
    return (
      <Dialog label="Export" onClose={onClose}>
        <h2>Export</h2>
        <p role="status" className="muted">
          Loading&hellip;
        </p>
      </Dialog>
    );
  }
  if (error || !data) {
    return (
      <Dialog label="Export" onClose={onClose}>
        <h2>Export</h2>
        <p role="alert" className="error">
          {error ?? 'That book is not in the library any more.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }
  return <ExportDialog book={data} onClose={onClose} />;
}

/**
 * The book's Export… and Back up book… actions (in the top bar while a book is open).
 * @param {{ bookId: string, slug?: string | null }} props
 */
export function BookActions({ bookId, slug = null }) {
  const [dialog, setDialog] = useState(null);
  const close = () => setDialog(null);
  return (
    <div className="book-actions" role="group" aria-label="Book actions">
      <button type="button" className="btn" onClick={() => setDialog('export')}>
        Export…
      </button>
      <button type="button" className="btn" onClick={() => setDialog('backup')}>
        Back up book…
      </button>
      {dialog === 'export' && <ExportFlow bookId={bookId} onClose={close} />}
      {dialog === 'backup' && <BackupDialog book={{ id: bookId, slug }} onClose={close} />}
    </div>
  );
}
