// FsRepository Story Planner reads (ADR 0003, M1): causal links (planning/links/<slug>.md), scene plan sidecars (planning/scene-plans/<scene>.md) and the
// flow projection (scenes in reading order + live links). Reads come from the validated documents on every call (nothing is kept in the index), so a file edited
// outside the app shows up on the next read. Writes are in fs-writes.mjs (through @storyforge/manuscript and the store).
// No filesystem access here: file bytes (for sha256) come from the `readFileAt` function fs-repository.mjs passes in.
import { createHash } from 'node:crypto';
import { extractDocs, validate } from '@storyforge/format';
import { PLAN_FIELDS } from '@storyforge/manuscript';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (v) => (typeof v === 'string' ? v : null);
const stem = (rel) => rel.replace(/[.]md$/, '');
const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
/** Body of a document as the author wrote it: no leading blank lines, no trailing white space. */
const tidy = (body) => (typeof body === 'string' ? body.replace(/^(?:\r?\n)+/, '').replace(/\s+$/, '') : '');
const CHUNK = 32;

/**
 * @param {{ root: string, readValidate?: () => Promise<any>, readFileAt: (libRel: string) => Promise<{ bytes: Buffer, mtimeMs: number } | null> }} deps
 */
export function createPlannerMethods({ root, readValidate = () => validate(root), readFileAt }) {
  async function load(bookId) {
    const result = await readValidate();
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    const prefix = book.path ? `${book.path}/` : '';
    const docs = extractDocs(result, book.path);
    const scenes = new Map(book.order.map((/** @type {any} */ s) => [s.id, s]));
    /** @type {Map<string, any[]>} file -> diagnostics */
    const problems = new Map();
    for (const d of result.diagnostics) {
      if (!d.file.startsWith(prefix)) continue;
      if (!problems.has(d.file)) problems.set(d.file, []);
      problems.get(d.file).push({ code: d.code, message: d.message });
    }
    return { book, prefix, docs, scenes, problems };
  }

  /** sha256 of many book files at once (in small batches). @returns {Promise<Map<string, string|null>>} */
  async function hashes(ctx, rels) {
    const out = new Map();
    for (let i = 0; i < rels.length; i += CHUNK) {
      const part = rels.slice(i, i + CHUNK);
      const got = await Promise.all(part.map((rel) => readFileAt(`${ctx.prefix}${rel}`)));
      part.forEach((rel, j) => out.set(rel, got[j] ? sha(got[j].bytes) : null));
    }
    return out;
  }

  const linkOf = (ctx, d, sha256) => {
    const from = text(d.fm.from);
    const to = text(d.fm.to);
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      from,
      to,
      relation: text(d.fm.relation),
      rationale: tidy(d.body),
      created: d.fm.created === undefined || d.fm.created === null ? null : String(d.fm.created),
      sha256,
      from_title: from ? (ctx.scenes.get(from)?.title ?? null) : null,
      to_title: to ? (ctx.scenes.get(to)?.title ?? null) : null,
      problems: ctx.problems.get(d.file) ?? [],
    };
  };

  const linkDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'link' && d.archived === archived).sort(byRel);
  const planOf = (ctx, sceneId) => ctx.docs.filter((d) => d.kind === 'scene-plan' && !d.archived && d.fm.scene === sceneId).sort((a, b) => (stem(a.rel) < stem(b.rel) ? -1 : stem(a.rel) > stem(b.rel) ? 1 : 0))[0] ?? null;

  return {
    /** GET /api/books/:b/links: { links, archived }. Null when there is no such book. */
    async listLinks(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = linkDocs(ctx, false);
      const arch = linkDocs(ctx, true);
      const sums = await hashes(ctx, [...live, ...arch].map((d) => d.rel));
      return { links: live.map((d) => linkOf(ctx, d, sums.get(d.rel) ?? null)), archived: arch.map((d) => linkOf(ctx, d, sums.get(d.rel) ?? null)) };
    },

    /** GET /api/books/:b/links/:slug: the live link, else the archived one, with `archived`. Null when there is no such book or link. */
    async getLink(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/links/${slug}.md`;
        const d = linkDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        return { ...linkOf(ctx, d, f ? sha(f.bytes) : null), archived };
      }
      return null;
    },

    /** GET /api/books/:b/scene-plans/:sceneId. Null when the book or the live scene is unknown; a scene with no sidecar has no path, no sha256, null fields. */
    async getScenePlan(bookId, sceneId) {
      const ctx = await load(bookId);
      if (!ctx || typeof sceneId !== 'string' || !ctx.scenes.has(sceneId)) return null;
      const d = planOf(ctx, sceneId);
      const fields = Object.fromEntries(PLAN_FIELDS.map((k) => [k, d && typeof d.fm[k] === 'string' && d.fm[k] !== '' ? d.fm[k] : null]));
      if (!d) return { scene_id: sceneId, path: null, sha256: null, fields, characters: [], body: '' };
      const f = await readFileAt(`${ctx.prefix}${d.rel}`);
      const characters = Array.isArray(d.fm.characters) ? d.fm.characters.filter((c) => typeof c === 'string') : [];
      return { scene_id: sceneId, path: d.rel, sha256: f ? sha(f.bytes) : null, fields, characters, body: tidy(d.body) };
    },

    /**
     * GET /api/books/:b/flow: nodes are the live scenes in reading order, edges the live links. An edge with an end that is not a live scene is still returned, `broken: true`.
     * Null when there is no such book.
     */
    async flowGraph(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const sceneDocs = new Map(ctx.docs.filter((d) => d.kind === 'scene' && !d.archived).map((d) => [d.fm.id, d]));
      const planned = new Set(ctx.docs.filter((d) => d.kind === 'scene-plan' && !d.archived && typeof d.fm.scene === 'string').map((d) => d.fm.scene));
      const nodes = ctx.book.order.map((/** @type {any} */ s) => {
        const fm = sceneDocs.get(s.id)?.fm ?? {};
        return { id: s.id, kind: 'scene', title: s.title ?? null, summary: text(fm.summary), status: text(fm.status), pov: text(fm.pov), act: s.act, chapter: s.chapter, sequence: s.sequence, plan: planned.has(s.id) };
      });
      const live = linkDocs(ctx, false);
      const sums = await hashes(ctx, live.map((d) => d.rel));
      const edges = live.map((d) => {
        const l = linkOf(ctx, d, sums.get(d.rel) ?? null);
        return { id: l.id, slug: l.slug, from: l.from, to: l.to, relation: l.relation, rationale: l.rationale, sha256: l.sha256, broken: !(l.from && ctx.scenes.has(l.from) && l.to && ctx.scenes.has(l.to)) };
      });
      return { nodes, edges };
    },
  };
}
