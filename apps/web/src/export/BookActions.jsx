import { useState } from 'react';
import { useApi } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { BackupDialog } from './BackupDialog.jsx';
import { LabelManager } from '../world/LabelManager.jsx';
import { SaveAsTemplateDialog } from '../world/SaveAsTemplateDialog.jsx';
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
 * The book's Export…, Back up book…, Labels… and Save as template… actions (in the top bar while a book is open).
 * @param {{ bookId: string, slug?: string | null, title?: string | null }} props
 */
export function BookActions({ bookId, slug = null, title = null }) {
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
      <button type="button" className="btn" onClick={() => setDialog('labels')}>
        Labels…
      </button>
      <button type="button" className="btn" onClick={() => setDialog('template')}>
        Save as template…
      </button>
      {dialog === 'labels' && <LabelManager bookId={bookId} onClose={close} />}
      {dialog === 'template' && <SaveAsTemplateDialog bookId={bookId} bookTitle={title} onClose={close} />}
      {dialog === 'export' && <ExportFlow bookId={bookId} onClose={close} />}
      {dialog === 'backup' && <BackupDialog book={{ id: bookId, slug }} onClose={close} />}
    </div>
  );
}
