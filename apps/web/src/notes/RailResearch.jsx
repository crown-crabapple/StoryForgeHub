import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { notesHref } from './model.js';

/**
 * A list of research notes, each linking to the note. Used by the "Research" section of the editor rail (`via`: the entries and threads of the scene a note links) and
 * of the Codex inspector.
 * @param {{ bookId: string, notes: { id: string, title: string | null, via?: string[] }[], empty?: string }} props
 */
export function ResearchList({ bookId, notes, empty = 'No research notes are linked to this.' }) {
  if (notes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="rail-links">
      {notes.map((n) => (
        <li key={n.id}>
          <Link to={notesHref(bookId, { section: 'research', note: n.id })}>{n.title}</Link>
          {n.via && n.via.length > 0 && <span className="muted"> · {n.via.join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The "Research" section of the editor rail: notes that link any entry or thread of the scene. @param {{ bookId: string, notes: any[] | null }} props `notes`: researchForScene(); null while loading */
export function RailResearch({ bookId, notes }) {
  return (
    <InspectorSection title="Research">
      {notes === null ? <p className="muted">Loading…</p> : <ResearchList bookId={bookId} notes={notes} empty="No research notes link anything in this scene." />}
    </InspectorSection>
  );
}
