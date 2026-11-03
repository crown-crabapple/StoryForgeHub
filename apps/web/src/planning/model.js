// What the Board, Outline, Threads and Matrix views show, worked out from two API answers. Pure: no DOM, no fetch.
//
// `book` is GET /api/books/:id: { acts: [{ act, label, title?, chapters: [{ chapter, label, title?, scenes: [{ id, title, status, pov, word_count, path, ... }] }] }] }.
// `planning` is GET /api/books/:id/threads:
//   { threads: [{ id, slug, title, kind, status, setup: [sceneId], develop: [sceneId], payoff: [sceneId], characters: [ref], path, sha256, problems }],
//     scenes: [{ id, summary, plot_threads: [threadId], sha256, ... }] }
// Everything here comes from files; nothing is stored anywhere else.
import { chapterName, actName } from '../structure/helpers.js';

/** The six current thread states, in the order of a thread's life. */
export const THREAD_STATES = ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved'];
/** Legacy states stay valid and are shown when a thread has one. */
export const LEGACY_STATES = ['open', 'abandoned'];
export const THREAD_KINDS = ['promise', 'question', 'mystery', 'subplot', 'arc'];

const STATE_LABELS = { planned: 'Planned', planted: 'Planted', developed: 'Developed', paid: 'Paid', dropped: 'Dropped', unresolved: 'Unresolved', open: 'Open (legacy)', abandoned: 'Abandoned (legacy)' };

/** The text of a state chip. @param {string | null | undefined} state */
export const stateLabel = (state) => (state && STATE_LABELS[state]) || (state ? state : 'No state');

/** The states a thread's select offers: the six, plus its own legacy state when it has one. @param {string | null | undefined} current */
export const stateOptions = (current) => (current && LEGACY_STATES.includes(current) ? [...THREAD_STATES, current] : [...THREAD_STATES]);

/** The three scene lists of a thread: S = setup, D = development (`develop`), P = payoff. */
export const ROLES = [
  { key: 'S', list: 'setup', label: 'setup', verb: 'Mark as setup' },
  { key: 'D', list: 'develop', label: 'development', verb: 'Mark as development' },
  { key: 'P', list: 'payoff', label: 'payoff', verb: 'Mark as payoff' },
];

/** "Ch 3", or "Prologue" for chapter 0. @param {number} n */
export const chapterShort = (n) => (n === 0 ? 'Prologue' : `Ch ${n}`);

