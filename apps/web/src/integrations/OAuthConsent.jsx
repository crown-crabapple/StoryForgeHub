// /oauth/authorize: the page an AI app (claude.ai, ChatGPT, any MCP client that signs in with OAuth) sends the owner to. It shows which app asks and where it
// will return, and lets the owner choose the connection's name, books and permissions, exactly as Settings -> AI connections does; Allow makes that connection and
// returns to the app with a one-time code, Deny returns with access_denied. In shared mode the server lets only the owner see or answer it.
import { useEffect, useId, useState } from 'react';
import { postJson } from '../api.js';
import { AuthFrame } from '../shared/forms.jsx';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What each permission lets the app do, in the words of Settings -> AI connections. `read` is always given. */
export const CONSENT_PERMISSIONS = Object.freeze([
  { key: 'propose', label: 'Suggest changes (nothing changes until you accept)' },
  { key: 'canvas', label: 'Edit canvases (planning boards only, never your prose)' },
  { key: 'plan', label: 'Change the plan: write your Story Planner items (never your prose; you can Undo each change)' },
  { key: 'workspace', label: 'Workspace docs and ledgers: write your book and style docs, state notes and ledgers (never your prose; you can Undo each change)' },
  { key: 'draft', label: 'Create chapters and scenes as drafts (it never changes a scene you already have)' },
]);

/** The problem with a connection name, or null. @param {string} name @param {Iterable<string>} taken plugin slugs of live connections */
export function nameProblem(name, taken) {
  const clean = name.trim().toLowerCase();
  if (clean === '') return 'Give the connection a name.';
  if (!SLUG_RE.test(`mcp-${clean}`)) return 'Use lower-case letters, digits and single hyphens only, for example claude.';
  if (new Set(taken).has(`mcp-${clean}`)) return `You already have a connection named ${clean}. Pick another name.`;
  return null;
}

/**
 * The consent form from the server's answer (also used by tests).
 * @param {{ info: any, busy?: boolean, error?: string | null, onAllow: (choice: { name: string, books: 'all' | string[], permissions: string[] }) => void, onDeny: () => void }} props
 */
