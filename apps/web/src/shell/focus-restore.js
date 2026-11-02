// After an in-app page change the old focused element is gone and focus falls to <body>. Put it on the new page's <main>
// (only when it was lost, never taking it from something the user is in). Checked again once a loading page has been replaced.
// Installed once by the client entry (main.jsx); a module-level listener survives the page components remounting.
import { NAV_EVENT } from '../nav-event.js';

/** @param {Document} doc @param {Window} win @returns {() => void} uninstall */
export function installFocusRestore(doc = document, win = window) {
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];
  const land = () => {
    const lost = !doc.activeElement || doc.activeElement === doc.body;
    if (lost) doc.getElementById('main')?.focus({ preventScroll: true });
  };
  const onNavigate = () => {
    timers.forEach(clearTimeout);
    timers = [setTimeout(land, 0), setTimeout(land, 500)];
  };
  win.addEventListener(NAV_EVENT, onNavigate);
  win.addEventListener('popstate', onNavigate);
  return () => {
    timers.forEach(clearTimeout);
    win.removeEventListener(NAV_EVENT, onNavigate);
    win.removeEventListener('popstate', onNavigate);
  };
}
