// Pure helpers for plan data on the canvas (M10 C3/C4): which planner object a story card shows, plan counts for the rail, layer settings kept per book,
// and which cards a plan-check finding points at. The raw JSON of the planner endpoints is kept as is; nothing here touches the DOM or the network.

/** The ref kinds the planner adds to story cards. */
export const PLAN_KINDS = ['story-plan', 'structure', 'beat', 'arc', 'relationship', 'synopsis', 'clue'];
/** @param {unknown} kind */
export const isPlanKind = (kind) => typeof kind === 'string' && PLAN_KINDS.includes(kind);

/** @param {any} data @param {string} key */
const list = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);

/**
 * The planner object a story card shows, by its ref (`{ kind, id }` of the canvas refs). A beat comes back as `{ ...beat, structure }` (the structure it sits in).
 * Null when the plan has no such object (or the plan is not loaded).
 * @param {any} plan the plan data of usePlanData @param {{ kind?: string | null, id?: string | null } | null | undefined} ref
 */
export function planItemFor(plan, ref) {
  if (!plan || !ref || typeof ref.id !== 'string') return null;
  const byId = (items) => items.find((x) => x?.id === ref.id) ?? null;
  switch (ref.kind) {
    case 'story-plan':
      return plan.storyPlan ?? null;
    case 'structure':
      return byId(list(plan.structures, 'structures'));
    case 'beat':
      for (const s of list(plan.structures, 'structures')) {
        const beat = (s.beats ?? []).find((b) => b?.id === ref.id);
        if (beat) return { ...beat, structure: s };
      }
      return null;
    case 'arc':
      return byId(list(plan.arcs, 'arcs'));
    case 'relationship':
      return byId(list(plan.relationships, 'relationships'));
    case 'synopsis':
      return byId(list(plan.synopses, 'synopses'));
    case 'clue':
      return byId(list(plan.clues, 'clues'));
    default:
      return null;
  }
}

/**
 * The chapter number of a scene: `scenes` is a list of `{ id, chapter }` (GET /flow nodes) or targets-like `{ ref, chapter }`. Null when unknown.
 * @param {{ id?: string, ref?: string, chapter?: number | null }[] | null | undefined} scenes @param {string} sceneId
 */
export function chapterOf(scenes, sceneId) {
  const s = (scenes ?? []).find((x) => x?.id === sceneId || x?.ref === sceneId);
  return Number.isInteger(s?.chapter) ? s.chapter : null;
}

/** "Ch 3" / "Ch 3, 5" for chapter numbers (duplicates and unknowns dropped); "" when none. @param {(number | null | undefined)[]} chapters */
export function chaptersText(chapters) {
  const uniq = [...new Set(chapters.filter((c) => Number.isInteger(c)))].sort((a, b) => a - b);
  return uniq.length === 0 ? '' : `Ch ${uniq.join(', ')}`;
}

