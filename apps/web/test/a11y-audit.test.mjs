// M06-J03 section 2: the accessibility audit of the core views, at render level (no browser, no new dependency).
// Every core view is server-rendered with real repository answers (a copy of salt-orchard plus a pending suggestion) and checked by a11y-check.mjs:
//   no button or link without an accessible name, no img without alt, every field labelled, no duplicate id, no positive tabindex, landmarks present,
//   headings in order, dialogs named and modal, errors tied to their fields, the skip link first, and no two controls sharing one aria-label.
// Views: Library (with books and first run), New book, Open folder, Editor (rail, inspector), Board, Outline, Threads, Matrix, Codex, Timeline, Notes,
// Continuity, Suggestions review, Export / Backup / Restore dialogs, Settings. What a render cannot show (the dialog focus trap, Escape and focus return in shell/Dialog.jsx; focus rings; layout) is checked in a11y-styles.test.mjs where it lives in the
// stylesheet and by the manual browser walk; the Alt+Up/Down reorder path in the rail, the Board and the Timeline is covered by tree.test.mjs, planning.test.mjs and timeline-notes.test.mjs.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Fragment, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { copyFixture } from '../../server/test/helpers.mjs';
import { BOOK as BOOK_ID, CF1, withSuggestion } from '../../server/test/suggest-helpers.mjs';
import { audit } from './a11y-check.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const m = {};
const d = {};

const clone = (o) => JSON.parse(JSON.stringify(o));
const noop = () => {};

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const load = async (p) => Object.assign(m, await vite.ssrLoadModule(p));
  for (const p of [
    '/src/shell/AppShell.jsx', '/src/shell/Inspector.jsx', '/src/BookView.jsx', '/src/library/LibraryPage.jsx', '/src/library/NewBookDialog.jsx', '/src/library/OpenFolderDialog.jsx',
    '/src/planning/PlanningWorkspace.jsx', '/src/codex/CodexPage.jsx', '/src/timeline/TimelinePage.jsx', '/src/timeline/model.js', '/src/notes/NotesPage.jsx', '/src/continuity/ContinuityPage.jsx',
    '/src/suggestions/SuggestionReview.jsx', '/src/export/ExportDialog.jsx', '/src/export/BackupDialog.jsx', '/src/export/RestoreDialog.jsx', '/src/ai/SettingsView.jsx',
    '/src/structure/MoveDialog.jsx', '/src/PlaceholderView.jsx', '/src/editor/SceneEditorPage.jsx',
    // M07-J02: Insights, goals, the timer, Tasks
    '/src/insights/InsightsPage.jsx', '/src/insights/GoalsPanel.jsx', '/src/tasks/TasksPage.jsx', '/src/writing/TimerPanel.jsx', '/src/suggestions/CheckReport.jsx',
  ]) await load(p);

  const root = await copyFixture('valid/salt-orchard');
  await withSuggestion()(root);
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    d.book = clone(await repo.getBook(BOOK_ID));
    d.books = clone(await repo.listBooks());
    d.planning = clone(await repo.listThreads(BOOK_ID));
    d.timeline = clone(await repo.getTimeline(BOOK_ID));
    d.notes = clone(await repo.listNotes(BOOK_ID));
    d.sceneNotes = clone(await repo.getSceneNotes(BOOK_ID));
    const list = await repo.listCodexEntries(BOOK_ID);
    d.entries = clone(list.entries);
    d.chapters = clone(list.chapters);
    d.types = clone(await repo.getCodexTypes(BOOK_ID));
    d.continuity = clone(await repo.getContinuity(BOOK_ID));
    d.objects = clone(await repo.getObjects(BOOK_ID, ['entry', 'thread', 'event']));
    d.diagnostics = clone(await repo.getDiagnostics(BOOK_ID));
    d.templates = clone(await repo.listTemplates());
    const scenes = d.book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
    d.scene = clone(await repo.getScene(BOOK_ID, scenes[1].id));
    d.suggestion = clone((await repo.getSuggestion(BOOK_ID, (await repo.listSuggestions(BOOK_ID)).suggestions[0].id)).suggestion);
    const firstNote = d.notes.notes[0];
    d.note = firstNote ? clone(await repo.getNote(BOOK_ID, firstNote.id)) : null;
    // M07-J02: one task made from the CF1 finding, the numbers, the check report of Arrival
    const made = await repo.createTask(BOOK_ID, { from: 'continuity', fingerprint: CF1 });
    d.tasks = clone(await repo.listTasks(BOOK_ID));
    d.openedTask = clone(await repo.getTask(BOOK_ID, made.id));
    d.insights = clone((await repo.getInsights(BOOK_ID)).insights);
    d.codexForCell = clone(await repo.listCodexEntries(BOOK_ID));
    d.check = clone(await repo.checkScene(BOOK_ID, scenes[1].id));
  } finally {
    await repo.close?.();
  }
});
after(async () => {
  await vite?.close();
});

