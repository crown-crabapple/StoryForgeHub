// The Plan tab's pure model: what the URL says, how the Flow graph is laid out, how a relation is drawn, and the small projections the list and graph share.
// Nothing here touches the DOM or the network, so all of it is tested in node.
import { chapterShort } from '../planning/model.js';
import { planHref, relationLabel } from './requests.js';

/** The two views of the Plan tab, in order. */
export const PLAN_VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'flow', label: 'Flow' },
  { key: 'structure', label: 'Structure' },
  { key: 'arcs', label: 'Arcs' },
];

/**
 * What /books/:id/plan?… asks for: `view` (overview unless `view=flow`), `node` (a scene id), `link` (a link slug), `arc` (an arc slug, with view=arcs), `structure` (a structure slug, with view=structure), `mode` ('list', 'graph' (lanes in the Arcs view),
 * or null for "the default of the screen width") and `filter` ('unlinked' or null).
 * @param {string} [search]
 * @returns {{ view: 'overview' | 'flow' | 'structure' | 'arcs', node: string | null, link: string | null, arc: string | null, structure: string | null, mode: 'list' | 'graph' | null, filter: 'unlinked' | null }}
 */
export function parsePlanSearch(search = '') {
  const p = new URLSearchParams(search);
  const mode = p.get('mode');
  return {
    view: p.get('view') === 'flow' ? 'flow' : p.get('view') === 'arcs' ? 'arcs' : p.get('view') === 'structure' ? 'structure' : 'overview',
    node: p.get('node') || null,
    link: p.get('link') || null,
    arc: p.get('arc') || null,
    structure: p.get('structure') || null,
    mode: mode === 'list' || mode === 'graph' ? mode : null,
    filter: p.get('filter') === 'unlinked' ? 'unlinked' : null,
  };
}

/**
 * The address of the Plan tab with some parts of the current state changed (`null` removes a part). `parsePlanSearch(planUrl(...).split('?')[1])` gives the state back.
 * @param {string} bookId
 * @param {ReturnType<typeof parsePlanSearch>} state
 * @param {Partial<ReturnType<typeof parsePlanSearch>>} [patch]
 */
export const planUrl = (bookId, state, patch = {}) => {
  const next = { ...state, ...patch };
  return planHref(bookId, { view: next.view === 'flow' || next.view === 'arcs' || next.view === 'structure' ? next.view : null, node: next.node, link: next.link, mode: next.mode, filter: next.filter, arc: next.arc, structure: next.structure });
};

export const sceneName = (title) => title || 'Untitled scene';

// ---------------------------------------------------------------- relations as lines

/** The line style of each relation. A style is never the only cue: the relation is also written out as text. */
export const RELATION_STYLES = {
  therefore: 'solid',
  enables: 'solid',
  motivates: 'solid',
  but: 'dashed',
  prevents: 'dashed',
  reveals: 'dotted',
  foreshadows: 'dotted',
  pays_off: 'dotted',
  parallel: 'long-dash',
  other: 'long-dash',
};
const DASH = { solid: null, dashed: '8 5', dotted: '2 5', 'long-dash': '18 6' };
/** What each style is called in the legend. */
export const STYLE_NAMES = { solid: 'solid', dashed: 'dashed', dotted: 'dotted', 'long-dash': 'long dashes' };

/** The stroke of a relation: `{ group, dasharray }` (dasharray is null for a solid line). An unknown relation draws like `other`. @param {string} relation */
export function relationStroke(relation) {
  const group = RELATION_STYLES[relation] ?? 'long-dash';
  return { group, dasharray: DASH[group] };
}

/** The legend as sentences: "Solid: therefore, enables, motivates." @returns {string[]} */
export function strokeLegend() {
  return Object.keys(STYLE_NAMES).map((group) => {
    const words = Object.keys(RELATION_STYLES).filter((r) => RELATION_STYLES[r] === group).map(relationLabel);
    return `${STYLE_NAMES[group][0].toUpperCase()}${STYLE_NAMES[group].slice(1)}: ${words.join(', ')}.`;
  });
}

// ---------------------------------------------------------------- scenes and links

/** Scenes whose title contains `query` (case-insensitive); an empty query keeps all. @param {any[]} nodes @param {string} query */
export function filterNodes(nodes, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return nodes;
  return nodes.filter((n) => sceneName(n.title).toLowerCase().includes(q));
}

