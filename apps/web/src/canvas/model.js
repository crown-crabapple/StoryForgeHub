// The Canvas page's pure model (M09-J01): node kinds and defaults, safe Markdown blocks, to-do lists, column layout, edge geometry, view fitting and the
// undo history. Nothing here touches the DOM or the network, so all of it is tested in node.
import { relationStroke } from '../planner/model.js';
import { RELATIONS, explainLinkFailure, relationLabel } from '../planner/requests.js';
import { explainFailure } from '../structure/helpers.js';

const enc = encodeURIComponent;

/** /books/:id/canvas with the optional ?canvas=<slug>. @param {string} bookId @param {string | null} [slug] */
export const canvasHref = (bookId, slug = null) => `/books/${enc(bookId)}/canvas${slug ? `?canvas=${enc(slug)}` : ''}`;
/** @param {string} search */
export function parseCanvasSearch(search) {
  const p = new URLSearchParams(search);
  return { canvas: p.get('canvas') };
}
/** GET / PUT url of one canvas. @param {string} bookId @param {string} slug */
export const canvasUrl = (bookId, slug) => `/api/books/${enc(bookId)}/canvases/${enc(slug)}`;
/** The attachment route for a book-relative assets/ path. @param {string} bookId @param {string} rel */
export const assetUrl = (bookId, rel) => `/api/books/${enc(bookId)}/attachments?path=${enc(rel)}`;

// ---------------------------------------------------------------- kinds

export const IMAGE_RE = /^assets\/.+\.(png|jpe?g|webp|gif)$/i;
export const GRID = 8;
export const COLUMN_HEAD = 44;
export const COLUMN_PAD = 12;
export const COLUMN_GAP = 12;
/** JSON Canvas preset colours "1"-"6" (red, orange, yellow, green, cyan, purple). */
export const PRESET_COLORS = { 1: '#E5534B', 2: '#E8743B', 3: '#E0C04B', 4: '#57AB5A', 5: '#39C5CF', 6: '#986EE2' };
export const SWATCH_PALETTE = ['#E8DDD4', '#7DA7C9', '#2A2F3A', '#B5651D', '#D9CBB0', '#3E5C76', '#C2A878', '#6B4E71'];

