// "Download SVG" of the Flow graph, pure part: a standalone SVG string built from the same layout (layoutGraph) and edge geometry (edgeGeometry) as the screen. No DOM, no network.
// `escapeXml` and `svgDocument` are shared with the relationship graph's export.
import { edgeGeometry } from '../canvas/model.js';
import { chapterShort } from '../planning/model.js';
import { beatLabel, branchPrefix, relationStroke, sceneName } from './model.js';
import { relationLabel } from './requests.js';

/** Escape text for an XML text node or a double- or single-quoted attribute: & < > " ' */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The id of the arrow head defined by ARROW_DEFS; edges point at it with `marker-end="url(#sf-arrow)"`. */
export const ARROW_ID = 'sf-arrow';
/** The `<defs>` every exported graph carries: one arrow head, in a fixed dark colour (the file has no page styles). A polygon, so a path count is a count of edges. */
export const ARROW_DEFS = `<defs><marker id="${ARROW_ID}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><polygon points="0,0 10,5 0,10" fill="#333333"/></marker></defs>`;

/** The dash of a branch link: always dotted, whatever its relation. */
export const BRANCH_DASH = '2 4';
/** The space kept around the layout. */
export const SVG_MARGIN = 16;
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * A standalone SVG document: xmlns, a viewBox of `width` x `height`, the arrow-head defs, a white background and then `body` (already valid SVG markup).
 * @param {{ width: number, height: number, body: string }} p
 */
export function svgDocument({ width, height, body }) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${escapeXml(FONT)}">\n${ARROW_DEFS}\n<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>\n${body}\n</svg>\n`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const num = (n) => Math.round(n * 100) / 100;

/** The small line under a node's title: "Act 1 · Ch 2" for a scene (what is known of it), "Beat" for a beat. @param {any} n */
function detailLine(n) {
  if (n?.kind === 'beat') return 'Beat';
  const parts = [];
  if (typeof n?.act === 'number') parts.push(`Act ${n.act}`);
  if (typeof n?.chapter === 'number') parts.push(chapterShort(n.chapter));
  return parts.join(' · ');
}

/**
 * The Flow graph as an SVG file: a rounded box per node (title, and an act/chapter line), a curved arrow per edge in its relation's dash (a branch edge is dotted and its label starts "[branch]"),
 * and the relation as text at the middle of each edge. Edges that are broken, or whose ends are not in the layout, are left out.
 * @param {{ nodes: any[], edges: any[], layout: ReturnType<typeof import('./model.js').layoutGraph> }} p
 *   `nodes` are the scenes and beats drawn (GET /flow nodes), `layout` is layoutGraph of them.
 * @returns {string}
 */
export function flowSvg({ nodes, edges, layout }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const boxes = new Map(layout.nodes.map((b) => [b.id, b]));
  const out = [];
  if (layout.beatsRow) out.push(`<text x="${layout.beatsRow.x}" y="${layout.beatsRow.y + 14}" font-size="13" fill="#555555">${escapeXml(layout.beatsRow.label)}</text>`);
  for (const c of layout.columns) out.push(`<text x="${c.x}" y="${24 + (layout.top ?? 0) + 14}" font-size="13" fill="#555555">${escapeXml(c.label)}</text>`);
  const drawn = edges.filter((e) => !e.broken && boxes.has(e.from) && boxes.has(e.to));
  const lines = [];
  const labels = [];
  for (const e of drawn) {
    const geo = edgeGeometry(e, boxes.get(e.from), boxes.get(e.to));
    const dash = e.branch ? BRANCH_DASH : relationStroke(e.relation).dasharray;
    lines.push(`<path d="${escapeXml(geo.d)}" fill="none" stroke="#333333" stroke-width="2" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${ARROW_ID})"${e.branch ? ` data-branch="${escapeXml(e.branch)}"` : ''}/>`);
    labels.push(`<text x="${num(geo.mid.x)}" y="${num(geo.mid.y)}" font-size="12" text-anchor="middle" dominant-baseline="central" fill="#111111" stroke="#ffffff" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${escapeXml(`${branchPrefix(e)}${relationLabel(e.relation)}`)}</text>`);
  }
  out.push(...lines);
  for (const b of layout.nodes) {
    const n = byId.get(b.id);
    const isBeat = n?.kind === 'beat';
    const title = isBeat ? beatLabel(n) : sceneName(n?.title);
    out.push(
      `<g><rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="8" ry="8" fill="${isBeat ? '#f3f0ff' : '#f7f7f7'}" stroke="#333333" stroke-width="1.5"/>` +
        `<text x="${b.x + 12}" y="${b.y + 28}" font-size="14" font-weight="600" fill="#111111">${escapeXml(clip(title, 26))}</text>` +
        `<text x="${b.x + 12}" y="${b.y + 50}" font-size="12" fill="#555555">${escapeXml(detailLine(n))}</text></g>`,
    );
  }
  out.push(...labels);
  const body = `<g transform="translate(${SVG_MARGIN} ${SVG_MARGIN})">\n${out.join('\n')}\n</g>`;
  return svgDocument({ width: layout.width + SVG_MARGIN * 2, height: layout.height + SVG_MARGIN * 2, body });
}
