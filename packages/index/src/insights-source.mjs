// The structural inputs of the Insights numbers (M07-J02), taken from validate()'s result instead of the index.
// Must give exactly what queries.insightsStructure() gives from the index (a test compares them).
import { extractDocs } from '@storyforge/format';
import { buildGraph } from './graph.mjs';
import { countWords } from './word-count.mjs';

const str = (v) => (typeof v === 'string' ? v : null);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * @param {{ books: any[] }} result what validate() returned @param {string} bookPath as in `result.books[i].path`
 * @returns {{ scenes: any[], chapters: any[], containers: any[], nodes: any[], edges: any[] } | null} null when the book is not in the result
 */
export function structureFromResult(result, bookPath) {
  const book = result.books.find((b) => b.path === bookPath);
  if (!book) return null;
  const docs = extractDocs(result, bookPath);
  const prefix = bookPath === '' ? '' : `${bookPath}/`;
  const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const byRel = new Map(docs.map((d) => [d.rel, d]));
  const scenes = book.order.map((s) => {
    const p = rel(s.path);
    const doc = byRel.get(p);
    return {
      id: s.id, title: s.title, position: s.position, act: s.act, chapter: s.chapter, sequence: s.sequence,
      status: str(doc?.fm.status), pov: str(doc?.fm.pov), word_count: countWords(doc?.body ?? ''), path: p,
    };
  });
  const chapters = [];
  const seen = new Set();
  for (const s of book.order) {
    const key = `${s.act}/${s.chapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = dirOf(rel(s.path));
    let title = null;
    if (baseOf(dir).startsWith('ch-')) {
      const d = byRel.get(`${dir}/chapter.md`);
      title = d && d.kind === 'chapter' && typeof d.fm.id === 'string' ? (str(d.fm.title) ?? str(d.fm.name)) : null;
    }
    chapters.push({ act: s.act, act_label: s.act_label, chapter: s.chapter, label: s.chapter_label, title });
  }
  const containers = docs
    .filter((d) => !d.archived && (d.kind === 'chapter' || d.kind === 'act') && typeof d.fm.id === 'string')
    .map((d) => ({ id: d.fm.id, kind: d.kind, dir: dirOf(d.rel) }));
  const graph = buildGraph(result, undefined, bookPath);
  const nodes = graph.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type ?? null, name: n.name ?? null, ...(n.owner ? { owner: n.owner } : {}), ...(n.external ? { external: true } : {}) }));
  const edges = graph.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, rel: e.rel, location: e.source.location }));
  return { scenes, chapters, containers, nodes, edges };
}
