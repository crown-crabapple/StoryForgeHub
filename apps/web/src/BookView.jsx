import { useState } from 'react';
import { postJson, useApi } from './api.js';
import { ProseView } from './ProseView.jsx';
import { Outline } from './Outline.jsx';
import { AiProvider, useAi } from './ai/AiContext.jsx';
import { EditorBridgeProvider, useEditorBridge } from './editor/bridge.jsx';
import { SceneEditorPage } from './editor/SceneEditorPage.jsx';
import { parseView } from './planning/model.js';
import { noticeText, parseSelect } from './tasks/model.js';
import { PlanningWorkspace, ViewSwitch } from './planning/PlanningWorkspace.jsx';
import { Link, useLocation } from './router.jsx';
import { SceneInspector } from './shell/Inspector.jsx';
import { Workspace } from './shell/Workspace.jsx';
import { useWrites } from './shell/writes.jsx';
import { bookVersion, useStatus } from './status.jsx';
import { WritingProvider } from './writing/WritingContext.jsx';

/** Archives the scene. If the scene is open in the editor it is saved first, and the file's current hash is used as the base. */
export function ArchiveButton({ bookId, scene }) {
  const { track } = useWrites();
  const bridge = useEditorBridge();
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  async function archive() {
    if (!window.confirm(`Archive "${scene.title}"? The file moves to the archive folder; nothing is deleted.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const open = bridge.current();
      if (open && open.sceneId === scene.id) {
        const { saved } = await open.flush();
        if (!saved) {
          setMessage('Not archived: the scene has changes that could not be saved yet.');
          setBusy(false);
          return;
        }
      }
      const url = `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(scene.id)}`;
      const fresh = await fetch(url, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null), () => null);
      const { status } = await track(bookId, () => postJson(`${url}/archive`, { base_sha256: fresh?.sha256 ?? scene.sha256 }));
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

/** "AI workshop" in the book header: drawn only when the book has an active AI provider (Settings, Set up AI). */
function AiWorkshopButton() {
  const ai = useAi();
  if (!ai.available) return null;
  return (
    <p className="ai-header-button">
      <button type="button" className="btn" aria-pressed={ai.open} onClick={ai.toggle}>
        AI workshop
      </button>
    </p>
  );
}

export { Outline };

/** Three-column book page: outline rail, main column, inspector. `onChanged` runs after a structure command wrote. */
export function BookLayout({ book, activeId, inspector, onChanged, children }) {
  return (
    <EditorBridgeProvider>
      <AiProvider key={book.id} book={book}>
        <WritingProvider key={book.id} bookId={book.id}>
          <InvalidBanner book={book} />
          <Workspace rail={<Outline key={book.id} book={book} activeId={activeId} onChanged={onChanged} />} inspector={inspector}>
            <AiWorkshopButton />
            {children}
          </Workspace>
        </WritingProvider>
      </AiProvider>
    </EditorBridgeProvider>
  );
}

export function BookView({ bookId, sceneId, file }) {
  const { status } = useStatus();
  const { search } = useLocation();
  const { view, mode, thread: threadId } = parseView(search);
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const { data: book, error, loading } = useApi(`/api/books/${encodeURIComponent(bookId)}`, version);
  const allScenes = book ? book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)) : [];
  const activeId = sceneId && allScenes.some((s) => s.id === sceneId) ? sceneId : (allScenes[0]?.id ?? null);
  const showScene = Boolean(book) && !file && activeId !== null;
  const sceneUrl = showScene ? `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(activeId)}` : null;
  const { data: scene, error: sceneError, loading: sceneLoading } = useApi(sceneUrl, version);
  const { data: items, error: diagError, loading: diagLoading } = useApi(book ? `/api/books/${encodeURIComponent(bookId)}/diagnostics` : null, version);
  const { data: objects } = useApi(book ? `/api/books/${encodeURIComponent(bookId)}/objects?kinds=entry,thread,event` : null, version);
  // M04-J03: the threads with their scene lists and the scenes' summaries (the Board, Outline, Threads and Matrix views and the rail's thread marks)
  const { data: planning } = useApi(book ? `/api/books/${encodeURIComponent(bookId)}/threads` : null, version);
  // M04-J04: the events and research notes the editor rail shows for the open scene (they refresh with the status poll, like everything else)
  const { data: timeline } = useApi(showScene ? `/api/books/${encodeURIComponent(bookId)}/timeline` : null, version);
  const { data: notes } = useApi(showScene ? `/api/books/${encodeURIComponent(bookId)}/notes` : null, version);
  // M05-J02: the continuity findings the rail's Continuity section lists (refreshed by the status poll and after every save, like the rest of the rail)
  const { data: continuity } = useApi(showScene ? `/api/books/${encodeURIComponent(bookId)}/continuity` : null, version);

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
  const onChanged = () => setBump((n) => n + 1);
  if (view !== 'write' && !file) {
    return (
      <PlanningWorkspace
        book={book}
        planning={planning ?? null}
        objects={objects}
        view={view}
        mode={mode}
        threadId={threadId}
        outlineFilters={{ status: new URLSearchParams(search).get('status') ?? '' }}
        version={version}
        onChanged={onChanged}
        fallbackInspector={<SceneInspector book={book} scene={null} diagnostics={{ items, error: diagError, loading: diagLoading }} objects={objects} onChanged={onChanged} />}
        render={({ main, inspector }) => (
          <BookLayout book={book} activeId={null} onChanged={onChanged} inspector={inspector}>
            {main}
          </BookLayout>
        )}
      />
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
  else if (scene.problem || scene.raw) main = <ScenePaper key={scene.id} book={book} scene={scene} chapterLabel={chapterLabel} />;
  else {
    main = (
      <SceneEditorPage
        key={scene.id}
        book={book}
        scene={scene}
        chapterLabel={chapterLabel}
        objects={objects}
        initialLine={/^[1-9][0-9]{0,6}$/.test(new URLSearchParams(search).get('line') ?? '') ? Number(new URLSearchParams(search).get('line')) : null}
        initialSelection={parseSelect(search)}
        footerExtra={<ArchiveButton bookId={book.id} scene={scene} />}
        onStructureChanged={() => setBump((n) => n + 1)}
      />
    );
  }

  return (
    <BookLayout
      book={book}
      activeId={file ? null : activeId}
      onChanged={() => setBump((n) => n + 1)}
      inspector={<SceneInspector book={book} scene={file ? null : scene} diagnostics={{ items, error: diagError, loading: diagLoading }} objects={objects} planning={planning ?? null} timeline={timeline ?? null} notes={notes ?? null} continuity={continuity ?? null} version={version} onChanged={() => setBump((n) => n + 1)} />}
    >
      {!file && <ViewSwitch bookId={book.id} view="write" scene={activeId} />}
      {noticeText(search) && (
        <p className="muted" role="status">
          {noticeText(search)}
        </p>
      )}
      {main}
    </BookLayout>
  );
}
