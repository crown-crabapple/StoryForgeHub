import { useRef, useState } from 'react';
import { postJson } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { Field, PASSWORD_HINT } from './forms.jsx';
import { ROLE_WORDS, useSession } from './session.jsx';

/**
 * Change your own password. Other sessions end; this one stays signed in.
 * @param {{ onClose: () => void }} props
 */
export function ChangePasswordDialog({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (next !== again) return setError('The two new passwords are not the same.');
    setBusy(true);
    setError(null);
    try {
      const { status, json } = await postJson('/api/auth/password', { current, next });
      if (status === 200) return setDone(true);
      setError(status === 401 ? 'The current password is wrong.' : (json?.message ?? 'Could not change the password.'));
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    }
    setBusy(false);
  }

  return (
    <Dialog label="Change password" onClose={onClose} className="password-dialog">
      <h2>Change password</h2>
      {done ? (
        <>
          <p role="status">Your password was changed. Your other sessions were signed out.</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <Field label="New password" type="password" value={next} onChange={setNext} autoComplete="new-password" hint={PASSWORD_HINT} />
          <Field label="New password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" error={error} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Change password
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/**
 * The account button and its panel: who you are, Change password, Log out. Escape closes the panel and gives focus back to the button.
 * @param {{ user: { display_name: string, role: string }, onLogout: () => void, defaultOpen?: boolean }} props
 */
export function UserMenuView({ user, onLogout, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [changing, setChanging] = useState(false);
  const button = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div
      className="user-menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button ref={button} type="button" className="btn btn-small user-menu-button" aria-expanded={open} aria-controls="user-menu-panel" onClick={() => setOpen((o) => !o)}>
        {user.display_name}
      </button>
      {open && (
        <div id="user-menu-panel" className="user-menu-panel" role="group" aria-label="Account">
          <p className="user-menu-who">
            <strong>{user.display_name}</strong>
            <span>{ROLE_WORDS[user.role] ?? user.role}</span>
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            Change password
          </button>
          <button type="button" className="btn btn-small" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </div>
  );
}

/** The account menu of the signed-in person in shared mode; nothing in personal mode. */
export function UserMenu() {
  const { mode, user, refresh } = useSession();
  if (mode !== 'shared' || !user) return null;
  return (
    <UserMenuView
      user={user}
      onLogout={async () => {
        try {
          await postJson('/api/auth/logout', {});
        } finally {
          await refresh();
        }
      }}
    />
  );
}
