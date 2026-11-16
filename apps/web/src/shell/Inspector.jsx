import { Fragment, useId, useRef, useState } from 'react';
import { GoalCard } from '../writing/GoalCard.jsx';
import { LinkedEntries } from '../writing/LinkedEntries.jsx';
import { Revisions } from '../writing/Revisions.jsx';
import { SceneNotes } from '../writing/SceneNotes.jsx';
import { SceneSection } from '../writing/SceneSection.jsx';
import { sceneLinkItems } from '../writing/scene-context.js';
import { RailResearch } from '../notes/RailResearch.jsx';
import { researchForScene } from '../notes/model.js';
import { RailContinuity } from '../continuity/RailContinuity.jsx';
import { RailSuggestions } from '../suggestions/RailSuggestions.jsx';
import { RailComments } from '../collab/RailComments.jsx';
import { RailReceipts } from '../receipts/RailReceipts.jsx';
import { RailEvents } from '../timeline/RailEvents.jsx';
import { eventsForScene } from '../timeline/model.js';
import { ScenePlanSection } from '../planner/ScenePlanSection.jsx';
import { threadActionsFor } from '../planning/ThreadMarks.jsx';
import { useStructure } from '../structure/useStructure.jsx';
import { threadListRequest } from '../planning/requests.js';
import { useWriting } from '../writing/WritingContext.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { sectionPlace } from '../prefs/appearance.js';
import { nextTabIndex } from '../codex/model.js';
import { InspectorSection } from './InspectorSection.jsx';
import { RailSlot } from './RailSlot.jsx';

export { InspectorSection };

/** The problems of a book. A problem in the series' shared files (`scope: 'series'`, M07-J01b) carries a "Series" badge: it is the same for every book of the series. */
export function DiagnosticList({ items }) {
  return (
    <ul className="diag-list">
      {items.map((d, i) => (
        <li key={`${d.code}-${d.file}-${d.location}-${i}`} className={`diag diag-${d.severity}`}>
          <strong>
            {d.code} {d.severity}
          </strong>
          {d.scope === 'series' && (
            <span className="series-badge" title={`In the shared files of the series ${d.series ?? ''}`.trim()}>
              Series
            </span>
          )}
          <div className="muted">
            {d.file}
            {d.location ? ` (${d.location})` : ''}
          </div>
          <div>{d.message}</div>
        </li>
      ))}
    </ul>
  );
}

/** Library-relative or book-relative: does this diagnostic belong to the scene's file? */
export function isForFile(diagnostic, book, scene) {
  return diagnostic.file === scene.path || (book.path ? diagnostic.file === `${book.path}/${scene.path}` : false);
}

const TAB_KEYS = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
const TAB_STORE_KEY = 'storyforge.inspector.tab';
/** The tabs of the scene panel and their sections, in order. */
const TAB_DEFS = [
  { key: 'scene', label: 'Scene', sections: ['goal', 'scene', 'plan', 'notes'] },
  { key: 'links', label: 'Links', sections: ['linked', 'events', 'research'] },
  { key: 'review', label: 'Review', sections: ['continuity', 'comments', 'suggestions'] },
  { key: 'problems', label: 'Problems', sections: ['problems', 'book-problems'] },
  { key: 'history', label: 'History', sections: ['revisions', 'receipts'] },
];
/** The module a section belongs to (the same one its RailSlot names); sections not listed belong to none. */
const SECTION_MODULE = { plan: 'planner', events: 'timeline', research: 'research', continuity: 'continuity', suggestions: 'suggestions', receipts: 'receipts' };

/**
 * The tabs the scene panel shows: a tab appears only when one of its sections would be drawn (its condition `has[id]`, its module on, and the layout showing it).
 * `book-problems` always counts as given. The Problems tab carries `count` (the scene's problems) when there are any.
 * @param {{ has: Record<string, boolean>, moduleOn: (m: string) => boolean, pinned: string[] | null, problemCount?: number }} o
 * @returns {{ key: string, label: string, sections: string[], count?: number }[]}
 */
export function inspectorTabs({ has, moduleOn, pinned, problemCount = 0 }) {
  const shown = (id) => (id === 'book-problems' || Boolean(has[id])) && (!SECTION_MODULE[id] || moduleOn(SECTION_MODULE[id])) && sectionPlace(pinned, id).shown;
  return TAB_DEFS.filter((t) => t.sections.some(shown)).map((t) => (t.key === 'problems' && problemCount > 0 ? { ...t, count: problemCount } : t));
}

