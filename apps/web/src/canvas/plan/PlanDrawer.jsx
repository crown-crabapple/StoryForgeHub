// The wide right drawer of the canvas (M10 C6): the existing Plan-tab editors for the picked card, for the long forms the Inspector does not hold.
// Non-modal (the board stays usable): focus moves in on open, Escape or Close shuts it, and focus goes back to where it was (else the board).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api.js';
import { ArcEditor } from '../../planner/ArcEditor.jsx';
import { BeatSheetEditor } from '../../planner/BeatSheetEditor.jsx';
import { ClueView } from '../../planner/ClueView.jsx';
import { OverviewView } from '../../planner/OverviewView.jsx';
import { RelationshipEditor } from '../../planner/RelationshipEditor.jsx';
import { ScenePlanSection } from '../../planner/ScenePlanSection.jsx';
import { SynopsisView } from '../../planner/SynopsisView.jsx';
import { clueUrl } from '../../planner/clues.js';
import { synopsisUrl } from '../../planner/synopsis.js';
import { useArcWrites } from '../../planner/useArcWrites.js';
import { useRelationshipWrites } from '../../planner/useRelationshipWrites.js';
import { useStructureWrites } from '../../planner/useStructureWrites.js';
import { entriesUrl, explainLinkFailure, isStaleWrite, planOverviewUrl, storyPlanBody, storyPlanUrl } from '../../planner/requests.js';
import { useWrites } from '../../shell/writes.jsx';
import { explainFailure, send } from '../../structure/helpers.js';
import { planItemFor } from './selectors.js';

const noop = () => {};

/** The story plan in the Overview component: fetches GET /plan-overview and runs the story-plan writes like PlanView does. */
function StoryPlanEditor({ bookId, structure, refresh, version }) {
  const { track } = useWrites();
  const overview = useApi(planOverviewUrl(bookId), version);
  const entries = useApi(entriesUrl(bookId), 0);
  const [state, setState] = useState({ message: null, error: null });
  const characters = (entries.data ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string').map((o) => ({ id: o.id, slug: o.slug, title: o.title }));

  async function writeStory(body, done) {
    setState({ message: null, error: null });
    const { status, json } = await track(bookId, () => send(storyPlanUrl(bookId), storyPlanBody({ ...body, sha: overview.data?.story?.sha256 ?? null })));
    if (status === 200 || status === 201) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      refresh();
      return true;
    }
    if (isStaleWrite(status, json)) setState({ message: 'The story plan changed elsewhere; reloaded.', error: null });
    else setState({ message: null, error: explainLinkFailure(status, json) ?? explainFailure(status, json) });
    refresh();
    return false;
  }

  if (overview.error) return <p className="error">{overview.error}</p>;
  if (!overview.data) return <p className="muted">Loading…</p>;
  return (
    <OverviewView
      bookId={bookId}
      overview={overview.data}
      characters={characters}
      message={state.message}
      error={state.error}
      handlers={{ onSaveField: (key, value) => writeStory({ fields: { [key]: value } }, 'Story plan saved.'), onSaveNotes: (text) => writeStory({ body: text }, 'Story notes saved.'), onConnect: noop }}
    />
  );
}

/** The Synopsis component with the one synopsis of the card (its list shows the others too). */
function SynopsisEditor({ bookId, plan, item, structure, refresh, version }) {
  const detail = useApi(synopsisUrl(bookId, item.slug), version);
  return <SynopsisView bookId={bookId} list={plan.synopses} detail={detail.data} detailLoading={detail.loading} selected={item.slug} hasStory={typeof plan.storyPlan?.sha256 === 'string'} structure={structure} refresh={refresh} onSelect={noop} />;
}

