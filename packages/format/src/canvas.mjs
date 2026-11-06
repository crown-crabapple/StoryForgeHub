// M09-J01: canvases (planning/canvases/<slug>.canvas). JSON Canvas 1.0 (jsoncanvas.org) plus an optional `storyforge` object on the document and on nodes.
// Pure: no filesystem access. parseCanvas() checks a document and returns a normalised copy (coordinates rounded, unknown keys kept); serializeCanvas() is the
// one way a canvas is written, so a file StoryForge saves always has the same shape (two-space JSON, trailing newline).

export const CANVAS_SCHEMA = 'storyforge.canvas/v1';
export const CANVAS_DIR = 'planning/canvases';
export const CANVAS_EXT = '.canvas';
export const CANVAS_NODE_TYPES = ['text', 'file', 'link', 'group'];
export const CANVAS_KINDS = ['todo', 'swatch', 'column'];
export const CANVAS_SIDES = ['top', 'right', 'bottom', 'left'];
export const CANVAS_ENDS = ['none', 'arrow'];
export const CANVAS_LIMITS = Object.freeze({ nodes: 2000, edges: 4000, bytes: 5 * 1024 * 1024, text: 100000, id: 64, ref: 80, label: 500, url: 2000, file: 300 });

const COLOR_RE = /^(?:[1-6]|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_RE = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i;
const CONTROL_RE = new RegExp(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** A book-relative file path a canvas may name: forward slashes, no `..`, no leading `/`, no `\`, no NUL or control characters. @param {unknown} p */
export function isCanvasFilePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > CANVAS_LIMITS.file || p.includes('\\') || p.startsWith('/') || CONTROL_RE.test(p) || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Check a canvas document (an object, or the JSON text of one). Returns { ok: true, canvas } with a normalised copy, or { ok: false, message } naming the
 * first rule broken. Unknown keys are kept as they are.
 * @param {unknown} input
 * @returns {{ ok: true, canvas: { nodes: any[], edges: any[], [k: string]: unknown } } | { ok: false, message: string }}
 */
export function parseCanvas(input) {
  let doc = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > CANVAS_LIMITS.bytes) return bad('the canvas is larger than 5 MB');
    try {
      doc = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (e) {
      return bad(`not JSON: ${String(/** @type {any} */ (e)?.message ?? e)}`);
    }
  }
  if (!isObject(doc)) return bad('a canvas is a JSON object with "nodes" and "edges"');
  const d = /** @type {Record<string, any>} */ (doc);
  const nodesIn = d.nodes ?? [];
  const edgesIn = d.edges ?? [];
  if (!Array.isArray(nodesIn)) return bad('"nodes" must be a list');
  if (!Array.isArray(edgesIn)) return bad('"edges" must be a list');
  if (nodesIn.length > CANVAS_LIMITS.nodes) return bad(`at most ${CANVAS_LIMITS.nodes} cards`);
  if (edgesIn.length > CANVAS_LIMITS.edges) return bad(`at most ${CANVAS_LIMITS.edges} connections`);
  if (d.storyforge !== undefined) {
    if (!isObject(d.storyforge)) return bad('"storyforge" must be an object');
    if (d.storyforge.title !== undefined && !shortText(d.storyforge.title, 300)) return bad('storyforge.title must be text of at most 300 characters');
  }
  const ids = new Set();
  const nodes = [];
  for (let i = 0; i < nodesIn.length; i++) {
    const n = nodesIn[i];
    const at = `nodes[${i}]`;
    if (!isObject(n)) return bad(`${at} must be an object`);
    const idProblem = checkId(n.id, ids);
    if (idProblem) return bad(`${at}.id ${idProblem}`);
    const where = `${at} (${n.id})`;
    if (!CANVAS_NODE_TYPES.includes(n.type)) return bad(`${where}: type must be one of ${CANVAS_NODE_TYPES.join(', ')}`);
    for (const k of ['x', 'y', 'width', 'height']) if (!isNum(n[k])) return bad(`${where}: ${k} must be a number`);
    if (n.width < 1 || n.height < 1) return bad(`${where}: width and height must be at least 1`);
    if (n.color !== undefined && !(typeof n.color === 'string' && COLOR_RE.test(n.color))) return bad(`${where}: color must be "1" to "6" or a #hex colour`);
    if (n.type === 'text' && !(typeof n.text === 'string' && n.text.length <= CANVAS_LIMITS.text)) return bad(`${where}: text must be text of at most ${CANVAS_LIMITS.text} characters`);
    if (n.type === 'file' && !isCanvasFilePath(n.file)) return bad(`${where}: file must be a book-relative path (forward slashes, no "..")`);
    if (n.type === 'file' && n.subpath !== undefined && !shortText(n.subpath, 300)) return bad(`${where}: subpath must be short text`);
    if (n.type === 'link' && !(typeof n.url === 'string' && n.url.length <= CANVAS_LIMITS.url && URL_RE.test(n.url))) return bad(`${where}: url must start with http:, https: or mailto:`);
    if (n.type === 'group' && n.label !== undefined && !shortText(n.label, CANVAS_LIMITS.label)) return bad(`${where}: label must be text of at most ${CANVAS_LIMITS.label} characters`);
    if (n.storyforge !== undefined) {
      const s = n.storyforge;
      if (!isObject(s)) return bad(`${where}: storyforge must be an object`);
      if (s.kind !== undefined && !shortText(s.kind, 40)) return bad(`${where}: storyforge.kind must be short text`);
      if (s.ref !== undefined && !(typeof s.ref === 'string' && s.ref !== '' && s.ref.length <= CANVAS_LIMITS.ref && !CONTROL_RE.test(s.ref))) return bad(`${where}: storyforge.ref must be an id`);
      if (s.hex !== undefined && !(typeof s.hex === 'string' && HEX_RE.test(s.hex))) return bad(`${where}: storyforge.hex must be #rrggbb`);
      if (s.name !== undefined && !shortText(s.name, 200)) return bad(`${where}: storyforge.name must be short text`);
    }
    nodes.push({ ...n, x: Math.round(n.x), y: Math.round(n.y), width: Math.max(1, Math.round(n.width)), height: Math.max(1, Math.round(n.height)) });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (let i = 0; i < edgesIn.length; i++) {
    const e = edgesIn[i];
    const at = `edges[${i}]`;
    if (!isObject(e)) return bad(`${at} must be an object`);
    const idProblem = checkId(e.id, ids);
    if (idProblem) return bad(`${at}.id ${idProblem}`);
    const where = `${at} (${e.id})`;
    if (!nodeIds.has(e.fromNode)) return bad(`${where}: fromNode must name a card`);
    if (!nodeIds.has(e.toNode)) return bad(`${where}: toNode must name a card`);
    for (const k of ['fromSide', 'toSide']) if (e[k] !== undefined && !CANVAS_SIDES.includes(e[k])) return bad(`${where}: ${k} must be one of ${CANVAS_SIDES.join(', ')}`);
    for (const k of ['fromEnd', 'toEnd']) if (e[k] !== undefined && !CANVAS_ENDS.includes(e[k])) return bad(`${where}: ${k} must be none or arrow`);
    if (e.color !== undefined && !(typeof e.color === 'string' && COLOR_RE.test(e.color))) return bad(`${where}: color must be "1" to "6" or a #hex colour`);
    if (e.label !== undefined && !shortText(e.label, CANVAS_LIMITS.label)) return bad(`${where}: label must be text of at most ${CANVAS_LIMITS.label} characters`);
    if (e.storyforge !== undefined) {
      if (!isObject(e.storyforge)) return bad(`${where}: storyforge must be an object`);
      const link = e.storyforge.link;
      if (link !== undefined && !(typeof link === 'string' && link.length <= 120 && SLUG_RE.test(link))) return bad(`${where}: storyforge.link must be a link slug`);
    }
    edges.push({ ...e });
  }
  const canvas = { ...d, nodes, edges };
  if (Buffer.byteLength(serializeCanvas(canvas), 'utf8') > CANVAS_LIMITS.bytes) return bad('the canvas is larger than 5 MB');
  return { ok: true, canvas };
}

/** The bytes StoryForge writes for a canvas: `nodes`, `edges`, then the other keys in their order; two-space JSON and a final newline. @param {Record<string, any>} canvas */
export function serializeCanvas(canvas) {
  const { nodes = [], edges = [], ...rest } = canvas;
  return `${JSON.stringify({ nodes, edges, ...rest }, null, 2)}\n`;
}

/** A new, empty canvas document. @param {string} title */
export const emptyCanvas = (title) => ({ nodes: [], edges: [], storyforge: { schema: CANVAS_SCHEMA, title } });

/** The title of a canvas document: storyforge.title, else the slug. @param {any} canvas @param {string} slug */
export const canvasTitle = (canvas, slug) => (isObject(canvas?.storyforge) && typeof canvas.storyforge.title === 'string' && canvas.storyforge.title.trim() !== '' ? canvas.storyforge.title : slug);

function checkId(id, seen) {
  if (typeof id !== 'string' || id === '' || id.length > CANVAS_LIMITS.id || CONTROL_RE.test(id)) return `must be text of 1 to ${CANVAS_LIMITS.id} characters`;
  if (seen.has(id)) return `"${id}" is used twice`;
  seen.add(id);
  return null;
}
const shortText = (v, max) => typeof v === 'string' && v.length <= max && !CONTROL_RE.test(v.replace(/[\n\t]/g, ' '));
const bad = (message) => ({ ok: /** @type {const} */ (false), message });