export function ConsentForm({ info, busy = false, error = null, onAllow, onDeny }) {
  const id = useId();
  const [name, setName] = useState(String(info.name ?? ''));
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState(/** @type {Set<string>} */ (new Set()));
  const [perms, setPerms] = useState(() => new Set(/** @type {string[]} */ (info.permissions?.ticked ?? ['read'])));
  const available = new Set(/** @type {string[]} */ (info.permissions?.available ?? []));
  const problem = nameProblem(name, info.taken ?? []);
  const ready = problem === null && (scope === 'all' || picked.size > 0);
  const flip = (/** @type {Set<string>} */ set, /** @type {string} */ k) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  };
  return (
    <form
      className="integrations-form oauth-consent"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        const books = scope === 'all' ? 'all' : info.books.map((/** @type {any} */ b) => b.slug).filter((/** @type {string} */ s) => picked.has(s));
        onAllow({ name: name.trim().toLowerCase(), books, permissions: ['read', ...CONSENT_PERMISSIONS.map((p) => p.key).filter((k) => perms.has(k))] });
      }}
    >
      <p id={`${id}-h`} className="oauth-consent-who">
        <strong>{info.client.name}</strong> wants to connect to your StoryForge. When you allow it, you go back to <strong>{info.client.redirect_host}</strong>.
      </p>
      <p className="muted">It can always read the books you pick. An AI never changes your prose: a suggestion changes nothing until you accept it.</p>
      <div className="field">
        <label htmlFor={`${id}-name`}>Connection name</label>
        <input id={`${id}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={`${id}-hint`} autoComplete="off" spellCheck={false} />
        <p id={`${id}-hint`} className={problem ? 'field-error' : 'field-hint'}>
          {problem ?? `Shown in Settings, AI connections as ${name.trim().toLowerCase()}. You can revoke it there at any time.`}
        </p>
      </div>
      <fieldset className="field">
        <legend>Books</legend>
        <label className="choice">
          <input type="radio" name={`${id}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>All books</span>
        </label>
        <label className="choice">
          <input type="radio" name={`${id}-scope`} checked={scope === 'some'} onChange={() => setScope('some')} />
          <span>Only these books</span>
        </label>
        {scope === 'some' &&
          (info.books ?? []).map((/** @type {any} */ b) => (
            <label key={b.slug} className="choice integrations-indent">
              <input type="checkbox" checked={picked.has(b.slug)} onChange={() => setPicked(flip(picked, b.slug))} />
              <span>{b.title}</span>
            </label>
          ))}
      </fieldset>
      <fieldset className="field">
        <legend>It may also</legend>
        {CONSENT_PERMISSIONS.filter((p) => available.has(p.key)).map((p) => (
          <label key={p.key} className="choice">
            <input type="checkbox" checked={perms.has(p.key)} onChange={() => setPerms(flip(perms, p.key))} />
            <span>{p.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="field-hint">The book&apos;s AI level (Settings, AI level) still limits what is allowed.</p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDeny} disabled={busy}>
          Deny
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Connecting…' : 'Allow'}
        </button>
      </div>
    </form>
  );
}

/**
 * What the page shows for each state (also used by tests).
 * @param {{ state: { kind: 'loading' } | { kind: 'ready', info: any } | { kind: 'error', message: string, redirect?: string | null } | { kind: 'leaving', app: string },
 *   busy?: boolean, error?: string | null, onAllow?: (c: any) => void, onDeny?: () => void, onReturn?: (url: string) => void }} props
 */
export function ConsentView({ state, busy = false, error = null, onAllow = () => {}, onDeny = () => {}, onReturn = () => {} }) {
  return (
    <AuthFrame title="Connect an AI app">
      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'leaving' && <p role="status">Returning you to {state.app}…</p>}
      {state.kind === 'error' && (
        <>
          <p role="alert" className="field-error">
            {state.message}
          </p>
          {state.redirect && (
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => onReturn(/** @type {string} */ (state.redirect))}>
                Return to the app
              </button>
            </div>
          )}
        </>
      )}
      {state.kind === 'ready' && <ConsentForm info={state.info} busy={busy} error={error} onAllow={onAllow} onDeny={onDeny} />}
    </AuthFrame>
  );
}

/** The message for a refused consent request. @param {number} status @param {any} json */
function refusal(status, json) {
  if (status === 403) return 'Only the owner of this StoryForge can connect an AI app. Ask the owner to connect it.';
  if (status === 401) return 'Sign in first, then start the connection again from the app.';
  return typeof json?.message === 'string' ? json.message : `This request cannot be answered (${status}).`;
}

/** The page at /oauth/authorize. */
export function OAuthConsentPage() {
  const query = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
  const [state, setState] = useState(/** @type {any} */ ({ kind: 'loading' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const leave = (/** @type {string} */ url) => window.location.assign(url);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/oauth/request?${query}`, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        setState(res.ok ? { kind: 'ready', info: json } : { kind: 'error', message: refusal(res.status, json), redirect: json?.redirect ?? null });
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setState({ kind: 'error', message: 'The server could not be reached.' });
      });
    return () => ctrl.abort();
  }, [query]);

  async function answer(/** @type {'approve' | 'deny'} */ what, /** @type {Record<string, unknown>} */ extra = {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson(`/api/oauth/${what}`, { request: query, ...extra });
      if (r.status === 200 && typeof r.json?.redirect === 'string') {
        setState({ kind: 'leaving', app: state.info?.client?.name ?? 'the app' });
        leave(r.json.redirect);
        return;
      }
      if (r.json?.redirect) setState({ kind: 'error', message: refusal(r.status, r.json), redirect: r.json.redirect });
      else setError(refusal(r.status, r.json));
    } catch {
      setError('The server could not be reached.');
    }
    setBusy(false);
  }

  return <ConsentView state={state} busy={busy} error={error} onAllow={(c) => answer('approve', c)} onDeny={() => answer('deny')} onReturn={leave} />;
}
