import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api.js';
import { useEditorBridge } from '../editor/bridge.jsx';
import { CompareView } from '../editor/ConflictPanel.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { InspectorSection } from '../shell/InspectorSection.jsx';
import { bookUrl, send } from '../structure/helpers.js';
import { SAFETY_NOTE, newestFirst, revisionSummary, whenLabel } from './revisions.js';
import { useWriting } from './WritingContext.jsx';

const sceneUrl = (bookId, sceneId, tail = '') => bookUrl(bookId, `/scenes/${encodeURIComponent(sceneId)}${tail}`);

const failure = (status, json) =>
  status === 409
    ? 'The scene changed since you looked, so nothing was written. Close this and try again.'
    : status === 0
      ? 'The server could not be reached.'
      : (json?.message ?? `That did not work (${json?.code ?? json?.error ?? status}).`);

/** Save the open scene first, so the file on disk is what the author sees. Returns an error sentence, or null. */
async function saveFirst(handle) {
  if (!handle) return null;
  const { saved } = await handle.flush();
  return saved ? null : 'The scene has text that could not be saved yet. Save it first.';
}

function SaveDialog({ bookId, sceneId, onClose, onDone }) {
  const bridge = useEditorBridge();
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await saveFirst(bridge.current());
    if (problem) {
      setError(problem);
      setBusy(false);
      return;
    }
    const { status, json } = await send(sceneUrl(bookId, sceneId, '/revisions'), label.trim() === '' ? {} : { label: label.trim() });
    setBusy(false);
    if (status === 200 || status === 201) {
      onDone(json?.stored === false ? 'Nothing changed since the latest revision, so no new one was added.' : 'Revision saved.');
      onClose();
    } else setError(failure(status, json));
  };
  return (
    <Dialog label="Save a revision" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Save a revision</h2>
        <div className="field">
          <label htmlFor="revision-label">Label (optional)</label>
          <input id="revision-label" type="text" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Before the rewrite" />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save revision
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CompareDialog({ bookId, sceneId, rev, onClose }) {
  const bridge = useEditorBridge();
  const { data, error, loading } = useApi(sceneUrl(bookId, sceneId, `/revisions/${encodeURIComponent(rev.file)}`));
  const current = bridge.current()?.text?.() ?? null;
  return (
    <Dialog label="Compare a revision" onClose={onClose} className="dialog-wide">
      <h2>Compare</h2>
      <p className="muted">{revisionSummary(rev)}. Left: that revision. Right: the scene as it is now.</p>
      {loading && <p className="muted">Reading the revision…</p>}
      {error && <p className="error">{error}</p>}
      {data && current !== null && <CompareView mine={data.body} theirs={current} leftLabel="Revision" rightLabel="Now" />}
      {data && current === null && <p className="muted">Open the scene in the editor to compare.</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function RestoreDialog({ bookId, sceneId, rev, onClose, onRestored }) {
  const bridge = useEditorBridge();
  const [mode, setMode] = useState('into');
  const [state, setState] = useState({ phase: 'loading', preview: null, error: null });
  const [base, setBase] = useState(null);

  /** Save the scene, then ask the server what restoring in this mode would do (nothing is written). */
  const preview = useCallback(
    async (nextMode) => {
      const handle = bridge.current();
      const problem = await saveFirst(handle);
      if (problem) return { sha: null, state: { phase: 'error', preview: null, error: problem } };
      const sha = handle?.baseSha?.() ?? null;
      const { status, json } = await send(sceneUrl(bookId, sceneId, `/revisions/${encodeURIComponent(rev.file)}/restore`), { mode: nextMode, ...(sha ? { base_sha256: sha } : {}), dryRun: true });
      return { sha, state: status === 200 ? { phase: 'ready', preview: json, error: null } : { phase: 'error', preview: null, error: failure(status, json) } };
    },
    [bridge, bookId, sceneId, rev.file],
  );
  const apply = (r) => {
    setBase(r.sha);
    setState(r.state);
  };

  // the preview of the default choice, as soon as the dialog opens
  useEffect(() => {
    let cancelled = false;
    preview('into').then((r) => {
      if (!cancelled) {
        setBase(r.sha);
        setState(r.state);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  function choose(nextMode) {
    setMode(nextMode);
    setState({ phase: 'loading', preview: null, error: null });
    void preview(nextMode).then(apply);
  }

  async function confirm() {
    setState((s) => ({ ...s, phase: 'working' }));
    const handle = bridge.current();
    const { status, json } = await send(sceneUrl(bookId, sceneId, `/revisions/${encodeURIComponent(rev.file)}/restore`), { mode, ...(base ? { base_sha256: base } : {}) });
    if (status === 200 || status === 201) {
      if (mode === 'into') await handle?.reload?.();
      onRestored(mode, json);
      onClose();
    } else setState({ phase: 'error', preview: state.preview, error: failure(status, json) });
  }

  const p = state.preview;
  return (
    <Dialog label="Restore a revision" onClose={onClose} className="dialog-wide">
      <h2>Restore a revision</h2>
      <p className="muted">{revisionSummary(rev)}</p>
      <fieldset className="restore-choice">
        <legend>How to restore</legend>
        <label>
          <input type="radio" name="restore-mode" checked={mode === 'into'} onChange={() => choose('into')} /> Restore into this scene
        </label>
        <label>
          <input type="radio" name="restore-mode" checked={mode === 'new'} onChange={() => choose('new')} /> Restore as a new scene
        </label>
      </fieldset>
      {state.phase === 'loading' && <p className="muted">Checking…</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {p && mode === 'into' && (
        <div className="restore-preview">
          <p>
            The text of this scene will be replaced by the revision&apos;s text. The scene as it is now is saved as a revision first, so nothing is lost.
            {!p.body_differs && ' The text is already the same as that revision.'}
          </p>
          {p.front_matter_differs && (
            <>
              <p>The revision had different front matter. Yours stays as it is now; this is what the revision had:</p>
              <pre className="scene-text">{p.front_matter?.revision}</pre>
            </>
          )}
        </div>
      )}
      {p && mode === 'new' && (
        <div className="restore-preview">
          <p>
            A new scene called &ldquo;{p.title}&rdquo; is added right after this one, with the revision&apos;s text. This scene is not touched.
          </p>
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={state.phase !== 'ready'} onClick={confirm}>
          {mode === 'new' ? 'Restore as a new scene' : 'Restore into this scene'}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * The Revisions section: local safety copies of this scene, newest first, with "Save a revision", Compare and Restore (both
 * show what will happen first). Restoring never erases the current version: it becomes the newest revision.
 * @param {{ bookId: string, sceneId: string, onChanged?: () => void }} props
 */
export function Revisions({ bookId, sceneId, onChanged }) {
  const { revisionTick, bumpRevisions } = useWriting();
  const { data, error, loading } = useApi(sceneUrl(bookId, sceneId, '/revisions'), String(revisionTick));
  const [dialog, setDialog] = useState(null);
  const [message, setMessage] = useState(null);
  const [opened, setOpened] = useState(null);
  const list = newestFirst(Array.isArray(data) ? data : []);
  const close = () => setDialog(null);
  return (
    <InspectorSection title="Revisions">
      <p className="muted revisions-note">{SAFETY_NOTE}</p>
      <button type="button" className="btn" onClick={() => setDialog({ type: 'save' })}>
        Save a revision
      </button>
      {message && (
        <p className="revisions-message" role="status">
          {message}
          {opened && (
            <>
              {' '}
              <a href={`/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(opened)}`}>Open it</a>
            </>
          )}
        </p>
      )}
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && list.length === 0 && <p className="muted">No revisions yet. One is saved automatically when you start writing.</p>}
      {list.length > 0 && (
        <ul className="revision-list">
          {list.map((r) => (
            <li key={r.file} className="revision-item">
              <p className="revision-line">{revisionSummary(r)}</p>
              {r.label && <p className="revision-label">{r.label}</p>}
              <span className="revision-actions">
                <button type="button" className="btn row-button" aria-label={`Compare the revision from ${whenLabel(r.at)}`} onClick={() => setDialog({ type: 'compare', rev: r })}>
                  Compare
                </button>
                <button type="button" className="btn row-button" aria-label={`Restore the revision from ${whenLabel(r.at)}`} onClick={() => setDialog({ type: 'restore', rev: r })}>
                  Restore…
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dialog?.type === 'save' && (
        <SaveDialog
          bookId={bookId}
          sceneId={sceneId}
          onClose={close}
          onDone={(text) => {
            setMessage(text);
            setOpened(null);
            bumpRevisions();
          }}
        />
      )}
      {dialog?.type === 'compare' && <CompareDialog bookId={bookId} sceneId={sceneId} rev={dialog.rev} onClose={close} />}
      {dialog?.type === 'restore' && (
        <RestoreDialog
          bookId={bookId}
          sceneId={sceneId}
          rev={dialog.rev}
          onClose={close}
          onRestored={(mode, json) => {
            setMessage(mode === 'into' ? 'Restored. The version you had is saved as a revision.' : `Saved as a new scene, "${json?.title ?? 'revision'}".`);
            setOpened(mode === 'new' ? (json?.id ?? null) : null);
            bumpRevisions();
            if (mode === 'new') onChanged?.();
          }}
        />
      )}
    </InspectorSection>
  );
}
