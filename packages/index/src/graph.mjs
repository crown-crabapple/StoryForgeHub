// The book graph (contract M04-J01 section 3), computed from the link records and the mention rows only.
// buildGraph() is pure (no database); the index stores the same edges in its `graph` table, and
// subGraph() narrows either one to a node's neighbourhood and/or one edge kind.
import { extractDocs, extractLinks } from '@storyforge/format';
import { foldText, mentionCounter, stripForSearch } from './text.mjs';

/** Kinds that are nodes of the graph. */
export const GRAPH_KINDS = ['scene', 'entry', 'thread', 'event'];

/**
 * @typedef {{ id: string, kind: string, type: string|null, name: string|null }} GraphNode
 * @typedef {{ from: string, to: string, kind: 'explicit'|'inferred', rel: string, label?: string,
 *             source: { path: string, location: string }, count?: number }} GraphEdge
 * @typedef {{ entry_id: string, scene_id: string, count: number }} MentionRow
 */

const str = (v) => (typeof v === 'string' ? v : null);

/** The mention rows of a book: entry name and aliases counted in every scene's prose. @returns {MentionRow[]} */
export function mentionRows(docs, order, rel) {
  const byRel = new Map(docs.map((d) => [d.rel, d]));
  const scenes = order.map((s) => ({ id: s.id, text: foldText(stripForSearch(byRel.get(rel(s.path))?.body ?? '')) }));
  const rows = [];
  for (const d of docs) {
    if (d.kind !== 'entry' || typeof d.fm.id !== 'string') continue;
    const count = mentionCounter([d.fm.name, ...(Array.isArray(d.fm.aliases) ? d.fm.aliases : [])]);
    if (!count) continue;
    for (const s of scenes) {
      const n = count(s.text);
      if (n > 0) rows.push({ entry_id: d.fm.id, scene_id: s.id, count: n });
    }
  }
  return rows;
}

/** How a link record's location maps to an edge `rel`. */
function relOf(location) {
  if (/^related\[\d+\]\.to$/.test(location)) return 'related';
  if (location === 'pov') return 'pov';
  if (location.startsWith('characters[')) return 'character';
  if (location.startsWith('locations[')) return 'location';
  if (location.startsWith('plot_threads[')) return 'thread';
  if (location.startsWith('events[')) return 'event';
  return 'link';
}

/**
 * @param {{ books: any[] }} result what @storyforge/format validate() returned
 * @param {MentionRow[]} [mentions] mention rows; computed from the files when omitted
 * @param {string} [bookPath] one book of the result (all of them when omitted)
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[] }}
 */
export function buildGraph(result, mentions, bookPath) {
  const nodes = [];
  const edges = [];
  for (const book of result.books.filter((b) => bookPath === undefined || b.path === bookPath)) {
    const docs = extractDocs(result, book.path);
    const links = extractLinks(result, book.path);
    const prefix = book.path === '' ? '' : `${book.path}/`;
    const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const rows = mentions ?? mentionRows(docs, book.order, rel);

    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const d of docs) if (typeof d.fm.id === 'string' && !byId.has(d.fm.id)) byId.set(d.fm.id, d);
    for (const d of byId.values()) {
      if (GRAPH_KINDS.includes(d.kind)) nodes.push({ id: d.fm.id, kind: d.kind, type: d.kind === 'entry' ? str(d.fm.type) : null, name: str(d.fm.title) ?? str(d.fm.name) });
    }

    const isNode = (id, kind) => GRAPH_KINDS.includes(kind) && byId.get(id)?.kind === kind;
    const seen = new Set();
    const pairs = new Set();
    for (const l of links) {
      if (!l.src_id || !l.target_id || l.src_id === l.target_id) continue;
      const src = byId.get(l.src_id);
      if (!src || src.rel !== l.src_path || !isNode(l.src_id, src.kind) || !isNode(l.target_id, l.target_kind)) continue;
      const rel_ = relOf(l.location);
      let label;
      if (rel_ === 'related') {
        const i = Number(/\[(\d+)\]/.exec(l.location)[1]);
        label = str(src.fm.related?.[i]?.as) ?? undefined;
      }
      const key = `${l.src_id}\0${l.target_id}\0${rel_}\0${label ?? ''}`;
      pairs.add([l.src_id, l.target_id].sort().join('\0'));
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: l.src_id, to: l.target_id, kind: 'explicit', rel: rel_, ...(label !== undefined ? { label } : {}), source: { path: l.src_path, location: l.location } });
    }
    for (const m of rows) {
      if (pairs.has([m.scene_id, m.entry_id].sort().join('\0'))) continue;
      if (!isNode(m.scene_id, 'scene') || !isNode(m.entry_id, 'entry')) continue;
      edges.push({ from: m.scene_id, to: m.entry_id, kind: 'inferred', rel: 'mention', source: { path: byId.get(m.scene_id).rel, location: '' }, count: m.count });
    }
  }
  return { nodes, edges };
}

/**
 * Narrow a graph: edges of the given kinds, and with `node` only the edges that touch it plus the node and
 * its neighbours. Returns null when `node` is not in the graph.
 * @param {{ nodes: GraphNode[], edges: GraphEdge[] }} graph
 * @param {{ node?: string, kinds?: string[] }} [opts]
 */
export function subGraph(graph, { node, kinds } = {}) {
  let edges = kinds ? graph.edges.filter((e) => kinds.includes(e.kind)) : graph.edges;
  if (node === undefined) return { nodes: graph.nodes, edges };
  if (!graph.nodes.some((n) => n.id === node)) return null;
  edges = edges.filter((e) => e.from === node || e.to === node);
  const keep = new Set([node]);
  for (const e of edges) {
    keep.add(e.from);
    keep.add(e.to);
  }
  return { nodes: graph.nodes.filter((n) => keep.has(n.id)), edges };
}
