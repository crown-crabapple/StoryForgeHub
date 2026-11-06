// Story Planner data on the Board, Outline and Matrix, from one read-only projection (GET /api/books/:b/plan-badges). Pure: no DOM, no fetch.
//
// `badges` is { scenes: { [sceneId]: { plan, goal, purpose, links_in, links_out, beats: [{ structure_slug, structure_name, primary, beat_id, beat_name }],
//   milestones: [{ arc_slug, name }], relationships: [{ slug, name, change }] } }, arcs: [{ slug, name }],
//   structures: [{ slug, name, primary, beats: [{ id, name, state, scenes: [sceneId] }] }] }, or null (module off, old server, not loaded yet).

const STORAGE_KEY = 'sf.board.cardFace';

/** Which badges a Board card shows. */
export const cardFaceDefaults = () => ({ purpose: false, links: true, beats: true, milestones: true, missing: true });

/** The Card face menu: key and label of each checkbox. */
export const CARD_FACE_OPTIONS = [
  { key: 'purpose', label: 'Purpose' },
  { key: 'links', label: 'Links in/out' },
  { key: 'beats', label: 'Beats' },
  { key: 'milestones', label: 'Arc milestones' },
  { key: 'missing', label: 'Missing summary/goal' },
];

const browserStorage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The stored card face; anything missing, unreadable or of the wrong type falls back to the default for that key. @param {{ getItem: (k: string) => string | null } | null} [storage] */
export function readCardFace(storage = browserStorage()) {
  const face = cardFaceDefaults();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') for (const k of Object.keys(face)) if (typeof parsed[k] === 'boolean') face[k] = parsed[k];
  } catch {
    // an unreadable value is the default
  }
  return face;
}

/** Store the card face; a failure (private mode, full storage) is ignored. @param {ReturnType<typeof cardFaceDefaults>} face @param {{ setItem: (k: string, v: string) => void } | null} [storage] */
export function writeCardFace(face, storage = browserStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(face));
  } catch {
    // not stored: the choice lasts for this visit
  }
}

/** The projection as the views use it: null unless it has the expected shape. */
export const validBadges = (data) => (data && typeof data === 'object' && data.scenes && typeof data.scenes === 'object' ? data : null);

const EMPTY = Object.freeze({ plan: false, goal: null, purpose: null, links_in: 0, links_out: 0, beats: [], milestones: [], relationships: [] });

/** What the projection says about one scene: null without a projection, an empty entry for a scene it does not mention. */
export function badgesFor(badges, sceneId) {
  if (!validBadges(badges)) return null;
  const e = badges.scenes[sceneId];
  return e ? { ...EMPTY, ...e } : EMPTY;
}

/** The primary structure (the projection lists it first), or null. */
export const primaryStructure = (badges) => validBadges(badges)?.structures?.find((s) => s.primary) ?? validBadges(badges)?.structures?.[0] ?? null;

/**
 * The text chips of a card for the chosen face: [{ key, text, label }] (`text` is what is seen, `label` the spoken form).
 * @param {any} badges @param {{ id: string, summary: string }} card @param {ReturnType<typeof cardFaceDefaults>} face
 */
export function badgeChips(badges, card, face) {
  const e = badgesFor(badges, card.id);
  if (!e) return [];
  const chips = [];
  if (face.purpose && e.purpose) chips.push({ key: 'purpose', text: `Purpose: ${e.purpose}`, label: `Purpose: ${e.purpose}` });
  if (face.links && (e.links_in > 0 || e.links_out > 0)) {
    chips.push({ key: 'links', text: `← ${e.links_in} → ${e.links_out}`, label: `${e.links_in} ${e.links_in === 1 ? 'link' : 'links'} in, ${e.links_out} out` });
  }
  if (face.beats) for (const b of e.beats) chips.push({ key: `beat:${b.structure_slug}:${b.beat_id}`, text: `Beat: ${b.beat_name}`, label: `Beat ${b.beat_name} of ${b.structure_name}` });
  if (face.milestones) for (const m of e.milestones) chips.push({ key: `arc:${m.arc_slug}`, text: `Arc: ${m.name}`, label: `Milestone of the arc ${m.name}` });
  if (face.missing) {
    if (!card.summary) chips.push({ key: 'no-summary', text: 'No summary', label: 'Missing: no summary' });
    if (!e.goal) chips.push({ key: 'no-goal', text: 'No goal', label: 'Missing: no goal' });
  }
  return chips;
}

/** The compact text of the Outline's Plan column: the chips' text joined, "" when there is nothing. */
export const planText = (badges, card) => badgeChips(badges, card, { purpose: false, links: true, beats: true, milestones: true, missing: false }).map((c) => c.text).join('; ');

/**
 * The Outline grouped by beat of the primary structure: one group per beat in beat order with its scenes (book order; a scene may be in several beats; an
 * empty beat stays), then the scenes in no beat of it. `keep` is the filter predicate.
 * @param {ReturnType<typeof import('./model.js').buildModel>} model @param {any} badges @param {(s: any) => boolean} [keep]
 * @returns {{ key: string, name: string, scenes: any[], none?: boolean }[] | null} null when there is no primary structure
 */
export function beatGroups(model, badges, keep = () => true) {
  const structure = primaryStructure(badges);
  if (!structure) return null;
  const inBeat = new Set();
  const groups = (structure.beats ?? []).map((b) => {
    const all = (b.scenes ?? []).map((id) => model.sceneById.get(id)).filter(Boolean);
    for (const s of all) inBeat.add(s.id);
    return { key: b.id, name: b.name, scenes: all.filter(keep).sort((x, y) => x.index - y.index) };
  });
  const rest = model.scenes.filter((s) => !inBeat.has(s.id) && keep(s));
  return [...groups, { key: '__none__', name: 'Not in a beat', scenes: rest, none: true }];
}

/**
 * The extra Matrix columns: one per arc (a scene holds a milestone of it) and one per beat of the primary structure (the scene is in it). Each column has
 * `has(sceneId)`.
 * @param {any} badges @param {{ arcs: boolean, beats: boolean }} show
 * @returns {{ key: string, kind: 'arc' | 'beat', name: string, mark: 'M' | 'B', has: (sceneId: string) => boolean }[]}
 */
export function matrixExtraColumns(badges, { arcs = false, beats = false } = {}) {
  if (!validBadges(badges)) return [];
  const out = [];
  if (arcs) {
    for (const a of badges.arcs ?? []) {
      out.push({ key: `arc:${a.slug}`, kind: 'arc', name: a.name, mark: 'M', has: (id) => (badges.scenes[id]?.milestones ?? []).some((m) => m.arc_slug === a.slug) });
    }
  }
  if (beats) {
    for (const b of primaryStructure(badges)?.beats ?? []) {
      const ids = new Set(b.scenes ?? []);
      out.push({ key: `beat:${b.id}`, kind: 'beat', name: b.name, mark: 'B', has: (id) => ids.has(id) });
    }
  }
  return out;
}
