// Settings -> AI connections (MCP). A friendly front for plugin access tokens named `mcp-<name>`: one key per AI client (Claude Code, Claude Desktop or any other
// MCP client), as many as the author wants. Pick a name, the client, the books and whether the AI may suggest changes, then the key is shown ONCE with setup text
// for that client. The key is kept in memory only while it is on screen. Uses the same routes as the Plugins panel; the client choice only shapes the setup text.
import { useId, useState } from 'react';
import { deleteJson, postJson, useApi } from '../api.js';
import { useModule } from '../prefs/PrefsContext.jsx';
import { TokenNotice, copyText } from './PluginsPanel.jsx';

const PREFIX = 'mcp-';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The AI clients the setup text is written for. Claude Desktop runs StoryForge's stdio bridge on the same computer, so it is offered only outside shared mode.
 * @type {readonly { id: 'claude-code' | 'claude-desktop' | 'other', label: string, example: string, personalOnly?: boolean }[]}
 */
export const CLIENTS = Object.freeze([
  { id: 'claude-code', label: 'Claude Code', example: 'laptop' },
  { id: 'claude-desktop', label: 'Claude Desktop', example: 'desktop', personalOnly: true },
  { id: 'other', label: 'Other MCP client', example: 'my-agent' },
]);

/** The clients this server can offer. @param {string | null | undefined} mode */
export const clientsFor = (mode) => CLIENTS.filter((c) => !(c.personalOnly && mode === 'shared'));

/**
 * The plugin slug for a connection name: `mcp-<name>`, lower-case letters, digits and hyphens (the plugin-tokens rule), and not a name already in use.
 * @param {string} name
 * @param {Iterable<string>} [taken] the slugs of the live connections
 * @returns {{ ok: true, slug: string } | { ok: false, message: string }}
 */
export function connectionSlug(name, taken = []) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (clean === '') return { ok: false, message: 'Give the connection a name, for example laptop.' };
  const slug = `${PREFIX}${clean}`;
  if (!SLUG_RE.test(slug)) return { ok: false, message: 'Use lower-case letters, digits and single hyphens only, for example laptop or work-pc.' };
  if (new Set(taken).has(slug)) return { ok: false, message: `You already have a connection named ${clean}. Pick another name, or revoke the old one first.` };
  return { ok: true, slug };
}

/**
 * The setup text for a new key. Claude Desktop (a stdio bridge on this computer) is only for personal mode.
 * @param {{ token: string, origin: string, mode: string | null | undefined }} p
 * @returns {{ address: string, header: string, claudeCode: string, claudeDesktop: string | null }}
 */
export function connectSnippets({ token, origin, mode }) {
  const address = `${origin}/mcp`;
  const header = `Authorization: Bearer ${token}`;
  const claudeCode = `claude mcp add --transport http storyforge ${address} --header "${header}"`;
  const claudeDesktop =
    mode === 'shared'
      ? null
      : JSON.stringify({ mcpServers: { storyforge: { command: 'node', args: ['<path to StoryForge>/apps/server/src/main.mjs', 'mcp'], env: { STORYFORGE_TOKEN: token } } } }, null, 2);
  return { address, header, claudeCode, claudeDesktop };
}

/**
 * The copy blocks to show for one client.
 * @param {string} client @param {ReturnType<typeof connectSnippets>} s
 * @returns {{ label: string, text: string }[]}
 */
export function setupBlocks(client, s) {
  if (client === 'claude-code') return [{ label: 'Claude Code command', text: s.claudeCode }];
  if (client === 'claude-desktop' && s.claudeDesktop) return [{ label: 'Claude Desktop config (claude_desktop_config.json)', text: s.claudeDesktop }];
  return [
    { label: 'Server address (Streamable HTTP)', text: s.address },
    { label: 'Header', text: s.header },
  ];
}

/** The permissions a connection gets: read always, propose, canvas and plan when ticked, events never. @param {boolean} propose @param {boolean} [canvas] @param {boolean} [plan] */
export const connectionPermissions = (propose, canvas = false, plan = false) => ['read', ...(propose ? ['propose'] : []), ...(canvas ? ['canvas'] : []), ...(plan ? ['plan'] : [])];

