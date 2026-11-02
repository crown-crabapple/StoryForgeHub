import { useState } from 'react';
import { postJson, useApi } from './api.js';
import { ProseView } from './ProseView.jsx';
import { Link } from './router.jsx';
import { SceneInspector } from './shell/Inspector.jsx';
import { BookIcon, FolderIcon } from './shell/icons.jsx';
import { Workspace } from './shell/Workspace.jsx';
import { useWrites } from './shell/writes.jsx';
import { bookVersion, useStatus } from './status.jsx';

const sceneHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}`;

/** Up/Down move between scene links in the rail; Enter opens the focused link (native). Plain Tab works too. */
function moveBetweenScenes(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const links = [...e.currentTarget.querySelectorAll('a[data-scene-link]')];
  const at = links.indexOf(document.activeElement);
  if (at === -1) return;
  const next = links[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/** The manuscript outline: act, chapter, scenes with word counts. */
export function Outline({ book, activeId }) {
  return (
    <div className="outline" onKeyDown={moveBetweenScenes}>
      <h2 className="rail-heading">{book.title ?? book.slug ?? book.id}</h2>
      <ul className="outline-acts">
        {book.acts.map((act) => (
          <li key={act.act}>
            <span className="outline-row outline-act">
              <FolderIcon width={15} height={15} />
              <span className="outline-label">{act.label}</span>
            </span>
            <ul>
              {act.chapters.map((ch) => (
                <li key={ch.chapter}>
                  <span className="outline-row outline-chapter">
                    <BookIcon width={15} height={15} />
                    <span className="outline-label">{ch.title ? `${ch.label}: ${ch.title}` : ch.label}</span>
                    <span className="outline-words">{ch.scenes.reduce((n, s) => n + s.word_count, 0)}w</span>
                  </span>
                  <ul>
                    {ch.scenes.map((s) => (
                      <li key={s.id}>
                        <Link
                          to={sceneHref(book.id, s.id)}
                          data-scene-link=""
                          className="outline-row outline-scene"
                          aria-current={s.id === activeId ? 'page' : undefined}
                        >
                          <span className="outline-label">{s.title}</span>
                          {s.problem && (
                            <span className="badge badge-error" title={s.problem.message}>
                              can't be read
                            </span>
                          )}
                          <span className="outline-words">{s.word_count}w</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArchiveButton({ bookId, scene }) {
  const { track } = useWrites();
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  async function archive() {
    if (!window.confirm(`Archive "${scene.title}"? The file moves to the archive folder; nothing is deleted.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { status } = await track(bookId, () =>
        postJson(`/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(scene.id)}/archive`, { base_sha256: scene.sha256 }),
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
    <span className="archive">
      <button type="button" className="btn" onClick={archive} disabled={busy}>
        Archive scene
      </button>
      {message && <span className="error"> {message}</span>}
    </span>
  );
}

/**
 * The centre column for one scene: title, meta line, prose. A file that can't be read is shown raw, exactly as on disk.
 * @param {{ book: any, scene: any, chapterLabel?: string | null }} props
 */
export function ScenePaper({ book, scene, chapterLabel = null }) {
  const meta = [chapterLabel, scene.status ?? 'no status', scene.pov ? `POV ${scene.pov}` : null, `${scene.word_count} words`].filter(Boolean);
  return (
    <article className="paper">
      <h1>{scene.title}</h1>
      <p className="paper-meta">{meta.join(' · ')}</p>
      {scene.problem ? (
        <>
          <p className="error">
            This file can't be read ({scene.problem.code}: {scene.problem.message}). Its text is shown exactly as it is on disk; fix it in your editor.
          </p>
          <pre className="scene-text">{scene.body}</pre>
        </>
      ) : (
        <ProseView source={scene.body ?? ''} />
      )}
      {!scene.problem && (
        <footer className="paper-footer">
          <span className="muted">{scene.word_count} words</span>
          <ArchiveButton bookId={book.id} scene={scene} />
        </footer>
      )}
    </article>
  );
}

