// Settings -> Connect Claude. A friendly front for one plugin access token named `mcp-<name>`: pick a name, the books and whether Claude may suggest changes, then
// the token is shown ONCE with ready-made setup text. The token is kept in memory only while it is on screen. Uses the same routes as the Plugins panel.
import { useId, useState } from 'react';
import { deleteJson, postJson, useApi } from '../api.js';
import { useModule } from '../prefs/PrefsContext.jsx';
import { TokenNotice, copyText } from './PluginsPanel.jsx';

const PREFIX = 'mcp-';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The plugin slug for a connection name: `mcp-<name>`, lower-case letters, digits and hyphens (the plugin-tokens rule).
 * @param {string} name
 * @returns {{ ok: true, slug: string } | { ok: false, message: string }}
 */
export function connectionSlug(name) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (clean === '') return { ok: false, message: 'Give the connection a name, for example laptop.' };
  const slug = `${PREFIX}${clean}`;
  if (!SLUG_RE.test(slug)) return { ok: false, message: 'Use lower-case letters, digits and single hyphens only, for example laptop or work-pc.' };
  return { ok: true, slug };
}

/**
 * The setup text for a new token. Claude Desktop (a stdio bridge on this computer) is only for personal mode.
 * @param {{ token: string, origin: string, mode: string | null | undefined }} p
 * @returns {{ address: string, claudeCode: string, claudeDesktop: string | null }}
 */
export function connectSnippets({ token, origin, mode }) {
  const address = `${origin}/mcp`;
  const claudeCode = `claude mcp add --transport http storyforge ${address} --header "Authorization: Bearer ${token}"`;
  const claudeDesktop =
    mode === 'shared'
      ? null
      : JSON.stringify({ mcpServers: { storyforge: { command: 'node', args: ['<path to StoryForge>/apps/server/src/main.mjs', 'mcp'], env: { STORYFORGE_TOKEN: token } } } }, null, 2);
  return { address, claudeCode, claudeDesktop };
}

/** The permissions a connection gets: read always, propose when ticked, events never. @param {boolean} propose */
export const connectionPermissions = (propose) => (propose ? ['read', 'propose'] : ['read']);

const permissionWords = (/** @type {string[]} */ perms) => perms.map((p) => (p === 'read' ? 'read your books' : p === 'propose' ? 'suggest changes' : p)).join(', ');
const booksText = (/** @type {'all' | string[]} */ books) => (books === 'all' ? 'All books' : books.join(', '));
const day = (/** @type {number | undefined} */ ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : null);

/** A read-only block of text with a Copy button. @param {{ label: string, text: string }} props */
function CopyBlock({ label, text }) {
  const id = useId();
  const [copied, setCopied] = useState(/** @type {null | boolean} */ (null));
  return (
    <div className="field">
      <label htmlFor={`${id}-t`}>{label}</label>
      <textarea id={`${id}-t`} readOnly rows={Math.min(10, text.split('\n').length + 1)} value={text} onFocus={(e) => e.target.select()} spellCheck={false} />
      <button type="button" className="btn btn-small" aria-label={`Copy ${label}`} onClick={async () => setCopied(await copyText(text))}>
        Copy
      </button>
      <p role="status" className="muted">
        {copied === true ? 'Copied to the clipboard.' : copied === false ? 'Your browser did not allow copying. Select the text and copy it by hand.' : ''}
      </p>
    </div>
  );
}

/**
 * @param {{ books: { slug: string, title: string }[], busy: boolean, error: string | null, onCreate: (g: { plugin: string, permissions: string[], books: 'all' | string[] }) => void }} props
 */
function ConnectForm({ books, busy, error, onCreate }) {
  const id = useId();
  const [name, setName] = useState('');
  const [propose, setPropose] = useState(true);
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState(/** @type {Set<string>} */ (new Set()));
  const slug = connectionSlug(name);
  const ready = slug.ok && (scope === 'all' || picked.size > 0);
  const toggle = (/** @type {string} */ k) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };
  return (
    <form
      className="integrations-form"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        if (slug.ok && ready && !busy) onCreate({ plugin: slug.slug, permissions: connectionPermissions(propose), books: scope === 'all' ? 'all' : books.map((b) => b.slug).filter((s) => picked.has(s)) });
      }}
    >
      <h3 id={`${id}-h`}>New connection</h3>
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={`${id}-hint`} autoComplete="off" spellCheck={false} placeholder="laptop" />
        <p id={`${id}-hint`} className="field-hint">
          {slug.ok ? `Saved as ${slug.slug}.` : name.trim() === '' ? 'For example laptop. Lower-case letters, digits and hyphens.' : slug.message}
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
          books.map((b) => (
            <label key={b.slug} className="choice integrations-indent">
              <input type="checkbox" checked={picked.has(b.slug)} onChange={() => toggle(b.slug)} />
              <span>{b.title}</span>
            </label>
          ))}
      </fieldset>
      <label className="choice">
        <input type="checkbox" checked={propose} onChange={() => setPropose(!propose)} />
        <span>Claude may suggest changes (nothing changes until you accept)</span>
      </label>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Creating…' : 'Create connection'}
        </button>
      </div>
    </form>
  );
}

