// Settings. The only AI entry in the app: "Set up AI (optional)". StoryForge works completely without it; with no provider profile nothing is ever sent anywhere.
import { useState } from 'react';
import { useApi } from '../api.js';
import { ClaudeSettings } from '../integrations/ClaudePanel.jsx';
import { PluginsSettings } from '../integrations/PluginsPanel.jsx';
import { WebhooksSettings } from '../integrations/WebhooksPanel.jsx';
import { PreferencesSettings } from '../prefs/PreferencesSettings.jsx';
import { Link } from '../router.jsx';
import { useSession } from '../shared/session.jsx';
import { backendText, hostOf, isInsecureCloud, keyStorageChoices, localityOf } from './model.js';
import { LocalityBadge } from './parts.jsx';
import { aiRequest, aiUrl } from './requests.js';

const IMAGE_KIND = 'openai-compatible-images';
const EMPTY = { kind: 'openai-compatible', name: '', baseUrl: '', model: '', temperature: '', maxTokens: '', contextBudget: '8000', keyStorage: 'none', apiKey: '' };

/** The form fields for a saved profile (the key is never sent back by the server, so it starts empty). @param {any} p */
const fromProfile = (p) => ({
  kind: p.kind ?? 'openai-compatible',
  name: p.name,
  baseUrl: p.baseUrl,
  model: p.model,
  temperature: p.temperature === undefined ? '' : String(p.temperature),
  maxTokens: p.maxTokens === undefined ? '' : String(p.maxTokens),
  contextBudget: String(p.contextBudget),
  keyStorage: p.keyStorage,
  apiKey: '',
});

/** @param {typeof EMPTY} f @param {boolean} editing the request body */
function bodyOf(f) {
  return {
    name: f.name,
    kind: f.kind ?? 'openai-compatible',
    baseUrl: f.baseUrl,
    model: f.model,
    temperature: f.temperature.trim() === '' ? null : Number(f.temperature),
    maxTokens: f.maxTokens.trim() === '' ? null : Number(f.maxTokens),
    contextBudget: Number(f.contextBudget),
    keyStorage: f.keyStorage,
    ...(f.keyStorage !== 'none' && f.apiKey !== '' ? { apiKey: f.apiKey } : {}),
  };
}

/**
 * Add or edit one provider profile. Locality is shown from the address (the server decides it for real); the key choices say plainly where a key would live.
 * @param {{ initial: typeof EMPTY, hasKey: boolean, configFile: string, secureBackend?: string | null, saving: boolean, error: string | null, onSave: (f: typeof EMPTY) => void, onCancel: () => void, title: string }} props
 */
