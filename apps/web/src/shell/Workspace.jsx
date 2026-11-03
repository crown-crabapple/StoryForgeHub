import { useId, useRef, useState } from 'react';
import { PanelSeparator } from '../prefs/PanelSeparator.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { useFocus } from '../writing/FocusContext.jsx';

/**
 * Three regions: the manuscript rail, the main column and the inspector. Wide: three columns. Medium:
 * rail + main with the inspector below main. Narrow: one column, the rail behind a "Chapters" button.
 * `main` is the page's <main>: pass its content as children. In focus mode only the main column is drawn (the rail and the
 * inspector are not rendered; their slots stay empty so the main column keeps its place and its state).
 * M07-J04: the layout can hide either side panel (their slots stay, so switching layouts never remounts the page or loses an unsaved buffer) and
 * the panels are resized with a separator (mouse and keyboard).
 */
export function Workspace({ rail, inspector, children }) {
  const [railOpen, setRailOpen] = useState(false);
  const railId = useId();
  const focus = useFocus().active;
  const { layout } = usePrefs();
  const box = useRef(null);
  const showRail = !focus && layout.rail.shown;
  const showInspector = !focus && layout.inspector.shown;
  return (
    <div className="workspace" data-focus={focus ? 'on' : 'off'} ref={box}>
      {showRail && (
        <button type="button" className="rail-toggle btn" aria-expanded={railOpen} aria-controls={railId} onClick={() => setRailOpen((o) => !o)}>
          Chapters
        </button>
      )}
      {showRail && (
        <nav id={railId} aria-label="Manuscript" className="rail" data-open={railOpen ? 'true' : 'false'}>
          {rail}
        </nav>
      )}
      <main id="main" tabIndex={-1} className="workspace-main">
        {children}
      </main>
      {showInspector && (
        <aside aria-label="Inspector" className="inspector">
          {inspector}
        </aside>
      )}
      {showRail && <PanelSeparator which="rail" containerRef={box} />}
      {showInspector && <PanelSeparator which="inspector" containerRef={box} />}
    </div>
  );
}
