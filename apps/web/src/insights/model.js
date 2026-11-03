// What the Insights page shows, worked out from GET /api/books/:b/insights. Pure: no DOM, no fetch.
// Every chart has a table form made here too, so "Show as table" and the picture always say the same thing.
import { codexHref } from '../codex/model.js';
import { viewHref } from '../planning/model.js';
import { timelineHref } from '../timeline/model.js';

const enc = encodeURIComponent;

/** GET: the numbers. @param {string} bookId */
export const insightsUrl = (bookId) => `/api/books/${enc(bookId)}/insights`;
/** GET: the goals file as the app reads it. @param {string} bookId */
export const goalsUrl = (bookId) => `/api/books/${enc(bookId)}/goals`;
/** /books/:id/insights @param {string} bookId */
export const insightsHref = (bookId) => `/books/${enc(bookId)}/insights`;
/** /books/:id/tasks with the optional ?status= filter or ?task= selection. @param {string} bookId @param {{ status?: string | null, task?: string | null }} [q] */
export function tasksHref(bookId, { status = null, task = null } = {}) {
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (task) p.set('task', task);
  const qs = p.toString();
  return `/books/${enc(bookId)}/tasks${qs ? `?${qs}` : ''}`;
}
/** The manuscript at a scene. @param {string} bookId @param {string} sceneId */
export const sceneHref = (bookId, sceneId) => `/books/${enc(bookId)}?scene=${enc(sceneId)}`;
/** The Outline with its status filter set: a status bar's source. @param {string} bookId @param {string} status */
export const outlineStatusHref = (bookId, status) => `${viewHref(bookId, 'outline')}&status=${enc(status)}`;
/** The Outline (a chapter bar's source: the whole outline, scenes grouped by chapter). @param {string} bookId */
export const outlineHref = (bookId) => viewHref(bookId, 'outline');
export { codexHref, timelineHref };
/** The threads list with one thread selected. @param {string} bookId @param {string} threadId */
export const threadHref = (bookId, threadId) => viewHref(bookId, 'threads', { thread: threadId });

// ---------------------------------------------------------------- words

/** 12,345 @param {number} n */
export const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
/** "Ch 3" or "Prologue" @param {{ chapter: number, label?: string | null }} c */
export const chapterShort = (c) => (c.chapter === 0 ? 'Prologue' : `Ch ${c.chapter}`);
/** The chapter as the manuscript names it: its label (and title). @param {{ chapter: number, label?: string | null, title?: string | null }} c */
export const chapterName = (c) => (c.title ? `${c.label ?? chapterShort(c)}: ${c.title}` : (c.label ?? chapterShort(c)));

// ---------------------------------------------------------------- goals

const KIND = { words: ['word', 'words'], scenes: ['scene', 'scenes'], chapters: ['chapter', 'chapters'], minutes: ['minute', 'minutes'] };
const PERIOD = { day: 'a day', week: 'a week', month: 'a month', total: 'in total' };
const TODAY = { day: 'today', week: 'this week', month: 'this month', total: 'so far' };

/** "500 words a day", "90,000 words in total, due 2027-03-01" @param {{ kind: string, target: number, period: string, due?: string | null }} g */
export function goalTitle(g) {
  const [one, many] = KIND[g.kind] ?? [g.kind, g.kind];
  return `${fmt(g.target)} ${g.target === 1 ? one : many} ${PERIOD[g.period] ?? g.period}${g.due ? `, due ${g.due}` : ''}`;
}

/** "412 of 500 words today" @param {{ kind: string, target: number, period: string, value: number }} g */
export function goalProgressText(g) {
  const [, many] = KIND[g.kind] ?? [g.kind, g.kind];
  return `${fmt(g.value)} of ${fmt(g.target)} ${many} ${TODAY[g.period] ?? ''}`.trim();
}

/** "3 days" streak text, or '' for none. @param {number} n */
export const streakText = (n) => (n > 0 ? plural(n, 'day') : '');

/** The projected finish of a total goal with a due date, in words. @param {{ projected_finish: string | null, on_track: boolean | null, reached: boolean, due?: string | null }} g */
export function projectionText(g) {
  if (g.reached) return 'Reached.';
  if (!g.due) return '';
  if (!g.projected_finish) return 'No projected finish yet: there is no recent writing to project from.';
  return `At your pace of the last 30 days: ${g.projected_finish}, ${g.on_track ? 'before' : 'after'} the due date.`;
}

// ---------------------------------------------------------------- words per day

/** The last `n` days of the 90 the server gives, oldest first. @param {{ date: string }[]} days @param {number} n */
export const lastDays = (days, n) => days.slice(Math.max(0, days.length - n));

/** Table rows of the days chart: [date, net, added, removed, minutes]. @param {{ date: string, net: number, added: number, removed: number, minutes: number }[]} days */
export const dayRows = (days) => days.map((d) => [d.date, d.net, d.added, d.removed, d.minutes]);

// ---------------------------------------------------------------- bars

