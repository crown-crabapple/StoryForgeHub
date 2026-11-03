// Settings: profile, theme, typography, layouts, shortcuts, modules and the precedence table (M07-J04). Everything here is saved to the PROFILE (a file on this
// computer); nothing on this page writes to a book or to library.md. The project's own preferences (library.md, book.md) are edited by hand and shown below.
import { useState } from 'react';
import { useApi } from '../api.js';
import { checkCustomTheme, exportTheme, importTheme, resolveTheme, THEME_TOKENS, BUILTIN_THEMES } from './themes.js';
import { FONT_LABELS, FONT_STACKS, INSPECTOR_SECTIONS, LAYOUT_NAMES, SECTION_LABELS, TYPOGRAPHY_RANGES } from './appearance.js';
import { MODULES, usePrefs } from './PrefsContext.jsx';
import { ShortcutSettings } from './ShortcutSettings.jsx';

/** A short line for the user after a save. @param {{ ok: boolean, message?: string }} r @param {string} done */
const said = (r, done) => (r.ok ? done : (r.message ?? 'Not saved.'));

function ProfileSection() {
  const { profile, switchProfile } = usePrefs();
  const [name, setName] = useState('');
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const valid = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name);
  return (
    <section aria-labelledby="pref-profile-heading" className="pref-section">
      <h2 id="pref-profile-heading">Profile</h2>
      <p className="muted">
        A profile keeps your theme, type, layout, shortcuts and module choices on this computer. It never changes a book. Start StoryForge with <code>--profile &lt;name&gt;</code> or the STORYFORGE_PROFILE variable to pick one at launch.
      </p>
      <div className="field">
        <label htmlFor="pref-profile-select">Profile in use</label>
        <select id="pref-profile-select" value={profile.name} onChange={async (e) => setStatus(said(await switchProfile(e.target.value), `Switched to ${e.target.value}.`))}>
          {profile.names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <form
        className="field"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setStatus(said(await switchProfile(name, true), `Created ${name} and switched to it.`));
          setName('');
        }}
      >
        <label htmlFor="pref-profile-new">New profile name</label>
        <input id="pref-profile-new" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example: night" aria-describedby="pref-profile-new-hint" />
        <p id="pref-profile-new-hint" className="muted">
          Lower-case letters, digits, hyphen or underscore.
        </p>
        <button type="submit" className="btn" disabled={!valid}>
          Create and switch
        </button>
      </form>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function ThemeSection() {
  const { effective, profile, save, layers } = usePrefs();
  const customs = profile.customThemes;
  const [draftName, setDraftName] = useState('');
  const [tokens, setTokens] = useState(() => ({ ...resolveTheme(effective.theme, customs).tokens }));
  const [checked, setChecked] = useState(/** @type {ReturnType<typeof checkCustomTheme> | null} */ (null));
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const own = layers.profile?.theme ?? '';
  const nameOk = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(draftName);

  async function choose(value) {
    setStatus(said(await save({ theme: value === '' ? null : value }), value === '' ? 'Following the project (dark unless library.md or book.md says otherwise).' : `Theme: ${value}.`));
  }
  function check() {
    setConfirmed(false);
    setChecked(checkCustomTheme(tokens));
  }
  async function apply() {
    const result = checked ?? checkCustomTheme(tokens);
    if (result.problems.length > 0 || !nameOk) return;
    if (result.fails.length > 0 && !confirmed) return;
    setStatus(said(await save({ customThemes: { ...customs, [draftName]: tokens }, theme: `custom:${draftName}` }), `Applied the custom theme ${draftName}.`));
  }
  function download() {
    const blob = new Blob([exportTheme(draftName || 'my-theme', tokens)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(draftName || 'my-theme').replace(/[^A-Za-z0-9_-]+/g, '-')}.theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = importTheme(await file.text());
    if (!r.ok) {
      setStatus(r.message);
      return;
    }
    setDraftName(r.name);
    setTokens({ ...resolveTheme('dark').tokens, ...r.tokens });
    setChecked(checkCustomTheme(r.tokens));
    setConfirmed(false);
    setStatus(`Loaded ${r.name}. Check the contrast below, then apply it.`);
  }

  return (
    <section aria-labelledby="pref-theme-heading" className="pref-section">
      <h2 id="pref-theme-heading">Theme</h2>
      <div className="field">
        <label htmlFor="pref-theme">Theme</label>
        <select id="pref-theme" value={own} onChange={(e) => choose(e.target.value)}>
          <option value="">Follow the project (default: dark)</option>
          {BUILTIN_THEMES.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
          {Object.keys(customs).map((n) => (
            <option key={n} value={`custom:${n}`}>
              Custom: {n}
            </option>
          ))}
        </select>
      </div>
      <details>
        <summary>Custom theme: edit, check, apply, export, import</summary>
        <div className="field">
          <label htmlFor="pref-theme-name">Theme name</label>
          <input id="pref-theme-name" type="text" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </div>
        <div className="theme-tokens">
          {THEME_TOKENS.map((t) => (
            <div key={t} className="field theme-token">
              <label htmlFor={`pref-token-${t}`}>{t}</label>
              <input id={`pref-token-${t}`} type="text" value={tokens[t]} spellCheck="false" onChange={(e) => (setChecked(null), setTokens((x) => ({ ...x, [t]: e.target.value })))} />
              <input type="color" aria-label={`${t} colour picker`} value={/^#[0-9A-Fa-f]{6}$/.test(tokens[t]) ? tokens[t] : '#000000'} onChange={(e) => (setChecked(null), setTokens((x) => ({ ...x, [t]: e.target.value.toUpperCase() })))} />
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={check}>
            Check contrast
          </button>
          <button type="button" className="btn btn-primary" disabled={!nameOk || ((checked?.fails.length ?? 0) > 0 && !confirmed)} onClick={apply}>
            Apply theme
          </button>
          <button type="button" className="btn" onClick={download}>
            Export as a file
          </button>
          <label className="btn" htmlFor="pref-theme-import">
            Import a file
          </label>
          <input id="pref-theme-import" type="file" accept=".json,application/json" className="sr-only" onChange={upload} />
        </div>
        {checked && checked.problems.length > 0 && (
          <ul role="alert" className="form-error">
            {checked.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {checked && checked.problems.length === 0 && checked.fails.length === 0 && <p role="status">Every contrast pair passes.</p>}
        {checked && checked.fails.length > 0 && (
          <div role="alert">
            <p className="form-error">These pairs are below the readable minimum:</p>
            <ul className="theme-fails">
              {checked.fails.map((f) => (
                <li key={f.pair}>
                  {f.pair}: {f.ratio}
                  {f.min === 10 ? ' lightness steps' : ':1'} (needs {f.min}
                  {f.min === 10 ? '' : ':1'})
                </li>
              ))}
            </ul>
            <label className="ai-check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand and want to apply it anyway
            </label>
          </div>
        )}
      </details>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function TypographySection() {
  const { effective, save, layers } = usePrefs();
  const t = effective.typography;
  const [draft, setDraft] = useState({ ...t, measureFull: t.measure === 'full' });
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const field = (k, label, r) => (
    <div className="field">
      <label htmlFor={`pref-type-${k}`}>
        {label} ({r.min} to {r.max}
        {r.unit ? ` ${r.unit}` : ''})
      </label>
      <input id={`pref-type-${k}`} type="number" min={r.min} max={r.max} step={r.step} value={draft[k]} onChange={set(k)} />
    </div>
  );
  async function apply() {
    const value = {
      family: draft.family,
      size: Number(draft.size),
      lineHeight: Number(draft.lineHeight),
      paragraphSpacing: Number(draft.paragraphSpacing),
      letterSpacing: Number(draft.letterSpacing),
      measure: draft.measureFull ? 'full' : Number(draft.measure === 'full' ? 72 : draft.measure),
    };
    setStatus(said(await save({ typography: value }), 'Typography saved.'));
  }
  return (
    <section aria-labelledby="pref-type-heading" className="pref-section">
      <h2 id="pref-type-heading">Typography</h2>
      <p className="muted">How the manuscript text looks while you write and read. System fonts only; nothing is downloaded.</p>
      <div className="field">
        <label htmlFor="pref-type-family">Manuscript font</label>
        <select id="pref-type-family" value={draft.family} onChange={set('family')}>
          {Object.keys(FONT_STACKS).map((k) => (
            <option key={k} value={k}>
              {FONT_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      {field('size', 'Size', TYPOGRAPHY_RANGES.size)}
      {field('lineHeight', 'Line height', TYPOGRAPHY_RANGES.lineHeight)}
      {field('paragraphSpacing', 'Space between paragraphs', TYPOGRAPHY_RANGES.paragraphSpacing)}
      {field('letterSpacing', 'Letter spacing', TYPOGRAPHY_RANGES.letterSpacing)}
      <label className="ai-check">
        <input type="checkbox" checked={draft.measureFull} onChange={set('measureFull')} /> Full width (no line length limit)
      </label>
      {!draft.measureFull && (
        <div className="field">
          <label htmlFor="pref-type-measure">Line length (50 to 100 characters)</label>
          <input id="pref-type-measure" type="number" min={50} max={100} value={draft.measure === 'full' ? 72 : draft.measure} onChange={set('measure')} />
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={apply}>
          Save typography
        </button>
        <button
          type="button"
          className="btn"
          disabled={layers.profile?.typography === undefined}
          onClick={async () => setStatus(said(await save({ typography: null }), 'Typography is back to the project default.'))}
        >
          Reset
        </button>
      </div>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function LayoutSection() {
  const { layout, profile, layers, save, setLayout, setPanelShown, saveLayoutAs } = usePrefs();
  const [name, setName] = useState('');
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const names = [...LAYOUT_NAMES, ...Object.keys(profile.layouts).filter((n) => !LAYOUT_NAMES.includes(n))];
  const order = layout.pinned ?? INSPECTOR_SECTIONS;
  const profileLayout = layers.profile?.layout ?? {};
  const setPinned = async (pinned) => setStatus(said(await save({ layout: { ...profileLayout, name: layout.name, pinned } }), 'Right panel saved.'));
  const move = (id, by) => {
    const at = order.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(to, 0, ...next.splice(at, 1));
    return setPinned(next);
  };
  const toggle = (id, on) => setPinned(on ? [...order, id] : order.filter((x) => x !== id));
  const hidden = INSPECTOR_SECTIONS.filter((s) => !order.includes(s));
  return (
    <section aria-labelledby="pref-layout-heading" className="pref-section">
      <h2 id="pref-layout-heading">Layout</h2>
      <p className="muted">Switching layout changes the panels only: the page is not reloaded and nothing you typed is lost.</p>
      <div className="field">
        <label htmlFor="pref-layout">Layout</label>
        <select id="pref-layout" value={layout.name} onChange={async (e) => setStatus(said(await setLayout(e.target.value), `Layout: ${e.target.value}.`))}>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <label className="ai-check">
        <input type="checkbox" checked={layout.rail.shown} onChange={(e) => setPanelShown('rail', e.target.checked)} /> Show the chapters panel
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={layout.inspector.shown} onChange={(e) => setPanelShown('inspector', e.target.checked)} /> Show the right panel
      </label>
      <p className="muted">Drag the edge of a panel, or focus it and use the arrow keys, to change its width.</p>
      <fieldset className="field">
        <legend>Sections in the right panel (top to bottom)</legend>
        <ol className="pref-pins">
          {order.map((id, i) => (
            <li key={id}>
              <label className="ai-check">
                <input type="checkbox" checked onChange={() => toggle(id, false)} /> {SECTION_LABELS[id]}
              </label>{' '}
              <button type="button" className="btn" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`Move ${SECTION_LABELS[id]} up`}>
                Up
              </button>{' '}
              <button type="button" className="btn" disabled={i === order.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${SECTION_LABELS[id]} down`}>
                Down
              </button>
            </li>
          ))}
        </ol>
        {hidden.length > 0 && (
          <>
            <p className="muted">Not shown:</p>
            {hidden.map((id) => (
              <label key={id} className="ai-check">
                <input type="checkbox" checked={false} onChange={() => toggle(id, true)} /> {SECTION_LABELS[id]}
              </label>
            ))}
          </>
        )}
      </fieldset>
      <form
        className="field"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setStatus(said(await saveLayoutAs(name.trim()), `Saved the layout ${name.trim()}.`));
          setName('');
        }}
      >
        <label htmlFor="pref-layout-name">Save the current layout as</label>
        <input id="pref-layout-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example: Drafting" />
        <button type="submit" className="btn" disabled={!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(name)}>
          Save layout
        </button>
      </form>
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function ModulesSection() {
  const { modules, warnings, save, layers } = usePrefs();
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const own = layers.profile?.modules ?? {};
  async function set(id, on) {
    if (id === 'receipts' && !on && !window.confirm('Turning receipts off stops new receipts, so the provenance chain gets a gap. Verification will report RCPT_CHAIN_GAP for the changes made while they are off. Turn them off?')) return;
    setStatus(said(await save({ modules: { ...own, [id]: on } }), `${MODULES.find((m) => m.id === id)?.label}: ${on ? 'on' : 'off'}.`));
  }
  return (
    <section aria-labelledby="pref-modules-heading" className="pref-section">
      <h2 id="pref-modules-heading">Features</h2>
      <p className="muted">A feature you turn off disappears from the navigation and the panels, and its changes are refused. Its files stay on disk, untouched and still checked. A project (library.md or book.md) can require a feature off or on; you cannot override that here.</p>
      <ul className="pref-modules">
        {MODULES.map((m) => {
          const s = modules[m.id] ?? { on: true, source: 'builtin', locked: false };
          return (
            <li key={m.id}>
              <label className="ai-check">
                <input type="checkbox" checked={s.on} disabled={s.locked} onChange={(e) => set(m.id, e.target.checked)} /> {m.label}
              </label>
              <span className="muted"> {m.note}</span>
              {s.locked && <span className="muted"> Set by this project ({s.source === 'book' ? 'book.md' : 'library.md'}).</span>}
            </li>
          );
        })}
      </ul>
      {warnings.map((w) => (
        <p key={w.code} role="alert" className="banner banner-warning">
          {w.message}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

const LAYER_LABELS = { builtin: 'built-in', library: 'library.md', book: 'book.md', profile: 'your profile' };

function PrecedenceSection() {
  const { sources } = usePrefs();
  const keys = Object.keys(sources).filter((k) => sources[k] !== 'builtin');
  return (
    <section aria-labelledby="pref-precedence-heading" className="pref-section">
      <h2 id="pref-precedence-heading">Which setting wins</h2>
      <table className="pref-table">
        <caption className="sr-only">Precedence of the preference layers (the last one wins)</caption>
        <thead>
          <tr>
            <th scope="col">Kind of setting</th>
            <th scope="col">Keys</th>
            <th scope="col">Order (the last one wins)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Project</th>
            <td>modules, labels, export</td>
            <td>built-in, your profile, library.md, book.md</td>
          </tr>
          <tr>
            <th scope="row">Appearance</th>
            <td>theme, typography, layout, shortcuts</td>
            <td>built-in, library.md, book.md, your profile</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">A project can require a module off (no AI for this book); you always decide how things look.</p>
      {keys.length > 0 && (
        <>
          <h3>Settings that differ from the built-in ones here</h3>
          <ul>
            {keys.map((k) => (
              <li key={k}>
                <code>{k}</code>: from {LAYER_LABELS[sources[k]]}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PromptsSection() {
  const { data } = useApi('/api/prompts');
  const { moduleOn } = usePrefs();
  if (!moduleOn('ai')) return null;
  const prompts = data?.prompts ?? [];
  const workflows = data?.workflows ?? [];
  const bad = data ? [...prompts, ...workflows].filter((p) => p.problems.length > 0) : [];
  return (
    <section aria-labelledby="pref-prompts-heading" className="pref-section">
      <h2 id="pref-prompts-heading">Custom prompts</h2>
      <p className="muted">Prompt components and workflows are Markdown files in the _prompts folder of your library. Run them from the editor with Run a prompt; every send is previewed first.</p>
      <p>
        {prompts.length} prompt{prompts.length === 1 ? '' : 's'}, {workflows.length} workflow{workflows.length === 1 ? '' : 's'}.
      </p>
      {bad.length > 0 && (
        <ul className="diag-list">
          {bad.map((p) => (
            <li key={p.path} className="diag diag-error">
              <strong>{p.path}</strong>
              <div>
                {p.problems[0].code} at {p.problems[0].location || 'file'}: {p.problems[0].message}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Everything under "Settings" that is about how StoryForge looks and which features are on. */
export function PreferencesSettings() {
  const { loaded, profile } = usePrefs();
  const fresh = `${loaded}-${profile.name}`; // the forms start from the saved values: begin again when they arrive or the profile changes
  return (
    <>
      <ProfileSection />
      <ThemeSection key={`theme-${fresh}`} />
      <TypographySection key={`type-${fresh}`} />
      <LayoutSection />
      <ShortcutSettings />
      <ModulesSection />
      <PromptsSection />
      <PrecedenceSection />
    </>
  );
}
