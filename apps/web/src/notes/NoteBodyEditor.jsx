import { useApi } from '../api.js';
import { SceneEditorPage } from '../editor/SceneEditorPage.jsx';
import { KIND_LABEL } from './model.js';
import { noteUrl } from './requests.js';

/**
 * The text of one note in the editor the scenes use (the same component): it saves the body alone, PUT /notes/:id/body with the file hash it was loaded from, so the
 * front matter is never touched. The editor also offers "Attach file..." and takes files dropped on it: the file is uploaded to the book and a link to it is inserted
 * at the caret, relative to this note.
 * @param {{ bookId: string, note: { id: string, title: string | null, kind: string }, objects?: any[] | null, onDone: () => void }} props
 */
export function NoteBodyEditor({ bookId, note, objects = null, onDone }) {
  const url = noteUrl(bookId, note.id);
  const { data, error, loading } = useApi(url);
  return (
    <div className="codex-editor">
      <div className="codex-editor-head">
        <button type="button" className="btn" onClick={onDone}>
          Back to the note
        </button>
        <span className="muted">Editing the text of {note.title}. Changes save automatically.</span>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !data && <p className="muted">That note is not there any more.</p>}
      {data && typeof data.body === 'string' && (
        <SceneEditorPage
          key={data.id}
          book={{ id: bookId }}
          scene={{ id: data.id, title: data.title, body: data.body, sha256: data.sha256 }}
          objects={objects}
          resource={{ url, label: 'Note text', meta: [KIND_LABEL[data.kind] ?? data.kind], attach: { noteId: data.id } }}
        />
      )}
    </div>
  );
}