/** The tab holding the first visible section in the layout's order (Writing: Scene; Review: Review). Null when there are no tabs. */
export function defaultInspectorTab(tabs, pinned) {
  let best = null;
  for (const t of tabs) {
    for (const id of t.sections) {
      const place = sectionPlace(pinned, id);
      if (place.shown && (best === null || place.order < best.order)) best = { order: place.order, key: t.key };
    }
  }
  return best?.key ?? tabs[0]?.key ?? null;
}

function storedTab() {
  try {
    return localStorage.getItem(TAB_STORE_KEY);
  } catch {
    return null;
  }
}
function storeTab(key) {
  try {
    localStorage.setItem(TAB_STORE_KEY, key);
  } catch {
    // private window or storage off: the tabs work without it
  }
}

/**
 * The right rail for the open scene (M03-J04): goal card, scene facts, what is linked, notes, continuity, problems, revisions, grouped into tabs
 * (Scene, Links, Review, Problems, History; a tab appears only when one of its sections is drawn). All panels are rendered, inactive ones `hidden`, so nothing
 * unsaved is lost on a tab change. The last tab chosen is remembered; without a scene (the Read view) only "Book problems" is drawn, with no tabs.
 * Names come from `objects` (the GET /api/books/:b/objects answer) with the slug in the tooltip; a slug nothing resolves is shown as it is.
 * @param {{ book: any, scene: any | null, diagnostics: { items: any[] | null, error: string | null, loading: boolean },
 *   objects?: { id: string, kind: string, slug: string | null, title: string | null }[] | null, onChanged?: () => void, planning?: { threads: any[] } | null,
 *   timeline?: any | null, notes?: { notes: any[] } | null, continuity?: any | null, version?: string }} props
 *   `onChanged` runs after the rail changed the book (status, POV, a restore as a new scene).
 *   `timeline` (GET /timeline) and `notes` (GET /notes), M04-J04: when given (null while loading), the rail also shows "Events" (the scene's events, from both sides) and "Research"
 *   (research notes that link any entry or thread of the scene). Left out, those two sections are not drawn.
 *   `continuity` (GET /continuity), M05-J02: the rail's "Continuity" section lists the findings of this scene ("Loading…" while it is null or left out); `version` refreshes the context lines it shows.
 */