export function ProfileForm({ initial, hasKey, configFile, secureBackend = null, saving, error, onSave, onCancel, title }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const insecure = isInsecureCloud(f.baseUrl);
  const looksLikeUrl = /^https?:\/\//i.test(f.baseUrl.trim());
  return (
    <form
      className="ai-profile-form"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <h3>{title}</h3>
      <div className="field">
        <label htmlFor="ai-kind">Type</label>
        <select id="ai-kind" value={f.kind ?? 'openai-compatible'} onChange={set('kind')}>
          <option value="openai-compatible">Chat model (OpenAI-compatible)</option>
          <option value={IMAGE_KIND}>Image model for cover drafts (OpenAI-compatible images)</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="ai-name">Name</label>
        <input id="ai-name" type="text" value={f.name} onChange={set('name')} required />
      </div>
      <div className="field">
        <label htmlFor="ai-url">Base URL</label>
        <input id="ai-url" type="text" value={f.baseUrl} onChange={set('baseUrl')} placeholder={`${globalThis.location?.protocol ?? 'http:'}//localhost:11434/v1`} aria-invalid={insecure ? 'true' : undefined} required />
        {looksLikeUrl && !insecure && <p className="muted">{localityOf(f.baseUrl) === 'local' ? <LocalityBadge locality="local" host={hostOf(f.baseUrl)} /> : <LocalityBadge locality="cloud" host={hostOf(f.baseUrl)} />}</p>}
        {insecure && <p className="field-error">A cloud provider must use https. Plain http is only allowed for localhost, 127.0.0.1 and [::1].</p>}
      </div>
      <div className="field">
        <label htmlFor="ai-model">Model</label>
        <input id="ai-model" type="text" value={f.model} onChange={set('model')} required />
      </div>
      <div className="field">
        <label htmlFor="ai-temp">Temperature (optional)</label>
        <input id="ai-temp" type="number" step="0.1" min="0" max="2" value={f.temperature} onChange={set('temperature')} />
      </div>
      <div className="field">
        <label htmlFor="ai-max">Maximum reply tokens (optional)</label>
        <input id="ai-max" type="number" min="1" value={f.maxTokens} onChange={set('maxTokens')} />
      </div>
      <div className="field">
        <label htmlFor="ai-budget">Context budget (tokens)</label>
        <input id="ai-budget" type="number" min="200" value={f.contextBudget} onChange={set('contextBudget')} required />
      </div>
      <fieldset className="field">
        <legend>API key</legend>
        {keyStorageChoices(secureBackend).map((c) => (
          <label key={c.value} className="ai-check">
            <input type="radio" name="ai-key-storage" value={c.value} checked={f.keyStorage === c.value} onChange={() => setF((x) => ({ ...x, keyStorage: c.value }))} /> {c.label}
          </label>
        ))}
        {f.keyStorage !== 'none' && (
          <>
            <label htmlFor="ai-key">{hasKey ? 'New key (leave empty to keep the saved one)' : 'Key'}</label>
            <input id="ai-key" type="password" autoComplete="off" value={f.apiKey} onChange={set('apiKey')} />
          </>
        )}
        {f.keyStorage === 'config' && (
          <p className="ai-plain-text" role="note">
            This saves the key as <strong>plain text</strong> in <code>{configFile}</code>, outside your books. Anyone who can read your user folder can read it. It is never put in a book, a backup or an export.
          </p>
        )}
        {f.keyStorage === 'secure' && (
          <p className="muted">
            The key is kept by {backendText(secureBackend)}, outside your books. It is never put in a book, a backup, an export or the settings file.
          </p>
        )}
        {f.keyStorage === 'session' && <p className="muted">The key stays in memory until StoryForge restarts, then it is forgotten. It is never saved to disk.</p>}
      </fieldset>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || insecure}>
          Save profile
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One book: which profile it uses (none = AI off for it) and whether chat and rewrite records are saved in the book. */
function BookAiRow({ book, profiles }) {
  const [bump, setBump] = useState(0);
  const { data: status } = useApi(aiUrl.bookStatus(book.id), String(bump));
  const [error, setError] = useState(null);
  if (!status) return null;
  const change = async (call) => {
    setError(null);
    const r = await call();
    if (r.status === 200) setBump((n) => n + 1);
    else setError(r.json?.message ?? `Not saved (${r.status}).`);
  };
  return (
    <li className="ai-book-row">
      <strong>{book.title ?? book.slug ?? book.id}</strong>
      <div className="field">
        <label htmlFor={`ai-book-${book.id}`}>AI provider for this book</label>
        <select id={`ai-book-${book.id}`} value={status.active?.id ?? ''} onChange={(e) => change(() => aiRequest('PUT', aiUrl.bookProfile(book.id), { profileId: e.target.value === '' ? null : e.target.value }))}>
          <option value="">None (AI is off)</option>
          {profiles.filter((p) => p.kind !== IMAGE_KIND).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.locality})
            </option>
          ))}
        </select>
      </div>
      {profiles.some((p) => p.kind === IMAGE_KIND) && (
        <div className="field">
          <label htmlFor={`ai-image-${book.id}`}>Image provider for cover drafts</label>
          <select
            id={`ai-image-${book.id}`}
            value={status.image?.id ?? ''}
            onChange={(e) => change(() => aiRequest('PUT', aiUrl.bookProfile(book.id), e.target.value === '' ? { profileId: null, kind: 'image' } : { profileId: e.target.value }))}
          >
            <option value="">None (no cover generation)</option>
            {profiles.filter((p) => p.kind === IMAGE_KIND).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.locality})
              </option>
            ))}
          </select>
        </div>
      )}
      <label className="ai-check">
        <input type="checkbox" checked={status.records} onChange={(e) => change(() => aiRequest('PUT', aiUrl.bookRecords(book.id), { enabled: e.target.checked }))} /> Save each chat and rewrite as a file in this book (ai/ folder)
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={status.usage === true} onChange={(e) => change(() => aiRequest('PUT', aiUrl.bookRecords(book.id), { usage: e.target.checked }))} /> Keep a daily token table for this book (activity/ai-usage.md; counts only, never sent anywhere)
      </label>
      {error && <p className="form-error">{error}</p>}
    </li>
  );
}

