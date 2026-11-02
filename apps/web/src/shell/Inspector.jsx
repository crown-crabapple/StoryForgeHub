import { sceneNotes } from '../prose.js';

/** One inspector section: uppercase 12px muted heading, then content. @param {{ title: string, children: import('react').ReactNode }} props */
export function InspectorSection({ title, children }) {
  return (
    <section className="inspector-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Refs({ label, slugs }) {
  if (!slugs || slugs.length === 0) return null;
  return (
    <div className="refs">
      <span className="refs-label">{label}</span>
      <ul>
        {slugs.map((slug) => (
          <li key={slug}>{slug}</li>
        ))}
      </ul>
    </div>
  );
}

export function DiagnosticList({ items }) {
  return (
    <ul className="diag-list">
      {items.map((d, i) => (
        <li key={`${d.code}-${d.file}-${d.location}-${i}`} className={`diag diag-${d.severity}`}>
          <strong>
            {d.code} {d.severity}
          </strong>
          <div className="muted">
            {d.file}
            {d.location ? ` (${d.location})` : ''}
          </div>
          <div>{d.message}</div>
        </li>
      ))}
    </ul>
  );
}

/** Library-relative or book-relative: does this diagnostic belong to the scene's file? */
export function isForFile(diagnostic, book, scene) {
  return diagnostic.file === scene.path || (book.path ? diagnostic.file === `${book.path}/${scene.path}` : false);
}

/**
 * Inspector for the open scene. Names are shown as the slugs the scene's front matter holds: there is no
 * Codex read route yet to resolve them.
 * @param {{ book: any, scene: any | null, diagnostics: { items: any[] | null, error: string | null, loading: boolean } }} props
 */
export function SceneInspector({ book, scene, diagnostics }) {
  const front = scene?.front_matter ?? {};
  const pov = scene?.pov ?? front.pov ?? null;
  const notes = scene && !scene.problem ? sceneNotes(scene.body ?? '') : [];
  const items = diagnostics.items ?? [];
  const forScene = scene ? items.filter((d) => isForFile(d, book, scene)) : [];
  const forBook = scene ? items.filter((d) => !forScene.includes(d)) : items;
  const nothingToShow = !pov && !front.characters?.length && !front.locations?.length && !front.plot_threads?.length;
  return (
    <>
      {scene && (
        <>
          <InspectorSection title="In this scene">
            {nothingToShow ? (
              <p className="muted">Nothing is linked to this scene yet.</p>
            ) : (
              <>
                <Refs label="POV" slugs={pov ? [pov] : []} />
                <Refs label="Characters" slugs={front.characters} />
                <Refs label="Locations" slugs={front.locations} />
                <Refs label="Plot threads" slugs={front.plot_threads} />
              </>
            )}
          </InspectorSection>
          <InspectorSection title="Scene notes">
            {notes.length === 0 ? (
              <p className="muted">No notes in this scene.</p>
            ) : (
              <ul className="notes">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </InspectorSection>
          <InspectorSection title="Problems">
            {diagnostics.loading && <p className="muted">Loading…</p>}
            {diagnostics.error && <p className="error">{diagnostics.error}</p>}
            {diagnostics.items && forScene.length === 0 && <p className="muted">No problems in this scene.</p>}
            {forScene.length > 0 && <DiagnosticList items={forScene} />}
          </InspectorSection>
        </>
      )}
      <InspectorSection title="Book problems">
        {!scene && diagnostics.loading && <p className="muted">Loading…</p>}
        {!scene && diagnostics.error && <p className="error">{diagnostics.error}</p>}
        {diagnostics.items && forBook.length === 0 && <p className="muted">No other problems found.</p>}
        {forBook.length > 0 && <DiagnosticList items={forBook} />}
      </InspectorSection>
    </>
  );
}
