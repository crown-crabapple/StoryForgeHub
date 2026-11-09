// The JSON API. Maps GET /api/... paths to FileRepository reads and the guarded write routes to
// FileRepository write methods.
import { DEFAULT_BUDGET, MAX_BUDGET, MIN_BUDGET } from '@storyforge/core';
import { AI_LEVELS } from '@storyforge/format';
import { ExportError, ExportVerificationError, FORMATS, INCLUDE_MODES, RestoreError, createBackup, exportBook, planningZip, restoreBackup } from '@storyforge/export';
import pkg from '../package.json' with { type: 'json' };
import { handleAiRead, handleAiWrite } from './ai-routes.mjs';
import { handleIntegrationsRead, handleIntegrationsWrite } from './plugin-admin.mjs';
import { checkModule, handlePreferencesRead, handleProfileWrite } from './preferences.mjs';

/** @typedef {import('@storyforge/core').FileRepository} FileRepository */
/** @typedef {{ status: number, body: unknown, raw?: { bytes: Buffer, headers: Record<string, string> } }} ApiResult  `raw` (cover images) is sent as is instead of `body`. */
/** @typedef {{ lastRecover: any, instance?: { pid: number, started_at: string, lock: string }, host?: ReturnType<typeof import('@storyforge/core').createLibraryHost> | null }} ApiState  Report of the most recent recover() run; what this process knows about itself; the library host (which library is open, recent libraries, switching). */

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const NOT_SUPPORTED = { status: 501, body: { error: 'not_supported' } };

/** @param {string} s @returns {string | null} */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * True when the path belongs to the API (handled here, never by static files).
 * @param {string} pathname
 */
export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * @param {FileRepository} repository
 * @param {string} pathname raw (still percent-encoded) URL path
 * @param {ApiState} [state]
 * @param {URLSearchParams} [params] the query string
 * @returns {Promise<ApiResult>}
 */
