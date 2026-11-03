import { useState } from 'react';
import { postJson } from '../api.js';
import { AuthFrame, Field, PASSWORD_HINT } from './forms.jsx';
import { forgetHash, tokenFromHash } from './session.jsx';

/**
 * /setup: the owner chooses a password with the one-time link from `shared init`. The token is read from the address hash.
 * @param {{ token?: string | null, onDone: () => void }} props `token` lets a part be rendered with a token given; the app reads it from the address
 */
export function SetupPage({ token: given, onDone }) {
  const [token] = useState(() => given ?? tokenFromHash());
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (password !== again) return setError('The two passwords are not the same.');
    setBusy(true);
    setError(null);
    try {
      const { status, json } = await postJson('/api/auth/setup', { token, password });
      if (status === 200) {
        forgetHash();
        return onDone();
      }
      setError(status === 410 ? 'This setup link has expired or was already used. Ask whoever runs the server to run "shared init" again.' : (json?.message ?? 'Could not finish setup.'));
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    }
    setBusy(false);
  }

  if (!token) {
    return (
      <AuthFrame title="Set up StoryForge">
        <p className="field-error" role="alert">
          This page needs the setup link that &quot;shared init&quot; printed. Open that whole link, including the part after the # sign.
        </p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Choose the owner password">
      <form onSubmit={submit} noValidate aria-label="Choose the owner password" className="auth-form">
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
        <Field label="Password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Set password and sign in
        </button>
      </form>
    </AuthFrame>
  );
}
