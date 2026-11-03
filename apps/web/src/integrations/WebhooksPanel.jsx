// Settings -> Webhooks (M08-J02). A webhook tells a program of yours that something happened: StoryForge sends a signed POST with the ids and hashes of what changed.
// The scene text is never in it unless you tick "Include the scene text" below, and a plugin can never turn that on. The signing secret is shown once.
import { useId, useState } from 'react';
import { deleteJson, postJson, useApi } from '../api.js';
import { useModule } from '../prefs/PrefsContext.jsx';

export const EVENT_TEXT = {
  'scene.saved': 'A scene was saved',
  'scene.created': 'A scene was created',
  'scene.moved': 'A scene was moved',
  'entry.changed': 'A codex entry changed',
  'suggestion.created': 'A suggestion was made',
  'suggestion.decided': 'A suggestion was accepted or declined',
  'export.done': 'An export finished',
  'backup.done': 'A backup finished',
};
const EVENTS = Object.keys(EVENT_TEXT);
const booksText = (/** @type {'all' | string[]} */ books) => (books === 'all' ? 'All books' : books.join(', '));
const when = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** @param {any} w a webhook as the server lists it @returns {string} */
export function statusText(w) {
  if (w.revoked) return 'Revoked.';
  if (w.disabled) return 'Disabled after 20 failed deliveries in a row. Create it again to resume.';
  return 'Active.';
}

/** @param {any} w @returns {string} */
export function lastDeliveryText(w) {
  const d = w.last_delivery;
  if (!d) return 'No delivery yet.';
  return d.ok ? `Last delivery ${when(d.at)}: delivered (${d.status ?? 'ok'}).` : `Last delivery ${when(d.at)}: failed (${d.status ?? d.code ?? 'no answer'}).`;
}

/**
 * The secret, shown once.
 * @param {{ secret: string, url: string, onDone: () => void }} props
 */
export function SecretNotice({ secret, url, onDone }) {
  const id = useId();
  const [copied, setCopied] = useState(/** @type {null | boolean} */ (null));
  return (
    <div className="integrations-secret" role="group" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Signing secret for {url}</h3>
      <p className="field-warning">Copy it now. It is shown only once. Your receiver needs it to check the signature of each delivery (x-storyforge-signature).</p>
      <div className="field">
        <label htmlFor={`${id}-s`}>Secret</label>
        <input id={`${id}-s`} type="text" readOnly value={secret} onFocus={(e) => e.target.select()} spellCheck={false} autoComplete="off" />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          Copy secret
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done, I have saved it
        </button>
      </div>
      <p role="status" className="muted">
        {copied === true ? 'Copied to the clipboard.' : copied === false ? 'Your browser did not allow copying. Select the secret and copy it by hand.' : ''}
      </p>
    </div>
  );
}

/**
 * The create form.
 * @param {{ books: { slug: string, title: string }[], busy: boolean, error: string | null, onCreate: (w: any) => void }} props
 */
export function WebhookForm({ books, busy, error, onCreate }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(new Set(['scene.saved']));
  const [scope, setScope] = useState('all');
  const [picked, setPicked] = useState(new Set(/** @type {string[]} */ ([])));
  const [content, setContent] = useState(false);
  const [local, setLocal] = useState(false);
  const toggle = (/** @type {Set<string>} */ set, /** @type {(s: Set<string>) => void} */ put, /** @type {string} */ k) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    put(next);
  };
  const ready = url.trim() !== '' && events.size > 0 && (scope === 'all' || picked.size > 0);
  return (
    <form
      className="integrations-form"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) {
          onCreate({ url: url.trim(), events: EVENTS.filter((x) => events.has(x)), books: scope === 'all' ? 'all' : books.map((b) => b.slug).filter((s) => picked.has(s)), include_content: content, allow_local: local });
        }
      }}
    >
      <h3 id={`${id}-h`}>Create a webhook</h3>
      <div className="field">
        <label htmlFor={`${id}-url`}>Address to send to</label>
        <input id={`${id}-url`} type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="your-receiver.example/storyforge" autoComplete="off" spellCheck={false} aria-describedby={`${id}-url-hint`} />
        <p id={`${id}-url-hint`} className="field-hint muted">
          Use https. Plain http is allowed only for this computer (localhost or 127.0.0.1). Redirects are never followed.
        </p>
      </div>
      <fieldset className="field">
        <legend>Send when</legend>
        {EVENTS.map((ev) => (
          <label key={ev} className="choice">
            <input type="checkbox" checked={events.has(ev)} onChange={() => toggle(events, setEvents, ev)} />
            <span>
              {EVENT_TEXT[ev]} <code>{ev}</code>
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
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} aria-describedby={`${id}-content-warning`} />
          <span>Include the scene text</span>
        </label>
        <p id={`${id}-content-warning`} className="field-warning">
          Warning: with this on, the full text of every scene you save is sent to the address above, as plain JSON. Only turn it on for a receiver you run yourself and trust. With it off (the default) only ids,
          the file path and a hash are sent, never any of your writing.
        </p>
      </div>
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          <span>Allow a private network address (https only)</span>
        </label>
        <p className="field-hint muted">Needed for an address on your home or office network, such as 192.168.x.x. This computer itself is always allowed.</p>
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Creating…' : 'Create webhook'}
        </button>
      </div>
    </form>
  );
}