const permissionWords = (/** @type {string[]} */ perms) => perms.map((p) => (p === 'read' ? 'read your books' : p === 'propose' ? 'suggest changes' : p === 'canvas' ? 'edit canvases' : p === 'plan' ? 'change the plan' : p)).join(', ');
const booksText = (/** @type {'all' | string[]} */ books) => (books === 'all' ? 'All books' : books.join(', '));
const day = (/** @type {number | null | undefined} */ ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : null);

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

/** A choice of AI client, as radio buttons. @param {{ name: string, clients: typeof CLIENTS, value: string, onChange: (id: string) => void, legend: string }} props */
function ClientChoice({ name, clients, value, onChange, legend }) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      {clients.map((c) => (
        <label key={c.id} className="choice">
          <input type="radio" name={name} checked={value === c.id} onChange={() => onChange(c.id)} />
          <span>{c.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The key just made, with the setup text for the client picked (which can be switched while the key is on screen).
 * @param {{ created: { token: string, plugin: string, client: string }, origin: string, mode: string | null, onDone: () => void }} props
 */
function NewKey({ created, origin, mode, onDone }) {
  const id = useId();
  const clients = clientsFor(mode);
  const [client, setClient] = useState(clients.some((c) => c.id === created.client) ? created.client : clients[0].id);
  const snippets = connectSnippets({ token: created.token, origin, mode });
  return (
    <>
      <TokenNotice token={created.token} plugin={created.plugin} onDone={onDone} />
      <h3>Set up the AI client</h3>
      <ClientChoice name={`${id}-client`} legend="Show setup for" clients={clients} value={client} onChange={setClient} />
      {setupBlocks(client, snippets).map((b) => (
        <CopyBlock key={b.label} label={b.label} text={b.text} />
      ))}
      {client === 'other' && <p className="muted">Use these in any client that speaks MCP over Streamable HTTP and lets you set a header. Each POST carries one JSON-RPC message; there is no SSE stream.</p>}
    </>
  );
}

/**
 * @param {{ books: { slug: string, title: string }[], taken: string[], mode: string | null, busy: boolean, error: string | null,
 *   onCreate: (g: { plugin: string, permissions: string[], books: 'all' | string[], client: string }) => void }} props
 */
function ConnectForm({ books, taken, mode, busy, error, onCreate }) {
  const id = useId();
  const clients = clientsFor(mode);
  const [name, setName] = useState('');
  const [client, setClient] = useState(clients[0].id);
  const [propose, setPropose] = useState(true);
  const [canvas, setCanvas] = useState(false);
  const [plan, setPlan] = useState(false);
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState(/** @type {Set<string>} */ (new Set()));
  const slug = connectionSlug(name, taken);
  const ready = slug.ok && (scope === 'all' || picked.size > 0);
  const example = clients.find((c) => c.id === client)?.example ?? 'laptop';
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
        if (slug.ok && ready && !busy)
          onCreate({ plugin: slug.slug, permissions: connectionPermissions(propose, canvas, plan), books: scope === 'all' ? 'all' : books.map((b) => b.slug).filter((s) => picked.has(s)), client });
      }}
    >
      <h3 id={`${id}-h`}>{taken.length === 0 ? 'New connection' : 'Add another connection'}</h3>
      <ClientChoice name={`${id}-client`} legend="AI client" clients={clients} value={client} onChange={setClient} />
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={`${id}-hint`} autoComplete="off" spellCheck={false} placeholder={example} />
        <p id={`${id}-hint`} className="field-hint">
          {slug.ok ? `Saved as ${slug.slug}.` : name.trim() === '' ? `For example ${example}. Lower-case letters, digits and hyphens. Each connection gets its own key.` : slug.message}
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
        <span>The AI may suggest changes (nothing changes until you accept)</span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={canvas} onChange={() => setCanvas(!canvas)} />
        <span>The AI may edit canvases (planning boards only, never your prose)</span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={plan} onChange={() => setPlan(!plan)} />
        <span>Change the plan: the AI may write your Story Planner items (planning material, never your prose; you can Undo each change)</span>
      </label>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </form>
  );
}

/**
 * The panel from the server's answer (also used by tests).
 * @param {{ data: any, loadError?: string | null, moduleOff?: boolean, mode?: string | null, origin?: string, created?: { token: string, plugin: string, client?: string } | null,
 *   busy?: boolean, error?: string | null, formKey?: number, onCreate?: (g: any) => void, onRevoke?: (g: any) => void, onDone?: () => void }} props
 */
export function ClaudeView({ data, loadError = null, moduleOff = false, mode = null, origin = '', created = null, busy = false, error = null, formKey = 0, onCreate = () => {}, onRevoke = () => {}, onDone = () => {} }) {
  const grants = (data?.grants ?? []).filter((/** @type {any} */ g) => g.plugin.startsWith(PREFIX) && !g.revoked);
  const books = data?.books ?? [];
  const taken = grants.map((/** @type {any} */ g) => g.plugin);
  return (
    <section aria-labelledby="claude-heading" className="pref-section">
      <h2 id="claude-heading">AI connections (MCP)</h2>
      <p className="muted">
        Let {mode === 'shared' ? 'Claude Code' : 'Claude Code, Claude Desktop'} or another MCP client read your books. Make one key for each client or computer, as many as you need: each has its own books and permissions, and you can revoke one without affecting the
        others. An AI never changes your prose: a suggestion changes nothing until you accept it. Only if you tick them below may it edit your canvases or change your plan.
      </p>
      {moduleOff && <p className="field-warning">The Integrations module is off, so no AI client can reach your books. Turn it on under Modules above.</p>}
      {loadError && (
        <p role="alert" className="field-error">
          {loadError}
        </p>
      )}
      {created && <NewKey key={created.token} created={{ client: CLIENTS[0].id, ...created }} origin={origin} mode={mode} onDone={onDone} />}
      <h3 id="claude-connections-heading">Your connections{grants.length > 0 ? ` (${grants.length})` : ''}</h3>
      {grants.length === 0 ? (
        <p className="muted">No connections yet.</p>
      ) : (
        <ul className="ai-profile-list" aria-labelledby="claude-connections-heading">
          {grants.map((/** @type {any} */ g) => {
            const name = g.plugin.slice(PREFIX.length);
            const used = day(g.last_used);
            return (
              <li key={g.id} className="ai-profile-row">
                <p>
                  <strong>{name}</strong>
                </p>
                <p className="muted">
                  Can: {permissionWords(g.permissions)}. Books: {booksText(g.books)}.{day(g.created) ? ` Created ${day(g.created)}.` : ''} {used ? `Last used ${used}.` : 'Not used yet.'}
                </p>
                <button type="button" className="btn btn-small" aria-label={`Revoke the connection ${name}`} onClick={() => onRevoke(g)}>
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ConnectForm key={formKey} books={books} taken={taken} mode={mode} busy={busy} error={error} onCreate={onCreate} />
    </section>
  );
}

/** Settings -> AI connections (MCP). Only the owner reaches it in shared mode (the server refuses everyone else). @param {{ mode?: string | null }} props */
export function ClaudeSettings({ mode = null }) {
  const [bump, setBump] = useState(0);
  const { data, error: loadError } = useApi('/api/plugins', String(bump));
  const integrationsOn = useModule('integrations');
  const [created, setCreated] = useState(/** @type {null | { token: string, plugin: string, client: string, origin: string }} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [formKey, setFormKey] = useState(0);

  async function create(/** @type {{ plugin: string, permissions: string[], books: 'all' | string[], client: string }} */ { client, ...g }) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson('/api/plugins/grants', g);
      if (r.status === 201) {
        setCreated({ token: r.json.token, plugin: g.plugin, client, origin: window.location.origin });
        setFormKey((n) => n + 1); // a fresh, empty form for the next key
        setBump((n) => n + 1);
      } else setError(r.json?.message ?? `Not created (${r.status}).`);
    } catch {
      setError('The server could not be reached.');
    }
    setBusy(false);
  }
  async function revoke(/** @type {any} */ g) {
    if (!window.confirm(`Revoke the connection ${g.plugin.slice(PREFIX.length)}? The AI client using its key will stop working at once.`)) return;
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
      formKey={formKey}
      onCreate={create}
      onRevoke={revoke}
      onDone={() => setCreated(null)}
    />
  );
}
