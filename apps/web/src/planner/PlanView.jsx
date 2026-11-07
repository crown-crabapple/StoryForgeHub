import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { explainFailure, send } from '../structure/helpers.js';
import { useStructure } from '../structure/useStructure.jsx';
import { ArcEditor } from './ArcEditor.jsx';
import { ArcsView, NewArcDialog } from './ArcsView.jsx';
import { ClueView } from './ClueView.jsx';
import { ConnectDialog } from './ConnectDialog.jsx';
import { NewStructureDialog } from './NewStructureDialog.jsx';
import { NewRelationshipDialog, RelationshipEditor } from './RelationshipEditor.jsx';
import { StructureView } from './StructureView.jsx';
import { SynopsisView } from './SynopsisView.jsx';
import { clueUrl, cluesUrl } from './clues.js';
import { synopsesUrl, synopsisUrl } from './synopsis.js';
import { useStructureWrites } from './useStructureWrites.js';
import { FlowView } from './FlowView.jsx';
import { OverviewView } from './OverviewView.jsx';
import { PlanPage } from './PlanPage.jsx';
import { ScenePlanSection } from './ScenePlanSection.jsx';
import { useArcWrites } from './useArcWrites.js';
import { useRelationshipWrites } from './useRelationshipWrites.js';
import { ALL_BRANCHES, beatLabel, branchFromSearch, branchNames, clueFromSearch, parsePlanSearch, planUrl, sceneName } from './model.js';
import {
  arcUrl,
  arcsUrl,
  beatOptions,
  createLinkRequest,
  entriesUrl,
  explainLinkFailure,
  flowUrl,
  isStaleWrite,
  linkUrl,
  linksUrl,
  planHref,
  planOverviewUrl,
  relationshipUrl,
  relationshipsUrl,
  structureTemplatesUrl,
  structureUrl,
  structuresUrl,
  reverseLinkBody,
  storyPlanBody,
  storyPlanUrl,
  threadsUrl,
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
 * (?view=, ?node=, ?link=, ?mode=, ?filter=, ?branch=, ?clue=), and runs the writes (each with Undo, or with the dry-run preview for a new link).
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
  const url = { ...parsePlanSearch(search), branch: branchFromSearch(search) };
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const structure = useStructure({ book, activeId: null, onChanged: refresh });

  const overview = useApi(url.view === 'overview' || url.view === 'structure' || url.view === 'synopsis' ? planOverviewUrl(bookId) : null, version);
  const entries = useApi(url.view === 'overview' || url.view === 'arcs' || url.view === 'clues' ? entriesUrl(bookId) : null, version);
  const arcs = useApi(url.view === 'arcs' ? arcsUrl(bookId) : null, version);
  const relationships = useApi(url.view === 'arcs' ? relationshipsUrl(bookId) : null, version);
  const threads = useApi(url.view === 'arcs' ? threadsUrl(bookId) : null, version);
  const structures = useApi(url.view === 'structure' ? structuresUrl(bookId) : null, version);
  const synopses = useApi(url.view === 'synopsis' ? synopsesUrl(bookId) : null, version);
  const synopsisSlug = new URLSearchParams(search).get('synopsis') || null;
  const synopsisDetail = useApi(url.view === 'synopsis' && synopsisSlug ? synopsisUrl(bookId, synopsisSlug) : null, version);
  const clueSlug = clueFromSearch(search);
  const clues = useApi(url.view === 'clues' ? cluesUrl(bookId) : null, version);
  const clueDetail = useApi(url.view === 'clues' && clueSlug ? clueUrl(bookId, clueSlug) : null, version);
  const library = useApi(url.view === 'flow' || url.view === 'arcs' ? '/api/books' : null, 0);
  const flow = useApi(flowUrl(bookId), version);
  const links = useApi(linksUrl(bookId), version);

  const [query, setQuery] = useState('');
  const [connect, setConnect] = useState(/** @type {{ from: string | null } | null} */ (null));
  const [storyState, setStoryState] = useState({ message: null, error: null });
  const [newArc, setNewArc] = useState(false);
  const [newRelationship, setNewRelationship] = useState(false);
  const connectStructures = useApi(connect ? structuresUrl(bookId) : null, 0);
  const [development, setDevelopment] = useState(/** @type {{ slug: string, index: number } | null} */ (null));
  const [threadSel, setThreadSel] = useState(/** @type {{ slug: string, role: string, scene: string } | null} */ (null));
  const [newStructure, setNewStructure] = useState(false);
  const templates = useApi(newStructure ? structureTemplatesUrl(bookId) : null, 0);
  const [milestone, setMilestone] = useState(/** @type {{ slug: string, index: number } | null} */ (null));
  const [linkState, setLinkState] = useState({ slug: null, busy: false, message: null, error: null });

  const arcWrites = useArcWrites({ bookId, structure, refresh });
  const relationshipWrites = useRelationshipWrites({ bookId, structure, refresh });
  const structureWrites = useStructureWrites({ bookId, structure, refresh });
  const go = (patch) => navigate(planUrl(bookId, url, patch));
  const bookSlug = (Array.isArray(library.data) ? library.data.find((b) => b.id === bookId)?.slug : null) ?? bookId;
  const toLink = (slug, branch = url.branch) => planHref(bookId, { view: 'flow', link: slug, mode: url.mode, branch });
  const characters = (entries.data ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string').map((o) => ({ id: o.id, slug: o.slug, title: o.title }));
  const allEntries = (entries.data ?? []).filter((o) => o.kind === 'entry' && typeof o.slug === 'string').map((o) => ({ id: o.id, slug: o.slug, title: o.title, type: o.type }));
  const beats = beatOptions(connectStructures.data);
  const nodeName = (id) => {
    const node = flow.data?.nodes?.find((n) => n.id === id);
    if (node?.kind === 'beat') return beatLabel(node);
    return beats.find((b) => b.id === id)?.label ?? sceneName(node?.title);
  };

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
          if (json?.slug) navigate(toLink(json.slug, v.branch ?? (url.branch === ALL_BRANCHES ? ALL_BRANCHES : null)));
        },
      },
      { stayInForm: true },
    );
  }

  const handlers = {
    onQuery: setQuery,
    onMode: (mode) => go({ mode }),
    onBranch: (branch) => go({ branch }),
    onConnect: (from) => setConnect({ from: from ?? null }),
    onSelectNode: (id) => go({ view: 'flow', node: id, link: null, arc: null, relationship: null }),
    onSelectLink: (slug) => go({ view: 'flow', link: slug, node: null, arc: null, relationship: null }),
    onOpenBeat: (node) => navigate(planHref(bookId, { view: 'structure', structure: node?.structure?.slug ?? null })),
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
      const relationship = !arc && url.relationship ? relationships.data?.relationships?.find((r) => r.slug === url.relationship) : null;
      body = (
        <ArcsView
          bookId={bookId}
          bookSlug={bookSlug}
          arcs={arcs.data}
          relationships={relationships.error ? { relationships: [], archived: [] } : relationships.data}
          threads={threads.error ? { threads: [] } : threads.data}
          flow={flow.data}
          url={url}
          wide={wide}
          selectedMilestone={milestone}
          selectedDevelopment={development}
          selectedThread={threadSel}
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
          relationshipPanel={
            relationship ? (
              <RelationshipEditor
                key={relationship.slug}
                bookId={bookId}
                relationship={relationship}
                scenes={(flow.data?.nodes ?? []).filter((n) => n.kind !== 'beat')}
                state={relationshipWrites.state.slug === relationship.slug ? relationshipWrites.state : {}}
                handlers={relationshipWrites.handlersFor(relationship, { onArchived: () => go({ view: 'arcs', relationship: null }) })}
              />
            ) : null
          }
          handlers={{
            onMode: (mode) => go({ mode }),
            onNewArc: () => setNewArc(true),
            onNewRelationship: () => setNewRelationship(true),
            onRestoreRelationship: async (archivedRelationship) => {
              const r = await structure.apply({ url: relationshipUrl(bookId, archivedRelationship.slug, '/restore'), body: {}, done: 'Relationship restored.', undoable: true, after: () => go({ view: 'arcs', arc: null, relationship: archivedRelationship.slug }) });
              if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
            },
            onSelectRelationship: (slug) => {
              setDevelopment(null);
              setThreadSel(null);
              go({ view: 'arcs', arc: null, relationship: slug });
            },
            onSelectDevelopment: (slug, index) => {
              setDevelopment({ slug, index });
              setThreadSel(null);
              go({ view: 'arcs', arc: null, relationship: slug });
            },
            onSelectThread: (sel) => {
              setThreadSel(sel);
              setMilestone(null);
              setDevelopment(null);
              go({ view: 'arcs', arc: null, relationship: null });
            },
            onRestoreArc: async (archivedArc) => {
              const r = await structure.apply({ url: arcUrl(bookId, archivedArc.slug, '/restore'), body: {}, done: 'Arc restored.', undoable: true, after: () => go({ view: 'arcs', arc: archivedArc.slug, relationship: null }) });
              if (!r.ok) structure.showToast({ message: `Not restored: ${r.message}` });
            },
            onSelectArc: (slug) => {
              setMilestone(null);
              setThreadSel(null);
              go({ view: 'arcs', arc: slug, relationship: null });
            },
            onSelectMilestone: (slug, index) => {
              setMilestone({ slug, index });
              setThreadSel(null);
              go({ view: 'arcs', arc: slug, relationship: null });
            },
          }}
        />
      );
    }
  } else if (url.view === 'synopsis') {
    if (synopses.error) body = <p className="error">{synopses.error}</p>;
    else if (!synopses.loading && !synopses.data) body = <NotFound />;
    else {
      body = (
        <SynopsisView
          bookId={bookId}
          list={synopses.data}
          detail={synopsisDetail.data}
          detailLoading={synopsisDetail.loading}
          selected={synopsisSlug}
          hasStory={typeof overview.data?.story?.sha256 === 'string'}
          structure={structure}
          refresh={refresh}
          onSelect={(slug) => navigate(planHref(bookId, { view: 'synopsis', synopsis: slug }))}
        />
      );
    }
  } else if (url.view === 'clues') {
    if (clues.error || flow.error) body = <p className="error">{clues.error ?? flow.error}</p>;
    else if (!clues.loading && !clues.data) body = <NotFound />;
    else {
      body = (
        <ClueView
          bookId={bookId}
          list={clues.data}
          detail={clueDetail.data}
          detailLoading={clueDetail.loading}
          selected={clueSlug}
          scenes={(flow.data?.nodes ?? []).filter((n) => n.kind !== 'beat')}
          characters={characters}
          structure={structure}
          refresh={refresh}
          onSelect={(slug) => navigate(planHref(bookId, { view: 'clues', clue: slug }))}
        />
      );
    }
  } else if (flow.error || links.error) body = <p className="error">{flow.error ?? links.error}</p>;
  else if (!flow.loading && !flow.data) body = <NotFound />;
  else {
    const selected = url.node && flow.data?.nodes?.some((n) => n.id === url.node && n.kind !== 'beat') ? url.node : null;
    body = (
      <FlowView
        bookId={bookId}
        flow={flow.data}
        links={links.data}
        url={url}
        wide={wide}
        query={query}
        fileBase={bookSlug}
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
          scenes={(flow.data?.nodes ?? []).filter((n) => n.kind !== 'beat')}
          beats={beats}
          links={links.data?.links ?? []}
          branches={branchNames(flow.data?.branches, links.data?.links)}
          initialBranch={url.branch !== null && url.branch !== ALL_BRANCHES ? url.branch : null}
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
      {newRelationship && (
        <NewRelationshipDialog
          entries={allEntries}
          onCreate={async (a, b) => {
            const r = await relationshipWrites.create({ a, b });
            if (r.ok) {
              setNewRelationship(false);
              setDevelopment(null);
              if (r.slug) go({ view: 'arcs', arc: null, relationship: r.slug });
            }
            return r;
          }}
          onOpenExisting={(slug) => {
            setNewRelationship(false);
            go({ view: 'arcs', arc: null, relationship: slug });
          }}
          onClose={() => setNewRelationship(false)}
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