/** The Clue component with the one clue of the card (its list and New clue form show too). */
function ClueEditor({ bookId, plan, item, structure, refresh, version }) {
  const detail = useApi(clueUrl(bookId, item.slug), version);
  const entries = useApi(entriesUrl(bookId), 0);
  const characters = (entries.data ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string').map((o) => ({ id: o.id, slug: o.slug, title: o.title }));
  return <ClueView bookId={bookId} list={plan.clues} detail={detail.data} detailLoading={detail.loading} selected={item.slug} scenes={plan.scenes ?? []} characters={characters} structure={structure} refresh={refresh} onSelect={noop} />;
}

/**
 * @param {{ bookId: string, plan: any, refInfo: { kind: string, id: string, title?: string | null }, structure: any, onClose: () => void }} props
 *   `structure` is the useStructure object of the page (its toast carries Undo); a save here calls `plan.refresh`, so the Inspector shows the new values.
 */
export function PlanDrawer({ bookId, plan, refInfo, structure, onClose }) {
  const ref = useRef(null);
  const [version, setVersion] = useState(0);
  const planRefresh = plan?.refresh ?? noop;
  const refresh = useCallback(() => {
    planRefresh();
    setVersion((n) => n + 1);
  }, [planRefresh]);
  const arcWrites = useArcWrites({ bookId, structure, refresh });
  const relationshipWrites = useRelationshipWrites({ bookId, structure, refresh });
  const structureWrites = useStructureWrites({ bookId, structure, refresh });
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // focus in on open, back out on close
  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement;
    node?.focus();
    return () => {
      const target = opener instanceof HTMLElement && opener.isConnected ? opener : document.querySelector('.cv-board');
      if (target instanceof HTMLElement) target.focus();
    };
  }, []);

  const item = planItemFor(plan, refInfo);
  const kind = refInfo.kind;
  const scenes = plan?.scenes ?? [];
  let body;
  if (kind === 'scene') body = <ScenePlanSection key={refInfo.id} book={book} sceneId={refInfo.id} onChanged={refresh} />;
  else if (kind === 'story-plan') body = <StoryPlanEditor bookId={bookId} structure={structure} refresh={refresh} version={version} />;
  else if (!item) body = <p className="muted">This is not loaded from the plan yet. Close the drawer and try again.</p>;
  else if (kind === 'arc')
    body = <ArcEditor key={item.slug} bookId={bookId} arc={item} scenes={scenes} state={arcWrites.state.slug === item.slug ? arcWrites.state : {}} handlers={arcWrites.handlersFor(item, { onArchived: onClose })} />;
  else if (kind === 'relationship')
    body = <RelationshipEditor key={item.slug} bookId={bookId} relationship={item} scenes={scenes} state={relationshipWrites.state.slug === item.slug ? relationshipWrites.state : {}} handlers={relationshipWrites.handlersFor(item, { onArchived: onClose })} />;
  else if (kind === 'synopsis') body = <SynopsisEditor key={item.slug} bookId={bookId} plan={plan} item={item} structure={structure} refresh={refresh} version={version} />;
  else if (kind === 'clue') body = <ClueEditor key={item.slug} bookId={bookId} plan={plan} item={item} structure={structure} refresh={refresh} version={version} />;
  else if (kind === 'beat' || kind === 'structure') {
    const s = kind === 'beat' ? item.structure : item;
    const handlers = structureWrites.handlersFor(s);
    const state = structureWrites.state.slug === s.slug ? structureWrites.state : {};
    body = (
      <>
        {state.message && (
          <p className="muted" role="status">
            {state.message}
          </p>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <BeatSheetEditor key={`${s.slug}:${s.sha256}`} structure={s} scenes={scenes} busy={state.busy === true} onSave={handlers.onSaveBeats} />
      </>
    );
  } else body = <p className="muted">There is nothing to edit for this card.</p>;

  return (
    <aside
      ref={ref}
      className="cv-drawer"
      role="dialog"
      aria-label={`Edit plan: ${refInfo.title ?? kind}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
      }}
    >
      <header className="cv-drawer-head">
        <h2>{`Edit plan: ${refInfo.title ?? kind}`}</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="cv-drawer-body">{body}</div>
    </aside>
  );
}
