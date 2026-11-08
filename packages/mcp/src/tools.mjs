// The MCP tool table (M08 MCP service). Each tool is a name, a JSON Schema for its arguments, the permission it needs ('read', 'propose', 'canvas', 'plan' or 'workspace') and a run() that talks to the
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
 * @typedef {{ name: string, title: string, description: string, need: 'read' | 'propose' | 'canvas' | 'plan' | 'workspace', inputSchema: Record<string, any>,
 *   annotations: { readOnlyHint: boolean, destructiveHint: false, idempotentHint: boolean, openWorldHint: false },
 *   run: (args: Record<string, any>, api: Api) => Promise<ToolResult> }} Tool
 */

const BOOK_DOC = 'The book is its slug or its id (see codex_list_books).';
const CANVAS_NOTE = 'This changed the canvas file directly; it is planning material, not prose.';
const WORKSPACE_NOTE = 'This changed the workspace doc directly (planning material, not prose); the author can Undo it in StoryForge.';
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

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'codex_status',
    title: 'StoryForge status',
    description: 'Shows the StoryForge server and API version and lists the books in the library with their scene and word counts. Start here to find the book slugs.',
    need: 'read',
    inputSchema: schema({}, []),
    annotations: READ,
    async run(_args, api) {
      const root = await api.get('/api/v1');
      const { books } = await api.get('/api/v1/books');
      return result({ api: root.api, server: root.server, books: books.map((/** @type {any} */ b) => ({ slug: b.slug, title: b.title, scenes: b.scenes, words: b.words })) });
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
];

/** Names an author of the original Codex MCP might ask for that v2 has no plugin route for. */
export const NOT_OFFERED = [
  'codex_create_chapter', 'codex_push_files', 'codex_get_ledger',
  'codex_save_ledger_item', 'codex_delete_ledger_item', 'codex_get_cast', 'codex_set_chapter_cast', 'codex_knowledge_at', 'codex_record_knowledge', 'codex_delete_knowledge',
  'codex_continuity_check', 'codex_get_state_events', 'codex_record_state_events', 'codex_delete_state_event', 'codex_dismiss_finding', 'codex_restore_finding',
  'codex_set_continuity_thresholds', 'codex_get_tasks', 'codex_update_task', 'codex_complete_task', 'codex_create_task', 'codex_log_writing',
];