/**
 * The panel from the server's answer (also used by tests).
 * @param {{ data: any, loadError?: string | null, moduleOff?: boolean, mode?: string | null, origin?: string, created?: { token: string, plugin: string } | null, busy?: boolean, error?: string | null,
 *   onCreate?: (g: any) => void, onRevoke?: (g: any) => void, onDone?: () => void }} props
 */
export function ClaudeView({ data, loadError = null, moduleOff = false, mode = null, origin = '', created = null, busy = false, error = null, onCreate = () => {}, onRevoke = () => {}, onDone = () => {} }) {
  const grants = (data?.grants ?? []).filter((/** @type {any} */ g) => g.plugin.startsWith(PREFIX) && !g.revoked);
  const books = data?.books ?? [];
  const snippets = created ? connectSnippets({ token: created.token, origin, mode }) : null;
  return (
    <section aria-labelledby="claude-heading" className="pref-section">
      <h2 id="claude-heading">Connect Claude</h2>
      <p className="muted">
        Let Claude Code or Claude Desktop read your books. Claude gets its own access token, which you can revoke at any time. Claude can never change a file: a suggestion changes nothing until you accept it.
      </p>
      {moduleOff && <p className="field-warning">The Integrations module is off, so Claude cannot reach your books. Turn it on under Modules above.</p>}
      {loadError && (
        <p role="alert" className="field-error">
          {loadError}
        </p>
      )}
      {created && snippets && (
        <>
          <TokenNotice token={created.token} plugin={created.plugin} onDone={onDone} />
          <h3>Set up Claude</h3>
          <CopyBlock label="Address" text={snippets.address} />
          <CopyBlock label="Claude Code command" text={snippets.claudeCode} />
          {snippets.claudeDesktop && <CopyBlock label="Claude Desktop config (claude_desktop_config.json)" text={snippets.claudeDesktop} />}
        </>
      )}
      <ConnectForm books={books} busy={busy} error={error} onCreate={onCreate} />
      <h3 id="claude-connections-heading">Claude connections</h3>
      {grants.length === 0 ? (
        <p className="muted">No connections yet.</p>
      ) : (
        <ul className="ai-profile-list" aria-labelledby="claude-connections-heading">
          {grants.map((/** @type {any} */ g) => {
            const name = g.plugin.slice(PREFIX.length);
            return (
              <li key={g.id} className="ai-profile-row">
                <p>
                  <strong>{name}</strong>
                </p>
                <p className="muted">
                  Can: {permissionWords(g.permissions)}. Books: {booksText(g.books)}.{day(g.created) ? ` Created ${day(g.created)}.` : ''}
                </p>
                <button type="button" className="btn btn-small" aria-label={`Revoke the connection ${name}`} onClick={() => onRevoke(g)}>
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Settings -> Connect Claude. Only the owner reaches it in shared mode (the server refuses everyone else). @param {{ mode?: string | null }} props */
export function ClaudeSettings({ mode = null }) {
  const [bump, setBump] = useState(0);
  const { data, error: loadError } = useApi('/api/plugins', String(bump));
  const integrationsOn = useModule('integrations');
  const [created, setCreated] = useState(/** @type {null | { token: string, plugin: string, origin: string }} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  async function create(/** @type {{ plugin: string, permissions: string[], books: 'all' | string[] }} */ g) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson('/api/plugins/grants', g);
      if (r.status === 201) {
        setCreated({ token: r.json.token, plugin: g.plugin, origin: window.location.origin });
        setBump((n) => n + 1);
      } else setError(r.json?.message ?? `Not created (${r.status}).`);
    } catch {
      setError('The server could not be reached.');
    }
    setBusy(false);
  }
  async function revoke(/** @type {any} */ g) {
    if (!window.confirm(`Revoke the connection ${g.plugin.slice(PREFIX.length)}? Claude will stop working with it at once.`)) return;
    await deleteJson(`/api/plugins/grants/${encodeURIComponent(g.id)}`);
    setBump((n) => n + 1);
  }
  return (
    <ClaudeView
      data={data}
      loadError={loadError}
      moduleOff={!integrationsOn}
      mode={mode}
      origin={created?.origin ?? ''}
      created={created}
      busy={busy}
      error={error}
      onCreate={create}
      onRevoke={revoke}
      onDone={() => setCreated(null)}
    />
  );
}
