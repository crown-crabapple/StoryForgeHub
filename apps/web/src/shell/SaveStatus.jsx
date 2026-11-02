import { useStatus } from '../status.jsx';
import { AlertIcon, CheckIcon, LockIcon, SpinnerIcon } from './icons.jsx';
import { deriveSave } from './save-state.js';
import { useWrites } from './writes.jsx';

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The indicator itself: icon and words, never colour alone. @param {{ view: import('./save-state.js').SaveView }} props */
export function SaveStatusView({ view }) {
  let icon = <CheckIcon />;
  let text;
  switch (view.kind) {
    case 'saving':
      icon = <SpinnerIcon />;
      text = 'Saving…';
      break;
    case 'conflict':
      icon = <AlertIcon />;
      text = "Can't save — file changed outside";
      break;
    case 'readonly':
      icon = <LockIcon />;
      text = 'Read-only';
      break;
    case 'saved':
      text = `Saved ${formatTime(view.at)}`;
      break;
    default:
      icon = <SpinnerIcon />;
      text = 'Checking…';
  }
  return (
    <span role="status" className="save-status" data-state={view.kind}>
      {icon}
      <span>{text}</span>
    </span>
  );
}

/** Connected indicator: writes made here plus the book's last reconcile time from /api/status. */
export function SaveStatus({ bookId }) {
  const { status } = useStatus();
  const { writes } = useWrites();
  const lastReconciledAt = status?.books?.find((b) => b.book_id === bookId)?.last_reconciled_at ?? null;
  return <SaveStatusView view={deriveSave({ bookId: bookId ?? null, writes, lastReconciledAt })} />;
}
