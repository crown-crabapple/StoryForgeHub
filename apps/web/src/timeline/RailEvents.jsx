import { Link } from '../router.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { timelineHref, whenLabel } from './model.js';

/**
 * The "Events" section of the editor rail: the events the open scene belongs to, from both sides (the event lists the scene, or the scene lists the event), each linking
 * to the Timeline. `events` comes from eventsForScene(); null while the timeline is loading.
 * @param {{ bookId: string, events: { id: string, title: string, when: string | null, date?: string | null }[] | null }} props
 */
export function RailEvents({ bookId, events }) {
  return (
    <InspectorSection title="Events">
      {events === null ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted">No event is linked to this scene.</p>
      ) : (
        <ul className="rail-links">
          {events.map((e) => (
            <li key={e.id}>
              <Link to={timelineHref(bookId, { event: e.id })}>{e.title}</Link>
              {whenLabel(e) && <span className="muted"> · {whenLabel(e)}</span>}
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link to={timelineHref(bookId)}>Open the Timeline</Link>
      </p>
    </InspectorSection>
  );
}
