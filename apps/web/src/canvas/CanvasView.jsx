// /books/:id/plan (M09-J01, the Plan tab since M10): the list of canvases and the open one. Loads the canvas, keeps the undo history, and saves every change on its own
// (debounced, guarded by the sha256 last seen; a 409 shows the conflict banner).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../api.js';
import { abilities } from '../collab/model.js';
import { useSession } from '../shared/session.jsx';
import { useModule } from '../prefs/PrefsContext.jsx';
import { Dialog } from '../shell/Dialog.jsx';
import { Link, useNavigate } from '../router.jsx';
import { SeriesDrawer } from './plan/SeriesDrawer.jsx';
import { seriesPlanUrl } from '../planner/series.js';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { useClueWrites } from '../planner/useClueWrites.js';
import { useStructureWrites } from '../planner/useStructureWrites.js';
import { useStructure } from '../structure/useStructure.jsx';
import { CanvasBoard } from './CanvasBoard.jsx';
import { canvasHref, canvasUrl, history, parseCanvasSearch, record, redo, undo } from './model.js';
import { buildPlanCanvas } from './plan/build.js';
import { legacyPlanTarget, resolvePlanTarget } from './plan/deepLink.js';
import { Inspector, InspectorHint } from './plan/Inspector.jsx';
import { buildPlanList, locateListItem } from './plan/listModel.js';
import { PlanList } from './plan/PlanList.jsx';
import { PlanDrawer } from './plan/PlanDrawer.jsx';
import { PlanRail } from './plan/PlanRail.jsx';
import { canvasRefIds, chooseCanvas, findingOnCanvas, findingRefIds, loadLastCanvas, loadLayers, loadViewMode, saveLastCanvas, saveLayers, saveViewMode } from './plan/selectors.js';
import { usePlanData } from './plan/usePlanData.js';
import { useCanvasLinks } from './useCanvasLinks.js';
import { archiveCanvas, createCanvas, explainCanvasFailure, restoreCanvas, saveCanvas, uploadCanvasImage } from './requests.js';

const enc = encodeURIComponent;
export const SAVE_DELAY_MS = 800;
const noop = () => {};

/** @param {{ bookId: string, search?: string }} props */
export function CanvasView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const { data: list, error, loading } = useApi(`/api/books/${enc(bookId)}/canvases`, version);
  const { canvas: wanted } = parseCanvasSearch(search);
  const canvases = list?.canvases ?? [];
  const boardOn = useModule('board');
  const plannerTabOn = useModule('planner'); // M10: the Plan page needs the board or the planner
  // the canvas the address asks for, else the one opened last in this book (kept in localStorage), else the first
  const slug = chooseCanvas(canvases, wanted, loadLastCanvas(bookId));
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (slug) saveLastCanvas(bookId, slug);
  }, [bookId, slug]);

  /** The "Build your plan canvas" button: create story-plan, lay the plan out on it, open it. Returns a sentence when it failed. */
  async function buildPlan(plan) {
    const made = await createCanvas(bookId, { title: 'Story plan', slug: 'story-plan' });
    if (made.status !== 201) return explainCanvasFailure(made.status, made.json);
    const madeSlug = made.json?.slug ?? 'story-plan';
    setBump((n) => n + 1);
    const got = await fetch(canvasUrl(bookId, madeSlug), { headers: { accept: 'application/json' } }).then(
      (res) => (res.ok ? res.json() : null),
      () => null,
    );
    navigate(canvasHref(bookId, madeSlug));
    if (!got || typeof got.sha256 !== 'string') return 'The canvas was created but could not be read back to lay the plan out. It is open and empty.';
    const doc = buildPlanCanvas({ plan, structureId: null, targets: got.targets ?? [], title: 'Story plan' });
    const saved = await saveCanvas(bookId, madeSlug, doc, got.sha256);
    if (saved.status !== 200) return explainCanvasFailure(saved.status, saved.json);
    setBump((n) => n + 1);
    return null;
  }

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
  if (!boardOn && !plannerTabOn) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Plan</h1>
        <p>
          The Plan page is a canvas, and both the board and planner modules are off for this profile or this project. Turn it on in <Link to="/settings">Settings</Link> (a project that requires it off must be changed in library.md or book.md).
        </p>
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
        search={search}
        onBuildPlan={buildPlan}
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
 * @param {{ bookId: string, list: { canvases: any[], archived: any[] }, slug: string | null, search?: string, onBuildPlan?: (plan: any) => Promise<string | null>, problem?: string | null, onDismiss?: () => void, onNew: () => void,
 *   onArchive: (c: any) => void, onRestore: (c: any) => void, onSaved?: () => void, initial?: any }} props  `initial` (tests): the open canvas instead of fetching it; `search` the address query (deep links: ?select=, and the older Plan-tab forms); `onBuildPlan` runs the Build your plan canvas button
 */