export async function handleApi(repository, pathname, state, params = new URLSearchParams()) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((p) => p === null)) return NOT_FOUND;
  const [api, a, b, c, d, e, f, ...rest] = /** @type {string[]} */ (parts);
  if (api !== 'api' || rest.length > 0) return NOT_FOUND;
  // only the revisions routes (scenes/:s/revisions[/:file]), an entry image and a synopsis extract (synopses/:slug/extract) are longer than five segments
  if (e !== undefined && !(a === 'books' && ((c === 'scenes' && d !== undefined && e === 'revisions') || (c === 'entries' && d !== undefined && e === 'image') || (c === 'synopses' && d !== undefined && e === 'extract' && f === undefined) || (c === 'export' && d === 'planning' && e === undefined)))) return NOT_FOUND;

  if (a === 'health' && b === undefined) {
    const info = await repository.libraryInfo();
    return { status: 200, body: { ok: true, version: pkg.version, library: info.root } };
  }
  if (a === 'recover' && b === 'last' && c === undefined) {
    return { status: 200, body: state?.lastRecover ?? { completed: [], rolledBack: [], needsAttention: [] } };
  }
  if (a === 'status' && b === undefined) {
    const status = await repository.getStatus();
    const last = state?.lastRecover;
    return {
      status: 200,
      body: {
        instance: state?.instance ?? { pid: process.pid, started_at: null, lock: 'none' },
        watch: status.watch,
        books: status.books,
        recover: { needsAttention: last?.needsAttention ?? [], rolledBack: last?.rolledBack ?? [] },
      },
    };
  }
  // M05-J04 (optional AI): provider profiles, and whether AI is on for a book
  if (a === 'ai' && b === 'profiles' && c === undefined) return handleAiRead(repository, state, 'profiles');
  if (a === 'search' && b === undefined) return handleSearch(repository, params);
  // M08-J02: the plugins found in the library and the access granted to them; the webhook subscriptions (never a token or a secret)
  if ((a === 'plugins' || a === 'webhooks') && b === undefined) return handleIntegrationsRead(repository, state, a);
  if (a === 'index' && b === 'status' && c === undefined) {
    return { status: 200, body: await repository.indexStatus() };
  }
  if (a === 'library' && b === undefined) {
    return { status: 200, body: await repository.libraryInfo() };
  }
  if (a === 'library' && b === 'recent' && c === undefined) {
    if (!state?.host) return NOT_SUPPORTED;
    return { status: 200, body: await state.host.recent() };
  }
  // M07-J04: the layers, the resolved preferences and the modules; the custom prompt components and workflows
  if (a === 'preferences' && b === undefined) return handlePreferencesRead(repository, state, params);
  if (a === 'prompts' && b === undefined) return { status: 200, body: await repository.listPrompts() };
  if (a === 'templates' && b === undefined) {
    return { status: 200, body: await repository.listTemplates() };
  }
  if (a === 'books') {
    if (b === undefined) return { status: 200, body: await repository.listBooks() };
    if (c === undefined) {
      const book = await repository.getBook(b);
      return book ? { status: 200, body: book } : NOT_FOUND;
    }
    if (c === 'cover' && d === undefined) return handleCover(repository, b, params);
    if (c === 'export' && d === undefined) return handleExport(repository, b, params);
    if (c === 'export' && d === 'planning' && e === undefined) return handlePlanningExport(repository, b);
    if (c === 'backup' && d === undefined) return handleBackup(repository, b, params);
    if (c === 'diagnostics' && d === undefined) {
      return { status: 200, body: await repository.getDiagnostics(b) };
    }
    // M12 AI Activity: what AI connections (plugin tokens) changed in this book, newest first, from the op journal (read-only; Undo is the ops restore route)
    if (c === 'ai-activity' && d === undefined) {
      const r = await repository.listAiActivity(b);
      return r.ok ? { status: 200, body: { activity: (r.items ?? []).map(({ opId, at, actor, op, summary, files, undone, undoable, archivable, target }) => ({ opId, at, actor, route: op, summary, files, undone, undoable, archivable: archivable === true, target: target ?? null })) } } : NOT_FOUND;
    }
    // M05-J01: continuity findings, computed from the files on every call (read-only)
    if (c === 'continuity' && d === undefined) {
      // M12 W4: ?chapter=N keeps the findings that touch that chapter; &cast=<entry>:<role>,... also checks that planned cast (CS1, CS2) as if it were in chapter N
      const q = continuityOptions(params);
      if (q.error) return badRequest(q.error);
      const continuity = await repository.getContinuity(b, q.opts);
      return continuity ? { status: 200, body: continuity } : NOT_FOUND;
    }
    // M12 W4: the author's continuity settings (planning/continuity/settings.md): { exists, file, overdue_chapters, severity }
    if (c === 'continuity' && d === 'settings' && e === undefined) {
      const settings = await repository.getContinuitySettings(b);
      return settings ? { status: 200, body: settings } : NOT_FOUND;
    }
    // M05-J02: the lines around a finding's evidence ("Show both"): ?file=<book-relative>&line=N&radius=3 (radius at most 10)
    if (c === 'continuity' && d === 'context' && e === undefined) {
      const line = params.get('line');
      const radius = params.get('radius');
      const r = await repository.getContinuityContext(b, { file: params.get('file') ?? undefined, line: line === null ? undefined : /^[0-9]+$/.test(line) ? Number(line) : NaN, ...(radius === null ? {} : { radius: /^[0-9]+$/.test(radius) ? Number(radius) : NaN }) });
      if (r.ok) return { status: 200, body: { lines: r.lines } };
      if (r.code === 'NOT_FOUND') return NOT_FOUND;
      return { status: 400, body: { error: 'bad_request', code: r.code, message: r.message } };
    }
    // M05-J06: suggestions (read-only listing; deciding is a guarded write)
    if (c === 'suggestions' && d === undefined) {
      const state = params.get('state');
      if (state !== null && state !== 'open' && state !== 'decided') return badRequest('state must be open or decided');
      const r = await repository.listSuggestions(b, { ...(params.get('target') !== null ? { target: /** @type {string} */ (params.get('target')) } : {}), ...(state !== null ? { state } : {}) });
      return r.ok ? { status: 200, body: { suggestions: r.suggestions } } : NOT_FOUND;
    }
    if (c === 'suggestions' && d !== undefined && e === undefined) {
      const r = await repository.getSuggestion(b, d);
      return r.ok ? { status: 200, body: r.suggestion } : NOT_FOUND;
    }
    // M07-J03b: comments of a scene (?target=<id>&status=open|resolved) and who has a scene open (?scene=<id>, advisory, in memory)
    if (c === 'comments' && d === undefined) {
      const status = params.get('status');
      if (status !== null && status !== 'open' && status !== 'resolved') return badRequest('status must be open or resolved');
      const r = await repository.listComments(b, { ...(params.get('target') !== null ? { target: /** @type {string} */ (params.get('target')) } : {}), ...(status !== null ? { status } : {}) });
      return r.ok ? { status: 200, body: { comments: r.comments } } : NOT_FOUND;
    }
    if (c === 'presence' && d === undefined) {
      const scene = params.get('scene');
      if (scene === null || scene === '') return badRequest('scene is required');
      return { status: 200, body: { scene, users: state?.presence ? state.presence.who(b, scene) : [] } };
    }
    // M05-J07: receipts (the provenance ledger). Reads only: GET /receipts?scene= (lineage, receipts, integrity status), /receipts/blame?scene=&from=&to=, /receipts/verify
    if (c === 'receipts' && d === undefined) {
      const scene = params.get('scene');
      if (scene === null || scene === '') return badRequest('scene is required');
      const r = await repository.getReceipts(b, scene);
      return r.ok ? { status: 200, body: { receipts: r.receipts, lineage: r.lineage, status: r.status } } : NOT_FOUND;
    }
    if (c === 'receipts' && d === 'blame' && e === undefined) {
      const scene = params.get('scene');
      const from = params.get('from');
      const to = params.get('to');
      if (scene === null || scene === '') return badRequest('scene is required');
      if ((from !== null && !/^[1-9][0-9]*$/.test(from)) || (to !== null && !/^[1-9][0-9]*$/.test(to))) return badRequest('from and to must be line numbers (1 or more)');
      const r = await repository.blame(b, scene, from === null ? 1 : Number(from), to === null ? Infinity : Number(to));
      return r.ok ? { status: 200, body: { lines: r.lines } } : NOT_FOUND;
    }
    if (c === 'receipts' && d === 'verify' && e === undefined) {
      const r = await repository.verifyReceipts(b);
      return r ? { status: 200, body: r } : NOT_FOUND;
    }
    if (c === 'repair' && d === 'plan' && e === undefined) {
      const plan = await repository.planRepair(b);
      return plan ? { status: 200, body: plan } : NOT_FOUND;
    }
    if (c === 'raw' && d === undefined) {
      const file = params.get('path');
      if (file === null) return badRequest('path is required');
      const raw = await repository.getRawFile(b, file);
      return raw ? { status: 200, body: raw } : NOT_FOUND;
    }
    if (c === 'objects' && d === undefined) {
      const kindsParam = params.get('kinds');
      let kinds;
      if (kindsParam !== null) {
        kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
        if (kinds.length === 0 || kinds.some((k) => !OBJECT_KINDS.includes(k))) return badRequest(`kinds must be a comma-separated list of: ${OBJECT_KINDS.join(', ')}`);
      }
      const objects = await repository.getObjects(b, kinds);
      return objects ? { status: 200, body: objects } : NOT_FOUND;
    }
    if (c === 'scenes' && d !== undefined && e === undefined) {
      const scene = await repository.getScene(b, d);
      return scene ? { status: 200, body: scene } : NOT_FOUND;
    }
    // M03-J04: scene revisions, writing activity, entry preview
    if (c === 'scenes' && d !== undefined && e === 'revisions' && f === undefined) {
      const r = await repository.listRevisions(b, d);
      return r.ok ? { status: 200, body: r.revisions } : NOT_FOUND;
    }
    if (c === 'scenes' && d !== undefined && e === 'revisions') {
      const r = await repository.getRevision(b, d, f);
      return r.ok ? { status: 200, body: r.revision } : NOT_FOUND;
    }
    if (c === 'activity' && d === undefined) {
      const daysParam = params.get('days');
      if (daysParam !== null && (!/^[0-9]+$/.test(daysParam) || Number(daysParam) < 1 || Number(daysParam) > 366)) return badRequest('days must be an integer from 1 to 366');
      const r = await repository.getActivity(b, daysParam !== null ? { days: Number(daysParam) } : {});
      if (!r.ok) return NOT_FOUND;
      const { added, removed, net, minutes, sessions, ai_words: aiWords } = r.today;
      return { status: 200, body: { goal: r.goal, today: { added, removed, net, minutes, sessions, ai_words: aiWords }, days: r.days, streak: r.streak, totals: r.totals } };
    }
    // M07-J02: the Insights numbers (one JSON, computed from the index when fresh, else from the files), goals, revision tasks (list; one task opened = its targets located)
    if (c === 'insights' && d === undefined) {
      const r = await repository.getInsights(b);
      return r.ok ? { status: 200, body: r.insights } : NOT_FOUND;
    }
    if (c === 'goals' && d === undefined) {
      const r = await repository.getGoals(b);
      return r.ok ? { status: 200, body: { goals: r.goals, skipped: r.skipped, daily_word_goal: r.daily_word_goal, effective: r.effective } } : NOT_FOUND;
    }
    if (c === 'tasks' && d === undefined) {
      const status = params.get('status');
      const source = params.get('source');
      if (status !== null && !['open', 'doing', 'done', 'dropped'].includes(status)) return badRequest('status must be open, doing, done or dropped');
      if (source !== null && !['continuity', 'check', 'manual'].includes(source)) return badRequest('source must be continuity, check or manual');
      const label = params.get('label');
      const forWho = params.get('for');
      if (forWho !== null && !['ai', 'author'].includes(forWho)) return badRequest('for must be ai or author');
      const r = await repository.listTasks(b, { ...(status !== null ? { status } : {}), ...(source !== null ? { source } : {}), ...(label !== null && label !== '' ? { label } : {}), ...(forWho !== null ? { for: forWho } : {}) });
      return r.ok ? { status: 200, body: { tasks: r.tasks, counts: r.counts, labels: r.labels } } : NOT_FOUND;
    }
    // M12 W3: the promises / questions ledger, the chapter cast, what a character knows by a chapter, the state events (reads; nothing here writes)
    if (c === 'ledger' && d === undefined) {
      const ledger = await repository.getLedger(b);
      return ledger ? { status: 200, body: ledger } : NOT_FOUND;
    }
    if (c === 'cast' && d === undefined) {
      const chapter = params.get('chapter');
      if (chapter !== null && !/^[0-9]{1,6}$/.test(chapter)) return badRequest('chapter must be a chapter number');
      const cast = await repository.getCast(b, chapter !== null ? { chapter: Number(chapter) } : {});
      return cast ? { status: 200, body: cast } : NOT_FOUND;
    }
    if (c === 'knowledge' && d === undefined) {
      const character = params.get('character');
      const at = params.get('at');
      if (character === null || character === '') return badRequest('character is required (an entry id or slug)');
      if (at !== null && !/^[0-9]{1,6}$/.test(at)) return badRequest('at must be a chapter number');
      const r = await repository.knowledgeAt(b, { character, ...(at !== null ? { at: Number(at) } : {}) });
      if (r.ok) return { status: 200, body: { character: r.character, at: r.at, facts: r.facts } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : badRequest(r.message ?? 'bad request');
    }
    if (c === 'state-events' && d === undefined) {
      const chapter = params.get('chapter');
      if (chapter !== null && chapter !== 'all' && !/^[0-9]{1,6}$/.test(chapter)) return badRequest('chapter must be a chapter number or all');
      const events = await repository.getStateEvents(b, chapter !== null && chapter !== 'all' ? { chapter: Number(chapter) } : {});
      return events ? { status: 200, body: events } : NOT_FOUND;
    }
    // M12 W6: the chapter context pack (?chapter=N, optional ?budget=<characters>); reads only
    if (c === 'context' && d === undefined) {
      const parsed = parseContextQuery(params);
      if (parsed.error) return badRequest(parsed.error);
      const pack = await repository.getContext(b, { chapter: parsed.chapter, budget: parsed.budget });
      return pack ? { status: 200, body: pack } : NOT_FOUND;
    }
    if (c === 'tasks' && d !== undefined && e === undefined) {
      const r = await repository.getTask(b, d);
      return r.ok ? { status: 200, body: { task: r.task, notes: r.notes, targets: r.targets } } : NOT_FOUND;
    }
    if (c === 'entries' && d !== undefined && e === undefined) {
      const entry = await repository.getEntry(b, d);
      return entry ? { status: 200, body: entry } : NOT_FOUND;
    }
    if (c === 'entries' && d !== undefined && e === 'image' && f === undefined) return handleEntryImage(repository, b, d, params);
    // M04-J03: threads with their scene lists and the scenes' planning fields; one thread with its text
    if (c === 'threads' && d === undefined) {
      const planning = await repository.listThreads(b);
      return planning ? { status: 200, body: planning } : NOT_FOUND;
    }
    if (c === 'threads' && d !== undefined && e === undefined) {
      const thread = await repository.getThread(b, d);
      return thread ? { status: 200, body: thread } : NOT_FOUND;
    }
    // M04-J04: the timeline, events, notes (research, planning docs, sources), scene notes and attachments
    if (c === 'timeline' && d === undefined) {
      const timeline = await repository.getTimeline(b);
      return timeline ? { status: 200, body: timeline } : NOT_FOUND;
    }
    if (c === 'events' && d !== undefined && e === undefined) {
      const event = await repository.getEvent(b, d);
      return event ? { status: 200, body: event } : NOT_FOUND;
    }
    if (c === 'notes' && d === undefined) {
      const notes = await repository.listNotes(b);
      return notes ? { status: 200, body: notes } : NOT_FOUND;
    }
    if (c === 'notes' && d !== undefined && e === undefined) {
      const note = await repository.getNote(b, d);
      return note ? { status: 200, body: note } : NOT_FOUND;
    }
    if (c === 'scene-notes' && d === undefined) {
      const notes = await repository.getSceneNotes(b);
      return notes ? { status: 200, body: notes } : NOT_FOUND;
    }
    if (c === 'attachments' && d === undefined) return handleAttachment(repository, b, params);
    // M09-J01: canvases (planning/canvases/<slug>.canvas)
    if (c === 'canvases' && d === undefined) {
      const list = await repository.listCanvases(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'canvases' && d !== undefined && e === undefined) {
      const canvas = await repository.getCanvas(b, d);
      return canvas ? { status: 200, body: canvas } : NOT_FOUND;
    }
    // M12 W2: workspace docs (planning/workspace, planning/state, planning/development); reads are not module-gated, like every read
    if (c === 'workspace' && d === 'docs' && e === undefined) {
      const addr = params.get('path');
      if (addr === null) {
        const list = await repository.listWorkspaceDocs(b);
        return list ? { status: 200, body: list } : NOT_FOUND;
      }
      const doc = await repository.getWorkspaceDoc(b, addr);
      return doc ? { status: 200, body: doc } : NOT_FOUND;
    }
    // Story Planner M1 (ADR 0003 D05): causal links, scene plans and the flow projection (reads are not module-gated, like every read)
    if (c === 'links' && d === undefined) {
      const list = await repository.listLinks(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'links' && d !== undefined && e === undefined) {
      const link = await repository.getLink(b, d);
      return link ? { status: 200, body: link } : NOT_FOUND;
    }
    if (c === 'scene-plans' && d !== undefined && e === undefined) {
      const plan = await repository.getScenePlan(b, d);
      return plan ? { status: 200, body: plan } : NOT_FOUND;
    }
    if (c === 'flow' && d === undefined) {
      const flow = await repository.flowGraph(b);
      return flow ? { status: 200, body: flow } : NOT_FOUND;
    }
    // Story Planner M2: the book's story plan (planning/story.md) and the Plan overview (story plan + counts)
    if (c === 'story-plan' && d === undefined) {
      const plan = await repository.getStoryPlan(b);
      return plan ? { status: 200, body: plan } : NOT_FOUND;
    }
    if (c === 'plan-overview' && d === undefined) {
      const overview = await repository.planOverview(b);
      return overview ? { status: 200, body: overview } : NOT_FOUND;
    }
    // Story Planner M3: character arcs (planning/arcs/<slug>.md)
    if (c === 'arcs' && d === undefined) {
      const list = await repository.listArcs(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'arcs' && d !== undefined && e === undefined) {
      const arc = await repository.getArc(b, d);
      return arc ? { status: 200, body: arc } : NOT_FOUND;
    }
    // Story Planner M4: structure templates (built-in data) and structures (planning/structures/<slug>.md)
    if (c === 'structure-templates' && d === undefined) return { status: 200, body: { templates: repository.listStructureTemplates() } };
    if (c === 'structures' && d === undefined) {
      const list = await repository.listStructures(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'structures' && d !== undefined && e === undefined) {
      const structure = await repository.getStructure(b, d);
      return structure ? { status: 200, body: structure } : NOT_FOUND;
    }
    // Story Planner M5: relationship developments (planning/relationships/<slug>.md) and the planner badges for Board, Outline and Matrix
    if (c === 'relationships' && d === undefined) {
      const list = await repository.listRelationships(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'relationships' && d !== undefined && e === undefined) {
      const rel = await repository.getRelationship(b, d);
      return rel ? { status: 200, body: rel } : NOT_FOUND;
    }
    // Story Planner M7: synopses (planning/synopses/<slug>.md) and their offline extraction from the plan (writes nothing)
    if (c === 'synopses' && d === undefined) {
      const list = await repository.listSynopses(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'synopses' && d !== undefined && e === undefined) {
      const syn = await repository.getSynopsis(b, d);
      return syn ? { status: 200, body: syn } : NOT_FOUND;
    }
    if (c === 'synopses' && d !== undefined && e === 'extract') {
      const ex = await repository.extractSynopsis(b, d);
      return ex ? { status: 200, body: ex } : NOT_FOUND;
    }
    // Story Planner M8: clues (planning/clues/<slug>.md) and the read-only series view (book-scope.mjs narrows it to the member's books)
    if (c === 'clues' && d === undefined) {
      const list = await repository.listClues(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    if (c === 'clues' && d !== undefined && e === undefined) {
      const clue = await repository.getClue(b, d);
      return clue ? { status: 200, body: clue } : NOT_FOUND;
    }
    if (c === 'series-plan' && d === undefined) {
      const plan = await repository.seriesPlan(b);
      return plan ? { status: 200, body: { hidden: 0, ...plan } } : NOT_FOUND;
    }
    if (c === 'plan-badges' && d === undefined) {
      const badges = await repository.planBadges(b);
      return badges ? { status: 200, body: badges } : NOT_FOUND;
    }
    // M05-J04 status; M08-J03: the cover generator's state, a draft picture, and a streamed reply in progress
    if (c === 'ai' && ['status', 'cover', 'cover-draft', 'stream'].includes(d) && e === undefined) return handleAiRead(repository, state, d, b, params);
    if (c === 'graph' && d === undefined) {
      const kindsParam = params.get('kinds');
      let kinds;
      if (kindsParam !== null) {
        kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
        if (kinds.length === 0 || kinds.some((k) => !GRAPH_EDGE_KINDS.includes(k))) return badRequest(`kinds must be a comma-separated list of: ${GRAPH_EDGE_KINDS.join(', ')}`);
      }
      const node = params.get('node');
      const graph = await repository.getGraph(b, { ...(node !== null ? { node } : {}), ...(kinds ? { kinds } : {}) });
      return graph ? { status: 200, body: graph } : NOT_FOUND;
    }
    if (c === 'codex' && d === 'types' && e === undefined) {
      const types = await repository.getCodexTypes(b);
      return types ? { status: 200, body: types } : NOT_FOUND;
    }
    if (c === 'codex' && d === 'entries' && e === undefined) {
      const list = await repository.listCodexEntries(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
    }
    // M07-J01b: the labels of the book and its series; what a link picker offers (this book, its series' shared entries, other books)
    if (c === 'labels' && d === undefined) {
      const labels = await repository.getLabels(b);
      return labels ? { status: 200, body: labels } : NOT_FOUND;
    }
    if (c === 'link-targets' && d === undefined) {
      const targets = await repository.getLinkTargets(b);
      return targets ? { status: 200, body: targets } : NOT_FOUND;
    }
    if (c === 'backlinks' && d !== undefined) {
      return fromIndex(() => repository.getBacklinks(b, d));
    }
    if (c === 'mentions' && d === undefined) {
      const entry = params.get('entry');
      const scene = params.get('scene');
      return fromIndex(() =>
        repository.getMentions(b, { ...(entry !== null ? { entryId: entry } : {}), ...(scene !== null ? { sceneId: scene } : {}) }),
      );
    }
  }
  return NOT_FOUND;
}

const DOWNLOAD_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; sandbox",
};

/** @param {{ bytes: Buffer, filename: string, mime: string }} file */
const download = (file) => ({
  status: 200,
  body: null,
  raw: { bytes: file.bytes, headers: { ...DOWNLOAD_HEADERS, 'content-type': file.mime, 'content-disposition': `attachment; filename="${file.filename}"` } },
});

/** `0` / `1` (or absent) to a boolean; null when it is anything else. @param {string | null} v */
const flag = (v) => (v === null || v === '0' ? false : v === '1' ? true : null);

/**
 * GET /api/books/:b/export?format=markdown|docx|epub|pdf[&excludeStatuses=a,b][&sceneTitles=0|1][&page=letter|a4][&include=manuscript|summary|evidence][&scenes=id,id]: the manuscript as a download
 * (M05-J07: `summary` appends a provenance summary; `evidence` is a private zip of the manuscript, receipts, verify.json and README.txt).
 * Read-only: the book folder is never written. 400 bad parameters, 404 unknown book, 500 { error: 'export_failed', problems } when verification fails.
 */
async function handleExport(repository, bookId, params) {
  const format = params.get('format');
  if (format === null || !Object.hasOwn(FORMATS, format)) return badRequest(`format must be one of: ${Object.keys(FORMATS).join(', ')}`);
  const sceneTitles = flag(params.get('sceneTitles'));
  if (sceneTitles === null) return badRequest('sceneTitles must be 0 or 1');
  const page = params.get('page') ?? 'letter';
  if (page !== 'letter' && page !== 'a4') return badRequest('page must be letter or a4');
  const statusParam = params.get('excludeStatuses');
  const excludeStatuses = statusParam === null || statusParam === '' ? [] : statusParam.split(',').map((x) => x.trim());
  if (excludeStatuses.some((x) => !/^[A-Za-z0-9_-]{1,40}$/.test(x))) return badRequest('excludeStatuses must be a comma-separated list of status names');
  const include = params.get('include') ?? 'manuscript';
  if (!INCLUDE_MODES.includes(include)) return badRequest(`include must be one of: ${INCLUDE_MODES.join(', ')}`);
  const sceneParam = params.get('scenes');
  const sceneIds = sceneParam === null || sceneParam === '' ? undefined : sceneParam.split(',').map((x) => x.trim());
  if (sceneIds?.some((x) => !/^[A-Za-z0-9_-]{1,80}$/.test(x))) return badRequest('scenes must be a comma-separated list of scene ids');
  const root = await repository.bookRoot(bookId);
  if (!root) return NOT_FOUND;
  try {
    const verify = include === 'evidence' && typeof repository.verifyReceipts === 'function' ? await repository.verifyReceipts(bookId) : undefined;
    return download(await exportBook(root, format, { excludeStatuses, sceneTitles, page, include, sceneIds, verify }));
  } catch (e) {
    if (e instanceof ExportVerificationError) return { status: 500, body: { error: 'export_failed', problems: e.problems } };
    if (e instanceof ExportError) return e.code === 'NOT_A_BOOK' ? NOT_FOUND : badRequest(e.message);
    throw e;
  }
}

/** GET /api/books/:b/backup[?provenance=0|1]: the book folder as a zip (no .storyforge/; provenance/ only when asked). */
async function handleBackup(repository, bookId, params) {
  const provenance = flag(params.get('provenance'));
  if (provenance === null) return badRequest('provenance must be 0 or 1');
  const root = await repository.bookRoot(bookId);
  if (!root) return NOT_FOUND;
  const { bytes, filename } = await createBackup(root, { includeProvenance: provenance });
  return download({ bytes, filename, mime: 'application/zip' });
}

/**
 * GET /api/books/:b/export/planning (Story Planner M8): the plan as a zip of Markdown files. Separate from the manuscript exports, which never include planning.
 * Read only; built from the planner reads, nothing written.
 */
async function handlePlanningExport(repository, bookId) {
  const book = await repository.getBook(bookId);
  if (!book) return NOT_FOUND;
  const [story, flow, arcs, relationships, structures, synopses, clues, links] = await Promise.all([
    repository.getStoryPlan(bookId), repository.flowGraph(bookId), repository.listArcs(bookId), repository.listRelationships(bookId),
    repository.listStructures(bookId), repository.listSynopses(bookId), repository.listClues(bookId), repository.listLinks(bookId),
  ]);
  const primary = (structures?.structures ?? []).find((/** @type {any} */ x) => x.primary) ?? null;
  const structure = primary ? await repository.getStructure(bookId, primary.slug) : null;
  const fullSynopses = [];
  for (const x of synopses?.synopses ?? []) {
    const one = await repository.getSynopsis(bookId, x.slug);
    if (one) fullSynopses.push({ slug: one.slug, type: one.type, name: one.name, body: one.body });
  }
  const sceneNodes = (flow?.nodes ?? []).filter((/** @type {any} */ n) => n.kind === 'scene');
  const scenePlans = new Map();
  for (const n of sceneNodes) if (n.plan) scenePlans.set(n.id, await repository.getScenePlan(bookId, n.id));
  const titles = new Map(sceneNodes.map((/** @type {any} */ n) => [n.id, n.title]));
  const data = {
    book: { title: book.title, slug: book.slug },
    story: story ?? { fields: {}, body: '' },
    scenes: sceneNodes.map((/** @type {any} */ n) => ({ id: n.id, title: n.title, act: n.act, chapter: n.chapter, sequence: n.sequence, summary: n.summary ?? null, plan: scenePlans.get(n.id)?.fields ?? null })),
    arcs: arcs?.arcs ?? [],
    relationships: relationships?.relationships ?? [],
    structure,
    synopses: fullSynopses,
    clues: clues?.clues ?? [],
    links: (links?.links ?? []).map((/** @type {any} */ l) => ({ from_title: titles.get(l.from) ?? l.from, to_title: titles.get(l.to) ?? l.to, relation: l.relation, branch: l.branch ?? null, rationale: l.rationale ?? null })),
  };
  const { bytes, filename } = planningZip(data);
  return download({ bytes, filename, mime: 'application/zip' });
}

/** GET /api/books/:b/cover[?v=<sha8>]: the cover image bytes. Only a supported image under the book's assets/ is ever served. */
async function handleCover(repository, bookId, params) {
  const cover = await repository.getCover(bookId);
  if (!cover) return NOT_FOUND;
  if ('error' in cover) return { status: 404, body: { error: 'too_large' } };
  const current = params.get('v') === cover.sha256.slice(0, 8);
  return {
    status: 200,
    body: null,
    raw: {
      bytes: cover.bytes,
      headers: {
        'content-type': cover.contentType,
        'x-content-type-options': 'nosniff',
        'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache',
      },
    },
  };
}

/**
 * GET /api/books/:b/attachments?path=assets/...: a file of the book's assets/ folder. Only an allowlisted extension (png jpg jpeg webp gif pdf txt md csv; never SVG)
 * whose real path is inside assets/ is served; images inline, everything else as a download; always nosniff and a sandboxing CSP. Anything else is 404.
 */
async function handleAttachment(repository, bookId, params) {
  const file = params.get('path');
  if (file === null) return badRequest('path is required');
  const a = await repository.getAttachment(bookId, file);
  if (!a || 'error' in a) return NOT_FOUND;
  const name = a.name.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    status: 200,
    body: null,
    raw: {
      bytes: a.bytes,
      headers: {
        'content-type': a.contentType,
        'x-content-type-options': 'nosniff',
        'content-disposition': a.inline ? `inline; filename="${name}"` : `attachment; filename="${name}"`,
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-cache',
      },
    },
  };
}

/** GET /api/books/:b/entries/:id/image[?v=<sha8>]: the image bytes of an entry's `image` field (only a supported image under assets/). */
async function handleEntryImage(repository, bookId, ref, params) {
  const image = await repository.getEntryImage(bookId, ref);
  if (!image) return NOT_FOUND;
  if ('error' in image) return { status: 404, body: { error: 'too_large' } };
  const current = params.get('v') === image.sha256.slice(0, 8);
  return {
    status: 200,
    body: null,
    raw: {
      bytes: image.bytes,
      headers: {
        'content-type': image.contentType,
        'x-content-type-options': 'nosniff',
        'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache',
      },
    },
  };
}

const OBJECT_KINDS = ['entry', 'thread', 'event'];
const GRAPH_EDGE_KINDS = ['explicit', 'inferred'];
const SEARCH_KINDS = ['scene', 'entry', 'thread', 'event', 'doc', 'research'];
const badRequest = (message) => ({ status: 400, body: { error: 'bad_request', message } });

/** GET /api/search?q=&book=&kinds=scene,entry&limit= @param {FileRepository} repository @param {URLSearchParams} params */
async function handleSearch(repository, params) {
  const q = params.get('q');
  if (q === null || q.trim() === '' || q.length > 200) return badRequest('q is required and must be 1 to 200 characters');
  const kindsParam = params.get('kinds');
  let kinds;
  if (kindsParam !== null) {
    kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
    if (kinds.length === 0 || kinds.some((k) => !SEARCH_KINDS.includes(k))) {
      return badRequest(`kinds must be a comma-separated list of: ${SEARCH_KINDS.join(', ')}`);
    }
  }
  let limit;
  const limitParam = params.get('limit');
  if (limitParam !== null) {
    if (!/^[0-9]+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > 100) return badRequest('limit must be an integer from 1 to 100');
    limit = Number(limitParam);
  }
  const bookId = params.get('book');
  const hits = await repository.search(q, { ...(bookId !== null ? { bookId } : {}), ...(kinds ? { kinds } : {}), ...(limit !== undefined ? { limit } : {}) });
  return { status: 200, body: hits };
}

/** Index-backed reads: null means unknown book (404); no usable index yet means 503 (a rebuild has started). */
async function fromIndex(read) {
  try {
    const value = await read();
    return value === null ? NOT_FOUND : { status: 200, body: value };
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'INDEX_NOT_READY') return { status: 503, body: { error: 'index_not_ready' } };
    throw e;
  }
}

/**
 * M12 W6: the query of the context pack, ?chapter=N (required, a chapter number) and ?budget=<characters> (optional, MIN_BUDGET to MAX_BUDGET; the default when left out).
 * @param {URLSearchParams} params @returns {{ chapter: number, budget: number, error?: undefined } | { error: string }}
 */
export function parseContextQuery(params) {
  const chapter = params.get('chapter');
  if (chapter === null || !/^[0-9]{1,6}$/.test(chapter)) return { error: 'chapter is required and must be a chapter number' };
  const budget = params.get('budget');
  if (budget !== null && (!/^[0-9]{1,7}$/.test(budget) || Number(budget) < MIN_BUDGET || Number(budget) > MAX_BUDGET)) return { error: `budget must be a number of characters from ${MIN_BUDGET} to ${MAX_BUDGET}` };
  return { chapter: Number(chapter), budget: budget === null ? DEFAULT_BUDGET : Number(budget) };
}

// ---------------------------------------------------------------- write routes

/**
 * Which write route (if any) a method + path is. Anything else non-GET stays 405.
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: string, profileId?: string, bookId?: string, commentId?: string, sceneId?: string, entryId?: string, threadId?: string, eventId?: string, noteId?: string, n?: string, opId?: string, file?: string, goalId?: string, taskId?: string, tokenId?: string, webhookId?: string } | null}
 */
export function matchWriteRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((p) => p === null) || parts[0] !== 'api') return null;
  const [, a, b, c, d, e, f, g, ...rest] = /** @type {string[]} */ (parts);
  if (rest.length > 0) return null;
  if ((f !== undefined || g !== undefined) && !(a === 'books' && ((c === 'scenes' && e === 'revisions') || (c === 'suggestions' && e === 'hunks' && g === undefined)))) return null;
  if (method === 'POST' && a === 'recover' && b === undefined) return { route: 'recover' };
  if (method === 'POST' && a === 'index' && b === 'rebuild' && c === undefined) return { route: 'index-rebuild' };
  if (method === 'POST' && a === 'books' && b === undefined) return { route: 'book-create' };
  if (method === 'POST' && a === 'library' && b === 'open' && c === undefined) return { route: 'library-open' };
  if (method === 'POST' && a === 'library' && b === 'recent' && c === 'remove' && d === undefined) return { route: 'recent-remove' };
  if (method === 'POST' && a === 'library' && b === 'restore' && c === undefined) return { route: 'backup-restore' };
  // M05-J04 optional AI workshop
  if (a === 'ai' && b === 'profiles') {
    if (method === 'POST' && c === undefined) return { route: 'ai-profile-create' };
    if (method === 'PUT' && c !== undefined && d === undefined) return { route: 'ai-profile-update', profileId: c };
    if (method === 'DELETE' && c !== undefined && d === undefined) return { route: 'ai-profile-delete', profileId: c };
    if (method === 'POST' && c !== undefined && d === 'test' && e === undefined) return { route: 'ai-profile-test', profileId: c };
    // M08-J03: list the models and learn about streaming and usage; move a plain-text key into the key store
    if (method === 'POST' && c !== undefined && d === 'discover' && e === undefined) return { route: 'ai-profile-discover', profileId: c };
    if (method === 'POST' && c !== undefined && d === 'secure' && e === undefined) return { route: 'ai-profile-secure', profileId: c };
    return null;
  }
  // M07-J04 profiles: per-machine appearance settings (a file in the user config folder, never a library file)
  if (a === 'profile' && b === undefined && method === 'PUT') return { route: 'profile-save' };
  if (a === 'profile' && b === 'switch' && c === undefined && method === 'POST') return { route: 'profile-switch' };
  if (a === 'profiles' && b !== undefined && c === undefined && method === 'DELETE') return { route: 'profile-delete', name: b };
  // OAuth for MCP: the consent page's answer (oauth-routes.mjs; server.mjs answers these itself, owner only in shared mode)
  if (a === 'oauth' && c === undefined && method === 'POST') {
    if (b === 'approve') return { route: 'oauth-approve' };
    if (b === 'deny') return { route: 'oauth-deny' };
  }
  // M08-J02 plugin access tokens and webhook subscriptions (Settings; owner only in shared mode)
  if (a === 'plugins' && b === 'grants') {
    if (method === 'POST' && c === undefined) return { route: 'plugin-grant' };
    if (method === 'DELETE' && c !== undefined && d === undefined) return { route: 'plugin-revoke', tokenId: c };
    return null;
  }
  if (a === 'webhooks') {
    if (method === 'POST' && b === undefined) return { route: 'webhook-create' };
    if (method === 'DELETE' && b !== undefined && c === undefined) return { route: 'webhook-revoke', webhookId: b };
    return null;
  }
  if (a !== 'books' || b === undefined || c === undefined) return null;
  if (c === 'ai' && e === undefined) {
    if (method === 'PUT' && d === 'profile') return { route: 'ai-book-profile', bookId: b };
    if (method === 'PUT' && d === 'records') return { route: 'ai-records', bookId: b };
    if (method === 'POST' && ['context', 'send', 'apply', 'discard'].includes(d)) return { route: `ai-${d}`, bookId: b };
    // M08-J03: stop a streamed reply; cover drafts (generate asks the image provider, only after consent; use and delete are edits of the book)
    if (method === 'POST' && d === 'cancel') return { route: 'ai-cancel', bookId: b };
    if (method === 'POST' && d === 'cover-generate') return { route: 'ai-cover-generate', bookId: b };
    if (method === 'POST' && d === 'cover-use') return { route: 'ai-cover-use', bookId: b };
    if (method === 'POST' && d === 'cover-delete') return { route: 'ai-cover-delete', bookId: b };
    return null;
  }
  if (method === 'POST' && c === 'repair' && d === undefined) return { route: 'repair', bookId: b };
  // M03-J04
  if (method === 'POST' && c === 'activity' && d === 'session' && e === undefined) return { route: 'activity-session', bookId: b };
  if (method === 'POST' && c === 'goal' && d === undefined) return { route: 'goal', bookId: b };
  // M12: the book's (or its library's default) AI level, saved as the `ai.level` project preference
  if (method === 'POST' && c === 'ai-level' && d === undefined) return { route: 'book-ai-level', bookId: b };
  // M07-J02: goals file, revision tasks
  if (method === 'POST' && c === 'goals' && d === undefined) return { route: 'goal-set', bookId: b };
  if (method === 'DELETE' && c === 'goals' && d !== undefined && e === undefined) return { route: 'goal-remove', bookId: b, goalId: d };
  if (method === 'POST' && c === 'tasks' && d === undefined) return { route: 'task-create', bookId: b };
  if (method === 'POST' && c === 'tasks' && d !== undefined && e === 'status' && f === undefined) return { route: 'task-status', bookId: b, taskId: d };
  // M12 W3: chapter cast, knowledge and state events (the chapter's state event), the AI words of the writing log
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'cast' && f === undefined) return { route: 'scene-cast', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'knowledge' && d === undefined) return { route: 'ledger-knowledge-record', bookId: b };
  if (method === 'POST' && c === 'state-events' && d === undefined) return { route: 'ledger-state-record', bookId: b };
  if (method === 'POST' && c === 'activity' && d === 'ai-words' && e === undefined) return { route: 'activity-ai-log', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'revisions' && f === undefined) return { route: 'revision-save', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'revisions' && f !== undefined && g === 'restore') return { route: 'revision-restore', bookId: b, sceneId: d, file: f };
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'body') return { route: 'body', bookId: b, sceneId: d };
  // M12 W6: replace the body of a scene the AI made and the author has not accepted (front matter origin: ai and status drafting); any other scene is refused (403 NOT_AI_DRAFT)
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'ai-draft') return { route: 'scene-ai-draft', bookId: b, sceneId: d };
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'raw') return { route: 'scene-raw', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d === undefined) return { route: 'create', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'archive') return { route: 'archive', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'archive' && d === 'restore' && e === undefined) return { route: 'restore', bookId: b };
  // M03-J01 structure commands (all POST; `dryRun: true` in the body previews without writing)
  if (method === 'POST' && c === 'scenes' && d === 'merge' && e === undefined) return { route: 'scene-merge', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'fields') return { route: 'scene-fields', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'move') return { route: 'scene-move', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'split') return { route: 'scene-split', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'chapters' && d === undefined) return { route: 'chapter-create', bookId: b };
  if (method === 'POST' && c === 'chapters' && d === 'renumber' && e === undefined) return { route: 'chapters-renumber', bookId: b };
  if (method === 'POST' && c === 'chapters' && d !== undefined && e === 'fields') return { route: 'chapter-fields', bookId: b, n: d };
  if (method === 'POST' && c === 'chapters' && d !== undefined && e === 'archive') return { route: 'chapter-archive', bookId: b, n: d };
  if (method === 'POST' && c === 'chapters' && d !== undefined && d !== 'renumber' && e === 'move') return { route: 'chapter-move', bookId: b, n: d };
  if (method === 'POST' && c === 'acts' && d === undefined) return { route: 'act-create', bookId: b };
  if (method === 'POST' && c === 'acts' && d !== undefined && e === 'fields') return { route: 'act-fields', bookId: b, n: d };
  if (method === 'POST' && c === 'ops' && d !== undefined && e === 'restore') return { route: 'op-restore', bookId: b, opId: d };
  // M04-J02 Codex entries and types
  if (method === 'POST' && c === 'entries' && d === undefined) return { route: 'entry-create', bookId: b };
  if (method === 'POST' && c === 'entries' && d === 'restore' && e === undefined) return { route: 'entry-restore', bookId: b };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'fields') return { route: 'entry-fields', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'slug') return { route: 'entry-slug', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'archive') return { route: 'entry-archive', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'restore') return { route: 'entry-restore', bookId: b, entryId: d };
  if (method === 'PUT' && c === 'entries' && d !== undefined && e === 'body') return { route: 'entry-body', bookId: b, entryId: d };
  if (method === 'POST' && c === 'codex' && d === 'types' && e === undefined) return { route: 'codex-type-create', bookId: b };
  // M07-J01b series worlds, labels, templates: Move to series, Copy into this book, a book's / series' label list, Save as template
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'move-to-series') return { route: 'entry-move-to-series', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'copy-to-book') return { route: 'entry-copy-to-book', bookId: b, entryId: d };
  if (method === 'POST' && c === 'labels' && d === undefined) return { route: 'labels-set', bookId: b };
  if (method === 'POST' && c === 'save-as-template' && d === undefined) return { route: 'template-save', bookId: b };
  // M04-J03 plot threads
  if (method === 'POST' && c === 'threads' && d === undefined) return { route: 'thread-create', bookId: b };
  if (method === 'POST' && c === 'threads' && d !== undefined && e === 'fields') return { route: 'thread-fields', bookId: b, threadId: d };
  if (method === 'PUT' && c === 'threads' && d !== undefined && e === 'body') return { route: 'thread-body', bookId: b, threadId: d };
  // M04-J04 timeline events, notes / planning docs / sources, attachments
  if (method === 'POST' && c === 'events' && d === undefined) return { route: 'event-create', bookId: b };
  if (method === 'POST' && c === 'events' && d === 'restore' && e === undefined) return { route: 'event-restore', bookId: b };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'fields') return { route: 'event-fields', bookId: b, eventId: d };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'archive') return { route: 'event-archive', bookId: b, eventId: d };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'restore') return { route: 'event-restore', bookId: b, eventId: d };
  if (method === 'PUT' && c === 'events' && d !== undefined && e === 'body') return { route: 'event-body', bookId: b, eventId: d };
  if (method === 'POST' && c === 'notes' && d === undefined) return { route: 'note-create', bookId: b };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'fields') return { route: 'note-fields', bookId: b, noteId: d };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'archive') return { route: 'note-archive', bookId: b, noteId: d };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'restore') return { route: 'note-restore', bookId: b, noteId: d };
  if (method === 'PUT' && c === 'notes' && d !== undefined && e === 'body') return { route: 'note-body', bookId: b, noteId: d };
  // M05-J02 continuity exceptions
  if (method === 'POST' && c === 'continuity' && d === 'exceptions' && e === undefined) return { route: 'continuity-exception-create', bookId: b };
  if (method === 'DELETE' && c === 'continuity' && d === 'exceptions' && e !== undefined && f === undefined) return { route: 'continuity-exception-archive', bookId: b, slug: e };
  // M12 W4: the author's continuity settings (the app only; there is no plugin route for it)
  if (method === 'POST' && c === 'continuity' && d === 'settings' && e === undefined) return { route: 'continuity-settings-save', bookId: b };
  // M05-J06 suggestions: decide one hunk or every pending hunk; check one scene (read-only report)
  if (method === 'POST' && c === 'suggestions' && d !== undefined && e === undefined) return { route: 'suggestion-decide', bookId: b, suggestionId: d };
  if (method === 'POST' && c === 'suggestions' && d !== undefined && e === 'hunks' && f !== undefined) return { route: 'suggestion-hunk-decide', bookId: b, suggestionId: d, hunkId: f };
  if (method === 'POST' && c === 'suggestions' && d === undefined) return { route: 'suggestion-create', bookId: b };
  if (method === 'POST' && c === 'check' && d === undefined) return { route: 'check-scene', bookId: b };
  // M07-J03b: comments (create, reply, resolve or reopen) and the advisory presence heartbeat
  if (method === 'POST' && c === 'comments' && d === undefined) return { route: 'comment-create', bookId: b };
  if (method === 'POST' && c === 'comments' && d !== undefined && e === undefined) return { route: 'comment-resolve', bookId: b, commentId: d };
  if (method === 'POST' && c === 'comments' && d !== undefined && e === 'replies' && f === undefined) return { route: 'comment-reply', bookId: b, commentId: d };
  if (method === 'POST' && c === 'presence' && d === undefined) return { route: 'presence', bookId: b };
  // M05-J07: "Record now" (flush the author's pending changes to a scene into a receipt)
  if (method === 'POST' && c === 'receipts' && d === 'flush' && e === undefined) return { route: 'receipts-flush', bookId: b };
  if (method === 'POST' && c === 'attachments' && d === undefined) return { route: 'attachment-upload', bookId: b };
  // M09-J01 canvases
  if (method === 'POST' && c === 'canvases' && d === undefined) return { route: 'canvas-create', bookId: b };
  if (method === 'PUT' && c === 'canvases' && d !== undefined && e === undefined) return { route: 'canvas-save', bookId: b, slug: d };
  if (method === 'POST' && c === 'canvases' && d !== undefined && e === 'archive') return { route: 'canvas-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'canvases' && d !== undefined && e === 'restore') return { route: 'canvas-restore', bookId: b, slug: d };
  // M12 W2 workspace docs: save (create or update), append, lock / unlock, archive, restore; and the starter docs
  if (method === 'POST' && c === 'workspace' && d === 'docs' && e === undefined) return { route: 'workspace-doc-save', bookId: b };
  if (method === 'POST' && c === 'workspace' && d === 'docs' && e === 'append') return { route: 'workspace-doc-append', bookId: b };
  if (method === 'POST' && c === 'workspace' && d === 'docs' && e === 'lock') return { route: 'workspace-doc-lock', bookId: b };
  if (method === 'POST' && c === 'workspace' && d === 'docs' && e === 'archive') return { route: 'workspace-doc-archive', bookId: b };
  if (method === 'POST' && c === 'workspace' && d === 'docs' && e === 'restore') return { route: 'workspace-doc-restore', bookId: b };
  if (method === 'POST' && c === 'workspace' && d === 'setup' && e === undefined) return { route: 'workspace-setup', bookId: b };
  // Story Planner M1 (ADR 0003 D05): causal links and scene plans, flat under the book
  if (method === 'POST' && c === 'links' && d === undefined) return { route: 'planner-link-create', bookId: b };
  if (method === 'POST' && c === 'links' && d !== undefined && e === undefined) return { route: 'planner-link-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'links' && d !== undefined && e === 'archive') return { route: 'planner-link-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'links' && d !== undefined && e === 'restore') return { route: 'planner-link-restore', bookId: b, slug: d };
  if (method === 'POST' && c === 'scene-plans' && d !== undefined && e === undefined) return { route: 'planner-scene-plan-save', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'story-plan' && d === undefined) return { route: 'planner-story-plan-save', bookId: b };
  if (method === 'POST' && c === 'arcs' && d === undefined) return { route: 'planner-arc-create', bookId: b };
  if (method === 'POST' && c === 'arcs' && d !== undefined && e === undefined) return { route: 'planner-arc-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'arcs' && d !== undefined && e === 'milestones') return { route: 'planner-arc-milestones', bookId: b, slug: d };
  if (method === 'POST' && c === 'arcs' && d !== undefined && e === 'archive') return { route: 'planner-arc-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'arcs' && d !== undefined && e === 'restore') return { route: 'planner-arc-restore', bookId: b, slug: d };
  if (method === 'POST' && c === 'structures' && d === undefined) return { route: 'planner-structure-create', bookId: b };
  if (method === 'POST' && c === 'structures' && d !== undefined && e === undefined) return { route: 'planner-structure-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'structures' && d !== undefined && e === 'beats') return { route: 'planner-structure-beats', bookId: b, slug: d };
  if (method === 'POST' && c === 'structures' && d !== undefined && e === 'archive') return { route: 'planner-structure-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'structures' && d !== undefined && e === 'restore') return { route: 'planner-structure-restore', bookId: b, slug: d };
  if (method === 'POST' && c === 'relationships' && d === undefined) return { route: 'planner-relationship-create', bookId: b };
  if (method === 'POST' && c === 'relationships' && d !== undefined && e === undefined) return { route: 'planner-relationship-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'relationships' && d !== undefined && e === 'developments') return { route: 'planner-relationship-developments', bookId: b, slug: d };
  if (method === 'POST' && c === 'relationships' && d !== undefined && e === 'archive') return { route: 'planner-relationship-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'relationships' && d !== undefined && e === 'restore') return { route: 'planner-relationship-restore', bookId: b, slug: d };
  if (method === 'POST' && c === 'clues' && d === undefined) return { route: 'planner-clue-create', bookId: b };
  if (method === 'POST' && c === 'clues' && d !== undefined && e === undefined) return { route: 'planner-clue-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'clues' && d !== undefined && e === 'knowers') return { route: 'planner-clue-knowers', bookId: b, slug: d };
  if (method === 'POST' && c === 'clues' && d !== undefined && e === 'archive') return { route: 'planner-clue-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'clues' && d !== undefined && e === 'restore') return { route: 'planner-clue-restore', bookId: b, slug: d };
  if (method === 'POST' && c === 'synopses' && d === undefined) return { route: 'planner-synopsis-create', bookId: b };
  if (method === 'POST' && c === 'synopses' && d !== undefined && e === undefined) return { route: 'planner-synopsis-update', bookId: b, slug: d };
  if (method === 'POST' && c === 'synopses' && d !== undefined && e === 'archive') return { route: 'planner-synopsis-archive', bookId: b, slug: d };
  if (method === 'POST' && c === 'synopses' && d !== undefined && e === 'restore') return { route: 'planner-synopsis-restore', bookId: b, slug: d };
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Map a core write result to an HTTP result. @param {any} r @param {number} okStatus @param {(r: any) => unknown} okBody */
function respond(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  if (r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', current: r.current ?? null } };
  const detail = { code: r.code, ...(r.field ? { field: r.field } : {}), ...(r.message ? { message: r.message } : {}), ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) };
  const conflicting = ['EXISTS', 'ROLLED_BACK', 'REFUSED_PATH_TAKEN', 'REFUSED_DUPLICATE_ID', 'REFUSED_STALE_ACTION', 'NO_CHAPTER_GAP', 'REFUSED_FILES_CHANGED', 'REFUSED_TRASH_MISSING', 'REFUSED_NOT_UNDOABLE', 'SLUG_TAKEN', 'TYPE_EXISTS', 'CITE_KEY_TAKEN', 'TEMPLATE_EXISTS'].includes(r.code);
  return { status: conflicting ? 409 : 400, body: { error: conflicting ? 'conflict' : 'refused', ...detail } };
}

/** A planner `fields` body: an object of string-or-null values ({} when absent), or an error message. @param {unknown} v @returns {Record<string, string | null> | string} */
function plannerFields(v) {
  if (v === undefined) return {};
  if (!isObject(v)) return 'fields must be an object';
  for (const [k, x] of Object.entries(/** @type {Record<string, unknown>} */ (v))) if (x !== null && typeof x !== 'string') return `fields.${k} must be a string or null`;
  return /** @type {Record<string, string | null>} */ (v);
}

/**
 * Like respond(), for the Story Planner writes: a duplicate link, arc or relationship is 409 with the existing one's slug, and the reference refusals are 400 with their codes.
 * @param {any} r @param {number} okStatus
 */
function respondPlanner(r, okStatus) {
  if (!r.ok && (r.code === 'REFUSED_DUPLICATE_LINK' || r.code === 'REFUSED_DUPLICATE_ARC' || r.code === 'REFUSED_DUPLICATE_RELATIONSHIP')) return { status: 409, body: { error: 'conflict', code: r.code, message: r.message, existing: r.existing ?? null } };
  // M5: a beat that is still the end of a live link cannot be removed; the links are named so the author can archive or re-point them
  if (!r.ok && r.code === 'REFUSED_BEAT_LINKED') return { status: 400, body: { error: 'refused', code: r.code, message: r.message, links: Array.isArray(r.links) ? r.links : [], archived_links: Array.isArray(r.archived_links) ? r.archived_links : [] } };
  return respond(r, okStatus, structureBody);
}

/** Like respond(), with the workspace refusals named by their codes: 409 LOCKED, 409 conflict (with the current sha256 and body). */
function respondWorkspace(r, okStatus, okBody) {
  if (!r.ok && r.code === 'LOCKED') return { status: 409, body: { error: 'conflict', code: 'LOCKED', message: r.message, ...(r.path ? { path: r.path } : {}) } };
  if (!r.ok && r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', code: 'CONFLICT', ...(r.message ? { message: r.message } : {}), current: r.current ?? null } };
  return respond(r, okStatus, okBody);
}

/**
 * The shape check of a beats list (M4): an array of objects whose values are strings or null, except `scenes`, an array of strings. Returns an error message or null.
 * The values themselves (lengths, ids, states, known scenes) are checked by setStructureBeats.
 * @param {unknown} v
 */
function plannerBeats(v) {
  if (!Array.isArray(v)) return 'beats must be a list';
  for (const [i, x] of v.entries()) {
    if (!isObject(x)) return `beats[${i}] must be an object`;
    for (const [k, y] of Object.entries(x)) {
      if (k === 'scenes') {
        if (!Array.isArray(y) || !y.every((s) => typeof s === 'string')) return `beats[${i}].scenes must be a list of scene ids`;
      } else if (y !== null && typeof y !== 'string') return `beats[${i}].${k} must be a string or null`;
    }
  }
  return null;
}

/**
 * M12 W4: the ?chapter=N and ?cast=<entry>:<role>,... of a continuity check. `cast` needs `chapter`. Entry is an entry id or slug; role is pov, appears or mentioned.
 * @param {URLSearchParams} params @returns {{ error: string, opts?: undefined } | { error?: undefined, opts: { chapter?: number, cast?: { entry: string, role: string }[] } }}
 */
export function continuityOptions(params) {
  const chapter = params.get('chapter');
  const cast = params.get('cast');
  if (chapter !== null && !/^[0-9]{1,6}$/.test(chapter)) return { error: 'chapter must be a chapter number' };
  if (cast !== null && chapter === null) return { error: 'cast needs a chapter' };
  /** @type {{ entry: string, role: string }[] | undefined} */
  let list;
  if (cast !== null) {
    list = [];
    for (const part of cast.split(',').filter((x) => x !== '')) {
      const at = part.lastIndexOf(':');
      const entry = at > 0 ? part.slice(0, at).trim() : '';
      const role = at > 0 ? part.slice(at + 1).trim() : '';
      if (entry === '' || !['pov', 'appears', 'mentioned'].includes(role)) return { error: 'cast must be <entry>:<role> pairs separated by commas; role is pov, appears or mentioned' };
      list.push({ entry, role });
    }
    if (list.length > 200) return { error: 'cast has too many entries' };
  }
  return { opts: { ...(chapter !== null ? { chapter: Number(chapter) } : {}), ...(list ? { cast: list } : {}) } };
}

/** Like respond(), with the continuity refusals named by their codes: 404 FINDING_NOT_FOUND, 409 ALREADY_EXCEPTED, 400 RATIONALE_REQUIRED. */
function respondContinuity(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  const named = { FINDING_NOT_FOUND: 404, ALREADY_EXCEPTED: 409, RATIONALE_REQUIRED: 400 };
  if (named[r.code]) return { status: named[r.code], body: { error: r.code, code: r.code, message: r.message } };
  return respond(r, okStatus, okBody);
}

/** Like respond(), with the suggestion refusals named by their codes (409 SUGGESTION_STALE, ALREADY_DECIDED, TARGET_MISSING, NO_CHANGE). */
function respondSuggestion(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  const named = { SUGGESTION_STALE: 409, ALREADY_DECIDED: 409, TARGET_MISSING: 409, ROLLED_BACK: 409, NO_CHANGE: 409, BAD_ARGS: 400 };
  if (named[r.code]) return { status: named[r.code], body: { error: r.code, code: r.code, message: r.message, ...(r.hunkId ? { hunkId: r.hunkId } : {}), ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) } };
  return respond(r, okStatus, okBody);
}

/**
 * @param {FileRepository} repository
 * @param {{ route: string, bookId?: string, sceneId?: string, entryId?: string, threadId?: string, n?: string, opId?: string, file?: string }} match from matchWriteRoute
 * @param {unknown} body parsed JSON request body
 * @param {ApiState} [state] updated by POST /api/recover
 * @param {{ principal?: { kind: string, id: string, display_name?: string, role?: string } | null }} [ctx] shared mode (M07-J03b): who is asking. Personal mode passes nothing and
 *   keeps its behaviour exactly (a stale save is the plain 409 `conflict`; no `by`).
 * @returns {Promise<ApiResult>}
 */
export async function handleWrite(repository, match, body, state, ctx = {}) {
  if (!isObject(body)) return badRequest('body must be a JSON object');
  if (match.route.startsWith('profile-')) return handleProfileWrite(match, body, state); // M07-J04: a file in the user config folder, no library file
  if (match.route.startsWith('plugin-') || match.route.startsWith('webhook-')) return handleIntegrationsWrite(repository, match, body, state); // M08-J02: files in the user config (or shared-data) folder, no library file
  const off = await checkModule(repository, state, match); // M07-J04: a write of a module that is off is refused (403 MODULE_OFF) before anything runs
  if (off) return off;
  const bookId = /** @type {string} */ (match.bookId);
  switch (match.route) {
    case 'recover': {
      const report = await repository.recover();
      if (state) state.lastRecover = report;
      return { status: 200, body: report };
    }
    case 'index-rebuild': {
      if (body.book !== undefined && typeof body.book !== 'string') return badRequest('book must be a string');
      const r = await repository.rebuildIndex(body.book);
      if (r.code === 'NOT_FOUND') return NOT_FOUND;
      return { status: 200, body: r };
    }
    case 'book-create': {
      const r = await repository.createBook(body);
      if (r.ok) return { status: 201, body: { ok: true, bookId: r.bookId, path: r.path } };
      const taken = ['FOLDER_EXISTS', 'SLUG_TAKEN', 'SERIES_NUMBER_TAKEN'].includes(r.code);
      const mine = ['BAD_TITLE', 'BAD_SLUG', 'NO_SUCH_SERIES', 'NO_SUCH_PEN_NAME', 'NO_SUCH_TEMPLATE', 'OUTSIDE_ROOT'].includes(r.code);
      return {
        status: taken ? 409 : mine ? 400 : 500,
        body: { ok: false, code: r.code, field: r.field ?? null, message: r.message ?? '', ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) },
      };
    }
    case 'library-open': {
      if (!state?.host) return NOT_SUPPORTED;
      if (typeof body.path !== 'string' || body.path.trim() === '') return badRequest('path is required');
      const r = await state.host.open(body.path);
      if (r.ok) {
        if (r.recover) state.lastRecover = r.recover;
        state.instance = { ...(state.instance ?? { pid: process.pid, started_at: new Date().toISOString() }), lock: r.lock };
        return { status: 200, body: { ok: true, library: r.library } };
      }
      const status = r.code === 'LOCKED' ? 409 : r.code === 'OPEN_FAILED' ? 500 : 400;
      return { status, body: { ok: false, code: r.code, message: r.message, ...(r.holder !== undefined ? { holder: r.holder } : {}) } };
    }
    case 'recent-remove': {
      if (!state?.host) return NOT_SUPPORTED;
      if (typeof body.path !== 'string' || body.path.trim() === '') return badRequest('path is required');
      await state.host.removeRecent(body.path);
      return { status: 200, body: { ok: true } };
    }
    case 'repair': {
      if (!Array.isArray(body.actions)) return badRequest('expected { actions: [...] }');
      const r = await repository.applyRepair(bookId, body.actions);
      return respond(r, 200, (x) => ({ ok: true, changes: x.changes ?? [], opId: x.opId ?? null }));
    }
    case 'body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateSceneBody(bookId, /** @type {string} */ (match.sceneId), body.body, { baseSha256: body.base_sha256 });
      if (!r.ok && r.code === 'CONFLICT' && ctx.principal?.kind === 'user') {
        // shared mode (contract M07-J03 section 7): the file moved on since this buffer was loaded. Keep BOTH versions: the file stays as it is, and the buffer is
        // written as a suggestion against it (source author, rationale "Saved over a newer version"); the editor opens the compare view from the 409.
        const kept = await repository.suggestFromStaleSave(bookId, /** @type {string} */ (match.sceneId), body.body);
        return {
          status: 409,
          body: {
            error: 'STALE',
            code: 'STALE',
            message: kept.ok ? 'Someone saved this scene first. Your text was kept as a suggestion against their version.' : 'Someone saved this scene first. Your text could not be kept as a suggestion; it is still in your editor.',
            current: r.current ?? null,
            kept: Boolean(kept.ok),
            suggestion: kept.ok ? kept.suggestion : null,
          },
        };
      }
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: x.words ?? { added: 0, removed: 0 } }));
    }
    case 'entry-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateEntryBody(bookId, /** @type {string} */ (match.entryId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'thread-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateThreadBody(bookId, /** @type {string} */ (match.threadId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'event-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateEventBody(bookId, /** @type {string} */ (match.eventId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'note-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateNoteBody(bookId, /** @type {string} */ (match.noteId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'activity-session': {
      // M07-J02: { start, end, kind, scenes } adds a row to activity/sessions/; the old { minutes } body works as before
      if (body.start !== undefined || body.end !== undefined || body.kind !== undefined) {
        const r = await repository.recordSessionRow(bookId, { start: /** @type {any} */ (body.start), end: /** @type {any} */ (body.end), kind: /** @type {any} */ (body.kind), scenes: /** @type {any} */ (body.scenes) });
        return respond(r, 200, (x) => ({ ok: true, row: x.row }));
      }
      if (!Number.isInteger(body.minutes)) return badRequest('expected { minutes: integer >= 1 } or { start, end, kind, scenes }');
      const r = await repository.recordSession(bookId, /** @type {number} */ (body.minutes));
      return respond(r, 200, () => ({ ok: true }));
    }
    case 'goal-set': {
      if (!isObject(body.goal)) return badRequest('expected { goal: { id?, kind, target, period, due?, scope? } }');
      const r = await repository.setGoal(bookId, /** @type {any} */ (body.goal));
      return respond(r, 200, (x) => ({ ok: true, goal: x.goal }));
    }
    case 'goal-remove': {
      const r = await repository.removeGoal(bookId, /** @type {string} */ (match.goalId));
      return respond(r, 200, (x) => ({ ok: true, removed: x.removed }));
    }
    case 'task-create': {
      const r = await repository.createTask(bookId, body);
      if (!r.ok && r.code === 'TASK_EXISTS') return { status: 409, body: { error: 'TASK_EXISTS', code: r.code, message: r.message, existing: r.existing } };
      if (!r.ok && r.code === 'FINDING_NOT_FOUND') return { status: 404, body: { error: r.code, code: r.code, message: r.message } };
      return respond(r, 201, (x) => (x.dryRun ? { ok: true, dryRun: true, file: x.file, text: x.text } : { ok: true, id: x.id, slug: x.slug, file: x.file, opId: x.opId ?? null }));
    }
    case 'task-status': {
      if (typeof body.status !== 'string') return badRequest("expected { status: 'open' | 'doing' | 'done' | 'dropped' }");
      if (body.for !== undefined && !['ai', 'author'].includes(/** @type {any} */ (body.for))) return badRequest('for must be ai or author');
      const r = await repository.setTaskStatus(bookId, /** @type {string} */ (match.taskId), body.status, body.for !== undefined ? { for: /** @type {string} */ (body.for) } : {});
      return respond(r, 200, (x) => ({ ok: true, id: x.id, slug: x.slug, status: x.status, for: x.for, path: x.path }));
    }
    // ---- M12 W3. scene-cast writes only the scene's `cast` key (never prose); the ledger routes only append state items to the chapter's "Chapter N (state)" event; activity-ai-log adds AI words to today's row.
    case 'scene-cast': {
      if (!Array.isArray(body.cast)) return badRequest('expected { cast: [{ entry, role }], base_sha256?: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.setSceneCast(bookId, /** @type {string} */ (match.sceneId), { cast: body.cast, baseSha256: body.base_sha256, dryRun: body.dryRun === true });
      return respond(r, 200, structureBody);
    }
    case 'ledger-knowledge-record': {
      if (typeof body.character !== 'string' || typeof body.fact !== 'string' || !Number.isInteger(body.chapter)) return badRequest('expected { character: entry id or slug, fact: string, chapter: integer >= 0 }');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.recordKnowledge(bookId, { character: body.character, fact: body.fact, chapter: /** @type {number} */ (body.chapter), dryRun: body.dryRun === true });
      return respond(r, 200, structureBody);
    }
    case 'ledger-state-record': {
      if (!Number.isInteger(body.chapter) || !Array.isArray(body.items)) return badRequest('expected { chapter: integer >= 0, items: [{ subject, kind, value? }] }');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.recordStateEvents(bookId, { chapter: /** @type {number} */ (body.chapter), items: body.items, dryRun: body.dryRun === true });
      return respond(r, 200, structureBody);
    }
    case 'activity-ai-log': {
      if (!Number.isInteger(body.words)) return badRequest('expected { words: integer >= 1, chapter?: integer, note?: string }');
      const r = await repository.recordAiWords(bookId, { words: /** @type {number} */ (body.words), ...(body.chapter !== undefined ? { chapter: /** @type {any} */ (body.chapter) } : {}), ...(body.note !== undefined ? { note: /** @type {any} */ (body.note) } : {}) });
      return respond(r, 200, structureBody);
    }
    case 'goal': {
      if (body.daily_word_goal === undefined || (body.daily_word_goal !== null && !Number.isInteger(body.daily_word_goal))) {
        return badRequest('expected { daily_word_goal: integer >= 1 }');
      }
      const r = await repository.setDailyGoal(bookId, body.daily_word_goal);
      return respond(r, 200, (x) => ({ ok: true, daily_word_goal: x.daily_word_goal }));
    }
    case 'book-ai-level': {
      if (body.level !== null && !AI_LEVELS.includes(/** @type {any} */ (body.level))) return badRequest(`expected { level: ${AI_LEVELS.join(' | ')} | null, scope?: 'book' | 'library' }`);
      if (body.scope !== undefined && body.scope !== 'book' && body.scope !== 'library') return badRequest("scope must be 'book' or 'library'");
      const r = await repository.setAiLevel(bookId, body.level, { scope: body.scope ?? 'book' });
      return respond(r, 200, (x) => ({ ok: true, level: x.level, scope: x.scope }));
    }
    case 'revision-save': {
      if (body.label !== undefined && typeof body.label !== 'string') return badRequest('label must be a string');
      if (body.reason !== undefined && body.reason !== 'manual' && body.reason !== 'external') return badRequest("reason must be 'manual' or 'external'");
      const r = await repository.saveRevision(bookId, /** @type {string} */ (match.sceneId), { label: body.label, ...(body.reason !== undefined ? { reason: body.reason } : {}) });
      return respond(r, r.ok && r.stored ? 201 : 200, (x) => ({ ok: true, stored: x.stored, revision: x.revision }));
    }
    case 'revision-restore': {
      if (body.mode !== 'into' && body.mode !== 'new') return badRequest("mode must be 'into' or 'new'");
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      if (body.mode === 'into' && body.base_sha256 === undefined) return badRequest('expected { mode, base_sha256: string }');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const dryRun = body.dryRun === true;
      const r = await repository.restoreRevision(bookId, /** @type {string} */ (match.sceneId), /** @type {string} */ (match.file), { mode: body.mode, baseSha256: body.base_sha256, dryRun });
      return respond(r, body.mode === 'new' && !dryRun ? 201 : 200, structureBody);
    }
    case 'scene-raw': {
      if (typeof body.content !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { content: string, base_sha256: string }');
      const r = await repository.writeSceneRaw(bookId, /** @type {string} */ (match.sceneId), body.content, { baseSha256: body.base_sha256 });
      if (!r.ok && r.code === 'ROLLED_BACK') {
        // the edit would leave the book with new errors: nothing was kept
        return { status: 422, body: { error: 'invalid', code: r.code, message: r.message ?? 'the change would introduce new errors', diagnostics: r.diagnostics ?? [] } };
      }
      return respond(r, 200, (x) => ({ sha256: x.sha256 }));
    }
    case 'scene-ai-draft': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string' || body.base_sha256 === '') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateAiDraftBody(bookId, /** @type {string} */ (match.sceneId), body.body, { baseSha256: body.base_sha256 });
      if (!r.ok && r.code === 'NOT_AI_DRAFT') return { status: 403, body: { error: 'forbidden', code: 'NOT_AI_DRAFT', message: r.message } };
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: x.words }));
    }
    case 'create': {
      const { chapter, act, after, title, slug, body: text, status, summary, origin } = body;
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      if (origin !== undefined && origin !== 'ai' && origin !== 'author') return badRequest("origin must be 'ai' or 'author'");
      const dryRun = body.dryRun === true;
      const r = await repository.createScene(bookId, { chapter, act, after, title, slug, body: text, ...(status !== undefined ? { status } : {}), ...(summary !== undefined ? { summary } : {}), ...(origin !== undefined ? { origin } : {}), dryRun });
      return dryRun ? respond(r, 200, structureBody) : respond(r, 201, (x) => ({ id: x.id, path: x.path }));
    }
    case 'archive': {
      if (typeof body.base_sha256 !== 'string') return badRequest('expected { base_sha256: string }');
      const r = await repository.archiveScene(bookId, /** @type {string} */ (match.sceneId), { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ path: x.path }));
    }
    case 'restore': {
      if (typeof body.path !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { path: string, base_sha256: string }');
      const r = await repository.restoreScene(bookId, body.path, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ path: x.path }));
    }
    // ---- M05-J06: decide a suggestion (the only canonical write is the accepted hunk's lines); check a scene (writes nothing)
    case 'suggestion-decide':
    case 'suggestion-hunk-decide': {
      if (body.decision !== 'accept' && body.decision !== 'decline') return badRequest("expected { decision: 'accept' | 'decline' }");
      const r = await repository.decideSuggestion(bookId, /** @type {string} */ (match.suggestionId), { decision: body.decision, ...(match.route === 'suggestion-hunk-decide' ? { hunkId: match.hunkId } : {}) });
      return respondSuggestion(r, 200, (x) => ({ ok: true, decision: x.decision, hunkIds: x.hunkIds, opId: x.opId ?? null, undo: x.undo ?? null, suggestion: x.suggestion ?? null }));
    }
    // ---- M07-J03b: a suggestion made by a person (a reviewer's "Suggest change"), comments, and the presence heartbeat
    case 'suggestion-create': {
      if (typeof body.target !== 'string' || body.target === '') return badRequest('expected { target: string, proposedText | proposedRange, rationale? }');
      if (body.rationale !== undefined && typeof body.rationale !== 'string') return badRequest('rationale must be a string');
      if (body.expect_sha256 !== undefined && typeof body.expect_sha256 !== 'string') return badRequest('expect_sha256 must be a string');
      // the server decides the source from the role; the client cannot claim another
      const source = ctx.principal?.kind === 'user' && ctx.principal.role === 'reviewer' ? 'reviewer' : 'author';
      const r = await repository.createSuggestion(bookId, {
        target: body.target,
        ...(body.proposedText !== undefined ? { proposedText: body.proposedText } : {}),
        ...(body.proposedRange !== undefined ? { proposedRange: body.proposedRange } : {}),
        ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
        ...(body.expect_sha256 !== undefined ? { expectSha256: body.expect_sha256 } : {}),
        source,
        mode: 'suggest',
      });
      return respondSuggestion(r, 201, (x) => ({ ok: true, id: x.id, path: x.path, status: x.status, hunks: x.hunks }));
    }
    case 'comment-create': {
      if (typeof body.target !== 'string' || typeof body.text !== 'string') return badRequest('expected { target: string, line: integer, lines?: integer, quote?: string, text: string }');
      const r = await repository.createComment(bookId, { target: body.target, line: /** @type {number} */ (body.line), ...(body.lines !== undefined ? { lines: /** @type {number} */ (body.lines) } : {}), ...(body.quote !== undefined ? { quote: /** @type {string} */ (body.quote) } : {}), text: body.text });
      return respondSuggestion(r, 201, (x) => ({ ok: true, id: x.id, path: x.path, comment: x.comment }));
    }
    case 'comment-reply': {
      if (typeof body.text !== 'string') return badRequest('expected { text: string }');
      const r = await repository.replyToComment(bookId, /** @type {string} */ (match.commentId), { text: body.text });
      return respondSuggestion(r, 200, (x) => ({ ok: true, comment: x.comment }));
    }
    case 'comment-resolve': {
      if (body.status !== 'open' && body.status !== 'resolved') return badRequest("expected { status: 'open' | 'resolved' }");
      const r = await repository.setCommentState(bookId, /** @type {string} */ (match.commentId), { status: body.status });
      return respondSuggestion(r, 200, (x) => ({ ok: true, comment: x.comment }));
    }
    case 'presence': {
      // advisory only (read class): never blocks anything. Only signed-in people are recorded; a share link or personal mode records nothing.
      if (body.scene !== null && typeof body.scene !== 'string') return badRequest('expected { scene: string | null }');
      const who = ctx.principal?.kind === 'user' ? ctx.principal : null;
      if (who && state?.presence) {
        if (!state.presence.beat(bookId, /** @type {string | null} */ (body.scene), { id: who.id, name: who.display_name ?? who.id })) return badRequest('scene must be an id');
      }
      return { status: 200, body: { ok: true, users: who && state?.presence && typeof body.scene === 'string' ? state.presence.who(bookId, body.scene, who.id) : [] } };
    }
    case 'check-scene': {
      if (typeof body.sceneId !== 'string' || body.sceneId === '') return badRequest('expected { sceneId: string }');
      const r = await repository.checkScene(bookId, body.sceneId);
      return respond(r, 200, (x) => ({ scene: x.scene, at: x.at, findings: x.findings, summary: x.summary }));
    }
    case 'receipts-flush': {
      if (typeof body.sceneId !== 'string' || body.sceneId === '') return badRequest('expected { sceneId: string }');
      const r = await repository.flushReceipts(bookId, body.sceneId);
      return respond(r, 200, (x) => ({ flushed: x.flushed, baseline: x.baseline, receipt: x.receipt }));
    }
    default:
      if (match.route.startsWith('ai-')) return handleAiWrite(repository, match, body, state);
      return handleStructure(repository, match, body);
  }
}

/** A chapter / act number from a URL segment (digits only), or null. */
const numberOf = (n) => (typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : null);

/** Body of a successful structure command: everything the command reported, without the code. */
const structureBody = (x) => {
  return { ...x, ok: true, code: undefined };
};

/**
 * POST structure commands (M03-J01). `dryRun: true` previews: { ok, changes: [{ from, to, before_sha256, after_sha256, diff }] }.
 * @param {FileRepository} repository @param {{ route: string, bookId?: string, sceneId?: string, n?: string, opId?: string }} match @param {Record<string, any>} body
 */
async function handleStructure(repository, match, body) {
  const bookId = /** @type {string} */ (match.bookId);
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
  const dryRun = body.dryRun === true;
  const created = dryRun ? 200 : 201;
  const num = numberOf(match.n);
  switch (match.route) {
    case 'scene-fields': {
      const { title, status, pov, summary, renameFile } = body;
      const r = await repository.setSceneFields(bookId, /** @type {string} */ (match.sceneId), { title, status, pov, summary, renameFile: renameFile === true, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'scene-move': {
      // M03-J03: { chapter, act?, after: sceneId | null, dryRun? } -> { ok, code, changes, undo }
      if (!Number.isInteger(body.chapter) || body.chapter < 0) return badRequest('expected { chapter: integer >= 0 }');
      if (body.act !== undefined && (!Number.isInteger(body.act) || body.act < 0)) return badRequest('act must be an integer >= 0');
      if (body.after === undefined || (body.after !== null && typeof body.after !== 'string')) return badRequest('after must be a scene id or null');
      const r = await repository.moveScene(bookId, /** @type {string} */ (match.sceneId), {
        chapter: body.chapter,
        ...(body.act !== undefined ? { act: body.act } : {}),
        after: body.after,
        ...(body.expect !== undefined ? { expect: body.expect } : {}),
        dryRun,
      });
      if (!r.ok && r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', code: 'CONFLICT', ...(r.changed ? { changed: r.changed } : {}), message: r.message ?? 'A file changed on disk since it was read; nothing was written.' } };
      if (!r.ok && r.code === 'REFUSED_INVALID_BOOK') {
        return { status: 409, body: { error: 'refused', code: r.code, message: r.message ?? 'book has manuscript errors', diagnostics: r.diagnostics ?? [] } };
      }
      return respond(r, 200, (x) => ({ ok: true, code: 'OK', ...(x.dryRun ? { dryRun: true } : {}), changes: x.changes ?? [], undo: x.undo ?? null, id: x.id, path: x.path, sequence: x.sequence, opId: x.opId ?? null }));
    }
    case 'scene-split': {
      if (!Number.isInteger(body.atLine)) return badRequest('expected { atLine: integer }');
      const r = await repository.splitScene(bookId, /** @type {string} */ (match.sceneId), { atLine: body.atLine, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'scene-merge': {
      if (typeof body.first !== 'string' || typeof body.second !== 'string') return badRequest('expected { first: string, second: string }');
      const r = await repository.mergeScenes(bookId, { first: body.first, second: body.second, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapter-create': {
      const { act, after, title } = body;
      const r = await repository.createChapter(bookId, { act, after, title, dryRun });
      return respond(r, created, structureBody);
    }
    case 'chapter-fields': {
      if (num === null) return NOT_FOUND;
      const r = await repository.setChapterFields(bookId, num, { title: body.title, label: body.label, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapter-archive': {
      if (num === null) return NOT_FOUND;
      const r = await repository.archiveChapter(bookId, num, { dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapter-move': {
      if (num === null) return NOT_FOUND;
      if (!Number.isInteger(body.act) || body.act < 0) return badRequest('act must be an integer >= 0');
      if (body.after !== undefined && body.after !== null && (!Number.isInteger(body.after) || body.after < 0)) return badRequest('after must be a chapter number, null or omitted');
      const r = await repository.moveChapter(bookId, num, { act: body.act, ...(body.after !== undefined ? { after: body.after } : {}), dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapters-renumber': {
      const r = await repository.renumberChapters(bookId, { step: body.step, ...(body.start !== undefined ? { start: body.start } : {}), dryRun });
      return respond(r, 200, structureBody);
    }
    case 'act-create': {
      const r = await repository.createAct(bookId, { title: body.title, dryRun });
      return respond(r, created, structureBody);
    }
    case 'act-fields': {
      if (num === null) return NOT_FOUND;
      const r = await repository.setActFields(bookId, num, { title: body.title, dryRun });
      return respond(r, 200, structureBody);
    }
    // ---- M04-J02 Codex. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'entry-create': {
      const r = await repository.createEntry(bookId, { type: body.type, name: body.name, slug: body.slug, status: body.status, fields: body.fields, ...(body.where !== undefined ? { where: body.where } : {}), dryRun });
      return respond(r, created, structureBody);
    }
    case 'entry-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setEntryFields(bookId, /** @type {string} */ (match.entryId), { name: body.name, status: body.status, role: body.role, aliases: body.aliases, fields: body.fields, related: body.related, labels: body.labels, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-slug': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.changeEntrySlug(bookId, /** @type {string} */ (match.entryId), { slug: body.slug, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveEntry(bookId, /** @type {string} */ (match.entryId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-restore': {
      // POST /entries/:id/restore, or POST /entries/restore with { path } (the archived file) or { id }
      const ref = match.entryId ?? body.path ?? body.id;
      if (typeof ref !== 'string' || ref === '') return badRequest('expected { path: string } or { id: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreEntry(bookId, ref, { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'codex-type-create': {
      const r = await repository.createCodexType(bookId, { type: body.type, name: body.name, plural: body.plural, fields: body.fields, ...(body.where !== undefined ? { where: body.where } : {}), dryRun });
      return respond(r, created, structureBody);
    }
    // ---- M07-J01b. Move to series keeps the entry's id; Copy into this book makes a new id (the answer carries the W309 warning). Series files get no receipts.
    case 'entry-move-to-series': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.moveEntryToSeries(bookId, /** @type {string} */ (match.entryId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-copy-to-book': {
      const r = await repository.copyEntryIntoBook(bookId, /** @type {string} */ (match.entryId), { dryRun });
      return respond(r, created, structureBody);
    }
    case 'labels-set': {
      if (body.scope !== undefined && body.scope !== 'book' && body.scope !== 'series') return badRequest("scope must be 'book' or 'series'");
      if (!Array.isArray(body.labels)) return badRequest('expected { labels: [{ name, color }] }');
      const r = await repository.setLabels(bookId, { scope: body.scope ?? 'book', labels: body.labels, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'template-save': {
      for (const k of ['name', 'title', 'description']) if (body[k] !== undefined && typeof body[k] !== 'string') return badRequest(`${k} must be a string`);
      const r = await repository.saveAsTemplate(bookId, { name: body.name, title: body.title, description: body.description });
      return respond(r, 201, (x) => ({ ok: true, name: x.name, path: x.path, files: x.files }));
    }
    // ---- M04-J03 plot threads. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'thread-create': {
      const r = await repository.createThread(bookId, { title: body.title, slug: body.slug, kind: body.kind, status: body.status, dryRun });
      return respond(r, created, structureBody);
    }
    case 'thread-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setThreadFields(bookId, /** @type {string} */ (match.threadId), { status: body.status, setup: body.setup, develop: body.develop, payoff: body.payoff, characters: body.characters, add: body.add, remove: body.remove, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    // ---- M04-J04 events and notes. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'event-create': {
      const r = await repository.createEvent(bookId, { title: body.title, slug: body.slug, order: body.order, when: body.when, date: body.date, scenes: body.scenes, characters: body.characters, locations: body.locations, dryRun });
      return respond(r, created, structureBody);
    }
    case 'event-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setEventFields(bookId, /** @type {string} */ (match.eventId), {
        title: body.title,
        when: body.when,
        date: body.date,
        order: body.order,
        scenes: body.scenes,
        characters: body.characters,
        locations: body.locations,
        add: body.add,
        remove: body.remove,
        ...(body.two_sided !== undefined ? { twoSided: body.two_sided } : {}),
        dryRun,
        baseSha256: body.base_sha256,
      });
      return respond(r, 200, structureBody);
    }
    case 'event-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveEvent(bookId, /** @type {string} */ (match.eventId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'event-restore': {
      const ref = match.eventId ?? body.path ?? body.id;
      if (typeof ref !== 'string' || ref === '') return badRequest('expected { path: string } or { id: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreEvent(bookId, ref, { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-create': {
      const { kind, title, slug, tags, links, sources, canon, cite_key: citeKey, type, author, year, publisher, url, accessed, locator } = body;
      const r = await repository.createNote(bookId, { kind, title, slug, tags, links, sources, canon, cite_key: citeKey, type, author, year, publisher, url, accessed, locator, dryRun });
      return respond(r, created, structureBody);
    }
    case 'note-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const { title, canon, locked, tags, links, sources, type, author, year, publisher, url, accessed, locator } = body;
      const r = await repository.setNoteFields(bookId, /** @type {string} */ (match.noteId), { title, canon, locked, tags, links, sources, type, author, year, publisher, url, accessed, locator, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveNote(bookId, /** @type {string} */ (match.noteId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreNote(bookId, /** @type {string} */ (match.noteId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    // ---- M09-J01 canvases: the only files these routes write are planning/canvases/<slug>.canvas (archive/ when archived)
    case 'canvas-create': {
      const r = await repository.createCanvas(bookId, { title: body.title, slug: body.slug, dryRun });
      return respond(r, created, structureBody);
    }
    case 'canvas-save': {
      if (typeof body.base_sha256 !== 'string') return badRequest('expected { canvas: object, base_sha256: string }');
      const r = await repository.saveCanvas(bookId, /** @type {string} */ (match.slug), { canvas: body.canvas, baseSha256: body.base_sha256 });
      if (!r.ok && r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', current: r.current ?? null } };
      return respond(r, 200, (x) => ({ ok: true, sha256: x.sha256, path: x.path }));
    }
    case 'canvas-archive':
    case 'canvas-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'canvas-archive' ? repository.archiveCanvas : repository.restoreCanvas;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    // ---- M12 W2 workspace docs: the only files these routes write are planning/workspace/*.md, planning/state/chapter-NN/*.md and planning/development/*.md (archive/ when archived)
    case 'workspace-doc-save': {
      if (typeof body.path !== 'string' || typeof body.body !== 'string') return badRequest('expected { path: string, title?: string, body: string, base_sha256?: string }');
      if (body.title !== undefined && typeof body.title !== 'string') return badRequest('title must be a string');
      if (body.base_sha256 !== undefined && body.base_sha256 !== null && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.saveWorkspaceDoc(bookId, { path: body.path, ...(body.title !== undefined ? { title: body.title } : {}), body: body.body, baseSha256: body.base_sha256 ?? null, dryRun });
      return respondWorkspace(r, r.created ? created : 200, (x) => ({ ok: true, path: x.path, sha256: x.sha256, created: x.created === true, opId: x.opId ?? null, ...(x.dryRun ? { dryRun: true, changes: x.changes } : {}) }));
    }
    case 'workspace-doc-append': {
      if (typeof body.path !== 'string' || typeof body.text !== 'string') return badRequest('expected { path: string, text: string }');
      const r = await repository.appendWorkspaceDoc(bookId, { path: body.path, text: body.text, dryRun });
      return respondWorkspace(r, r.created ? created : 200, (x) => ({ ok: true, path: x.path, sha256: x.sha256, created: x.created === true, opId: x.opId ?? null }));
    }
    case 'workspace-doc-lock': {
      if (typeof body.locked !== 'boolean') return badRequest('expected { path: string } or { prefix: string }, and locked: true | false');
      if ((typeof body.path === 'string') === (typeof body.prefix === 'string')) return badRequest('give exactly one of path and prefix (a string)');
      const r = await repository.lockWorkspaceDocs(bookId, { ...(typeof body.path === 'string' ? { path: body.path } : { prefix: body.prefix }), locked: body.locked, dryRun });
      return respondWorkspace(r, 200, (x) => ({ ok: true, locked: x.locked, changed: x.changed, matched: x.matched, opId: x.opId ?? null }));
    }
    case 'workspace-doc-archive':
    case 'workspace-doc-restore': {
      if (typeof body.path !== 'string') return badRequest('expected { path: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'workspace-doc-archive' ? repository.archiveWorkspaceDoc : repository.restoreWorkspaceDoc;
      const r = await call.call(repository, bookId, { path: body.path, baseSha256: body.base_sha256, dryRun });
      return respondWorkspace(r, 200, (x) => ({ ok: true, path: x.path, file: x.file, opId: x.opId ?? null }));
    }
    case 'workspace-setup': {
      const r = await repository.setupWorkspace(bookId, { dryRun });
      return respondWorkspace(r, r.created?.length ? created : 200, (x) => ({ ok: true, created: x.created, existing: x.existing, opId: x.opId ?? null }));
    }
    // ---- Story Planner M1 (ADR 0003): the only files these routes write are planning/links/<slug>.md, planning/scene-plans/<slug>.md and planning/story.md (archive/ when archived)
    case 'planner-link-create':
    case 'planner-link-update': {
      const creating = match.route === 'planner-link-create';
      for (const k of ['from', 'to', 'relation', 'rationale']) if (body[k] !== undefined && typeof body[k] !== 'string') return badRequest(`${k} must be a string`);
      if (body.branch !== undefined && body.branch !== null && typeof body.branch !== 'string') return badRequest('branch must be a string or null');
      if (creating && (typeof body.from !== 'string' || typeof body.to !== 'string' || typeof body.relation !== 'string')) return badRequest('expected { from: sceneId, to: sceneId, relation: string, rationale?: string }');
      if (!creating && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      const args = { from: body.from, to: body.to, relation: body.relation, rationale: body.rationale, ...(body.branch !== undefined ? { branch: body.branch } : {}), dryRun };
      const r = creating
        ? await repository.createLink(bookId, args)
        : await repository.updateLink(bookId, /** @type {string} */ (match.slug), { ...args, baseSha256: body.base_sha256 });
      return respondPlanner(r, creating ? created : 200);
    }
    case 'planner-link-archive':
    case 'planner-link-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-link-archive' ? repository.archiveLink : repository.restoreLink;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    case 'planner-scene-plan-save': {
      if (body.fields !== undefined && !isObject(body.fields)) return badRequest('fields must be an object');
      for (const [k, v] of Object.entries(body.fields ?? {})) if (v !== null && typeof v !== 'string') return badRequest(`fields.${k} must be a string or null`);
      if (body.characters !== undefined && !(Array.isArray(body.characters) && body.characters.every((s) => typeof s === 'string'))) return badRequest('characters must be a list of entry slugs');
      if (body.base_sha256 !== undefined && body.base_sha256 !== null && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string or null');
      const r = await repository.saveScenePlan(bookId, /** @type {string} */ (match.sceneId), { fields: body.fields ?? {}, characters: body.characters, baseSha256: body.base_sha256 ?? null, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-story-plan-save': {
      if (body.fields !== undefined && !isObject(body.fields)) return badRequest('fields must be an object');
      for (const [k, v] of Object.entries(body.fields ?? {})) if (v !== null && typeof v !== 'string') return badRequest(`fields.${k} must be a string or null`);
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      if (body.base_sha256 !== undefined && body.base_sha256 !== null && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string or null');
      const r = await repository.saveStoryPlan(bookId, { fields: body.fields ?? {}, body: body.body, baseSha256: body.base_sha256 ?? null, dryRun });
      return respondPlanner(r, 200);
    }
    // ---- Story Planner M3: the only files these routes write are planning/arcs/<slug>.md (archive/ when archived); never a Codex entry or a scene
    case 'planner-arc-create': {
      if (typeof body.character !== 'string') return badRequest('expected { character: entryId, arc_type?: string, fields?: object }');
      if (body.arc_type !== undefined && body.arc_type !== null && typeof body.arc_type !== 'string') return badRequest('arc_type must be a string');
      const fields = plannerFields(body.fields);
      if (typeof fields === 'string') return badRequest(fields);
      const r = await repository.createArc(bookId, { character: body.character, arc_type: body.arc_type ?? undefined, fields, dryRun });
      return respondPlanner(r, created);
    }
    case 'planner-arc-update': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (body.arc_type !== undefined && body.arc_type !== null && typeof body.arc_type !== 'string') return badRequest('arc_type must be a string or null');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      const fields = plannerFields(body.fields);
      if (typeof fields === 'string') return badRequest(fields);
      const r = await repository.updateArc(bookId, /** @type {string} */ (match.slug), { arc_type: body.arc_type, fields, body: body.body, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-arc-milestones': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (!Array.isArray(body.milestones) || !body.milestones.every((m) => isObject(m) && Object.values(m).every((v) => typeof v === 'string'))) return badRequest('milestones must be a list of objects with string values');
      const r = await repository.setArcMilestones(bookId, /** @type {string} */ (match.slug), { milestones: body.milestones, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-arc-archive':
    case 'planner-arc-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-arc-archive' ? repository.archiveArc : repository.restoreArc;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    // ---- Story Planner M4: the only files these routes write are planning/structures/<slug>.md (archive/ when archived); never a scene
    case 'planner-structure-create': {
      if (typeof body.template !== 'string' || typeof body.name !== 'string') return badRequest('expected { template: string, name: string }');
      const r = await repository.createStructure(bookId, { template: body.template, name: body.name, dryRun });
      return respondPlanner(r, created);
    }
    case 'planner-structure-update': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (body.name !== undefined && typeof body.name !== 'string') return badRequest('name must be a string');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      const r = await repository.updateStructure(bookId, /** @type {string} */ (match.slug), { name: body.name, body: body.body, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-structure-beats': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      const bad = plannerBeats(body.beats);
      if (bad) return badRequest(bad);
      const r = await repository.setStructureBeats(bookId, /** @type {string} */ (match.slug), { beats: body.beats, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-structure-archive':
    case 'planner-structure-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-structure-archive' ? repository.archiveStructure : repository.restoreStructure;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    // ---- Story Planner M5: the only files these routes write are planning/relationships/<slug>.md (archive/ when archived); never a Codex entry or a scene
    case 'planner-relationship-create': {
      if (typeof body.a !== 'string' || typeof body.b !== 'string') return badRequest('expected { a: entryId, b: entryId, fields?: object }');
      const fields = plannerFields(body.fields);
      if (typeof fields === 'string') return badRequest(fields);
      const r = await repository.createRelationship(bookId, { a: body.a, b: body.b, fields, dryRun });
      return respondPlanner(r, created);
    }
    case 'planner-relationship-update': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      const fields = plannerFields(body.fields);
      if (typeof fields === 'string') return badRequest(fields);
      const r = await repository.updateRelationship(bookId, /** @type {string} */ (match.slug), { fields, body: body.body, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-relationship-developments': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (!Array.isArray(body.developments) || !body.developments.every((m) => isObject(m) && Object.values(m).every((v) => v === null || typeof v === 'string'))) return badRequest('developments must be a list of objects with string values');
      const r = await repository.setRelationshipDevelopments(bookId, /** @type {string} */ (match.slug), { developments: body.developments, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-relationship-archive':
    case 'planner-relationship-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-relationship-archive' ? repository.archiveRelationship : repository.restoreRelationship;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    // ---- Story Planner M8: the only files these routes write are planning/clues/<slug>.md (archive/ when archived); never a scene, an entry or an event
    case 'planner-clue-create': {
      if (typeof body.fact !== 'string') return badRequest('expected { fact: string, kind?: string, fields?: object }');
      if (body.kind !== undefined && typeof body.kind !== 'string') return badRequest('kind must be a string');
      if (body.fields !== undefined && !isObject(body.fields)) return badRequest('fields must be an object');
      const r = await repository.createClue(bookId, { fact: body.fact, kind: body.kind, fields: body.fields, dryRun });
      return respondPlanner(r, created);
    }
    case 'planner-clue-update': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (body.fields !== undefined && !isObject(body.fields)) return badRequest('fields must be an object');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      const r = await repository.updateClue(bookId, /** @type {string} */ (match.slug), { fields: body.fields, body: body.body, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-clue-knowers': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (!Array.isArray(body.knowers) || !body.knowers.every((k) => isObject(k) && Object.values(k).every((v) => v === null || typeof v === 'string' || typeof v === 'boolean'))) return badRequest('knowers must be a list of objects with string or boolean values');
      const r = await repository.setClueKnowers(bookId, /** @type {string} */ (match.slug), { knowers: body.knowers, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-clue-archive':
    case 'planner-clue-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-clue-archive' ? repository.archiveClue : repository.restoreClue;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    // ---- Story Planner M7: the only files these routes write are planning/synopses/<slug>.md (archive/ when archived); never a scene or the story plan
    case 'planner-synopsis-create': {
      if (typeof body.type !== 'string') return badRequest('expected { type: string, name?: string, target_words?: number, body?: string }');
      if (body.name !== undefined && typeof body.name !== 'string') return badRequest('name must be a string');
      if (body.target_words !== undefined && !Number.isInteger(body.target_words)) return badRequest('target_words must be a whole number');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      const r = await repository.createSynopsis(bookId, { type: body.type, name: body.name, target_words: body.target_words, body: body.body, dryRun });
      return respondPlanner(r, created);
    }
    case 'planner-synopsis-update': {
      if (typeof body.base_sha256 !== 'string') return badRequest('base_sha256 is required');
      if (body.name !== undefined && typeof body.name !== 'string') return badRequest('name must be a string');
      if (body.target_words !== undefined && body.target_words !== null && !Number.isInteger(body.target_words)) return badRequest('target_words must be a whole number or null');
      if (body.body !== undefined && typeof body.body !== 'string') return badRequest('body must be a string');
      if (body.basis !== undefined && body.basis !== null && typeof body.basis !== 'string') return badRequest('basis must be a string or null');
      const r = await repository.updateSynopsis(bookId, /** @type {string} */ (match.slug), { name: body.name, target_words: body.target_words, body: body.body, basis: body.basis, baseSha256: body.base_sha256, dryRun });
      return respondPlanner(r, 200);
    }
    case 'planner-synopsis-archive':
    case 'planner-synopsis-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const call = match.route === 'planner-synopsis-archive' ? repository.archiveSynopsis : repository.restoreSynopsis;
      const r = await call(bookId, /** @type {string} */ (match.slug), { dryRun, baseSha256: body.base_sha256 });
      return respondPlanner(r, 200);
    }
    // ---- M05-J02 continuity exceptions: the only files these routes write are planning/continuity/<slug>.md (archive/ when removed)
    case 'continuity-exception-create': {
      for (const k of ['fingerprint', 'rationale', 'title']) if (body[k] !== undefined && typeof body[k] !== 'string') return badRequest(`${k} must be a string`);
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      if (body.intentional !== undefined && typeof body.intentional !== 'boolean') return badRequest('intentional must be a boolean');
      const r = await repository.createContinuityException(bookId, { fingerprint: body.fingerprint, rationale: body.rationale, title: body.title, intentional: body.intentional === true, dryRun: body.dryRun === true });
      return respondContinuity(r, body.dryRun === true ? 200 : 201, (x) => (x.dryRun ? { ok: true, dryRun: true, file: x.file, slug: x.slug, text: x.text, changes: x.changes } : { ok: true, file: x.file, slug: x.slug, opId: x.opId ?? null, undo: x.undo ?? null }));
    }
    case 'continuity-exception-archive': {
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.archiveContinuityException(bookId, /** @type {string} */ (match.slug), { dryRun: body.dryRun === true });
      return respondContinuity(r, 200, (x) => (x.dryRun ? { ok: true, dryRun: true, archived: x.archived, changes: x.changes } : { ok: true, archived: x.archived, opId: x.opId ?? null, undo: x.undo ?? null }));
    }
    case 'continuity-settings-save': {
      if (body.overdue_chapters !== undefined && !Number.isInteger(body.overdue_chapters)) return badRequest('overdue_chapters must be a whole number');
      if (body.severity !== undefined && (body.severity === null || typeof body.severity !== 'object' || Array.isArray(body.severity))) return badRequest('severity must be an object of rule id to error, warning, info or off');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.saveContinuitySettings(bookId, { overdue_chapters: /** @type {number | undefined} */ (body.overdue_chapters), severity: /** @type {Record<string, string> | undefined} */ (body.severity), dryRun: body.dryRun === true });
      return respondContinuity(r, 200, (x) => (x.dryRun ? { ok: true, dryRun: true, file: x.file, text: x.text, changes: x.changes } : { ok: true, file: x.file, opId: x.opId ?? null, undo: x.undo ?? null }));
    }
    case 'op-restore': {
      const r = await repository.restoreOp(bookId, /** @type {string} */ (match.opId), { dryRun });
      return respond(r, 200, structureBody);
    }
    default:
      return NOT_FOUND;
  }
}

/**
 * POST /api/books/:b/attachments?name=<file name>[&note=<book-relative note path or note id>]: the raw bytes of one file (at most 25 MB; the caller has already
 * limited the body). 201 { path, name, markdown } with the link to insert in the note; 400 bad name or empty; 413 too large; 415 type not allowed.
 * `for=canvas` (M09-J01) stores under assets/canvas/ instead of assets/research/.
 * @param {FileRepository} repository @param {{ bookId?: string }} match @param {{ name: string | null, note: string | null, purpose?: string | null, bytes: Buffer }} upload
 * @returns {Promise<ApiResult>}
 */
export async function handleUpload(repository, match, { name, note, purpose = null, bytes }) {
  if (name === null || name.trim() === '') return badRequest('name is required (the file name)');
  if (purpose !== null && purpose !== 'research' && purpose !== 'canvas') return badRequest('for must be research or canvas');
  const r = await repository.uploadAttachment(/** @type {string} */ (match.bookId), { name, bytes, ...(note !== null ? { note } : {}), ...(purpose !== null ? { purpose } : {}) });
  if (r.ok) return { status: 201, body: { ok: true, path: r.path, name: r.name, markdown: r.markdown } };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  const status = r.code === 'TOO_LARGE' ? 413 : r.code === 'UNSUPPORTED_TYPE' ? 415 : r.code === 'REFUSED_PATH_TAKEN' ? 409 : 400;
  const error = status === 413 ? 'too_large' : status === 415 ? 'unsupported_type' : status === 409 ? 'conflict' : 'refused';
  return { status, body: { error, code: r.code, ...(r.message ? { message: r.message } : {}) } };
}

/** The single folder name a restore may create inside the library. */
export const RESTORE_FOLDER_RE = /^[a-z0-9-]{1,60}$/;

/**
 * POST /api/library/restore?folder=<new folder name>: the raw bytes of a backup zip (the caller has already limited the body). Restores into
 * <library>/<folder> and rescans the library so the book appears. 200 { bookRoot, bookId, folder, diagnostics }; 400 bad folder or an archive that
 * is refused (nothing is written); 409 RESTORE_TARGET_NOT_EMPTY.
 * @param {FileRepository} repository @param {string | null} folder @param {Buffer} bytes
 * @returns {Promise<ApiResult>}
 */
export async function handleRestore(repository, folder, bytes) {
  if (folder === null || !RESTORE_FOLDER_RE.test(folder)) return badRequest('folder must be a single folder name of 1 to 60 characters: a-z, 0-9 and hyphen');
  const library = /** @type {any} */ (repository).root;
  try {
    const r = await restoreBackup(bytes, `${library}/${folder}`);
    await repository.rescan();
    return { status: 200, body: { bookRoot: r.bookRoot, bookId: r.bookId, folder, diagnostics: r.diagnostics } };
  } catch (e) {
    if (!(e instanceof RestoreError)) throw e;
    if (e.code === 'RESTORE_TARGET_NOT_EMPTY') return { status: 409, body: { error: 'conflict', code: e.code, message: e.message } };
    return { status: 400, body: { error: 'refused', code: e.code, message: e.message } };
  }
}
