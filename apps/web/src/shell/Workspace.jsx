import { useId, useState } from 'react';

/**
 * Three regions: the manuscript rail, the main column and the inspector. Wide: three columns. Medium:
 * rail + main with the inspector below main. Narrow: one column, the rail behind a "Chapters" button.
 * `main` is the page's <main>: pass its content as children.
 */
export function Workspace({ rail, inspector, children }) {
  const [railOpen, setRailOpen] = useState(false);
  const railId = useId();
  return (
    <div className="workspace">
      <button type="button" className="rail-toggle btn" aria-expanded={railOpen} aria-controls={railId} onClick={() => setRailOpen((o) => !o)}>
        Chapters
      </button>
      <nav id={railId} aria-label="Manuscript" className="rail" data-open={railOpen ? 'true' : 'false'}>
        {rail}
      </nav>
      <main id="main" tabIndex={-1} className="workspace-main">
        {children}
      </main>
      <aside aria-label="Inspector" className="inspector">
        {inspector}
      </aside>
    </div>
  );
}