/** The height or width of a bar: 0 for nothing, at least `min` for something, `size` for the largest. @param {number} value @param {number} max @param {number} size @param {number} [min] */
export function barSize(value, max, size, min = 2) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.max(min, Math.round((value / max) * size * 100) / 100);
}

/** Heat level 0 (none) to 4 for a count against the largest count. @param {number} n @param {number} max */
export function heatLevel(n, max) {
  if (!(n > 0) || !(max > 0)) return 0;
  return Math.min(4, 1 + Math.floor((n / max) * 3.999));
}

/** Evenly spaced indexes to label on an axis of `n` items (at most `max`). @param {number} n @param {number} [max] */
export function labelIndexes(n, max = 10) {
  if (n <= 0) return [];
  const step = Math.max(1, Math.ceil(n / max));
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

// ---------------------------------------------------------------- heat map keyboard

/**
 * The next cell with something in it after an arrow key. `grid[row][col]` is a count; only non-zero cells can be reached. Left / Right stay in the row, Up / Down go to the
 * nearest row that has a non-zero cell in the same column, else the nearest one in its row. Home / End jump along the row. Returns null when there is nowhere to go.
 * @param {number[][]} grid @param {number} row @param {number} col @param {string} key @returns {{ row: number, col: number } | null}
 */
export function nextCell(grid, row, col, key) {
  const has = (r, c) => (grid[r]?.[c] ?? 0) > 0;
  const width = grid[0]?.length ?? 0;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const step = key === 'ArrowRight' ? 1 : -1;
    for (let c = col + step; c >= 0 && c < width; c += step) if (has(row, c)) return { row, col: c };
    return null;
  }
  if (key === 'Home' || key === 'End') {
    const cols = [...Array(width).keys()];
    for (const c of key === 'Home' ? cols : cols.reverse()) if (has(row, c)) return c === col ? null : { row, col: c };
    return null;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    for (let r = row + step; r >= 0 && r < grid.length; r += step) {
      if (has(r, col)) return { row: r, col };
      let best = null;
      for (let c = 0; c < width; c++) if (has(r, c) && (best === null || Math.abs(c - col) < Math.abs(best - col))) best = c;
      if (best !== null) return { row: r, col: best };
    }
    return null;
  }
  return null;
}

/** The first cell with something in it, reading order. @param {number[][]} grid */
export function firstCell(grid) {
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < (grid[r]?.length ?? 0); c++) if (grid[r][c] > 0) return { row: r, col: c };
  return null;
}

// ---------------------------------------------------------------- a heat-map cell's scenes

/**
 * The scenes of a chapter that an entry appears in: from the Codex entries answer (`appears_in`: scene_id, title, position) and its `chapters` (scene_ids).
 * Book order. @param {any[] | null | undefined} entries @param {{ chapter: number, scene_ids?: string[] }[] | null | undefined} chapters @param {string} entryId @param {number} chapter
 * @returns {{ id: string, title: string, position: number }[]}
 */
export function cellScenes(entries, chapters, entryId, chapter) {
  const entry = (entries ?? []).find((e) => e.id === entryId);
  const ids = new Set((chapters ?? []).find((c) => c.chapter === chapter)?.scene_ids ?? []);
  const seen = new Set();
  return (entry?.appears_in ?? [])
    .filter((a) => ids.has(a.scene_id) && !seen.has(a.scene_id) && seen.add(a.scene_id))
    .map((a) => ({ id: a.scene_id, title: a.title ?? 'Untitled scene', position: a.position }))
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------- tables

/** @param {any} insights */
export function chapterRows(insights) {
  return insights.manuscript.chapters.map((c) => [chapterName(c), c.words, c.scenes, c.final]);
}
/** @param {any} insights */
export const statusRows = (insights) => insights.manuscript.status.map((s) => [s.status, s.scenes, s.words]);
/** @param {any} insights */
export const labelRows = (insights) => insights.manuscript.labels.rows.map((l) => [l.label, l.scenes, l.words, l.defined ? '' : 'not defined']);
/** @param {any} insights */
export const povRows = (insights) => insights.manuscript.pov.map((p) => [p.name ?? '(no POV)', p.scenes, p.words, `${p.share}%`]);
/** One row per character with a count per chapter. @param {any} insights */
export const heatTable = (insights) => ({
  head: ['Character', ...insights.story.chapters.map(chapterShort), 'Total'],
  rows: insights.story.characters.rows.map((r) => [r.shared ? `${r.name} (series)` : r.name, ...r.cells, r.total]),
});
/** @param {any} insights */
export const threadTable = (insights) => ({
  head: ['Thread', 'Planted', 'Developed', 'Paid', 'Listed only'],
  rows: insights.story.threads.rows.map((t) => [t.title, t.planted, t.developed, t.paid, t.linked]),
});
/** @param {any} insights */
export const eventRows = (insights) => insights.story.events.by_chapter.map((c) => [chapterName(c), c.events]);
