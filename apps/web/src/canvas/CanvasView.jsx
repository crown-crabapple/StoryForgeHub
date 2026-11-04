// /books/:id/canvas (M09-J01): the list of canvases and the open one. Loads the canvas, keeps the undo history, and saves every change on its own
// (debounced, guarded by the sha256 last seen; a 409 shows the conflict banner).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../api.js';
import { Dialog } from '../shell/Dialog.jsx';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { CanvasBoard } from './CanvasBoard.jsx';
import { canvasHref, canvasUrl, history, parseCanvasSearch, record, redo, undo } from './model.js';
import { archiveCanvas, createCanvas, explainCanvasFailure, restoreCanvas, saveCanvas, uploadCanvasImage } from './requests.js';

const enc = encodeURIComponent;
export const SAVE_DELAY_MS = 800;

/** @param {{ bookId: string, search?: string }} props */
export function CanvasView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const { data: list, error, loading } = useApi(`/api/books/${enc(bookId)}/canvases`, version);
  const { canvas: wanted } = parseCanvasSearch(search);
  const canvases = list?.canvases ?? [];
  const slug = wanted && canvases.some((c) => c.slug === wanted) ? wanted : (canvases[0]?.slug ?? null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState(null);

  async function archive(c) {
    const r = await archiveCanvas(bookId, c.slug, c.sha256);
    if (r.status !== 200) return setProblem(explainCanvasFailure(r.status, r.json));
    setBump((n) => n + 1);
    navigate(canvasHref(bookId));
  }
  async function restore(c) {
    const r = await restoreCanvas(bookId, c.slug);
    if (r.status !== 200) return setProblem(explainCanvasFailure(r.status, r.json));
    setBump((n) => n + 1);
    navigate(canvasHref(bookId, c.slug));
  }

  if (loading && !list) {
    return (
      <main id="main" tabIndex={-1} className="page muted">
        Loading…
      </main>
    );
  }
  if (error) {
    return (
      <main id="main" tabIndex={-1} className="page error">
        {error}
      </main>
    );
  }
  if (!list) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  return (
    <main id="main" tabIndex={-1} className="cv-page">
      <CanvasPage
        bookId={bookId}
        list={list}
        slug={slug}
        problem={problem}
        onDismiss={() => setProblem(null)}
        onNew={() => setCreating(true)}
        onArchive={archive}
        onRestore={restore}
        onSaved={() => setBump((n) => n + 1)}
      />
      {creating && (
        <NewCanvasDialog
          onClose={() => setCreating(false)}
          onSubmit={async (title) => {
            const r = await createCanvas(bookId, { title });
            if (r.status !== 201) return { error: explainCanvasFailure(r.status, r.json) };
            setCreating(false);
            setBump((n) => n + 1);
            navigate(canvasHref(bookId, r.json.slug));
            return null;
          }}
        />
      )}
    </main>
  );
}

/**
 * The page without fetching the list (render tests use it with a fixed list): the side list and the open canvas.
 * @param {{ bookId: string, list: { canvases: any[], archived: any[] }, slug: string | null, problem?: string | null, onDismiss?: () => void, onNew: () => void,
 *   onArchive: (c: any) => void, onRestore: (c: any) => void, onSaved?: () => void, initial?: any }} props  `initial` (tests): the open canvas instead of fetching it
 */
