import { useApi } from '../api.js';
import { SceneEditorPage } from '../editor/SceneEditorPage.jsx';
import { stateLabel } from './model.js';
import { threadUrl } from './requests.js';

/**
 * The text of one thread in the editor the scenes use (the same component, as for Codex entries): it saves the body alone, PUT /threads/:id/body with the
 * file hash it was loaded from, so the front matter is never touched.
 * @param {{ bookId: string, thread: { id: string, title: string, kind: string | null, status: string | null }, objects?: any[] | null, onDone: () => void }} props
 */
export function ThreadBodyEditor({ bookId, thread, objects = null, onDone }) {
  const url = threadUrl(bookId, thread.id);
  const { data, error, loading } = useApi(url);
  return (
    <div className="codex-editor">
      <div className="codex-editor-head">
        <button type="button" className="btn" onClick={onDone}>
          Back to the threads
        </button>
        <span className="muted">Editing the text of {thread.title}. Changes save automatically.</span>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !data && <p className="muted">That thread is not there any more.</p>}
      {data && typeof data.body === 'string' && (
        <SceneEditorPage
          key={data.id}
          book={{ id: bookId }}
          scene={{ id: data.id, title: data.title, body: data.body, sha256: data.sha256 }}
          objects={objects}
          resource={{ url, label: 'Thread text', meta: [data.kind, stateLabel(data.status)].filter(Boolean) }}
        />
      )}
    </div>
  );
}
