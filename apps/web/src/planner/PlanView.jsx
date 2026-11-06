import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { useStructure } from '../structure/useStructure.jsx';
import { ArcEditor } from './ArcEditor.jsx';
import { ArcsView, NewArcDialog } from './ArcsView.jsx';
import { ConnectDialog } from './ConnectDialog.jsx';
import { NewStructureDialog } from './NewStructureDialog.jsx';
import { StructureView } from './StructureView.jsx';
import { useStructureWrites } from './useStructureWrites.js';
import { FlowView } from './FlowView.jsx';
import { OverviewView } from './OverviewView.jsx';
import { PlanPage } from './PlanPage.jsx';
import { ScenePlanSection } from './ScenePlanSection.jsx';
import { useArcWrites } from './useArcWrites.js';
import { parsePlanSearch, planUrl, sceneName } from './model.js';
import {
  arcUrl,
  arcsUrl,
  createLinkRequest,
  entriesUrl,
  explainLinkFailure,
  flowUrl,
  isStaleWrite,
  linkUrl,
  linksUrl,
  planHref,
  planOverviewUrl,
  structureTemplatesUrl,
  structureUrl,
  structuresUrl,
  reverseLinkBody,
  storyPlanBody,
  storyPlanUrl,
  updateLinkBody,
} from './requests.js';

const WIDE = '(min-width: 768px)';
const subscribeWide = (onChange) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};
/** True from 768 px up: the graph is only drawn there. */
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);

const isOk = (status) => status === 200 || status === 201;