/**
 * The panel itself, from the server's answer (used alone by the accessibility audit).
 * @param {{ data: any, loadError?: string | null, moduleOff?: boolean, created?: { secret: string, url: string } | null, busy?: boolean, error?: string | null,
 *   onCreate?: (w: any) => void, onRevoke?: (w: any) => void, onDone?: () => void }} props
 */
export function WebhooksView({ data, loadError = null, moduleOff = false, created = null, busy = false, error = null, onCreate = () => {}, onRevoke = () => {}, onDone = () => {} }) {
  const hooks = data?.webhooks ?? [];
  const books = data?.books ?? [];
  return (
    <section aria-labelledby="webhooks-heading" className="pref-section">
      <h2 id="webhooks-heading">Webhooks</h2>
      <p className="muted">
        A webhook sends a signed message to an address when something happens in your books. By default it carries only ids, the file path and a hash, never your writing. Nothing is sent at all until you create one here
        (or grant a plugin the right to ask for its own).
      </p>
      {moduleOff && <p className="field-warning">The Integrations module is off, so nothing is sent. Turn it on under Modules above.</p>}
      {loadError && (
        <p role="alert" className="field-error">
          {loadError}
        </p>
      )}
      {created && <SecretNotice secret={created.secret} url={created.url} onDone={onDone} />}
      <h3 id="webhooks-list-heading">Your webhooks</h3>
      {hooks.length === 0 ? (
        <p className="muted">None. StoryForge sends nothing anywhere.</p>
      ) : (
        <ul className="ai-profile-list" aria-labelledby="webhooks-list-heading">
          {hooks.map((w) => (
            <li key={w.id} className="ai-profile-row">
              <p>
                <strong>{w.url}</strong>
                {w.plugin ? <span className="muted"> (made by the plugin {w.plugin})</span> : null}
              </p>
              <p className="muted">
                Events: {w.events.join(', ')}. Books: {booksText(w.books)}. {w.include_content ? 'Includes the scene text.' : 'Ids and hashes only.'}
              </p>
              <p className={w.disabled ? 'field-warning' : 'muted'}>
                {statusText(w)} {lastDeliveryText(w)}
              </p>
              {!w.revoked && (
                <button type="button" className="btn btn-small" aria-label={`Revoke the webhook to ${w.url} (${w.id})`} onClick={() => onRevoke(w)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <WebhookForm books={books} busy={busy} error={error} onCreate={onCreate} />
    </section>
  );
}

/** Settings -> Webhooks, with its requests. */
export function WebhooksSettings() {
  const [bump, setBump] = useState(0);
  const { data, error: loadError } = useApi('/api/webhooks', String(bump));
  const integrationsOn = useModule('integrations');
  const [created, setCreated] = useState(/** @type {null | { secret: string, url: string }} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  async function create(/** @type {any} */ w) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson('/api/webhooks', w);
      if (r.status === 201) {
        setCreated({ secret: r.json.secret, url: r.json.webhook.url });
        setBump((n) => n + 1);
      } else setError(r.json?.message ?? `Not created (${r.status}).`);
    } catch {
      setError('The server could not be reached.');
    }
    setBusy(false);
  }
  async function revoke(/** @type {any} */ w) {
    if (!window.confirm(`Revoke the webhook to ${w.url}? Nothing more will be sent there.`)) return;
    await deleteJson(`/api/webhooks/${encodeURIComponent(w.id)}`);
    setBump((n) => n + 1);
  }
  return <WebhooksView data={data} loadError={loadError} moduleOff={!integrationsOn} created={created} busy={busy} error={error} onCreate={create} onRevoke={revoke} onDone={() => setCreated(null)} />;
}
