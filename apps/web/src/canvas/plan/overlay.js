// What the plan draws over the canvas (M10 C5): link filtering by layer and what-if branch, beat columns, clue / relationship edges, badges on scene cards and finding marks.
// Everything here is derived from the planner data and the document; nothing is saved into the .canvas file and the inputs are never changed. No DOM, no network.
import { arcName } from '../../planner/model.js';
import { relationLabel } from '../../planner/requests.js';
import { columnMembers, edgeLink, indexLinks, makeNode, nodeKind } from '../model.js';
import { excerpt, findingRefIds } from './selectors.js';

/** The most badges one card shows. */
export const MAX_BADGES = 3;

const idOf = (x) => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : null);
const listOf = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);

/** The ref id of a node: the server's answer for it, else the id in the file; null without a ref. @param {any} node @param {Record<string, any> | null | undefined} refs node id -> ref info */
const refIdOf = (node, refs) => {
  const own = node?.storyforge?.ref;
  if (typeof own !== 'string') return null;
  return typeof refs?.[node.id]?.id === 'string' ? refs[node.id].id : own;
};

/** Is the node a column that stands for a beat? (its ref says beat, or the server has not answered for it yet) @param {any} node @param {Record<string, any> | null | undefined} refs */
export const isBeatColumn = (node, refs) => nodeKind(node) === 'column' && typeof node.storyforge?.ref === 'string' && (refs?.[node.id] === undefined || refs[node.id].kind === 'beat');

/** Is the node a story card of a live scene? @param {any} node @param {Record<string, any> | null | undefined} refs */
const isSceneCard = (node, refs) => nodeKind(node) === 'story' && refs?.[node.id]?.kind === 'scene' && refs[node.id].state === 'ok' && typeof refs[node.id].id === 'string';

/** The node ids of the story cards of one ref kind, by ref id. @param {any[]} nodes @param {Record<string, any>} refs @param {string} kind @returns {Map<string, string[]>} */
function cardsOf(nodes, refs, kind) {
  const out = new Map();
  for (const n of nodes) {
    if (nodeKind(n) !== 'story' || refs?.[n.id]?.kind !== kind || refs[n.id].state !== 'ok') continue;
    const id = refs[n.id].id;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(n.id);
  }
  return out;
}

/** A new column for a beat: a saved column node whose `storyforge.ref` is the beat id (so the column layout works and a scene dropped in it is assigned). @param {{ x: number, y: number }} at @param {string} beatId */
export function beatColumnNode(at, beatId) {
  const node = makeNode('column', at, { label: 'Beat' });
  return { ...node, storyforge: { kind: 'column', ref: beatId } };
}

/**
 * The overlay of the plan for one canvas. `layers` missing or null means every layer on; `branch` null is the main plan.
 * `refs` is node id -> ref info (the server's refs, with the story cards' refs). `edges` (the document's edges) is needed to filter links.
 * @param {{ nodes: any[], edges?: any[], refs: Record<string, any>, plan: any, layers?: Record<string, boolean> | null, branch?: string | null, findings?: any[] | null }} p
 * @returns {{ hiddenEdgeIds: Set<string>, dashedEdgeIds: Set<string>, edgeLabels: Map<string, string>,
 *   extraEdges: { id: string, from: string, to: string, kind: 'plants' | 'reveals' | 'develops', label: string, warn: boolean }[],
 *   badges: Map<string, { label: string, tone: string }[]>, marks: Map<string, string[]>, hiddenNodeIds: Set<string> }}
 */
