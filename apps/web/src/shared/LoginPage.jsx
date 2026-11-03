import { useState } from 'react';
import { postJson } from '../api.js';
import { AuthFrame, Field } from './forms.jsx';

/** @param {number} status */
const reason = (status) => (status === 429 ? 'Too many wrong tries. Wait 15 minutes and try again.' : status === 401 ? 'Wrong user name or password.' : 'Could not sign in. Try again in a moment.');

/**
 * Sign in to a shared StoryForge. @param {{ needsOwner?: boolean, onSignedIn: () => void }} props
 */
export function LoginPage({ needsOwner = false, onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status } = await postJson('/api/auth/login', { username: username.trim(), password });
      if (status === 200) return onSignedIn();
      setError(reason(status));
    } catch {
      setError(reason(0));
    }
    setBusy(false);
  }

  return (
    <AuthFrame title="Sign in to StoryForge">
      {needsOwner && (
        <p role="status" className="banner banner-warning">
          The owner has not finished setting up yet. Open the setup link that &quot;shared init&quot; printed.
        </p>
      )}
      <form onSubmit={submit} noValidate aria-label="Sign in" className="auth-form">
        <Field label="User name" value={username} onChange={setUsername} autoComplete="username" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || username.trim() === '' || password === ''}>
          Sign in
        </button>
      </form>
    </AuthFrame>
  );
}
