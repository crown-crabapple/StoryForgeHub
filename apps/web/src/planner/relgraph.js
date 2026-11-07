// The relationship graph of the Lanes view (Story Planner M8): a pure layout (entries on a circle, one edge per relationship) and the standalone SVG made from it.

/** What an entry without a name is called. */
export const UNKNOWN_ENTRY = 'Unknown entry';

const MARGIN = 70;
const NODE_R = 18;

/** The text an SVG may hold: &, <, > and quotes escaped, control characters dropped. @param {unknown} s */
export function escapeSvgText(s) {
  return [...String(s ?? '')]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 31 || c === 9 || c === 10 || c === 13; // XML 1.0 cannot hold the other control characters
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Round to two decimals so the SVG stays short and stable. @param {number} n */
const r2 = (n) => Math.round(n * 100) / 100;

/** The label of a relationship's edge: where it ends, else where it starts, else its name. @param {{ end_state?: string | null, baseline?: string | null, name?: string | null, slug?: string }} rel */
export function edgeLabel(rel) {
  return rel.end_state || rel.baseline || rel.name || rel.slug || '';
}

/**
 * Nodes (the distinct entries on either end, by id; sorted by name and placed evenly on a circle, the first at the top) and edges (one per relationship, labelled).
 * @param {any[]} relationships GET /relationships `relationships`
 * @param {{ width?: number, height?: number }} [size]
 * @returns {{ width: number, height: number, nodes: { id: string, name: string, x: number, y: number, r: number }[],
 *   edges: { key: string, slug: string, name: string, label: string, from: string, to: string, x1: number, y1: number, x2: number, y2: number, mx: number, my: number }[] }}
 */
export function relationshipLayout(relationships, { width = 720, height = 520 } = {}) {
  const found = new Map();
  const endId = (rel, side) => {
    const end = rel[side] ?? {};
    const id = typeof end.id === 'string' && end.id !== '' ? end.id : `${rel.slug ?? rel.id}:${side}`;
    if (!found.has(id)) found.set(id, end.name || UNKNOWN_ENTRY);
    return id;
  };
  const pairs = (relationships ?? []).map((rel) => ({ rel, from: endId(rel, 'a'), to: endId(rel, 'b') }));
  const sorted = [...found.entries()].sort((p, q) => p[1].localeCompare(q[1]) || (p[0] < q[0] ? -1 : 1));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(0, Math.min(width, height) / 2 - MARGIN);
  const nodes = sorted.map(([id, name], i) => {
    if (sorted.length === 1) return { id, name, x: cx, y: cy, r: NODE_R };
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / sorted.length;
    return { id, name, x: r2(cx + radius * Math.cos(angle)), y: r2(cy + radius * Math.sin(angle)), r: NODE_R };
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges = pairs.map(({ rel, from, to }) => {
    const p = at.get(from);
    const q = at.get(to);
    return {
      key: String(rel.slug ?? rel.id),
      slug: rel.slug,
      name: rel.name ?? '',
      label: edgeLabel(rel),
      from,
      to,
      x1: p.x,
      y1: p.y,
      x2: q.x,
      y2: q.y,
      mx: r2((p.x + q.x) / 2),
      my: r2((p.y + q.y) / 2),
    };
  });
  return { width, height, nodes, edges };
}

/**
 * A standalone SVG document of a layout: edges as lines with their labels at the middle, entries as circles with their names. All text is escaped.
 * @param {ReturnType<typeof relationshipLayout>} layout
 */
export function relationshipSvg(layout) {
  const { width, height, nodes, edges } = layout;
  const lines = edges.map((e) => `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="#777777" stroke-width="2"/>`);
  const labels = edges
    .filter((e) => e.label)
    .map((e) => `<text x="${e.mx}" y="${e.my}" text-anchor="middle" font-size="12" fill="#222222" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeSvgText(e.label)}</text>`);
  const circles = nodes.flatMap((n) => [
    `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="#dbe7f5" stroke="#2f5d8a" stroke-width="2"/>`,
    `<text x="${n.x}" y="${r2(n.y + n.r + 16)}" text-anchor="middle" font-size="14" fill="#111111">${escapeSvgText(n.name)}</text>`,
  ]);
  const body = [...lines, ...labels, ...circles].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">\n<rect width="${width}" height="${height}" fill="#ffffff"/>\n${body}\n</svg>\n`;
}
