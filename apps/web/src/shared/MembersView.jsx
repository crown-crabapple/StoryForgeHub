import { useEffect, useState } from 'react';
import { deleteJson, postJson, putJson } from '../api.js';
import { Link } from '../router.jsx';
import { MembersPage } from './MembersPage.jsx';
import { useSession } from './session.jsx';

const getJson = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

async function fetchAll() {
  const [m, i, s, set, books] = await Promise.all([getJson('/api/shared/members'), getJson('/api/shared/invites'), getJson('/api/shared/shares'), getJson('/api/shared/settings'), getJson('/api/books')]);
  return { members: m.members, invites: i.invites, shares: s.shares, settings: set, books: books.map((b) => ({ id: b.id, title: b.title })) };
}

/** Settings, Members: loads the owner's lists and turns each control into one admin call. Anyone who is not the owner is told so (the server refuses them anyway). */
export function MembersView() {
  const { user } = useSession();
  const isOwner = user?.role === 'owner';
  const [state, setState] = useState(/** @type {any} */ (null));
  const [link, setLink] = useState(/** @type {{ kind: string, url: string } | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  const [reloadError, setReloadError] = useState(false);
  useEffect(() => {
    if (!isOwner) return undefined;
    let live = true;
    fetchAll().then(
      (next) => live && setState(next),
      () => live && setReloadError(true),
    );
    return () => {
      live = false;
    };
  }, [isOwner]);
  async function load() {
    try {
      setState(await fetchAll());
    } catch {
      setError('Could not load the members. Try again in a moment.');
    }
  }

  /** Run one admin call, then reload the lists. @param {() => Promise<{ status: number, json: any }>} call @param {(json: any) => void} [after] */
  async function run(call, after) {
    setBusy(true);
    setError(null);
    try {
      const { status, json } = await call();
      if (status >= 200 && status < 300) after?.(json);
      else setError(json?.message ?? 'That did not work.');
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    }
    await load();
    setBusy(false);
  }

  if (!isOwner) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Members and sharing</h1>
        <p>Only the owner can manage members and sharing.</p>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  if (!state) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Members and sharing</h1>
        {error || reloadError ? (
          <p role="alert" className="banner banner-danger">
            {error ?? 'Could not load the members. Try again in a moment.'}
          </p>
        ) : (
          <p role="status">Loading...</p>
        )}
      </main>
    );
  }
  return (
    <MembersPage
      {...state}
      currentUserId={user?.id}
      link={link}
      error={error}
      busy={busy}
      onDismissLink={() => setLink(null)}
      onRole={(id, role) => run(() => putJson(`/api/shared/members/${encodeURIComponent(id)}`, { role }))}
      onBooks={(id, books) => run(() => putJson(`/api/shared/members/${encodeURIComponent(id)}`, { books }))}
      onRemove={(id) => run(() => deleteJson(`/api/shared/members/${encodeURIComponent(id)}`))}
      onInvite={({ role, days, books }) => run(() => postJson('/api/shared/invites', { role, expires_days: days, ...(books ? { books } : {}) }), (j) => setLink({ kind: 'invitation', url: j.link }))}
      onRevokeInvite={(id) => run(() => deleteJson(`/api/shared/invites/${encodeURIComponent(id)}`))}
      onShare={({ book, scope, days }) => run(() => postJson('/api/shared/shares', { book, scope, expires_days: days }), (j) => setLink({ kind: 'share', url: j.link }))}
      onRevokeShare={(id) => run(() => deleteJson(`/api/shared/shares/${encodeURIComponent(id)}`))}
      onAi={(on) => run(() => putJson('/api/shared/settings', { ai_for_members: on }))}
    />
  );
}
