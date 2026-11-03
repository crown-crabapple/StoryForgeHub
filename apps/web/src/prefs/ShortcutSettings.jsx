// Settings > Shortcuts (M07-J04 contract section 4): every command with its binding. Change (capture a key chord), Remove, Reset. A chord another command of the same
// scope already uses, or a reserved one, is refused with both names shown. While capturing, Tab keeps working (it moves on) and Escape cancels.
import { useState } from 'react';
import { COMMANDS, SCOPES, bindingsFor, chordFromEvent, displayChord, validateBinding } from '../shortcuts/registry.js';
import { usePrefs } from './PrefsContext.jsx';

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');

export function ShortcutSettings() {
  const { effective, layers, save } = usePrefs();
  const [capturing, setCapturing] = useState(/** @type {string | null} */ (null));
  const [message, setMessage] = useState(/** @type {{ id: string, text: string } | null} */ (null));
  const [status, setStatus] = useState(/** @type {string | null} */ (null));
  const bindings = bindingsFor(effective.shortcuts);
  const own = layers.profile?.shortcuts ?? {};
  const mac = isMac();

  async function change(id, chord) {
    const verdict = validateBinding(id, chord, bindings);
    if (!verdict.ok) {
      setMessage({ id, text: verdict.message });
      return;
    }
    setMessage(null);
    const r = await save({ shortcuts: { ...own, [id]: chord } });
    setStatus(r.ok ? `${COMMANDS.find((c) => c.id === id)?.label}: ${chord === null ? 'binding removed' : `now ${displayChord(chord, mac)}`}.` : (r.message ?? 'Not saved.'));
    setCapturing(null);
  }
  async function reset(id) {
    const next = { ...own };
    delete next[id];
    setMessage(null);
    const r = await save({ shortcuts: Object.keys(next).length > 0 ? next : null });
    setStatus(r.ok ? `${COMMANDS.find((c) => c.id === id)?.label}: back to ${displayChord(COMMANDS.find((c) => c.id === id)?.binding ?? null, mac)}.` : (r.message ?? 'Not saved.'));
  }

  function onCaptureKey(e, id) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setCapturing(null);
      setMessage(null);
      return;
    }
    const chord = chordFromEvent(e);
    if (chord === null) return; // a bare modifier: keep waiting
    if (chord === 'Tab' || chord === 'Shift+Tab') {
      // the keyboard walk must keep working: Tab moves on and ends the capture
      setCapturing(null);
      return;
    }
    e.preventDefault();
    void change(id, chord);
  }

  return (
    <section aria-labelledby="pref-shortcuts-heading" className="pref-section">
      <h2 id="pref-shortcuts-heading">Shortcuts</h2>
      <p className="muted">
        Choose Change, then press the keys. Escape, Tab and Shift+Tab, and the browser&apos;s own chords (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+L, Ctrl+Tab, F5, Alt+F4) cannot be used. Two commands in the same place cannot share a chord. Press ? anywhere for the cheat sheet.
      </p>
      {status && <p role="status">{status}</p>}
      {SCOPES.map(([scope, heading]) => (
        <div key={scope}>
          <h3>{heading}</h3>
          <table className="pref-table">
            <caption className="sr-only">{heading}: commands and their shortcuts</caption>
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Shortcut</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {COMMANDS.filter((c) => c.scope === scope).map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.label}</th>
                  <td>
                    {capturing === c.id ? (
                      <span ref={(el) => el?.focus()} className="shortcut-capture" tabIndex={0} role="textbox" aria-label={`Press the new shortcut for ${c.label}`} onKeyDown={(e) => onCaptureKey(e, c.id)} onBlur={() => setCapturing(null)}>
                        Press the keys…
                      </span>
                    ) : (
                      <kbd>{displayChord(bindings[c.id], mac)}</kbd>
                    )}
                    {message?.id === c.id && (
                      <p role="alert" className="form-error">
                        {message.text}
                      </p>
                    )}
                  </td>
                  <td>
                    {c.fixed ? (
                      <span className="muted">Fixed</span>
                    ) : (
                      <>
                        <button type="button" className="btn" onClick={() => setCapturing(c.id)} aria-label={`Change the shortcut for ${c.label}`}>
                          Change
                        </button>{' '}
                        <button type="button" className="btn" disabled={bindings[c.id] === null} onClick={() => change(c.id, null)} aria-label={`Remove the shortcut for ${c.label}`}>
                          Remove
                        </button>{' '}
                        <button type="button" className="btn" disabled={!Object.hasOwn(own, c.id)} onClick={() => reset(c.id)} aria-label={`Reset the shortcut for ${c.label}`}>
                          Reset
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <button type="button" className="btn" disabled={Object.keys(own).length === 0} onClick={() => save({ shortcuts: null }).then((r) => setStatus(r.ok ? 'Every shortcut is back to its default.' : (r.message ?? 'Not saved.')))}>
        Reset all shortcuts
      </button>
    </section>
  );
}
