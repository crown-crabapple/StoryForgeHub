import { useState } from 'react';
import { postJson, useApi } from './api.js';
import { Link } from './router.jsx';

function Tree({ book, activeId }) {
  return (
    <nav aria-label="Manuscript" className="tree">
      {book.acts.map((act) => (
        <section key={act.act}>
          <h3>{act.label}</h3>
          {act.chapters.map((ch) => (
            <div key={ch.chapter}>
              <h4>{ch.title ? `${ch.label}: ${ch.title}` : ch.label}</h4>
              <ul>
                {ch.scenes.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/books/${encodeURIComponent(book.id)}?scene=${encodeURIComponent(s.id)}`}
                      className={s.id === activeId ? 'scene-link active' : 'scene-link'}
                      aria-current={s.id === activeId ? 'page' : undefined}
                    >
                      {s.title}
                    </Link>
                    <span className="muted"> {s.word_count}w</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </nav>
  );
}

function ArchiveButton({ bookId, scene }) {
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  async function archive() {
    if (!window.confirm(`Archive "${scene.title}"? The file moves to the archive folder; nothing is deleted.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { status } = await postJson(
        `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(scene.id)}/archive`,
        { base_sha256: scene.sha256 },
      );
      if (status === 200) {
        window.location.assign(`/books/${encodeURIComponent(bookId)}`);
        return;
      }
      setMessage(
        status === 409
          ? 'Not archived: the scene changed on disk (or archiving would break the book). Reload the page and try again.'
          : `Not archived (${status}).`,
      );
    } catch {
      setMessage('Not archived: the server could not be reached.');
    }
    setBusy(false);
  }
  return (
    <p>
      <button type="button" onClick={archive} disabled={busy}>
        Archive
      </button>
      {message && <span className="error"> {message}</span>}
    </p>
  );
}

function SceneText({ bookId, sceneId }) {
  const { data: scene, error, loading } = useApi(
    sceneId ? `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}` : null,
  );
  if (!sceneId) return <p className="muted">This book has no scenes in its manuscript.</p>;
  if (loading) return <p className="muted">Loading...</p>;
  if (error) return <p className="error">{error}</p>;
  if (!scene) return <p className="muted">Scene not found.</p>;
  return (
    <article>
      <h2>{scene.title}</h2>
      <ArchiveButton bookId={bookId} scene={scene} />
      <p className="muted">
        {scene.status ?? 'no status'}
        {scene.pov ? ` · POV ${scene.pov}` : ''} · {scene.word_count} words
      </p>
      <pre className="scene-text">{scene.body}</pre>
    </article>
  );
}

function Diagnostics({ bookId }) {
  const { data: items, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}/diagnostics`);
  return (
    <aside aria-label="Diagnostics" className="diagnostics">
      <h3>Diagnostics</h3>
      {loading && <p className="muted">Loading...</p>}
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="muted">No problems found.</p>}
      {items && items.length > 0 && (
        <ul>
          {items.map((d, i) => (
            <li key={`${d.code}-${d.file}-${d.location}-${i}`} className={`diag diag-${d.severity}`}>
              <strong>
                {d.code} {d.severity}
              </strong>
              <div className="muted">
                {d.file}
                {d.location ? ` (${d.location})` : ''}
              </div>
              <div>{d.message}</div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function BookView({ bookId, sceneId }) {
  const { data: book, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}`);
  if (loading) return <main className="page muted">Loading...</main>;
  if (error) return <main className="page error">{error}</main>;
  if (!book) {
    return (
      <main className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  const allScenes = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
  const activeId = sceneId && allScenes.some((s) => s.id === sceneId) ? sceneId : (allScenes[0]?.id ?? null);
  return (
    <div className="workspace">
      <div className="col col-tree">
        <h1>{book.title ?? book.slug ?? book.id}</h1>
        <Tree book={book} activeId={activeId} />
      </div>
      <main className="col col-scene">
        <SceneText key={activeId ?? 'none'} bookId={book.id} sceneId={activeId} />
      </main>
      <div className="col col-diag">
        <Diagnostics bookId={book.id} />
      </div>
    </div>
  );
}
