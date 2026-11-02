import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { chapterOptions, currentPosition, dialogTarget, locate, positionOptions } from './move-target.js';

/**
 * The Move... dialog: the keyboard / no-drag way to move a scene. Chapter select (acts as groups, every chapter including
 * empty ones), Position select ("At the start", "After <scene>"), Move / Cancel. The caller shows the same preview rules as a drop.
 * `onSubmit({ chapter, act, after })`; `error` / `repair` are a refusal to show (with a Repair button for a book with errors).
 */
export function MoveDialog({ book, scene, busy = false, error = null, repair = false, onSubmit, onClose, onRepair }) {
  const here = locate(book, scene.id);
  const now = currentPosition(book, scene.id);
  const [chapter, setChapter] = useState(String(here?.chapter ?? ''));
  const [position, setPosition] = useState(now?.value ?? '');
  const name = scene.title || 'Untitled scene';
  const groups = chapterOptions(book);
  const positions = positionOptions(book, Number(chapter), scene.id);

  const pickChapter = (value) => {
    setChapter(value);
    setPosition(Number(value) === here?.chapter ? (now?.value ?? '') : '');
  };

  return (
    <Dialog label={`Move ${name}`} onClose={onClose}>
      <h2>Move &quot;{name}&quot;</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const target = dialogTarget(book, chapter, position);
          if (target) onSubmit(target);
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Act and chapter</span>
            <select name="chapter" value={chapter} onChange={(e) => pickChapter(e.target.value)}>
              {groups.map((g) => (
                <optgroup key={g.act} label={g.label}>
                  {g.chapters.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            <span className="form-label">Position</span>
            <select name="position" value={position} onChange={(e) => setPosition(e.target.value)}>
              {positions.map((p) => (
                <option key={p.value || 'start'} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {repair && (
            <button type="button" className="btn" onClick={onRepair}>
              Repair...
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Move
          </button>
        </div>
      </form>
    </Dialog>
  );
}