/** The scene's text in the manuscript. @param {string} bookId @param {string} sceneId */
export const sceneHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}`;

// ---------------------------------------------------------------- views and URLs

export const VIEWS = [
  { key: 'write', label: 'Write' },
  { key: 'board', label: 'Board' },
  { key: 'outline', label: 'Outline' },
  { key: 'threads', label: 'Threads' },
];

/**
 * The view of the Manuscript tab from the query string: ?view=board|outline|threads (anything else is Write); on Threads `show=matrix`
 * opens the scene-by-thread matrix and `thread=` selects a thread of the list.
 * @param {string} [search]
 * @returns {{ view: 'write' | 'board' | 'outline' | 'threads', mode: 'list' | 'matrix', thread: string | null }}
 */
export function parseView(search = '') {
  const p = new URLSearchParams(search);
  const v = p.get('view');
  const view = v === 'board' || v === 'outline' || v === 'threads' ? v : 'write';
  return { view, mode: view === 'threads' && p.get('show') === 'matrix' ? 'matrix' : 'list', thread: view === 'threads' && p.get('thread') ? p.get('thread') : null };
}

/**
 * The URL of a view. Write keeps the open scene (`scene`) in the URL; Threads takes `mode` ('matrix') and `thread`.
 * @param {string} bookId @param {string} view @param {{ scene?: string | null, mode?: string, thread?: string | null }} [opts]
 */
export function viewHref(bookId, view, { scene = null, mode = 'list', thread = null } = {}) {
  const p = new URLSearchParams();
  if (view === 'board' || view === 'outline' || view === 'threads') p.set('view', view);
  if (view === 'threads' && mode === 'matrix') p.set('show', 'matrix');
  if (view === 'threads' && mode !== 'matrix' && thread) p.set('thread', thread);
  if (view === 'write' && scene) p.set('scene', scene);
  const qs = p.toString();
  return `/books/${encodeURIComponent(bookId)}${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------- the model

/**
 * Join the book's structure with the planning answer.
 * @param {any} book @param {{ threads?: any[], scenes?: any[] } | null | undefined} planning
 * @returns {{
 *   book: any,
 *   acts: { act: number, label: string, title: string | null, name: string, chapters: Chapter[] }[],
 *   chapters: Chapter[], scenes: Card[], threads: ThreadRow[], sceneById: Map<string, Card>, threadById: Map<string, ThreadRow>, povs: string[],
 * }}
 * @typedef {{ act: number, chapter: number, label: string, title: string | null, name: string, scenes: Card[], words: number }} Chapter
 * @typedef {{ thread_id: string, title: string, slug: string | null, state: string | null, roles: ('S' | 'D' | 'P')[], own: boolean }} Tag
 * @typedef {{ id: string, title: string, summary: string, status: string | null, pov: string | null, word_count: number, path: string, act: number, chapter: number,
 *   chapterName: string, index: number, tags: Tag[], sha256: string | null }} Card
 * @typedef {{ id: string, slug: string | null, title: string, kind: string | null, status: string | null, setup: string[], develop: string[], payoff: string[], characters: string[],
 *   path: string, sha256: string | null, problems: any[], counts: { S: number, D: number, P: number }, firstSetup: number | null,
 *   lastTouched: { chapter: number, label: string, sceneId: string } | null, suggestions: { to: string, label: string }[] }} ThreadRow
 */
export function buildModel(book, planning) {
  const planned = new Map((planning?.scenes ?? []).map((s) => [s.id, s]));
  const rawThreads = [...(planning?.threads ?? [])];
  const flat = (book?.acts ?? []).flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => ({ s, a, c }))));
  const index = new Map(flat.map(({ s }, i) => [s.id, i]));

  const threads = rawThreads.map((t) => {
    const sorted = (ids) => ids.filter((id) => index.has(id)).sort((x, y) => index.get(x) - index.get(y));
    const touched = [...new Set([...t.setup, ...t.develop, ...t.payoff])].filter((id) => index.has(id)).sort((x, y) => index.get(x) - index.get(y));
    const setup = sorted(t.setup ?? []);
    const develop = sorted(t.develop ?? []);
    const payoff = sorted(t.payoff ?? []);
    const last = touched[touched.length - 1] ?? null;
    const lastScene = last ? flat[index.get(last)] : null;
    const row = {
      ...t,
      title: t.title ?? t.slug ?? t.id,
      setup,
      develop,
      payoff,
      characters: t.characters ?? [],
      counts: { S: setup.length, D: develop.length, P: payoff.length },
      firstSetup: setup.length > 0 ? index.get(setup[0]) : null,
      lastTouched: lastScene ? { chapter: lastScene.s.chapter, label: chapterShort(lastScene.s.chapter), sceneId: last } : null,
      suggestions: [],
    };
    row.suggestions = lifecycleSuggestions(row);
    return row;
  });
  const threadById = new Map(threads.map((t) => [t.id, t]));

  const tagsOf = (sceneId) => {
    const own = new Set(planned.get(sceneId)?.plot_threads ?? []);
    /** @type {Tag[]} */
    const tags = [];
    for (const t of threads) {
      const roles = ROLES.filter((r) => t[r.list].includes(sceneId)).map((r) => r.key);
      if (roles.length === 0 && !own.has(t.id)) continue;
      tags.push({ thread_id: t.id, title: t.title, slug: t.slug, state: t.status, roles: /** @type {any} */ (roles), own: own.has(t.id) });
    }
    return tags;
  };

  /** @type {Card[]} */
  const scenes = [];
  const acts = (book?.acts ?? []).map((a) => ({
    act: a.act,
    label: a.label,
    title: a.title ?? null,
    name: actName(a),
    chapters: a.chapters.map((c) => {
      const cards = c.scenes.map((s) => {
        const p = planned.get(s.id);
        /** @type {Card} */
        const card = {
          id: s.id,
          title: s.title ?? '',
          summary: typeof p?.summary === 'string' ? p.summary : '',
          status: s.status ?? null,
          pov: s.pov ?? null,
          word_count: s.word_count ?? 0,
          path: s.path,
          act: a.act,
          chapter: c.chapter,
          chapterName: chapterName(c),
          index: index.get(s.id) ?? 0,
          tags: tagsOf(s.id),
          sha256: p?.sha256 ?? null,
          labels: Array.isArray(p?.labels) ? p.labels : [],
        };
        scenes.push(card);
        return card;
      });
      return { act: a.act, chapter: c.chapter, label: c.label, title: c.title ?? null, name: chapterName(c), scenes: cards, words: cards.reduce((n, s) => n + s.word_count, 0) };
    }),
  }));
  return {
    book,
    acts,
    chapters: acts.flatMap((a) => a.chapters),
    scenes,
    threads,
    sceneById: new Map(scenes.map((s) => [s.id, s])),
    threadById,
    povs: [...new Set(scenes.map((s) => s.pov).filter((p) => typeof p === 'string' && p !== ''))].sort(),
    labelDefs: planning?.labels ?? [],
  };
}

// ---------------------------------------------------------------- threads

