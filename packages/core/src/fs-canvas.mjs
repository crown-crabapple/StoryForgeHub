// FsRepository canvases (M09-J01): planning/canvases/<slug>.canvas, JSON Canvas files. Reads come from the files on every call (nothing is kept in the index), so a
// canvas edited outside the app shows up on the next read and deleting .storyforge/ changes nothing. Writes go through @storyforge/manuscript (the store).
// No filesystem access here: listing and reading are the `listDir` / `readFileAt` functions fs-repository.mjs passes in.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CANVAS_DIR, CANVAS_EXT, canvasTitle, extractDocs, parseCanvas, validate } from '@storyforge/format';
import { archiveCanvas, createCanvas, restoreCanvas, saveCanvas } from '@storyforge/manuscript';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const SLUG_OF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.canvas$/;
const TARGET_KINDS = ['scene', 'entry', 'thread', 'event', 'research', 'doc', 'source'];
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * @param {{ root: string, readValidate?: () => Promise<any>, listDir: (libRel: string) => Promise<string[]>, readFileAt: (libRel: string) => Promise<{ bytes: Buffer, mtimeMs: number } | null>,
 *   afterWrite?: (bookPath: string) => void }} deps
 */
export function createCanvasMethods({ root, readValidate = () => validate(root), listDir, readFileAt, afterWrite = () => {} }) {
  async function load(bookId) {
    const result = await readValidate();
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    const prefix = book.path ? `${book.path}/` : '';
    return { result, book, prefix, bookRoot: book.path === '' ? root : path.join(root, ...book.path.split('/')) };
  }

  /** Every canvas file of one folder: [{ slug, title, path, nodes, edges, sha256, updated_at, problem }] sorted by title. */
  async function listIn(ctx, folder) {
    const out = [];
    for (const name of await listDir(`${ctx.prefix}${folder}`)) {
      const m = SLUG_OF_RE.exec(name);
      if (!m) continue;
      const rel = `${folder}/${name}`;
      const f = await readFileAt(`${ctx.prefix}${rel}`);
      if (!f) continue;
      const parsed = parseCanvas(f.bytes.toString('utf8'));
      out.push({
        slug: m[1],
        title: parsed.ok ? canvasTitle(parsed.canvas, m[1]) : m[1],
        path: rel,
        nodes: parsed.ok ? parsed.canvas.nodes.length : 0,
        edges: parsed.ok ? parsed.canvas.edges.length : 0,
        sha256: sha(f.bytes),
        updated_at: new Date(f.mtimeMs).toISOString(),
        problem: parsed.ok ? null : parsed.message,
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
  }

  /** What a story card may point at, and how to resolve one: { targets, resolve(ref) }. */
  function storyIndex(ctx) {
    const docs = extractDocs(ctx.result, ctx.book.path).filter((d) => TARGET_KINDS.includes(d.kind) && typeof d.fm.id === 'string');
    const order = new Map(ctx.book.order.map((s) => [s.id, s]));
    const bookRel = (file) => (ctx.prefix && file.startsWith(ctx.prefix) ? file.slice(ctx.prefix.length) : file);
    const titleOf = (d) => str(d.fm.title) ?? str(d.fm.name) ?? str(d.fm.slug) ?? d.fm.id;
    const subtitleOf = (d) => {
      if (d.kind === 'scene') {
        const s = order.get(d.fm.id);
        return s ? `${s.chapter_label ?? `Chapter ${s.chapter}`} · scene ${s.position}` : 'Not in the book order';
      }
      if (d.kind === 'entry') return str(d.fm.type) ?? 'entry';
      if (d.kind === 'thread') return str(d.fm.status) ?? 'thread';
      if (d.kind === 'event') return str(d.fm.when) ?? 'event';
      return d.kind === 'doc' ? 'planning doc' : d.kind;
    };
    const byId = new Map();
    for (const d of docs) {
      const prev = byId.get(d.fm.id);
      if (!prev || (prev.archived && !d.archived)) byId.set(d.fm.id, d);
    }
    const live = docs.filter((d) => !d.archived);
    const rank = (d) => (d.kind === 'scene' ? (order.get(d.fm.id)?.position ?? 1e9) : 0);
    const targets = live
      .filter((d) => d.kind !== 'scene' || order.has(d.fm.id))
      .sort((a, b) => TARGET_KINDS.indexOf(a.kind) - TARGET_KINDS.indexOf(b.kind) || rank(a) - rank(b) || titleOf(a).localeCompare(titleOf(b)))
      .map((d) => ({ ref: d.fm.id, kind: d.kind, title: titleOf(d), subtitle: subtitleOf(d), slug: str(d.fm.slug) }));
    const resolve = (ref) => {
      const d = byId.get(ref) ?? docs.find((x) => x.fm.slug === ref);
      if (!d) return { state: 'broken', kind: null, id: ref, title: null, summary: null, path: null, slug: null };
      return { state: d.archived ? 'archived' : 'ok', kind: d.kind, id: d.fm.id, title: titleOf(d), summary: str(d.fm.summary) ?? subtitleOf(d), path: bookRel(d.file), slug: str(d.fm.slug) };
    };
    return { targets, resolve };
  }

  /** Copy of the canvas with every story card's `file` set to its target's current path (a broken or archived target keeps its path). */
  function refreshPaths(canvas, resolve) {
    let changed = false;
    const nodes = canvas.nodes.map((n) => {
      const ref = n?.storyforge?.ref;
      if (n?.type !== 'file' || typeof ref !== 'string') return n;
      const r = resolve(ref);
      if (r.state !== 'ok' || r.path === n.file) return n;
      changed = true;
      return { ...n, file: r.path };
    });
    return changed ? { ...canvas, nodes } : canvas;
  }

  return {
    /** GET /api/books/:b/canvases. Null when there is no such book. */
    async listCanvases(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      return { canvases: await listIn(ctx, CANVAS_DIR), archived: await listIn(ctx, `archive/${CANVAS_DIR}`) };
    },

    /** GET /api/books/:b/canvases/:slug: { slug, title, path, sha256, canvas, problem, refs, targets }. Null when there is no such book or canvas. */
    async getCanvas(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      const rel = `${CANVAS_DIR}/${slug}${CANVAS_EXT}`;
      const f = await readFileAt(`${ctx.prefix}${rel}`);
      if (!f) return null;
      const text = f.bytes.toString('utf8');
      const parsed = parseCanvas(text);
      const { targets, resolve } = storyIndex(ctx);
      const canvas = parsed.ok ? parsed.canvas : { nodes: [], edges: [] };
      const refs = {};
      for (const n of canvas.nodes) if (typeof n?.storyforge?.ref === 'string') refs[n.id] = resolve(n.storyforge.ref);
      return { slug, title: parsed.ok ? canvasTitle(canvas, slug) : slug, path: rel, sha256: sha(f.bytes), canvas, problem: parsed.ok ? null : parsed.message, refs, targets };
    },

    async createCanvas(bookId, args = {}) {
      const ctx = await load(bookId);
      if (!ctx) return fail('NOT_FOUND');
      const r = await createCanvas(ctx.bookRoot, args);
      if (r.ok && !r.dryRun) afterWrite(ctx.book.path);
      return r;
    },

    /** Save the whole canvas (story-card paths refreshed first). CONFLICT carries `current: { sha256, canvas }`. */
    async saveCanvas(bookId, slug, { canvas, baseSha256 } = {}) {
      const ctx = await load(bookId);
      if (!ctx) return fail('NOT_FOUND');
      const parsed = parseCanvas(canvas);
      const next = parsed.ok ? refreshPaths(parsed.canvas, storyIndex(ctx).resolve) : canvas;
      const r = await saveCanvas(ctx.bookRoot, slug, { canvas: next, baseSha256 });
      if (r.ok) {
        if (r.changes?.length) afterWrite(ctx.book.path);
        return r;
      }
      if (r.code === 'CONFLICT' && r.current) {
        const now = parseCanvas(r.current.text);
        return { ...r, current: { sha256: r.current.sha256, canvas: now.ok ? now.canvas : null, problem: now.ok ? null : now.message } };
      }
      return r;
    },

    async archiveCanvas(bookId, slug, args = {}) {
      const ctx = await load(bookId);
      if (!ctx) return fail('NOT_FOUND');
      const r = await archiveCanvas(ctx.bookRoot, slug, args);
      if (r.ok && !r.dryRun) afterWrite(ctx.book.path);
      return r;
    },

    async restoreCanvas(bookId, slug, args = {}) {
      const ctx = await load(bookId);
      if (!ctx) return fail('NOT_FOUND');
      const r = await restoreCanvas(ctx.bookRoot, slug, args);
      if (r.ok && !r.dryRun) afterWrite(ctx.book.path);
      return r;
    },
  };
}