export function planOverlay({ nodes, edges = [], refs, plan, layers = null, branch = null, findings = [] }) {
  const on = (key) => layers?.[key] !== false;
  const hiddenEdgeIds = new Set();
  const dashedEdgeIds = new Set();
  const edgeLabels = new Map();
  const extraEdges = [];
  const badges = new Map();
  const marks = new Map();
  const hiddenNodeIds = new Set();
  const addBadge = (nodeId, label, tone) => {
    if (!badges.has(nodeId)) badges.set(nodeId, []);
    badges.get(nodeId).push({ label, tone });
  };

  // ---- links: layer and what-if branch
  const live = plan?.links ? indexLinks(plan.links) : null;
  for (const ed of edges) {
    const slug = edgeLink(ed);
    if (!slug) continue;
    if (!on('links')) {
      hiddenEdgeIds.add(ed.id);
      continue;
    }
    const link = live?.get(slug);
    const linkBranch = typeof link?.branch === 'string' && link.branch !== '' ? link.branch : null;
    if (linkBranch === null) continue;
    if (branch === null || linkBranch !== branch) hiddenEdgeIds.add(ed.id);
    else {
      dashedEdgeIds.add(ed.id);
      edgeLabels.set(ed.id, `${relationLabel(link.relation)} · what-if`);
    }
  }

  // ---- beats: the columns, and a badge on each scene card the beat lists
  if (!on('beats')) for (const n of nodes) if (isBeatColumn(n, refs)) hiddenNodeIds.add(n.id);
  const sceneCards = new Map();
  for (const n of nodes) {
    if (!isSceneCard(n, refs)) continue;
    const id = refs[n.id].id;
    if (!sceneCards.has(id)) sceneCards.set(id, []);
    sceneCards.get(id).push(n.id);
  }
  if (on('beats')) {
    for (const s of listOf(plan?.structures, 'structures'))
      for (const beat of s.beats ?? [])
        for (const sceneId of (beat.scenes ?? []).map(idOf)) for (const nodeId of sceneCards.get(sceneId) ?? []) addBadge(nodeId, beat.name || 'Beat', 'beat');
  }

  // ---- clues: plant and reveal edges and badges
  if (on('clues')) {
    const early = new Set((findings ?? []).filter((f) => f?.rule === 'PL6' && typeof f.subject?.id === 'string').map((f) => f.subject.id));
    const clueCards = cardsOf(nodes, refs, 'clue');
    for (const clue of listOf(plan?.clues, 'clues')) {
      const short = excerpt(clue.fact ?? '', 28);
      const planted = [...new Set((clue.planted ?? []).map(idOf).filter(Boolean))];
      const revealed = idOf(clue.revealed);
      const flagged = early.has(clue.id);
      for (const sceneId of planted) {
        for (const nodeId of sceneCards.get(sceneId) ?? []) {
          addBadge(nodeId, `Plants · ${short}`, 'clue');
          for (const clueNode of clueCards.get(clue.id) ?? []) extraEdges.push({ id: `plants:${nodeId}:${clueNode}`, from: nodeId, to: clueNode, kind: 'plants', label: 'plants', warn: false });
        }
      }
      if (revealed) {
        for (const nodeId of sceneCards.get(revealed) ?? []) {
          addBadge(nodeId, `Reveals · ${short}`, flagged ? 'warn' : 'clue');
          for (const clueNode of clueCards.get(clue.id) ?? [])
            extraEdges.push({ id: `reveals:${clueNode}:${nodeId}`, from: clueNode, to: nodeId, kind: 'reveals', label: flagged ? 'reveals · too early' : 'reveals', warn: flagged });
        }
      }
    }
  }

  // ---- arcs: a milestone in a scene
  if (on('arcs')) {
    for (const arc of listOf(plan?.arcs, 'arcs')) {
      const done = new Set();
      for (const m of arc.milestones ?? []) {
        if (typeof m?.scene !== 'string' || done.has(m.scene)) continue;
        done.add(m.scene);
        for (const nodeId of sceneCards.get(m.scene) ?? []) addBadge(nodeId, `Arc · ${arcName(arc)}`, 'arc');
      }
    }
  }

  // ---- relationships: develops edges
  if (on('relationships')) {
    const relCards = cardsOf(nodes, refs, 'relationship');
    for (const rel of listOf(plan?.relationships, 'relationships')) {
      const seen = new Set();
      for (const d of rel.developments ?? []) {
        if (typeof d?.scene !== 'string') continue;
        for (const relNode of relCards.get(rel.id) ?? []) {
          for (const nodeId of sceneCards.get(d.scene) ?? []) {
            const id = `develops:${relNode}:${nodeId}`;
            if (seen.has(id)) continue;
            seen.add(id);
            extraEdges.push({ id, from: relNode, to: nodeId, kind: 'develops', label: 'develops', warn: false });
          }
        }
      }
    }
  }

  // ---- finding marks (not a layer: a finding always marks its cards)
  for (const f of findings ?? []) {
    const ids = findingRefIds(f);
    const title = String(f?.title ?? f?.message ?? '').trim();
    if (ids.length === 0 || title === '') continue;
    for (const n of nodes) {
      const rid = refIdOf(n, refs);
      if (rid === null || !ids.includes(rid)) continue;
      const list = marks.get(n.id) ?? [];
      if (!list.includes(title)) list.push(title);
      marks.set(n.id, list);
    }
  }

  for (const [id, list] of badges) badges.set(id, list.slice(0, MAX_BADGES));
  return { hiddenEdgeIds, dashedEdgeIds, edgeLabels, extraEdges, badges, marks, hiddenNodeIds };
}

// ---------------------------------------------------------------- drag to assign

/** The beat id of the beat column that holds a node, or null. @param {any[]} nodes @param {any} node @param {Record<string, any>} refs */
function beatOfNode(nodes, node, refs) {
  const col = nodes.filter((c) => isBeatColumn(c, refs)).find((c) => columnMembers(nodes, c).some((m) => m.id === node.id));
  return col ? refIdOf(col, refs) : null;
}

/**
 * Which beats the scene cards entered and left between two versions of the nodes (a drag): `add` the beat entered, `remove` the beat left. Cards that stay in the same beat (or in none) are not listed.
 * @param {any[]} beforeNodes @param {any[]} afterNodes @param {Record<string, any>} refs node id -> ref info
 * @returns {{ sceneId: string, add?: string, remove?: string }[]}
 */
export function beatMoves(beforeNodes, afterNodes, refs) {
  const before = new Map(beforeNodes.map((n) => [n.id, n]));
  const out = [];
  const seen = new Set();
  for (const n of afterNodes) {
    const was = before.get(n.id);
    if (!was || !isSceneCard(n, refs)) continue;
    const from = beatOfNode(beforeNodes, was, refs);
    const to = beatOfNode(afterNodes, n, refs);
    if (from === to) continue;
    const move = { sceneId: refs[n.id].id, ...(to ? { add: to } : {}), ...(from ? { remove: from } : {}) };
    const key = JSON.stringify(move);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(move);
  }
  return out;
}

/**
 * The beats of one structure with the moves applied: every beat's scenes as plain ids, a scene added at the end of the beat it entered and taken out of the beat it left.
 * Null when no move touches this structure's beats.
 * @param {any[]} beats the beats of a structure @param {{ sceneId: string, add?: string, remove?: string }[]} moves
 */
export function beatsAfterMoves(beats, moves) {
  let changed = false;
  const next = beats.map((b) => {
    let scenes = (b.scenes ?? []).map(idOf).filter(Boolean);
    for (const m of moves) {
      if (m.remove === b.id && scenes.includes(m.sceneId)) {
        scenes = scenes.filter((s) => s !== m.sceneId);
        changed = true;
      }
      if (m.add === b.id && !scenes.includes(m.sceneId)) {
        scenes = [...scenes, m.sceneId];
        changed = true;
      }
    }
    return { ...b, scenes };
  });
  return changed ? next : null;
}
