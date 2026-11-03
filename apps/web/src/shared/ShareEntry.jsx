import { useEffect, useState } from 'react';
import { postJson } from '../api.js';
import { AuthFrame } from './forms.jsx';
import { forgetHash, tokenFromHash } from './session.jsx';

/**
 * /s: a read-only share link. The token goes to the server once, in a POST body; then the book opens read-only.
 * @param {{ onOpened: (share: { book: string, scope: string[] }) => void }} props
 */
export function ShareEntry({ onOpened }) {
  const [failed, setFailed] = useState(() => tokenFromHash() === null);
  useEffect(() => {
    const token = tokenFromHash();
    if (!token) return undefined;
    let live = true;
    postJson('/api/auth/share', { token }).then(
      ({ status, json }) => {
        if (!live) return;
        if (status === 200 && json?.share?.book) {
          forgetHash();
          window.history.replaceState(null, '', '/');
          onOpened(json.share);
        } else setFailed(true);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [onOpened]);
  return (
    <AuthFrame title="Shared book">
      {failed ? (
        <p className="field-error" role="alert">
          This link is not valid any more. It may have expired or been withdrawn. Ask for a new one.
        </p>
      ) : (
        <p role="status">Opening the book...</p>
      )}
    </AuthFrame>
  );
}