/** What the author sees: note | todo | swatch | image | story | file | link | group | column. @param {any} n */
export function nodeKind(n) {
  const k = n?.storyforge?.kind;
  if (n.type === 'group') return k === 'column' ? 'column' : 'group';
  if (n.type === 'link') return 'link';
  if (n.type === 'file') return typeof n.storyforge?.ref === 'string' ? 'story' : IMAGE_RE.test(n.file) ? 'image' : 'file';
  if (k === 'swatch' && /^#[0-9a-f]{6}$/i.test(n.storyforge?.hex ?? '')) return 'swatch';
  if (k === 'todo') return 'todo';
  return 'note';
}
export const isContainer = (n) => n.type === 'group';

export const DEFAULT_SIZE = {
  note: [260, 160],
  todo: [260, 180],
  swatch: [140, 150],
  image: [280, 200],
  story: [260, 150],
  file: [260, 90],
  link: [260, 90],
  group: [480, 320],
  column: [300, 360],
};

/** A fresh node id (16 hex characters, as Obsidian makes them). @param {() => number} [rand] */
export function newId(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/**
 * A new node of an author-facing kind, centred on `at` (world coordinates), snapped to the grid.
 * @param {string} kind @param {{ x: number, y: number }} at @param {Record<string, any>} [extra] @param {() => number} [rand]
 */
export function makeNode(kind, at, extra = {}, rand = Math.random) {
  const [w, h] = extra.size ?? DEFAULT_SIZE[kind] ?? DEFAULT_SIZE.note;
  const base = { id: newId(rand), x: snap(at.x - w / 2), y: snap(at.y - h / 2), width: w, height: h };
  switch (kind) {
    case 'todo':
      return { ...base, type: 'text', text: extra.text ?? '- [ ] ', storyforge: { kind: 'todo' } };
    case 'swatch': {
      const hex = (extra.hex ?? SWATCH_PALETTE[Math.floor(rand() * SWATCH_PALETTE.length)]).toUpperCase();
      const name = extra.name ?? 'Swatch';
      return { ...base, type: 'text', text: swatchText(name, hex), color: hex, storyforge: { kind: 'swatch', name, hex } };
    }
    case 'image':
    case 'file':
      return { ...base, type: 'file', file: extra.file };
    case 'story':
      return { ...base, type: 'file', file: extra.file ?? 'unknown.md', storyforge: { ref: extra.ref } };
    case 'link':
      return { ...base, type: 'link', url: extra.url };
    case 'group':
      return { ...base, type: 'group', label: extra.label ?? 'Group' };
    case 'column':
      return { ...base, type: 'group', label: extra.label ?? 'Column', storyforge: { kind: 'column' } };
    default:
      return { ...base, type: 'text', text: extra.text ?? '' };
  }
}
export const snap = (v) => Math.round(v / GRID) * GRID;
/** The JSON Canvas text a swatch carries (what Obsidian shows). @param {string} name @param {string} hex */
export const swatchText = (name, hex) => `**${name.replace(/\*/g, '')}**\n${hex}`;

/** @param {string} hex #rrggbb @returns {[number, number, number]} */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
/** Black or white, whichever reads better on `hex`. @param {string} hex */
export function inkOn(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#141414' : '#F5F5F5';
}
/** The CSS colour of a node or edge `color` ("1"-"6" or #hex), or null. @param {string | undefined} c */
export const cssColor = (c) => (c === undefined ? null : PRESET_COLORS[/** @type {keyof typeof PRESET_COLORS} */ (c)] ?? (/^#[0-9a-f]{3,6}$/i.test(c) ? c : null));

/** A web address the canvas may open: http(s) or mailto, else null. @param {unknown} raw */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? s : null;
  } catch {
    return null;
  }
}
/** Host name of a link (or the address itself). @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- Markdown (safe subset; produces data, never HTML)

const INLINE_RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*|_([^_]+)_)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;

/** Inline runs: { t: 'text' | 'b' | 'i' | 'code' | 'link', text, href? }. A link that is not http(s) / mailto stays text. @param {string} s */
export function inlineRuns(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ t: 'text', text: s.slice(last, m.index) });
    if (m[1]) out.push({ t: 'b', text: m[2] });
    else if (m[3]) out.push({ t: 'i', text: m[4] ?? m[5] });
    else if (m[6]) out.push({ t: 'code', text: m[7] });
    else {
      const href = safeUrl(m[10]);
      out.push(href ? { t: 'link', text: m[9], href } : { t: 'text', text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', text: s.slice(last) });
  return out;
}

/**
 * Blocks of a note: { type: 'h', level, runs } | { type: 'li', runs } | { type: 'task', checked, line, runs } | { type: 'p', runs } | { type: 'hr' }.
 * `line` is the 0-based source line of a task (for toggling it).
 * @param {string} text
 */
export function markdownBlocks(text) {
  const blocks = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.trim() === '') continue;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) blocks.push({ type: 'h', level: m[1].length, runs: inlineRuns(m[2]) });
    else if ((m = /^\s*[-*+]\s+\[( |x|X)\]\s?(.*)$/.exec(line))) blocks.push({ type: 'task', checked: m[1] !== ' ', line: i, runs: inlineRuns(m[2]) });
    else if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line))) blocks.push({ type: 'li', runs: inlineRuns(m[1]) });
    else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) blocks.push({ type: 'hr' });
    else blocks.push({ type: 'p', runs: inlineRuns(line) });
  }
  return blocks;
}

