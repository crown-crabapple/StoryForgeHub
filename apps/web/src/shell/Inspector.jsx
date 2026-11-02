import { GoalCard } from '../writing/GoalCard.jsx';
import { LinkedEntries } from '../writing/LinkedEntries.jsx';
import { Revisions } from '../writing/Revisions.jsx';
import { SceneNotes } from '../writing/SceneNotes.jsx';
import { SceneSection } from '../writing/SceneSection.jsx';
import { useWriting } from '../writing/WritingContext.jsx';
import { InspectorSection } from './InspectorSection.jsx';

export { InspectorSection };

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
 * The right rail for the open scene (M03-J04): goal card, scene facts, what is linked, notes, continuity, problems, revisions.
 * Names come from `objects` (the GET /api/books/:b/objects answer) with the slug in the tooltip; a slug nothing resolves is shown as it is.
 * @param {{ book: any, scene: any | null, diagnostics: { items: any[] | null, error: string | null, loading: boolean },
 *   objects?: { id: string, kind: string, slug: string | null, title: string | null }[] | null, onChanged?: () => void }} props
 *   `onChanged` runs after the rail changed the book (status, POV, a restore as a new scene).
 */
export function SceneInspector({ book, scene, diagnostics, objects = null, onChanged }) {
  const { liveBody } = useWriting();
  const readable = Boolean(scene) && !scene?.problem && !scene?.raw;
  const body = readable ? (liveBody ?? scene?.body ?? '') : '';
  const items = diagnostics.items ?? [];
  const forScene = scene ? items.filter((d) => isForFile(d, book, scene)) : [];
  const forBook = scene ? items.filter((d) => !forScene.includes(d)) : items;
  return (
    <>
      {scene && (
        <>
          <GoalCard />
          {readable && <SceneSection book={book} scene={scene} objects={objects} onChanged={onChanged} />}
          <LinkedEntries bookId={book.id} front={scene.front_matter} body={body} objects={objects} />
          <SceneNotes body={body} />
          <InspectorSection title="Continuity">
            <p className="placeholder-card">Continuity checks arrive in M05.</p>
          </InspectorSection>
          <InspectorSection title="Problems">
            {diagnostics.loading && <p className="muted">Loading…</p>}
            {diagnostics.error && <p className="error">{diagnostics.error}</p>}
            {diagnostics.items && forScene.length === 0 && <p className="muted">No problems in this scene.</p>}
            {forScene.length > 0 && <DiagnosticList items={forScene} />}
          </InspectorSection>
          {readable && <Revisions bookId={book.id} sceneId={scene.id} onChanged={onChanged} />}
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
