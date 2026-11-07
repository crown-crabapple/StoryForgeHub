// Build a canvas from the plan (M10 C8) and tidy cards back to it. Pure: the plan data and the document go in, a new document comes out; no DOM, no network.
// "Build" lays the plan out the way the Plan tab's first canvas shows it; "tidy" only moves cards that are in a beat of the plan but outside that beat's column.
import { COLUMN_GAP, COLUMN_HEAD, COLUMN_PAD, DEFAULT_SIZE, columnMembers, connect, layoutColumns, makeNode, nodeKind, withLink } from '../model.js';
import { isBeatColumn } from './overlay.js';
import { activeStructure } from './selectors.js';

const SCHEMA = 'storyforge.canvas/v1';
/** Space between columns and between rows of cards. */
const GAP = 24;
const ROW_GAP = 48;
const NOT_IN_A_BEAT = 'Not in a beat';

const idOf = (x) => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : null);
const listOf = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);

/** A node of a kind with its top-left corner exactly at (x, y). @param {string} kind @param {number} x @param {number} y @param {Record<string, any>} extra @param {() => number} rand */
function nodeAt(kind, x, y, extra, rand) {
  return { ...makeNode(kind, { x: 0, y: 0 }, extra, rand), x, y };
}

/** The height a column needs for `count` cards of height `h` (the same sum layoutColumns uses). */
const columnHeight = (count, h) => Math.max(DEFAULT_SIZE.column[1] / 2, COLUMN_HEAD + count * (h + COLUMN_GAP) - (count > 0 ? COLUMN_GAP : 0) + COLUMN_PAD);

/**
 * A full canvas document for the plan: the story plan and synopsis cards top-left; a column per beat of the structure, each scene's card in its first beat; scenes in no beat in a last
 * column "Not in a beat" (book order); clue cards in a row under the columns; arc and relationship cards in a row under that; an edge for every main-plan link between two scenes that have cards.
 * @param {{ plan: any, structureId?: string | null, targets?: { ref: string, kind: string }[] | null, title?: string, rand?: () => number }} p
 * @returns {{ nodes: any[], edges: any[], storyforge: { schema: string, title: string } }}
 */
