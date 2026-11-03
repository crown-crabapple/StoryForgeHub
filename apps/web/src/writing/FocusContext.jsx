// Focus mode state for the whole app: on or off, the two options, and the keyboard shortcut. The scene editor registers itself as
// "available"; the shortcut does nothing while no editor is open, and focus mode ends when the last editor goes away.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcuts } from '../shortcuts/ShortcutsContext.jsx';
import { DEFAULT_FOCUS_OPTIONS, focusKeyAction, readFocusOptions, writeFocusOptions } from './focus.js';

const FocusContext = createContext(null);
const OFF = { active: false, options: DEFAULT_FOCUS_OPTIONS, toggle: () => {}, exit: () => {}, setOption: () => {}, register: () => () => {} };

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const dialogOpen = () => typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

export function FocusProvider({ children }) {
  const [active, setActive] = useState(false);
  const [options, setOptions] = useState(() => readFocusOptions(storage()));
  const activeRef = useRef(false);
  const editors = useRef(0);
  const shortcuts = useShortcuts();
  const bindingsRef = useRef(shortcuts.bindings);
  useEffect(() => {
    bindingsRef.current = shortcuts.bindings;
  });
  const set = useCallback((next) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const action = focusKeyAction(e, { focus: activeRef.current, dialogOpen: dialogOpen() }, bindingsRef.current);
      if (action === 'toggle' && (activeRef.current || editors.current > 0)) {
        e.preventDefault();
        set(!activeRef.current);
      } else if (action === 'exit') {
        e.preventDefault();
        set(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [set]);

  /** An editor is open; returns the function that says it closed. Stable, so an effect that registers does not re-run. */
  const register = useCallback(() => {
    editors.current++;
    return () => {
      editors.current--;
      if (editors.current <= 0) {
        editors.current = 0;
        set(false);
      }
    };
  }, [set]);

  const exit = useCallback(() => set(false), [set]);

  const value = useMemo(
    () => ({
      active,
      options,
      toggle: () => {
        if (activeRef.current || editors.current > 0) set(!activeRef.current);
      },
      exit,
      setOption(name, on) {
        setOptions((o) => {
          const next = { ...o, [name]: on === true };
          writeFocusOptions(storage(), next);
          return next;
        });
      },
      register,
    }),
    [active, options, set, register, exit],
  );
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

/** @returns {{ active: boolean, options: { typewriter: boolean, dim: boolean }, toggle: () => void, exit: () => void, setOption: (name: 'typewriter' | 'dim', on: boolean) => void, register: () => () => void }} */
export function useFocus() {
  return useContext(FocusContext) ?? OFF;
}
