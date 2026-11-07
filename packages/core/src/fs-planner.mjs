// FsRepository Story Planner reads (ADR 0003, M1; character arcs M3; structures M4; relationships, beats in links and the planBadges projection M5): causal links (planning/links/<slug>.md), scene plan sidecars (planning/scene-plans/<scene>.md) and the
// flow projection (scenes in reading order + live links), the book-level story plan (planning/story.md) and the plan overview. Reads come from the validated documents on every call (nothing is kept in the index), so a file edited
// outside the app shows up on the next read. Writes are in fs-writes.mjs (through @storyforge/manuscript and the store).
// No filesystem access here: file bytes (for sha256) come from the `readFileAt` function fs-repository.mjs passes in.
import { createHash } from 'node:crypto';
import { extractDocs, extractShared, validate } from '@storyforge/format';
import { ARC_TEXT_FIELDS, CLUE_KINDS, MILESTONE_FIELDS, PLAN_FIELDS, STORY_FIELDS, STORY_PATH, STRUCTURE_TEMPLATES, SYNOPSIS_LABELS, SYNOPSIS_TYPES } from '@storyforge/manuscript';
import { basisOf, extractText } from './synopsis-extract.mjs';
import { countWords } from './word-count.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (v) => (typeof v === 'string' ? v : null);
const stem = (rel) => rel.replace(/[.]md$/, '');
const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
/** Body of a document as the author wrote it: no leading blank lines, no trailing white space. */
const tidy = (body) => (typeof body === 'string' ? body.replace(/^(?:\r?\n)+/, '').replace(/\s+$/, '') : '');
const CHUNK = 32;

/**
 * @param {{ root: string, readValidate?: () => Promise<any>, readFileAt: (libRel: string) => Promise<{ bytes: Buffer, mtimeMs: number } | null>, readSceneSummaries?: (order: any[]) => Promise<(string | null)[]> }} deps
 *   readSceneSummaries: the `summary` front matter value of each scene of `order` (null when it has none); only summaries are read for extraction (M7), never prose.
 */
