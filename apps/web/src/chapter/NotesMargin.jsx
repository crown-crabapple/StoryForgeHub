// The scene-notes margin of one scene: its summary (edited in place) and its author notes (a click scrolls to the note in the text).
import { useState } from 'react';
import { useChapter } from './ChapterContext.js';

/** @param {{ sceneId: string }} props */
export function NotesMargin({ sceneId }) {
  const ctx = useChapter();
  const info = ctx?.scenes[sceneId];
  const [draft, setDraft] = useState(/** @type {string | null} */ (null));
  if (!ctx || !info) return null;
  const notes = ctx.notes[sceneId] ?? [];
  const shown = draft ?? info.summary;
  const commit = () => {
    if (draft !== null && draft !== info.summary) void ctx.actions.saveSummary(sceneId, draft);
    setDraft(null);
  };
  return (
    <aside className="sf-margin" id={`sf-margin-${sceneId}`} aria-label={`Notes for ${info.title || 'Untitled scene'}`}>
      <label className="sf-margin-field">
        <span className="sf-margin-label">Summary</span>
        <textarea
          rows={3}
          value={shown}
          placeholder="One or two lines about this scene"
          disabled={!ctx.canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </label>
      <div className="sf-margin-field">
        <span className="sf-margin-label">Author notes</span>
        {notes.length === 0 ? (
          <p className="muted sf-margin-empty">No notes in this scene.</p>
        ) : (
          <ul className="sf-margin-notes">
            {notes.map((n) => (
              <li key={n.pos}>
                <button type="button" className="sf-margin-note" onClick={() => ctx.actions.goToNote(n.pos)}>
                  {n.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
