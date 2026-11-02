import { useId, useState } from 'react';
import { useFocus } from '../writing/FocusContext.jsx';

/**
 * Three regions: the manuscript rail, the main column and the inspector. Wide: three columns. Medium:
 * rail + main with the inspector below main. Narrow: one column, the rail behind a "Chapters" button.
 * `main` is the page's <main>: pass its content as children. In focus mode only the main column is drawn (the rail and the
 * inspector are not rendered; their slots stay empty so the main column keeps its place and its state).
 */
export function Workspace({ rail, inspector, children }) {
  const [railOpen, setRailOpen] = useState(false);
  const railId = useId();
  const focus = useFocus().active;
  return (
    <div className="workspace" data-focus={focus ? 'on' : 'off'}>
      {!focus && (
        <button type="button" className="rail-toggle btn" aria-expanded={railOpen} aria-controls={railId} onClick={() => setRailOpen((o) => !o)}>
          Chapters
        </button>
      )}
      {!focus && (
        <nav id={railId} aria-label="Manuscript" className="rail" data-open={railOpen ? 'true' : 'false'}>
          {rail}
        </nav>
      )}
      <main id="main" tabIndex={-1} className="workspace-main">
        {children}
      </main>
      {!focus && (
        <aside aria-label="Inspector" className="inspector">
          {inspector}
        </aside>
      )}
    </div>
  );
}
