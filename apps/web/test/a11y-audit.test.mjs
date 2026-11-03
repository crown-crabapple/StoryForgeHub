// M06-J03 section 2: the accessibility audit of the core views, at render level (no browser, no new dependency).
// Every core view is server-rendered with real repository answers (a copy of salt-orchard plus a pending suggestion) and checked by a11y-check.mjs:
//   no button or link without an accessible name, no img without alt, every field labelled, no duplicate id, no positive tabindex, landmarks present,
//   headings in order, dialogs named and modal, errors tied to their fields, the skip link first, and no two controls sharing one aria-label.
// Views: Library (with books and first run), New book, Open folder, Editor (rail, inspector), Board, Outline, Threads, Matrix, Codex, Timeline, Notes,
// Continuity, Suggestions review, Export / Backup / Restore dialogs, Settings. M07-J01b adds, rendered with a copy of the tidewater fixture (a book in a series with
// shared entries, labels and typed fields): the Codex of a series book, a shared entry open, the Edit dialog with typed fields and W312, New entry with Where, the
// preview with the shared notice, the label manager, Save as template, the link picker with other books, New book with library templates, the Board and Outline with
// label chips and filters, and the problems list with the Series badge. What a render cannot show (the dialog focus trap, Escape and focus return in shell/Dialog.jsx; focus rings; layout) is checked in a11y-styles.test.mjs where it lives in the
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
import { audit, indexIds, nameOf, parse as parseMarkup, walk as walkMarkup } from './a11y-check.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const m = {};
const d = {};
const T = {}; // the tidewater library (M07-J01b)
const TIDE = { so: 'book_01W10000000000000000000006', lt: 'book_01W1000000000000000000000A', ilse: 'entry_01W10000000000000000000003', vessel: 'entry_01W10000000000000000000009' };

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
    '/src/collab/RailComments.jsx', '/src/collab/Presence.jsx', '/src/editor/StalePanel.jsx',
    '/src/shared/LoginPage.jsx', '/src/shared/SetupPage.jsx', '/src/shared/InvitePage.jsx', '/src/shared/MembersPage.jsx', '/src/shared/UserMenu.jsx', '/src/shared/ShareReader.jsx', '/src/shared/ShareEntry.jsx',
    '/src/codex/dialogs.jsx', '/src/codex/model.js', '/src/editor/LinkPicker.jsx', '/src/structure/PreviewDialog.jsx', '/src/world/LabelManager.jsx', '/src/world/SaveAsTemplateDialog.jsx', '/src/world/model.js',
    // M07-J02: Insights, goals, the timer, Tasks
    // M08-J04: drawers, the simulated viewport and the offline bar
    '/src/shell/useDrawer.js', '/src/shell/drawer.js', '/src/shell/Workspace.jsx', '/src/shared/OfflineQueueBar.jsx', '/src/editor/offline-queue.js', '/src/planning/MatrixView.jsx',
    '/src/insights/InsightsPage.jsx', '/src/insights/GoalsPanel.jsx', '/src/tasks/TasksPage.jsx', '/src/writing/TimerPanel.jsx', '/src/suggestions/CheckReport.jsx',
    // M08-J02: Settings -> Plugins and Webhooks
    '/src/integrations/PluginsPanel.jsx', '/src/integrations/WebhooksPanel.jsx',
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
before(async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    const list = await repo.listCodexEntries(TIDE.so);
    T.entries = clone(list.entries);
    T.chapters = clone(list.chapters);
    T.series = clone(list.series);
    T.types = clone(await repo.getCodexTypes(TIDE.so));
    T.labels = clone(await repo.getLabels(TIDE.so));
    T.targets = clone(await repo.getLinkTargets(TIDE.lt));
    T.books = clone(await repo.listBooks());
    T.book = clone(await repo.getBook(TIDE.so));
    T.planning = clone(await repo.listThreads(TIDE.so));
    T.objects = clone(await repo.getObjects(TIDE.so, ['entry', 'thread', 'event']));
    T.templates = clone(await repo.listTemplates());
    T.diagnostics = [...clone(await repo.getDiagnostics(TIDE.lt)), { code: 'W312', severity: 'warning', file: 'tidewater/codex/vessels/the-gull.md', location: 'fields.Tonnage', message: 'Tonnage should be a number value', scope: 'series', series: 'tidewater' }];
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

// M07-J03a shared-mode views: the sign-in pages have no app shell (nobody is signed in), so they are a lone <main>
const LONE_MAIN = { landmarks: ['main'] };
const MEMBERS = {
  members: [
    { user: 'usr_1', username: 'ilse', display_name: 'Ilse', role: 'owner', disabled: false },
    { user: 'usr_2', username: 'tobin', display_name: 'Tobin', role: 'editor', disabled: false },
    { user: 'usr_3', username: 'mara', display_name: 'Mara', role: 'reviewer', disabled: false },
  ],
  invites: [{ id: 'inv_1', role: 'viewer', expires: 1_800_000_000_000, live: true }, { id: 'inv_2', role: 'editor', expires: 1_800_100_000_000, live: true }],
  shares: [{ id: 'shr_1', book: BOOK_ID, scope: ['read'], expires: 1_800_000_000_000, live: true }, { id: 'shr_2', book: BOOK_ID, scope: ['read', 'export'], expires: 1_800_100_000_000, live: true }],
  settings: { ai_for_members: false },
  currentUserId: 'usr_1',
  onRole: noop, onRemove: noop, onInvite: noop, onRevokeInvite: noop, onShare: noop, onRevokeShare: noop, onAi: noop, onDismissLink: noop,
};
const membersPage = (extra = {}) => h(m.MembersPage, { ...MEMBERS, books: d.books.map((b) => ({ id: b.id, title: b.title })), ...extra });

// M08-J02: Settings -> Plugins and Webhooks, rendered with data (Settings itself renders them before the server has answered). Every control is a native button, input or
// label, so the keyboard walk is the browser's own; the audit checks names, labels, ids, the headings order and that no two controls share a name.
const PLUGINS = {
  api: 1,
  manifests: [
    { plugin: 'word-frequency', name: 'Word frequency', version: '1.0.0', api: 1, permissions: ['read'], books: 'all', homepage: '', description: 'Prints the most used words of each chapter.', path: '_plugins/word-frequency/plugin.md', problems: [] },
    { plugin: 'tidy-notes', name: 'Tidy notes', version: '0.4.0', api: 1, permissions: ['read', 'propose'], books: ['salt-orchard'], homepage: '', description: '', path: '_plugins/tidy-notes/plugin.md', problems: [] },
    { plugin: 'from-the-future', name: 'From the future', version: '9.0.0', api: 2, permissions: ['read'], books: 'all', homepage: '', description: '', path: '_plugins/future/plugin.md', problems: [{ code: 'W315', location: 'api', message: 'needs a newer StoryForge' }] },
    { plugin: null, name: null, version: null, api: null, permissions: [], books: 'all', homepage: '', description: '', path: '_plugins/broken/plugin.md', problems: [{ code: 'E102', location: 'schema', message: 'schema must be storyforge.plugin/v1' }] },
  ],
  grants: [
    { id: 'tok_01S8000000000000000000AAAA', plugin: 'word-frequency', permissions: ['read'], books: 'all', created: 1_793_000_000_000, last_used: 1_793_100_000_000, revoked: false },
    { id: 'tok_01S8000000000000000000BBBB', plugin: 'tidy-notes', permissions: ['read', 'propose'], books: ['salt-orchard'], created: 1_793_000_000_000, last_used: null, revoked: false },
    { id: 'tok_01S8000000000000000000CCCC', plugin: 'old-one', permissions: ['read', 'events'], books: 'all', created: 1_790_000_000_000, last_used: 1_790_500_000_000, revoked: true },
  ],
  books: [{ id: BOOK_ID, slug: 'salt-orchard', title: 'The Salt Orchard' }, { id: 'book_01S5000000000000000000000B', slug: 'second-book', title: 'A Second Book' }],
};
const WEBHOOKS = {
  events: ['scene.saved'],
  books: PLUGINS.books,
  webhooks: [
    { id: 'whk_01S8000000000000000000AAAA', url: 'https://example.com/storyforge', events: ['scene.saved', 'suggestion.created'], books: 'all', include_content: false, allow_local: false, plugin: null, secret_hash: 'a'.repeat(64), created: 1_793_000_000_000, revoked: false, disabled: false, failures: 0, last_delivery: { at: 1_793_100_000_000, ok: true, status: 204, code: null } },
    { id: 'whk_01S8000000000000000000BBBB', url: 'http://127.0.0.1:8787/hook', events: ['scene.saved'], books: ['salt-orchard'], include_content: true, allow_local: false, plugin: 'tidy-notes', secret_hash: 'b'.repeat(64), created: 1_793_000_000_000, revoked: false, disabled: true, failures: 20, last_delivery: { at: 1_793_100_000_000, ok: false, status: 500, code: 'HTTP_500' } },
    { id: 'whk_01S8000000000000000000CCCC', url: 'https://old.example.org/h', events: ['export.done'], books: 'all', include_content: false, allow_local: false, plugin: null, secret_hash: 'c'.repeat(64), created: 1_790_000_000_000, revoked: true, disabled: false, failures: 0, last_delivery: null },
  ],
};
const settingsPart = (...parts) => shell(h('main', { id: 'main', tabIndex: -1, className: 'page settings-page' }, h('h1', null, 'Settings'), ...parts), { bookId: null });

const tshell = (children, { tab = 'manuscript' } = {}) => h(m.AppShell, { books: T.books, bookId: TIDE.so, tab }, children);
const defs = () => [...T.labels.book.labels.map((l) => ({ ...l, scope: 'book' })), ...T.labels.series.labels.map((l) => ({ ...l, scope: 'series' }))];
const tcodex = (props = {}) => h(m.CodexPage, { bookId: TIDE.so, types: T.types, entries: T.entries, chapters: T.chapters, typeKey: 'all', series: T.series, labelDefs: defs(), onLabel: noop, onScope: noop, ...props });
const tplanning = (view) => h(m.PlanningWorkspace, { book: T.book, planning: T.planning, objects: T.objects, view, render: ({ main, inspector }) => h(m.BookLayout, { book: T.book, activeId: null, inspector }, main) });
// M07-J03b: comments rail, reviewer controls, presence and the stale-save panel (rendered with data, like the other views)
const COMMENTS = [
  { id: 'note_C1', status: 'open', by: 'Mara', created: '2026-11-02T15:00:00Z', text: 'Is the orchard really half under water?', quote: 'half under water', line: 19, anchored: true, replies: [{ name: 'Ilse', at: '2026-11-02T16:00:00Z', text: 'At high tide, yes.' }] },
  { id: 'note_C2', status: 'open', by: 'Mara', created: '2026-11-02T15:05:00Z', text: 'Which ferry?', quote: '', line: null, anchored: false, replies: [] },
  { id: 'note_C3', status: 'resolved', by: null, created: '2026-11-01T09:00:00Z', text: 'Fixed.', quote: 'green eyes', line: 17, anchored: true, replies: [] },
];
const inRail = (el) => h(Fragment, null, el);
const staleSnapshot = (conflict) => ({ state: 'conflict', baseSha256: 'a', text: 'My version of the scene.\nSecond line.\n', savedText: '', savedAt: null, attempt: 0, retryInMs: null, error: null, conflict });
const STALE = { currentSha256: 'b', currentText: 'Their version of the scene.\nSecond line.\n', stale: true, suggestionId: 'note_SUG' };
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
  'Comments rail (open, unanchored and resolved threads with reply boxes)': () => [shell(layout(h('h1', null, 'Arrival'), d.scene.id, inRail(h('section', { 'aria-label': 'Comments' }, h(m.CommentList, { comments: COMMENTS, canComment: true, onReply: noop, onStatus: noop, onShow: noop }))))), WITH_BOOK_ASIDE],
  'Comments rail read-only (a viewer)': () => [shell(layout(h('h1', null, 'Arrival'), d.scene.id, inRail(h('section', { 'aria-label': 'Comments' }, h(m.CommentList, { comments: COMMENTS, canComment: false }))))), WITH_BOOK_ASIDE],
  'Reviewer: Comment on selection form': () => [shell(layout(h('h1', null, 'Arrival'), d.scene.id, inRail(h(m.SelectionForm, { mode: 'comment', selectedText: 'Past the dunes lay the orchard', error: 'Your role cannot do this.', onComment: noop, onCancel: noop })))), WITH_BOOK_ASIDE],
  'Reviewer: Suggest change form': () => [shell(layout(h('h1', null, 'Arrival'), d.scene.id, inRail(h(m.SelectionForm, { mode: 'suggest', selectedText: 'half under water', onSuggest: noop, onCancel: noop })))), WITH_BOOK_ASIDE],
  'Reviewer: a reviewer suggestion with no Accept or Decline': () => [shell(h('main', { id: 'main', tabIndex: -1 }, h(m.SuggestionReview, { suggestion: { ...d.suggestion, source: 'reviewer', by: { id: 'usr_1', name: 'Mara' } } })), { tab: 'continuity' }), { landmarks: ['main'] }],
  'Presence: also in this scene': () => [shell(layout(h(Fragment, null, h('h1', null, 'Arrival'), h(m.PresenceNote, { users: [{ name: 'Ilse' }, { name: 'Tobin' }] })), d.scene.id)), WITH_BOOK_ASIDE],
  'Stale save panel (shared mode, text kept as a suggestion)': () => [shell(layout(h(Fragment, null, h('h1', null, 'Arrival'), h(m.StalePanel, { snapshot: staleSnapshot(STALE), title: 'Arrival', canReview: true, onReview: noop, onUseCurrent: noop })), d.scene.id)), WITH_BOOK_ASIDE],
  'Stale save panel for a reviewer-less role (no review button)': () => [shell(layout(h(Fragment, null, h('h1', null, 'Arrival'), h(m.StalePanel, { snapshot: staleSnapshot({ ...STALE, suggestionId: null }), title: 'Arrival', canReview: false, onReview: noop, onUseCurrent: noop })), d.scene.id)), WITH_BOOK_ASIDE],
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
  'Settings, Plugins (manifests, a newer-StoryForge warning, a broken manifest, grants active and revoked)': () => [settingsPart(h(m.PluginsView, { data: PLUGINS, onAsk: noop, onRevoke: noop })), PAGE],
  'Settings, Plugins, confirming a grant from a manifest (permissions and books)': () => [settingsPart(h(m.PluginsView, { data: PLUGINS, ask: { plugin: 'tidy-notes', name: 'Tidy notes', permissions: ['read', 'propose'], books: ['salt-orchard'], manual: false } })), PAGE],
  'Settings, Plugins, granting to a plugin with no manifest, with an error': () => [settingsPart(h(m.PluginsView, { data: PLUGINS, ask: { plugin: '', name: '', permissions: ['read'], books: 'all', manual: true }, error: 'books names a book that is not in this library' })), PAGE],
  'Settings, Plugins, the token shown once': () => [settingsPart(h(m.PluginsView, { data: PLUGINS, created: { token: 'a'.repeat(43), plugin: 'word-frequency' } })), PAGE],
  'Settings, Plugins, nothing found yet, module off': () => [settingsPart(h(m.PluginsView, { data: { manifests: [], grants: [], books: PLUGINS.books }, moduleOff: true })), PAGE],
  'Settings, Webhooks (active, disabled after failures, revoked; the create form with the include-text warning)': () => [settingsPart(h(m.WebhooksView, { data: WEBHOOKS })), PAGE],
  'Settings, Webhooks, the secret shown once, with an error': () => [settingsPart(h(m.WebhooksView, { data: WEBHOOKS, created: { secret: 'f'.repeat(64), url: 'https://example.com/storyforge' }, error: 'that address is on a private network; tick "allow local network" to send there' })), PAGE],
  'Settings, Webhooks, none yet': () => [settingsPart(h(m.WebhooksView, { data: { webhooks: [], events: [], books: PLUGINS.books }, moduleOff: true })), PAGE],
  'Sign in': () => [h(m.LoginPage, { onSignedIn: noop }), LONE_MAIN],
  'Sign in, owner setup pending': () => [h(m.LoginPage, { needsOwner: true, onSignedIn: noop }), LONE_MAIN],
  'Owner setup (/setup)': () => [h(m.SetupPage, { token: 'a'.repeat(43), onDone: noop }), LONE_MAIN],
  'Owner setup without a link': () => [h(m.SetupPage, { token: null, onDone: noop }), LONE_MAIN],
  'Invitation (/invite)': () => [h(m.InvitePage, { token: 'a'.repeat(43), peek: { role: 'reviewer', expires: 1_800_000_000_000 }, onDone: noop }), LONE_MAIN],
  'Invitation that is not valid': () => [h(m.InvitePage, { token: 'a'.repeat(43), peek: null, onDone: noop }), LONE_MAIN],
  'Share link opening (/s)': () => [h(m.ShareEntry, { onOpened: noop }), LONE_MAIN],
  'Shared book, read only': () => [h(m.ShareReaderPage, { share: { book: BOOK_ID, scope: ['read', 'export'] }, book: d.book, scene: d.scene, sceneId: d.scene.id, onPick: noop, onLeave: noop }), { landmarks: ['banner', 'main', 'complementary'] }],
  'Members and sharing': () => [shell(membersPage(), { bookId: null }), PAGE],
  'Members and sharing with a new link': () => [shell(membersPage({ link: { kind: 'invitation', url: 'http://127.0.0.1:4317/invite#token=abc' } }), { bookId: null }), PAGE],
  'Members and sharing with an error': () => [shell(membersPage({ error: 'the last owner cannot be demoted' }), { bookId: null }), PAGE],
  'Account menu open': () => [h('main', { id: 'main' }, h('h1', null, 'Page'), h(m.UserMenuView, { user: { display_name: 'Ilse', role: 'owner' }, onLogout: noop, defaultOpen: true })), LONE_MAIN],
  'Change password dialog': () => [shell(h(Fragment, null, h(m.LibraryPage, { books: d.books }), h(m.ChangePasswordDialog, { onClose: noop })), { bookId: null }), PAGE],
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
  // ---- M07-J01b
  'Codex of a book in a series (shared badge, Where filter, label chips and filter)': () => [tshell(tcodex({ scope: 'shared' }), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Codex, a shared entry open (series path, notice, Copy into this book)': () => [tshell(tcodex({ selectedId: TIDE.ilse, actions: () => ({ onEdit: noop, onEditText: noop, onCopyIntoBook: noop, onArchive: noop }) }), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Codex, an entry of the book open (Move to series)': () => [tshell(tcodex({ selectedId: TIDE.vessel, actions: () => ({ onEdit: noop, onMoveToSeries: noop }) }), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Edit entry dialog (typed fields, W312 inline, shared notice)': () => [
    tshell(h(Fragment, null, tcodex(), h(m.EditFieldsDialog, { bookId: TIDE.so, entry: { ...T.entries.find((e) => e.id === TIDE.vessel), fields: { Master: 'Captain Pell', Tonnage: 'heavy', Launched: '1891-04-12', 'Home port': '[[port-aldine]]', Rig: 'junk', Cargoes: ['salt', 'tar'] } }, entries: T.entries, types: T.types, labelDefs: defs(), onClose: noop, onPreview: noop })), { tab: 'codex' }),
    WITH_BOOK_ASIDE,
  ],
  'Edit entry dialog (a shared entry)': () => [tshell(h(Fragment, null, tcodex(), h(m.EditFieldsDialog, { bookId: TIDE.so, entry: T.entries.find((e) => e.id === TIDE.ilse), entries: T.entries, types: T.types, labelDefs: defs(), onClose: noop, onPreview: noop })), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'New entry dialog (Where: This book / Series)': () => [tshell(h(Fragment, null, tcodex(), h(m.NewEntryDialog, { bookId: TIDE.so, types: T.types, takenSlugs: new Set(), series: T.series, sharedSlugs: new Set(), onClose: noop, onPreview: noop })), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Preview dialog (shared notice and warnings)': () => [
    tshell(h(Fragment, null, tcodex(), h(m.PreviewDialog, { preview: { title: 'Copy Ilse Hollis into this book', changes: [{ from: null, to: 'tidewater/low-tide/codex/characters/ilse-hollis.md' }], notice: m.SHARED_NOTICE, warnings: ['W309: this entry shadows the series entry ilse-hollis'] }, busy: false, onApply: noop, onCancel: noop })), { tab: 'codex' }),
    WITH_BOOK_ASIDE,
  ],
  'Label manager (book and series)': () => [tshell(h(Fragment, null, tcodex(), h(m.LabelManager, { bookId: TIDE.so, data: T.labels, onClose: noop })), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Save as template dialog': () => [tshell(h(Fragment, null, tcodex(), h(m.SaveAsTemplateDialog, { bookId: TIDE.so, bookTitle: 'Salt Orchard Two', onClose: noop })), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'Link picker (this book, series, other books)': () => [tshell(h(Fragment, null, tcodex(), h(m.LinkPicker, { objects: null, targets: T.targets, selectedText: 'the ledger', onPick: noop, onClose: noop })), { tab: 'codex' }), WITH_BOOK_ASIDE],
  'New book dialog (library templates after the built-in ones)': () => [shell(h(Fragment, null, h(m.LibraryPage, { books: d.books }), h(m.NewBookDialog, { templates: T.templates, series: [{ slug: 'tidewater', title: 'The Tidewater Books' }], penNames: [], onClose: noop })), { bookId: null }), PAGE],
  'Board with label chips and filter': () => [tshell(tplanning('board')), WITH_BOOK_ASIDE],
  'Outline with label chips and filter': () => [tshell(tplanning('outline')), WITH_BOOK_ASIDE],
  'Book problems with the Series badge': () => [tshell(h(m.BookLayout, { book: T.book, activeId: null, inspector: h(m.SceneInspector, { book: T.book, scene: null, diagnostics: { items: T.diagnostics, error: null, loading: false }, objects: T.objects }) }, h('p', null, 'x'))), OVER_PAGE],
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// M08-J04 section 2: the same audit at 1280, 900, 600 and 360 px. A render has no window, so the width is simulated with the ViewportContext the layout reads (the same
// switch the panel drawers use for their media queries); what the stylesheet does at each width is checked in responsive-styles.test.mjs.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const atWidth = (width, el) => h(m.ViewportContext.Provider, { value: width }, el);
const WIDTHS = [
  { width: 1280, cls: 'desktop' },
  { width: 900, cls: 'tablet' },
  { width: 600, cls: 'phone' },
  { width: 360, cls: 'phone' },
];

for (const { width, cls } of WIDTHS) {
  describe(`every core view passes the render-level audit at ${width} px (${cls})`, () => {
    for (const name of Object.keys(VIEWS)) {
      test(name, () => {
        const [el, opts] = VIEWS[name]();
        const markup = html(atWidth(width, el));
        assert.ok(markup.length > 200, `${name} rendered something`);
        assert.deepEqual(audit(markup, opts), []);
      });
    }
  });
}

const sceneEditor = () => h(m.ScenePaper, { book: d.book, scene: d.scene, chapterLabel: 'Chapter One' });
const withDrawer = (openPanel) => shell(h(m.BookLayout, { book: d.book, activeId: d.scene.id, openPanel, inspector: sceneInspector() }, sceneEditor()));
const tagOf = (markup, re) => markup.match(re)?.[0] ?? '';

describe('panel drawers: names, roles and state at each width', () => {
  for (const { width } of WIDTHS) {
    test(`${width} px: both toggles are buttons with aria-expanded=false and aria-controls pointing at their panel, and the panel exists`, () => {
      const markup = html(atWidth(width, withDrawer(null)));
      const root = parseMarkup(markup);
      const nodes = [...walkMarkup(root)];
      for (const [cls, label] of [['rail-toggle', 'Chapters'], ['inspector-toggle', 'Details']]) {
        const b = nodes.find((n) => n.tag === 'button' && n.attrs.class?.split(' ').includes(cls));
        assert.ok(b, `${cls} is drawn`);
        assert.equal(b.attrs['aria-expanded'], 'false');
        assert.match(markup, new RegExp(`<button[^>]*class="${cls} btn"[^>]*>${label}</button>`));
        const panel = nodes.find((n) => n.attrs.id === b.attrs['aria-controls']);
        assert.ok(panel, `${cls} controls an element that exists`);
        assert.equal(panel.attrs['data-open'], 'false');
      }
      assert.deepEqual(audit(markup, WITH_BOOK_ASIDE), []);
    });
  }
  test('an open drawer: the button says aria-expanded=true, only one drawer is open, the page behind is inert and a tap-outside button is drawn (tablet and phone)', () => {
    for (const [width, panel] of [[900, 'inspector'], [600, 'inspector'], [360, 'inspector'], [600, 'rail'], [360, 'rail']]) {
      const markup = html(atWidth(width, withDrawer(panel)));
      const toggle = tagOf(markup, new RegExp(`<button[^>]*class="${panel}-toggle btn"[^>]*>`));
      assert.match(toggle, /aria-expanded="true"/, `${width} ${panel}`);
      assert.equal((markup.match(/data-open="true"/g) ?? []).length, 1, 'one drawer at a time');
      assert.match(markup, /<main id="main"[^>]*inert=""/, 'the text behind an open drawer is inert');
      assert.match(markup, /<button type="button" class="drawer-scrim" aria-label="Close panel" tabindex="-1">/);
      assert.deepEqual(audit(markup, WITH_BOOK_ASIDE), [], `${width} ${panel}`);
    }
  });
  test('where a panel is not an overlay (1280 px; the rail at 900 px) an open flag draws no scrim and makes nothing inert', () => {
    for (const [width, panel] of [[1280, 'rail'], [1280, 'inspector'], [900, 'rail']]) {
      const markup = html(atWidth(width, withDrawer(panel)));
      assert.doesNotMatch(markup, /inert/, `${width} ${panel}`);
      assert.doesNotMatch(markup, /drawer-scrim/, `${width} ${panel}`);
    }
  });
  test('which panels are drawers at which width, and the device class of a width', () => {
    assert.deepEqual(m.drawersAt(1280), { rail: false, inspector: false });
    assert.deepEqual(m.drawersAt(1199), { rail: false, inspector: true });
    assert.deepEqual(m.drawersAt(900), { rail: false, inspector: true });
    assert.deepEqual(m.drawersAt(899), { rail: true, inspector: true });
    assert.deepEqual(m.drawersAt(360), { rail: true, inspector: true });
    assert.deepEqual([1280, 1199, 768, 767, 360].map(m.widthClass), ['desktop', 'tablet', 'tablet', 'phone', 'phone']);
    for (const q of Object.values(m.DRAWER_QUERY)) assert.equal(typeof q, 'string');
    for (const { width } of WIDTHS) {
      assert.equal(m.matchesWidth(m.DRAWER_QUERY.rail, width), m.drawersAt(width).rail, `rail at ${width}`);
      assert.equal(m.matchesWidth(m.DRAWER_QUERY.inspector, width), m.drawersAt(width).inspector, `inspector at ${width}`);
    }
  });
});

describe('the focus trap: where Tab goes inside an open drawer', () => {
  test('wraps from the last control to the first and from the first back to the last, and pulls focus in from outside', () => {
    const { trapTarget } = m;
    assert.equal(trapTarget({ count: 3, index: 2, shift: false }), 0);
    assert.equal(trapTarget({ count: 3, index: 0, shift: true }), 2);
    assert.equal(trapTarget({ count: 3, index: 1, shift: false }), null, 'in the middle the browser moves focus');
    assert.equal(trapTarget({ count: 3, index: 1, shift: true }), null);
    assert.equal(trapTarget({ count: 3, index: -1, shift: false }), 0);
    assert.equal(trapTarget({ count: 3, index: -1, shift: true }), 2);
    assert.equal(trapTarget({ count: 0, index: -1, shift: false }), -1, 'nothing to focus: stay on the drawer itself');
    assert.equal(trapTarget({ count: 1, index: 0, shift: false }), 0);
    assert.equal(trapTarget({ count: 1, index: 0, shift: true }), 0);
  });
  test('Escape, focus return and the trap are wired in useDrawer (no browser here: the source is checked)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/shell/useDrawer.js', import.meta.url), 'utf8');
    assert.match(src, /e\.key === 'Escape'/);
    assert.match(src, /closeRef\.current\(\)/);
    assert.match(src, /trapTarget\(/);
    assert.match(src, /opener\.focus\(/, 'focus returns to the button that opened it');
    assert.match(src, /removeEventListener\('keydown'/);
    const ws = await readFile(new URL('../src/shell/Workspace.jsx', import.meta.url), 'utf8');
    assert.equal((ws.match(/useDrawer\(/g) ?? []).length, 2, 'both drawers use it');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// M08-J04 section 2: keyboard walks at tablet and phone, drawers included. A render cannot press keys, so a walk is: for every step of a flow, the control it needs is
// in the page's tab order at that width (a real, named, focusable element that is not hidden or inert), and when the control lives in a side drawer that is an overlay
// at that width, the drawer's toggle comes first in the tab order, is collapsed, and controls that drawer; with the drawer open the control is in it. The trap, Escape and
// focus return that complete the walk are tested above (trapTarget, useDrawer).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const FOCUSABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);

/** The controls a Tab key visits, in order, at this width: { node, name, panel }. `panel` is 'rail' / 'inspector' when the control is inside a side panel. */
function tabStops(markup, width) {
  const root = parseMarkup(markup);
  const byId = indexIds(root);
  const drawers = m.drawersAt(width);
  const stops = [];
  for (const n of walkMarkup(root)) {
    const focusable = (FOCUSABLE_TAGS.has(n.tag) && !(n.tag === 'a' && n.attrs.href === undefined) && !('disabled' in n.attrs) && !(n.tag === 'input' && n.attrs.type === 'hidden')) || (n.attrs.tabindex !== undefined && Number(n.attrs.tabindex) >= 0);
    if (!focusable || n.attrs.tabindex === '-1') continue;
    let panel = null;
    let blocked = false;
    for (let x = n; x && x.tag; x = x.parent) {
      if (x.attrs['aria-hidden'] === 'true' || 'hidden' in x.attrs || 'inert' in x.attrs) blocked = true;
      const cls = (x.attrs.class ?? '').split(' ');
      for (const which of ['rail', 'inspector']) if (cls.includes(which) && x.tag !== 'button') panel = which;
      if (panel && x.attrs['data-open'] === 'false' && drawers[panel]) blocked = true; // a closed drawer is out of the tab order
    }
    if (!blocked) stops.push({ node: n, name: nameOf(n, byId, root), panel });
  }
  return stops;
}

/**
 * One flow at one width. Each step: { name: RegExp, view: () => element, region?: 'rail' | 'inspector' }.
 * A step with a region is rendered with that drawer open when it is an overlay at this width, and the closed render must offer its toggle.
 */
function walkFlow(width, steps, shellOpts = {}) {
  const drawers = m.drawersAt(width);
  const seen = [];
  for (const step of steps) {
    const view = step.view;
    const closed = tabStops(html(atWidth(width, view(null))), width);
    if (closed[0]?.node.attrs.class !== 'skip-link') seen.push(`${step.name}: the skip link is not the first stop`);
    const overlay = step.region && drawers[step.region];
    const stops = overlay ? tabStops(html(atWidth(width, view(step.region))), width) : closed;
    const hit = stops.find((s) => step.name.test(s.name));
    if (!hit) {
      seen.push(`${width} px: no stop named ${step.name} (${stops.length} stops)`);
      continue;
    }
    if (step.region) assert.equal(hit.panel, step.region, `${step.name} is in the ${step.region}`);
    if (overlay) {
      // closed: the control is not reachable, but its toggle is, collapsed, and it controls the panel the control is in
      assert.ok(!closed.some((s) => step.name.test(s.name)), `${step.name} is out of the tab order while the ${step.region} drawer is closed`);
      const toggle = closed.find((s) => s.node.tag === 'button' && s.node.attrs.class?.includes(`${step.region}-toggle`));
      assert.ok(toggle, `${width} px: the ${step.region} toggle is reachable`);
      assert.equal(toggle.node.attrs['aria-expanded'], 'false');
      const opened = tabStops(html(atWidth(width, view(step.region))), width);
      assert.equal(opened.find((s) => s.node.tag === 'button' && s.node.attrs.class?.includes(`${step.region}-toggle`)).node.attrs['aria-expanded'], 'true');
      assert.ok(closed.indexOf(toggle) < closed.length, 'the toggle is part of the page order');
    }
    assert.ok(hit.name.length > 0);
  }
  assert.deepEqual(seen, [], shellOpts.label ?? '');
}

describe('keyboard walks at tablet and phone widths (drawers included)', () => {
  const book = (openPanel, body = sceneEditor()) => shell(h(m.BookLayout, { book: d.book, activeId: d.scene.id, openPanel, inspector: sceneInspector() }, body));
  const flowBook = () => [
    // create a book
    { name: /^New book/, view: () => shell(h(m.LibraryPage, { books: d.books, library: { root: 'C:\\Books' } }), { bookId: null }) },
    // write: open a scene from the chapters rail, which is a drawer on a phone
    { name: new RegExp(`^${d.scene.title}`), region: 'rail', view: (open) => book(open) },
    // add a scene, reorder (the row menu holds Move up / Move down; Alt+Arrow keys do the same), both in the rail
    { name: /^Add scene to /, region: 'rail', view: (open) => book(open) },
    { name: /^More actions for /, region: 'rail', view: (open) => book(open) },
    // export is in the top bar
    { name: /^Export/, view: () => book(null) },
  ];
  const codex = (extra = {}) => h(m.CodexPage, { bookId: BOOK_ID, types: d.types, entries: d.entries, chapters: d.chapters, typeKey: 'all', ...extra });
  const flowCodex = () => [
    { name: new RegExp(d.entries[0].name), view: () => shell(codex(), { tab: 'codex' }) },
    { name: /^Edit fields/, view: () => shell(codex({ selectedId: d.entries[0].id, actions: () => ({ onEdit: noop }) }), { tab: 'codex' }) },
    { name: /^Preview$/, view: () => shell(h(Fragment, null, codex(), h(m.EditFieldsDialog, { bookId: BOOK_ID, entry: d.entries[0], entries: d.entries, types: d.types, labelDefs: [], onClose: noop, onPreview: noop })), { tab: 'codex' }) },
    { name: /^Apply/, view: () => shell(h(Fragment, null, codex(), h(m.PreviewDialog, { preview: { title: 'Edit', changes: [{ from: null, to: 'x.md' }], warnings: [] }, busy: false, onApply: noop, onCancel: noop })), { tab: 'codex' }) },
  ];
  for (const { width, cls } of WIDTHS.filter((w) => w.cls !== 'desktop')) {
    test(`${width} px (${cls}): create book, write, add scene, reorder, export`, () => walkFlow(width, flowBook(), { label: 'book flow' }));
    test(`${width} px (${cls}): open a Codex entry, edit, save`, () => walkFlow(width, flowCodex(), { label: 'codex flow' }));
  }
  test('every tab stop at 360 px has a name, none has a positive tabindex, and the Chapters and Details toggles are stops in that order', () => {
    const stops = tabStops(html(atWidth(360, book(null))), 360);
    assert.ok(stops.length > 8);
    for (const s of stops) assert.ok(s.name.length > 0, `${s.node.tag} ${s.node.attrs.class ?? ''} has a name`);
    const at = (cls) => stops.findIndex((s) => s.node.attrs.class?.includes(cls));
    assert.ok(at('rail-toggle') > -1 && at('inspector-toggle') > -1);
    assert.ok(at('rail-toggle') < at('inspector-toggle'), 'Chapters, then Details');
    assert.equal(stops[0].node.attrs.class, 'skip-link', 'the skip link is the first stop');
  });
});

describe('screen-reader semantics: live regions are present and polite', () => {
  const polite = (markup, testid) => {
    const tag = tagOf(markup, new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`));
    assert.ok(tag, `${testid} is drawn`);
    assert.match(tag, /role="status"/);
    assert.match(tag, /aria-live="polite"/);
  };
  test('drawer open/close has its own polite status region in the workspace, at every width', () => {
    for (const { width } of WIDTHS) polite(html(atWidth(width, shell(layout(h('h1', null, 'x'))))), 'drawer-live');
  });
  test('the drawer announcement says which panel opened or closed', () => {
    assert.equal(m.drawerAnnouncement('Details', true), 'Details panel opened');
    assert.equal(m.drawerAnnouncement('Chapters', false), 'Chapters panel closed');
  });
  test('save state, toasts, and the board and rail move announcements are polite', () => {
    const markup = html(shell(planning('board')));
    assert.match(markup, /<div id="toast-stack" class="toast-stack" role="status" aria-live="polite"/);
    polite(markup, 'board-live');
    polite(markup, 'move-live');
    assert.match(markup, /<span role="status" class="save-status" data-state="[a-z-]+">/);
  });
  test('the timer is read out through a polite region', () => {
    const markup = html(h(m.TimerRunning, { timer: RUNNING, here: true, onPause: noop, onResume: noop, onFinish: noop, onAbandon: noop }));
    assert.match(markup, /role="(timer|status)"|aria-live="polite"/);
    assert.doesNotMatch(markup, /aria-live="assertive"/);
  });
  test('the offline bar is a polite status region that is there before it has anything to say, and names the count', () => {
    assert.match(html(h(m.OfflineBarView, { count: 0 })), /role="status" aria-live="polite"/);
    assert.match(html(h(m.OfflineBarView, { count: 2 })), /Offline: 2 scenes waiting to save/);
    assert.match(html(h(m.OfflineBarView, { count: 1 })), /Offline: 1 scene waiting to save/);
    const page = h('main', { id: 'main' }, h('h1', null, 'x'), h(m.OfflineBarView, { count: 2, notice: { saved: 1, stale: [{ bookId: BOOK_ID, sceneId: 's1' }] }, onDismiss: noop }));
    assert.deepEqual(audit(html(page), { landmarks: ['main'] }), []);
  });
  test('the editor names its text area (aria-label) and describes its status through a polite line', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/editor/SceneEditorPage.jsx', import.meta.url), 'utf8');
    assert.match(src, /'aria-label': resource\?\.label \?\? 'Scene text'/);
    assert.match(src, /aria-live="polite"/, 'the word count line is polite');
    assert.match(src, /role="status"/, 'offline and queued notices are status regions');
  });
});

describe('the offline queue is a browser-only store: no server, core, export or format source can see it', () => {
  test('no source outside the web app mentions the queue or its database', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const walkDir = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'test') continue;
        const f = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walkDir(f)));
        else if (/\.(mjs|js)$/.test(e.name)) out.push(f);
      }
      return out;
    };
    const files = [];
    for (const dir of ['packages', 'apps/server/src']) files.push(...(await walkDir(join(root, dir))));
    assert.ok(files.length > 20);
    for (const f of files) assert.doesNotMatch(await readFile(f, 'utf8'), /offline-queue|storyforge-offline-queue/i, f);
  });
});

describe('reviewer mode: the controls follow the role', () => {
  test('a reviewer suggestion shows its source and who made it, and offers neither Accept nor Decline without handlers', () => {
    const markup = html(h(m.SuggestionReview, { suggestion: { ...d.suggestion, source: 'reviewer', by: { id: 'usr_1', name: 'Mara' } } }));
    assert.match(markup, /Reviewer/);
    assert.match(markup, /Mara/);
    assert.doesNotMatch(markup, />Accept</);
    assert.doesNotMatch(markup, />Decline</);
    const editor = html(h(m.SuggestionReview, { suggestion: d.suggestion, handlers: { onAccept: noop, onDecline: noop, onAcceptAll: noop, onDeclineAll: noop } }));
    assert.match(editor, />Accept</);
  });
  test('the thread offers Resolve and Reply only to people who may comment', () => {
    const can = html(h(m.CommentList, { comments: COMMENTS, canComment: true }));
    const cannot = html(h(m.CommentList, { comments: COMMENTS, canComment: false }));
    assert.match(can, />Resolve</);
    assert.match(can, /Reply to comment 1/);
    assert.doesNotMatch(cannot, />Resolve</);
    assert.doesNotMatch(cannot, /<textarea/);
    assert.match(cannot, /half under water/, 'the comments themselves are still readable');
    assert.match(can, /cannot be shown in place/, 'a comment whose text changed says so');
  });
  test('the stale panel names what happened, offers Review only when allowed, and never offers to overwrite', () => {
    const el = (canReview, conflict = STALE) => html(h(m.StalePanel, { snapshot: staleSnapshot(conflict), title: 'Arrival', canReview, onReview: noop, onUseCurrent: noop }));
    assert.match(el(true), /Your text was not lost/);
    assert.match(el(true), /Review my changes/);
    assert.doesNotMatch(el(false), /Review my changes/);
    assert.match(el(false), /An editor can merge/);
    assert.doesNotMatch(el(true), /Keep mine|Overwrite/);
    assert.match(el(true, { ...STALE, suggestionId: null }), /still here/);
  });
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
