// The List mode of the canvas (M10 C10): the plan as plain lists, built from the same planner data, layers and branch the board uses. Pure: no DOM, no network.
import { arcName, relationshipName, sceneName } from '../../planner/model.js';
import { relationLabel } from '../../planner/requests.js';
import { typeLabel } from '../../planner/synopsis.js';
import { kindLabel } from '../../planner/clues.js';
import { activeStructure, excerpt } from './selectors.js';

const idOf = (x) => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : null);
const listOf = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Heading of the group of scenes that sit in no beat (the same words as the built canvas), and of all scenes when the beats layer is off. */
export const NOT_IN_A_BEAT = 'Not in a beat';
export const ALL_SCENES = 'Scenes';

/**
 * @typedef {{ id: string, title: string, chapter: number | null, goal: string, turn: string,
 *   links: { slug: string, relation: string, text: string, toId: string | null, whatIf: boolean }[] }} ListScene
 */

/**
 * Everything List mode shows.
 * `layers` missing or null: every layer on. `branch` null is the main plan: links of a what-if branch are hidden, and with a branch chosen main links plus that branch's links show (marked what-if).
 * `scenePlans` (optional): scene id -> its scene plan `fields` when loaded, for the goal and turn lines.
 * @param {{ plan: any, structureId?: string | null, layers?: Record<string, boolean> | null, branch?: string | null, findings?: any[] | null, scenePlans?: Record<string, any> | null }} p
 * @returns {{ story: { id: string, logline: string, premise: string } | null, primary: string | null, structureName: string | null,
 *   groups: { id: string, name: string, scenes: ListScene[] }[],
 *   clues: { id: string, fact: string, kind: string, planted: string[], revealed: string | null, warn: string | null }[] | null,
 *   arcs: { id: string, name: string, summary: string }[] | null, relationships: { id: string, name: string, summary: string }[] | null,
 *   synopses: { id: string, title: string, type: string, stale: boolean, excerpt: string }[] }}
 */
export function buildPlanList({ plan, structureId = null, layers = null, branch = null, findings = [], scenePlans = null }) {
  const on = (key) => layers?.[key] !== false;
  const scenes = (plan?.scenes ?? []).filter((s) => typeof s?.id === 'string');
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const title = (id, fallback) => sceneName(byId.get(id)?.title ?? fallback);

  // links that start at a scene, after the links layer and the what-if branch
  const outgoing = new Map();
  if (on('links')) {
    for (const l of listOf(plan?.links, 'links')) {
      if (l?.broken || l?.archived || typeof l?.from !== 'string') continue;
      const lb = text(l.branch) || null;
      if (lb !== null && lb !== branch) continue;
      if (!outgoing.has(l.from)) outgoing.set(l.from, []);
      outgoing.get(l.from).push({
        slug: l.slug ?? `${l.from}:${l.to}`,
        relation: l.relation,
        text: `→ ${relationLabel(l.relation)} → ${title(l.to, l.to_title)}`,
        toId: typeof l.to === 'string' ? l.to : null,
        whatIf: lb !== null,
      });
    }
  }
  const row = (s) => {
    const f = scenePlans?.[s.id] ?? {};
    return { id: s.id, title: sceneName(s.title), chapter: Number.isInteger(s.chapter) ? s.chapter : null, goal: text(f.goal), turn: text(f.turn), links: outgoing.get(s.id) ?? [] };
  };

  // scenes in book order, grouped by the first beat of the active structure that lists them
  const structure = activeStructure(plan?.structures, structureId);
  let groups;
  if (on('beats') && structure) {
    const first = new Map();
    (structure.beats ?? []).forEach((b, i) => {
      for (const sid of (b.scenes ?? []).map(idOf)) if (sid && byId.has(sid) && !first.has(sid)) first.set(sid, i);
    });
    groups = (structure.beats ?? []).map((b, i) => ({ id: b.id ?? `beat-${i}`, name: text(b.name) || 'Untitled beat', scenes: scenes.filter((s) => first.get(s.id) === i).map(row) }));
    const loose = scenes.filter((s) => !first.has(s.id));
    if (loose.length > 0) groups.push({ id: 'no-beat', name: NOT_IN_A_BEAT, scenes: loose.map(row) });
  } else groups = [{ id: 'all', name: ALL_SCENES, scenes: scenes.map(row) }];

  const early = new Map((findings ?? []).filter((f) => f?.rule === 'PL6' && typeof f.subject?.id === 'string').map((f) => [f.subject.id, f.title ?? f.message ?? 'Revealed before it is planted']));
  const f = plan?.storyPlan?.fields ?? {};
  return {
    story: plan?.storyPlan ? { id: idOf(plan.storyPlan) ?? '', logline: text(f.logline), premise: text(f.premise) } : null,
    primary: listOf(plan?.structures, 'structures').find((s) => s.primary)?.name ?? null,
    structureName: structure?.name ?? null,
    groups,
    clues: on('clues')
      ? listOf(plan?.clues, 'clues').map((c) => ({
          id: c.id,
          fact: text(c.fact) || 'Untitled clue',
          kind: c.red_herring ? 'Red herring' : kindLabel(c.kind ?? 'clue'),
          planted: (c.planted ?? []).map((p) => title(idOf(p), p?.title)),
          revealed: c.revealed ? title(idOf(c.revealed), c.revealed?.title) : null,
          warn: early.get(c.id) ?? null,
        }))
      : null,
    arcs: on('arcs')
      ? listOf(plan?.arcs, 'arcs').map((a) => ({ id: a.id, name: arcName(a), summary: [text(a.fields?.start_state), text(a.fields?.end_state)].some(Boolean) ? `${text(a.fields?.start_state) || '…'} → ${text(a.fields?.end_state) || '…'}` : '' }))
      : null,
    relationships: on('relationships')
      ? listOf(plan?.relationships, 'relationships').map((r) => ({ id: r.id, name: relationshipName(r), summary: text(r.baseline) || text(r.fields?.baseline) }))
      : null,
    synopses: listOf(plan?.synopses, 'synopses').map((s) => ({ id: s.id, title: text(s.title) || typeLabel(s.type) || 'Synopsis', type: typeLabel(s.type), stale: s.stale === true, excerpt: excerpt(s.body, 160) })),
  };
}

/**
 * The List item for a ref id (what a deep link or a plan-check finding points at), as `{ kind, id, title }`; null when the list has no such item (a beat or a structure has none).
 * @param {ReturnType<typeof buildPlanList>} list @param {string} id
 */
export function locateListItem(list, id) {
  if (list.story && list.story.id === id) return { kind: 'story-plan', id, title: 'Story plan' };
  for (const g of list.groups) {
    const s = g.scenes.find((x) => x.id === id);
    if (s) return { kind: 'scene', id, title: s.title };
  }
  const c = (list.clues ?? []).find((x) => x.id === id);
  if (c) return { kind: 'clue', id, title: c.fact };
  const a = (list.arcs ?? []).find((x) => x.id === id);
  if (a) return { kind: 'arc', id, title: a.name };
  const r = (list.relationships ?? []).find((x) => x.id === id);
  if (r) return { kind: 'relationship', id, title: r.name };
  const y = list.synopses.find((x) => x.id === id);
  if (y) return { kind: 'synopsis', id, title: y.title };
  return null;
}
