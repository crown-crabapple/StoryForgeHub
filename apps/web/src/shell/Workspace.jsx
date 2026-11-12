import { useEffect, useId, useRef, useState } from 'react';
import { PanelSeparator } from '../prefs/PanelSeparator.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { useFocus } from '../writing/FocusContext.jsx';
import { DRAWER_QUERY, drawerAnnouncement } from './drawer.js';
import { useDrawer, useMedia } from './useDrawer.js';

/**
 * Three regions: the manuscript rail, the main column and the inspector. Wide: three columns. Medium:
 * rail + main with the inspector below main. Narrow: one column, the rail behind a "Chapters" button.
 * `main` is the page's <main>: pass its content as children. In focus mode only the main column is drawn (the rail and the
 * inspector are not rendered; their slots stay empty so the main column keeps its place and its state).
 * M07-J04: the layout can hide either side panel (their slots stay, so switching layouts never remounts the page or loses an unsaved buffer) and
 * the panels are resized with a separator (mouse and keyboard).
 * M08-J04: below 1200 px the inspector is an off-canvas drawer ("Details" button) and below 900 px so is the rail ("Chapters"); only one is open at a time. An open drawer
 * has `aria-expanded` on its button, keeps Tab inside, closes on Escape, a tap outside or its own Close button (the only way out on a phone, where it fills the screen),
 * and gives focus back to its button. Picking a scene in the Chapters drawer closes it too. Opening and closing is announced politely.
 * `openPanel` (tests): the drawer that starts open. Below 900 px the two buttons are the tab switch between the text and its panels (the split editor and the pinned panel of M07-J04 are one panel at a time there).
 */
export function Workspace({ rail, inspector, openPanel = null, children }) {
  const [open, setOpen] = useState(/** @type {null | 'rail' | 'inspector'} */ (openPanel)); // one drawer at a time
  const [announce, setAnnounce] = useState('');
  const railId = useId();
  const inspectorId = useId();
  const focus = useFocus().active;
  const { layout } = usePrefs();
  const box = useRef(null);
  const railNode = useRef(null);
  const inspectorNode = useRef(null);
  const railToggle = useRef(null);
  const inspectorToggle = useRef(null);
  const showRail = !focus && layout.rail.shown;
  const showInspector = !focus && layout.inspector.shown;
  const railOverlay = useMedia(DRAWER_QUERY.rail);
  const inspectorOverlay = useMedia(DRAWER_QUERY.inspector);
  const railOpen = showRail && open === 'rail';
  const inspectorOpen = showInspector && open === 'inspector';
  const shut = (which, name) => {
    setOpen((o) => (o === which ? null : o));
    setAnnounce(drawerAnnouncement(name, false));
  };
  const toggle = (which, name) => {
    const next = open === which ? null : which;
    setOpen(next);
    setAnnounce(drawerAnnouncement(name, next === which));
  };
  useDrawer({ active: railOpen && railOverlay, onClose: () => shut('rail', 'Chapters'), panel: railNode, toggle: railToggle });
  useDrawer({ active: inspectorOpen && inspectorOverlay, onClose: () => shut('inspector', 'Details'), panel: inspectorNode, toggle: inspectorToggle });
  const overlayOpen = (railOpen && railOverlay) || (inspectorOpen && inspectorOverlay);
  // a drawer that fills the screen (phones) has nothing outside it to tap, so it carries its own Close button; picking a scene in the
  // Chapters drawer also closes it, so you land on the scene
  const closeBar = (which, name) => (
    <div className="drawer-close-bar">
      <button type="button" className="btn btn-small drawer-close" onClick={() => shut(which, name)}>
        Close {name.toLowerCase()}
      </button>
    </div>
  );
  const railDrawer = railOpen && railOverlay;
  useEffect(() => {
    const nav = railNode.current;
    if (!railDrawer || !nav) return undefined;
    const onPick = (e) => {
      if (e.target instanceof Element && e.target.closest('a[href]')) shut('rail', 'Chapters');
    };
    nav.addEventListener('click', onPick);
    return () => nav.removeEventListener('click', onPick);
  });
  return (
    <div className="workspace" data-focus={focus ? 'on' : 'off'} data-drawer={overlayOpen ? (railOpen ? 'rail' : 'inspector') : 'none'} ref={box}>
      {(showRail || showInspector) && (
        <div className="workspace-bar" role="group" aria-label="Panels">
          {showRail && (
            <button type="button" ref={railToggle} className="rail-toggle btn" aria-expanded={railOpen} aria-controls={railId} onClick={() => toggle('rail', 'Chapters')}>
              Chapters
            </button>
          )}
          {showInspector && (
            <button type="button" ref={inspectorToggle} className="inspector-toggle btn" aria-expanded={inspectorOpen} aria-controls={inspectorId} onClick={() => toggle('inspector', 'Details')}>
              Details
            </button>
          )}
        </div>
      )}
      {overlayOpen && <button type="button" className="drawer-scrim" aria-label="Close panel" tabIndex={-1} onClick={() => setOpen(null)} />}
      {showRail && (
        <nav id={railId} ref={railNode} tabIndex={-1} aria-label="Manuscript" className="rail" data-open={railOpen ? 'true' : 'false'}>
          {railOpen && railOverlay && closeBar('rail', 'Chapters')}
          {rail}
        </nav>
      )}
      <main id="main" tabIndex={-1} className="workspace-main" inert={overlayOpen || undefined}>
        {children}
      </main>
      {showInspector && (
        <aside id={inspectorId} ref={inspectorNode} tabIndex={-1} aria-label="Inspector" className="inspector" data-open={inspectorOpen ? 'true' : 'false'}>
          {inspectorOpen && inspectorOverlay && closeBar('inspector', 'Details')}
          {inspector}
        </aside>
      )}
      {showRail && <PanelSeparator which="rail" containerRef={box} />}
      {showInspector && <PanelSeparator which="inspector" containerRef={box} />}
      <p className="sr-only drawer-live" role="status" aria-live="polite" aria-atomic="true" data-testid="drawer-live">
        {announce}
      </p>
    </div>
  );
}
