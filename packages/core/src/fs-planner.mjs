// FsRepository Story Planner reads (ADR 0003, M1; character arcs M3; structures M4): causal links (planning/links/<slug>.md), scene plan sidecars (planning/scene-plans/<scene>.md) and the
// flow projection (scenes in reading order + live links), the book-level story plan (planning/story.md) and the plan overview. Reads come from the validated documents on every call (nothing is kept in the index), so a file edited
// outside the app shows up on the next read. Writes are in fs-writes.mjs (through @storyforge/manuscript and the store).
// No filesystem access here: file bytes (for sha256) come from the `readFileAt` function fs-repository.mjs passes in.
import { createHash } from 'node:crypto';
import { extractDocs, extractShared, validate } from '@storyforge/format';
import { ARC_TEXT_FIELDS, MILESTONE_FIELDS, PLAN_FIELDS, STORY_FIELDS, STORY_PATH, STRUCTURE_TEMPLATES } from '@storyforge/manuscript';

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
    const shared = extractShared(result, book.path);
    /** @type {Map<string, any[]>} file -> diagnostics */
    const problems = new Map();
    for (const d of result.diagnostics) {
      if (!d.file.startsWith(prefix)) continue;
      if (!problems.has(d.file)) problems.set(d.file, []);
      problems.get(d.file).push({ code: d.code, message: d.message });
    }
    return { book, prefix, docs, scenes, problems, shared };
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

  const arcDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'arc' && d.archived === archived).sort(byRel);

  /** The entry an arc's `character` id names: the book's own entries first, then the series' shared ones; live before archived. null when unresolved. */
  function characterOf(ctx, id) {
    if (typeof id !== 'string') return null;
    const own = ctx.docs.filter((d) => d.kind === 'entry' && d.fm.id === id).map((d) => ({ d, shared: false }));
    const series = (ctx.shared?.docs ?? []).filter((d) => d.kind === 'entry' && d.fm.id === id).map((d) => ({ d, shared: true }));
    const hit = [...own, ...series].sort((a, b) => Number(a.d.archived) - Number(b.d.archived))[0];
    return hit ? { id, slug: text(hit.d.fm.slug), name: text(hit.d.fm.name), shared: hit.shared } : null;
  }

  const arcOf = (ctx, d, sha256) => {
    const character = characterOf(ctx, d.fm.character);
    const milestones = (Array.isArray(d.fm.milestones) ? d.fm.milestones : []).map((m, index) => {
      const item = m !== null && typeof m === 'object' && !Array.isArray(m) ? m : {};
      const scene = text(item.scene);
      const live = scene ? ctx.scenes.get(scene) : null;
      return {
        index,
        scene,
        scene_title: live ? (live.title ?? null) : null,
        chapter: live && Number.isInteger(live.chapter) ? live.chapter : null,
        sequence: live && Number.isInteger(live.sequence) ? live.sequence : null,
        ...Object.fromEntries(MILESTONE_FIELDS.map((k) => [k, typeof item[k] === 'string' && item[k] !== '' ? item[k] : null])),
      };
    });
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      sha256,
      character,
      character_id: text(d.fm.character),
      arc_type: text(d.fm.arc_type),
      fields: Object.fromEntries(ARC_TEXT_FIELDS.map((k) => [k, typeof d.fm[k] === 'string' && d.fm[k] !== '' ? d.fm[k] : null])),
      milestones,
      body: tidy(d.body),
      problems: ctx.problems.get(d.file) ?? [],
    };
  };

  const structureDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'structure' && d.archived === archived).sort(byRel);

  /** The id the book's live story plan names as its primary structure (null when there is none). */
  const primaryIdOf = (ctx) => {
    const d = ctx.docs.find((x) => x.kind === 'story-plan' && !x.archived && x.rel === STORY_PATH);
    return d && typeof d.fm.primary_structure === 'string' && d.fm.primary_structure !== '' ? d.fm.primary_structure : null;
  };

  const structureOf = (ctx, d, sha256, primaryId) => {
    const beats = (Array.isArray(d.fm.beats) ? d.fm.beats : []).map((b) => {
      const item = b !== null && typeof b === 'object' && !Array.isArray(b) ? b : {};
      const scenes = (Array.isArray(item.scenes) ? item.scenes : []).filter((s) => typeof s === 'string').map((id) => {
        const live = ctx.scenes.get(id);
        return { id, title: live ? (live.title ?? null) : null, chapter: live && Number.isInteger(live.chapter) ? live.chapter : null, sequence: live && Number.isInteger(live.sequence) ? live.sequence : null };
      });
      return {
        id: text(item.id),
        name: text(item.name),
        purpose: text(item.purpose) || null,
        question: text(item.question) || null,
        position: text(item.position) || null,
        state: item.state === 'done' || item.state === 'omitted' ? item.state : 'open',
        scenes,
      };
    });
    const id = text(d.fm.id);
    return {
      id,
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      name: text(d.fm.name),
      template: text(d.fm.template),
      template_version: Number.isInteger(d.fm.template_version) ? d.fm.template_version : null,
      primary: id !== null && id === primaryId,
      sha256,
      body: tidy(d.body),
      beats,
      counts: { beats: beats.length, assigned: beats.filter((b) => b.scenes.length > 0).length, omitted: beats.filter((b) => b.state === 'omitted').length },
    };
  };

  /** Flow projection of a loaded book (see flowGraph). */
  async function flow(ctx) {
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
  }

  /** The story plan of a loaded book (see getStoryPlan). Only a live file at planning/story.md counts; a story plan anywhere else gets W318 and is ignored here. */
  async function story(ctx) {
    const d = ctx.docs.find((x) => x.kind === 'story-plan' && !x.archived && x.rel === STORY_PATH) ?? null;
    const fields = Object.fromEntries(STORY_FIELDS.map((k) => [k, d && typeof d.fm[k] === 'string' && d.fm[k] !== '' ? d.fm[k] : null]));
    if (!d) return { path: null, sha256: null, fields, body: '' };
    const f = await readFileAt(`${ctx.prefix}${d.rel}`);
    return { path: d.rel, sha256: f ? sha(f.bytes) : null, fields, body: tidy(d.body) };
  }

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
     * GET /api/books/:b/arcs: { arcs, archived } (planning/arcs/*.md). Arc = { id, slug, path, sha256, character: { id, slug, name, shared } | null, character_id, arc_type,
     * fields: { want, need, false_belief, fear, wound, start_state, end_state }, milestones: [{ index, scene, scene_title, chapter, sequence, pressure, choice, belief_before,
     * belief_after, cost }], body, problems }. `character` is null when the id names no entry (the id stays in character_id); scene_title, chapter and sequence are null when the
     * scene is not live. Live arcs are sorted by character name (unresolved last), then slug. Null when there is no such book.
     */
    async listArcs(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = arcDocs(ctx, false);
      const arch = arcDocs(ctx, true);
      const sums = await hashes(ctx, [...live, ...arch].map((d) => d.rel));
      const arcs = live.map((d) => arcOf(ctx, d, sums.get(d.rel) ?? null));
      const key = (a) => (a.character?.name ?? '').toLowerCase();
      arcs.sort((a, b) => Number(a.character === null) - Number(b.character === null) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return { arcs, archived: arch.map((d) => arcOf(ctx, d, sums.get(d.rel) ?? null)) };
    },

    /** GET /api/books/:b/arcs/:slug: the live arc, else the archived one, with `archived`. Null when there is no such book or arc. */
    async getArc(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/arcs/${slug}.md`;
        const d = arcDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        return { ...arcOf(ctx, d, f ? sha(f.bytes) : null), archived };
      }
      return null;
    },

    /** GET /api/books/:b/structure-templates: the built-in templates (STRUCTURE_TEMPLATES), the same for every book. */
    listStructureTemplates() {
      return STRUCTURE_TEMPLATES;
    },

    /**
     * GET /api/books/:b/structures: { structures, archived } (planning/structures/*.md). Structure = { id, slug, name, template, template_version, primary, sha256, body,
     * beats: [{ id, name, purpose, question, position, state, scenes: [{ id, title, chapter, sequence }] }], counts: { beats, assigned, omitted } }. `primary` is true when the story
     * plan's primary_structure is its id; `state` is open, done or omitted (absent = open); a scene that is not live has null title, chapter and sequence; assigned = beats with at
     * least one scene. Live structures are sorted primary first, then by name, then slug. archived = [{ slug, name }]. Null when there is no such book.
     */
    async listStructures(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = structureDocs(ctx, false);
      const arch = structureDocs(ctx, true);
      const sums = await hashes(ctx, live.map((d) => d.rel));
      const primaryId = primaryIdOf(ctx);
      const structures = live.map((d) => structureOf(ctx, d, sums.get(d.rel) ?? null, primaryId));
      const key = (s) => (s.name ?? '').toLowerCase();
      structures.sort((a, b) => Number(b.primary) - Number(a.primary) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return { structures, archived: arch.map((d) => ({ slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(), name: text(d.fm.name) })) };
    },

    /** GET /api/books/:b/structures/:slug: the live structure (shape as in listStructures), else the archived one, with `archived`. Null when there is no such book or structure. */
    async getStructure(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/structures/${slug}.md`;
        const d = structureDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        return { ...structureOf(ctx, d, f ? sha(f.bytes) : null, primaryIdOf(ctx)), archived };
      }
      return null;
    },

    /**
     * GET /api/books/:b/flow: nodes are the live scenes in reading order, edges the live links. An edge with an end that is not a live scene is still returned, `broken: true`.
     * Null when there is no such book.
     */
    async flowGraph(bookId) {
      const ctx = await load(bookId);
      return ctx ? flow(ctx) : null;
    },

    /**
     * GET /api/books/:b/story: planning/story.md. `{ path, sha256, fields: { premise, logline, theme_question, central_conflict, protagonist_goal, stakes, protagonist, primary_structure }, body }`;
     * no file: path and sha256 null, every field null, body ''. Null when there is no such book.
     */
    async getStoryPlan(bookId) {
      const ctx = await load(bookId);
      return ctx ? story(ctx) : null;
    },

    /**
     * The Overview read: `{ story, counts, primary_structure, unlinked }`. scenes = the flow nodes; linked_scenes = scenes at an end of a live link; unlinked = the other scenes in reading
     * order (max 50); broken_links = live links with an end that is not a live scene; threads = live plot threads; arcs = live arcs; structures = live structures.
     * `primary_structure` is `{ id, slug, name }` of the live structure the story plan names, else null. Null when there is no such book.
     */
    async planOverview(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const { nodes, edges } = await flow(ctx);
      const ends = new Set(edges.flatMap((e) => [e.from, e.to]));
      const unlinked = nodes.filter((n) => !ends.has(n.id));
      const primaryId = primaryIdOf(ctx);
      const primary = primaryId ? structureDocs(ctx, false).find((d) => d.fm.id === primaryId) : null;
      return {
        story: await story(ctx),
        counts: {
          scenes: nodes.length,
          planned_scenes: nodes.filter((n) => n.plan).length,
          links: edges.length,
          linked_scenes: nodes.length - unlinked.length,
          unlinked_scenes: unlinked.length,
          broken_links: edges.filter((e) => e.broken).length,
          archived_links: linkDocs(ctx, true).length,
          threads: ctx.docs.filter((d) => d.kind === 'thread' && !d.archived).length,
          arcs: arcDocs(ctx, false).length,
          structures: structureDocs(ctx, false).length,
        },
        primary_structure: primary ? { id: primaryId, slug: text(primary.fm.slug) ?? stem(primary.rel).split('/').pop(), name: text(primary.fm.name) } : null,
        unlinked: unlinked.slice(0, 50).map((n) => ({ id: n.id, title: n.title })),
      };
    },
  };
}
