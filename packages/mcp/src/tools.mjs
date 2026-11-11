// The MCP tool table (M08 MCP service). Each tool is a name, a JSON Schema for its arguments, the permission it needs ('read', 'propose', 'canvas', 'plan', 'workspace' or 'draft') and a run() that talks to the
// plugin API /api/v1 only, through the `api` helper the protocol layer builds over the server's `call`. Nothing here touches a file or the network, and no tool can change
// prose or a canonical file: the propose tools create a suggestion the author accepts or rejects in StoryForge. The one exception is the canvas tools (permission 'canvas'),
// which change only planning/canvases/*.canvas files, and the plan tools (permission 'plan', M11), which write only Story Planner files under planning/ through the app's own
// planner routes (the author can Undo each change), and the workspace tools (permission 'workspace', M12), which write only workspace docs under planning/ the same way.
// plugin-policy.mjs still decides every underlying request.

/** A failure whose message is safe to show the model (becomes an isError tool result). */
export class ToolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * @typedef {{ get: (path: string, query?: Record<string, string>) => Promise<any>, post: (path: string, body?: unknown) => Promise<any>, put: (path: string, body?: unknown) => Promise<any>, origin: string }} Api
 * @typedef {{ content: { type: 'text', text: string }[], structuredContent: Record<string, unknown> }} ToolResult
 * @typedef {{ name: string, title: string, description: string, need: 'read' | 'propose' | 'canvas' | 'plan' | 'workspace' | 'draft', inputSchema: Record<string, any>,
 *   annotations: { readOnlyHint: boolean, destructiveHint: false, idempotentHint: boolean, openWorldHint: false },
 *   run: (args: Record<string, any>, api: Api) => Promise<ToolResult> }} Tool
 */

const BOOK_DOC = 'The book is its slug or its id (see codex_list_books).';
const CANVAS_NOTE = 'This changed the canvas file directly; it is planning material, not prose.';
const WORKSPACE_NOTE = 'This changed the workspace files directly (a workspace doc, ledger, cast, state, task or writing log; planning material, not prose); the author can Undo it in StoryForge.';
const PLAN_NOTE = 'This changed the planning file directly (planning material, not prose); the author can Undo it in StoryForge.';
const NOTE = 'Nothing was changed. The author reviews this suggestion in StoryForge and accepts or rejects it.';
const seg = (/** @type {string} */ s) => encodeURIComponent(s);
const bookPath = (/** @type {string} */ book) => `/api/v1/books/${seg(book)}`;

/** @param {unknown} obj @param {string} [text] @returns {ToolResult} */
const result = (obj, text) => ({ content: [{ type: 'text', text: text ?? JSON.stringify(obj, null, 2) }], structuredContent: /** @type {Record<string, unknown>} */ (obj) });

/** Result with the prose in a second content item. @param {Record<string, any>} obj the full object (with body) @param {string} bodyText @param {Record<string, any>} head */
const splitResult = (obj, bodyText, head) => ({ content: [{ type: 'text', text: JSON.stringify(head, null, 2) }, { type: 'text', text: bodyText }], structuredContent: obj });

const bookArg = { type: 'string', minLength: 1, maxLength: 200, description: `The book: its slug or its id.` };
const rationaleArg = { type: 'string', maxLength: 20000, description: 'Why the author should accept this change (shown in the review).' };
const shaArg = { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the file you read; the proposal is marked stale if the file changed since.' };

/** @param {Record<string, any>} properties @param {string[]} required */
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const READ = { readOnlyHint: true, destructiveHint: /** @type {const} */ (false), idempotentHint: true, openWorldHint: /** @type {const} */ (false) };
const CANVAS = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };
const PLAN = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };
const PROPOSE = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };

/** @param {Record<string, any>} args the optional proposal fields */
function proposalExtras(args) {
  return { ...(args.rationale !== undefined ? { rationale: args.rationale } : {}), ...(args.base_sha256 !== undefined ? { base_sha256: args.base_sha256 } : {}) };
}

/** @param {Api} api @param {string} book @param {Record<string, unknown>} payload */
async function propose(api, book, payload) {
  const res = await api.post(`${bookPath(book)}/proposals`, payload);
  return result({ suggestion: res.suggestion, note: NOTE });
}

