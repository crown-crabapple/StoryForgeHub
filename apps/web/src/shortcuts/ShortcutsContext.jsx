// The one global key listener and the cheat sheet (M07-J04 contract section 4). Commands carry out their own work where they live (the editor keymap, focus mode, the
// outline); this provider hands every one of them the current bindings, runs the global commands that registered a handler, and opens the cheat sheet on `?`.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { COMMANDS, SCOPES, WIDGET_KEYS, ariaShortcut, bindingsFor, chordFromEvent, commandForEvent, displayChord } from './registry.js';

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');
const dialogOpen = () => typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
/** Is the key going to a place where plain characters are text (a field, the editor)? */
const typing = (target) => target instanceof Element && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;

const DEFAULT = {
  bindings: bindingsFor({}),
  commandFor: (e, scope) => commandForEvent(e, scope, bindingsFor({})),
  matches: (e, id) => commandForEvent(e, COMMANDS.find((c) => c.id === id)?.scope ?? '', bindingsFor({})) === id,
  display: (id) => displayChord(bindingsFor({})[id] ?? null, isMac()),
  aria: (id) => ariaShortcut(bindingsFor({})[id] ?? null),
  register: () => () => {},
  showCheatSheet: () => {},
};
const ShortcutsContext = createContext(DEFAULT);

/** The cheat sheet: every command with its active binding, then the keys that belong to components. @param {{ bindings: Record<string, string | null>, onClose: () => void }} props */
export function ShortcutsDialog({ bindings, onClose }) {
  const mac = isMac();
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose} className="shortcuts-dialog">
      <h2>Keyboard shortcuts</h2>
      <p className="muted">These are the active bindings for this profile. Change them in Settings, Shortcuts.</p>
      {SCOPES.map(([scope, heading]) => (
        <section key={scope} aria-labelledby={`sc-${scope}`}>
          <h3 id={`sc-${scope}`}>{heading}</h3>
          <dl className="shortcut-list">
            {COMMANDS.filter((c) => c.scope === scope).map((c) => (
              <div key={c.id} className="shortcut-row">
                <dt>{c.label}</dt>
                <dd>
                  <kbd>{displayChord(bindings[c.id] ?? null, mac)}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section aria-labelledby="sc-widgets">
        <h3 id="sc-widgets">Inside lists, menus and fields</h3>
        <dl className="shortcut-list">
          {WIDGET_KEYS.filter((w) => w.keys !== 'none' && !w.file.startsWith('prefs/')).map((w) => (
            <div key={w.file} className="shortcut-row">
              <dt>{w.what}</dt>
              <dd>
                <kbd>{w.keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** Put inside PrefsProvider. */
export function ShortcutsProvider({ children }) {
  const { bindings } = usePrefs();
  const [sheet, setSheet] = useState(false);
  const handlers = useRef(/** @type {Map<string, () => void>} */ (new Map()));
  const bindingsRef = useRef(bindings);
  useEffect(() => {
    bindingsRef.current = bindings;
  });

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented) return;
      const chord = chordFromEvent(e);
      if (chord === null) return;
      if (typing(e.target) && !/^(Mod|Alt)\+/.test(chord)) return; // plain keys are text inside a field
      const id = commandForEvent(e, 'global', bindingsRef.current);
      if (id === null) return;
      if (id === 'help.shortcuts') {
        if (dialogOpen()) return;
        e.preventDefault();
        setSheet(true);
        return;
      }
      const run = handlers.current.get(id);
      if (run) {
        e.preventDefault();
        run();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const register = useCallback((id, fn) => {
    handlers.current.set(id, fn);
    return () => {
      if (handlers.current.get(id) === fn) handlers.current.delete(id);
    };
  }, []);

  const value = useMemo(
    () => ({
      bindings,
      commandFor: (e, scope) => commandForEvent(e, scope, bindings),
      matches: (e, id) => commandForEvent(e, COMMANDS.find((c) => c.id === id)?.scope ?? '', bindings) === id,
      display: (id) => displayChord(bindings[id] ?? null, isMac()),
      aria: (id) => ariaShortcut(bindings[id] ?? null),
      register,
      showCheatSheet: () => setSheet(true),
    }),
    [bindings, register],
  );
  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      {sheet && <ShortcutsDialog bindings={bindings} onClose={() => setSheet(false)} />}
    </ShortcutsContext.Provider>
  );
}

/** @returns {typeof DEFAULT} the live bindings and helpers (the defaults when there is no provider) */
export function useShortcuts() {
  return useContext(ShortcutsContext);
}
