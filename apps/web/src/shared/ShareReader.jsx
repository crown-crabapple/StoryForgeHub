import { useMemo, useState } from 'react';
import { useApi } from '../api.js';

const FORMATS = [
  ['markdown', 'Markdown'],
  ['docx', 'Word (.docx)'],
  ['epub', 'EPUB'],
  ['pdf', 'PDF'],
];

/**
 * What a read-only share link shows: the one book it is for, its scenes, and downloads when the link allows them. No editing, no other books.
 * @param {{ share: { book: string, scope: string[] }, book?: any, scene?: any, sceneId?: string | null, onPick?: (id: string) => void, onLeave?: () => void, error?: string | null }} props
 */
export function ShareReaderPage({ share, book = null, scene = null, sceneId = null, onPick, onLeave, error = null }) {
  const scenes = useMemo(() => (book?.acts ?? []).flatMap((a) => a.chapters.flatMap((c) => c.scenes)), [book]);
  const canExport = share.scope.includes('export');
  return (
    <div className="app">
      <header className="topbar">
        <span className="logo-word">StoryForge</span>
        <span className="share-badge">Shared with you, read only</span>
        <nav aria-label="Application" className="topbar-nav">
          <button type="button" className="btn btn-small" onClick={onLeave}>
            Leave
          </button>
        </nav>
      </header>
      <div className="share-layout">
        <aside aria-label="Scenes" className="share-scenes">
          {book && <h2>{book.title}</h2>}
          <ul>
            {scenes.map((s) => (
              <li key={s.id}>
                <button type="button" className="btn btn-small" aria-current={s.id === sceneId ? 'true' : undefined} onClick={() => onPick?.(s.id)}>
                  {s.title ?? s.id}
                </button>
              </li>
            ))}
          </ul>
          {canExport && (
            <section aria-label="Downloads">
              <h2>Download</h2>
              <ul>
                {FORMATS.map(([f, label]) => (
                  <li key={f}>
                    <a href={`/api/books/${encodeURIComponent(share.book)}/export?format=${f}`} download>
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
        <main id="main" tabIndex={-1} className="page share-text">
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : !book ? (
            <p role="status">Loading...</p>
          ) : (
            <>
              <h1>{scene?.title ?? book.title}</h1>
              {scene ? <div className="share-prose">{scene.body}</div> : <p>Choose a scene.</p>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** Loads the shared book and shows it. @param {{ share: { book: string, scope: string[] }, onLeave: () => void }} props */
export function ShareReader({ share, onLeave }) {
  const { data: book, error } = useApi(`/api/books/${encodeURIComponent(share.book)}`);
  const [picked, setPicked] = useState(/** @type {string | null} */ (null));
  const first = book?.acts?.flatMap((a) => a.chapters.flatMap((c) => c.scenes))[0]?.id ?? null;
  const sceneId = picked ?? first;
  const { data: scene } = useApi(sceneId ? `/api/books/${encodeURIComponent(share.book)}/scenes/${encodeURIComponent(sceneId)}` : null);
  return <ShareReaderPage share={share} book={book} scene={scene} sceneId={sceneId} onPick={setPicked} onLeave={onLeave} error={error ? 'This book could not be loaded. The link may have expired.' : null} />;
}
