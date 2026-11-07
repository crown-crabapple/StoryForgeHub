// Settings -> Plugins (M08-J02). A plugin is a separate program you start yourself; StoryForge never runs it. This panel lists the plugin manifests found in the
// library (what each one will ask for), lets you grant access (you see the permissions and books and confirm), shows the access token ONCE, and lists and revokes
// the grants. The token is kept in memory only while it is on screen.
import { useId, useState } from 'react';
import { deleteJson, postJson, useApi } from '../api.js';
import { useModule } from '../prefs/PrefsContext.jsx';

export const PERMISSION_TEXT = {
  read: 'Read your books: the outline, scene text, the codex, threads, events, search and problems.',
  propose: 'Propose changes as suggestions. Nothing in your book changes until you accept a suggestion yourself.',
  canvas: 'Create, change, archive and restore canvases (planning boards). It never touches your prose.',
  plan: 'Change the plan: read and write the Story Planner (scene plans, links, structures, arcs, relationships, clues, synopses). You can Undo each change. It never touches your prose.',
  events: 'Subscribe to webhooks for its own address (it can never ask for scene text).',
};
const PERMISSIONS = Object.keys(PERMISSION_TEXT);

const booksText = (/** @type {'all' | string[]} */ books) => (books === 'all' ? 'All books' : books.join(', '));
const when = (/** @type {number | null} */ ms) => (ms === null || ms === undefined ? 'never' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

/** Copy `text` to the clipboard; false when the browser will not let us. @param {string} text */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The token, shown once. Copy puts it on the clipboard; Done removes it from the screen for good.
 * @param {{ token: string, plugin: string, onDone: () => void }} props
 */
export function TokenNotice({ token, plugin, onDone }) {
  const id = useId();
  const [copied, setCopied] = useState(/** @type {null | boolean} */ (null));
  return (
    <div className="integrations-secret" role="group" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Access token for {plugin}</h3>
      <p className="field-warning">Copy it now. It is shown only once and cannot be shown again. Anyone who has it can read what you granted, so keep it as private as a password.</p>
      <div className="field">
        <label htmlFor={`${id}-t`}>Token</label>
        <input id={`${id}-t`} type="text" readOnly value={token} onFocus={(e) => e.target.select()} spellCheck={false} autoComplete="off" />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => setCopied(await copyText(token))}
        >
          Copy token
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done, I have saved it
        </button>
      </div>
      <p role="status" className="muted">
        {copied === true ? 'Copied to the clipboard.' : copied === false ? 'Your browser did not allow copying. Select the token and copy it by hand.' : ''}
      </p>
    </div>
  );
}

/**
 * The confirmation before a grant: the permissions and the books, which you can narrow.
 * @param {{ ask: { plugin: string, name: string, permissions: string[], books: 'all' | string[], manual: boolean }, books: { slug: string, title: string }[], busy: boolean, error: string | null,
 *   onConfirm: (g: { plugin: string, permissions: string[], books: 'all' | string[] }) => void, onCancel: () => void }} props
 */
