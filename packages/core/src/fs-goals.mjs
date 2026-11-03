// Goals (activity/goals.md) and session rows (activity/sessions/...), M07-J02. Everything is written through the store.
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { openStore } from '@storyforge/store';
import { parseFrontMatter } from './fm.mjs';
import { GOALS_PATH, GOAL_KINDS, GOAL_PERIODS, applyGoalOp, freeGoalId, newGoalsFile, parseGoals } from './goals.mjs';
import { SESSION_KINDS } from './sessions.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

function isDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * @param {{ root: string, activity?: ReturnType<typeof import('./activity.mjs').createActivity>, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any> }} p
 */
export function createGoalMethods({ root, activity, afterWrite = () => {}, reconcile }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }
  async function refresh(book) {
    if (reconcile) await reconcile(book.path);
    else afterWrite(book.path);
  }

  /** The goals the author wrote, and the legacy daily goal of book.md. @param {string} bookId */
  async function getGoals(bookId) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const file = await store.read(GOALS_PATH);
    const { goals, skipped } = file ? parseGoals(file.bytes.toString('utf8')) : { goals: [], skipped: 0 };
    const bookFile = await store.read('book.md');
    const daily = bookFile ? parseFrontMatter(bookFile.bytes.toString('utf8')).fm.daily_word_goal : null;
    const dailyWordGoal = Number.isInteger(daily) && daily >= 1 ? daily : null;
    const effective = dailyWordGoal && !goals.some((g) => g.kind === 'words' && g.period === 'day')
      ? [{ id: 'daily_word_goal', kind: 'words', period: 'day', target: dailyWordGoal, legacy: true }, ...goals]
      : goals;
    return { ok: true, code: 'OK', goals, skipped, daily_word_goal: dailyWordGoal, effective, sha256: file?.sha256 ?? null };
  }

  /**
   * Add or change one goal (by `id`; a new id when absent). The file is created when missing; every other goal, even one the app cannot read, stays as written.
   * Refusals: BAD_ARGS, NOT_FOUND. @param {string} bookId @param {{ id?: string, kind?: string, target?: number, period?: string, due?: string | null, scope?: string | null }} goal
   */
  async function setGoal(bookId, goal) {
    const g = goal ?? {};
    if (!GOAL_KINDS.includes(/** @type {string} */ (g.kind))) return fail('BAD_ARGS', { message: `kind must be one of ${GOAL_KINDS.join(', ')}` });
    if (!GOAL_PERIODS.includes(/** @type {string} */ (g.period))) return fail('BAD_ARGS', { message: `period must be one of ${GOAL_PERIODS.join(', ')}` });
    if (!Number.isInteger(g.target) || /** @type {number} */ (g.target) < 1 || /** @type {number} */ (g.target) > 999_999_999) return fail('BAD_ARGS', { message: 'target must be a whole number >= 1' });
    if (g.id !== undefined && (typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(g.id))) return fail('BAD_ARGS', { message: 'id must be 1 to 40 letters, digits, - or _' });
    if (g.due !== undefined && g.due !== null) {
      if (g.period !== 'total') return fail('BAD_ARGS', { message: 'due is only for a goal with period total' });
      if (typeof g.due !== 'string' || !isDate(g.due)) return fail('BAD_ARGS', { message: 'due must be an ISO date: YYYY-MM-DD' });
    }
    if (g.scope !== undefined && g.scope !== null && (typeof g.scope !== 'string' || g.scope === '')) return fail('BAD_ARGS', { message: 'scope must be a chapter or act ID' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    if (typeof g.scope === 'string') {
      const ok = extractDocs(found.result, found.book.path).some((d) => !d.archived && (d.kind === 'chapter' || d.kind === 'act') && d.fm.id === g.scope);
      if (!ok) return fail('BAD_ARGS', { message: 'scope is not the ID of a chapter or act of this book' });
    }
    const store = await openStore(bookRootOf(found.book), { recover: false });
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await store.read(GOALS_PATH);
      const text = cur ? cur.bytes.toString('utf8') : null;
      const known = text ? parseGoals(text).goals : [];
      const id = g.id ?? freeGoalId(known);
      const next = {
        id, kind: /** @type {any} */ (g.kind), target: /** @type {number} */ (g.target), period: /** @type {any} */ (g.period),
        ...(typeof g.due === 'string' ? { due: g.due } : {}), ...(typeof g.scope === 'string' ? { scope: g.scope } : {}),
      };
      let out = text === null ? newGoalsFile([next]) : applyGoalOp(text, { set: next });
      if (out === null) out = newGoalsFile([next]);
      const r = await store.write(GOALS_PATH, Buffer.from(out, 'utf8'), { baseSha256: cur ? cur.sha256 : null });
      if (r.ok) {
        await refresh(found.book);
        return { ok: true, code: 'OK', goal: next, sha256: r.sha256 };
      }
      if (r.code !== 'CONFLICT' && r.code !== 'EXISTS') return fail(r.code, r.message ? { message: r.message } : {});
    }
    return fail('CONFLICT', { message: 'goals.md kept changing; try again' });
  }

  /** Remove one goal (the file stays, with the other goals as written). NOT_FOUND when there is no such goal. @param {string} bookId @param {string} id */
  async function removeGoal(bookId, id) {
    if (typeof id !== 'string' || id === '') return fail('BAD_ARGS', { message: 'id must be a goal id' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const cur = await store.read(GOALS_PATH);
    if (!cur) return fail('NOT_FOUND');
    const out = applyGoalOp(cur.bytes.toString('utf8'), { remove: id });
    if (out === null) return fail('NOT_FOUND');
    const r = await store.write(GOALS_PATH, Buffer.from(out, 'utf8'), { baseSha256: cur.sha256 });
    if (!r.ok) return r.code === 'CONFLICT' ? fail('CONFLICT', { current: null }) : fail(r.code, r.message ? { message: r.message } : {});
    await refresh(found.book);
    return { ok: true, code: 'OK', removed: id };
  }

  /**
   * One finished timer or sprint or session, reported with its times and the scenes worked on: a row in activity/sessions/<YYYY>/<YYYY-MM>.md.
   * Refusals: BAD_ARGS (times, kind, scenes), NOT_FOUND.
   * @param {string} bookId @param {{ start?: string, end?: string, kind?: string, scenes?: string[] }} body
   */
  async function recordSessionRow(bookId, body) {
    const { start, end, kind, scenes = [] } = body ?? {};
    if (typeof start !== 'string' || typeof end !== 'string' || !ISO_TIME_RE.test(start) || !ISO_TIME_RE.test(end)) return fail('BAD_ARGS', { message: 'start and end must be UTC ISO times like 2026-11-02T10:00:00Z' });
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return fail('BAD_ARGS', { message: 'end must be after start' });
    const minutes = Math.round((e - s) / 60_000);
    if (minutes < 1 || minutes > 1440) return fail('BAD_ARGS', { message: 'a session is from 1 minute to 24 hours' });
    if (!SESSION_KINDS.includes(/** @type {string} */ (kind))) return fail('BAD_ARGS', { message: `kind must be one of ${SESSION_KINDS.join(', ')}` });
    if (!Array.isArray(scenes) || scenes.length > 100 || scenes.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(x))) return fail('BAD_ARGS', { message: 'scenes must be a list of scene ids' });
    const found = await findBook(bookId);
    if (!found || !activity) return fail('NOT_FOUND');
    const live = new Set(found.book.order.map((/** @type {any} */ x) => x.id));
    if (scenes.some((x) => !live.has(x))) return fail('BAD_ARGS', { message: 'scenes must be scenes of this book' });
    const r = await activity.appendSession(found.book.path, { start: s, end: e, kind: /** @type {any} */ (kind), scenes: [...new Set(scenes)] });
    return r.ok ? { ok: true, code: 'OK', row: r.row, path: r.path } : fail('WRITE_FAILED', { message: 'the session could not be written' });
  }

  return { getGoals, setGoal, removeGoal, recordSessionRow };
}