export function CanvasPage({ bookId, list, slug, problem = null, onDismiss = () => {}, onNew, onArchive, onRestore, onSaved = () => {}, initial = null }) {
  const open = list.canvases.find((c) => c.slug === slug) ?? null;
  return (
    <div className="cv-layout">
      <aside className="cv-list" aria-label="Canvases">
        <div className="cv-list-head">
          <h1>Canvas</h1>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            New canvas
          </button>
        </div>
        {list.canvases.length === 0 ? (
          <p className="muted">No canvases yet. A canvas is a board for mood images, colour palettes, notes and cards for your characters and scenes. It is saved as a file in planning/canvases/.</p>
        ) : (
          <ul>
            {list.canvases.map((c) => (
              <li key={c.slug}>
                <Link to={canvasHref(bookId, c.slug)} aria-current={c.slug === slug ? 'page' : undefined} className="cv-list-item">
                  <span>{c.title}</span>
                  <span className="muted">{c.problem ? 'cannot be read' : `${c.nodes} ${c.nodes === 1 ? 'card' : 'cards'}`}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {list.archived.length > 0 && (
          <details className="cv-archived">
            <summary>Archived ({list.archived.length})</summary>
            <ul>
              {list.archived.map((c) => (
                <li key={c.slug}>
                  <span>{c.title}</span>
                  <button type="button" className="btn" onClick={() => onRestore(c)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        {problem && (
          <div className="error cv-problem" role="alert">
            <p>{problem}</p>
            <button type="button" className="btn" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        )}
      </aside>
      <section className="cv-main" aria-label={open ? `Canvas ${open.title}` : 'Canvas'}>
        {open ? (
          <OpenCanvas key={open.slug} bookId={bookId} summary={open} onArchive={() => onArchive(open)} onSaved={onSaved} initial={initial} />
        ) : (
          <div className="cv-none">
            <h2>Start a canvas</h2>
            <p className="muted">Pin up mood images, build a colour palette, sketch a plot with arrows, or lay out a cast wall with live cards from your Codex.</p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              New canvas
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/** One canvas: fetch, history, autosave, conflict banner. */
function OpenCanvas({ bookId, summary, onArchive, onSaved, initial }) {
  const { data, error } = useApi(initial ? null : canvasUrl(bookId, summary.slug), '');
  const loaded = initial ?? data;
  if (error) return <p className="error">{error}</p>;
  if (!loaded) return <p className="muted cv-loading">Loading…</p>;
  return <Editor key={loaded.sha256} bookId={bookId} loaded={loaded} onArchive={onArchive} onSaved={onSaved} />;
}

function Editor({ bookId, loaded, onArchive, onSaved }) {
  const { track } = useWrites();
  const [hist, setHist] = useState(() => history(loaded.canvas));
  const [live, setLive] = useState(null);
  const [save, setSave] = useState({ state: 'saved', sha: loaded.sha256, message: null });
  const [conflict, setConflict] = useState(null);
  const [problem, setProblem] = useState(null);
  const refs = loaded.refs ?? {};
  const saved = useRef(loaded.canvas);
  const shaRef = useRef(loaded.sha256);
  const timer = useRef(null);
  const readOnly = loaded.problem !== null && loaded.problem !== undefined;
  const doc = live ?? hist.present;

  const flush = useCallback(
    async (canvas, sha = shaRef.current) => {
      clearTimeout(timer.current);
      setSave((s) => ({ ...s, state: 'saving', message: null }));
      const r = await track(bookId, () => saveCanvas(bookId, loaded.slug, canvas, sha));
      if (r.status === 200) {
        shaRef.current = r.json.sha256;
        saved.current = canvas;
        setSave({ state: 'saved', sha: r.json.sha256, message: null });
        onSaved();
      } else if (r.status === 409) {
        setConflict(r.json?.current ?? null);
        setSave((s) => ({ ...s, state: 'conflict', message: null }));
      } else setSave((s) => ({ ...s, state: 'error', message: explainCanvasFailure(r.status, r.json) }));
    },
    [bookId, loaded.slug, track, onSaved],
  );

  // every committed change saves itself after a short pause
  useEffect(() => {
    if (readOnly || conflict || hist.present === saved.current) return undefined;
    setSave((s) => (s.state === 'saving' ? s : { ...s, state: 'pending' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(hist.present), SAVE_DELAY_MS);
    return () => clearTimeout(timer.current);
  }, [hist.present, readOnly, conflict, flush]);

  // leaving the page with a change not yet sent: send it now
  const latest = useRef(hist.present);
  useEffect(() => {
    latest.current = hist.present;
  });
  useEffect(
    () => () => {
      if (latest.current !== saved.current && !readOnly) saveCanvas(bookId, loaded.slug, latest.current, shaRef.current);
    },
    [bookId, loaded.slug, readOnly],
  );

  const onChange = useCallback((next, { commit = true } = {}) => {
    if (!commit) return setLive(next);
    setLive(null);
    setHist((h) => record(h, next));
  }, []);

  const title = doc?.storyforge?.title ?? loaded.title;
  const setTitle = (t) => onChange({ ...hist.present, storyforge: { schema: 'storyforge.canvas/v1', ...(hist.present.storyforge ?? {}), title: t } });

  return (
    <div className="cv-editor">
      <header className="cv-bar">
        <TitleField key={title} value={title} disabled={readOnly} onCommit={(t) => t.trim() && t !== title && setTitle(t.trim())} />
        <p className="cv-file muted">{loaded.path}</p>
        <SaveLine save={save} onRetry={() => flush(hist.present)} />
        <button type="button" className="btn" onClick={onArchive}>
          Archive
        </button>
      </header>
      {readOnly && (
        <p className="warning cv-banner" role="alert">
          This file cannot be read as a canvas ({loaded.problem}). It is shown read-only; fix the file in a text editor.
        </p>
      )}
      {conflict && (
        <div className="warning cv-banner" role="alert">
          <p>This canvas changed on disk since you opened it (another window, another person or a text editor).</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (conflict.canvas) {
                shaRef.current = conflict.sha256;
                saved.current = conflict.canvas;
                setHist(history(conflict.canvas));
                setLive(null);
                setSave({ state: 'saved', sha: conflict.sha256, message: null });
              }
              setConflict(null);
            }}
            disabled={!conflict.canvas}
          >
            Load the file
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const sha = conflict.sha256;
              shaRef.current = sha;
              setConflict(null);
              flush(hist.present, sha);
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {problem && (
        <div className="error cv-banner" role="alert">
          <p>{problem}</p>
          <button type="button" className="btn" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      )}
      <CanvasBoard
        bookId={bookId}
        doc={doc}
        refs={refs}
        targets={loaded.targets ?? []}
        readOnly={readOnly}
        fitKey={loaded.slug}
        onChange={onChange}
        onUndo={() => {
          setLive(null);
          setHist(undo);
        }}
        onRedo={() => {
          setLive(null);
          setHist(redo);
        }}
        onUploadImage={(file) => track(bookId, () => uploadCanvasImage(bookId, file).then((r) => ({ ...r, status: r.ok ? 201 : 400 })))}
        onProblem={setProblem}
      />
    </div>
  );
}

function TitleField({ value, disabled, onCommit }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="cv-title"
      aria-label="Canvas title"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setV(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const SAVE_TEXT = { saved: 'Saved', pending: 'Not saved yet', saving: 'Saving…', conflict: 'Not saved: changed on disk', error: 'Not saved' };
function SaveLine({ save, onRetry }) {
  return (
    <p className={`cv-save cv-save-${save.state}`} role="status" aria-live="polite">
      {SAVE_TEXT[save.state]}
      {save.state === 'error' && (
        <>
          {save.message ? ` (${save.message})` : ''}{' '}
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </p>
  );
}

function NewCanvasDialog({ onSubmit, onClose }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog label="New canvas" onClose={onClose}>
      <h2>New canvas</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (title.trim() === '') return setError('Give it a title.');
          setBusy(true);
          const r = await onSubmit(title.trim());
          setBusy(false);
          if (r?.error) setError(r.error);
          return undefined;
        }}
      >
        <div className="form-row">
          <label>
            <span className="form-label">Title</span>
            <input type="text" name="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <p className="muted form-hint">Saved as planning/canvases/&lt;name&gt;.canvas, a JSON Canvas file that Obsidian can open too.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