export function createPlannerMethods({ root, readValidate = () => validate(root), readFileAt, readSceneSummaries = async (order) => order.map(() => null) }) {
  async function load(bookId) {
    return loadFrom(await readValidate(), bookId);
  }

  /** The context of one book of an already validated library. */
  function loadFrom(result, bookId) {
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

  /**
   * Every beat of the book's structures by id, for link ends (M5): { id, name, structure: { slug, name, archived } }. A beat of a live structure beats the same id in an archived one.
   * @returns {Map<string, { id: string, name: string | null, structure: { slug: string, name: string | null, archived: boolean } }>}
   */
  function beatIndex(ctx) {
    if (ctx.beatIdx) return ctx.beatIdx;
    const out = new Map();
    for (const d of ctx.docs.filter((x) => x.kind === 'structure').sort((a, b) => Number(a.archived) - Number(b.archived) || byRel(a, b))) {
      const structure = { slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(), name: text(d.fm.name), archived: d.archived };
      for (const b of Array.isArray(d.fm.beats) ? d.fm.beats : []) {
        if (b === null || typeof b !== 'object' || Array.isArray(b) || typeof b.id !== 'string' || out.has(b.id)) continue;
        out.set(b.id, { id: b.id, name: text(b.name), structure });
      }
    }
    ctx.beatIdx = out;
    return out;
  }

  /** What a link end is: { kind: 'scene' | 'beat', title } (title null when it does not resolve; an unresolved end is kind 'scene'). A beat's title is "<structure name>: <beat name>". */
  function endOf(ctx, beats, id) {
    if (!id) return { kind: 'scene', title: null };
    const scene = ctx.scenes.get(id);
    if (scene) return { kind: 'scene', title: scene.title ?? null };
    const beat = beats.get(id);
    if (beat) return { kind: 'beat', title: `${beat.structure.name ?? beat.structure.slug}: ${beat.name ?? ''}` };
    return { kind: 'scene', title: null };
  }

  const linkOf = (ctx, d, sha256) => {
    const from = text(d.fm.from);
    const to = text(d.fm.to);
    const beats = beatIndex(ctx);
    const fromEnd = endOf(ctx, beats, from);
    const toEnd = endOf(ctx, beats, to);
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      from,
      to,
      relation: text(d.fm.relation),
      rationale: tidy(d.body),
      branch: text(d.fm.branch) || null,
      created: d.fm.created === undefined || d.fm.created === null ? null : String(d.fm.created),
      sha256,
      from_title: fromEnd.title,
      to_title: toEnd.title,
      from_kind: fromEnd.kind,
      to_kind: toEnd.kind,
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

  const relationshipDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'relationship' && d.archived === archived).sort(byRel);

  /** The entry a relationship end names (any entry type): the book's own entries first, then the series' shared ones; live before archived. Unresolved: slug, name and type are null. */
  function entryOf(ctx, id) {
    const none = { id: text(id), slug: null, name: null, type: null };
    if (typeof id !== 'string') return none;
    const own = ctx.docs.filter((d) => d.kind === 'entry' && d.fm.id === id);
    const series = (ctx.shared?.docs ?? []).filter((d) => d.kind === 'entry' && d.fm.id === id);
    const hit = [...own, ...series].sort((a, b) => Number(a.archived) - Number(b.archived))[0];
    return hit ? { id, slug: text(hit.fm.slug), name: text(hit.fm.name), type: text(hit.fm.type) } : none;
  }

  const relationshipName = (a, b) => `${a.name ?? a.slug ?? a.id ?? ''} & ${b.name ?? b.slug ?? b.id ?? ''}`;

  const relationshipOf = (ctx, d, sha256) => {
    const a = entryOf(ctx, d.fm.a);
    const b = entryOf(ctx, d.fm.b);
    const developments = (Array.isArray(d.fm.developments) ? d.fm.developments : []).map((m) => {
      const item = m !== null && typeof m === 'object' && !Array.isArray(m) ? m : {};
      const scene = text(item.scene);
      const live = scene ? ctx.scenes.get(scene) : null;
      return {
        scene,
        scene_title: live ? (live.title ?? null) : null,
        chapter: live && Number.isInteger(live.chapter) ? live.chapter : null,
        sequence: live && Number.isInteger(live.sequence) ? live.sequence : null,
        change: text(item.change) || null,
        a_view: text(item.a_view) || null,
        b_view: text(item.b_view) || null,
      };
    });
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      name: relationshipName(a, b),
      a,
      b,
      baseline: text(d.fm.baseline) || null,
      end_state: text(d.fm.end_state) || null,
      sha256,
      body: tidy(d.body),
      developments,
      problems: ctx.problems.get(d.file) ?? [],
    };
  };

  /** Live relationships sorted by name, then slug. */
  const sortedRelationships = (list) => list.sort((x, y) => { const kx = x.name.toLowerCase(); const ky = y.name.toLowerCase(); return kx < ky ? -1 : kx > ky ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0; });

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
    const beats = beatIndex(ctx);
    // an end resolves when it is a live scene or a beat of a live structure
    const resolves = (id) => Boolean(id) && (ctx.scenes.has(id) || beats.get(id)?.structure.archived === false);
    const edges = live.map((d) => {
      const l = linkOf(ctx, d, sums.get(d.rel) ?? null);
      return { id: l.id, slug: l.slug, from: l.from, to: l.to, relation: l.relation, branch: l.branch, rationale: l.rationale, sha256: l.sha256, broken: !(resolves(l.from) && resolves(l.to)) };
    });
    // a beat is a node only when a live link uses it
    const used = new Set(edges.flatMap((e) => [e.from, e.to]));
    for (const [id, beat] of beats) {
      if (!used.has(id) || beat.structure.archived) continue;
      nodes.push({ id, kind: 'beat', title: beat.name, structure: { slug: beat.structure.slug, name: beat.structure.name }, chapter: null, sequence: null });
    }
    const branches = [...new Set(edges.map((e) => e.branch).filter((b) => b !== null))].sort();
    return { nodes, edges, branches };
  }

  /** The story plan of a loaded book (see getStoryPlan). Only a live file at planning/story.md counts; a story plan anywhere else gets W318 and is ignored here. */
  async function story(ctx) {
    const d = ctx.docs.find((x) => x.kind === 'story-plan' && !x.archived && x.rel === STORY_PATH) ?? null;
    const fields = Object.fromEntries(STORY_FIELDS.map((k) => [k, d && typeof d.fm[k] === 'string' && d.fm[k] !== '' ? d.fm[k] : null]));
    if (!d) return { path: null, sha256: null, fields, body: '' };
    const f = await readFileAt(`${ctx.prefix}${d.rel}`);
    return { path: d.rel, sha256: f ? sha(f.bytes) : null, fields, body: tidy(d.body) };
  }

  // ---- M7: synopses (planning/synopses)
  const synopsisDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'synopsis' && d.archived === archived);
  const typeRank = (t) => { const i = SYNOPSIS_TYPES.indexOf(t); return i < 0 ? SYNOPSIS_TYPES.length : i; };

  /** The records extraction reads, from the validated documents and the scenes' summary lines: { storyPlan, scenes (reading order), primaryStructure }. */
  async function extractionInputs(ctx) {
    const order = ctx.book.order;
    const summaries = await readSceneSummaries(order);
    const scenes = order.map((s, i) => ({ id: s.id, title: s.title ?? null, summary: summaries[i] ?? null, act: Number.isInteger(s.act) ? s.act : null, chapter: Number.isInteger(s.chapter) ? s.chapter : null }));
    const primaryId = primaryIdOf(ctx);
    const primary = primaryId ? structureDocs(ctx, false).find((d) => d.fm.id === primaryId) : null;
    return { storyPlan: await story(ctx), scenes, primaryStructure: primary ? { beats: structureOf(ctx, primary, null, primaryId).beats } : null };
  }

  const synopsisOf = (d, sha256, archived, extracted) => {
    const type = text(d.fm.type);
    const basis = typeof d.fm.basis === 'string' && /^[0-9a-f]{64}$/.test(d.fm.basis) ? d.fm.basis : null;
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      type,
      name: text(d.fm.name) || SYNOPSIS_LABELS[type] || null,
      target_words: Number.isInteger(d.fm.target_words) && d.fm.target_words >= 1 ? d.fm.target_words : null,
      words: countWords(typeof d.body === 'string' ? d.body : ''),
      basis,
      stale: !archived && basis !== null && extracted !== null && basis !== extracted(type),
      sha256,
    };
  };

  /** A function type -> basis of today's extraction (memoised per type). */
  const extractedBasis = (inputs) => {
    const memo = new Map();
    return (type) => {
      if (!memo.has(type)) memo.set(type, basisOf(extractText(type, inputs).text));
      return memo.get(type);
    };
  };

  // ---- M8: clues (planning/clues) and the series plan
  const clueDocs = (ctx, archived) => ctx.docs.filter((d) => d.kind === 'clue' && d.archived === archived).sort(byRel);

  /** A scene as a clue shows it: { id, title, position } (position = 1-based reading-order number; title and position null when the scene is not live). */
  function sceneRef(ctx, id) {
    if (!ctx.positions) ctx.positions = new Map(ctx.book.order.map((/** @type {any} */ s, i) => [s.id, i + 1]));
    const live = ctx.scenes.get(id);
    return { id, title: live ? (live.title ?? null) : null, position: ctx.positions.get(id) ?? null };
  }

  const isMapValue = (m) => m !== null && typeof m === 'object' && !Array.isArray(m);

  const clueOf = (ctx, d, sha256) => {
    const planted = (Array.isArray(d.fm.planted) ? d.fm.planted : []).filter((s) => typeof s === 'string' && s !== '').map((s) => sceneRef(ctx, s));
    const revealed = typeof d.fm.revealed === 'string' && d.fm.revealed !== '' ? sceneRef(ctx, d.fm.revealed) : null;
    const knowers = (Array.isArray(d.fm.knowers) ? d.fm.knowers : []).filter(isMapValue).map((m) => {
      const who = typeof m.who === 'string' ? m.who : '';
      const entry = who === 'reader' ? null : characterOf(ctx, who);
      return {
        who: who === 'reader' ? { id: 'reader', name: null, reader: true } : { id: who, name: entry?.name ?? null, reader: false, shared: entry?.shared === true },
        scene: sceneRef(ctx, typeof m.scene === 'string' ? m.scene : ''),
        how: text(m.how) || null,
        reliable: m.reliable !== false,
      };
    });
    return {
      id: text(d.fm.id),
      slug: text(d.fm.slug) ?? stem(d.rel).split('/').pop(),
      path: d.rel,
      fact: text(d.fm.fact) ?? '',
      kind: CLUE_KINDS.includes(d.fm.kind) ? d.fm.kind : 'clue',
      planted,
      revealed,
      red_herring: d.fm.red_herring === true,
      knowers,
      sha256,
      body: tidy(d.body),
      problems: ctx.problems.get(d.file) ?? [],
    };
  };

  /** Live clues sorted by fact, then slug. */
  const sortedClues = (list) => list.sort((x, y) => { const kx = x.fact.toLowerCase(); const ky = y.fact.toLowerCase(); return kx < ky ? -1 : kx > ky ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0; });

  /** The overview synopsis of a book: the first live synopsis of type one-page, else short, else null. "First" = by name, then slug. */
  function overviewSynopsis(ctx) {
    const live = synopsisDocs(ctx, false);
    for (const type of ['one-page', 'short']) {
      const hit = live.filter((d) => d.fm.type === type).sort((a, b) => {
        const ka = (text(a.fm.name) || SYNOPSIS_LABELS[type]).toLowerCase();
        const kb = (text(b.fm.name) || SYNOPSIS_LABELS[type]).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : byRel(a, b);
      })[0];
      if (hit) return { type, name: text(hit.fm.name) || SYNOPSIS_LABELS[type], body: tidy(hit.body) };
    }
    return null;
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

    /**
     * GET /api/books/:b/relationships: { relationships, archived } (planning/relationships/*.md). Relationship = { id, slug, path, name ("<A name> & <B name>"), a: { id, slug, name, type },
     * b: { id, slug, name, type }, baseline, end_state, sha256, body, developments: [{ scene, scene_title, chapter, sequence, change, a_view, b_view }], problems }. An entry that is not found has null
     * slug, name and type (the id stays); scene_title, chapter and sequence are null when the scene is not live. Live relationships are sorted by name, then slug. archived = [{ slug, name }].
     * Null when there is no such book.
     */
    async listRelationships(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = relationshipDocs(ctx, false);
      const arch = relationshipDocs(ctx, true);
      const sums = await hashes(ctx, live.map((d) => d.rel));
      const relationships = sortedRelationships(live.map((d) => relationshipOf(ctx, d, sums.get(d.rel) ?? null)));
      return { relationships, archived: arch.map((d) => { const r = relationshipOf(ctx, d, null); return { slug: r.slug, name: r.name }; }) };
    },

    /** GET /api/books/:b/relationships/:slug: the live relationship (shape as in listRelationships), else the archived one, with `archived`. Null when there is no such book or relationship. */
    async getRelationship(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/relationships/${slug}.md`;
        const d = relationshipDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        return { ...relationshipOf(ctx, d, f ? sha(f.bytes) : null), archived };
      }
      return null;
    },

    /**
     * GET /api/books/:b/plan-badges: the planner data of every live scene in one read (Board, Outline, Matrix). `{ scenes, arcs, structures }`:
     * scenes[sceneId] = { plan (a live scene plan exists), goal, purpose (from the plan, else null), links_in, links_out (live links whose other end also resolves: a live scene or a beat of a live structure),
     * beats: [{ structure_slug, structure_name, primary, beat_id, beat_name }], milestones: [{ arc_slug, name }] (one per arc milestone set in the scene; name = the character's name),
     * relationships: [{ slug, name, change }] (one per development set in the scene) } for every live scene; arcs = [{ slug, name }] (live arcs, as listArcs sorts them);
     * structures = [{ slug, name, primary, beats: [{ id, name, state, scenes: [sceneId] }] }] (live structures, primary first; scenes = the beat's live scenes). Null when there is no such book.
     */
    async planBadges(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const primaryId = primaryIdOf(ctx);
      const sceneIds = ctx.book.order.map((/** @type {any} */ s) => s.id);
      /** @type {Record<string, any>} */
      const scenes = {};
      for (const id of sceneIds) {
        const plan = planOf(ctx, id);
        const field = (k) => (plan && typeof plan.fm[k] === 'string' && plan.fm[k] !== '' ? plan.fm[k] : null);
        scenes[id] = { plan: plan !== null, goal: field('goal'), purpose: field('purpose'), links_in: 0, links_out: 0, beats: [], milestones: [], relationships: [] };
      }
      const beatIdx = beatIndex(ctx);
      const resolves = (id) => typeof id === 'string' && (ctx.scenes.has(id) || beatIdx.get(id)?.structure.archived === false);
      for (const d of linkDocs(ctx, false)) {
        const from = text(d.fm.from);
        const to = text(d.fm.to);
        if (!from || !to || !resolves(from) || !resolves(to)) continue;
        if (scenes[from]) scenes[from].links_out += 1;
        if (scenes[to]) scenes[to].links_in += 1;
      }
      const structures = structureDocs(ctx, false).map((d) => structureOf(ctx, d, null, primaryId));
      const skey = (s) => (s.name ?? '').toLowerCase();
      structures.sort((a, b) => Number(b.primary) - Number(a.primary) || (skey(a) < skey(b) ? -1 : skey(a) > skey(b) ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      for (const s of structures) {
        for (const b of s.beats) {
          for (const sc of b.scenes) {
            if (scenes[sc.id]) scenes[sc.id].beats.push({ structure_slug: s.slug, structure_name: s.name, primary: s.primary, beat_id: b.id, beat_name: b.name });
          }
        }
      }
      const arcs = arcDocs(ctx, false).map((d) => arcOf(ctx, d, null));
      const akey = (a) => (a.character?.name ?? '').toLowerCase();
      arcs.sort((a, b) => Number(a.character === null) - Number(b.character === null) || (akey(a) < akey(b) ? -1 : akey(a) > akey(b) ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      const arcName = (a) => a.character?.name ?? a.slug;
      for (const a of arcs) {
        for (const m of a.milestones) if (m.scene && scenes[m.scene]) scenes[m.scene].milestones.push({ arc_slug: a.slug, name: arcName(a) });
      }
      const relationships = sortedRelationships(relationshipDocs(ctx, false).map((d) => relationshipOf(ctx, d, null)));
      for (const r of relationships) {
        for (const m of r.developments) if (m.scene && scenes[m.scene]) scenes[m.scene].relationships.push({ slug: r.slug, name: r.name, change: m.change });
      }
      return {
        scenes,
        arcs: arcs.map((a) => ({ slug: a.slug, name: arcName(a) })),
        structures: structures.map((s) => ({ slug: s.slug, name: s.name, primary: s.primary, beats: s.beats.map((b) => ({ id: b.id, name: b.name, state: b.state, scenes: b.scenes.filter((sc) => scenes[sc.id]).map((sc) => sc.id) })) })),
      };
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
     * GET /api/books/:b/flow: nodes are the live scenes in reading order, edges the live links. An edge with an end that is neither a live scene nor a beat of a live structure is still returned, `broken: true`. M5: after the scenes, a node { id, kind: 'beat', title, structure: { slug, name }, chapter: null, sequence: null } for each beat of a live structure that is an end of a live link.
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
     * order (max 50); broken_links = live links with an end that is neither a live scene nor a beat of a live structure; threads = live plot threads; arcs = live arcs; structures = live structures; relationships = live relationships.
     * `primary_structure` is `{ id, slug, name }` of the live structure the story plan names, else null. Null when there is no such book.
     */
    async planOverview(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const flowed = await flow(ctx);
      const { edges } = flowed;
      const nodes = flowed.nodes.filter((n) => n.kind === 'scene'); // beat nodes (M5) are not scenes
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
          relationships: relationshipDocs(ctx, false).length,
        },
        primary_structure: primary ? { id: primaryId, slug: text(primary.fm.slug) ?? stem(primary.rel).split('/').pop(), name: text(primary.fm.name) } : null,
        unlinked: unlinked.slice(0, 50).map((n) => ({ id: n.id, title: n.title })),
      };
    },

    /**
     * GET /api/books/:b/synopses: { synopses, archived } (planning/synopses/*.md, archive/planning/synopses/*.md). Item = { id, slug, path, type, name (the type's label when the file has none), target_words: number | null,
     * words (word count of the body), basis: string | null, stale: boolean, sha256 }. stale = the file has a basis and today's extraction for its type hashes differently (archived items are never stale).
     * Both lists are by type (premise, logline, elevator-pitch, short, one-page, long, chapter-treatment, custom), then name, then slug. Null when there is no such book.
     */
    async listSynopses(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = synopsisDocs(ctx, false);
      const arch = synopsisDocs(ctx, true);
      const sums = await hashes(ctx, [...live, ...arch].map((d) => d.rel));
      const needsExtraction = live.some((d) => typeof d.fm.basis === 'string' && /^[0-9a-f]{64}$/.test(d.fm.basis));
      const extracted = needsExtraction ? extractedBasis(await extractionInputs(ctx)) : null;
      const order = (list) => list.sort((x, y) => typeRank(x.type) - typeRank(y.type) || (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
      return {
        synopses: order(live.map((d) => synopsisOf(d, sums.get(d.rel) ?? null, false, extracted))),
        archived: order(arch.map((d) => synopsisOf(d, sums.get(d.rel) ?? null, true, null))),
      };
    },

    /** GET /api/books/:b/synopses/:slug: the live synopsis, else the archived one: the Item of listSynopses plus `body` (the author's text) and `archived`. Null when there is no such book or synopsis. */
    async getSynopsis(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/synopses/${slug}.md`;
        const d = synopsisDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        const basis = typeof d.fm.basis === 'string' && /^[0-9a-f]{64}$/.test(d.fm.basis) ? d.fm.basis : null;
        const extracted = !archived && basis !== null ? extractedBasis(await extractionInputs(ctx)) : null;
        return { ...synopsisOf(d, f ? sha(f.bytes) : null, archived, extracted), body: tidy(d.body), archived };
      }
      return null;
    },

    /**
     * GET /api/books/:b/clues: { clues, archived } (planning/clues/*.md). Item = { id, slug, path, fact, kind ('clue' | 'reveal' | 'secret'; 'clue' when absent), planted: [{ id, title, position }],
     * revealed: { id, title, position } | null, red_herring: boolean, knowers: [{ who: { id, name: string | null, reader: boolean, shared?: boolean }, scene: { id, title, position }, how: string | null,
     * reliable: boolean (false only when the file says so) }], sha256, body, problems: [{ code, message }] }. position = the scene's reading-order number (1-based), null with a null title for a scene that is not live.
     * who = { id: 'reader', name: null, reader: true } for the reader; for an entry (the book's own, then the series' shared) { id, name (null when not found), reader: false, shared }.
     * Live clues are sorted by fact, then slug. archived = [{ slug, fact }]. Null when there is no such book.
     */
    async listClues(bookId) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const live = clueDocs(ctx, false);
      const arch = clueDocs(ctx, true);
      const sums = await hashes(ctx, live.map((d) => d.rel));
      const clues = sortedClues(live.map((d) => clueOf(ctx, d, sums.get(d.rel) ?? null)));
      return { clues, archived: arch.map((d) => { const c = clueOf(ctx, d, null); return { slug: c.slug, fact: c.fact }; }) };
    },

    /** GET /api/books/:b/clues/:slug: the live clue (the Item of listClues), else the archived one, with `archived`. Null when there is no such book or clue. */
    async getClue(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      for (const archived of [false, true]) {
        const rel = `${archived ? 'archive/' : ''}planning/clues/${slug}.md`;
        const d = clueDocs(ctx, archived).find((x) => x.rel === rel);
        if (!d) continue;
        const f = await readFileAt(`${ctx.prefix}${rel}`);
        return { ...clueOf(ctx, d, f ? sha(f.bytes) : null), archived };
      }
      return null;
    },

    /**
     * GET /api/books/:b/series-plan (read-only, nothing is written): null when there is no such book; `{ series: null }` when the book is not in a series; else
     * { series: { slug, title }, books: [{ id, slug, title, series_number, logline: string | null, premise: string | null, synopsis: { type, name, body } | null,
     * arcs: [{ character: { id, name, shared: true }, start: string | null, end: string | null, milestones: number }] }], characters: [{ id, name, books: [{ id, title, arc_slug }] }] }.
     * books = every book of the series in series_number order (then title); logline / premise come from the book's story plan; synopsis = the first live synopsis of type one-page, else short, else null;
     * arcs = the live arcs of characters that are series-shared entries (start = start_state, end = end_state, milestones = how many are set), by character name;
     * characters = the series-shared entries that have an arc in at least one book, by name, with the books (in book order) and the arc slug. Access filtering is the caller's job.
     */
    async seriesPlan(bookId) {
      const result = await readValidate();
      const own = loadFrom(result, bookId);
      if (!own) return null;
      const series = own.shared?.series ?? null;
      if (!series) return { series: null };
      const inSeries = result.books.filter((/** @type {any} */ b) => b.series === series.slug && typeof b.id === 'string');
      const rows = [];
      for (const b of inSeries) {
        const ctx = loadFrom(result, b.id);
        const bookDoc = ctx.docs.find((d) => d.kind === 'book');
        const plan = await story(ctx);
        const arcs = arcDocs(ctx, false).map((d) => arcOf(ctx, d, null)).filter((a) => a.character?.shared === true);
        arcs.sort((x, y) => { const kx = (x.character.name ?? '').toLowerCase(); const ky = (y.character.name ?? '').toLowerCase(); return kx < ky ? -1 : kx > ky ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0; });
        rows.push({
          id: b.id,
          slug: b.slug ?? null,
          title: b.title ?? null,
          series_number: Number.isInteger(bookDoc?.fm.series_number) ? bookDoc.fm.series_number : null,
          logline: plan.fields.logline,
          premise: plan.fields.premise,
          synopsis: overviewSynopsis(ctx),
          arcs: arcs.map((a) => ({ character: { id: a.character.id, name: a.character.name, shared: true }, start: a.fields.start_state, end: a.fields.end_state, milestones: a.milestones.length })),
          arcSlugs: arcs.map((a) => a.slug),
        });
      }
      const titleKey = (r) => (r.title ?? '').toLowerCase();
      rows.sort((x, y) => { const nx = x.series_number ?? Infinity; const ny = y.series_number ?? Infinity; return nx !== ny ? (nx < ny ? -1 : 1) : titleKey(x) < titleKey(y) ? -1 : titleKey(x) > titleKey(y) ? 1 : 0; });
      const byCharacter = new Map();
      for (const row of rows) {
        row.arcs.forEach((a, i) => {
          if (!byCharacter.has(a.character.id)) byCharacter.set(a.character.id, { id: a.character.id, name: a.character.name, books: [] });
          byCharacter.get(a.character.id).books.push({ id: row.id, title: row.title, arc_slug: row.arcSlugs[i] });
        });
      }
      const characters = [...byCharacter.values()].sort((x, y) => { const kx = (x.name ?? '').toLowerCase(); const ky = (y.name ?? '').toLowerCase(); return kx < ky ? -1 : kx > ky ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
      return {
        series: { slug: series.slug, title: series.title },
        books: rows.map((row) => ({ id: row.id, slug: row.slug, title: row.title, series_number: row.series_number, logline: row.logline, premise: row.premise, synopsis: row.synopsis, arcs: row.arcs })),
        characters,
      };
    },

    /**
     * GET /api/books/:b/synopses/:slug/extract: { text, basis, skipped } for the type of the synopsis (live or archived), built from the story plan, the scene summaries and the primary structure only (no prose, no
     * network, nothing written). basis = sha256 (hex) of text as UTF-8; skipped = scenes without a summary that the type would have used. Null when there is no such book or synopsis.
     */
    async extractSynopsis(bookId, slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
      const ctx = await load(bookId);
      if (!ctx) return null;
      const d = [false, true].map((archived) => synopsisDocs(ctx, archived).find((x) => x.rel === `${archived ? 'archive/' : ''}planning/synopses/${slug}.md`)).find(Boolean);
      if (!d) return null;
      const { text: proposal, skipped } = extractText(text(d.fm.type) ?? '', await extractionInputs(ctx));
      return { text: proposal, basis: basisOf(proposal), skipped };
    },
  };
}