/** The scenes that no live link starts or ends at, in the order given. @param {any[]} nodes @param {{ from: string, to: string }[]} links */
export function unlinkedNodes(nodes, links) {
  const ends = new Set(links.flatMap((l) => [l.from, l.to]));
  return nodes.filter((n) => !ends.has(n.id));
}

/**
 * A link in words. With `nodeById` (the live scenes of GET /flow) the titles and "missing" come from it; without, from the link's own `from_title` and `to_title` (null = not live).
 * `sentence` reads "The Key — therefore → Ferry", with " (missing scene)" added when an end is not a live scene.
 * @param {{ from: string, to: string, relation: string, from_title?: string | null, to_title?: string | null }} link
 * @param {Map<string, any> | null} [nodeById]
 * @returns {{ from: string, to: string, broken: boolean, sentence: string, name: string }}
 */
export function describeLink(link, nodeById = null) {
  const end = (id, title) => {
    const live = nodeById ? nodeById.get(id) : title === null || title === undefined ? null : { title };
    return live ? { name: sceneName(live.title), missing: false } : { name: 'Missing scene', missing: true };
  };
  const a = end(link.from, link.from_title);
  const b = end(link.to, link.to_title);
  const broken = a.missing || b.missing;
  const words = relationLabel(link.relation);
  return { from: a.name, to: b.name, broken, sentence: `${a.name} — ${words} → ${b.name}${broken ? ' (missing scene)' : ''}`, name: `${a.name} ${words} ${b.name}` };
}

// ---------------------------------------------------------------- graph layout

export const NODE_W = 200;
export const NODE_H = 104;
export const GAP_X = 96;
export const GAP_Y = 28;
export const PAD = 24;
export const HEAD = 32;

/**
 * The place of every scene: one column per chapter in reading order (a chapter is told apart by its act and number), the scenes of a column stacked by `sequence`
 * (ties keep the order given). The same scenes always give the same boxes: nothing depends on screen size or on earlier layouts.
 * @param {{ id: string, act?: number | null, chapter?: number | null, sequence?: number | null }[]} nodes scenes in reading order
 * @returns {{ nodes: { id: string, x: number, y: number, width: number, height: number, column: number, row: number }[], columns: { key: string, label: string, x: number, count: number }[], width: number, height: number }}
 */
