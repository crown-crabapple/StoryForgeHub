// Pure URL builders and request bodies for the Story Planner's scene plans and links (M1 API). No React, no fetch.
import { bookUrl } from '../structure/helpers.js';

/** The ten planning fields of a scene, in the order the Plan section shows them. */
export const PLAN_FIELDS = [
  { key: 'goal', label: 'Goal' },
  { key: 'opposition', label: 'Opposition' },
  { key: 'conflict', label: 'Conflict' },
  { key: 'turn', label: 'Turn' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'consequence', label: 'Consequence' },
  { key: 'stakes', label: 'Stakes' },
  { key: 'emotional_start', label: 'Feeling at start' },
  { key: 'emotional_end', label: 'Feeling at end' },
  { key: 'purpose', label: 'Purpose' },
];

/** GET and POST /api/books/:b/scene-plans/:sceneId */
export const scenePlanUrl = (bookId, sceneId) => bookUrl(bookId, `/scene-plans/${encodeURIComponent(sceneId)}`);

/** GET /api/books/:b/links */
export const linksUrl = (bookId) => bookUrl(bookId, '/links');

/**
 * The POST body that saves some plan fields. `fields` maps a field key to a string, or null to empty it. `sha` is the sha256 of the plan file as last read
 * (null when the scene has no plan file yet: then `base_sha256` is left out).
 * @param {{ fields: Record<string, string | null>, sha?: string | null, characters?: string[], dryRun?: boolean }} p
 */
