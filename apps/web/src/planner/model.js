// The Plan tab's pure model: what the URL says, how the Flow graph is laid out, how a relation is drawn, and the small projections the list and graph share.
// Nothing here touches the DOM or the network, so all of it is tested in node.
import { chapterShort } from '../planning/model.js';
import { planHref, relationLabel } from './requests.js';

/** The two views of the Plan tab, in order. */
export const PLAN_VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'flow', label: 'Flow' },
  { key: 'structure', label: 'Structure' },
  { key: 'arcs', label: 'Lanes' },
  { key: 'synopsis', label: 'Synopsis' },
  { key: 'clues', label: 'Clues' },
];

/**
 * What /books/:id/plan?… asks for: `view` (overview unless `view=flow`), `node` (a scene id), `link` (a link slug), `arc` (an arc slug, with view=arcs), `relationship` (a relationship slug, with view=arcs), `structure` (a structure slug, with view=structure), `mode` ('list', 'graph' (lanes in the Arcs view),
 * or null for "the default of the screen width") and `filter` ('unlinked' or null).
 * `clue` and `branch` are read apart from this (see clueFromSearch and branchFromSearch), so the result for an empty query stays as it was; planUrl carries them when the state has them.
 * @param {string} [search]
 * @returns {{ view: 'overview' | 'flow' | 'structure' | 'arcs' | 'synopsis' | 'clues', node: string | null, link: string | null, arc: string | null, relationship: string | null, structure: string | null, mode: 'list' | 'graph' | 'relationships' | null, filter: 'unlinked' | null }}
 */
export function parsePlanSearch(search = '') {
  const p = new URLSearchParams(search);
  const mode = p.get('mode');
  return {
    view: p.get('view') === 'flow' ? 'flow' : p.get('view') === 'arcs' ? 'arcs' : p.get('view') === 'structure' ? 'structure' : p.get('view') === 'synopsis' ? 'synopsis' : p.get('view') === 'clues' ? 'clues' : 'overview',
    node: p.get('node') || null,
    link: p.get('link') || null,
    arc: p.get('arc') || null,
    relationship: p.get('relationship') || null,
    structure: p.get('structure') || null,
    mode: mode === 'list' || mode === 'graph' || mode === 'relationships' ? mode : null,
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
  return planHref(bookId, { view: next.view === 'flow' || next.view === 'arcs' || next.view === 'structure' || next.view === 'synopsis' || next.view === 'clues' ? next.view : null, node: next.node, link: next.link, mode: next.mode, filter: next.filter, arc: next.arc, structure: next.structure, relationship: next.relationship, clue: next.clue, branch: next.branch });
};

export const sceneName = (title) => title || 'Untitled scene';

/** The clue slug the URL asks for (`?clue=`), or null. @param {string} [search] */
export const clueFromSearch = (search = '') => new URLSearchParams(search).get('clue') || null;

// ---------------------------------------------------------------- what-if branches (M8)

/** The `branch` value of the Flow filter that shows every branch together (not a slug, so it can never be a branch name). */
export const ALL_BRANCHES = '*';
/** The longest branch name. */
export const BRANCH_MAX = 40;
/** The rule a branch name follows, in words (shown next to the field). */
export const BRANCH_RULE = `Use lowercase letters, digits and hyphens, up to ${BRANCH_MAX} characters (for example ferry-sinks).`;
const BRANCH_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What the author typed in a Branch field: empty means the main plan (`value: null`); otherwise a slug of lowercase letters, digits and single hyphens, at most 40 characters.
 * @param {string | null | undefined} text
 * @returns {{ value: string | null, error: string | null }}
 */
export function validateBranch(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { value: null, error: null };
  if (t.length > BRANCH_MAX || !BRANCH_RE.test(t)) return { value: null, error: BRANCH_RULE };
  return { value: t, error: null };
}

/** The Flow branch filter the URL asks for: null (the main plan), a branch slug, or ALL_BRANCHES. Anything else is the main plan. @param {string} [search] */
export function branchFromSearch(search = '') {
  const b = new URLSearchParams(search).get('branch');
  return b === ALL_BRANCHES || (b !== null && BRANCH_RE.test(b) && b.length <= BRANCH_MAX) ? b : null;
}

/** The edges (or links) a branch filter shows: `null` the main plan (no branch), ALL_BRANCHES everything, else that branch only. @template {{ branch?: string | null }} T @param {T[]} edges @param {string | null | undefined} filter */
export function edgesForBranch(edges, filter) {
  if (filter === ALL_BRANCHES) return edges;
  if (typeof filter === 'string' && filter !== '') return edges.filter((e) => e.branch === filter);
  return edges.filter((e) => !e.branch);
}

/** The branch names in use, sorted: GET /flow `branches` when given, plus the branch of every edge and link. @param {string[] | null | undefined} named @param {...{ branch?: string | null }[]} lists */
export function branchNames(named, ...lists) {
  const all = new Set((named ?? []).filter((b) => typeof b === 'string' && b !== ''));
  for (const list of lists) for (const e of list ?? []) if (typeof e?.branch === 'string' && e.branch !== '') all.add(e.branch);
  return [...all].sort();
}

/** "[ferry-sinks] " for a branch link, else "". @param {{ branch?: string | null }} link */
export const branchPrefix = (link) => (link?.branch ? `[${link.branch}] ` : '');

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
    return live ? { name: live.kind === 'beat' ? beatLabel(live) : sceneName(live.title), missing: false } : { name: 'Missing scene', missing: true };
  };
  const a = end(link.from, link.from_title);
  const b = end(link.to, link.to_title);
  const broken = a.missing || b.missing;
  const words = relationLabel(link.relation);
  const tag = branchPrefix(link);
  return { from: a.name, to: b.name, broken, sentence: `${tag}${a.name} — ${words} → ${b.name}${broken ? ' (missing scene)' : ''}`, name: `${tag}${a.name} ${words} ${b.name}` };
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
 * (ties keep the order given). Beat nodes (`kind: 'beat'`, M5) are not scenes: they sit in their own top row, labelled "Beats", and the scene columns start below it.
 * The same nodes always give the same boxes: nothing depends on screen size or on earlier layouts.
 * @param {{ id: string, kind?: string, act?: number | null, chapter?: number | null, sequence?: number | null }[]} nodes scenes in reading order (and beats)
 * @returns {{ nodes: { id: string, x: number, y: number, width: number, height: number, column: number, row: number }[], columns: { key: string, label: string, x: number, count: number }[], beatsRow?: { label: string, x: number, y: number } | null, top?: number, width: number, height: number }}
 *   `top` is how far the scene columns are pushed down by the beats row (0 without beats); `column` of a beat is its place in the beats row and `row` is -1.
 */
