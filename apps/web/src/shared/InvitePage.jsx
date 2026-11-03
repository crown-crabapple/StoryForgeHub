import { useEffect, useState } from 'react';
import { postJson } from '../api.js';
import { AuthFrame, Field, PASSWORD_HINT } from './forms.jsx';
import { ROLE_WORDS, forgetHash, tokenFromHash } from './session.jsx';

/**
 * /invite: look at what the link grants, then choose a user name, a display name and a password.
 * @param {{ token?: string | null, peek?: { role: string, expires: number } | null, onDone: () => void }} props
 *   `token` and `peek` let a part be rendered with them given (peek null: the invite is not valid); the app reads the token from the address and asks the server
 */
export function InvitePage({ token: given, peek: givenPeek, onDone }) {
  const [token] = useState(() => given ?? tokenFromHash());
  const [asked, setAsked] = useState(/** @type {{ role: string, expires: number } | null | undefined} */ (undefined));
  const peek = givenPeek === undefined ? asked : givenPeek;
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (givenPeek !== undefined || !token) return undefined;
    let live = true;
    fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`, { headers: { accept: 'application/json' } })
      .then(async (res) => (res.ok ? await res.json() : null))
      .catch(() => null)
      .then((j) => {
        if (live) setAsked(j);
      });
    return () => {
      live = false;
    };
  }, [token, givenPeek]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (password !== again) return setError('The two passwords are not the same.');
    setBusy(true);
    setError(null);
    try {
      const { status, json } = await postJson('/api/auth/invite/accept', { token, username: username.trim(), display_name: displayName.trim(), password });
      if (status === 200) {
        forgetHash();
        return onDone();
      }
      setError(status === 410 ? 'This invitation has expired, was used already, or was withdrawn. Ask for a new one.' : (json?.message ?? 'Could not create the account.'));
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    }
    setBusy(false);
  }

  if (!token || peek === null) {
    return (
      <AuthFrame title="Invitation">
        <p className="field-error" role="alert">
          This invitation is not valid any more. It may have expired, been used already, or been withdrawn. Ask the owner for a new one.
        </p>
      </AuthFrame>
    );
  }
  if (peek === undefined) {
    return (
      <AuthFrame title="Invitation">
        <p role="status">Checking the invitation...</p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Join StoryForge">
      <p>
        You are invited as <strong>{ROLE_WORDS[peek.role] ?? peek.role}</strong>.
      </p>
      <form onSubmit={submit} noValidate aria-label="Create your account" className="auth-form">
        <Field label="User name" value={username} onChange={setUsername} autoComplete="username" hint="3 to 32 characters: a-z, 0-9, dot, underscore or hyphen." />
        <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" required={false} hint="What other people see. Optional." />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
        <Field label="Password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create account
        </button>
      </form>
    </AuthFrame>
  );
}