const html = (el) => renderToStaticMarkup(el);
const shell = (children, { tab = 'manuscript', bookId = BOOK_ID } = {}) => h(m.AppShell, { books: d.books, bookId, tab }, children);
const layout = (children, activeId = null, inspector = null) =>
  h(m.BookLayout, { book: d.book, activeId, inspector: inspector ?? h(m.SceneInspector, { book: d.book, scene: null, diagnostics: { items: d.diagnostics, error: null, loading: false }, objects: d.objects }) }, children);
const planning = (view, mode = 'list') => h(m.PlanningWorkspace, { book: d.book, planning: d.planning, objects: d.objects, view, mode, render: ({ main, inspector }) => layout(main, null, inspector) });
const sceneInspector = () =>
  h(m.SceneInspector, { book: d.book, scene: d.scene, diagnostics: { items: d.diagnostics, error: null, loading: false }, objects: d.objects, planning: d.planning, timeline: d.timeline, notes: d.notes, continuity: d.continuity });

/** A heat-map cell that has scenes, from the real numbers. */
const HEAT_CELL = () => {
  const row = d.insights.story.characters.rows[0];
  const at = row.cells.findIndex((n) => n > 0);
  return { id: row.id, chapter: d.insights.story.chapters[at].chapter };
};
/** The numbers with three goals in them (a day goal, a total with a due date, a chapter goal) so the progress bars render. */
const withGoals = () => {
  const g = (o) => ({ legacy: false, scope: null, scope_found: true, scope_name: null, due: null, period_start: null, streak: 0, projected_finish: null, on_track: null, reached: false, met: false, ...o });
  return {
    ...d.insights,
    progress: {
      ...d.insights.progress,
      goals: [
        g({ id: 'g1', kind: 'words', period: 'day', target: 500, value: 320, percent: 64, streak: 3 }),
        g({ id: 'g2', kind: 'words', period: 'total', target: 90000, value: 211, percent: 0, due: '2027-03-01', projected_finish: '2027-09-01', on_track: false }),
        g({ id: 'g3', kind: 'minutes', period: 'week', target: 300, value: 300, percent: 100, met: true, scope: 'chap_x', scope_name: 'Chapter One: The Drowned Rows' }),
      ],
    },
  };
};
const RUNNING = { kind: 'sprint', bookId: 'b', status: 'running', startedAt: 0, plannedMs: 1_500_000, activeMs: 300_000, lastAt: 0, wordTarget: 300, scenes: [], announced: 20 };

const PAGE = { page: true, landmarks: ['banner', 'navigation', 'main'] };
const WITH_BOOK_ASIDE = { ...PAGE, landmarks: [...PAGE.landmarks, 'complementary'] };
/** A dialog drawn over a page that is not under test: the dialog itself, the landmarks of the shell and no page-level rules. */
const OVER_PAGE = { landmarks: ['banner', 'navigation', 'main'] };

