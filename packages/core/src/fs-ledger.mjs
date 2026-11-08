// AI workspace ledgers (M12 W3), the read side and the thin write wrappers: the promises / questions ledger (threads of kind promise or question, plus the planner's clues),
// the chapter cast (a scene's `cast` list), what a character knows by a chapter and the state events (both from the `state` items of timeline events), and the AI
// words of the writing log. Reads come from the files through validate(); writes go through the manuscript commands (setSceneCast, recordEventState), which keep the
// store's guarantees (dry run, no new errors, Undo). Nothing here writes scene prose.
import { extractDocs } from '@storyforge/format';
import { slugify } from '@storyforge/manuscript';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const STATE_KINDS = ['died', 'revived', 'destroyed', 'lost', 'found', 'holder', 'location'];
const CLOSED = ['paid', 'dropped', 'abandoned'];
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f]`);

/**
 * @param {{ repository: any, readValidate: () => Promise<any>, activity: ReturnType<typeof import('./activity.mjs').createActivity> }} p
 */
export function createLedgerMethods({ repository, readValidate, activity }) {
  /** The book, its live documents and the chapter of every scene; null for an unknown book. */
  async function load(bookId) {
    if (typeof bookId !== 'string') return null;
    const result = await readValidate();
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    const docs = extractDocs(result, book.path).filter((d) => !d.archived);
    const chapterOf = new Map(book.order.map((/** @type {any} */ s) => [s.id, s.chapter]));
    return { book, docs, chapterOf };
  }
  const entryOf = (docs, ref) => docs.find((d) => d.kind === 'entry' && typeof d.fm.id === 'string' && (d.fm.id === ref || d.fm.slug === ref)) ?? null;
  const entryOut = (d) => ({ id: d.fm.id, slug: typeof d.fm.slug === 'string' ? d.fm.slug : null, name: typeof d.fm.name === 'string' ? d.fm.name : null });

  /** The chapters of some scene ids (unknown ids left out), without repeats, in order. */
  const chaptersOf = (chapterOf, ids) => [...new Set(ids.map((id) => chapterOf.get(id)).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);

  /**
   * Every state item of the book's live events, in book order: [{ event, event_id, chapter, order, entry (the doc or null), raw: { slug, event, value? } }].
   * The chapter of an event is the chapter of its first scene that resolves; else the number in a "Chapter N" title or chapter-N slug; else null (an event with order <= 0
   * and no chapter is "before the story"). Items come in chapter order, then event order, then the order they are written.
   */
  function stateItems({ docs, chapterOf }) {
    const out = [];
    for (const d of docs) {
      if (d.kind !== 'event' || !Array.isArray(d.fm.state)) continue;
      let chapter = null;
      for (const id of strs(d.fm.scenes)) {
        if (chapterOf.has(id)) {
          chapter = chapterOf.get(id);
          break;
        }
      }
      if (chapter === null) {
        const m = /^Chapter (\d+)\b/.exec(String(d.fm.title ?? '')) ?? /(?:^|-)chapter-(\d+)(?:-|$)/.exec(String(d.fm.slug ?? ''));
        if (m) chapter = Number(m[1]);
      }
      const order = typeof d.fm.order === 'number' ? d.fm.order : 0;
      const rank = chapter !== null ? chapter : order <= 0 ? -1 : Infinity;
      d.fm.state.forEach((raw, i) => {
        if (!isMap(raw) || typeof raw.slug !== 'string' || typeof raw.event !== 'string') return;
        out.push({ event: typeof d.fm.slug === 'string' ? d.fm.slug : null, event_id: d.fm.id, chapter, rank, order, index: i, entry: entryOf(docs, raw.slug), raw });
      });
    }
    return out.sort((a, b) => a.rank - b.rank || a.order - b.order || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0) || a.index - b.index);
  }

  const reads = {
    /**
     * The promises / questions ledger: { promises, questions, clues, counts }. A promise or question is a thread of that kind: { id, slug, title, kind, status, open, setup, develop, payoff
     * (scene ids), setup_chapters, develop_chapters, payoff_chapters, characters, sha256 }; `open` is false for paid and dropped ones. A clue: { id, slug, fact, kind, status
     * (planned | planted | revealed), planted (scene ids), planted_chapters, revealed (scene id or null), revealed_chapter, red_herring, sha256 }. Null for an unknown book.
     * @param {string} bookId
     */
    async getLedger(bookId) {
      const planning = await repository.listThreads(bookId);
      if (!planning) return null;
      const chapterOf = new Map(planning.scenes.map((/** @type {any} */ s) => [s.id, s.chapter]));
      const thread = (/** @type {any} */ t) => ({
        id: t.id, slug: t.slug, title: t.title, kind: t.kind, status: t.status, open: !CLOSED.includes(t.status),
        setup: t.setup, develop: t.develop, payoff: t.payoff,
        setup_chapters: chaptersOf(chapterOf, t.setup), develop_chapters: chaptersOf(chapterOf, t.develop), payoff_chapters: chaptersOf(chapterOf, t.payoff),
        characters: t.characters, sha256: t.sha256,
      });
      const promises = planning.threads.filter((/** @type {any} */ t) => t.kind === 'promise').map(thread);
      const questions = planning.threads.filter((/** @type {any} */ t) => t.kind === 'question').map(thread);
      const planned = typeof repository.listClues === 'function' ? await repository.listClues(bookId) : null;
      const clues = (planned?.clues ?? []).map((/** @type {any} */ c) => {
        const planted = (c.planted ?? []).map((/** @type {any} */ p) => p.id);
        const revealed = c.revealed?.id ?? null;
        return {
          id: c.id, slug: c.slug, fact: c.fact, kind: c.kind, status: revealed ? 'revealed' : planted.length > 0 ? 'planted' : 'planned',
          planted, planted_chapters: chaptersOf(chapterOf, planted), revealed, revealed_chapter: revealed ? (chapterOf.get(revealed) ?? null) : null,
          red_herring: Boolean(c.red_herring), sha256: c.sha256 ?? null,
        };
      });
      const open = (/** @type {any[]} */ l) => l.filter((x) => x.open).length;
      return { promises, questions, clues, counts: { promises: promises.length, open_promises: open(promises), questions: questions.length, open_questions: open(questions), clues: clues.length } };
    },

    /**
     * The chapter cast, per scene in book order (one chapter with `chapter`): [{ scene, title, chapter, cast: [{ entry (as written), id, slug, name, role }] }]; an entry that
     * does not resolve has id null. Null for an unknown book.
     * @param {string} bookId @param {{ chapter?: number }} [opts]
     */
    async getCast(bookId, { chapter } = {}) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      const sceneDocs = new Map(ctx.docs.filter((d) => d.kind === 'scene' && typeof d.fm.id === 'string').map((d) => [d.fm.id, d]));
      return ctx.book.order
        .filter((/** @type {any} */ s) => chapter === undefined || s.chapter === chapter)
        .map((/** @type {any} */ s) => {
          const fm = sceneDocs.get(s.id)?.fm ?? {};
          const cast = (Array.isArray(fm.cast) ? fm.cast : []).filter((m) => isMap(m) && typeof m.entry === 'string').map((m) => {
            const e = entryOf(ctx.docs, m.entry);
            return { entry: m.entry, id: e ? e.fm.id : null, slug: e && typeof e.fm.slug === 'string' ? e.fm.slug : null, name: e && typeof e.fm.name === 'string' ? e.fm.name : null, role: typeof m.role === 'string' ? m.role : null };
          });
          return { scene: s.id, title: s.title ?? null, chapter: s.chapter, cast };
        });
    },

    /**
     * The facts a character knows by the end of chapter `at` (all of them without `at`), from the `knows` / `learns` items of the timeline events in book order:
     * { ok, character: { id, slug, name }, at, facts: [{ fact (the key), text (the full wording; the key for an older item), how: 'knows' | 'learns', chapter, event, event_id }] } (the first item that gives each fact).
     * NOT_FOUND for an unknown book or a character that is no entry of it.
     * @param {string} bookId @param {{ character: string, at?: number }} args
     */
    async knowledgeAt(bookId, { character, at } = {}) {
      if (typeof character !== 'string' || character === '') return fail('BAD_ARGS', { message: 'character must be an entry id or slug' });
      if (at !== undefined && (!Number.isInteger(at) || at < 0)) return fail('BAD_ARGS', { message: 'at must be a chapter number' });
      const ctx = await load(bookId);
      const who = ctx ? entryOf(ctx.docs, character) : null;
      if (!ctx || !who) return fail('NOT_FOUND');
      const facts = [];
      const seen = new Set();
      for (const it of stateItems(ctx)) {
        if (it.entry !== who || (it.raw.event !== 'knows' && it.raw.event !== 'learns') || typeof it.raw.value !== 'string') continue;
        if (at !== undefined && it.rank > at) continue;
        if (seen.has(it.raw.value)) continue;
        seen.add(it.raw.value);
        facts.push({ fact: it.raw.value, text: typeof it.raw.fact === 'string' && it.raw.fact.trim() !== '' ? it.raw.fact : it.raw.value, how: it.raw.event, chapter: it.chapter ?? (it.rank === -1 ? 0 : null), event: it.event, event_id: it.event_id });
      }
      return { ok: true, code: 'OK', character: entryOut(who), at: at ?? null, facts };
    },

    /**
     * The state events (died, revived, destroyed, lost, found, holder, location) of the book in book order, or of one `chapter`:
     * [{ event, event_id, chapter, subject: { id, slug, name }, kind, value? }]. Null for an unknown book.
     * @param {string} bookId @param {{ chapter?: number }} [opts]
     */
    async getStateEvents(bookId, { chapter } = {}) {
      const ctx = await load(bookId);
      if (!ctx) return null;
      return stateItems(ctx)
        .filter((it) => STATE_KINDS.includes(it.raw.event) && (chapter === undefined || it.chapter === chapter))
        .map((it) => ({
          event: it.event, event_id: it.event_id, chapter: it.chapter,
          subject: it.entry ? entryOut(it.entry) : { id: null, slug: it.raw.slug, name: null },
          kind: it.raw.event, ...(typeof it.raw.value === 'string' ? { value: it.raw.value } : {}),
        }));
    },
  };

  const writes = {
    /**
     * Record that a character learns a fact in a chapter: a `learns` item on the chapter's "Chapter N (state)" event. `fact` is the text of the fact; its key (what the item
     * stores, and what knowledgeAt returns) is the slug of it (up to 60 characters); the item also keeps the full wording as `fact` (knowledgeAt returns it as `text`).
     * @param {string} bookId @param {{ character: string, fact: string, chapter: number, dryRun?: boolean }} args
     */
    async recordKnowledge(bookId, { character, fact, chapter, dryRun } = {}) {
      if (typeof character !== 'string' || character.trim() === '') return fail('BAD_ARGS', { message: 'character must be an entry id or slug' });
      if (typeof fact !== 'string' || fact.trim() === '' || fact.length > 300 || CONTROL_RE.test(fact)) return fail('BAD_ARGS', { message: 'fact must be one line of text (up to 300 characters)' });
      const key = slugify(fact).slice(0, 60).replace(/-+$/g, '');
      if (key === '') return fail('BAD_ARGS', { message: 'the fact has no letters or digits to make a key from' });
      const r = await repository.recordEventState(bookId, { chapter, items: [{ slug: character, event: 'learns', value: key, fact: fact.trim() }], allowKnowledge: true, ...(dryRun === true ? { dryRun: true } : {}) });
      return r.ok ? { ...r, character, fact: key, text: fact.trim() } : r;
    },

    /**
     * Record state events on a chapter's "Chapter N (state)" event. Items: { subject | slug: entry slug or id, kind | event: died | revived | destroyed | lost | found | holder | location, value? }.
     * @param {string} bookId @param {{ chapter: number, items: any[], dryRun?: boolean }} args
     */
    async recordStateEvents(bookId, { chapter, items, dryRun } = {}) {
      if (!Array.isArray(items)) return fail('BAD_ARGS', { message: 'items must be a list of { subject, kind, value? }' });
      const mapped = items.map((it) => (isMap(it) ? { slug: it.slug ?? it.subject, event: it.event ?? it.kind, ...(it.value !== undefined ? { value: it.value } : {}) } : it));
      return repository.recordEventState(bookId, { chapter, items: mapped, ...(dryRun === true ? { dryRun: true } : {}) });
    },

    /**
     * Add words an AI wrote to today's AI words in the writing log (written to activity/writing-log.md at once). `chapter` and `note` are checked and echoed, not stored.
     * @param {string} bookId @param {{ words: number, chapter?: number, note?: string }} args
     */
    async recordAiWords(bookId, { words, chapter, note } = {}) {
      if (!Number.isInteger(words) || words < 1 || words > 1_000_000) return fail('BAD_ARGS', { message: 'words must be a whole number from 1 to 1000000' });
      if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 0)) return fail('BAD_ARGS', { message: 'chapter must be a chapter number' });
      if (note !== undefined && (typeof note !== 'string' || note.length > 500 || CONTROL_RE.test(note))) return fail('BAD_ARGS', { message: 'note must be one line of text (up to 500 characters)' });
      const ctx = await load(bookId);
      if (!ctx) return fail('NOT_FOUND');
      activity.recordAi(ctx.book.path, words);
      await activity.flush();
      const day = await activity.read(ctx.book.path, { days: 1 });
      return { ok: true, code: 'OK', words, ...(chapter !== undefined ? { chapter } : {}), ...(note !== undefined ? { note } : {}), today: day.today, totals: day.totals };
    },
  };

  return { ...reads, ...writes };
}
