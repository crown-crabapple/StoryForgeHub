import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { FOCUSABLE, matchesWidth, trapTarget } from './drawer.js';

/** A window width to use instead of the real one (null: the real window). Render tests set it to see the layout of 1280, 900, 600 and 360 px. @type {import('react').Context<number | null>} */
export const ViewportContext = createContext(/** @type {number | null} */ (null));

/** Does the media query match now? False when rendered on the server (and in tests: there is no window). @param {string} query */
export function useMedia(query) {
  const simulated = useContext(ViewportContext);
  const real = useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
  return simulated === null ? real : matchesWidth(query, simulated);
}

/**
 * While `active` (the drawer is open and is an overlay at this width): focus moves in, Tab stays inside, Escape calls `onClose`, and focus goes back to the toggle
 * that opened it when it closes.
 * @param {{ active: boolean, onClose: () => void, panel: { current: HTMLElement | null }, toggle: { current: HTMLElement | null } }} p
 */
export function useDrawer({ active, onClose, panel, toggle }) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!active) return undefined;
    const node = panel.current;
    const opener = toggle.current ?? document.activeElement;
    if (!node) return undefined;
    const items = () => [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    (items()[0] ?? node).focus({ preventScroll: true });
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const list = items();
        const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const next = trapTarget({ count: list.length, index: at, shift: e.shiftKey });
        if (next === null) return;
        e.preventDefault();
        (next === -1 ? node : list[next]).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [active, panel, toggle]);
}