export function buildPlanCanvas({ plan, structureId = null, targets = null, title = 'Story plan', rand = Math.random }) {
  const nodes = [];
  const [cardW, cardH] = DEFAULT_SIZE.story;
  const [colW] = DEFAULT_SIZE.column;
  const story = (x, y, ref, size) => {
    const n = nodeAt('story', x, y, { ref, ...(size ? { size } : {}) }, rand);
    nodes.push(n);
    return n;
  };

  // row 1: story plan, then the synopses
  let x = 0;
  const top = [idOf(plan?.storyPlan), ...listOf(plan?.synopses, 'synopses').map(idOf)].filter(Boolean);
  for (const ref of top) {
    story(x, 0, ref);
    x += cardW + GAP;
  }
  let y = top.length > 0 ? cardH + ROW_GAP : 0;

  // scenes in book order (the flow's scenes; the picker's scene targets when the flow is not there)
  const flowScenes = (plan?.scenes ?? []).map(idOf).filter(Boolean);
  const sceneIds = flowScenes.length > 0 ? flowScenes : (targets ?? []).filter((t) => t?.kind === 'scene').map((t) => t.ref);
  const known = new Set(sceneIds);

  // the first beat of each scene, by structure order
  const structure = activeStructure(plan?.structures, structureId);
  const beats = structure?.beats ?? [];
  const firstBeat = new Map();
  beats.forEach((b, i) => {
    for (const s of (b.scenes ?? []).map(idOf)) if (s && known.has(s) && !firstBeat.has(s)) firstBeat.set(s, i);
  });

  const groups = beats.map((b, i) => ({ label: b.name || 'Beat', ref: b.id, scenes: sceneIds.filter((s) => firstBeat.get(s) === i) }));
  const loose = sceneIds.filter((s) => !firstBeat.has(s));
  if (loose.length > 0) groups.push({ label: NOT_IN_A_BEAT, ref: null, scenes: loose });

  const cardOf = new Map(); // scene id -> node id (the first card)
  x = 0;
  let rowH = 0;
  for (const g of groups) {
    const height = columnHeight(g.scenes.length, cardH);
    const col = nodeAt('column', x, y, { label: g.label, size: [colW, height] }, rand);
    if (g.ref) col.storyforge = { kind: 'column', ref: g.ref };
    nodes.push(col);
    let cy = y + COLUMN_HEAD;
    for (const s of g.scenes) {
      const card = story(x + COLUMN_PAD, cy, s, [colW - 2 * COLUMN_PAD, cardH]);
      cardOf.set(s, card.id);
      cy += cardH + COLUMN_GAP;
    }
    x += colW + GAP;
    rowH = Math.max(rowH, height);
  }
  if (groups.length > 0) y += rowH + ROW_GAP;

  // rows of clues, then arcs and relationships
  const row = (ids) => {
    let rx = 0;
    for (const ref of ids) {
      story(rx, y, ref);
      rx += cardW + GAP;
    }
    if (ids.length > 0) y += cardH + ROW_GAP;
  };
  row(listOf(plan?.clues, 'clues').filter((c) => !c?.archived).map(idOf).filter(Boolean));
  row([...listOf(plan?.arcs, 'arcs'), ...listOf(plan?.relationships, 'relationships')].filter((a) => !a?.archived).map(idOf).filter(Boolean));

  // an edge for each main-plan link between two scenes that have cards
  let doc = { nodes, edges: [] };
  for (const l of listOf(plan?.links, 'links')) {
    if (l?.branch || l?.archived || l?.broken || typeof l?.slug !== 'string' || l.slug === '') continue;
    const from = cardOf.get(l.from);
    const to = cardOf.get(l.to);
    if (!from || !to) continue;
    const next = connect(doc, from, to, rand);
    if (next.edges.length === doc.edges.length) continue;
    const edges = next.edges.slice();
    edges[edges.length - 1] = withLink(edges[edges.length - 1], l.slug, l.relation);
    doc = { ...next, edges };
  }
  return { ...layoutColumns(doc), storyforge: { schema: SCHEMA, title } };
}

/** The ref id of a node: the server's answer for it, else the id in the file. @param {any} node @param {Record<string, any>} refs */
const refIdOf = (node, refs) => (typeof refs?.[node.id]?.id === 'string' ? refs[node.id].id : (node?.storyforge?.ref ?? null));

/**
 * Move every scene card that is in a beat of the structure but not inside that beat's column into the column of its first beat (when that column is on the canvas), then lay the columns out.
 * Never adds or removes a node or an edge. @param {{ nodes: any[], edges: any[] }} doc @param {Record<string, any>} refs node id -> ref info @param {any} plan @param {string | null | undefined} structureId
 */
export function tidyToPlan(doc, refs, plan, structureId) {
  const beats = activeStructure(plan?.structures, structureId)?.beats ?? [];
  if (beats.length === 0) return doc;
  const columns = new Map();
  for (const n of doc.nodes) if (isBeatColumn(n, refs)) columns.set(refIdOf(n, refs), n);
  const moves = new Map();
  for (const n of doc.nodes) {
    const r = refs?.[n.id];
    if (nodeKind(n) !== 'story' || r?.kind !== 'scene' || r.state !== 'ok' || typeof r.id !== 'string') continue;
    const beat = beats.find((b) => (b.scenes ?? []).map(idOf).includes(r.id));
    const col = beat ? columns.get(beat.id) : null;
    if (!col || columnMembers(doc.nodes, col).some((m) => m.id === n.id)) continue;
    moves.set(n.id, { x: col.x + COLUMN_PAD, y: col.y + col.height - n.height });
  }
  if (moves.size === 0) return doc;
  return layoutColumns({ ...doc, nodes: doc.nodes.map((n) => (moves.has(n.id) ? { ...n, ...moves.get(n.id) } : n)) });
}
