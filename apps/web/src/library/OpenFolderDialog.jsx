import { useState } from 'react';
import { postJson } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';

/** Plain-words messages for the codes POST /api/library/open can answer with. */
const WORDS = {
  NOT_FOUND: 'We could not find that folder. Type the full path, for example C:\\Books or /home/me/books.',
  NOT_A_FOLDER: 'That path is not a folder StoryForge can open. Choose the folder that holds your books.',
  NO_BOOKS: 'That folder has no books in it.',
  LOCKED: 'Another StoryForge window is using that folder.',
  OPEN_FAILED: 'That folder could not be opened.',
};

/** @param {{ code?: string, message?: string } | null} error */
function words(error) {
  if (!error) return null;
  if (error.code && WORDS[error.code]) return WORDS[error.code];
  return error.message && error.message !== error.code ? error.message : 'That folder could not be opened.';
}

/**
 * The Open folder dialog: a path field and the recent libraries. A native folder picker is not possible in a
 * browser, so the path is typed (or picked from the recent list).
 * @param {{
 *   recent?: { path: string, exists?: boolean }[],
 *   onClose: () => void,
 *   onOpened?: (result: { ok: true, library: any }) => void,
 *   onRemove?: (path: string) => void,
 *   error?: { code?: string, message?: string } | null,
 * }} props  `error` is the error to show when the dialog opens (the dialog keeps its own after that).
 */
export function OpenFolderDialog({ recent = [], onClose, onOpened, onRemove, error = null }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(error);
  const [removed, setRemoved] = useState([]);
  const items = recent.filter((r) => !removed.includes(r.path));

  async function open(target) {
    if (busy) return;
    if (target.trim() === '') {
      setProblem({ code: 'NOT_FOUND' });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const { json } = await postJson('/api/library/open', { path: target.trim() });
      if (json?.ok) {
        onOpened?.(json);
        return;
      }
      setProblem(json && typeof json === 'object' ? json : { code: 'OPEN_FAILED' });
    } catch {
      setProblem({ message: 'StoryForge could not be reached. Try again in a moment.' });
    }
    setBusy(false);
  }

  async function remove(target) {
    setRemoved((r) => [...r, target]);
    try {
      await postJson('/api/library/recent/remove', { path: target });
    } catch {
      // the list is only a convenience; it is shown again next time
    }
    onRemove?.(target);
  }

  const message = words(problem);
  return (
    <Dialog label="Open folder" onClose={onClose} className="open-folder-dialog">
      <h2>Open folder</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          open(path);
        }}
        noValidate
      >
        <div className="field">
          <label htmlFor="of-path">Folder</label>
          <input
            id="of-path"
            type="text"
            value={path}
            placeholder="C:\Books\My library"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setPath(e.target.value);
              setProblem(null);
            }}
            {...(message ? { 'aria-invalid': 'true', 'aria-describedby': 'of-error' } : {})}
          />
          {message && (
            <p id="of-error" role="alert" className="field-error">
              {message}
            </p>
          )}
          <p className="secondary field-hint">The folder can be a library of books, a series, or a single book.</p>
        </div>

        {items.length > 0 && (
          <div className="recent-libraries">
            <h3>Recent</h3>
            <ul className="recent-list">
              {items.map((r) => (
                <li key={r.path} className="recent-item" data-missing={r.exists === false ? 'true' : 'false'}>
                  {r.exists === false ? (
                    <>
                      <span className="recent-path recent-missing">{r.path}</span>
                      <span className="badge">not found</span>
                    </>
                  ) : (
                    <button type="button" className="recent-path recent-open" disabled={busy} onClick={() => open(r.path)}>
                      {r.path}
                    </button>
                  )}
                  <button type="button" className="btn recent-remove" aria-label={`Remove ${r.path} from the list`} onClick={() => remove(r.path)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Open
          </button>
        </div>
      </form>
    </Dialog>
  );
}