/** Flip the task box on source line `line`. @param {string} text @param {number} line */
export function toggleTask(text, line) {
  const lines = text.split('\n');
  const m = /^(\s*[-*+]\s+\[)( |x|X)(\].*)$/.exec(lines[line] ?? '');
  if (!m) return text;
  lines[line] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`;
  return lines.join('\n');
}
/** { done, total } of a to-do text. @param {string} text */
export function taskCounts(text) {
  const tasks = markdownBlocks(text).filter((b) => b.type === 'task');
  return { done: tasks.filter((t) => /** @type {any} */ (t).checked).length, total: tasks.length };
}
/** The plain text of a note, for names and previews. @param {string} text */
export const plainText = (text) =>
  markdownBlocks(text)
    .map((b) => ('runs' in b ? b.runs.map((r) => r.text).join('') : ''))
    .filter(Boolean)
    .join(' ');

// ---------------------------------------------------------------- geometry

const centre = (n) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const contains = (outer, n) => n.x >= outer.x && n.y >= outer.y && n.x + n.width <= outer.x + outer.width && n.y + n.height <= outer.y + outer.height;

/** The cards a column holds: non-group nodes whose centre is inside it (and in no later column). @param {any[]} nodes @param {any} col */
export function columnMembers(nodes, col) {
  const cols = nodes.filter((n) => nodeKind(n) === 'column');
  return nodes.filter((n) => !isContainer(n) && inside(centre(n), col) && cols.filter((c) => inside(centre(n), c)).at(-1)?.id === col.id).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** What moves with a container: a column's members; for a group, every node fully inside it. @param {any[]} nodes @param {any} g */
export function carried(nodes, g) {
  if (nodeKind(g) === 'column') return columnMembers(nodes, g);
  return nodes.filter((n) => n.id !== g.id && contains(g, n));
}

/** Stack every column's cards top to bottom at the column's width; the column grows (or shrinks, to a minimum) to fit. @param {{ nodes: any[] }} canvas */
export function layoutColumns(canvas) {
  const cols = canvas.nodes.filter((n) => nodeKind(n) === 'column');
  if (cols.length === 0) return canvas;
  const moved = new Map();
  const grown = new Map();
  for (const col of cols) {
    let y = col.y + COLUMN_HEAD;
    for (const m of columnMembers(canvas.nodes, col)) {
      moved.set(m.id, { x: col.x + COLUMN_PAD, y, width: Math.max(40, col.width - 2 * COLUMN_PAD) });
      y += m.height + COLUMN_GAP;
    }
    grown.set(col.id, Math.max(DEFAULT_SIZE.column[1] / 2, y - col.y + COLUMN_PAD - COLUMN_GAP));
  }
  let changed = false;
  const nodes = canvas.nodes.map((n) => {
    const m = moved.get(n.id);
    if (m && (m.x !== n.x || m.y !== n.y || m.width !== n.width)) {
      changed = true;
      return { ...n, ...m };
    }
    const h = grown.get(n.id);
    if (h !== undefined && h !== n.height) {
      changed = true;
      return { ...n, height: h };
    }
    return n;
  });
  return changed ? { ...canvas, nodes } : canvas;
}

/** The point on a side of a node. @param {any} n @param {string} side */
export function anchor(n, side) {
  switch (side) {
    case 'top':
      return { x: n.x + n.width / 2, y: n.y };
    case 'bottom':
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left':
      return { x: n.x, y: n.y + n.height / 2 };
    default:
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}
/** The facing sides of two nodes. @param {any} a @param {any} b @returns {[string, string]} */
export function facingSides(a, b) {
  const dx = centre(b).x - centre(a).x;
  const dy = centre(b).y - centre(a).y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}
const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
/** SVG path (a cubic curve) and label point of an edge between two nodes. @param {any} edge @param {any} from @param {any} to */
export function edgeGeometry(edge, from, to) {
  const [fs, ts] = facingSides(from, to);
  const fromSide = edge.fromSide ?? fs;
  const toSide = edge.toSide ?? ts;
  const a = anchor(from, fromSide);
  const b = anchor(to, toSide);
  const k = Math.min(160, Math.max(16, Math.hypot(b.x - a.x, b.y - a.y) / 2));
  const c1 = { x: a.x + NORMAL[fromSide][0] * k, y: a.y + NORMAL[fromSide][1] * k };
  const c2 = { x: b.x + NORMAL[toSide][0] * k, y: b.y + NORMAL[toSide][1] * k };
  const mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
  return { d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, a, b, mid, toSide, fromSide };
}

/** The box around nodes, or null. @param {any[]} nodes */
export function bounds(nodes) {
  if (nodes.length === 0) return null;
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  return { x, y, width: Math.max(...nodes.map((n) => n.x + n.width)) - x, height: Math.max(...nodes.map((n) => n.y + n.height)) - y };
}
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 3;
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
/** The view { x, y, zoom } that shows `box` inside a viewport of `w` x `h` with a margin; an empty canvas is centred on 0,0 at 100%. */
export function fitView(box, w, h, margin = 48) {
  if (!box || w <= 0 || h <= 0) return { x: w / 2, y: h / 2, zoom: 1 };
  const zoom = clampZoom(Math.min(1, (w - 2 * margin) / Math.max(1, box.width), (h - 2 * margin) / Math.max(1, box.height)));
  return { x: w / 2 - (box.x + box.width / 2) * zoom, y: h / 2 - (box.y + box.height / 2) * zoom, zoom };
}
/** Zoom by `factor` keeping the screen point (sx, sy) still. */
export function zoomAt(view, factor, sx, sy) {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k };
}
/** Screen point (relative to the board) to world coordinates. */
export const toWorld = (view, sx, sy) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom });

/** Cards in reading order (top-left first, rows 40 px tall); containers before what they hold. @param {any[]} nodes */
export const readingOrder = (nodes) => [...nodes].sort((a, b) => Math.floor(a.y / 40) - Math.floor(b.y / 40) || a.x - b.x || (isContainer(b) ? 1 : 0) - (isContainer(a) ? 1 : 0));

// ---------------------------------------------------------------- edits

/** Remove nodes (and the edges that touch them) and edges by id. @param {{ nodes: any[], edges: any[] }} c @param {Set<string>} ids */
export function removeIds(c, ids) {
  return { ...c, nodes: c.nodes.filter((n) => !ids.has(n.id)), edges: c.edges.filter((e) => !ids.has(e.id) && !ids.has(e.fromNode) && !ids.has(e.toNode)) };
}
/** Copies of nodes (and the edges between them), 24 px down and right, with new ids. Returns { canvas, ids }. */
export function duplicate(c, ids, rand = Math.random) {
  const map = new Map();
  const copies = c.nodes.filter((n) => ids.has(n.id)).map((n) => {
    const id = newId(rand);
    map.set(n.id, id);
    return { ...structuredClone(n), id, x: n.x + 24, y: n.y + 24 };
  });
  const edges = c.edges.filter((e) => map.has(e.fromNode) && map.has(e.toNode)).map((e) => ({ ...e, id: newId(rand), fromNode: map.get(e.fromNode), toNode: map.get(e.toNode) }));
  return { canvas: { ...c, nodes: [...c.nodes, ...copies], edges: [...c.edges, ...edges] }, ids: new Set(map.values()) };
}
/** Move nodes by (dx, dy). @param {{ nodes: any[] }} c @param {Set<string>} ids */
export const moveBy = (c, ids, dx, dy) => ({ ...c, nodes: c.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) });
/** Change one node. @param {{ nodes: any[] }} c @param {string} id @param {(n: any) => any} fn */
export const patchNode = (c, id, fn) => ({ ...c, nodes: c.nodes.map((n) => (n.id === id ? fn(n) : n)) });
/** Change one edge. @param {{ edges: any[] }} c @param {string} id @param {(e: any) => any} fn */
export const patchEdge = (c, id, fn) => ({ ...c, edges: c.edges.map((e) => (e.id === id ? fn(e) : e)) });
/** Connect two nodes with an arrow on their facing sides (no duplicate, no self-loop). Returns the canvas unchanged when it would be one. */
export function connect(c, fromId, toId, rand = Math.random) {
  if (fromId === toId || c.edges.some((e) => e.fromNode === fromId && e.toNode === toId)) return c;
  const a = c.nodes.find((n) => n.id === fromId);
  const b = c.nodes.find((n) => n.id === toId);
  if (!a || !b) return c;
  const [fromSide, toSide] = facingSides(a, b);
  return { ...c, edges: [...c.edges, { id: newId(rand), fromNode: fromId, fromSide, toNode: toId, toSide, toEnd: 'arrow' }] };
}

// ---------------------------------------------------------------- Flow relations on a connection

/** The slug of the Flow link an edge carries (`storyforge.link`), or null. @param {any} edge */
export const edgeLink = (edge) => (typeof edge?.storyforge?.link === 'string' && edge.storyforge.link !== '' ? edge.storyforge.link : null);

/**
 * The scene ids at the two ends of an edge `{ from, to }` when both ends are story cards of a live scene (refs entry of kind scene, state ok), else null.
 * @param {any} edge @param {any[]} nodes @param {Record<string, any>} refs node id -> ref info
 */
export function sceneEnds(edge, nodes, refs) {
  const end = (id) => {
    const n = nodes.find((x) => x.id === id);
    const r = refs?.[id];
    return n && nodeKind(n) === 'story' && r?.kind === 'scene' && r.state === 'ok' && typeof r.id === 'string' && r.id !== '' ? r.id : null;
  };
  const from = end(edge?.fromNode);
  const to = end(edge?.toNode);
  return from && to ? { from, to } : null;
}

/** The edge tied to a Flow link: `storyforge.link` is the slug and the label is the relation in words (so Obsidian shows it). @param {any} edge @param {string} slug @param {string} relation */
export const withLink = (edge, slug, relation) => ({ ...edge, label: relationLabel(relation), storyforge: { ...(edge.storyforge ?? {}), link: slug } });

/** The edge with no Flow link and no label; an empty `storyforge` is dropped. @param {any} edge */
export function withoutLink(edge) {
  const next = { ...edge };
  delete next.label;
  const { storyforge } = next;
  if (storyforge) {
    const other = { ...storyforge };
    delete other.link;
    if (Object.keys(other).length > 0) next.storyforge = other;
    else delete next.storyforge;
  }
  return next;
}

/** The edge turned around: from and to swap, and so do their sides (the arrow ends stay where they are). @param {any} edge */
export function reverseEdge(edge) {
  const { fromNode, toNode, fromSide, toSide, ...rest } = edge;
  return { ...rest, fromNode: toNode, toNode: fromNode, ...(toSide !== undefined ? { fromSide: toSide } : {}), ...(fromSide !== undefined ? { toSide: fromSide } : {}) };
}

/** The relation a label spells ("pays off" -> "pays_off"), or null. @param {unknown} label */
export function relationFromLabel(label) {
  const t = String(label ?? '').trim().toLowerCase();
  return RELATIONS.find((r) => relationLabel(r.value) === t)?.value ?? null;
}

/** The live links of GET /links by slug. @param {{ links?: any[] } | null | undefined} data @returns {Map<string, any>} */
export const indexLinks = (data) => new Map((data?.links ?? []).filter((l) => typeof l?.slug === 'string').map((l) => [l.slug, l]));

/**
 * How an edge is drawn. Without a link: `plain` (its own label). With one: `live` (the link is the truth: its relation as the label and the Flow dash style),
 * `unlinked` (the slug is not a live link: stored label, muted) or `pending` (the links are not loaded yet: stored label).
 * @param {any} edge @param {Map<string, any> | null | undefined} links
 * @returns {{ state: 'plain' | 'live' | 'unlinked' | 'pending', slug: string | null, link: any, label: string, dasharray: string | null, group: string | null }}
 */
export function edgeView(edge, links) {
  const slug = edgeLink(edge);
  const own = { slug, link: null, label: edge?.label ?? '', dasharray: null, group: null };
  if (!slug) return { state: 'plain', ...own };
  if (!links) return { state: 'pending', ...own };
  const link = links.get(slug);
  if (!link) return { state: 'unlinked', ...own };
  const { group, dasharray } = relationStroke(link.relation);
  return { state: 'live', slug, link, label: relationLabel(link.relation), dasharray, group };
}

/** The slug of the link a refused create names (409 REFUSED_DUPLICATE_LINK, `existing: { slug }`), or null. @param {number} status @param {any} json */
export function duplicateLinkSlug(status, json) {
  if (status !== 409 || json?.code !== 'REFUSED_DUPLICATE_LINK') return null;
  const e = json.existing;
  const slug = typeof e === 'string' ? e : e?.slug;
  return typeof slug === 'string' && slug !== '' ? slug : null;
}

/** A refused link write in words. @param {number} status @param {any} json */
export function explainCanvasLinkFailure(status, json) {
  if (json?.code === 'MODULE_OFF') return 'The planner module is off, so Flow links cannot be changed.';
  return explainLinkFailure(status, json) ?? explainFailure(status, json);
}

// ---------------------------------------------------------------- history

export const HISTORY_LIMIT = 100;
/** @template T @param {T} present */
export const history = (present) => ({ past: /** @type {T[]} */ ([]), present, future: /** @type {T[]} */ ([]) });
/** @template T @param {{ past: T[], present: T, future: T[] }} h @param {T} next */
export const record = (h, next) => (next === h.present ? h : { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] });
/** @template T @param {{ past: T[], present: T, future: T[] }} h */
export const undo = (h) => (h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: /** @type {T} */ (h.past.at(-1)), future: [h.present, ...h.future] });
/** @template T @param {{ past: T[], present: T, future: T[] }} h */
export const redo = (h) => (h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) });

// ---------------------------------------------------------------- names and links

export const KIND_LABEL = { note: 'Note', todo: 'To-do', swatch: 'Swatch', image: 'Image', story: 'Story card', file: 'File', link: 'Link', group: 'Group', column: 'Column' };
export const REF_KIND_LABEL = {
  scene: 'Scene', entry: 'Codex', thread: 'Thread', event: 'Event', research: 'Research', doc: 'Planning doc', source: 'Source',
  'story-plan': 'Story plan', structure: 'Structure', beat: 'Beat', arc: 'Arc', relationship: 'Relationship', synopsis: 'Synopsis', clue: 'Clue',
};

/** The accessible name of a card. @param {any} n @param {any} [ref] */
export function cardName(n, ref = null) {
  const kind = nodeKind(n);
  const short = (s) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  switch (kind) {
    case 'swatch':
      return `Swatch: ${n.storyforge.name || 'unnamed'} ${n.storyforge.hex.toUpperCase()}`;
    case 'todo': {
      const { done, total } = taskCounts(n.text);
      return `To-do: ${short(plainText(n.text.split('\n').filter((l) => !/^\s*[-*+]\s+\[/.test(l)).join('\n')) || 'list')} (${done} of ${total} done)`;
    }
    case 'story':
      return ref?.state === 'ok' ? `${REF_KIND_LABEL[ref.kind] ?? 'Story card'}: ${ref.title}` : `Story card: ${ref?.state === 'archived' ? 'archived' : 'missing'} ${n.storyforge.ref}`;
    case 'image':
    case 'file':
      return `${KIND_LABEL[kind]}: ${n.file.split('/').pop()}`;
    case 'link':
      return `Link: ${hostOf(n.url)}`;
    case 'group':
    case 'column':
      return `${KIND_LABEL[kind]}: ${n.label || 'untitled'}`;
    default:
      return `Note: ${short(plainText(n.text)) || 'empty'}`;
  }
}

/** Where a story card's Open goes. @param {string} bookId @param {{ kind: string, id: string, slug?: string | null }} ref */
export function storyHref(bookId, ref) {
  const b = `/books/${enc(bookId)}`;
  switch (ref.kind) {
    case 'scene':
      return `${b}?scene=${enc(ref.id)}`;
    case 'entry':
      return `${b}/codex?entry=${enc(ref.slug ?? ref.id)}`;
    case 'thread':
      return `${b}?view=threads&thread=${enc(ref.id)}`;
    case 'event':
      return `${b}/timeline?event=${enc(ref.id)}`;
    default:
      return `${b}/notes?note=${enc(ref.id)}`;
  }
}

/** The ref of a story card: the server's answer, else what the picker list says (a card just added). */
export function refOf(node, refs, targets) {
  const r = node?.storyforge?.ref;
  if (typeof r !== 'string') return null;
  if (refs?.[node.id] && refs[node.id].id === r) return refs[node.id];
  const t = targets?.find((x) => x.ref === r);
  return t ? { state: 'ok', kind: t.kind, id: t.ref, title: t.title, summary: t.subtitle, path: null, slug: t.slug ?? null } : (refs?.[node.id] ?? { state: 'broken', kind: null, id: r, title: null, summary: null, path: null });
}