export function GrantForm({ ask, books, busy, error, onConfirm, onCancel }) {
  const id = useId();
  const [plugin, setPlugin] = useState(ask.plugin);
  const [perms, setPerms] = useState(new Set(ask.permissions));
  const [scope, setScope] = useState(ask.books === 'all' ? 'all' : 'some');
  const [picked, setPicked] = useState(new Set(ask.books === 'all' ? books.map((b) => b.slug) : ask.books));
  const toggle = (/** @type {Set<string>} */ set, /** @type {(s: Set<string>) => void} */ put, /** @type {string} */ k) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    put(next);
  };
  const ready = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin) && perms.size > 0 && (scope === 'all' || picked.size > 0);
  return (
    <form
      className="integrations-form"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onConfirm({ plugin, permissions: PERMISSIONS.filter((p) => perms.has(p)), books: scope === 'all' ? 'all' : books.map((b) => b.slug).filter((s) => picked.has(s)) });
      }}
    >
      <h3 id={`${id}-h`}>{ask.manual ? 'Grant access to another plugin' : `Grant access to ${ask.name}`}</h3>
      <p className="muted">Check what you are giving before you confirm. You can revoke it at any time, and the token can only do what is ticked here.</p>
      {ask.manual && (
        <div className="field">
          <label htmlFor={`${id}-slug`}>Plugin name (a slug: lower-case letters, digits, hyphens)</label>
          <input id={`${id}-slug`} type="text" value={plugin} onChange={(e) => setPlugin(e.target.value.trim())} autoComplete="off" spellCheck={false} />
        </div>
      )}
      <fieldset className="field">
        <legend>Permissions</legend>
        {PERMISSIONS.map((p) => (
          <label key={p} className="choice">
            <input type="checkbox" checked={perms.has(p)} onChange={() => toggle(perms, setPerms, p)} />
            <span>
              <strong>{p}</strong>: {PERMISSION_TEXT[p]}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field">
        <legend>Books</legend>
        <label className="choice">
          <input type="radio" name={`${id}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>All books in this library</span>
        </label>
        <label className="choice">
          <input type="radio" name={`${id}-scope`} checked={scope === 'some'} onChange={() => setScope('some')} />
          <span>Only these books</span>
        </label>
        {scope === 'some' &&
          books.map((b) => (
            <label key={b.slug} className="choice integrations-indent">
              <input type="checkbox" checked={picked.has(b.slug)} onChange={() => toggle(picked, setPicked, b.slug)} />
              <span>{b.title}</span>
            </label>
          ))}
      </fieldset>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Granting…' : 'Grant access'}
        </button>
      </div>
    </form>
  );
}

/**
 * The panel itself, from the server's answer (used alone by the accessibility audit).
 * @param {{ data: any, loadError?: string | null, moduleOff?: boolean, ask?: any, created?: { token: string, plugin: string } | null, busy?: boolean, error?: string | null,
 *   onAsk?: (a: any) => void, onCancel?: () => void, onConfirm?: (g: any) => void, onRevoke?: (g: any) => void, onDone?: () => void }} props
 */
export function PluginsView({ data, loadError = null, moduleOff = false, ask = null, created = null, busy = false, error = null, onAsk = () => {}, onCancel = () => {}, onConfirm = () => {}, onRevoke = () => {}, onDone = () => {} }) {
  const manifests = data?.manifests ?? [];
  const grants = data?.grants ?? [];
  const books = data?.books ?? [];
  const live = grants.filter((g) => !g.revoked);
  return (
    <section aria-labelledby="plugins-heading" className="pref-section">
      <h2 id="plugins-heading">Plugins</h2>
      <p className="muted">
        A plugin is a separate program you start yourself; StoryForge never runs it. With an access token you grant here it can read what you allow and propose changes as suggestions. It can never write a file of your
        book: a proposal changes nothing until you accept it in the normal review.
      </p>
      {moduleOff && <p className="field-warning">The Integrations module is off, so no plugin can reach your books and no webhook is sent. Turn it on under Modules above.</p>}
      {loadError && (
        <p role="alert" className="field-error">
          {loadError}
        </p>
      )}
      {created && <TokenNotice token={created.token} plugin={created.plugin} onDone={onDone} />}
      <h3 id="plugins-found-heading">Plugins found in this library</h3>
      {manifests.length === 0 ? (
        <p className="muted">None. A plugin describes itself in <code>_plugins/&lt;name&gt;/plugin.md</code> in your library folder.</p>
      ) : (
        <ul className="ai-profile-list" aria-labelledby="plugins-found-heading">
          {manifests.map((m) => {
            const errors = m.problems.filter((p) => p.code.startsWith('E'));
            return (
              <li key={m.path} className="ai-profile-row">
                <p>
                  <strong>{m.name ?? m.plugin ?? m.path}</strong> {m.version ? <span className="muted">version {m.version}</span> : null}
                </p>
                {m.description && <p className="muted">{m.description}</p>}
                <p className="muted">
                  Asks for: {m.permissions.length > 0 ? m.permissions.join(', ') : 'nothing valid'}. Books: {booksText(m.books)}.
                </p>
                {m.problems.map((p) => (
                  <p key={`${p.code}-${p.location}`} className={p.code.startsWith('E') ? 'field-error' : 'field-warning'}>
                    {p.code === 'W315' ? 'This plugin needs a newer StoryForge.' : `${p.code} ${p.location}: ${p.message}`}
                  </p>
                ))}
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={errors.length > 0 || m.problems.some((p) => p.code === 'W315') || !m.plugin}
                  aria-label={`Grant access to ${m.name ?? m.plugin}`}
                  onClick={() => onAsk({ plugin: m.plugin, name: m.name ?? m.plugin, permissions: m.permissions, books: m.books, manual: false })}
                >
                  Grant access
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {ask ? (
        <GrantForm key={ask.plugin ?? 'manual'} ask={ask} books={books} busy={busy} error={error} onConfirm={onConfirm} onCancel={onCancel} />
      ) : (
        <p>
          <button type="button" className="btn" onClick={() => onAsk({ plugin: '', name: '', permissions: ['read'], books: 'all', manual: true })}>
            Grant access to another plugin
          </button>
        </p>
      )}
      <h3 id="plugins-grants-heading">Access you have granted</h3>
      {grants.length === 0 ? (
        <p className="muted">No access granted yet.</p>
      ) : (
        <ul className="ai-profile-list" aria-labelledby="plugins-grants-heading">
          {grants.map((g) => (
            <li key={g.id} className="ai-profile-row">
              <p>
                <strong>{g.plugin}</strong> <span className="muted">{g.revoked ? 'revoked' : 'active'}</span>
              </p>
              <p className="muted">
                Permissions: {g.permissions.join(', ')}. Books: {booksText(g.books)}. Granted {when(g.created)}. Last used {when(g.last_used)}.
              </p>
              {!g.revoked && (
                <button type="button" className="btn btn-small" aria-label={`Revoke access for ${g.plugin} (${g.id})`} onClick={() => onRevoke(g)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {live.length === 0 && grants.length > 0 && <p className="muted">Every token has been revoked.</p>}
    </section>
  );
}

/** Settings -> Plugins, with its requests. Only the owner reaches it in shared mode (the server refuses everyone else). */
export function PluginsSettings() {
  const [bump, setBump] = useState(0);
  const { data, error: loadError } = useApi('/api/plugins', String(bump));
  const integrationsOn = useModule('integrations');
  const [ask, setAsk] = useState(/** @type {any} */ (null));
  const [created, setCreated] = useState(/** @type {null | { token: string, plugin: string }} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  async function confirm(/** @type {{ plugin: string, permissions: string[], books: 'all' | string[] }} */ g) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson('/api/plugins/grants', g);
      if (r.status === 201) {
        setCreated({ token: r.json.token, plugin: g.plugin });
        setAsk(null);
        setBump((n) => n + 1);
      } else setError(r.json?.message ?? `Not granted (${r.status}).`);
    } catch {
      setError('The server could not be reached.');
    }
    setBusy(false);
  }
  async function revoke(/** @type {any} */ g) {
    if (!window.confirm(`Revoke access for ${g.plugin}? It will stop working at once.`)) return;
    await deleteJson(`/api/plugins/grants/${encodeURIComponent(g.id)}`);
    setBump((n) => n + 1);
  }
  return (
    <PluginsView
      data={data}
      loadError={loadError}
      moduleOff={!integrationsOn}
      ask={ask}
      created={created}
      busy={busy}
      error={error}
      onAsk={(a) => {
        setError(null);
        setAsk(a);
      }}
      onCancel={() => setAsk(null)}
      onConfirm={confirm}
      onRevoke={revoke}
      onDone={() => setCreated(null)}
    />
  );
}
