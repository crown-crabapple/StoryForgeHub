import { useApi } from '../api.js';
import { RestoreDialog } from '../export/RestoreDialog.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { NewBookDialog } from './NewBookDialog.jsx';
import { NewSeriesDialog } from './NewSeriesDialog.jsx';
import { OpenFolderDialog } from './OpenFolderDialog.jsx';

/** A dialog that is waiting for data, or could not get it. */
function Waiting({ label, error, onClose }) {
  return (
    <Dialog label={label} onClose={onClose}>
      <h2>{label}</h2>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : (
        <p role="status" className="muted">
          Loading&hellip;
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** The New book dialog with its data (templates, series, pen names) loaded. On success it opens the new book. */
export function NewBookFlow({ onClose }) {
  const templates = useApi('/api/templates');
  const library = useApi('/api/library');
  const error = templates.error ?? library.error;
  if (error || templates.loading || library.loading || !templates.data || !library.data) {
    return <Waiting label="New book" error={error} onClose={onClose} />;
  }
  return (
    <NewBookDialog
      templates={templates.data}
      series={library.data.series ?? []}
      penNames={library.data.pen_names ?? []}
      onClose={onClose}
      onCreated={(r) => window.location.assign(`/books/${encodeURIComponent(r.bookId)}`)}
    />
  );
}

/** The New series dialog. On success the page reloads, so the library lists the new series. */
export function NewSeriesFlow({ onClose }) {
  return <NewSeriesDialog onClose={onClose} onCreated={() => window.location.assign('/')} />;
}

/** The Restore from backup dialog. On success it opens the restored book (the server has already rescanned the library). */
export function RestoreFlow({ onClose }) {
  return (
    <RestoreDialog
      onClose={onClose}
      onRestored={(r) => window.location.assign(r.bookId ? `/books/${encodeURIComponent(r.bookId)}` : '/')}
    />
  );
}

/** The Open folder dialog with the recent libraries loaded. Opening a folder reloads the app on the new library. */
export function OpenFolderFlow({ onClose }) {
  const recent = useApi('/api/library/recent');
  if (recent.loading) return <Waiting label="Open folder" error={null} onClose={onClose} />;
  return <OpenFolderDialog recent={recent.data ?? []} onClose={onClose} onOpened={() => window.location.assign('/')} />;
}
