// The Insights numbers of a book (M07-J02 section 3): GET /api/books/:id/insights.
// The structure (scenes, chapters, the graph) comes from the book's index when it is fresh, else from validate(); the author's own files (goals, tasks, the writing log,
// session rows, labels) are read from the files either way. The numbers are computed by one pure function, so both paths give the same bytes.
import path from 'node:path';
import { isFile, readText } from '@storyforge/format';
import { computeInsights, structureFromResult } from '@storyforge/index';
import { openStore } from '@storyforge/store';
import { parseFrontMatter } from './fm.mjs';
import { GOALS_PATH, parseGoals } from './goals.mjs';
import { readTasks } from './fs-tasks.mjs';
import { localDate } from './writing-log.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** The label definitions of a front matter ({ name, color } items). @param {any} fm */
function labelDefsOf(fm) {
  return (Array.isArray(fm?.labels) ? fm.labels : [])
    .filter((l) => l && typeof l === 'object' && typeof l.name === 'string' && l.name.trim() !== '' && typeof l.color === 'string')
    .map((l) => ({ name: l.name, color: l.color }));
}

/**
 * @param {{ root: string, manager: any, readValidate: () => Promise<any>, activity: ReturnType<typeof import('./activity.mjs').createActivity>, now?: () => number | Date }} p
 */
export function createInsightReads({ root, manager, readValidate, activity, now = () => Date.now() }) {
  /**
   * @param {string} bookId @param {{ from?: 'files' }} [opts] `from: 'files'` skips the index (tests compare both paths)
   * @returns {Promise<{ ok: true, code: 'OK', insights: any, source: 'index' | 'files' } | { ok: false, code: string }>}
   */
  async function getInsights(bookId, { from } = {}) {
    if (typeof bookId !== 'string') return fail('NOT_FOUND');
    const bookPath = await manager.pathOf(bookId);
    if (bookPath === null) return fail('NOT_FOUND');
    const bookRoot = bookPath === '' ? root : path.join(root, ...bookPath.split('/'));

    /** @type {'index' | 'files'} */
    let source = 'files';
    let structure = null;
    try {
      const hit = from === 'files' ? null : await manager.tryRead(bookPath, (q, s, inv) => (inv.invalid || s.id !== bookId ? null : q.insightsStructure()));
      if (hit?.value) {
        structure = hit.value;
        source = 'index';
      }
    } catch {
      structure = null;
    }
    if (!structure) {
      structure = structureFromResult(await readValidate(), bookPath);
      if (!structure) return fail('NOT_FOUND');
    }

    const store = await openStore(bookRoot, { recover: false });
    const text = async (rel) => (await store.read(rel))?.bytes.toString('utf8') ?? null;
    const bookFm = parseFrontMatter((await text('book.md')) ?? '').fm;
    // the series' label definitions (the folder above the book, when it holds a series.md)
    const segs = bookPath === '' ? [] : bookPath.split('/');
    const seriesAbs = segs.length === 0 ? null : path.join(root, ...segs.slice(0, -1), 'series.md');
    const seriesFm = seriesAbs && (await isFile(seriesAbs)) ? parseFrontMatter(await readText(seriesAbs)).fm : {};
    const defs = [];
    const seen = new Set();
    for (const l of [...labelDefsOf(bookFm), ...labelDefsOf(seriesFm)]) {
      const k = l.name.trim().toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        defs.push(l);
      }
    }

    // scene labels: the one thing about a scene the index does not keep
    const labelsOf = new Map();
    const scenes = structure.scenes;
    for (let i = 0; i < scenes.length; i += 64) {
      await Promise.all(
        scenes.slice(i, i + 64).map(async (s) => {
          labelsOf.set(s.id, strings(parseFrontMatter((await text(s.path)) ?? '').fm.labels));
        }),
      );
    }

    const goalsText = await text(GOALS_PATH);
    const goals = goalsText ? parseGoals(goalsText).goals : [];
    const tasks = (await readTasks(store)).map((t) => ({ status: t.status }));
    const days = await activity.allDays(bookPath);
    const sessions = (await activity.sessions(bookPath)).map((r) => ({ date: localDate(new Date(r.start)), minutes: r.minutes, added: r.added, removed: r.removed, kind: r.kind, scenes: r.scenes }));
    const daily = bookFm.daily_word_goal;
    const target = bookFm.word_target;

    const insights = computeInsights({
      today: localDate(new Date(Number(now()))),
      book: { id: bookId, title: typeof bookFm.title === 'string' ? bookFm.title : null, word_target: Number.isInteger(target) ? target : null },
      scenes: scenes.map((s) => ({ ...s, labels: labelsOf.get(s.id) ?? [] })),
      chapters: structure.chapters,
      containers: structure.containers,
      nodes: structure.nodes,
      edges: structure.edges,
      labelDefs: defs,
      goals,
      dailyWordGoal: Number.isInteger(daily) && daily >= 1 ? daily : null,
      days,
      sessions,
      tasks,
    });
    return { ok: true, code: 'OK', insights, source };
  }

  return { getInsights };
}
