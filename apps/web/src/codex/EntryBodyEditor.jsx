import { useApi } from '../api.js';
import { SceneEditorPage } from '../editor/SceneEditorPage.jsx';
import { entryUrl } from './requests.js';
import { statusLabel } from './model.js';
import { SHARED_NOTICE, sharedBadge } from '../world/model.js';

/**
 * The text of one entry in the editor the scenes use (same component: toolbar, autosave, conflict panel, draft store); only the URL
 * differs. It saves the body alone: PUT /entries/:id/body with the file hash it was loaded from, so the front matter is never touched.
 * @param {{ bookId: string, entry: any, types?: { type: string, name: string }[], objects?: any[] | null, onDone: () => void }} props
 */
export function EntryBodyEditor({ bookId, entry, types = [], objects = null, onDone }) {
  const url = entryUrl(bookId, entry.id);
  const { data, error, loading } = useApi(url);
  const typeName = types.find((t) => t.type === entry.type)?.name ?? entry.type;
  return (
    <div className="codex-editor">
      <div className="codex-editor-head">
        <button type="button" className="btn" onClick={onDone}>
          Back to the cards
        </button>
        <span className="muted">Editing the text of {entry.name}. Changes save automatically.</span>
        {entry.shared && (
          <span className="shared-notice" role="note">
            <span className="shared-badge">{sharedBadge(entry)}</span> {SHARED_NOTICE}
          </span>
        )}
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !data && <p className="muted">That entry is not there any more.</p>}
      {data && typeof data.body === 'string' && (
        <SceneEditorPage
          key={data.id}
          book={{ id: bookId }}
          scene={{ id: data.id, title: data.name, body: data.body, sha256: data.sha256 }}
          objects={objects}
          resource={{ url, label: 'Entry text', meta: [typeName, statusLabel(data.status)].filter(Boolean) }}
        />
      )}
    </div>
  );
}
