import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { InteriorControls } from './InteriorControls.jsx';
import { InteriorReport } from './InteriorReport.jsx';
import { DEBOUNCE_MS, EXPERIMENTAL_NOTE, LAYOUT_TIMEOUT_MS, POLL_MS, createSnapshot, interiorUrls, layoutOf, layoutProblems, patchOf, readFingerprint, saveLayout, statusLine, summaryFrom } from './requests.js';

/**
 * The page itself, without any behaviour: the controls on the left, the preview, its status line and the Report on the right. Every state of the page is a set of props.
 * @param {{
 *   bookId: string, layout: Record<string, any> | null, onChange?: (patch: Record<string, any>) => void, problems?: { field: string, message: string }[],
 *   phase: 'loading' | 'idle' | 'creating' | 'laying-out' | 'done' | 'failed', snapshot?: { snapshotId: string, report: any } | null,
 *   summary?: any, outOfDate?: boolean, error?: string | null, saveNote?: string | null, onRefresh?: () => void, frameRef?: import('react').Ref<HTMLIFrameElement>, previewSrc?: string | null
 * }} props
 */
export function InteriorScreen({ bookId, layout, onChange = () => {}, problems = [], phase, snapshot = null, summary = null, outOfDate = false, error = null, saveNote = null, onRefresh = () => {}, frameRef, previewSrc = null }) {
  const busy = phase === 'creating' || phase === 'loading';
  return (
    <main id="main" tabIndex={-1} className="page interior-page">
      <header className="interior-header">
        <h1>Book interior</h1>
        <p className="secondary">
          <Link to={`/books/${encodeURIComponent(bookId)}`}>Back to the manuscript</Link>
        </p>
      </header>
      <p role="note" className="export-warning interior-note">
        {EXPERIMENTAL_NOTE}
      </p>
      <p className="secondary interior-narrow-note">This page is made for a wide screen. The settings and the preview sit side by side there.</p>
      <div className="interior-layout">
        <div className="interior-side">
          {layout ? <InteriorControls layout={layout} onChange={onChange} problems={problems} /> : <p role="status" className="muted">Loading&hellip;</p>}
          {saveNote && (
            <p role="status" className="secondary interior-save-note">
              {saveNote}
            </p>
          )}
        </div>
        <div className="interior-main">
          <div className="interior-toolbar">
            <button type="button" className="btn btn-primary" disabled={busy || layout === null || problems.length > 0} onClick={onRefresh}>
              Refresh preview
            </button>
            <p role="status" className="interior-status" data-phase={phase}>
              {statusLine({ phase, summary, error })}
            </p>
          </div>
          {outOfDate && (
            <p role="status" className="banner banner-warning interior-stale">
              Preview out of date. Choose Refresh preview to lay the book out again.
            </p>
          )}
          {error && phase !== 'failed' && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {snapshot && previewSrc ? (
            <iframe key={snapshot.snapshotId} ref={frameRef} className="interior-frame" title="Book interior preview" src={previewSrc} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
          ) : (
            <div className="interior-frame interior-frame-empty" />
          )}
          <InteriorReport bookId={bookId} report={snapshot?.report ?? null} summary={summary} />
        </div>
      </div>
    </main>
  );
}

/**
 * /books/:id/interior (M13-J05 section 6): reads the book's effective settings, saves changes through the layout route 800 ms after the last one, makes a snapshot on Refresh preview, shows
 * it in a sandboxed frame, listens for the layout summary the frame posts (only from that frame, same origin), and asks for the fingerprint every 5 s while the page is visible and after
 * every save to say when the preview is out of date.
 * @param {{ bookId: string }} props
 */
export function InteriorView({ bookId }) {
  const prefs = useApi(interiorUrls(bookId).preferences);
  const [layout, setLayout] = useState(/** @type {Record<string, any> | null} */ (null));
  const [snapshot, setSnapshot] = useState(/** @type {{ snapshotId: string, fingerprint: string, report: any } | null} */ (null));
  const [phase, setPhase] = useState(/** @type {'loading' | 'idle' | 'creating' | 'laying-out' | 'done' | 'failed'} */ ('loading'));
  const [summary, setSummary] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [saveNote, setSaveNote] = useState(/** @type {string | null} */ (null));
  const [current, setCurrent] = useState(/** @type {string | null} */ (null));
  const saved = useRef(/** @type {Record<string, any> | null} */ (null));
  const latest = useRef(/** @type {Record<string, any> | null} */ (null));
  const timer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const pending = useRef(/** @type {Promise<boolean>} */ (Promise.resolve(true)));
  const frameRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // the book's own settings, once
  useEffect(() => {
    if (prefs.data === null && prefs.loading) return;
    if (saved.current !== null) return;
    const first = layoutOf(prefs.data);
    saved.current = first;
    latest.current = first;
    setLayout(first);
    setPhase('idle');
  }, [prefs.data, prefs.loading]);

  const checkFingerprint = useCallback(async () => {
    const fp = await readFingerprint(bookId);
    if (alive.current && fp !== null) setCurrent(fp);
  }, [bookId]);

  /** Save what changed (if all the numbers are valid). Resolves true when nothing is left unsaved. */
  const save = useCallback(async () => {
    timer.current = null;
    const now = latest.current;
    if (!now || !saved.current || layoutProblems(now).length > 0) return false;
    const patch = patchOf(now, saved.current);
    if (Object.keys(patch).length === 0) return true;
    setSaveNote('Saving…');
    const r = await saveLayout(bookId, patch);
    if (!alive.current) return false;
    if (!r.ok) {
      setSaveNote(`Not saved. ${r.message}`);
      return false;
    }
    saved.current = { ...saved.current, ...patch };
    setSaveNote('Saved.');
    void checkFingerprint();
    return JSON.stringify(patchOf(latest.current ?? now, saved.current)) === '{}';
  }, [bookId, checkFingerprint]);

  const change = useCallback(
    (/** @type {Record<string, any>} */ patch) => {
      latest.current = { ...latest.current, ...patch };
      setLayout(latest.current);
      setSaveNote(null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        pending.current = save();
      }, DEBOUNCE_MS);
    },
    [save],
  );

  const refresh = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      pending.current = save();
    }
    setError(null);
    setPhase('creating');
    if (!(await pending.current)) {
      if (alive.current) {
        setPhase(snapshot ? 'done' : 'idle');
        setError('The settings could not be saved, so the preview was not refreshed.');
      }
      return;
    }
    const r = await createSnapshot(bookId);
    if (!alive.current) return;
    if (!r.ok) {
      setError(r.message);
      setPhase(snapshot ? (summary?.state === 'failed' ? 'failed' : 'done') : 'idle');
      return;
    }
    setSummary(null);
    setSnapshot({ snapshotId: r.snapshotId, fingerprint: r.fingerprint, report: r.report });
    setCurrent(r.fingerprint);
    setPhase('laying-out');
  }, [bookId, save, snapshot, summary]);

  // the frame says when it has laid the pages out (or failed): only its own window, only this origin
  useEffect(() => {
    const onMessage = (/** @type {MessageEvent} */ e) => {
      const s = summaryFrom(e, frameRef.current?.contentWindow ?? null, window.location.origin);
      if (!s) return;
      setSummary(s);
      setPhase(s.state === 'done' ? 'done' : 'failed');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // a frame that never reports (paged.js blocked, a browser problem) must not leave "Laying out pages…" forever
  useEffect(() => {
    if (phase !== 'laying-out') return undefined;
    const id = setTimeout(() => {
      if (!alive.current) return;
      setError('The pages were not laid out within 3 minutes. Try Refresh preview.');
      setPhase('failed');
    }, LAYOUT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [phase, snapshot]);

  // out of date: ask every 5 s while the page is visible
  useEffect(() => {
    if (!snapshot) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') void checkFingerprint();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [snapshot, checkFingerprint]);

  const problems = layout ? layoutProblems(layout) : [];
  return (
    <InteriorScreen
      bookId={bookId}
      layout={layout}
      onChange={change}
      problems={problems}
      phase={phase}
      snapshot={snapshot}
      summary={summary}
      outOfDate={snapshot !== null && current !== null && current !== snapshot.fingerprint}
      error={error ?? (prefs.error ? 'The settings could not be read from the server.' : null)}
      saveNote={saveNote}
      onRefresh={refresh}
      frameRef={frameRef}
      previewSrc={snapshot ? interiorUrls(bookId).preview(snapshot.snapshotId) : null}
    />
  );
}