export function scenePlanBody({ fields, sha = null, characters, dryRun }) {
  return {
    fields,
    ...(characters !== undefined ? { characters } : {}),
    ...(typeof sha === 'string' ? { base_sha256: sha } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/** The value to send for what the author typed: an emptied field is null. */
export const fieldValue = (text) => (String(text).trim() === '' ? null : String(text).trim());

/** A relation as words: "pays_off" -> "pays off". */
export const relationLabel = (relation) => String(relation ?? '').replace(/_/g, ' ');

/**
 * Where the Plan tab shows something: `/books/:id/plan?view=flow&link=<slug>`. Only the given parts are put in the query (`mode` is `list` or `graph`, `filter` is `unlinked`).
 * @param {string} bookId
 * @param {{ view?: string | null, link?: string | null, node?: string | null, mode?: string | null, filter?: string | null, arc?: string | null }} [target]
 */
export function planHref(bookId, { view, link, node, mode, filter, arc } = {}) {
  const q = [['view', view], ['link', link], ['node', node], ['mode', mode], ['filter', filter], ['arc', arc]]
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `/books/${encodeURIComponent(bookId)}/plan${q.length ? `?${q.join('&')}` : ''}`;
}

/**
 * The links that touch a scene, from GET /links: `outgoing` (the scene is `from`) and `incoming` (it is `to`), each in the order given.
 * @param {{ links?: any[] } | null | undefined} data
 */
export function linksForScene(data, sceneId) {
  const all = data?.links ?? [];
  return { outgoing: all.filter((l) => l.from === sceneId), incoming: all.filter((l) => l.to === sceneId && l.from !== sceneId) };
}

// ---------------------------------------------------------------- Plan tab (M2): Overview and Flow

/** The ten relations of a link, with one plain line each (the Connect dialog shows them). "First scene" is `from`, "second scene" is `to`. */
export const RELATIONS = [
  { value: 'therefore', description: 'The first scene causes the second.' },
  { value: 'but', description: 'The second scene runs against what the first set up.' },
  { value: 'enables', description: 'The first scene makes the second possible.' },
  { value: 'reveals', description: 'The first scene shows something the second depends on.' },
  { value: 'motivates', description: 'The first scene gives someone a reason to act in the second.' },
  { value: 'prevents', description: 'The first scene blocks what would otherwise happen in the second.' },
  { value: 'foreshadows', description: 'The first scene hints at what happens in the second.' },
  { value: 'pays_off', description: 'The second scene pays off what the first set up.' },
  { value: 'parallel', description: 'The two scenes mirror each other or run side by side.' },
  { value: 'other', description: 'Some other connection; say which in the rationale.' },
];

/** The seven fields of the story plan, in the order the Overview shows them. */
export const STORY_FIELDS = [
  { key: 'premise', label: 'Premise' },
  { key: 'logline', label: 'Logline' },
  { key: 'theme_question', label: 'Theme / question' },
  { key: 'central_conflict', label: 'Central conflict' },
  { key: 'protagonist', label: 'Protagonist (Codex entry)' },
  { key: 'protagonist_goal', label: "Protagonist's goal" },
  { key: 'stakes', label: 'Stakes' },
];

/** GET /api/books/:b/plan-overview */
export const planOverviewUrl = (bookId) => bookUrl(bookId, '/plan-overview');
/** POST /api/books/:b/story-plan */
export const storyPlanUrl = (bookId) => bookUrl(bookId, '/story-plan');
/** GET /api/books/:b/flow */
export const flowUrl = (bookId) => bookUrl(bookId, '/flow');
/** GET /api/books/:b/objects?kinds=entry (the Codex entries, for the protagonist) */
export const entriesUrl = (bookId) => bookUrl(bookId, '/objects?kinds=entry');
/** POST /api/books/:b/links/:slug, and with the tails /archive and /restore. */
export const linkUrl = (bookId, slug, tail = '') => bookUrl(bookId, `/links/${encodeURIComponent(slug)}${tail}`);

/**
 * The POST body that saves some story-plan fields and/or the notes body. `sha` is the sha256 of planning/story.md as last read (null: there is no file yet).
 * @param {{ fields?: Record<string, string | null>, body?: string, sha?: string | null, dryRun?: boolean }} p
 */
export function storyPlanBody({ fields = {}, body, sha = null, dryRun }) {
  return { fields, ...(body !== undefined ? { body } : {}), base_sha256: typeof sha === 'string' ? sha : null, ...(dryRun ? { dryRun: true } : {}) };
}

/** The request that creates a link; an empty rationale is left out. @param {string} bookId @param {{ from: string, to: string, relation: string, rationale?: string }} v */
export function createLinkRequest(bookId, { from, to, relation, rationale = '' }) {
  return { url: linksUrl(bookId), body: { from, to, relation, ...(rationale.trim() !== '' ? { rationale: rationale.trim() } : {}) } };
}

/** The body that changes a link: the given parts plus the sha256 last read. @param {{ sha256: string }} link @param {{ relation?: string, from?: string, to?: string, rationale?: string }} patch */
export const updateLinkBody = (link, patch) => ({ ...patch, base_sha256: link.sha256 });

/** The body that turns a link around. @param {{ from: string, to: string, sha256: string }} link */
export const reverseLinkBody = (link) => updateLinkBody(link, { from: link.to, to: link.from });

/** True when a refused write means the file changed on disk since it was read (the plain 409 that carries `current`), not a duplicate link. */
export const isStaleWrite = (status, json) => status === 409 && json?.error === 'conflict' && json?.code === undefined;

/** A sentence for the refusals of a link or story-plan write that need their own words; null for the others (they go to explainFailure). */
export function explainLinkFailure(status, json) {
  if (json?.code === 'REFUSED_SELF_LINK') return "A scene can't lead to itself.";
  if (json?.code === 'REFUSED_DUPLICATE_LINK') return 'These scenes already have that link.';
  if (json?.code === 'REFUSED_UNKNOWN_ENTRY') return 'That character is not a Codex entry.';
  if (isStaleWrite(status, json)) return 'This changed elsewhere; reloaded.';
  return null;
}

// ---------------------------------------------------------------- character arcs (M3)

/** The four kinds of arc, each with the plain words the editor shows next to its name. */
export const ARC_TYPES = [
  { value: 'positive', label: 'Positive', words: 'changes for the better' },
  { value: 'negative', label: 'Negative', words: 'changes for the worse' },
  { value: 'flat', label: 'Flat', words: 'stays the same and changes others' },
  { value: 'custom', label: 'Custom', words: 'its own shape; say which in the notes' },
];

/** The seven fields of an arc, in the order the editor shows them. */
export const ARC_FIELDS = [
  { key: 'want', label: 'Want' },
  { key: 'need', label: 'Need' },
  { key: 'false_belief', label: 'False belief' },
  { key: 'fear', label: 'Fear' },
  { key: 'wound', label: 'Wound' },
  { key: 'start_state', label: 'Starts as' },
  { key: 'end_state', label: 'Ends as' },
];

/** The five text fields of a milestone (its scene comes first, as a select). */
export const MILESTONE_FIELDS = [
  { key: 'pressure', label: 'Pressure' },
  { key: 'choice', label: 'Choice' },
  { key: 'belief_before', label: 'Belief before' },
  { key: 'belief_after', label: 'Belief after' },
  { key: 'cost', label: 'Cost' },
];

/** GET /api/books/:b/arcs */
export const arcsUrl = (bookId) => bookUrl(bookId, '/arcs');
/** GET and POST /api/books/:b/arcs/:slug, and with the tails /milestones, /archive and /restore. */
export const arcUrl = (bookId, slug, tail = '') => bookUrl(bookId, `/arcs/${encodeURIComponent(slug)}${tail}`);

/** The request that starts an arc for a Codex entry (by id). @param {string} bookId @param {{ character: string, arc_type?: string | null, fields?: Record<string, string> }} v */
export function createArcRequest(bookId, { character, arc_type, fields }) {
  return { url: arcsUrl(bookId), body: { character, ...(arc_type ? { arc_type } : {}), ...(fields ? { fields } : {}) } };
}

/**
 * The body that changes an arc: the given parts plus the sha256 last read. `fields` maps a key to a string or null (empty it); `arc_type` is a string or null.
 * @param {{ sha256: string }} arc @param {{ arc_type?: string | null, fields?: Record<string, string | null>, body?: string, dryRun?: boolean }} patch
 */
export function updateArcBody(arc, { arc_type, fields, body, dryRun } = {}) {
  return {
    ...(arc_type !== undefined ? { arc_type } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(body !== undefined ? { body } : {}),
    base_sha256: arc.sha256,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/**
 * The body that writes the whole ordered milestone list: string values only, and an empty text field is left out.
 * @param {{ sha256: string }} arc @param {{ scene: string, pressure?: string, choice?: string, belief_before?: string, belief_after?: string, cost?: string }[]} milestones @param {{ dryRun?: boolean }} [opts]
 */
export function milestonesBody(arc, milestones, { dryRun } = {}) {
  const list = milestones.map((m) => {
    const out = { scene: String(m.scene) };
    for (const f of MILESTONE_FIELDS) {
      const v = String(m[f.key] ?? '').trim();
      if (v !== '') out[f.key] = v;
    }
    return out;
  });
  return { milestones: list, base_sha256: arc.sha256, ...(dryRun ? { dryRun: true } : {}) };
}

/** A sentence for the refusals of an arc write that need their own words; null for the others (they go to explainFailure). */
export function explainArcFailure(status, json) {
  if (json?.code === 'REFUSED_DUPLICATE_ARC') return 'This character already has an arc in this book.';
  if (json?.code === 'REFUSED_UNKNOWN_ENTRY') return 'That character is not a Codex entry.';
  if (json?.code === 'REFUSED_UNKNOWN_SCENE') return `A milestone points at a scene that is not in the book${typeof json.index === 'number' ? ` (milestone ${json.index + 1})` : ''}.`;
  if (isStaleWrite(status, json)) return 'This arc changed elsewhere; reloaded.';
  return null;
}

/**
 * The arc milestones set in a scene, from GET /arcs: one `{ arc, milestone }` per milestone whose `scene` is the scene id, arcs in the order given.
 * @param {{ arcs?: any[] } | null | undefined} data
 */
export function arcMilestonesForScene(data, sceneId) {
  return (data?.arcs ?? []).flatMap((arc) => (arc.milestones ?? []).filter((m) => m.scene === sceneId).map((milestone) => ({ arc, milestone })));
}