export function layoutGraph(nodes) {
  /** @type {Map<string, { key: string, chapter: number | null, nodes: any[] }>} */
  const byKey = new Map();
  for (const n of nodes) {
    const key = `${n.act ?? ''}:${n.chapter ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, { key, chapter: typeof n.chapter === 'number' ? n.chapter : null, nodes: [] });
    byKey.get(key)?.nodes.push(n);
  }
  const placed = [];
  const columns = [];
  let tallest = 0;
  [...byKey.values()].forEach((col, c) => {
    const x = PAD + c * (NODE_W + GAP_X);
    const ordered = col.nodes.map((n, i) => ({ n, i })).sort((a, b) => (a.n.sequence ?? 0) - (b.n.sequence ?? 0) || a.i - b.i);
    ordered.forEach(({ n }, row) => placed.push({ id: n.id, x, y: PAD + HEAD + row * (NODE_H + GAP_Y), width: NODE_W, height: NODE_H, column: c, row }));
    columns.push({ key: col.key, label: col.chapter === null ? 'Chapter' : chapterShort(col.chapter), x, count: ordered.length });
    tallest = Math.max(tallest, ordered.length);
  });
  if (columns.length === 0) return { nodes: [], columns: [], width: 0, height: 0 };
  return {
    nodes: placed,
    columns,
    width: PAD * 2 + columns.length * NODE_W + (columns.length - 1) * GAP_X,
    height: PAD * 2 + HEAD + tallest * NODE_H + (tallest - 1) * GAP_Y,
  };
}

/** The scale at which a layout of `width` x `height` fits a viewport (never above 100%, never below `min`). */
export function fitScale(width, height, viewW, viewH, margin = 16, min = 0.25) {
  if (width <= 0 || height <= 0 || viewW <= 0 || viewH <= 0) return 1;
  return Math.max(min, Math.min(1, (viewW - margin) / width, (viewH - margin) / height));
}

// ---------------------------------------------------------------- arcs (M3)

/** What a milestone is called in short: its choice, else its pressure, else empty. @param {{ choice?: string, pressure?: string }} m */
export const milestoneSummary = (m) => m?.choice || m?.pressure || '';

/** The name of an arc's character (the entry's name, else the arc's slug). @param {{ slug: string, character?: { name?: string } | null }} arc */
export const arcName = (arc) => arc.character?.name || arc.slug;

/** "Ch 2: The Key" for a scene of GET /flow (or "The Key" without a chapter). */
export const sceneLabel = (n) => `${typeof n.chapter === 'number' ? `${chapterShort(n.chapter)}: ` : ''}${sceneName(n.title)}`;

/** The accessible name of a lane marker: "Maren: Takes the key in The Ferry". */
export const markerName = (arc, m, title) => `${arcName(arc)}: ${milestoneSummary(m) || `milestone ${m.index + 1}`} in ${sceneName(title)}`;

export const LANE_LABEL_W = 168;
export const LANE_COL_W = 52;
export const LANE_ROW_H = 60;
export const LANE_HEAD = 52;
export const LANE_PAD = 12;
export const LANE_MARK = 28;

/**
 * The lanes of the Arcs view: one row per arc, one narrow column per scene in reading order, a marker at the column of each milestone's scene. Pure: the same arcs and
 * scenes always give the same boxes. A milestone whose scene is not among `nodes` has no marker (it is counted in `unplaced`; the list still shows it). Several milestones
 * of one arc in one scene sit side by side, a few pixels apart.
 * @param {any[]} arcs GET /arcs `arcs` @param {{ id: string, title?: string, act?: number | null, chapter?: number | null }[]} nodes scenes in reading order (GET /flow nodes)
 * @returns {{ columns: { id: string, x: number, title: string }[], chapters: { key: string, label: string, x: number, width: number }[],
 *   rows: { slug: string, name: string, y: number, markers: { key: string, slug: string, index: number, scene: string, x: number, y: number, text: string, name: string }[] }[],
 *   width: number, height: number, unplaced: number }}
 */
export function layoutLanes(arcs, nodes) {
  const colX = new Map();
  const columns = nodes.map((n, i) => {
    const x = LANE_LABEL_W + LANE_PAD + i * LANE_COL_W;
    colX.set(n.id, { x, title: n.title });
    return { id: n.id, x, title: sceneName(n.title) };
  });
  /** @type {{ key: string, label: string, x: number, width: number }[]} */
  const chapters = [];
  nodes.forEach((n, i) => {
    const key = `${n.act ?? ''}:${n.chapter ?? ''}`;
    const last = chapters[chapters.length - 1];
    if (last && last.key === key) last.width += LANE_COL_W;
    else chapters.push({ key, label: typeof n.chapter === 'number' ? chapterShort(n.chapter) : 'Chapter', x: columns[i].x, width: LANE_COL_W });
  });
  let unplaced = 0;
  const rows = arcs.map((arc, r) => {
    const y = LANE_HEAD + r * LANE_ROW_H;
    const seen = new Map();
    const markers = [];
    for (const m of arc.milestones ?? []) {
      const col = colX.get(m.scene);
      if (!col) {
        unplaced += 1;
        continue;
      }
      const slot = seen.get(m.scene) ?? 0;
      seen.set(m.scene, slot + 1);
      markers.push({
        key: `${arc.slug}:${m.index}`,
        slug: arc.slug,
        index: m.index,
        scene: m.scene,
        x: col.x + (LANE_COL_W - LANE_MARK) / 2 + slot * 10,
        y: y + (LANE_ROW_H - LANE_MARK) / 2,
        text: String(m.index + 1),
        name: markerName(arc, m, col.title),
      });
    }
    return { slug: arc.slug, name: arcName(arc), y, markers };
  });
  const width = nodes.length === 0 ? 0 : LANE_LABEL_W + LANE_PAD * 2 + nodes.length * LANE_COL_W;
  return { columns, chapters, rows, width, height: arcs.length === 0 ? 0 : LANE_HEAD + arcs.length * LANE_ROW_H + LANE_PAD, unplaced };
}