export function layoutGraph(nodes) {
  const beats = nodes.filter((n) => n.kind === 'beat');
  const scenes = nodes.filter((n) => n.kind !== 'beat');
  /** @type {Map<string, { key: string, chapter: number | null, nodes: any[] }>} */
  const byKey = new Map();
  for (const n of scenes) {
    const key = `${n.act ?? ''}:${n.chapter ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, { key, chapter: typeof n.chapter === 'number' ? n.chapter : null, nodes: [] });
    byKey.get(key)?.nodes.push(n);
  }
  const top = beats.length > 0 ? HEAD + NODE_H + GAP_Y : 0;
  const placed = [];
  const columns = [];
  let tallest = 0;
  beats.forEach((n, i) => placed.push({ id: n.id, x: PAD + i * (NODE_W + GAP_X), y: PAD + HEAD, width: NODE_W, height: NODE_H, column: i, row: -1 }));
  [...byKey.values()].forEach((col, c) => {
    const x = PAD + c * (NODE_W + GAP_X);
    const ordered = col.nodes.map((n, i) => ({ n, i })).sort((a, b) => (a.n.sequence ?? 0) - (b.n.sequence ?? 0) || a.i - b.i);
    ordered.forEach(({ n }, row) => placed.push({ id: n.id, x, y: PAD + top + HEAD + row * (NODE_H + GAP_Y), width: NODE_W, height: NODE_H, column: c, row }));
    columns.push({ key: col.key, label: col.chapter === null ? 'Chapter' : chapterShort(col.chapter), x, count: ordered.length });
    tallest = Math.max(tallest, ordered.length);
  });
  if (columns.length === 0 && beats.length === 0) return { nodes: [], columns: [], width: 0, height: 0 };
  const across = Math.max(columns.length, beats.length);
  return {
    nodes: placed,
    columns,
    beatsRow: beats.length > 0 ? { label: 'Beats', x: PAD, y: PAD } : null,
    top,
    width: PAD * 2 + across * NODE_W + (across - 1) * GAP_X,
    height: columns.length === 0 ? PAD * 2 + top : PAD * 2 + top + HEAD + tallest * NODE_H + (tallest - 1) * GAP_Y,
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
export const LANE_HEADING_H = 32;

/** The three kinds of lane row, in the order they are grouped, with the words the toggles and headings use. */
export const LANE_KINDS = [
  { key: 'arc', label: 'Character arcs' },
  { key: 'relationship', label: 'Relationships' },
  { key: 'thread', label: 'Plot threads' },
];
const KINDS_KEY = 'storyforge.plan.lanes.kinds';
const allKinds = () => ({ arc: true, relationship: true, thread: true });

/** Which lane kinds are shown, as last remembered in this browser (all on when nothing is stored or storage is unavailable). @param {Storage | null} [storage] */
export function loadLaneKinds(storage) {
  const kinds = allKinds();
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    const saved = JSON.parse(store?.getItem(KINDS_KEY) ?? 'null');
    if (saved && typeof saved === 'object') for (const k of Object.keys(kinds)) if (typeof saved[k] === 'boolean') kinds[k] = saved[k];
  } catch {
    // no storage, or unreadable: every kind stays on
  }
  return kinds;
}

/** Remember which lane kinds are shown; a failure (private mode, quota) is ignored. @param {Record<string, boolean>} kinds @param {Storage | null} [storage] */
export function saveLaneKinds(kinds, storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    store?.setItem(KINDS_KEY, JSON.stringify(kinds));
  } catch {
    // not remembered; the toggles still work for this visit
  }
}

/** The name of a relationship: its own `name`, else "A & B" from its two entries, else its slug. @param {{ slug: string, name?: string, a?: { name?: string }, b?: { name?: string } }} rel */
export const relationshipName = (rel) => rel.name || (rel.a?.name && rel.b?.name ? `${rel.a.name} & ${rel.b.name}` : rel.slug);

/** The accessible name of a development marker: "Maren & Pell: Trust breaks in The Ferry". */
export const developmentName = (rel, d, title) => `${relationshipName(rel)}: ${d.change || 'development'} in ${sceneName(title)}`;

/** The three roles of a scene in a plot thread, with the letter a marker shows and the word its name uses. */
export const THREAD_ROLES = [
  { key: 'setup', letter: 'S', word: 'setup' },
  { key: 'develop', letter: 'D', word: 'development' },
  { key: 'payoff', letter: 'P', word: 'payoff' },
];

/** The accessible name of a thread marker: "The Missing Key: setup in The Key". */
export const threadMarkerName = (thread, role, title) => `${thread.title || thread.slug}: ${THREAD_ROLES.find((r) => r.key === role)?.word ?? role} in ${sceneName(title)}`;

/** The scene ids of a thread list (entries may be ids or `{ id }`). */
export const threadSceneIds = (list) => (Array.isArray(list) ? list.map((s) => (typeof s === 'string' ? s : s?.id)).filter((s) => typeof s === 'string') : []);

/** The label of a beat node of GET /flow: "<structure>: <beat>" (the structure name is not repeated when the title already starts with it). @param {{ title?: string, structure?: { name?: string } | null }} n */
export function beatLabel(n) {
  const name = n.structure?.name;
  const title = n.title || 'Untitled beat';
  return name && !title.startsWith(`${name}: `) ? `${name}: ${title}` : title;
}

/** The Codex entries in the order the relationship dialog lists them: characters first, then the other types, each group by title. @param {{ type?: string, title?: string | null, slug?: string }[]} entries */
export function orderEntries(entries) {
  const name = (e) => String(e.title ?? e.slug ?? '');
  const rank = (e) => (e.type === 'character' ? 0 : 1);
  return entries
    .map((e, i) => ({ e, i }))
    .sort((x, y) => rank(x.e) - rank(y.e) || (x.e.type === y.e.type ? 0 : String(x.e.type).localeCompare(String(y.e.type))) || name(x.e).localeCompare(name(y.e)) || x.i - y.i)
    .map((x) => x.e);
}

/**
 * The lanes of the Lanes view: one narrow column per scene in reading order and one row per arc, relationship or plot thread, with a marker at the scene of each milestone, development
 * or S/D/P entry. Pure: the same sources and scenes always give the same boxes.
 * `sources` is either a plain list of arcs (GET /arcs `arcs`: one row each, no headings) or a list of `{ kind: 'arc' | 'relationship' | 'thread', items }` groups, drawn in the order given
 * each under a heading row (a group without items is left out). A marker whose scene is not among `nodes` is not drawn: arc milestones are counted in `unplaced`, developments and thread
 * entries in `unplacedOther` (the list still shows them). Several markers of one row in one scene sit side by side, a few pixels apart.
 * @param {any[]} sources @param {{ id: string, title?: string, act?: number | null, chapter?: number | null }[]} nodes scenes in reading order (GET /flow nodes)
 * @returns {{ columns: { id: string, x: number, title: string }[], chapters: { key: string, label: string, x: number, width: number }[],
 *   rows: any[], width: number, height: number, unplaced: number, unplacedOther: number }}
 *   A row is `{ kind, heading: true, label, y, height }` for a heading, else `{ kind, slug, name, y, height, markers: { key, kind, slug, index, role?, scene, x, y, text, name }[] }`.
 */
export function layoutLanes(sources, nodes) {
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
  const grouped = sources.length > 0 && sources.every((s) => s && typeof s.kind === 'string' && Array.isArray(s.items));
  const groups = grouped ? sources.filter((g) => g.items.length > 0) : [{ kind: 'arc', items: sources }];
  let unplaced = 0;
  let unplacedOther = 0;
  let y = LANE_HEAD;
  /** @type {any[]} */
  const rows = [];
  for (const group of groups) {
    if (grouped) {
      rows.push({ kind: group.kind, heading: true, label: LANE_KINDS.find((k) => k.key === group.kind)?.label ?? group.kind, y, height: LANE_HEADING_H });
      y += LANE_HEADING_H;
    }
    for (const item of group.items) {
      const seen = new Map();
      const markers = [];
      const place = (d) => {
        const col = colX.get(d.scene);
        if (!col) {
          if (group.kind === 'arc') unplaced += 1;
          else unplacedOther += 1;
          return;
        }
        const slot = seen.get(d.scene) ?? 0;
        seen.set(d.scene, slot + 1);
        markers.push({
          key: d.key,
          kind: group.kind,
          slug: item.slug,
          index: d.index,
          ...(d.role ? { role: d.role } : {}),
          scene: d.scene,
          x: col.x + (LANE_COL_W - LANE_MARK) / 2 + slot * 10,
          y: y + (LANE_ROW_H - LANE_MARK) / 2,
          text: d.text,
          name: d.name(col.title),
        });
      };
      if (group.kind === 'relationship') {
        (item.developments ?? []).forEach((d, i) => place({ key: `rel:${item.slug}:${i}`, index: i, scene: d.scene, text: String(i + 1), name: (t) => developmentName(item, d, t) }));
      } else if (group.kind === 'thread') {
        for (const role of THREAD_ROLES) {
          threadSceneIds(item[role.key]).forEach((scene, i) => place({ key: `thread:${item.slug}:${role.key}:${scene}`, index: i, role: role.key, scene, text: role.letter, name: (t) => threadMarkerName(item, role.key, t) }));
        }
      } else {
        for (const m of item.milestones ?? []) place({ key: `${item.slug}:${m.index}`, index: m.index, scene: m.scene, text: String(m.index + 1), name: (t) => markerName(item, m, t) });
      }
      rows.push({ kind: group.kind, slug: item.slug, name: group.kind === 'arc' ? arcName(item) : group.kind === 'relationship' ? relationshipName(item) : item.title || item.slug, y, height: LANE_ROW_H, markers });
      y += LANE_ROW_H;
    }
  }
  const width = nodes.length === 0 ? 0 : LANE_LABEL_W + LANE_PAD * 2 + nodes.length * LANE_COL_W;
  return { columns, chapters, rows, width, height: rows.length === 0 ? 0 : y + LANE_PAD, unplaced, unplacedOther };
}