/**
 * Suggestions, never automatic: a planned thread whose setup has a scene -> "Mark as planted"; a planted thread with develop scenes ->
 * "Mark as developed"; any thread that is not paid yet and has a payoff scene -> "Mark as paid".
 * @param {{ status: string | null, setup: string[], develop: string[], payoff: string[] }} t
 * @returns {{ to: string, label: string }[]}
 */
export function lifecycleSuggestions(t) {
  const out = [];
  if (t.status === 'planned' && t.setup.length > 0) out.push({ to: 'planted', label: 'Mark as planted' });
  if (t.status === 'planted' && t.develop.length > 0) out.push({ to: 'developed', label: 'Mark as developed' });
  if (t.status !== 'paid' && t.payoff.length > 0) out.push({ to: 'paid', label: 'Mark as paid' });
  return out;
}

/** The S / D / P roles a scene has in a thread's lists, in that order. @param {{ setup: string[], develop: string[], payoff: string[] }} thread @param {string} sceneId */
export const rolesOf = (thread, sceneId) => ROLES.filter((r) => thread[r.list].includes(sceneId)).map((r) => r.key);

/**
 * What a matrix cell shows: the roles from the thread's lists ("S", "S D", "P"), or a dot when the scene names the thread only in its own
 * `plot_threads`, or nothing. @returns {{ roles: string[], dot: boolean }}
 */
export function matrixCell(model, thread, sceneId) {
  const roles = rolesOf(thread, sceneId);
  const own = Boolean(model.sceneById.get(sceneId)?.tags.some((t) => t.thread_id === thread.id && t.own));
  return { roles, dot: roles.length === 0 && own };
}

/**
 * The thread list: filtered by state ('all' or a state), sorted by the book position of the first setup scene (threads without setup last,
 * by title). @param {ThreadRow[]} threads @param {{ state?: string }} [opts]
 */
export function visibleThreads(threads, { state = 'all' } = {}) {
  const list = state === 'all' ? [...threads] : threads.filter((t) => t.status === state);
  return list.sort((a, b) => {
    const x = a.firstSetup ?? Infinity;
    const y = b.firstSetup ?? Infinity;
    return x === y ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : x - y;
  });
}

// ---------------------------------------------------------------- outline

/**
 * The outline rows left after the filters, by act and chapter: [{ act, chapters: [{ chapter, scenes, words }] }]. A chapter with no row left is dropped
 * while a filter is on. `filters`: { status, pov, thread, label } ('' or 'all' = no filter).
 * @param {ReturnType<typeof buildModel>} model @param {{ status?: string, pov?: string, thread?: string }} [filters]
 */
export function outlineRows(model, { status = '', pov = '', thread = '', label = '' } = {}) {
  const on = (v) => v !== '' && v !== 'all' && v != null;
  const filtering = on(status) || on(pov) || on(thread) || on(label);
  const keep = (s) => (!on(status) || s.status === status) && (!on(pov) || s.pov === pov) && (!on(thread) || s.tags.some((t) => t.thread_id === thread)) && (!on(label) || s.labels.some((l) => l.toLowerCase() === label.toLowerCase()));
  return model.acts
    .map((a) => ({
      act: a,
      chapters: a.chapters
        .map((c) => {
          const scenes = c.scenes.filter(keep);
          return { chapter: c, scenes, words: scenes.reduce((n, s) => n + s.word_count, 0) };
        })
        .filter((c) => !filtering || c.scenes.length > 0),
    }))
    .filter((a) => !filtering || a.chapters.length > 0);
}

// ---------------------------------------------------------------- board keyboard

/**
 * The target of Alt+Left / Alt+Right on a card: the end of the previous / next chapter of the book (an empty one too, another act too). The same
 * { chapter, act, after, text } the move route takes (`after` = the last scene already there).
 * @param {any} book @param {string} sceneId @param {'left' | 'right'} direction
 * @returns {{ chapter: number, act: number, after: string | null, text: string } | null} null at the first / last chapter or for an unknown scene
 */
export function chapterShiftTarget(book, sceneId, direction) {
  const chapters = (book?.acts ?? []).flatMap((a) => a.chapters.map((c) => ({ act: a.act, chapter: c.chapter, label: c.label, title: c.title ?? null, scenes: c.scenes })));
  const here = chapters.findIndex((c) => c.scenes.some((s) => s.id === sceneId));
  if (here < 0) return null;
  const to = chapters[here + (direction === 'left' ? -1 : 1)];
  if (!to) return null;
  const mover = chapters[here].scenes.find((s) => s.id === sceneId);
  const last = to.scenes[to.scenes.length - 1] ?? null;
  const name = mover?.title || 'Untitled scene';
  const where = to.title ? `${to.label}: ${to.title}` : to.label;
  return { chapter: to.chapter, act: to.act, after: last ? last.id : null, text: `Move ${name} to the end of ${where}` };
}
