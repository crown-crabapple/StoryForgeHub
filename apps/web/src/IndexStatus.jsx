import { useState } from 'react';
import { postJson } from './api.js';
import { RepairDialog } from './RepairDialog.jsx';
import { Link } from './router.jsx';
import { useStatus, worstState } from './status.jsx';

const LABEL = {
  fresh: 'Index up to date',
  building: 'Index building',
  stale: 'Index out of date',
  error: 'Index unreadable',
  missing: 'Index not built yet',
  invalid: "A file can't be read",
};

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : 'never');

/** Book-relative path of a library-relative one (the raw-file link is relative to the book). */
const inBook = (book, file) => (book.path && file.startsWith(`${book.path}/`) ? file.slice(book.path.length + 1) : file);

function StatusPanel({ status, onClose, onRepair, onRebuild, busy }) {
  const { watch, books, recover, instance } = status;
  const invalid = books.filter((b) => b.invalid_paths.length > 0);
  const recovered = [
    ...recover.needsAttention.map((i) => ({ ...i, kind: 'needs attention' })),
    ...recover.rolledBack.map((i) => ({ ...i, kind: 'rolled back' })),
  ];
  return (
    <section className="status-panel" role="dialog" aria-label="Status">
      <h3>Status</h3>
      <p>
        <strong>Watching files:</strong> {watch.mode === 'watch' ? 'live' : 'checking every few seconds'}
        {watch.reason ? <span className="muted"> ({watch.reason})</span> : null}
        <br />
        <span className="muted">
          last change seen {time(watch.last_event_at)} · {watch.pending} waiting · pid {instance.pid}
        </span>
      </p>
      <h4>Books</h4>
      <ul className="status-books">
        {books.map((b) => (
          <li key={b.path || '.'}>
            <span className={`dot dot-${b.index}`} aria-hidden="true" /> {b.title ?? (b.path || 'this book')}: {LABEL[b.index] ?? b.index}
            <span className="muted">
              {' '}
              · {b.errors} errors · {b.warnings} warnings · updated {time(b.last_reconciled_at)}
            </span>
          </li>
        ))}
      </ul>
      {invalid.length > 0 && (
        <>
          <h4>Files that can't be read</h4>
          <ul>
            {invalid.map((b) =>
              b.invalid_paths.map((file) => (
                <li key={`${b.path}:${file}`}>
                  {b.book_id ? (
                    <Link to={`/books/${encodeURIComponent(b.book_id)}?file=${encodeURIComponent(inBook(b, file))}`} onClick={onClose}>
                      {file}
                    </Link>
                  ) : (
                    file
                  )}
                </li>
              )),
            )}
          </ul>
        </>
      )}
      {recovered.length > 0 && (
        <>
          <h4>Interrupted saves</h4>
          <ul>
            {recovered.map((i) => (
              <li key={i.opId}>
                {i.kind}: {i.op ?? 'operation'} {i.opId}
                {i.reason ? ` - ${i.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="status-actions">
        <button type="button" onClick={onRebuild} disabled={busy}>
          Rebuild index
        </button>{' '}
        <button type="button" onClick={onRepair} disabled={busy}>
          Repair…
        </button>{' '}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </p>
    </section>
  );
}

export function IndexStatus() {
  const { status, reload } = useStatus();
  const [open, setOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function rebuild() {
    setBusy(true);
    try {
      await postJson('/api/index/rebuild', {});
    } finally {
      setBusy(false);
      reload();
    }
  }

  const state = worstState(status?.books);
  if (state === null) return null;
  const shown = busy ? 'building' : state;
  return (
    <div className="index-status">
      <button
        type="button"
        className="status-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${LABEL[shown]}. Show status`}
        title={LABEL[shown]}
      >
        <span className={`dot dot-${shown}`} role="img" aria-label={LABEL[shown]} />
        <span className="muted">{shown}</span>
      </button>
      {open && <StatusPanel status={status} onClose={() => setOpen(false)} onRepair={() => setRepairing(true)} onRebuild={rebuild} busy={busy} />}
      {repairing && (
        <RepairDialog
          books={status.books.filter((b) => b.book_id)}
          onClose={() => {
            setRepairing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
