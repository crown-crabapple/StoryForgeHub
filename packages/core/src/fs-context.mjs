// The chapter context pack, the gathering side (M12 W6): reads what an AI needs before it writes chapter N through the repository's own read methods, then hands it to the pure
// assembleContext (context-pack.mjs), which trims it to the budget. Read-only; nothing here writes a file.
import { assembleContext, normalizeBudget, tailOf } from './context-pack.mjs';

const isMap = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const SUMMARY_MAX = 300;
const WORKSPACE_DOCS = ['workspace/book', 'workspace/style'];

/** One line about a Codex entry: its `summary` field when it has one, else the first paragraph of its text. @param {any} entry */
function summaryOf(entry) {
  const fields = isMap(entry?.fields) ? entry.fields : {};
  const given = text(fields.summary) ?? text(fields.Summary) ?? text(fields.description);
  const para = (entry?.body ?? '').split(/\n\s*\n/).map((/** @type {string} */ p) => p.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim()).find((/** @type {string} */ p) => p !== '');
  const s = given ?? para ?? '';
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : s;
}

/** @param {{ repository: any }} p */
export function createContextMethods({ repository }) {
  return {
    /**
     * GET /api/books/:b/context?chapter=N: the context pack for writing chapter `chapter` (see assembleContext). Null for an unknown book. Sections, in priority order: workspace docs (book, style),
     * the story plan, the chapter's scene plans with their beats, the cast, what each pov / appearing character knows at the end of chapter N-1, open promises / questions / clues planted
     * before N, state events up to N-1, the latest state docs, the tail of the last scene before N, continuity findings that touch chapter N.
     * @param {string} bookId @param {{ chapter: number, budget?: number }} args
     */
    async getContext(bookId, { chapter, budget } = /** @type {any} */ ({})) {
      const book = await repository.getBook(bookId);
      if (!book) return null;
      const n = chapter;
      const prev = n - 1;
      const scenes = (book.acts ?? []).flatMap((/** @type {any} */ a) => (a.chapters ?? []).flatMap((/** @type {any} */ c) => c.scenes.map((/** @type {any} */ s) => ({ ...s, chapter: c.chapter }))));
      const here = scenes.filter((/** @type {any} */ s) => s.chapter === n);

      // 1. workspace docs
      const workspace = [];
      for (const addr of WORKSPACE_DOCS) {
        const d = await repository.getWorkspaceDoc(bookId, addr);
        if (d && d.body.trim() !== '') workspace.push({ path: d.path, title: d.title, body: d.body.replace(/\r\n/g, '\n').trim() });
      }

      // 2. story plan
      const plan = await repository.getStoryPlan(bookId);
      const story = { logline: text(plan?.fields?.logline), premise: text(plan?.fields?.premise), protagonist_goal: text(plan?.fields?.protagonist_goal) };

      // 3. scene plans of the chapter and the beats the scenes sit in
      const structures = (await repository.listStructures(bookId))?.structures ?? [];
      const scene_plans = [];
      /** @type {string[]} */
      const planned = [];
      for (const s of here) {
        const sp = await repository.getScenePlan(bookId, s.id);
        const fields = Object.fromEntries(Object.entries(sp?.fields ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
        const beats = structures.flatMap((/** @type {any} */ st) => st.beats.filter((/** @type {any} */ b) => b.scenes.some((/** @type {any} */ x) => x.id === s.id)).map((/** @type {any} */ b) => ({ structure: st.name, beat: b.name, purpose: b.purpose ?? null, state: b.state ?? 'open' })));
        for (const c of sp?.characters ?? []) planned.push(c);
        if (Object.keys(fields).length === 0 && beats.length === 0 && !text(sp?.body)) continue;
        scene_plans.push({ scene: s.id, title: s.title ?? null, ...(Object.keys(fields).length > 0 ? { plan: fields } : {}), ...(text(sp?.body) ? { notes: text(sp.body) } : {}), beats });
      }

      // 4. cast: the scene casts of chapter N; the plan (the scene plans' characters, then the protagonist) when there are none
      const sceneCast = (await repository.getCast(bookId, { chapter: n })) ?? [];
      /** @type {Map<string, { ref: string, role: string | null }>} */
      const castRefs = new Map();
      const roleRank = { pov: 0, appears: 1, mentioned: 2 };
      for (const sc of sceneCast) {
        for (const m of sc.cast) {
          const ref = m.id ?? m.entry;
          const old = castRefs.get(ref);
          if (!old || (roleRank[/** @type {'pov'} */ (m.role)] ?? 3) < (roleRank[/** @type {'pov'} */ (old.role ?? '')] ?? 3)) castRefs.set(ref, { ref, role: m.role });
        }
      }
      if (castRefs.size === 0) {
        for (const ref of [...planned, ...(plan?.fields?.protagonist ? [plan.fields.protagonist] : [])]) if (!castRefs.has(ref)) castRefs.set(ref, { ref, role: null });
      }
      const cast = [];
      for (const { ref, role } of castRefs.values()) {
        const e = await repository.getEntry(bookId, ref);
        if (!e) continue;
        cast.push({ id: e.id, slug: e.slug ?? null, name: e.name ?? null, type: e.type ?? null, role, summary: summaryOf(e) });
      }

      // 5. what each pov / appearing character knows at the end of chapter N-1
      const knowledge = [];
      if (prev >= 0) {
        for (const c of cast) {
          if (c.role !== null && c.role !== 'pov' && c.role !== 'appears') continue;
          const k = await repository.knowledgeAt(bookId, { character: c.id, at: prev });
          if (k?.ok && k.facts.length > 0) knowledge.push({ character: c.name ?? c.slug ?? c.id, facts: k.facts.map((/** @type {any} */ f) => f.fact) });
        }
      }

      // 6. open promises, questions and clues planted before N
      const ledger = await repository.getLedger(bookId);
      const open_ledger = [];
      for (const kind of ['promise', 'question']) {
        for (const t of ledger?.[`${kind}s`] ?? []) {
          if (t.open && t.setup_chapters.some((/** @type {number} */ c) => c < n)) open_ledger.push({ kind, title: t.title, status: t.status, planted_in_chapters: t.setup_chapters });
        }
      }
      for (const c of ledger?.clues ?? []) {
        if (c.status === 'planted' && c.planted_chapters.some((/** @type {number} */ x) => x < n)) open_ledger.push({ kind: 'clue', title: c.fact, status: c.status, planted_in_chapters: c.planted_chapters });
      }

      // 7. state events up to N-1 (events with no chapter are "before the story" and come first)
      const state_events = ((await repository.getStateEvents(bookId)) ?? [])
        .filter((/** @type {any} */ ev) => ev.chapter === null || ev.chapter <= prev)
        .map((/** @type {any} */ ev) => ({ chapter: ev.chapter, subject: ev.subject.name ?? ev.subject.slug ?? ev.subject.id, kind: ev.kind, ...(ev.value !== undefined ? { value: ev.value } : {}) }));

      // 8. the latest state docs: state/chapter-(N-1), or the newest chapter before it that has some
      const state_docs = [];
      const docs = ((await repository.listWorkspaceDocs(bookId))?.docs ?? []).filter((/** @type {any} */ d) => d.workspace === 'state' && Number.isInteger(d.chapter) && d.chapter <= prev);
      const latest = docs.reduce((m, d) => Math.max(m, d.chapter), -1);
      for (const d of docs.filter((/** @type {any} */ x) => x.chapter === latest)) {
        const full = await repository.getWorkspaceDoc(bookId, d.path);
        if (full && full.body.trim() !== '') state_docs.push({ path: full.path, title: full.title, body: full.body.replace(/\r\n/g, '\n').trim() });
      }

      // 9. the tail of the last scene before chapter N
      const before = scenes.filter((/** @type {any} */ s) => s.chapter < n);
      const last = before.length > 0 ? before[before.length - 1] : null;
      const lastScene = last ? await repository.getScene(bookId, last.id) : null;
      const previous_tail = lastScene ? tailOf(lastScene.body ?? '') : null;

      // 10. continuity findings that touch chapter N (their subject or a related id is a scene of it, or a source is its file)
      const sceneIds = new Set(here.map((/** @type {any} */ s) => s.id));
      const scenePaths = here.map((/** @type {any} */ s) => s.path);
      const continuity = [];
      const found = await repository.getContinuity(bookId);
      for (const f of found?.findings ?? []) {
        const touches = sceneIds.has(f.subject?.id) || (f.related ?? []).some((/** @type {string} */ id) => sceneIds.has(id)) || (f.sources ?? []).some((/** @type {any} */ src) => typeof src?.file === 'string' && scenePaths.some((/** @type {string} */ p) => p === src.file || p.endsWith(`/${src.file}`) || src.file.endsWith(`/${p}`)));
        if (touches) continuity.push({ rule: f.rule, severity: f.severity, title: f.title, message: f.message });
      }

      return assembleContext({ chapter: n, budget: normalizeBudget(budget), workspace, story, scene_plans, cast, knowledge, open_ledger, state_events, state_docs, previous_tail, continuity });
    },
  };
}
