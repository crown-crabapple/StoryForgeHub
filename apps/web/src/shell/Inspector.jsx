import { GoalCard } from '../writing/GoalCard.jsx';
import { LinkedEntries } from '../writing/LinkedEntries.jsx';
import { Revisions } from '../writing/Revisions.jsx';
import { SceneNotes } from '../writing/SceneNotes.jsx';
import { SceneSection } from '../writing/SceneSection.jsx';
import { sceneLinkItems } from '../writing/scene-context.js';
import { RailResearch } from '../notes/RailResearch.jsx';
import { researchForScene } from '../notes/model.js';
import { RailContinuity } from '../continuity/RailContinuity.jsx';
import { RailSuggestions } from '../suggestions/RailSuggestions.jsx';
import { RailComments } from '../collab/RailComments.jsx';
import { RailReceipts } from '../receipts/RailReceipts.jsx';
import { RailEvents } from '../timeline/RailEvents.jsx';
import { eventsForScene } from '../timeline/model.js';
import { threadActionsFor } from '../planning/ThreadMarks.jsx';
import { useStructure } from '../structure/useStructure.jsx';
import { threadListRequest } from '../planning/requests.js';
import { useWriting } from '../writing/WritingContext.jsx';
import { InspectorSection } from './InspectorSection.jsx';

export { InspectorSection };

/** The problems of a book. A problem in the series' shared files (`scope: 'series'`, M07-J01b) carries a "Series" badge: it is the same for every book of the series. */
export function DiagnosticList({ items }) {
  return (
    <ul className="diag-list">
      {items.map((d, i) => (
        <li key={`${d.code}-${d.file}-${d.location}-${i}`} className={`diag diag-${d.severity}`}>
          <strong>
            {d.code} {d.severity}
          </strong>
          {d.scope === 'series' && (
            <span className="series-badge" title={`In the shared files of the series ${d.series ?? ''}`.trim()}>
              Series
            </span>
          )}
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
 *   objects?: { id: string, kind: string, slug: string | null, title: string | null }[] | null, onChanged?: () => void, planning?: { threads: any[] } | null,
 *   timeline?: any | null, notes?: { notes: any[] } | null, continuity?: any | null, version?: string }} props
 *   `onChanged` runs after the rail changed the book (status, POV, a restore as a new scene).
 *   `timeline` (GET /timeline) and `notes` (GET /notes), M04-J04: when given (null while loading), the rail also shows "Events" (the scene's events, from both sides) and "Research"
 *   (research notes that link any entry or thread of the scene). Left out, those two sections are not drawn.
 *   `continuity` (GET /continuity), M05-J02: the rail's "Continuity" section lists the findings of this scene ("Loading…" while it is null or left out); `version` refreshes the context lines it shows.
 */
export function SceneInspector({ book, scene, diagnostics, objects = null, onChanged, planning = null, timeline = undefined, notes = undefined, continuity = undefined, version = '' }) {
  const { liveBody } = useWriting();
  const structure = useStructure({ book, activeId: scene?.id ?? null, onChanged });
  // "Mark this scene as setup / development / payoff" under each plot thread (M04-J03): the thread file's list changes, after a preview
  const markThread = (thread, list, present) => {
    const words = { setup: 'setup', develop: 'development', payoff: 'payoff' };
    const what = present ? `Mark "${scene?.title || 'Untitled scene'}" as ${words[list]} of "${thread.title}"` : `Remove "${scene?.title || 'Untitled scene'}" from the ${words[list]} of "${thread.title}"`;
    const r = threadListRequest(book.id, thread, list, scene.id, present);
    structure.preview({ title: what, url: r.url, body: r.body, done: present ? `Marked as ${words[list]}.` : `Removed from the ${words[list]}.`, undoable: true });
  };
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
          <LinkedEntries bookId={book.id} front={scene.front_matter} body={body} objects={objects} threadActions={planning ? threadActionsFor({ planning, sceneId: scene.id, onMark: markThread }) : null} />
          <SceneNotes body={body} />
          {timeline !== undefined && <RailEvents bookId={book.id} events={timeline ? eventsForScene(timeline, scene.id) : null} />}
          {notes !== undefined && <RailResearch bookId={book.id} notes={notes ? researchForScene(notes.notes, sceneLinkItems(scene.front_matter, body, objects)) : null} />}
          <RailContinuity book={book} scene={scene} continuity={continuity ?? null} version={version} onChanged={onChanged} />
          {readable && <RailComments book={book} scene={scene} version={version} onChanged={onChanged} />}
          {readable && <RailSuggestions book={book} scene={scene} version={version} onChanged={onChanged} />}
          <InspectorSection title="Problems">
            {diagnostics.loading && <p className="muted">Loading…</p>}
            {diagnostics.error && <p className="error">{diagnostics.error}</p>}
            {diagnostics.items && forScene.length === 0 && <p className="muted">No problems in this scene.</p>}
            {forScene.length > 0 && <DiagnosticList items={forScene} />}
          </InspectorSection>
          {readable && <Revisions bookId={book.id} sceneId={scene.id} onChanged={onChanged} />}
          {readable && <RailReceipts book={book} scene={scene} version={version} onChanged={onChanged} />}
        </>
      )}
      <InspectorSection title="Book problems">
        {!scene && diagnostics.loading && <p className="muted">Loading…</p>}
        {!scene && diagnostics.error && <p className="error">{diagnostics.error}</p>}
        {diagnostics.items && forBook.length === 0 && <p className="muted">No other problems found.</p>}
        {forBook.length > 0 && <DiagnosticList items={forBook} />}
      </InspectorSection>
      {structure.ui}
    </>
  );
}
