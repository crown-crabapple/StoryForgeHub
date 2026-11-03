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
import { BOOK as BOOK_ID, withSuggestion } from '../../server/test/suggest-helpers.mjs';
import { audit } from './a11y-check.mjs';

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