export function CanvasPage({ bookId, list, slug, search = '', onBuildPlan = null, problem = null, onDismiss = () => {}, onNew, onArchive, onRestore, onSaved = () => {}, initial = null }) {
  const open = list.canvases.find((c) => c.slug === slug) ?? null;
  const plannerOn = useModule('planner');
  const plan = usePlanData({ bookId, enabled: plannerOn });
  const [layers, setLayers] = useState(() => loadLayers(bookId)); // kept per book
  const [structureId, setStructureId] = useState(/** @type {string | null} */ (null));
  const [branch, setBranch] = useState(/** @type {string | null} */ (null));
  const [focus, setFocus] = useState(/** @type {{ refIds: string[], seq: number } | null} */ (null));
  const [onCanvas, setOnCanvas] = useState(/** @type {Set<string> | null} */ (null));
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(/** @type {string | null} */ (null));
  const series = useApi(plannerOn ? seriesPlanUrl(bookId) : null, '');
  const inSeries = Boolean(series.data?.series);
  const readOnlySession = abilities(useSession()).readOnly;

  // a deep link (?select=<id>, or an older ?view=...&clue=<slug> form): pick that card once the plan (and the canvas) are loaded
  const target = useMemo(() => legacyPlanTarget(search), [search]);
  const [appliedSearch, setAppliedSearch] = useState(/** @type {string | null} */ (null));
  const asks = target.select !== null || target.slug !== null || target.branch !== null || target.series;
  if (asks && appliedSearch !== search && plannerOn && !plan.loading && !(open && onCanvas === null)) {
    // once per address, as soon as the plan (and the open canvas) are loaded
    setAppliedSearch(search);
    const r = resolvePlanTarget(target, plan);
    if (r.structureId) setStructureId(r.structureId);
    if (r.branch) setBranch(r.branch);
    if (r.series) setSeriesOpen(true);
    const id = r.select;
    if (id) setFocus((f) => ({ refIds: [id], seq: (f?.seq ?? 0) + 1 }));
  }

  async function build() {
    setBuilding(true);
    setBuildError(null);
    const failed = onBuildPlan ? await onBuildPlan(plan) : null;
    setBuilding(false);
    setBuildError(failed);
  }
  const changeLayers = (next) => {
    setLayers(next);
    saveLayers(bookId, next);
  };
  const pickFinding = (finding) => {
    if (findingOnCanvas(finding, onCanvas)) setFocus((f) => ({ refIds: findingRefIds(finding), seq: (f?.seq ?? 0) + 1 }));
  };
  const setRefIds = useCallback((next) => setOnCanvas((prev) => (prev && next && prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next)), []);
  return (
    <div className="cv-layout">
      <aside className="cv-list" aria-label="Canvases">
        <div className="cv-list-head">
          <h1>Plan</h1>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            New canvas
          </button>
        </div>
        {list.canvases.length === 0 ? (
          <p className="muted">No canvases yet. The Plan page is a canvas: a board for your plan, mood images, colour palettes, notes and cards for your characters and scenes. It is saved as a file in planning/canvases/.</p>
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
        {plannerOn && (
          <PlanRail plan={plan} layers={layers} onLayers={changeLayers} structureId={structureId} onStructure={setStructureId} branch={branch} onBranch={setBranch} onFinding={pickFinding} onCanvas={open ? onCanvas : null} inSeries={inSeries} onSeries={() => setSeriesOpen(true)} />
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
          <OpenCanvas key={open.slug} bookId={bookId} summary={open} onArchive={() => onArchive(open)} onSaved={onSaved} initial={initial} plan={plannerOn ? plan : null} focusRefs={focus} onRefIds={setRefIds} layers={plannerOn ? layers : null} branch={plannerOn ? branch : null} structureId={structureId} />
        ) : (
          <div className="cv-none">
            {plannerOn && !readOnlySession && onBuildPlan && (
              <section className="cv-plan-build" aria-labelledby="cv-plan-build-h">
                <h2 id="cv-plan-build-h">Build your plan canvas</h2>
                <p className="muted">Lays out your story plan: a column for each beat of the main structure with your scenes in them, your clues underneath, and the links between scenes drawn in. It is saved as planning/canvases/story-plan.canvas.</p>
                <button type="button" className="btn btn-primary" disabled={building || plan.loading} onClick={build}>
                  {building ? 'Building' : 'Build your plan canvas'}
                </button>
                {buildError && (
                  <p className="error" role="alert">
                    {buildError}
                  </p>
                )}
              </section>
            )}
            <h2>Start a canvas</h2>
            <p className="muted">Pin up mood images, build a colour palette, sketch a plot with arrows, or lay out a cast wall with live cards from your Codex.</p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              New canvas
            </button>
          </div>
        )}
      </section>
      {seriesOpen && series.data?.series && <SeriesDrawer bookId={bookId} series={series.data} onClose={() => setSeriesOpen(false)} />}
    </div>
  );
}

/** One canvas: fetch, history, autosave, conflict banner. */
function OpenCanvas({ bookId, summary, onArchive, onSaved, initial, plan, focusRefs, onRefIds, layers, branch, structureId }) {
  const { data, error } = useApi(initial ? null : canvasUrl(bookId, summary.slug), '');
  const loaded = initial ?? data;
  if (error) return <p className="error">{error}</p>;
  if (!loaded) return <p className="muted cv-loading">Loading…</p>;
  return <Editor key={loaded.sha256} bookId={bookId} loaded={loaded} onArchive={onArchive} onSaved={onSaved} plan={plan} focusRefs={focusRefs} onRefIds={onRefIds} layers={layers} branch={branch} structureId={structureId} />;
}

function Editor({ bookId, loaded, onArchive, onSaved, plan = null, focusRefs = null, onRefIds = () => {}, layers = null, branch = null, structureId = null }) {
  const { track } = useWrites();
  const { status } = useStatus();
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const reloadLinks = useRef(() => {});
  const [planVersion, setPlanVersion] = useState(0); // bumped on every plan save, so the Inspector reads the scene plan again
  const planRefresh = plan?.refresh ?? noop;
  const refreshPlan = useCallback(() => {
    planRefresh();
    setPlanVersion((n) => n + 1);
  }, [planRefresh]);
  const [picked, setPicked] = useState(/** @type {string[]} */ ([]));
  // Canvas | List (M10 C10): kept per book; a narrow screen starts in List. List mode needs the plan, so without it the board stays.
  const [chosenMode, setChosenMode] = useState(() => loadViewMode(bookId));
  const mode = plan ? chosenMode : 'canvas';
  const [listPick, setListPick] = useState(/** @type {{ kind: string, id: string, title?: string } | null} */ (null)); // the item picked in List mode
  const [drawer, setDrawer] = useState(/** @type {any} */ (null)); // the ref the plan drawer edits
  const onSelectionChange = useCallback((ids) => setPicked((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids)), []);
  const reloadPlan = useRef(noop);
  const structure = useStructure({ book, activeId: null, onChanged: () => {
    reloadLinks.current();
    reloadPlan.current();
  } }); // for its toast (with Undo), also the one the planner writes use
  const planWrites = { structures: useStructureWrites({ bookId, structure, refresh: refreshPlan }), clues: useClueWrites({ bookId, structure, refresh: refreshPlan }) };
  const linkWrites = useCanvasLinks({ bookId, version: bookVersion(status, bookId), showToast: structure.showToast });
  useEffect(() => {
    reloadLinks.current = linkWrites.reload;
    reloadPlan.current = refreshPlan;
  });
  const [hist, setHist] = useState(() => history(loaded.canvas));
  const [live, setLive] = useState(null);
  const [save, setSave] = useState({ state: 'saved', sha: loaded.sha256, message: null });
  const [conflict, setConflict] = useState(null);
  const [problem, setProblem] = useState(null);
  const refs = useMemo(() => loaded.refs ?? {}, [loaded.refs]);
  const switchMode = (next) => {
    if (next === mode) return;
    if (next === 'list') {
      const r = picked.length === 1 ? refs[picked[0]] : null; // carry the picked card over
      setListPick(r && typeof r.id === 'string' ? { kind: r.kind, id: r.id, title: r.title } : null);
    } else setPicked([]);
    setChosenMode(next);
    saveViewMode(bookId, next);
  };
  const list = useMemo(() => (plan && mode === 'list' ? buildPlanList({ plan, structureId, layers, branch, findings: plan.findings ?? [] }) : null), [plan, mode, structureId, layers, branch]);
  // a deep link or a plan-check finding in List mode picks the item for that id
  const [seenFocus, setSeenFocus] = useState(focusRefs);
  if (focusRefs && seenFocus !== focusRefs && list) {
    setSeenFocus(focusRefs);
    const hit = focusRefs.refIds.map((id) => locateListItem(list, id)).find(Boolean);
    if (hit) setListPick(hit);
  }
  const saved = useRef(loaded.canvas);
  const shaRef = useRef(loaded.sha256);
  const timer = useRef(null);
  // read-only when the file is broken, or (shared mode) for viewers, reviewers and share links; the server refuses their writes anyway
  const can = abilities(useSession());
  const readOnly = (loaded.problem !== null && loaded.problem !== undefined) || can.readOnly;
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

  // tell the page which ref ids are on this canvas (the plan check says so for a finding with no card here)
  useEffect(() => {
    onRefIds(canvasRefIds(doc.nodes, refs));
  }, [doc.nodes, refs, onRefIds]);
  useEffect(() => () => onRefIds(null), [onRefIds]);

  const title = doc?.storyforge?.title ?? loaded.title;
  const setTitle = (t) => onChange({ ...hist.present, storyforge: { schema: 'storyforge.canvas/v1', ...(hist.present.storyforge ?? {}), title: t } });

  return (
    <div className="cv-editor">
      <header className="cv-bar">
        <TitleField key={title} value={title} disabled={readOnly} onCommit={(t) => t.trim() && t !== title && setTitle(t.trim())} />
        <p className="cv-file muted">{loaded.path}</p>
        {plan && (
          <div role="group" aria-label="View" className="cv-mode">
            <button type="button" className="btn" aria-pressed={mode === 'canvas'} onClick={() => switchMode('canvas')}>
              Canvas
            </button>
            <button type="button" className="btn" aria-pressed={mode === 'list'} onClick={() => switchMode('list')}>
              List
            </button>
          </div>
        )}
        <SaveLine save={save} onRetry={() => flush(hist.present)} />
        <button type="button" className="btn" onClick={onArchive} disabled={readOnly}>
          Archive
        </button>
      </header>
      {readOnly && !loaded.problem && <p className="muted cv-banner">You can look at this canvas and its plan. Ask the owner for an editor role to change them.</p>}
      {loaded.problem && (
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
      <div className="cv-body">
        {mode === 'list' && list ? (
          <PlanList list={list} picked={listPick} onPick={setListPick} loading={plan.loading} />
        ) : (
          <div className="cv-board-col">
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
              links={linkWrites.links}
              linkWrites={linkWrites}
              plan={plan}
              focusRefs={focusRefs}
              layers={layers}
              branch={branch}
              findings={plan?.findings ?? null}
              planWrites={planWrites}
              onSelectionChange={onSelectionChange}
              structureId={structureId}
            />
          </div>
        )}
        {plan &&
          (mode === 'list' ? (
            listPick ? (
              <Inspector
                key={listPick.id}
                bookId={bookId}
                plan={plan}
                refInfo={listPick}
                node={null}
                findings={plan.findings ?? null}
                readOnly={readOnly}
                onEdit={() => setDrawer(listPick)}
                writes={planWrites}
                structureId={structureId}
                version={planVersion}
              />
            ) : (
              <InspectorHint />
            )
          ) : picked.length === 1 ? (
            <Inspector
              bookId={bookId}
              plan={plan}
              refInfo={refs[picked[0]] ?? null}
              node={doc.nodes.find((n) => n.id === picked[0]) ?? null}
              findings={plan.findings ?? null}
              readOnly={readOnly}
              onEdit={() => setDrawer(refs[picked[0]] ?? null)}
              writes={planWrites}
              structureId={structureId}
              version={planVersion}
            />
          ) : (
            <InspectorHint />
          ))}
      </div>
      {plan && drawer && !readOnly && <PlanDrawer bookId={bookId} plan={{ ...plan, refresh: refreshPlan }} refInfo={drawer} structure={structure} onClose={() => setDrawer(null)} />}
      {structure.ui}
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