const canvasArg = { type: 'string', minLength: 1, maxLength: 60, description: 'The canvas slug (see codex_list_canvases).' };
const canvasSha = { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the canvas as codex_get_canvas returned it.' };
const canvasPathOf = (/** @type {string} */ book, /** @type {string} */ slug) => `${bookPath(book)}/canvases/${seg(slug)}`;

/** Apply the edit operations of codex_edit_canvas to a canvas; throws ToolError on a bad id. @param {any} canvas @param {Record<string, any>} args */
function applyCanvasEdit(canvas, args) {
  let nodes = [...(canvas.nodes ?? [])];
  let edges = [...(canvas.edges ?? [])];
  const has = (/** @type {any[]} */ list, /** @type {string} */ id) => list.some((x) => x.id === id);
  for (const n of args.add_nodes ?? []) {
    if (typeof n?.id !== 'string' || n.id === '') throw new ToolError('every added node needs an id');
    if (has(nodes, n.id)) throw new ToolError(`a node with id "${n.id}" already exists`);
    nodes.push(n);
  }
  for (const u of args.update_nodes ?? []) {
    if (typeof u?.id !== 'string' || !has(nodes, u.id)) throw new ToolError(`update_nodes: no node with id "${u?.id}"; use codex_get_canvas to see the ids`);
    nodes = nodes.map((n) => (n.id === u.id ? { ...n, ...u } : n));
  }
  const gone = new Set();
  for (const id of args.remove_nodes ?? []) {
    if (!has(nodes, id)) throw new ToolError(`remove_nodes: no node with id "${id}"`);
    gone.add(id);
  }
  if (gone.size > 0) {
    nodes = nodes.filter((n) => !gone.has(n.id));
    edges = edges.filter((e) => !gone.has(e.fromNode) && !gone.has(e.toNode));
  }
  for (const e of args.add_edges ?? []) {
    if (typeof e?.id !== 'string' || e.id === '') throw new ToolError('every added edge needs an id');
    if (has(edges, e.id)) throw new ToolError(`an edge with id "${e.id}" already exists`);
    edges.push(e);
  }
  for (const id of args.remove_edges ?? []) {
    if (!has(edges, id)) throw new ToolError(`remove_edges: no edge with id "${id}"`);
    edges = edges.filter((e) => e.id !== id);
  }
  return { ...canvas, nodes, edges };
}

// ---- `search` and `fetch`: the two tools ChatGPT's regular connectors and deep research look for (by these exact names). A result id is `<book slug>/<item id>`,
// so fetch needs no other argument; url opens the item in StoryForge when the server knows its own address. Only kinds fetch can open are returned by search.
const FETCHABLE = ['scene', 'entry', 'thread', 'event'];
const SEARCH_LIMIT = 20;

/** The StoryForge page for an item, or null without an origin. @param {string} origin @param {string} bookId @param {string} kind @param {string} id */
function itemUrl(origin, bookId, kind, id) {
  if (!origin) return null;
  const b = `${origin}/books/${encodeURIComponent(bookId)}`;
  if (kind === 'scene') return `${b}?scene=${encodeURIComponent(id)}`;
  if (kind === 'entry') return `${b}/codex?entry=${encodeURIComponent(id)}`;
  if (kind === 'thread') return `${b}/plan`;
  if (kind === 'event') return `${b}/timeline`;
  return b;
}

/** @param {string} id @returns {string} the kind an item id names by its prefix */
const kindOf = (id) => (id.startsWith('scene_') ? 'scene' : id.startsWith('entry_') ? 'entry' : id.startsWith('thread_') ? 'thread' : id.startsWith('event_') ? 'event' : '');

/** Readable text for a thread or an event (a list item of the plugin API). @param {Record<string, any>} x */
function recordText(x) {
  return Object.entries(x)
    .filter(([k, v]) => !['id', 'path', 'sha256'].includes(k) && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

/** @param {any} book @returns {any[]} every chapter with its act */
const chaptersOf = (book) => (book.acts ?? []).flatMap((/** @type {any} */ a) => (a.chapters ?? []).map((/** @type {any} */ c) => ({ ...c, act: a.act })));

const CARD_W = 260;
const CARD_H = 150;
const CARD_GAP = 40;
const CARD_COLUMNS = 4;

const WORKSPACE = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };
const workspaceBase = (/** @type {string} */ book) => `${bookPath(book)}/workspace/docs`;
const docPathArg = { type: 'string', minLength: 1, maxLength: 100, description: 'The doc address, for example workspace/book, workspace/style, state/chapter-04/knowledge or development/ideas (see codex_list_docs).' };

// ---- M11 plan write tools (permission 'plan'): each posts to /api/v1/books/:b/plan/..., which runs the app's own planner route (same validation, sha check, op journal and Undo).
const planSha = { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the item as you read it (from the get/list tool); the write is refused as a conflict if the file changed since.' };
const planShaOpt = { type: 'string', minLength: 64, maxLength: 64, description: 'Optional: the sha256 of the item as you read it; the write is refused as a conflict if the file changed since.' };
const slugArg = (/** @type {string} */ what) => ({ type: 'string', minLength: 1, maxLength: 200, description: `The slug of the ${what} (as the list tool shows it).` });
const textOrNull = { type: ['string', 'null'] };
const strMap = (/** @type {string[]} */ keys, /** @type {string} */ words) => ({ type: 'object', description: words, properties: Object.fromEntries(keys.map((k) => [k, textOrNull])), additionalProperties: false });
const rowList = (/** @type {Record<string, any>} */ props, /** @type {string[]} */ required, /** @type {string} */ words) => ({ type: 'array', description: words, items: { type: 'object', properties: props, required, additionalProperties: false } });
const sceneId = (/** @type {string} */ words) => ({ type: 'string', minLength: 1, maxLength: 200, description: words });
const notesArg = (/** @type {string} */ words) => ({ type: 'string', description: words });
const LINK_RELATION_ENUM = ['therefore', 'but', 'enables', 'reveals', 'motivates', 'prevents', 'foreshadows', 'pays_off', 'parallel', 'other'];
const SYNOPSIS_TYPE_ENUM = ['premise', 'logline', 'elevator-pitch', 'short', 'one-page', 'long', 'chapter-treatment', 'custom'];
const ARC_TYPE_ENUM = ['positive', 'negative', 'flat', 'custom'];
const BEAT_STATE_ENUM = ['open', 'done', 'omitted'];
const CLUE_KIND_ENUM = ['clue', 'reveal', 'secret'];
const STORY_KEYS = ['premise', 'logline', 'theme_question', 'central_conflict', 'protagonist_goal', 'stakes', 'protagonist', 'primary_structure'];
const SCENE_PLAN_KEYS = ['goal', 'opposition', 'conflict', 'turn', 'outcome', 'consequence', 'stakes', 'emotional_start', 'emotional_end', 'purpose'];
const ARC_KEYS = ['want', 'need', 'false_belief', 'fear', 'wound', 'start_state', 'end_state'];

/** The listed args that are given, as a body object; `rename` maps an arg to its body key. @param {Record<string, any>} args @param {string[]} keys @param {Record<string, string>} [rename] */
const given = (args, keys, rename = {}) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [rename[k] ?? k, args[k]]));

/**
 * One planner write tool: POST /api/v1/books/:b/plan/<path(args)> with body(args). The answer (with opId for Undo in the app) is returned with PLAN_NOTE.
 * @param {{ name: string, title: string, text: string, props?: Record<string, any>, required?: string[], path: (args: Record<string, any>) => string, body: (args: Record<string, any>) => Record<string, unknown> }} d
 * @returns {Tool}
 */
const planWrite = ({ name, title, text, props = {}, required = [], path, body }) => ({
  name,
  title,
  description: `${text} ${PLAN_NOTE} ${BOOK_DOC}`,
  need: 'plan',
  inputSchema: schema({ book: bookArg, ...props }, ['book', ...required]),
  annotations: PLAN,
  async run(args, api) {
    const r = await api.post(`${bookPath(args.book)}/plan/${path(args)}`, body(args));
    return result({ ...r, note: PLAN_NOTE });
  },
});

/** The archive and restore pair of one planner collection. @param {string} what the singular, e.g. 'link' @param {string} collection the v1 path part, e.g. 'links' @returns {Tool[]} */
const archivePair = (what, collection) => [
  ['archive', 'Archive', `Archives a ${what} (codex_restore_${what} brings it back).`],
  ['restore', 'Restore', `Restores an archived ${what}.`],
].map(([verb, Verb, text]) => planWrite({
  name: `codex_${verb}_${what}`,
  title: `${Verb} a ${what}`,
  text,
  props: { slug: slugArg(what), base_sha256: planShaOpt },
  required: ['slug'],
  path: (a) => `${collection}/${seg(a.slug)}/${verb}`,
  body: (a) => given(a, ['base_sha256']),
}));

/** @type {Tool[]} */
const PLAN_WRITE_TOOLS = [
  planWrite({
    name: 'codex_save_story_plan',
    title: 'Save the story plan',
    text: 'Saves some fields of the story plan (premise, logline, theme question, central conflict, protagonist goal, stakes, protagonist = a Codex entry id, primary structure) and/or its notes. Only the fields you give change; null empties one. Pass base_sha256 from codex_get_plan unless the story plan has no file yet.',
    props: { fields: strMap(STORY_KEYS, 'Fields to set: a string, or null to empty it.'), notes: notesArg('The whole new notes text of the story plan.'), base_sha256: planShaOpt },
    path: () => 'story',
    body: (a) => ({ fields: a.fields ?? {}, ...given(a, ['notes'], { notes: 'body' }), base_sha256: a.base_sha256 ?? null }),
  }),
  planWrite({
    name: 'codex_save_scene_plan',
    title: 'Save a scene plan',
    text: 'Saves some planning fields of one scene (goal, opposition, conflict, turn, outcome, consequence, stakes, emotional_start, emotional_end, purpose) and/or its characters (Codex entry slugs). Only the fields you give change; null empties one. Pass base_sha256 from codex_get_scene_plan; leave it out only when the scene has no plan yet.',
    props: { scene: sceneId('The scene id (scene_...).'), fields: strMap(SCENE_PLAN_KEYS, 'Fields to set: a string, or null to empty it.'), characters: { type: 'array', items: { type: 'string' }, description: 'The whole list of Codex entry slugs in the scene.' }, base_sha256: planShaOpt },
    required: ['scene'],
    path: (a) => `scene-plans/${seg(a.scene)}`,
    body: (a) => ({ fields: a.fields ?? {}, ...given(a, ['characters', 'base_sha256']) }),
  }),
  // links
  planWrite({
    name: 'codex_create_link',
    title: 'Create a planner link',
    text: 'Creates a causal link between two scenes (or beats): from leads to to, with a relation. Give branch (a what-if branch slug) to keep it out of the main plan.',
    props: { from: sceneId('The scene (or beat) id the link starts from.'), to: sceneId('The scene (or beat) id it leads to.'), relation: { type: 'string', enum: LINK_RELATION_ENUM }, rationale: { type: 'string', description: 'Why the link holds.' }, branch: { type: 'string', description: 'What-if branch slug (leave out for the main plan).' } },
    required: ['from', 'to', 'relation'],
    path: () => 'links',
    body: (a) => given(a, ['from', 'to', 'relation', 'rationale', 'branch']),
  }),
  planWrite({
    name: 'codex_update_link',
    title: 'Update a planner link',
    text: 'Changes a link: any of from, to, relation, rationale, branch (null moves it back to the main plan). base_sha256 is required (from codex_list_plan_links).',
    props: { slug: slugArg('link'), from: sceneId('New start scene id.'), to: sceneId('New end scene id.'), relation: { type: 'string', enum: LINK_RELATION_ENUM }, rationale: { type: 'string' }, branch: textOrNull, base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `links/${seg(a.slug)}`,
    body: (a) => given(a, ['from', 'to', 'relation', 'rationale', 'branch', 'base_sha256']),
  }),
  ...archivePair('link', 'links'),
  // structures
  planWrite({
    name: 'codex_create_structure',
    title: 'Create a story structure',
    text: 'Starts a story structure (beat sheet) from a template; codex_list_structure_templates shows the template ids.',
    props: { template: { type: 'string', minLength: 1, maxLength: 100, description: 'A template id from codex_list_structure_templates.' }, name: { type: 'string', minLength: 1, maxLength: 200, description: 'The structure name.' } },
    required: ['template', 'name'],
    path: () => 'structures',
    body: (a) => ({ template: a.template, name: String(a.name).trim() }),
  }),
  planWrite({
    name: 'codex_update_structure',
    title: 'Update a story structure',
    text: "Changes a structure's name and/or notes (not its beats; see codex_set_beats). base_sha256 is required (from codex_list_structures).",
    props: { slug: slugArg('structure'), name: { type: 'string', minLength: 1, maxLength: 200 }, notes: notesArg('The whole new notes text.'), base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `structures/${seg(a.slug)}`,
    body: (a) => ({ ...given(a, ['name']), ...given(a, ['notes'], { notes: 'body' }), base_sha256: a.base_sha256 }),
  }),
  planWrite({
    name: 'codex_set_beats',
    title: 'Set the beats of a structure',
    text: "Writes the WHOLE ordered beat list of a structure, including which scenes are in each beat. Keep the id of every existing beat (it is what links, canvas beat columns and cards refer to) and leave id out for a new beat; a beat you leave out is removed (refused while a link still ends at it). Each beat: name, optional purpose, question, position, state (open, done, omitted) and scenes (scene ids; an empty list clears them). To put a scene in a beat, add it to that beat's scenes here. base_sha256 is required (from codex_list_structures).",
    props: {
      slug: slugArg('structure'),
      beats: rowList({ id: { type: 'string', description: 'The beat id; keep it for an existing beat, leave it out for a new one.' }, name: { type: 'string', minLength: 1 }, purpose: textOrNull, question: textOrNull, position: textOrNull, state: { type: 'string', enum: BEAT_STATE_ENUM }, scenes: { type: 'array', items: { type: 'string' }, description: 'Scene ids in this beat.' } }, ['name'], 'The complete beat list, in order.'),
      base_sha256: planSha,
    },
    required: ['slug', 'beats', 'base_sha256'],
    path: (a) => `structures/${seg(a.slug)}/beats`,
    body: (a) => ({ beats: a.beats.map((/** @type {any} */ b) => ({ ...b, state: b.state ?? 'open', scenes: b.scenes ?? [] })), base_sha256: a.base_sha256 }),
  }),
  ...archivePair('structure', 'structures'),
  // arcs
  planWrite({
    name: 'codex_create_arc',
    title: 'Create a character arc',
    text: 'Starts a character arc for a Codex entry (one arc per character).',
    props: { character: { type: 'string', minLength: 1, maxLength: 200, description: 'The Codex entry id (entry_...) of the character.' }, arc_type: { type: 'string', enum: ARC_TYPE_ENUM }, fields: strMap(ARC_KEYS, 'Arc fields to set.') },
    required: ['character'],
    path: () => 'arcs',
    body: (a) => given(a, ['character', 'arc_type', 'fields']),
  }),
  planWrite({
    name: 'codex_update_arc',
    title: 'Update a character arc',
    text: 'Changes an arc: arc_type (null clears it), fields (want, need, false_belief, fear, wound, start_state, end_state; null empties one) and/or notes. base_sha256 is required (from codex_list_arcs).',
    props: { slug: slugArg('arc'), arc_type: { type: ['string', 'null'], enum: [...ARC_TYPE_ENUM, null] }, fields: strMap(ARC_KEYS, 'Arc fields to set.'), notes: notesArg('The whole new notes text.'), base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `arcs/${seg(a.slug)}`,
    body: (a) => ({ ...given(a, ['arc_type', 'fields']), ...given(a, ['notes'], { notes: 'body' }), base_sha256: a.base_sha256 }),
  }),
  planWrite({
    name: 'codex_set_arc_milestones',
    title: 'Set the milestones of an arc',
    text: 'Writes the WHOLE ordered milestone list of an arc. Each milestone: scene (a scene id) and optional pressure, choice, belief_before, belief_after, cost (strings). base_sha256 is required (from codex_list_arcs).',
    props: { slug: slugArg('arc'), milestones: rowList({ scene: sceneId('The scene id.'), pressure: { type: 'string' }, choice: { type: 'string' }, belief_before: { type: 'string' }, belief_after: { type: 'string' }, cost: { type: 'string' } }, ['scene'], 'The complete milestone list, in order.'), base_sha256: planSha },
    required: ['slug', 'milestones', 'base_sha256'],
    path: (a) => `arcs/${seg(a.slug)}/milestones`,
    body: (a) => ({ milestones: a.milestones, base_sha256: a.base_sha256 }),
  }),
  ...archivePair('arc', 'arcs'),
  // relationships
  planWrite({
    name: 'codex_create_relationship',
    title: 'Create a relationship',
    text: 'Starts a relationship between two Codex entries (one per pair).',
    props: { a: { type: 'string', minLength: 1, maxLength: 200, description: 'The first Codex entry id (entry_...).' }, b: { type: 'string', minLength: 1, maxLength: 200, description: 'The second Codex entry id (entry_...).' }, fields: strMap(['baseline', 'end_state'], 'baseline and end_state texts.') },
    required: ['a', 'b'],
    path: () => 'relationships',
    body: (a) => given(a, ['a', 'b', 'fields']),
  }),
  planWrite({
    name: 'codex_update_relationship',
    title: 'Update a relationship',
    text: "Changes a relationship's fields (baseline, end_state; null empties one) and/or notes. base_sha256 is required (from codex_list_relationships).",
    props: { slug: slugArg('relationship'), fields: strMap(['baseline', 'end_state'], 'baseline and end_state texts.'), notes: notesArg('The whole new notes text.'), base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `relationships/${seg(a.slug)}`,
    body: (a) => ({ ...given(a, ['fields']), ...given(a, ['notes'], { notes: 'body' }), base_sha256: a.base_sha256 }),
  }),
  planWrite({
    name: 'codex_set_relationship_developments',
    title: 'Set the developments of a relationship',
    text: 'Writes the WHOLE ordered development list of a relationship. Each development: scene (a scene id), change (what shifts between them) and optional a_view and b_view. base_sha256 is required (from codex_list_relationships).',
    props: { slug: slugArg('relationship'), developments: rowList({ scene: sceneId('The scene id.'), change: { type: 'string' }, a_view: { type: 'string' }, b_view: { type: 'string' } }, ['scene', 'change'], 'The complete development list, in order.'), base_sha256: planSha },
    required: ['slug', 'developments', 'base_sha256'],
    path: (a) => `relationships/${seg(a.slug)}/developments`,
    body: (a) => ({ developments: a.developments, base_sha256: a.base_sha256 }),
  }),
  ...archivePair('relationship', 'relationships'),
  // clues
  planWrite({
    name: 'codex_create_clue',
    title: 'Create a clue',
    text: 'Starts a clue, reveal or secret: the fact, where it is planted (scene ids), the scene that reveals it and whether it is a red herring.',
    props: { fact: { type: 'string', minLength: 1, description: 'The fact, in a sentence.' }, kind: { type: 'string', enum: CLUE_KIND_ENUM }, planted: { type: 'array', items: { type: 'string' }, description: 'Scene ids where it is planted.' }, revealed: { type: 'string', description: 'The scene id that reveals it.' }, red_herring: { type: 'boolean' } },
    required: ['fact'],
    path: () => 'clues',
    body: (a) => {
      const fields = given(a, ['planted', 'revealed', 'red_herring']);
      return { fact: String(a.fact).trim(), ...given(a, ['kind']), ...(Object.keys(fields).length > 0 ? { fields } : {}) };
    },
  }),
  planWrite({
    name: 'codex_update_clue',
    title: 'Update a clue',
    text: 'Changes a clue: fact, kind, planted (the whole list of scene ids), revealed (a scene id; null clears it), red_herring and/or notes. base_sha256 is required (from codex_list_clues).',
    props: { slug: slugArg('clue'), fact: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: CLUE_KIND_ENUM }, planted: { type: 'array', items: { type: 'string' } }, revealed: textOrNull, red_herring: { type: 'boolean' }, notes: notesArg('The whole new notes text.'), base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `clues/${seg(a.slug)}`,
    body: (a) => {
      const fields = given(a, ['fact', 'kind', 'planted', 'revealed', 'red_herring']);
      return { ...(Object.keys(fields).length > 0 ? { fields } : {}), ...given(a, ['notes'], { notes: 'body' }), base_sha256: a.base_sha256 };
    },
  }),
  planWrite({
    name: 'codex_set_clue_knowers',
    title: 'Set who learns a clue',
    text: 'Writes the WHOLE list of who learns a clue and where. Each row: who ("reader" or a Codex entry id), scene (a scene id), optional how, and reliable: false for someone who believes something false. base_sha256 is required (from codex_list_clues).',
    props: { slug: slugArg('clue'), knowers: rowList({ who: { type: 'string', minLength: 1, description: '"reader" or a Codex entry id.' }, scene: sceneId('The scene id.'), how: { type: 'string' }, reliable: { type: 'boolean' } }, ['who', 'scene'], 'The complete knower list.'), base_sha256: planSha },
    required: ['slug', 'knowers', 'base_sha256'],
    path: (a) => `clues/${seg(a.slug)}/knowers`,
    body: (a) => ({ knowers: a.knowers, base_sha256: a.base_sha256 }),
  }),
  ...archivePair('clue', 'clues'),
  // synopses
  planWrite({
    name: 'codex_create_synopsis',
    title: 'Create a synopsis',
    text: 'Starts a synopsis of a type, optionally with a name, a target word count and its text.',
    props: { type: { type: 'string', enum: SYNOPSIS_TYPE_ENUM }, name: { type: 'string' }, target_words: { type: 'integer', minimum: 1 }, body: notesArg('The synopsis text.') },
    required: ['type'],
    path: () => 'synopses',
    body: (a) => given(a, ['type', 'name', 'target_words', 'body']),
  }),
  planWrite({
    name: 'codex_update_synopsis',
    title: 'Update a synopsis',
    text: 'Changes a synopsis: name, target_words (null clears it), body (the whole synopsis text) and/or basis (null clears it). base_sha256 is required (from codex_list_synopses).',
    props: { slug: slugArg('synopsis'), name: { type: 'string' }, target_words: { type: ['integer', 'null'], minimum: 1 }, body: notesArg('The whole new synopsis text.'), basis: textOrNull, base_sha256: planSha },
    required: ['slug', 'base_sha256'],
    path: (a) => `synopses/${seg(a.slug)}`,
    body: (a) => given(a, ['name', 'target_words', 'body', 'basis', 'base_sha256']),
  }),
  ...archivePair('synopsis', 'synopses'),
];

// ---- M12 W3 workspace tools. Reads (permission 'read'): the promises / questions ledger, the chapter cast, what a character knows by a chapter, the state events, the tasks.
// Writes (permission 'workspace'; the book's AI level decides too): each posts to /api/v1/books/:b/..., which runs the app's own route (same validation, sha check, op journal and Undo).
const CAST_ROLE_ENUM = ['pov', 'appears', 'mentioned'];
const STATE_KIND_ENUM = ['died', 'revived', 'destroyed', 'lost', 'found', 'holder', 'location'];
const THREAD_KIND_ENUM = ['promise', 'question'];
const THREAD_STATUS_ENUM = ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved'];
const TASK_STATUS_ENUM = ['open', 'doing', 'done', 'dropped'];
const FOR_ENUM = ['ai', 'author'];
const chapterNo = (/** @type {string} */ words) => ({ type: 'integer', minimum: 0, description: words });
const entryRef = (/** @type {string} */ words) => ({ type: 'string', minLength: 1, maxLength: 200, description: words });
const taskRef = { type: 'string', minLength: 1, maxLength: 200, description: 'The task id or slug (see codex_get_tasks).' };
const sceneIdList = (/** @type {string} */ words) => ({ type: 'array', items: { type: 'string' }, description: words });

/** One workspace read: GET /api/v1/books/:b/<path>[?query]. @param {{ name: string, title: string, text: string, props?: Record<string, any>, required?: string[], path: string, query?: (args: Record<string, any>) => Record<string, string> }} d @returns {Tool} */
const wsRead = ({ name, title, text, props = {}, required = [], path, query = () => ({}) }) => ({
  name,
  title,
  description: `${text} Read only. ${BOOK_DOC}`,
  need: 'read',
  inputSchema: schema({ book: bookArg, ...props }, ['book', ...required]),
  annotations: READ,
  async run(args, api) {
    return result(await api.get(`${bookPath(args.book)}/${path}`, query(args)));
  },
});

/** One workspace write: POST /api/v1/books/:b/<path(args)> with body(args); the answer is returned with WORKSPACE_NOTE. @param {{ name: string, title: string, text: string, props?: Record<string, any>, required?: string[], path: (args: Record<string, any>) => string, body: (args: Record<string, any>) => Record<string, unknown> }} d @returns {Tool} */
const wsWrite = ({ name, title, text, props = {}, required = [], path, body }) => ({
  name,
  title,
  description: `${text} ${WORKSPACE_NOTE} ${BOOK_DOC}`,
  need: 'workspace',
  inputSchema: schema({ book: bookArg, ...props }, ['book', ...required]),
  annotations: PLAN,
  async run(args, api) {
    const r = await api.post(`${bookPath(args.book)}/${path(args)}`, body(args));
    return result({ ...r, note: WORKSPACE_NOTE });
  },
});

/** @type {Tool[]} */
const WORKSPACE_TOOLS = [
  wsRead({
    name: 'codex_get_ledger',
    title: 'Read the promises and questions ledger',
    text: 'Reads the ledger: promises and questions (threads of that kind: status, open or closed, the setup, develop and payoff scene ids and their chapters) and the planner clues (planted and revealed scenes and chapters).',
    path: 'ledger',
  }),
  wsRead({
    name: 'codex_get_cast',
    title: 'Read the chapter cast',
    text: 'Reads the cast of each scene (who is pov, who appears, who is only mentioned), for the whole book or one chapter.',
    props: { chapter: chapterNo('Only this chapter number.') },
    path: 'cast',
    query: (a) => (a.chapter !== undefined ? { chapter: String(a.chapter) } : {}),
  }),
  wsRead({
    name: 'codex_knowledge_at',
    title: 'What a character knows at a chapter',
    text: 'Lists the facts a character knows by the end of a chapter (all of them when at is left out), from the knows and learns items of the timeline events in book order.',
    props: { character: entryRef('The character: a Codex entry slug or id.'), at: chapterNo('The chapter number; the facts known by the end of it.') },
    required: ['character'],
    path: 'knowledge',
    query: (a) => ({ character: a.character, ...(a.at !== undefined ? { at: String(a.at) } : {}) }),
  }),
  wsRead({
    name: 'codex_get_state_events',
    title: 'Read the state events',
    text: 'Lists the state events (died, revived, destroyed, lost, found, holder, location) with their chapter, subject and value, for the whole book or one chapter.',
    props: { chapter: chapterNo('Only this chapter number.') },
    path: 'state-events',
    query: (a) => (a.chapter !== undefined ? { chapter: String(a.chapter) } : {}),
  }),
  wsRead({
    name: 'codex_get_tasks',
    title: 'Read the tasks',
    text: 'Lists the revision tasks with their status and who they are for (ai or author), and the counts. Filter by status or by for.',
    props: { status: { type: 'string', enum: TASK_STATUS_ENUM }, for: { type: 'string', enum: FOR_ENUM, description: 'Only tasks for the AI or for the author.' } },
    path: 'tasks',
    query: (a) => ({ ...(a.status !== undefined ? { status: a.status } : {}), ...(a.for !== undefined ? { for: a.for } : {}) }),
  }),
  {
    name: 'codex_save_ledger_item',
    title: 'Save a promise or question',
    description: `Creates a promise or question (a thread of that kind) when slug is left out (title and kind are then required), or updates the thread with that slug: status, the setup, develop and payoff scene ids (each list replaces the old one), the characters. Retire a thread by setting its status to paid or dropped; nothing is deleted. Pass base_sha256 from codex_get_ledger when updating. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({
      book: bookArg,
      slug: slugArg('thread'),
      title: { type: 'string', minLength: 1, maxLength: 300, description: 'The title (required when creating).' },
      kind: { type: 'string', enum: THREAD_KIND_ENUM, description: 'promise or question (required when creating).' },
      status: { type: 'string', enum: THREAD_STATUS_ENUM },
      setup: sceneIdList('Scene ids where it is set up (the whole list).'),
      develop: sceneIdList('Scene ids where it develops (the whole list).'),
      payoff: sceneIdList('Scene ids where it pays off (the whole list).'),
      characters: { type: 'array', items: { type: 'string' }, description: 'Codex entry slugs or ids (the whole list).' },
      base_sha256: planShaOpt,
    }, ['book']),
    annotations: PLAN,
    async run(args, api) {
      const fields = given(args, ['status', 'setup', 'develop', 'payoff', 'characters', 'base_sha256']);
      const base = `${bookPath(args.book)}/ledger/threads`;
      if (args.slug !== undefined) {
        if (Object.keys(fields).length === 0) throw new ToolError('give at least one field to change (status, setup, develop, payoff, characters)');
        const r = await api.post(`${base}/${seg(args.slug)}`, fields);
        return result({ ...r, note: WORKSPACE_NOTE });
      }
      if (typeof args.title !== 'string' || args.title.trim() === '' || args.kind === undefined) throw new ToolError('creating a ledger item needs a title and a kind (promise or question)');
      const made = await api.post(base, { title: args.title, kind: args.kind, ...given(args, ['status']) });
      const lists = given(args, ['setup', 'develop', 'payoff', 'characters']);
      if (Object.keys(lists).length === 0) return result({ ...made, note: WORKSPACE_NOTE });
      const slug = typeof made.slug === 'string' ? made.slug : typeof made.id === 'string' ? made.id : '';
      const r = await api.post(`${base}/${seg(slug)}`, lists);
      return result({ ...made, ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_update_event',
    title: 'Repoint the scenes of a timeline event',
    description: `Changes which scenes a timeline event points at: scenes replaces the whole list, add and remove change the current list. Give at least one of scenes, add, remove. Only scene ids of live scenes are accepted; an archived or unknown scene is refused. Use it to fix an event whose scenes point into archive/. Optional base_sha256 refuses the change if the event file changed since. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({
      book: bookArg,
      event: { type: 'string', minLength: 1, maxLength: 200, description: 'The timeline event: its id or slug.' },
      scenes: sceneIdList('Scene ids the event points at (the whole list).'),
      add: sceneIdList('Scene ids to add to the current list.'),
      remove: sceneIdList('Scene ids to remove from the current list.'),
      base_sha256: planShaOpt,
    }, ['book', 'event']),
    annotations: PLAN,
    async run(args, api) {
      const fields = given(args, ['scenes', 'base_sha256']);
      if (args.scenes === undefined && args.add === undefined && args.remove === undefined) throw new ToolError('give at least one of scenes, add, remove');
      const body = { ...fields, ...(args.add !== undefined ? { add: { scenes: args.add } } : {}), ...(args.remove !== undefined ? { remove: { scenes: args.remove } } : {}) };
      const r = await api.post(`${bookPath(args.book)}/timeline/events/${seg(args.event)}`, body);
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_set_first_appearance',
    title: 'Set the first appearance of a Codex entry',
    description: `Sets the scene where a Codex entry first appears (its first_appearance field), or clears it when scene is null. The scene must be a live scene; an archived or unknown scene is refused. Only that one field changes. Pass base_sha256 (from codex_get_entry) to refuse the change if the entry file changed since. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({
      book: bookArg,
      entry: entryRef('The Codex entry: its slug or id.'),
      scene: { type: ['string', 'null'], description: 'The scene id (scene_...) of the first appearance, or null to clear it.' },
      base_sha256: planShaOpt,
    }, ['book', 'entry', 'scene']),
    annotations: PLAN,
    async run(args, api) {
      if (args.scene !== null && (typeof args.scene !== 'string' || args.scene === '')) throw new ToolError('scene must be a scene id, or null to clear the first appearance');
      const r = await api.post(`${bookPath(args.book)}/codex/entries/${seg(args.entry)}/first-appearance`, { first_appearance: args.scene, ...given(args, ['base_sha256']) });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  wsWrite({
    name: 'codex_set_chapter_cast',
    title: 'Set the cast of a scene',
    text: 'Sets the cast of one scene (the whole list): each entry is a Codex entry id or slug with a role (pov, appears or mentioned); at most one pov. Only the scene\'s cast changes; its text never does. Pass base_sha256 (the scene sha256 from codex_get_scene) to refuse the change if the scene file changed since.',
    props: {
      scene: sceneId('The scene id (scene_...).'),
      cast: rowList({ entry: entryRef('A Codex entry slug or id.'), role: { type: 'string', enum: CAST_ROLE_ENUM } }, ['entry', 'role'], 'The whole cast of the scene; an empty list clears it.'),
      base_sha256: planShaOpt,
    },
    required: ['scene', 'cast'],
    path: (a) => `scenes/${seg(a.scene)}/cast`,
    body: (a) => ({ cast: a.cast, ...given(a, ['base_sha256']) }),
  }),
  wsWrite({
    name: 'codex_record_knowledge',
    title: 'Record what a character learns',
    text: 'Records that a character learns a fact in a chapter (a learns item on that chapter\'s state event; the event is made when missing). The fact is one line of text; the full wording is kept, and a key made from it is stored too (see codex_knowledge_at). Nothing is ever deleted.',
    props: { character: entryRef('The character: a Codex entry slug or id.'), fact: { type: 'string', minLength: 1, maxLength: 300, description: 'The fact, one line of text.' }, chapter: chapterNo('The chapter number where the character learns it.') },
    required: ['character', 'fact', 'chapter'],
    path: () => 'knowledge',
    body: (a) => given(a, ['character', 'fact', 'chapter']),
  }),
  wsWrite({
    name: 'codex_record_state_events',
    title: 'Record state events',
    text: 'Records state events of a chapter (added to that chapter\'s state event, made when missing): died or revived (a character), destroyed, lost or found (an entry), holder (value = the character who holds the object, or an empty string for nobody), location (value = a location entry). To retire a state, record the item that ends it (revived, found, a new holder); nothing is deleted.',
    props: {
      chapter: chapterNo('The chapter number.'),
      items: rowList({ subject: entryRef('The Codex entry (slug or id) the event is about.'), kind: { type: 'string', enum: STATE_KIND_ENUM }, value: { type: 'string', maxLength: 200, description: 'Only for holder and location: a Codex entry slug or id.' } }, ['subject', 'kind'], 'The state events.'),
    },
    required: ['chapter', 'items'],
    path: () => 'state-events',
    body: (a) => given(a, ['chapter', 'items']),
  }),
  wsWrite({
    name: 'codex_create_task',
    title: 'Create a task',
    text: 'Creates a task (a note to revise or check something). for is ai or author (default author): a task for the AI is one the author wants the AI to do.',
    props: {
      title: { type: 'string', minLength: 1, maxLength: 300, description: 'One line.' },
      notes: notesArg('What to do, in text.'),
      labels: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } },
      for: { type: 'string', enum: FOR_ENUM, description: 'Who the task is for (default author).' },
    },
    required: ['title'],
    path: () => 'tasks',
    body: (a) => given(a, ['title', 'notes', 'labels', 'for']),
  }),
  {
    name: 'codex_update_task',
    title: 'Update a task',
    description: `Changes a task's status (open, doing, done, dropped) and/or who it is for (ai or author). Give at least one. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, task: taskRef, status: { type: 'string', enum: TASK_STATUS_ENUM }, for: { type: 'string', enum: FOR_ENUM } }, ['book', 'task']),
    annotations: PLAN,
    async run(args, api) {
      if (args.status === undefined && args.for === undefined) throw new ToolError('give a status and/or for');
      let status = args.status;
      if (status === undefined) {
        const list = await api.get(`${bookPath(args.book)}/tasks`);
        const found = (list.tasks ?? []).find((/** @type {any} */ t) => t.id === args.task || t.slug === args.task);
        if (!found) throw new ToolError(`no task "${args.task}"; see codex_get_tasks`);
        status = found.status;
      }
      const r = await api.post(`${bookPath(args.book)}/tasks/${seg(args.task)}/status`, { status, ...given(args, ['for']) });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  wsWrite({
    name: 'codex_complete_task',
    title: 'Complete a task',
    text: 'Marks a task done.',
    props: { task: taskRef },
    required: ['task'],
    path: (a) => `tasks/${seg(a.task)}/status`,
    body: () => ({ status: 'done' }),
  }),
  wsWrite({
    name: 'codex_log_writing',
    title: 'Log words an AI wrote',
    text: 'Adds words an AI wrote to today\'s AI words in the writing log (the author\'s own word counts are never touched). Insights shows the human and AI share.',
    props: { words: { type: 'integer', minimum: 1, maximum: 1000000, description: 'The number of words.' }, chapter: chapterNo('The chapter they belong to (optional).'), note: { type: 'string', maxLength: 500, description: 'One line about what was written (optional).' } },
    required: ['words'],
    path: () => 'activity/ai-words',
    body: (a) => given(a, ['words', 'chapter', 'note']),
  }),
];

const FINGERPRINT_RE = /^[a-z0-9]{2,4}-[0-9a-f]{16}$/;
const fingerprintArg = { type: 'string', minLength: 1, maxLength: 100, description: 'The fingerprint of a finding (from codex_continuity_check).' };

/** Continuity (M12 W4): check (read), dismiss and restore a finding (workspace, level planner). The author's thresholds and severities are not a tool: only the author changes them. @type {Tool[]} */
const CONTINUITY_TOOLS = [
  {
    name: 'codex_continuity_check',
    title: 'Run the continuity check',
    description: `Runs the continuity rules (facts, timeline, knowledge, possession, threads, the plan, a dead character or a gone object on the page, an overdue promise) and returns the findings, the ones the author dismissed and the stale dismissals. With chapter, only the findings that touch that chapter. With chapter and cast (the entries you plan to put in that chapter, each as pov, appears or mentioned), the check also runs as if they were in that chapter: a pre-flight for a chapter not written yet. Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({
      book: bookArg,
      chapter: chapterNo('Only findings that touch this chapter number.'),
      cast: rowList({ entry: entryRef('A Codex entry slug or id.'), role: { type: 'string', enum: CAST_ROLE_ENUM } }, ['entry', 'role'], 'The planned cast of the chapter (needs chapter).'),
    }, ['book']),
    annotations: READ,
    async run(args, api) {
      if (args.cast !== undefined && args.chapter === undefined) throw new ToolError('cast needs a chapter');
      const query = {
        ...(args.chapter !== undefined ? { chapter: String(args.chapter) } : {}),
        ...(args.cast !== undefined && args.cast.length > 0 ? { cast: args.cast.map((/** @type {{ entry: string, role: string }} */ c) => `${c.entry}:${c.role}`).join(',') } : {}),
      };
      return result(await api.get(`${bookPath(args.book)}/continuity`, query));
    },
  },
  {
    name: 'codex_dismiss_finding',
    title: 'Dismiss a continuity finding',
    description: `Dismisses one continuity finding as intended or fine, with the reason why (the author sees it and can restore it). The finding is hidden from codex_continuity_check but nothing in the story changes. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, fingerprint: fingerprintArg, reason: { type: 'string', minLength: 1, maxLength: 5000, description: 'Why this is fine (required).' } }, ['book', 'fingerprint', 'reason']),
    annotations: WORKSPACE,
    async run(args, api) {
      const r = await api.post(`${bookPath(args.book)}/continuity/exceptions`, { fingerprint: args.fingerprint, reason: args.reason });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_restore_finding',
    title: 'Restore a dismissed finding',
    description: `Brings back a dismissed continuity finding: give the fingerprint of the finding or the slug of its dismissal (both are listed in the "suppressed" part of codex_continuity_check). The dismissal is archived, never deleted. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, finding: { type: 'string', minLength: 1, maxLength: 200, description: 'The finding fingerprint or the slug of the dismissal.' } }, ['book', 'finding']),
    annotations: WORKSPACE,
    async run(args, api) {
      let slug = args.finding;
      if (FINGERPRINT_RE.test(args.finding)) {
        const all = await api.get(`${bookPath(args.book)}/continuity`);
        const hit = (all.suppressed ?? []).find((/** @type {any} */ s) => s.finding?.fingerprint === args.finding);
        if (!hit) throw new ToolError('no dismissed finding has that fingerprint');
        slug = hit.exception.slug;
      }
      const r = await api.post(`${bookPath(args.book)}/continuity/exceptions/${seg(slug)}/archive`, {});
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
];

// ---- M12 W6 co-writer tools (permission 'draft', book AI level cowriter) and the context pack. New scenes are drafts marked as AI; an existing scene of the author is never changed by these tools.
const DRAFT = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };
const DRAFT_NOTE = 'New chapters and scenes are drafts marked as AI; the author can archive them in StoryForge (AI Activity). The author accepts a draft by changing its status from drafting. Scenes the author wrote or accepted can only be changed with codex_propose_edit.';

/** @type {Tool[]} */
const COWRITER_TOOLS = [
  {
    name: 'codex_get_context',
    title: 'Get the context pack for a chapter',
    description: `Returns everything needed to write one chapter in a single call, trimmed to a character budget (default 24000) in this priority order: the workspace book and style docs; the story plan (logline, premise, protagonist goal); the chapter's scene plans with the beats they sit in; the cast (name, type, summary); what each pov or appearing character knows at the end of the previous chapter; open promises, questions and clues planted before the chapter; state events up to the previous chapter; the latest state docs; the last ~1500 characters of the previous chapter; continuity findings that touch the chapter. "truncated" names every section that was cut. Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, chapter: chapterNo('The chapter number you are about to write.'), budget: { type: 'integer', minimum: 500, maximum: 200000, description: 'The most characters the pack may take (default 24000).' } }, ['book', 'chapter']),
    annotations: READ,
    async run(args, api) {
      const pack = await api.get(`${bookPath(args.book)}/context`, { chapter: String(args.chapter), ...(args.budget !== undefined ? { budget: String(args.budget) } : {}) });
      return result(pack);
    },
  },
  {
    name: 'codex_create_chapter',
    title: 'Create a chapter',
    description: `Creates a new, empty chapter (with one empty placeholder scene) after chapter "after", or as the first chapter of act "act" when "after" is left out. Nothing existing is changed. Add prose with codex_create_scene. ${DRAFT_NOTE} ${BOOK_DOC}`,
    need: 'draft',
    inputSchema: schema({ book: bookArg, title: { type: 'string', minLength: 1, maxLength: 300, description: 'The chapter title.' }, after: chapterNo('Insert after this chapter number.'), act: { type: 'integer', minimum: 0, description: 'The act (required when after is left out).' } }, ['book', 'title']),
    annotations: DRAFT,
    async run(args, api) {
      const r = await api.post(`${bookPath(args.book)}/chapters`, given(args, ['title', 'after', 'act']));
      return result({ chapter: r.chapter, act: r.act, scene: r.sceneId, opId: r.opId ?? null, note: DRAFT_NOTE });
    },
  },
  {
    name: 'codex_create_scene',
    title: 'Create a draft scene',
    description: `Creates a new scene in a chapter with your prose as its body. The scene is a draft marked as AI (origin ai, status drafting) whatever you pass; it goes after the scene "after" (a scene id), or at the end of the chapter when "after" is left out. The words are logged as AI words. Replace your own draft later with codex_save_draft. ${DRAFT_NOTE} ${BOOK_DOC}`,
    need: 'draft',
    inputSchema: schema({
      book: bookArg,
      chapter: chapterNo('The chapter number the scene goes in.'),
      title: { type: 'string', minLength: 1, maxLength: 300, description: 'The scene title.' },
      body: { type: 'string', description: 'The scene prose, in markdown.' },
      summary: { type: 'string', maxLength: 2000, description: 'One line about the scene (optional).' },
      after: { type: ['string', 'null'], description: 'The scene id (scene_...) to put it after; null for the start of the chapter. Leave out for the end.' },
    }, ['book', 'chapter', 'title', 'body']),
    annotations: DRAFT,
    async run(args, api) {
      const r = await api.post(`${bookPath(args.book)}/scenes`, given(args, ['chapter', 'title', 'body', 'summary', 'after']));
      return result({ id: r.id, path: r.path, note: DRAFT_NOTE });
    },
  },
  {
    name: 'codex_save_draft',
    title: 'Revise your own draft scene',
    description: `Replaces the whole body of a scene that you created and the author has not accepted (origin ai, status drafting). base_sha256 is required: pass the sha256 from codex_get_scene or from the last save; a stale sha256 is a conflict, so read the scene again. If the author wrote the scene or changed its status from drafting, this is refused (NOT_AI_DRAFT): use codex_propose_edit instead. The added words are logged as AI words. ${BOOK_DOC}`,
    need: 'draft',
    inputSchema: schema({ book: bookArg, scene: sceneId('The scene id (scene_...).'), body: { type: 'string', description: 'The complete new body of the scene.' }, base_sha256: { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the scene file as you read it.' } }, ['book', 'scene', 'body', 'base_sha256']),
    annotations: DRAFT,
    async run(args, api) {
      const r = await api.put(`${bookPath(args.book)}/scenes/${seg(args.scene)}/draft`, given(args, ['body', 'base_sha256']));
      return result({ sha256: r.sha256, words: r.words, note: DRAFT_NOTE });
    },
  },
];

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'codex_status',
    title: 'StoryForge status',
    description: 'Shows the StoryForge server and API version and lists the books in the library with their scene and word counts and the AI level of each book (ai_level: off = read only, advisor = also suggest edits, tasks and checks, planner = also the plan, canvas, workspace docs and ledgers, cowriter = also new chapters and scenes as drafts). Start here to find the book slugs and what you may do in each.',
    need: 'read',
    inputSchema: schema({}, []),
    annotations: READ,
    async run(_args, api) {
      const root = await api.get('/api/v1');
      const { books } = await api.get('/api/v1/books');
      return result({ api: root.api, server: root.server, books: books.map((/** @type {any} */ b) => ({ slug: b.slug, title: b.title, scenes: b.scenes, words: b.words, ai_level: b.ai_level ?? null })) });
    },
  },
  {
    name: 'codex_list_books',
    title: 'List books',
    description: 'Lists every book in the StoryForge library: id, slug, title, status, series, language, scene count and word count.',
    need: 'read',
    inputSchema: schema({}, []),
    annotations: READ,
    async run(_args, api) {
      const { books } = await api.get('/api/v1/books');
      return result({ books });
    },
  },
  {
    name: 'codex_list_chapters',
    title: 'List chapters',
    description: `Lists a book's structure: its acts, the chapters in each act, and the scenes in each chapter (id, title, status, POV, word count). ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const b = await api.get(bookPath(args.book));
      return result({ book: { slug: b.slug, title: b.title }, acts: b.acts ?? [] });
    },
  },
  {
    name: 'codex_get_chapter',
    title: 'Read a chapter',
    description: `Reads every scene of one chapter in order, with each scene's markdown body and sha256. Match the chapter by its number, label or title (as shown by codex_list_chapters). If the same chapter number occurs in more than one act, pass act. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, chapter: { type: 'string', minLength: 1, maxLength: 200, description: 'Chapter number, label or title.' }, act: { type: 'integer', description: 'Act number, to disambiguate.' } }, ['book', 'chapter']),
    annotations: READ,
    async run(args, api) {
      const b = await api.get(bookPath(args.book));
      const want = String(args.chapter);
      const matches = chaptersOf(b).filter((/** @type {any} */ c) => (args.act === undefined || c.act === args.act) && (String(c.chapter) === want || c.label === want || c.title === want));
      if (matches.length === 0) throw new ToolError(`no chapter matches "${want}"${args.act === undefined ? '' : ` in act ${args.act}`}; use codex_list_chapters to see the chapters`);
      if (matches.length > 1) throw new ToolError(`chapter "${want}" is ambiguous (${matches.length} matches, in acts ${matches.map((/** @type {any} */ c) => c.act).join(', ')}); give act`);
      const ch = matches[0];
      const scenes = [];
      for (const s of ch.scenes ?? []) {
        const full = await api.get(`${bookPath(args.book)}/scenes/${seg(s.id)}`);
        scenes.push({ id: s.id, title: s.title, order: s.order, status: s.status, pov: s.pov ?? null, words: s.words, sha256: full.sha256, path: s.path, body: full.body });
      }
      const obj = { book: b.slug, act: ch.act, chapter: ch.chapter, label: ch.label, title: ch.title, scenes };
      const head = { ...obj, scenes: scenes.map((s) => ({ ...s, body: undefined })) };
      const bodies = scenes.map((s) => `<!-- scene ${s.id} sha256 ${s.sha256} -->\n${s.body}`).join('\n\n');
      return splitResult(obj, bodies, head);
    },
  },
  {
    name: 'codex_get_scene',
    title: 'Read a scene',
    description: `Reads one scene: its metadata, front matter, sha256 and markdown body. ${BOOK_DOC} The scene is its id (scene_...).`,
    need: 'read',
    inputSchema: schema({ book: bookArg, scene: { type: 'string', minLength: 1, maxLength: 200, description: 'The scene id.' } }, ['book', 'scene']),
    annotations: READ,
    async run(args, api) {
      const scene = await api.get(`${bookPath(args.book)}/scenes/${seg(args.scene)}`);
      const { body, ...head } = scene;
      return splitResult(scene, String(body ?? ''), head);
    },
  },
  {
    name: 'codex_list_entries',
    title: 'List codex entries',
    description: `Lists the codex entries of a book (characters, places, items and so on): id, slug, type, name, status, role and aliases. Pass type to keep one kind. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, type: { type: 'string', minLength: 1, maxLength: 100, description: 'Only entries of this type, for example "character".' } }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { entries } = await api.get(`${bookPath(args.book)}/entries`);
      return result({ entries: args.type === undefined ? entries : entries.filter((/** @type {any} */ e) => e.type === args.type) });
    },
  },
  {
    name: 'codex_get_entry',
    title: 'Read a codex entry',
    description: `Reads one codex entry: its fields, sha256 and markdown body. ${BOOK_DOC} The entry is its id (entry_...) or its slug.`,
    need: 'read',
    inputSchema: schema({ book: bookArg, entry: { type: 'string', minLength: 1, maxLength: 200, description: 'The entry id or slug.' } }, ['book', 'entry']),
    annotations: READ,
    async run(args, api) {
      const entry = await api.get(`${bookPath(args.book)}/entries/${seg(args.entry)}`);
      const { body, ...head } = entry;
      return splitResult(entry, String(body ?? ''), head);
    },
  },
  {
    name: 'codex_search',
    title: 'Search',
    description: 'Searches scenes and codex entries for text and returns hits with a snippet. Give book (slug or id) to search one book; leave it out to search every book (each hit then names its book).',
    need: 'read',
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 200, description: 'The text to look for.' }, book: bookArg, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum hits to return (default 20).' } }, ['query']),
    annotations: READ,
    async run(args, api) {
      const limit = args.limit ?? 20;
      const q = { q: args.query, limit: String(limit) };
      if (args.book !== undefined) {
        const r = await api.get(`${bookPath(args.book)}/search`, q);
        return result({ query: args.query, hits: r.hits });
      }
      const { books } = await api.get('/api/v1/books');
      /** @type {any[]} */
      const hits = [];
      for (const b of books) {
        const r = await api.get(`${bookPath(b.slug)}/search`, q);
        for (const h of r.hits) hits.push({ ...h, book: b.slug });
      }
      return result({ query: args.query, hits: hits.slice(0, limit) });
    },
  },
  {
    name: 'search',
    title: 'Search (ChatGPT connectors)',
    description: 'Searches every book for scenes, codex entries, plot threads and timeline events matching the query. Returns results with an id, a title, a snippet and a link; pass an id to fetch to read the whole item. (The same search as codex_search, in the shape ChatGPT connectors and deep research expect.)',
    need: 'read',
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 200, description: 'The text to look for.' } }, ['query']),
    annotations: READ,
    async run(args, api) {
      const { books } = await api.get('/api/v1/books');
      /** @type {{ id: string, title: string, text: string, url: string | null }[]} */
      const results = [];
      for (const b of books) {
        if (results.length >= SEARCH_LIMIT) break;
        const r = await api.get(`${bookPath(b.slug)}/search`, { q: args.query, limit: String(SEARCH_LIMIT) });
        for (const h of r.hits) {
          if (!FETCHABLE.includes(h.kind)) continue;
          results.push({ id: `${b.slug}/${h.id}`, title: `${h.title || h.id} (${h.kind}, ${b.title || b.slug})`, text: h.snippet ?? '', url: itemUrl(api.origin, b.id, h.kind, h.id) });
        }
      }
      const out = { results: results.slice(0, SEARCH_LIMIT).map((x) => (x.url ? x : { id: x.id, title: x.title, text: x.text })) };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  },
  {
    name: 'fetch',
    title: 'Fetch (ChatGPT connectors)',
    description: 'Reads one item that search returned, by its id (book slug, a slash, then the item id, for example my-book/scene_01...): the full text of a scene or codex entry, or the details of a plot thread or timeline event.',
    need: 'read',
    inputSchema: schema({ id: { type: 'string', minLength: 3, maxLength: 300, description: 'An id from search.' } }, ['id']),
    annotations: READ,
    async run(args, api) {
      const cut = args.id.indexOf('/');
      const slug = cut > 0 ? args.id.slice(0, cut) : '';
      const itemId = cut > 0 ? args.id.slice(cut + 1) : '';
      const kind = kindOf(itemId);
      if (!slug || !kind) throw new ToolError('id must be an id from search: the book slug, a slash, then a scene_, entry_, thread_ or event_ id');
      const { books } = await api.get('/api/v1/books');
      const book = books.find((/** @type {any} */ b) => b.slug === slug || b.id === slug);
      if (!book) throw new ToolError(`no book "${slug}" is available to this connection`);
      /** @type {{ title: string, text: string, metadata: Record<string, unknown> }} */
      let doc;
      if (kind === 'scene' || kind === 'entry') {
        const full = await api.get(`${bookPath(book.slug)}/${kind === 'scene' ? 'scenes' : 'entries'}/${seg(itemId)}`);
        const head = Object.fromEntries(Object.entries(full).filter(([k]) => !['body', 'sha256', 'path'].includes(k)));
        doc = { title: String(full.title ?? full.name ?? itemId), text: String(full.body ?? ''), metadata: { kind, book: book.slug, ...head } };
      } else {
        const list = await api.get(`${bookPath(book.slug)}/${kind === 'thread' ? 'threads' : 'events'}`);
        const item = (list[kind === 'thread' ? 'threads' : 'events'] ?? []).find((/** @type {any} */ x) => x.id === itemId);
        if (!item) throw new ToolError(`no ${kind} ${itemId} in ${book.slug}`);
        doc = { title: String(item.title ?? item.name ?? itemId), text: recordText(item), metadata: { kind, book: book.slug } };
      }
      const url = itemUrl(api.origin, book.id, kind, itemId);
      const out = { id: `${book.slug}/${itemId}`, title: doc.title, text: doc.text, ...(url ? { url } : {}), metadata: doc.metadata };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  },
  {
    name: 'codex_get_diagnostics',
    title: 'Book diagnostics',
    description: `Lists the problems StoryForge found in a book (broken references, missing fields and similar). ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { diagnostics } = await api.get(`${bookPath(args.book)}/diagnostics`);
      return result({ diagnostics });
    },
  },
  {
    name: 'codex_list_threads',
    title: 'List plot threads',
    description: `Lists the plot threads of a book. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { threads } = await api.get(`${bookPath(args.book)}/threads`);
      return result({ threads });
    },
  },
  {
    name: 'codex_get_timeline',
    title: 'Book timeline',
    description: `Lists the timeline events of a book. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { events } = await api.get(`${bookPath(args.book)}/events`);
      return result({ events });
    },
  },
  {
    name: 'codex_save_chapter',
    title: 'Propose new scene text',
    description: `Proposes the whole new markdown body of one scene. Nothing changes until the author accepts the suggestion in StoryForge. Pass base_sha256 (from codex_get_scene or codex_get_chapter) so a stale proposal is detected. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({ book: bookArg, scene: { type: 'string', minLength: 1, maxLength: 200, description: 'The scene id (scene_...).' }, markdown: { type: 'string', description: 'The complete new body of the scene.' }, rationale: rationaleArg, base_sha256: shaArg }, ['book', 'scene', 'markdown']),
    annotations: PROPOSE,
    async run(args, api) {
      return propose(api, args.book, { target: args.scene, text: args.markdown, ...proposalExtras(args) });
    },
  },
  {
    name: 'codex_save_entry',
    title: 'Propose new entry text',
    description: `Proposes the whole new markdown body of one codex entry. Nothing changes until the author accepts the suggestion in StoryForge. The entry is its id or slug. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({ book: bookArg, entry: { type: 'string', minLength: 1, maxLength: 200, description: 'The entry id (entry_...) or slug.' }, markdown: { type: 'string', description: 'The complete new body of the entry.' }, rationale: rationaleArg, base_sha256: shaArg }, ['book', 'entry', 'markdown']),
    annotations: PROPOSE,
    async run(args, api) {
      let id = args.entry;
      if (!id.startsWith('entry_')) {
        const e = await api.get(`${bookPath(args.book)}/entries/${seg(id)}`);
        id = e.id;
      }
      return propose(api, args.book, { target: id, text: args.markdown, ...proposalExtras(args) });
    },
  },
  {
    name: 'codex_propose_edit',
    title: 'Propose an edit',
    description: `Proposes a change to a scene, entry, thread or event, either as the whole new text (text) or as targeted replacements (hunks, each {from, to, replacement} over character offsets into the body exactly as a get tool returned it; a line break counts as one character). Give exactly one of text and hunks. Nothing changes until the author accepts the suggestion in StoryForge. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({
      book: bookArg,
      target: { type: 'string', minLength: 1, maxLength: 200, description: 'The id to change: scene_..., entry_..., thread_... or event_....' },
      text: { type: 'string', description: 'The complete new text of the target.' },
      hunks: { type: 'array', items: { type: 'object' }, description: 'Replacements: [{ "from": 0, "to": 5, "replacement": "text" }].' },
      rationale: rationaleArg,
      base_sha256: shaArg,
    }, ['book', 'target']),
    annotations: PROPOSE,
    async run(args, api) {
      if ((args.text === undefined) === (args.hunks === undefined)) throw new ToolError('give exactly one of "text" and "hunks"');
      const change = args.text !== undefined ? { text: args.text } : { hunks: args.hunks };
      return propose(api, args.book, { target: args.target, ...change, ...proposalExtras(args) });
    },
  },
  {
    name: 'codex_list_canvases',
    title: 'List canvases',
    description: `Lists the canvases (visual planning boards) of a book: slug, title, node and edge counts, sha256, and the archived ones. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { canvases, archived } = await api.get(`${bookPath(args.book)}/canvases`);
      return result({ canvases, archived });
    },
  },
  // Story Planner M8 (ADR 0003): read-only planner tools over GET /api/v1/books/:b/plan[/<what>]; there are no planner write tools
  {
    name: 'codex_get_plan',
    title: 'Read the story plan',
    description: `Reads a book's story plan (premise, logline, theme question, central conflict, protagonist goal, stakes, protagonist, primary structure, notes) and the planner counts. Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      return result(await api.get(`${bookPath(args.book)}/plan`));
    },
  },
  {
    name: 'codex_get_scene_plan',
    title: 'Read a scene plan',
    description: `Reads the plan of one scene: its planning fields (goal, opposition, conflict, turn, outcome, consequence, stakes, emotional_start, emotional_end, purpose), characters, notes body and sha256 (pass it back as base_sha256 to codex_save_scene_plan). Read only. ${BOOK_DOC} The scene is its id (scene_...).`,
    need: 'read',
    inputSchema: schema({ book: bookArg, scene: { type: 'string', minLength: 1, maxLength: 200, description: 'The scene id.' } }, ['book', 'scene']),
    annotations: READ,
    async run(args, api) {
      return result(await api.get(`${bookPath(args.book)}/plan/scene-plans/${seg(args.scene)}`));
    },
  },
  {
    name: 'codex_get_plan_check',
    title: 'Read the plan check',
    description: `Reads the plan check, the same findings the Plan tab shows: rules PL1 to PL6 (for example a scene with no plan, a beat with no scene, a clue revealed before it is planted), each with rule, severity, title, message, subject and related ids. Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      return result(await api.get(`${bookPath(args.book)}/plan/check`));
    },
  },
  {
    name: 'codex_list_structure_templates',
    title: 'List structure templates',
    description: `Lists the story structure templates (three-act, hero's journey and so on) that codex_create_structure can start from, with their beats. Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      return result(await api.get(`${bookPath(args.book)}/plan/templates`));
    },
  },
  ...[
    ['codex_list_plan_links', 'links', 'List planner links', 'Lists the causal links between scenes (and beats) of the planner: from, to, relation (therefore, but, enables…), the optional what-if branch and rationale.'],
    ['codex_list_arcs', 'arcs', 'List character arcs', 'Lists the character arcs: the character, arc type, start and end state, and the milestones with their scenes.'],
    ['codex_list_structures', 'structures', 'List story structures', 'Lists the story structures (three-act, hero\'s journey…) with their beats and the scenes assigned to each beat; one may be primary.'],
    ['codex_list_relationships', 'relationships', 'List relationships', 'Lists the relationships between two entries: baseline, end state and the developments scene by scene.'],
    ['codex_list_synopses', 'synopses', 'List synopses', 'Lists the synopses (premise, logline, one-page…): type, name, word count and target, and whether their plan sources changed.'],
    ['codex_list_clues', 'clues', 'List clues', 'Lists the clues and reveals: the fact, where it is planted and revealed, red herrings, and who learns it in which scene (the reader or a character, reliably or not).'],
  ].map(([name, what, title, text]) => ({
    name,
    title,
    description: `${text} Read only. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(/** @type {any} */ args, /** @type {any} */ api) {
      return result(await api.get(`${bookPath(args.book)}/plan/${what}`));
    },
  })),
  {
    name: 'codex_get_canvas',
    title: 'Read a canvas',
    description: `Reads one canvas: the JSON Canvas (nodes and edges), its sha256 (pass it back as base_sha256 when saving), refs (what each story card points at) and targets (the scenes, entries, threads, events and planner items - story plan, structures, beats, arcs, relationships, synopses, clues - a story card can link to). A beat column is a group node with storyforge.kind "column" and storyforge.ref = a beat id. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, canvas: canvasArg }, ['book', 'canvas']),
    annotations: READ,
    async run(args, api) {
      const c = await api.get(canvasPathOf(args.book, args.canvas));
      return result({ slug: c.slug, title: c.title, path: c.path, sha256: c.sha256, canvas: c.canvas, problem: c.problem, refs: c.refs, targets: c.targets });
    },
  },
  {
    name: 'codex_create_canvas',
    title: 'Create a canvas',
    description: `Creates a new, empty canvas (a planning board) in a book. The slug comes from the title unless you give one. ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({ book: bookArg, title: { type: 'string', minLength: 1, maxLength: 200, description: 'The canvas title.' }, slug: { type: 'string', minLength: 1, maxLength: 60, description: 'Optional file name: lower-case letters, digits and hyphens.' } }, ['book', 'title']),
    annotations: CANVAS,
    async run(args, api) {
      const r = await api.post(`${bookPath(args.book)}/canvases`, { title: args.title, ...(args.slug !== undefined ? { slug: args.slug } : {}) });
      return result({ ...r, note: CANVAS_NOTE });
    },
  },
  {
    name: 'codex_save_canvas',
    title: 'Save a whole canvas',
    description: `Replaces the whole canvas with content, a JSON Canvas object { nodes, edges, storyforge? }. Nodes have id, type (text | file | link | group), x, y, width, height and an optional color ("1" to "6" or a #hex); text nodes have text, file nodes file, link nodes url, group nodes label. A story card is a node of type file with storyforge.ref set to a scene, entry, thread, event, story-plan, structure, beat, arc, relationship, synopsis or clue id from the targets codex_get_canvas returns (planner cards show the live planner item; writing a canvas never changes the plan). A beat column is a group node { type: "group", label, storyforge: { kind: "column", ref: <beat id> } }; to put a scene in a beat use codex_set_beats, not the canvas. Edges have id, fromNode, toNode and optional label. base_sha256 is required: pass the sha256 from codex_get_canvas; if the canvas changed since, you get a conflict, so read it again and redo your change. For small changes prefer codex_edit_canvas. ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({ book: bookArg, canvas: canvasArg, content: { type: 'object', description: 'The whole JSON Canvas: { "nodes": [...], "edges": [...], "storyforge": {...} }.' }, base_sha256: canvasSha }, ['book', 'canvas', 'content', 'base_sha256']),
    annotations: CANVAS,
    async run(args, api) {
      const r = await api.put(canvasPathOf(args.book, args.canvas), { canvas: args.content, base_sha256: args.base_sha256 });
      return result({ ...r, note: CANVAS_NOTE });
    },
  },
  {
    name: 'codex_edit_canvas',
    title: 'Edit a canvas',
    description: `Changes a canvas by operations instead of resending all of it: add_nodes, update_nodes (each an object with id plus the fields to change), remove_nodes (ids; edges touching them are removed too), add_edges, remove_edges (ids). Give at least one. Node and edge shapes are as in codex_save_canvas, including story cards for planner items (storyforge.ref = a scene, structure, beat, arc, relationship, synopsis, clue or story-plan id) and beat columns (group node, storyforge { kind: "column", ref: <beat id> }); codex_add_plan_cards adds story cards by id more easily. Pass base_sha256 (from codex_get_canvas) to refuse the edit if the canvas changed since you read it. ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({
      book: bookArg,
      canvas: canvasArg,
      base_sha256: canvasSha,
      add_nodes: { type: 'array', items: { type: 'object' }, description: 'Nodes to add; each needs a new id.' },
      update_nodes: { type: 'array', items: { type: 'object' }, description: 'Each { id, ...fields to merge } for an existing node.' },
      remove_nodes: { type: 'array', items: { type: 'string' }, description: 'Ids of nodes to remove (their edges go too).' },
      add_edges: { type: 'array', items: { type: 'object' }, description: 'Edges to add; each needs a new id, fromNode and toNode.' },
      remove_edges: { type: 'array', items: { type: 'string' }, description: 'Ids of edges to remove.' },
    }, ['book', 'canvas']),
    annotations: CANVAS,
    async run(args, api) {
      if (!['add_nodes', 'update_nodes', 'remove_nodes', 'add_edges', 'remove_edges'].some((k) => args[k] !== undefined && args[k].length > 0)) throw new ToolError('give at least one of add_nodes, update_nodes, remove_nodes, add_edges, remove_edges');
      const path = canvasPathOf(args.book, args.canvas);
      const cur = await api.get(path);
      if (args.base_sha256 !== undefined && args.base_sha256 !== cur.sha256) throw new ToolError('the canvas changed since you read it; read it again with codex_get_canvas and redo the edit');
      const next = applyCanvasEdit(cur.canvas, args);
      const r = await api.put(path, { canvas: next, base_sha256: cur.sha256 });
      return result({ ...r, nodes: next.nodes.length, edges: next.edges.length, note: CANVAS_NOTE });
    },
  },
  {
    name: 'codex_add_plan_cards',
    title: 'Add plan cards to a canvas',
    description: `Adds a story card to a canvas for each ref (a scene, structure, beat, arc, relationship, synopsis, clue, story-plan, entry, thread or event id), placed in a simple grid below the existing nodes. Refs already on the canvas are skipped. The canvas is read and saved with its sha256, so a concurrent change gives a conflict. It only places cards; it never changes the plan. ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({ book: bookArg, canvas: canvasArg, refs: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Ids to put on the canvas as story cards (see the targets of codex_get_canvas).' } }, ['book', 'canvas', 'refs']),
    annotations: CANVAS,
    async run(args, api) {
      const path = canvasPathOf(args.book, args.canvas);
      const cur = await api.get(path);
      const nodes = [...(cur.canvas?.nodes ?? [])];
      const onCanvas = new Set(nodes.map((n) => n?.storyforge?.ref).filter((r) => typeof r === 'string'));
      const fresh = [...new Set(/** @type {string[]} */ (args.refs))].filter((r) => !onCanvas.has(r));
      const skipped = args.refs.length - fresh.length;
      if (fresh.length === 0) return result({ slug: cur.slug, added: 0, skipped, sha256: cur.sha256, note: 'Every ref is already on the canvas; nothing was changed.' });
      const x0 = nodes.length > 0 ? Math.min(...nodes.map((n) => Number(n.x) || 0)) : 0;
      const y0 = nodes.length > 0 ? Math.max(...nodes.map((n) => (Number(n.y) || 0) + (Number(n.height) || 0))) + CARD_GAP : 0;
      const ids = new Set(nodes.map((n) => n.id));
      const added = fresh.map((ref, i) => {
        let id;
        do id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        while (ids.has(id));
        ids.add(id);
        return { id, type: 'file', file: 'unknown.md', x: x0 + (i % CARD_COLUMNS) * (CARD_W + CARD_GAP), y: y0 + Math.floor(i / CARD_COLUMNS) * (CARD_H + CARD_GAP), width: CARD_W, height: CARD_H, storyforge: { ref } };
      });
      const r = await api.put(path, { canvas: { ...cur.canvas, nodes: [...nodes, ...added] }, base_sha256: cur.sha256 });
      return result({ ...r, added: added.length, skipped, nodes: nodes.length + added.length, note: CANVAS_NOTE });
    },
  },
  {
    name: 'codex_archive_canvas',
    title: 'Archive a canvas',
    description: `Moves a canvas to the archive (codex_restore_canvas brings it back). ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({ book: bookArg, canvas: canvasArg }, ['book', 'canvas']),
    annotations: CANVAS,
    async run(args, api) {
      const r = await api.post(`${canvasPathOf(args.book, args.canvas)}/archive`, {});
      return result({ ...r, note: CANVAS_NOTE });
    },
  },
  {
    name: 'codex_restore_canvas',
    title: 'Restore a canvas',
    description: `Moves an archived canvas back to the live canvases. ${CANVAS_NOTE} ${BOOK_DOC}`,
    need: 'canvas',
    inputSchema: schema({ book: bookArg, canvas: canvasArg }, ['book', 'canvas']),
    annotations: CANVAS,
    async run(args, api) {
      const r = await api.post(`${canvasPathOf(args.book, args.canvas)}/restore`, {});
      return result({ ...r, note: CANVAS_NOTE });
    },
  },
  // ---- M12 W2 workspace docs: the book, style and per-chapter state docs under planning/ (planning material, not prose)
  {
    name: 'codex_list_docs',
    title: 'List workspace docs',
    description: `Lists the workspace docs of a book: the book settings, the style guide and the per-chapter state docs (situation, characters, knowledge, inventory). Each has a path (its address, for example workspace/book, workspace/style or state/chapter-04/knowledge), title, workspace kind (book, style, state or other), chapter (for state docs), locked and sha256; archived ones are listed separately. A locked doc cannot be changed until the author unlocks it. These are planning documents, not prose. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const r = await api.get(workspaceBase(args.book));
      return result({ docs: r.docs, archived: r.archived });
    },
  },
  {
    name: 'codex_get_doc',
    title: 'Read a workspace doc',
    description: `Reads one workspace doc by its path (the address codex_list_docs shows, for example workspace/style or state/chapter-04/knowledge): title, locked, markdown body and sha256. Pass the sha256 back as base_sha256 to codex_save_doc to change it. A planning document, not prose. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, path: docPathArg }, ['book', 'path']),
    annotations: READ,
    async run(args, api) {
      const doc = await api.get(workspaceBase(args.book), { path: args.path });
      const { body, ...head } = doc;
      return splitResult(doc, String(body ?? ''), head);
    },
  },
  {
    name: 'codex_save_doc',
    title: 'Save a workspace doc',
    description: `Creates a workspace doc, or replaces the whole body of an existing one. The path is the doc's address: workspace/<name> (workspace/book and workspace/style are the book settings and style guide), state/chapter-NN/(situation|characters|knowledge|inventory), or development/<name> for proposals that are never canon. To change an existing doc pass base_sha256 (the sha256 from codex_get_doc or codex_list_docs); if the doc changed since you read it you get a conflict, so read it again and redo your change. A locked doc is refused (LOCKED): only the author unlocks. title is optional. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, path: docPathArg, body: { type: 'string', description: 'The complete markdown body of the doc.' }, title: { type: 'string', minLength: 1, maxLength: 300, description: 'Optional new title.' }, base_sha256: { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the doc as you read it. Required to change an existing doc; leave it out to create one.' } }, ['book', 'path', 'body']),
    annotations: WORKSPACE,
    async run(args, api) {
      const r = await api.post(workspaceBase(args.book), { path: args.path, body: args.body, ...given(args, ['title', 'base_sha256']) });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_append_doc',
    title: 'Append to a workspace doc',
    description: `Appends a block of markdown to the end of a workspace doc (a blank line in between), and creates the doc when it does not exist yet. Use it for running history such as a timeline log. Nothing already in the doc is changed, so no base_sha256 is needed. A locked doc is refused (LOCKED). Same paths as codex_save_doc. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, path: docPathArg, text: { type: 'string', minLength: 1, maxLength: 200000, description: 'The markdown to append.' } }, ['book', 'path', 'text']),
    annotations: WORKSPACE,
    async run(args, api) {
      const r = await api.post(`${workspaceBase(args.book)}/append`, { path: args.path, text: args.text });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_lock_docs',
    title: 'Lock workspace docs',
    description: `Locks one workspace doc (path) or every state doc of one chapter (prefix, for example state/chapter-04), so nothing can change them. Give exactly one of path and prefix. There is no unlock tool: only the author unlocks, in StoryForge. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg, path: docPathArg, prefix: { type: 'string', minLength: 1, maxLength: 100, description: 'A chapter state folder to lock whole, for example state/chapter-04.' } }, ['book']),
    annotations: WORKSPACE,
    async run(args, api) {
      if ((args.path === undefined) === (args.prefix === undefined)) throw new ToolError('give exactly one of "path" and "prefix"');
      const r = await api.post(`${workspaceBase(args.book)}/lock`, { ...given(args, ['path', 'prefix']), locked: true });
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  {
    name: 'codex_setup_workspace',
    title: 'Set up the workspace docs',
    description: `Creates the starter workspace docs that do not exist yet: workspace/book (book settings), workspace/style (style guide) and state/chapter-00/situation, characters, knowledge and inventory (the state before chapter 1). Existing docs are never touched, so it is safe to call again. ${WORKSPACE_NOTE} ${BOOK_DOC}`,
    need: 'workspace',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: WORKSPACE,
    async run(args, api) {
      const r = await api.post(`${bookPath(args.book)}/workspace/setup`, {});
      return result({ ...r, note: WORKSPACE_NOTE });
    },
  },
  ...PLAN_WRITE_TOOLS,
  ...WORKSPACE_TOOLS,
  ...CONTINUITY_TOOLS,
  ...COWRITER_TOOLS,
];

/** Names an author of the original Codex MCP might ask for that v2 has no plugin route for. */
export const NOT_OFFERED = [
  'codex_push_files', 'codex_delete_ledger_item', 'codex_delete_knowledge',
  'codex_delete_state_event',
  // the continuity thresholds and severities are the author's own (continuity settings in StoryForge); there is no plugin route for them
  'codex_set_continuity_thresholds',
];