function RawFile({ bookId, file, version }) {
  const { data: raw, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}/raw?path=${encodeURIComponent(file)}`, version);
  if (loading) return <p className="muted">Loading...</p>;
  if (error) return <p className="error">{error}</p>;
  if (!raw) return <p className="muted">That file is not there (any more).</p>;
  return (
    <article className="paper">
      <h1>{raw.path}</h1>
      {raw.problem && (
        <p className="error">
          This file can't be read ({raw.problem.code}: {raw.problem.message}). It is shown exactly as it is on disk; fix it in your editor.
        </p>
      )}
      <pre className="scene-text">{raw.body}</pre>
    </article>
  );
}

/** The banner shown when a file in the book can't be read (J04). */
export function InvalidBanner({ book }) {
  const invalidPaths = book.index_state === 'invalid' ? (book.invalid_paths ?? []) : [];
  if (invalidPaths.length === 0) return null;
  return (
    <aside role="alert" className="banner banner-danger">
      <strong>A file can't be read.</strong>{' '}
      <span>
        {invalidPaths[0]}
        {invalidPaths.length > 1 ? ` (and ${invalidPaths.length - 1} more)` : ''}. Showing the last good version of the book. Fix the file and it will update.
      </span>
      {book.unplaced?.length > 0 && (
        <ul>
          {book.unplaced.map((u) => (
            <li key={u.path}>
              New file not in the book yet: {u.path} ({u.problem.code})
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** Three-column book page: outline rail, main column, inspector. Presentational. */
export function BookLayout({ book, activeId, inspector, children }) {
  return (
    <>
      <InvalidBanner book={book} />
      <Workspace rail={<Outline book={book} activeId={activeId} />} inspector={inspector}>
        {children}
      </Workspace>
    </>
  );
}

export function BookView({ bookId, sceneId, file }) {
  const { status } = useStatus();
  const version = bookVersion(status, bookId);
  const { data: book, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}`, version);
  const allScenes = book ? book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)) : [];
  const activeId = sceneId && allScenes.some((s) => s.id === sceneId) ? sceneId : (allScenes[0]?.id ?? null);
  const showScene = Boolean(book) && !file && activeId !== null;
  const sceneUrl = showScene ? `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(activeId)}` : null;
  const { data: scene, error: sceneError, loading: sceneLoading } = useApi(sceneUrl, version);
  const { data: items, error: diagError, loading: diagLoading } = useApi(book ? `/api/books/${encodeURIComponent(bookId)}/diagnostics` : null, version);

  if (loading) return <main id="main" tabIndex={-1} className="page muted">Loading...</main>;
  if (error) return <main id="main" tabIndex={-1} className="page error">{error}</main>;
  if (!book) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  const chapter = book.acts.flatMap((a) => a.chapters).find((c) => c.scenes.some((s) => s.id === activeId));
  const chapterLabel = chapter ? (chapter.title ? `${chapter.label}: ${chapter.title}` : chapter.label) : null;

  let main;
  if (file) main = <RawFile bookId={book.id} file={file} version={version} />;
  else if (activeId === null) {
    main = (
      <>
        <h1>{book.title ?? book.slug ?? book.id}</h1>
        <p className="muted">This book has no scenes in its manuscript.</p>
      </>
    );
  } else if (sceneLoading) main = <p className="muted">Loading...</p>;
  else if (sceneError) main = <p className="error">{sceneError}</p>;
  else if (!scene) main = <p className="muted">Scene not found.</p>;
  else main = <ScenePaper key={scene.id} book={book} scene={scene} chapterLabel={chapterLabel} />;

  return (
    <BookLayout
      book={book}
      activeId={file ? null : activeId}
      inspector={<SceneInspector book={book} scene={file ? null : scene} diagnostics={{ items, error: diagError, loading: diagLoading }} />}
    >
      {main}
    </BookLayout>
  );
}
