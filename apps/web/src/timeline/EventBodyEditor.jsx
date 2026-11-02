import { useApi } from '../api.js';
import { SceneEditorPage } from '../editor/SceneEditorPage.jsx';
import { eventUrl } from './requests.js';
import { whenLabel } from './model.js';

/**
 * The text of one event in the editor the scenes use (the same component, as for Codex entries and threads): it saves the body alone, PUT /events/:id/body with the
 * file hash it was loaded from, so the front matter is never touched.
 * @param {{ bookId: string, event: { id: string, title: string | null, slug: string | null, when?: string | null, date?: string | null }, objects?: any[] | null, onDone: () => void }} props
 */
export function EventBodyEditor({ bookId, event, objects = null, onDone }) {
  const url = eventUrl(bookId, event.id);
  const { data, error, loading } = useApi(url);
  return (
    <div className="codex-editor">
      <div className="codex-editor-head">
        <button type="button" className="btn" onClick={onDone}>
          Back to the timeline
        </button>
        <span className="muted">Editing the text of {event.title ?? event.slug}. Changes save automatically.</span>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !data && <p className="muted">That event is not there any more.</p>}
      {data && typeof data.body === 'string' && (
        <SceneEditorPage
          key={data.id}
          book={{ id: bookId }}
          scene={{ id: data.id, title: data.title ?? data.slug, body: data.body, sha256: data.sha256 }}
          objects={objects}
          resource={{ url, label: 'Event text', meta: [whenLabel(data) || 'No date label'] }}
        />
      )}
    </div>
  );
}
