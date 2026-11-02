import { useEditorBridge } from '../editor/bridge.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { sceneNoteList } from './scene-context.js';

/** "Scene notes": every author note of the scene with its line; clicking one moves the editor caret there. @param {{ body: string }} props */
export function SceneNotes({ body }) {
  const bridge = useEditorBridge();
  const notes = sceneNoteList(body);
  return (
    <InspectorSection title="Scene notes">
      {notes.length === 0 ? (
        <p className="muted">No notes in this scene.</p>
      ) : (
        <ul className="notes-list">
          {notes.map((n) => (
            <li key={n.offset}>
              <button type="button" className="note-jump" onClick={() => bridge.current()?.jumpToLine?.(n.line)}>
                <span className="note-line">Line {n.line}</span> <span className="note-text">{n.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}