/**
 * /books/:id/plan: the Overview and the Flow view of the Story Planner. Fetches, keeps the view, the open scene or link and the display mode in the URL
 * (?view=, ?node=, ?link=, ?mode=, ?filter=), and runs the writes (each with Undo, or with the dry-run preview for a new link).
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function PlanView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const { track } = useWrites();
  const wide = useWide();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const url = parsePlanSearch(search);
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const structure = useStructure({ book, activeId: null, onChanged: refresh });

  const overview = useApi(url.view === 'overview' || url.view === 'structure' ? planOverviewUrl(bookId) : null, version);
  const entries = useApi(url.view === 'overview' || url.view === 'arcs' ? entriesUrl(bookId) : null, version);
  const arcs = useApi(url.view === 'arcs' ? arcsUrl(bookId) : null, version);
  const structures = useApi(url.view === 'structure' ? structuresUrl(bookId) : null, version);
  const flow = useApi(flowUrl(bookId), version);
  const links = useApi(linksUrl(bookId), version);

  const [query, setQuery] = useState('');
  const [connect, setConnect] = useState(/** @type {{ from: string | null } | null} */ (null));
  const [storyState, setStoryState] = useState({ message: null, error: null });
  const [newArc, setNewArc] = useState(false);
  const [newStructure, setNewStructure] = useState(false);
  const templates = useApi(newStructure ? structureTemplatesUrl(bookId) : null, 0);
  const [milestone, setMilestone] = useState(/** @type {{ slug: string, index: number } | null} */ (null));
  const [linkState, setLinkState] = useState({ slug: null, busy: false, message: null, error: null });

  const arcWrites = useArcWrites({ bookId, structure, refresh });
  const structureWrites = useStructureWrites({ bookId, structure, refresh });
  const go = (patch) => navigate(planUrl(bookId, url, patch));
  const toLink = (slug) => planHref(bookId, { view: 'flow', link: slug, mode: url.mode });
  const characters = (entries.data ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string').map((o) => ({ id: o.id, slug: o.slug, title: o.title }));
  const nodeName = (id) => sceneName(flow.data?.nodes?.find((n) => n.id === id)?.title);

  // ---------------------------------------------------------------- the story plan
  async function writeStory(body, done) {
    setStoryState({ message: null, error: null });
    const { status: code, json } = await track(bookId, () => send(storyPlanUrl(bookId), storyPlanBody({ ...body, sha: overview.data?.story?.sha256 ?? null })));
    if (isOk(code)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      refresh();
      return true;
    }
    if (isStaleWrite(code, json)) setStoryState({ message: 'The story plan changed elsewhere; reloaded.', error: null });
    else setStoryState({ message: null, error: explainLinkFailure(code, json) ?? explainFailure(code, json) });
    refresh();
    return false;
  }

  // ---------------------------------------------------------------- links
  /** Change a link in place (relation, rationale, direction): POST with the sha256 last read, then Undo in the toast; a 409 reloads. */
  async function changeLink(link, body, done) {
    setLinkState({ slug: link.slug, busy: true, message: null, error: null });
    const { status: code, json } = await track(bookId, () => send(linkUrl(bookId, link.slug), body));
    if (isOk(code)) {
      structure.showToast({ message: done, opId: json?.opId ?? null });
      setLinkState({ slug: link.slug, busy: false, message: null, error: null });
    } else if (isStaleWrite(code, json)) {
      setLinkState({ slug: link.slug, busy: false, message: 'This link changed elsewhere; reloaded.', error: null });
    } else {
      setLinkState({ slug: link.slug, busy: false, message: null, error: explainLinkFailure(code, json) ?? explainFailure(code, json) });
    }
    refresh();
  }

  async function archiveLink(link) {
    const r = await structure.apply({
      url: linkUrl(bookId, link.slug, '/archive'),
      body: { base_sha256: link.sha256 },
      done: 'Link archived.',
      undoable: true,
      after: () => {
        if (url.link === link.slug) go({ link: null });
      },
    });
    if (!r.ok) {
      structure.showToast({ message: `Not changed: ${r.message}` });
      refresh();
    }
  }

  async function restoreLink(link) {
    const r = await structure.apply({ url: linkUrl(bookId, link.slug, '/restore'), body: {}, done: 'Link restored.', undoable: true, after: (json) => navigate(toLink(json?.slug ?? link.slug)) });
    if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
  }

  /** Connect dialog: the dry-run diff first (Preview), then Apply writes it, selects the new link and offers Undo. */
  function previewConnect(v) {
    const req = createLinkRequest(bookId, v);
    return structure.preview(
      {
        title: `Connect "${nodeName(v.from)}" to "${nodeName(v.to)}"`,
        url: req.url,
        body: req.body,
        done: 'Link created.',
        undoable: true,
        after: (json) => {
          setConnect(null);
          if (json?.slug) navigate(toLink(json.slug));
        },
      },
      { stayInForm: true },
    );
  }

  const handlers = {
    onQuery: setQuery,
    onMode: (mode) => go({ mode }),
    onConnect: (from) => setConnect({ from: from ?? null }),
    onSelectNode: (id) => go({ view: 'flow', node: id, link: null, arc: null }),
    onSelectLink: (slug) => go({ view: 'flow', link: slug, node: null, arc: null }),
    onSave: (link, patch) => changeLink(link, updateLinkBody(link, patch), 'Link saved.'),
    onReverse: (link) => changeLink(link, reverseLinkBody(link), 'Link reversed.'),
    onArchive: archiveLink,
    onRestore: restoreLink,
  };

  let body;
  if (url.view === 'overview') {
    if (overview.loading && !overview.data) body = <p className="muted">Loading…</p>;
    else if (overview.error) body = <p className="error">{overview.error}</p>;
    else if (!overview.data) body = <NotFound />;
    else {
      body = (
        <OverviewView
          bookId={bookId}
          overview={overview.data}
          characters={characters}
          message={storyState.message}
          error={storyState.error}
          handlers={{
            onSaveField: (key, value) => writeStory({ fields: { [key]: value } }, 'Story plan saved.'),
            onSaveNotes: (text) => writeStory({ body: text }, 'Story notes saved.'),
            onConnect: handlers.onConnect,
          }}
        />
      );
    }
  } else if (url.view === 'structure') {
    if (flow.error || structures.error) body = <p className="error">{flow.error ?? structures.error}</p>;
    else if (!structures.loading && !structures.data) body = <NotFound />;
    else {
      const selected = url.structure ? structures.data?.structures?.find((s) => s.slug === url.structure) : (structures.data?.structures?.find((s) => s.primary) ?? structures.data?.structures?.[0]);
      body = (
        <StructureView
          bookId={bookId}
          structures={structures.data}
          flow={flow.data}
          url={url}
          state={selected && structureWrites.state.slug === selected.slug ? structureWrites.state : {}}
          handlers={{
            ...(selected ? structureWrites.handlersFor(selected, { onArchived: () => go({ view: 'structure', structure: null }) }) : {}),
            onNewStructure: () => setNewStructure(true),
            onSetPrimary: async (s) => {
              if (!(await writeStory({ fields: { primary_structure: s.id } }, 'Primary structure set.'))) structure.showToast({ message: 'Not changed: the story plan could not be saved. Try again.' });
            },
            onRestore: async (archivedStructure) => {
              const r = await structure.apply({
                url: structureUrl(bookId, archivedStructure.slug, '/restore'),
                body: {},
                done: 'Structure restored.',
                undoable: true,
                after: () => go({ view: 'structure', structure: archivedStructure.slug }),
              });
              if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
            },
          }}
        />
      );
    }
  } else if (url.view === 'arcs') {
    if (flow.error || arcs.error) body = <p className="error">{flow.error ?? arcs.error}</p>;
    else if (!arcs.loading && !arcs.data) body = <NotFound />;
    else {
      const arc = url.arc ? arcs.data?.arcs?.find((a) => a.slug === url.arc) : null;
      body = (
        <ArcsView
          bookId={bookId}
          arcs={arcs.data}
          flow={flow.data}
          url={url}
          wide={wide}
          selectedMilestone={milestone}
          panel={
            arc ? (
              <ArcEditor
                key={arc.slug}
                bookId={bookId}
                arc={arc}
                scenes={flow.data?.nodes ?? []}
                state={arcWrites.state.slug === arc.slug ? arcWrites.state : {}}
                handlers={arcWrites.handlersFor(arc, { onArchived: () => go({ view: 'arcs', arc: null }) })}
              />
            ) : null
          }
          handlers={{
            onMode: (mode) => go({ mode }),
            onNewArc: () => setNewArc(true),
            onRestoreArc: async (archivedArc) => {
              const r = await structure.apply({ url: arcUrl(bookId, archivedArc.slug, '/restore'), body: {}, done: 'Arc restored.', undoable: true, after: () => go({ view: 'arcs', arc: archivedArc.slug }) });
              if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
            },
            onSelectArc: (slug) => {
              setMilestone(null);
              go({ view: 'arcs', arc: slug });
            },
            onSelectMilestone: (slug, index) => {
              setMilestone({ slug, index });
              go({ view: 'arcs', arc: slug });
            },
          }}
        />
      );
    }
  } else if (flow.error || links.error) body = <p className="error">{flow.error ?? links.error}</p>;
  else if (!flow.loading && !flow.data) body = <NotFound />;
  else {
    const selected = url.node && flow.data?.nodes?.some((n) => n.id === url.node) ? url.node : null;
    body = (
      <FlowView
        bookId={bookId}
        flow={flow.data}
        links={links.data}
        url={url}
        wide={wide}
        query={query}
        linkState={linkState.slug === url.link ? linkState : {}}
        scenePlan={selected ? <ScenePlanSection key={selected} book={book} sceneId={selected} onChanged={refresh} /> : null}
        handlers={handlers}
      />
    );
  }

  return (
    <>
      <PlanPage bookId={bookId} view={url.view}>
        {body}
      </PlanPage>
      {connect && (
        <ConnectDialog
          scenes={flow.data?.nodes ?? []}
          links={links.data?.links ?? []}
          initialFrom={connect.from}
          onPreview={previewConnect}
          onOpenExisting={(slug) => {
            setConnect(null);
            navigate(toLink(slug));
          }}
          onClose={() => setConnect(null)}
        />
      )}
      {newArc && (
        <NewArcDialog
          characters={characters}
          hasArc={new Set((arcs.data?.arcs ?? []).map((a) => a.character_id))}
          onCreate={async (id) => {
            const r = await arcWrites.create({ character: id });
            if (r.ok) {
              setNewArc(false);
              setMilestone(null);
              if (r.slug) go({ view: 'arcs', arc: r.slug });
            }
            return r;
          }}
          onOpenExisting={(slug) => {
            setNewArc(false);
            go({ view: 'arcs', arc: slug });
          }}
          onClose={() => setNewArc(false)}
        />
      )}
      {newStructure && (
        <NewStructureDialog
          templates={templates.data?.templates ?? (templates.error ? [] : null)}
          onCreate={async (v) => {
            const r = await structureWrites.create(v);
            if (r.ok) {
              setNewStructure(false);
              if (r.slug) go({ view: 'structure', structure: r.slug });
            }
            return r;
          }}
          onClose={() => setNewStructure(false)}
        />
      )}
      {structure.ui}
    </>
  );
}

function NotFound() {
  return (
    <>
      <h2>Book not found</h2>
      <p>
        <Link to="/">Back to the library</Link>
      </p>
    </>
  );
}