/** The first N characters of a text, cut at a word and ended with an ellipsis. @param {string | null | undefined} text @param {number} [max] */
export function excerpt(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The structure the rail has chosen: by id, else the primary one, else the first. @param {any} structures GET /structures @param {string | null | undefined} id */
export function activeStructure(structures, id) {
  const all = list(structures, 'structures');
  return all.find((s) => s.id === id) ?? all.find((s) => s.primary) ?? all[0] ?? null;
}

/** The counts the rail shows next to each layer. @param {any} plan @param {string | null | undefined} structureId */
export function planCounts(plan, structureId) {
  const live = list(plan?.links, 'links').filter((l) => !l?.broken && !l?.archived);
  return {
    links: live.length,
    beats: (activeStructure(plan?.structures, structureId)?.beats ?? []).length,
    arcs: list(plan?.arcs, 'arcs').length,
    clues: list(plan?.clues, 'clues').length,
    relationships: list(plan?.relationships, 'relationships').length,
  };
}

/** The plan-check findings (rules PL1 to PL6) of a continuity result. @param {any} result GET /continuity */
export const planFindings = (result) => list(result, 'findings').filter((f) => typeof f?.rule === 'string' && f.rule.startsWith('PL'));

// ---------------------------------------------------------------- layers

/** The layers of the rail, in order: key, label and the token the dot is drawn in. */
export const LAYERS = [
  { key: 'links', label: 'Links', color: 'var(--accent)' },
  { key: 'beats', label: 'Beats', color: 'var(--warning)' },
  { key: 'arcs', label: 'Arcs', color: 'var(--ok)' },
  { key: 'clues', label: 'Clues', color: 'var(--danger)' },
  { key: 'relationships', label: 'Relationships', color: 'var(--text-2)' },
];
export const DEFAULT_LAYERS = Object.freeze(Object.fromEntries(LAYERS.map((l) => [l.key, true])));
/** The localStorage key of a book's layer settings. @param {string} bookId */
export const layersKey = (bookId) => `storyforge.canvas.layers.${bookId}`;

/** The layer settings a stored string holds: every layer a boolean, anything unreadable or missing stays on. @param {string | null | undefined} raw */
export function parseLayers(raw) {
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return Object.fromEntries(LAYERS.map((l) => [l.key, typeof data?.[l.key] === 'boolean' ? data[l.key] : true]));
}

/** Read a book's layers (default: all on); never throws. @param {string} bookId */
export function loadLayers(bookId) {
  try {
    return parseLayers(globalThis.localStorage?.getItem(layersKey(bookId)));
  } catch {
    return { ...DEFAULT_LAYERS };
  }
}

/** Keep a book's layers; a full or blocked store is ignored. @param {string} bookId @param {Record<string, boolean>} layers */
export function saveLayers(bookId, layers) {
  try {
    globalThis.localStorage?.setItem(layersKey(bookId), JSON.stringify(parseLayers(JSON.stringify(layers))));
  } catch {
    // not kept
  }
}

// ---------------------------------------------------------------- findings to cards

/** The ids a finding points at: its subject, then the related scene and beat ids (no duplicates). @param {any} finding */
export function findingRefIds(finding) {
  const ids = [finding?.subject?.id, ...(Array.isArray(finding?.related) ? finding.related : [])].filter((x) => typeof x === 'string' && x !== '');
  return [...new Set(ids)];
}

/** The ref id of a story card: the server's answer for it, else the id in the file. @param {any} node @param {Record<string, any> | undefined} refs */
const refIdOf = (node, refs) => {
  const own = node?.storyforge?.ref;
  if (typeof own !== 'string') return null;
  return typeof refs?.[node.id]?.id === 'string' ? refs[node.id].id : own;
};

/** The ref ids of every story card on a canvas. @param {any[]} nodes @param {Record<string, any> | undefined} refs @returns {Set<string>} */
export const canvasRefIds = (nodes, refs) => new Set((nodes ?? []).map((n) => refIdOf(n, refs)).filter((x) => x !== null));

/** The node ids of the cards that show any of `refIds`. @param {any[]} nodes @param {Record<string, any> | undefined} refs @param {string[]} refIds */
export function nodesForRefIds(nodes, refs, refIds) {
  const want = new Set(refIds);
  return (nodes ?? []).filter((n) => want.has(refIdOf(n, refs))).map((n) => n.id);
}

/** Is any card for the finding on the canvas? `onCanvas` null (no canvas open) counts as yes. @param {any} finding @param {Set<string> | null | undefined} onCanvas */
export const findingOnCanvas = (finding, onCanvas) => !onCanvas || findingRefIds(finding).some((id) => onCanvas.has(id));

// ---------------------------------------------------------------- the story picker

/**
 * Picker targets grouped by kind: the book's own kinds first (in the order they first appear), then the planner kinds in the order of PLAN_KINDS.
 * @template {{ kind: string }} T @param {T[]} targets @returns {{ kind: string, items: T[] }[]}
 */
export function groupTargets(targets) {
  const groups = new Map();
  for (const t of targets) {
    if (!groups.has(t.kind)) groups.set(t.kind, []);
    groups.get(t.kind).push(t);
  }
  const own = [...groups.keys()].filter((k) => !isPlanKind(k));
  const plan = PLAN_KINDS.filter((k) => groups.has(k));
  return [...own, ...plan].map((kind) => ({ kind, items: groups.get(kind) }));
}