/** One saved profile: what it is, where requests go, and the actions on it. */
function ProfileRow({ profile, secureBackend = null, onEdit, onDelete, onChanged }) {
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(/** @type {any} */ (profile.capabilities ?? null));
  const [moved, setMoved] = useState(/** @type {string | null} */ (null));
  const image = profile.kind === IMAGE_KIND;
  /** Test connection: list the models and learn whether streaming and usage are reported. No book text is sent. */
  async function runDiscover() {
    const note = image ? 'asks it for its list of models' : 'asks it for its list of models and streams the message "Reply with OK."';
    if (profile.locality === 'cloud' && !window.confirm(`This ${note} from ${profile.host}, which is not on this computer. No part of your book is sent. Continue?`)) return;
    setBusy(true);
    setTest(null);
    try {
      const r = await aiRequest('POST', aiUrl.discover(profile.id), profile.locality === 'cloud' ? { confirmCloud: true } : {});
      if (r.status === 200) setFound(r.json);
      else setTest(r.json?.message ?? `The connection test failed (${r.status}).`);
    } catch {
      setTest('The server could not be reached.');
    }
    setBusy(false);
  }
  async function moveKey() {
    setBusy(true);
    setMoved(null);
    try {
      const r = await aiRequest('POST', aiUrl.secure(profile.id), {});
      setMoved(r.status === 200 ? 'The key is now in secure storage and the plain-text copy is deleted.' : (r.json?.message ?? `The key was not moved (${r.status}).`));
      if (r.status === 200) onChanged();
    } catch {
      setMoved('The server could not be reached.');
    }
    setBusy(false);
  }
  async function runTest() {
    if (profile.locality === 'cloud' && !window.confirm(`This sends the message "Reply with OK." to ${profile.host}, which is not on this computer. Continue?`)) return;
    setBusy(true);
    setTest(null);
    try {
      const r = await aiRequest('POST', aiUrl.test(profile.id), {});
      setTest(r.status === 200 ? `The provider answered: ${r.json.reply}` : (r.json?.message ?? `The test failed (${r.status}).`));
    } catch {
      setTest('The server could not be reached.');
    }
    setBusy(false);
    onChanged();
  }
  const storage = profile.keyStorage === 'none' ? 'no key' : profile.keyStorage === 'session' ? (profile.hasKey ? 'key kept for this session' : 'key not entered (session)') : profile.keyStorage === 'secure' ? (profile.hasKey ? 'key kept in secure storage' : 'key not entered (secure storage)') : profile.hasKey ? 'key saved in the settings file (plain text)' : 'key not entered (settings file)';
  return (
    <li className="ai-profile-row">
      <div>
        <strong>{profile.name}</strong> <LocalityBadge locality={profile.locality} host={profile.host} />
      </div>
      <div className="muted">
        {profile.model} · {profile.baseUrl} · {storage}
      </div>
      <div className="ai-actions">
        <button type="button" className="btn" onClick={() => onEdit(profile)}>
          Edit
        </button>
        {!image && (
          <button type="button" className="btn" disabled={busy} onClick={runTest}>
            Send a test message
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={runDiscover}>
          Test connection
        </button>
        {profile.keyStorage === 'config' && profile.hasKey && secureBackend && (
          <button type="button" className="btn" disabled={busy} onClick={moveKey}>
            Move key to secure storage
          </button>
        )}
        <button type="button" className="btn" onClick={() => onDelete(profile)}>
          Delete
        </button>
      </div>
      {test && <p role="status">{test}</p>}
      {moved && <p role="status">{moved}</p>}
      {found && (
        <div className="ai-capabilities" aria-label={`Connection test for ${profile.name}`}>
          <p>
            {found.models.length === 0 ? 'The provider lists no models.' : `${found.models.length} model${found.models.length === 1 ? '' : 's'}: ${found.models.slice(0, 12).join(', ')}${found.models.length > 12 ? ', ...' : ''}`}
            {found.ollama ? ' (Ollama detected)' : ''}
          </p>
          {found.streaming !== null && found.streaming !== undefined && (
            <p className="muted">
              Streaming: {found.streaming ? 'yes' : 'no'} · Token usage: {found.usageReported ? 'reported by the provider' : 'not reported (shown as estimated)'}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function SettingsView() {
  const [bump, setBump] = useState(0);
  const { user, mode } = useSession(); // shared mode (M07-J03): only the owner sees Members and sharing, plugins and webhooks
  const { data, error: loadError } = useApi(aiUrl.profiles, String(bump));
  const { data: books } = useApi('/api/books');
  const [editing, setEditing] = useState(/** @type {null | { id: string | null, form: typeof EMPTY, hasKey: boolean }} */ (null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const profiles = data?.profiles ?? [];
  const configFile = data?.configFile ?? '';
  const keystore = data?.keystore ?? null; // M08-J03: where keys are kept (and whether they can be unlocked)
  const secureBackend = keystore?.backend ?? null;

  async function save(f) {
    setSaving(true);
    setError(null);
    try {
      const r = editing?.id ? await aiRequest('PUT', aiUrl.profile(editing.id), bodyOf(f)) : await aiRequest('POST', aiUrl.profiles, bodyOf(f));
      if (r.status === 200 || r.status === 201) {
        setEditing(null);
        setBump((n) => n + 1);
      } else setError(r.json?.message ?? `Not saved (${r.status}).`);
    } catch {
      setError('The server could not be reached.');
    }
    setSaving(false);
  }
  async function remove(p) {
    if (!window.confirm(`Delete the profile "${p.name}"? Books using it will have AI turned off.`)) return;
    await aiRequest('DELETE', aiUrl.profile(p.id), {});
    setBump((n) => n + 1);
  }

  return (
    <main id="main" tabIndex={-1} className="page settings-page">
      <h1>Settings</h1>
      {user?.role === 'owner' && (
        <section aria-labelledby="members-sharing-heading" className="pref-section">
          <h2 id="members-sharing-heading">Members and sharing</h2>
          <p className="muted">Invite people, change their roles, and share a book read-only.</p>
          <p>
            <Link to="/settings/members" className="btn">
              Open Members and sharing
            </Link>
          </p>
        </section>
      )}
      <PreferencesSettings />
      {(mode !== 'shared' || user?.role === 'owner') && (
        <>
          <ClaudeSettings mode={mode} />
          <PluginsSettings />
          <WebhooksSettings />
        </>
      )}
      <section aria-labelledby="ai-setup-heading">
        <h2 id="ai-setup-heading">Set up AI (optional)</h2>
        <p className="placeholder-text">
          StoryForge works fully without AI, and nothing is ever sent anywhere unless you add a provider here, turn it on for a book and click Send. You can use a model on this computer (for example a local
          server that speaks the OpenAI chat format) or a cloud provider. Every request is shown to you before it is sent, and nothing a model writes changes your book until you click Apply.
        </p>
        {loadError && <p className="error">{loadError}</p>}
        {keystore && <p className="muted ai-keystore">Keys are kept by: {backendText(keystore.backend)}.</p>}
        {keystore?.locked && (
          <p role="alert" className="form-error">
            {keystore.message ?? 'cannot unlock stored keys'}. Saved keys cannot be read, so requests that need one will not be sent. Enter the key again, or restore the key file or secrets setting that was used.
          </p>
        )}
        {profiles.length === 0 && !editing && <p className="muted">No providers yet.</p>}
        <ul className="ai-profile-list">
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              secureBackend={secureBackend}
              onEdit={(x) => {
                setError(null);
                setEditing({ id: x.id, form: fromProfile(x), hasKey: x.hasKey });
              }}
              onDelete={remove}
              onChanged={() => setBump((n) => n + 1)}
            />
          ))}
        </ul>
        {editing ? (
          <ProfileForm
            key={editing.id ?? 'new'}
            title={editing.id ? 'Edit provider' : 'Add a provider'}
            initial={editing.form}
            hasKey={editing.hasKey}
            configFile={configFile}
            secureBackend={secureBackend}
            saving={saving}
            error={error}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setEditing({ id: null, form: { ...EMPTY, keyStorage: secureBackend ? 'secure' : 'none' }, hasKey: false });
            }}
          >
            Add a provider
          </button>
        )}
      </section>
      {profiles.length > 0 && books && books.length > 0 && (
        <section aria-labelledby="ai-books-heading">
          <h2 id="ai-books-heading">AI in your books</h2>
          <ul className="ai-book-list">
            {books.map((b) => (
              <BookAiRow key={b.id} book={b} profiles={profiles} />
            ))}
          </ul>
        </section>
      )}
      <p>
        <Link to="/">Back to the library</Link>
      </p>
    </main>
  );
}