export function SceneInspector({ book, scene, diagnostics, objects = null, onChanged, planning = null, timeline = undefined, notes = undefined, continuity = undefined, version = '' }) {
  const { liveBody } = useWriting();
  const prefs = usePrefs();
  const structure = useStructure({ book, activeId: scene?.id ?? null, onChanged });
  const uid = useId();
  const [tab, setTab] = useState(storedTab);
  const tablistRef = useRef(null);
  // "Mark this scene as setup / development / payoff" under each plot thread (M04-J03): the thread file's list changes, after a preview
  const markThread = (thread, list, present) => {
    const words = { setup: 'setup', develop: 'development', payoff: 'payoff' };
    const what = present ? `Mark "${scene?.title || 'Untitled scene'}" as ${words[list]} of "${thread.title}"` : `Remove "${scene?.title || 'Untitled scene'}" from the ${words[list]} of "${thread.title}"`;
    const r = threadListRequest(book.id, thread, list, scene.id, present);
    structure.preview({ title: what, url: r.url, body: r.body, done: present ? `Marked as ${words[list]}.` : `Removed from the ${words[list]}.`, undoable: true });
  };
  const readable = Boolean(scene) && !scene?.problem && !scene?.raw;
  const body = readable ? (liveBody ?? scene?.body ?? '') : '';
  const items = diagnostics.items ?? [];
  const forScene = scene ? items.filter((d) => isForFile(d, book, scene)) : [];
  const forBook = scene ? items.filter((d) => !forScene.includes(d)) : items;
  const has = { scene: readable, events: timeline !== undefined, research: notes !== undefined, comments: readable, suggestions: readable, revisions: readable, goal: true, plan: true, linked: true, notes: true, continuity: true, problems: true, receipts: readable };
  const pinned = prefs.layout.pinned;
  const tabs = scene ? inspectorTabs({ has, moduleOn: prefs.moduleOn, pinned, problemCount: forScene.length }) : [];
  const active = tabs.some((t) => t.key === tab) ? tab : defaultInspectorTab(tabs, pinned);
  const pick = (key) => {
    setTab(key);
    storeTab(key);
  };
  const onTabKeyDown = (e) => {
    if (!TAB_KEYS.includes(e.key)) return;
    const at = tabs.findIndex((t) => t.key === active);
    const to = nextTabIndex(at, e.key, tabs.length);
    e.preventDefault();
    pick(tabs[to].key);
    tablistRef.current?.querySelectorAll('[role="tab"]')[to]?.focus();
  };
  const bookProblems = (
    <RailSlot id="book-problems">
      <InspectorSection title="Book problems">
        {!scene && diagnostics.loading && <p className="muted">Loading…</p>}
        {!scene && diagnostics.error && <p className="error">{diagnostics.error}</p>}
        {diagnostics.items && forBook.length === 0 && <p className="muted">No other problems found.</p>}
        {forBook.length > 0 && <DiagnosticList items={forBook} />}
      </InspectorSection>
    </RailSlot>
  );
  if (!scene) {
    return (
      <>
        {bookProblems}
        {structure.ui}
      </>
    );
  }
  const content = {
    goal: (
      <RailSlot id="goal">
        <GoalCard />
      </RailSlot>
    ),
    scene: has.scene && (
      <RailSlot id="scene">
        <SceneSection book={book} scene={scene} objects={objects} onChanged={onChanged} />
      </RailSlot>
    ),
    plan: (
      <RailSlot id="plan" module="planner">
        <ScenePlanSection book={book} sceneId={scene.id} onChanged={onChanged} />
      </RailSlot>
    ),
    linked: (
      <RailSlot id="linked">
        <LinkedEntries bookId={book.id} front={scene.front_matter} body={body} objects={objects} threadActions={planning && prefs.moduleOn('threads') ? threadActionsFor({ planning, sceneId: scene.id, onMark: markThread }) : null} />
      </RailSlot>
    ),
    notes: (
      <RailSlot id="notes">
        <SceneNotes body={body} />
      </RailSlot>
    ),
    events: has.events && (
      <RailSlot id="events" module="timeline">
        <RailEvents bookId={book.id} events={timeline ? eventsForScene(timeline, scene.id) : null} />
      </RailSlot>
    ),
    research: has.research && (
      <RailSlot id="research" module="research">
        <RailResearch bookId={book.id} notes={notes ? researchForScene(notes.notes, sceneLinkItems(scene.front_matter, body, objects)) : null} />
      </RailSlot>
    ),
    continuity: (
      <RailSlot id="continuity" module="continuity">
        <RailContinuity book={book} scene={scene} continuity={continuity ?? null} version={version} onChanged={onChanged} />
      </RailSlot>
    ),
    comments: has.comments && (
      <RailSlot id="comments">
        <RailComments book={book} scene={scene} version={version} onChanged={onChanged} />
      </RailSlot>
    ),
    suggestions: has.suggestions && (
      <RailSlot id="suggestions" module="suggestions">
        <RailSuggestions book={book} scene={scene} version={version} onChanged={onChanged} />
      </RailSlot>
    ),
    problems: (
      <RailSlot id="problems">
        <InspectorSection title="Problems">
          {diagnostics.loading && <p className="muted">Loading…</p>}
          {diagnostics.error && <p className="error">{diagnostics.error}</p>}
          {diagnostics.items && forScene.length === 0 && <p className="muted">No problems in this scene.</p>}
          {forScene.length > 0 && <DiagnosticList items={forScene} />}
        </InspectorSection>
      </RailSlot>
    ),
    'book-problems': bookProblems,
    revisions: has.revisions && (
      <RailSlot id="revisions">
        <Revisions bookId={book.id} sceneId={scene.id} onChanged={onChanged} />
      </RailSlot>
    ),
    receipts: has.receipts && (
      <RailSlot id="receipts" module="receipts">
        <RailReceipts book={book} scene={scene} version={version} onChanged={onChanged} />
      </RailSlot>
    ),
  };
  return (
    <>
      <div className="inspector-tabs">
        <div role="tablist" aria-label="Scene panel sections" className="entry-tabs" ref={tablistRef} onKeyDown={onTabKeyDown}>
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" id={`${uid}-tab-${t.key}`} aria-controls={`${uid}-panel-${t.key}`} aria-selected={active === t.key} tabIndex={active === t.key ? 0 : -1} className="entry-tab" onClick={() => pick(t.key)}>
              {t.label}
              {t.count !== undefined && <span className="entry-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>
        {tabs.map((t) => (
          <div key={t.key} role="tabpanel" id={`${uid}-panel-${t.key}`} aria-labelledby={`${uid}-tab-${t.key}`} className="entry-panel inspector-panel" hidden={active !== t.key}>
            {t.sections.map((id) => (
              <Fragment key={id}>{content[id]}</Fragment>
            ))}
          </div>
        ))}
      </div>
      {structure.ui}
    </>
  );
}