/** The core views: name -> [element, audit options]. Built lazily so a failing view names itself. */
const VIEWS = {
  'Library with books': () => [shell(h(m.LibraryPage, { books: d.books, library: { root: 'C:\\Books' } }), { bookId: null }), PAGE],
  'Library, first run (no books)': () => [shell(h(m.LibraryPage, { books: [], library: { root: 'C:\\Books' } }), { bookId: null }), PAGE],
  'Library loading': () => [shell(h(m.LibraryPage, { books: null, loading: true }), { bookId: null }), PAGE],
  'Library with an error': () => [shell(h(m.LibraryPage, { books: null, error: 'Could not read the library' }), { bookId: null }), PAGE],
  'New book dialog': () => [shell(h(Fragment, null, h(m.LibraryPage, { books: d.books }), h(m.NewBookDialog, { templates: d.templates, series: [], penNames: [{ name: 'R. Fenwick', slug: 'r-fenwick' }], onClose: noop, error: { code: 'EXISTS', field: 'slug', message: 'A folder with that name exists' } })), { bookId: null }), PAGE],
  'Open folder dialog': () => [shell(h(Fragment, null, h(m.LibraryPage, { books: [] }), h(m.OpenFolderDialog, { recent: [{ path: 'C:\\Books', exists: true }, { path: 'D:\\Gone', exists: false }], onClose: noop, error: { code: 'NOT_FOUND', message: 'No such folder' } })), { bookId: null }), PAGE],
  'Editor (scene, rail, inspector)': () => [shell(layout(h(m.ScenePaper, { book: d.book, scene: d.scene, chapterLabel: 'Chapter One: The Drowned Rows' }), d.scene.id, sceneInspector())), WITH_BOOK_ASIDE],
  'Editor (the live editor page)': () => [shell(layout(h(m.SceneEditorPage, { book: d.book, scene: d.scene, chapterLabel: 'Chapter One: The Drowned Rows', objects: d.objects }), d.scene.id, sceneInspector())), WITH_BOOK_ASIDE],
  'Board': () => [shell(planning('board')), WITH_BOOK_ASIDE],
  'Outline (table)': () => [shell(planning('outline')), WITH_BOOK_ASIDE],
  'Threads (list)': () => [shell(planning('threads')), WITH_BOOK_ASIDE],
  'Threads (matrix)': () => [shell(planning('threads', 'matrix')), WITH_BOOK_ASIDE],
  'Move dialog': () => [shell(h(Fragment, null, layout(h('p', null, 'x')), h(m.MoveDialog, { book: d.book, scene: d.book.acts[0].chapters[0].scenes[0], onSubmit: noop, onClose: noop, onRepair: noop, error: 'Not moved' }))), OVER_PAGE],
  'Codex': () => [shell(h(m.CodexPage, { bookId: BOOK_ID, types: d.types, entries: d.entries, chapters: d.chapters, typeKey: 'all' }), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Timeline': () => [shell(h(m.TimelinePage, { bookId: BOOK_ID, data: d.timeline, model: m.buildTimeline(d.timeline) }), { tab: 'timeline' }), WITH_BOOK_ASIDE],
  'Notes': () => [shell(h(m.NotesPage, { bookId: BOOK_ID, data: d.notes, sceneNotes: d.sceneNotes }), { tab: 'notes' }), WITH_BOOK_ASIDE],
  'Continuity': () => [shell(h(m.ContinuityPage, { bookId: BOOK_ID, result: d.continuity }), { tab: 'continuity' }), WITH_BOOK_ASIDE],
  'Suggestions review': () => [shell(h('main', { id: 'main', tabIndex: -1 }, h(m.SuggestionReview, { suggestion: d.suggestion })), { tab: 'continuity' }), { landmarks: ['main'] }],
  'Export dialog': () => [shell(h(Fragment, null, layout(h('p', null, 'x')), h(m.ExportDialog, { book: d.book, onClose: noop }))), OVER_PAGE],
  'Backup dialog': () => [shell(h(Fragment, null, layout(h('p', null, 'x')), h(m.BackupDialog, { book: d.book, onClose: noop }))), OVER_PAGE],
  'Restore dialog': () => [shell(h(Fragment, null, h(m.LibraryPage, { books: d.books }), h(m.RestoreDialog, { onClose: noop })), { bookId: null }), PAGE],
  'Settings': () => [shell(h(m.SettingsView), { bookId: null }), PAGE],
  // M07-J02: Insights (sections, charts with their table form, goals with progress bars, the timer), Tasks (list, opened task) and their dialogs
  'Insights': () => [shell(h(m.InsightsPage, { bookId: BOOK_ID, data: d.insights }), { tab: 'insights' }), PAGE],
  'Insights, a heat-map cell selected': () => [shell(h(m.InsightsPage, { bookId: BOOK_ID, data: d.insights, cell: HEAT_CELL(), entries: d.codexForCell.entries, entryChapters: d.codexForCell.chapters }), { tab: 'insights' }), PAGE],
  'Insights, with goals': () => [shell(h(m.InsightsPage, { bookId: BOOK_ID, data: withGoals(), goalHandlers: { onAdd: noop, onRemove: noop } }), { tab: 'insights' }), PAGE],
  'Insights, goal dialog': () => [shell(h(Fragment, null, h(m.InsightsPage, { bookId: BOOK_ID, data: d.insights }), h(m.GoalDialog, { scopes: d.insights.progress.scopes, error: 'The target is a whole number, 1 or more.', onSubmit: noop, onClose: noop })), { tab: 'insights' }), OVER_PAGE],
  'Timer, running': () => [shell(h('main', { id: 'main', tabIndex: -1 }, h('h1', null, 'Insights'), h('h2', null, 'Progress'), h(m.TimerRunning, { timer: RUNNING, here: true, onPause: noop, onResume: noop, onFinish: noop, onAbandon: noop })), { tab: 'insights' }), PAGE],
  'Tasks': () => [shell(h(m.TasksPage, { bookId: BOOK_ID, data: d.tasks, opened: d.openedTask, selectedId: d.openedTask.task.id, handlers: { onNew: noop } }), { tab: 'tasks' }), WITH_BOOK_ASIDE],
  'Tasks, nothing yet': () => [shell(h(m.TasksPage, { bookId: BOOK_ID, data: { tasks: [], counts: { open: 0, doing: 0, done: 0, dropped: 0, total: 0 }, labels: [] } }), { tab: 'tasks' }), WITH_BOOK_ASIDE],
  'New task dialog': () => [shell(h(Fragment, null, h(m.TasksPage, { bookId: BOOK_ID, data: d.tasks }), h(m.NewTaskDialog, { error: 'The server refused the request.', onSubmit: noop, onClose: noop })), { tab: 'tasks' }), OVER_PAGE],
  'Check report with Make a task': () => [shell(h(Fragment, null, layout(h('p', null, 'x')), h(m.CheckDialog, { bookId: BOOK_ID, sceneTitle: 'Arrival', report: d.check, makeTask: true, onClose: noop })), {}), OVER_PAGE],
  'Placeholder tab': () => [shell(h(m.PlaceholderView, { bookId: BOOK_ID, tab: 'places' }), { tab: 'places' }), PAGE],
};

describe('every core view passes the render-level audit', () => {
  for (const name of Object.keys(VIEWS)) {
    test(name, () => {
      const [el, opts] = VIEWS[name]();
      const markup = html(el);
      assert.ok(markup.length > 200, `${name} rendered something`);
      assert.deepEqual(audit(markup, opts), []);
    });
  }
});

describe('the audit itself catches what it is for', () => {
  const bad = (markup, opts) => audit(markup, opts);
  test('names', () => {
    assert.match(bad('<main id="main"><button type="button"><svg aria-hidden="true"></svg></button></main>')[0], /button without an accessible name/);
    assert.deepEqual(bad('<main id="main"><button type="button" aria-label="Close"><svg aria-hidden="true"></svg></button></main>'), []);
    assert.match(bad('<main id="main"><a href="/x"></a></main>')[0], /a without an accessible name/);
    assert.match(bad('<main id="main"><img src="x.png"></main>')[0], /img without alt/);
  });
  test('fields', () => {
    assert.match(bad('<main id="main"><input type="text" name="q"></main>')[0], /input\[type=text\] without a label/);
    assert.deepEqual(bad('<main id="main"><label for="a">Title</label><input id="a" type="text"><label>Slug <input type="text"></label></main>'), []);
    assert.match(bad('<main id="main"><input type="text" aria-label="x" aria-invalid="true"></main>')[0], /invalid field without aria-describedby/);
  });
  test('ids, tab order, headings, landmarks, duplicates', () => {
    assert.match(bad('<main id="main"><p id="a"></p><p id="a"></p></main>')[0], /duplicate id "a"/);
    assert.match(bad('<main id="main"><button tabindex="3">x</button></main>')[0], /positive tabindex/);
    assert.match(bad('<main id="main"><h1>a</h1><h3>b</h3></main>')[0], /heading jumps from h1 to h3/);
    assert.match(bad('<div></div>', { landmarks: ['main'] })[0], /landmark missing: main/);
    assert.match(bad('<main id="main"><button aria-label="More">a</button><button aria-label="More">b</button></main>')[0], /share the accessible name "More"/);
    assert.match(bad('<a href="#main">Skip</a><main id="main"><h1>T</h1></main>', { page: true })[0], /skip link is not the first/);
  });
});

describe('live regions: save status and toasts are announced, and toasts never pile up on top of each other', () => {
  test('the shell always carries the toast stack (a polite live region) and the save status', () => {
    const markup = html(shell(h('main', { id: 'main' }, h('h1', null, 'x'))));
    assert.match(markup, /<div id="toast-stack" class="toast-stack" role="status" aria-live="polite" aria-atomic="false"><\/div>/);
    assert.match(markup, /<[^>]*data-state="[a-z]+"[^>]*role="status"|<[^>]*role="status"[^>]*data-state="[a-z]+"/, 'the save status is a status region');
  });
  test('a toast drawn without the stack (a part rendered alone) is a live region of its own, with its buttons named', async () => {
    const { Toast } = await vite.ssrLoadModule('/src/continuity/useContinuityActions.jsx');
    const markup = html(h(Toast, { toast: { message: 'Archived.', undo: { op: 'x' } }, onUndo: noop, onDismiss: noop }));
    assert.match(markup, /<div class="toast" role="status">/);
    assert.deepEqual(audit(markup), []);
    assert.match(markup, />Undo</);
    assert.match(markup, />Dismiss</);
  });
  test('the Board announces moves in its own live region, and so does the rail', () => {
    assert.match(html(shell(planning('board'))), /data-testid="board-live"/);
    assert.match(html(shell(planning('board'))), /data-testid="move-live"/);
  });
});
