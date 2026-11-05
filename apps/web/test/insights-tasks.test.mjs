// M07-J02 acceptance 5 (render and flow tests, no browser): Insights (sections, "Show as table" on every chart, progress bars, the heat map reachable by keyboard and its cell
// opening scene links) and Tasks (the list, one task opened, "Open" selecting the quote, "Mark done"), Make a task on findings, the second nav, and the timer panel.
// The render-level accessibility audit of these views is in a11y-audit.test.mjs. Real repository answers (a copy of salt-orchard plus one task from the CF1 finding).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { copyFixture } from '../../server/test/helpers.mjs';
import { ARRIVAL, BOOK, CF1 } from '../../server/test/suggest-helpers.mjs';
import { audit } from './a11y-check.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const m = {};
const d = {};
const clone = (o) => JSON.parse(JSON.stringify(o));
const noop = () => {};
const html = (el) => renderToStaticMarkup(el);
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (markup) => decode(markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
const hrefs = (markup) => [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((x) => decode(x[1]));
const buttons = (markup) => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((x) => ({ attrs: x[1], text: text(x[2]) }));

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of [
    '/src/insights/InsightsPage.jsx', '/src/insights/charts.jsx', '/src/insights/GoalsPanel.jsx', '/src/insights/model.js', '/src/tasks/TasksPage.jsx', '/src/tasks/model.js', '/src/tasks/MakeTaskButton.jsx',
    '/src/writing/TimerPanel.jsx', '/src/shell/MoreNav.jsx', '/src/shell/ProjectNav.jsx', '/src/shell/AppShell.jsx', '/src/routes.js', '/src/continuity/ContinuityPage.jsx', '/src/suggestions/CheckReport.jsx',
  ]) Object.assign(m, { [p]: await vite.ssrLoadModule(p) });
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    d.made = await repo.createTask(BOOK, { from: 'continuity', fingerprint: CF1 });
    d.insights = clone((await repo.getInsights(BOOK)).insights);
    d.tasks = clone(await repo.listTasks(BOOK));
    d.opened = clone(await repo.getTask(BOOK, d.made.id));
    d.codex = clone(await repo.listCodexEntries(BOOK));
    d.continuity = clone(await repo.getContinuity(BOOK));
    d.check = clone(await repo.checkScene(BOOK, ARRIVAL));
    d.books = clone(await repo.listBooks());
  } finally {
    await repo.close?.();
  }
});
after(async () => {
  await vite?.close();
});
const mod = (p) => m[p];
const page = (props) => html(h(mod('/src/insights/InsightsPage.jsx').InsightsPage, { bookId: BOOK, data: d.insights, ...props }));
const tasksPage = (props) => html(h(mod('/src/tasks/TasksPage.jsx').TasksPage, { bookId: BOOK, data: d.tasks, ...props }));

describe('routes and navigation', () => {
  test('/books/:id/insights and /tasks are tabs; their hrefs parse back; the project tabs are untouched (M09-J01 added Canvas after Notes)', () => {
    const { parseRoute, tabHref, PROJECT_TABS, MORE_TABS } = mod('/src/routes.js');
    assert.deepEqual(parseRoute(`/books/${BOOK}/insights`), { name: 'tab', bookId: BOOK, tab: 'insights' });
    assert.deepEqual(parseRoute(`/books/${BOOK}/tasks`, '?task=x'), { name: 'tab', bookId: BOOK, tab: 'tasks' });
    assert.equal(tabHref(BOOK, 'insights'), `/books/${BOOK}/insights`);
    assert.equal(tabHref(BOOK, 'tasks'), `/books/${BOOK}/tasks`);
    assert.deepEqual(PROJECT_TABS.map((t) => t.key), ['manuscript', 'codex', 'timeline', 'continuity', 'places', 'notes', 'canvas']);
    assert.deepEqual(MORE_TABS.map((t) => t.label), ['Insights', 'Tasks']);
    assert.equal(parseRoute(`/books/${BOOK}/nope`).name, 'notfound');
  });

  test('the shell has the project nav (seven links) and a second, named nav with Insights and Tasks; aria-current marks the active one', () => {
    const shell = (tab) => html(h(mod('/src/shell/AppShell.jsx').AppShell, { books: d.books, bookId: BOOK, tab }, h('main', { id: 'main' }, h('h1', null, 'x'))));
    const markup = shell('insights');
    assert.equal([...markup.matchAll(/<nav\b[^>]*aria-label="Project"/g)].length, 1);
    const more = /<nav[^>]*aria-label="Insights and tasks"[\s\S]*?<\/nav>/.exec(markup)[0];
    assert.deepEqual(hrefs(more), [`/books/${BOOK}/insights`, `/books/${BOOK}/tasks`]);
    assert.equal([...more.matchAll(/aria-current="page"/g)].length, 1);
    assert.match(more, /aria-current="page"[^>]*>Insights</);
    assert.match(shell('tasks'), /aria-current="page"[^>]*>Tasks</);
    assert.deepEqual(audit(markup, { landmarks: ['banner', 'navigation', 'main'] }).filter((x) => /nav|name/i.test(x)), []);
  });

  test('with no timer running the nav chip draws nothing', () => {
    assert.equal(html(h(mod('/src/writing/TimerPanel.jsx').TimerChip, { insightsHref: '/x' })), '');
  });
});

describe('Insights page', () => {
  test('sections in order, a Show as table button on every chart (not pressed), and the numbers of the book', () => {
    const markup = page();
    const headings = [...markup.matchAll(/<h([123])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((x) => `h${x[1]} ${text(x[2])}`);
    assert.deepEqual(headings.filter((x) => x.startsWith('h1') || x.startsWith('h2')), ['h1 Insights', 'h2 Progress', 'h2 Manuscript', 'h2 Story', 'h2 Revision tasks']);
    for (const t of ['Words per chapter', 'Words per scene', 'Scenes by status', 'Scenes by label', 'Point of view, by words', 'Character appearances by chapter', 'Relationships per character']) {
      assert.ok(headings.includes(`h3 ${t}`), t);
    }
    const asTable = buttons(markup).filter((b) => b.text === 'Show as table');
    assert.ok(asTable.length >= 5, `chart toggles: ${asTable.length}`);
    for (const b of asTable) assert.match(b.attrs, /aria-pressed="false"/);
    assert.match(text(markup), /The Salt Orchard: 211 of 90,000 words in 7 scenes/);
    assert.deepEqual(audit(markup, { page: false, landmarks: ['main'] }), []);
  });

  test('every chart can be shown as a table with the same numbers (ChartFrame, DataTable, the model rows)', () => {
    const { ChartFrame, DataTable } = mod('/src/insights/charts.jsx');
    const { chapterRows, statusRows, heatTable } = mod('/src/insights/model.js');
    const rows = chapterRows(d.insights);
    assert.deepEqual(rows.map((r) => r[1]).reduce((a, b) => a + b, 0), d.insights.book.words, 'the words per chapter add up to the book');
    assert.equal(statusRows(d.insights).reduce((n, r) => n + r[1], 0), d.insights.book.scenes);
    const frame = html(h(ChartFrame, { id: 'c', title: 'Words per chapter', chart: h('svg'), table: h(DataTable, { caption: 'Words and scenes in each chapter', head: ['Chapter', 'Words', 'Scenes', 'Final'], rows }), defaultTable: true }));
    assert.match(frame, /<table class="ins-table">/);
    assert.match(frame, /<caption[^>]*>Words and scenes in each chapter<\/caption>/);
    assert.equal([...frame.matchAll(/<tr>/g)].length, rows.length + 1);
    assert.ok(!frame.includes('<svg'), 'the table replaces the picture');
    assert.match(frame, /aria-pressed="true"[^>]*>Show as chart</);
    const heat = heatTable(d.insights);
    assert.deepEqual(heat.head.at(-1), 'Total');
    for (const r of heat.rows) assert.equal(r.slice(1, -1).reduce((a, b) => a + b, 0), r.at(-1));
    assert.deepEqual(audit(frame, { page: false, landmarks: [] }), []);
  });

  test('an empty chart says why instead of drawing nothing', () => {
    const { ChartFrame } = mod('/src/insights/charts.jsx');
    const markup = html(h(ChartFrame, { id: 'c', title: 'Plot threads by chapter', empty: 'No plot threads yet.', chart: h('svg'), table: h('table') }));
    assert.match(markup, /No plot threads yet\./);
    assert.equal(buttons(markup).length, 0);
  });

  test('goals: each has a progress bar with its numbers in aria; the legacy goal is badged and cannot be removed; a due date shows the projection', () => {
    const goals = [
      { id: 'daily_word_goal', legacy: true, kind: 'words', period: 'day', target: 500, value: 320, percent: 64, met: false, streak: 3, scope: null, scope_found: true, scope_name: null, due: null, projected_finish: null, on_track: null, reached: false },
      { id: 'g2', legacy: false, kind: 'words', period: 'total', target: 90000, value: 211, percent: 0, met: false, streak: 0, scope: null, scope_found: true, scope_name: null, due: '2027-03-01', projected_finish: '2027-09-01', on_track: false, reached: false },
    ];
    const markup = page({ data: { ...d.insights, progress: { ...d.insights.progress, goals } }, goalHandlers: { onAdd: noop, onRemove: noop } });
    const bars = [...markup.matchAll(/role="progressbar"([^>]*)>/g)].map((x) => x[1]);
    assert.equal(bars.length, 2);
    assert.match(bars[0], /aria-valuemin="0"/);
    assert.match(bars[0], /aria-valuemax="500"/);
    assert.match(bars[0], /aria-valuenow="320"/);
    assert.match(bars[0], /aria-valuetext="320 of 500 words today"/);
    assert.match(bars[1], /aria-valuetext="211 of 90,000 words so far"/);
    const t = text(markup);
    assert.match(t, /From book\.md/);
    assert.match(t, /streak 3 days/);
    assert.match(t, /At your pace of the last 30 days: 2027-09-01, after the due date\./);
    const removes = buttons(markup).filter((b) => /^Remove/.test(b.text));
    assert.equal(removes.length, 1, 'only the goal in goals.md can be removed');
    assert.ok(buttons(markup).some((b) => b.text === 'Add a goal'));
  });
});

describe('keyboard walk: Insights to a heat-map cell to a scene', () => {
  test('heat-map cells are real links, exactly one is in the tab order, and arrows move between the cells that have scenes', () => {
    const markup = page();
    const cells = [...markup.matchAll(/<a\b([^>]*\bdata-cell="[^"]*"[^>]*)>/g)].map((x) => x[1]);
    assert.ok(cells.length > 0, 'the heat map has cells with scenes');
    for (const c of cells) assert.match(c, /href="\/books\/[^"]*\/insights\?cell=/);
    assert.equal(cells.filter((c) => /tabindex="0"/.test(c)).length, 1);
    assert.equal(cells.filter((c) => /tabindex="-1"/.test(c)).length, cells.length - 1);
    assert.ok(cells.every((c) => /aria-label="[^"]+: \d+ scenes?"/.test(c)), 'each cell is named: character, chapter, scenes');
    assert.ok(!/tabindex="[1-9]/.test(markup), 'no positive tabindex');
    const { nextCell, firstCell } = mod('/src/insights/model.js');
    const grid = [[0, 2, 0, 1], [1, 0, 0, 3], [0, 0, 0, 0], [0, 4, 0, 0]];
    assert.deepEqual(firstCell(grid), { row: 0, col: 1 });
    assert.deepEqual(nextCell(grid, 0, 1, 'ArrowRight'), { row: 0, col: 3 });
    assert.equal(nextCell(grid, 0, 3, 'ArrowRight'), null);
    assert.deepEqual(nextCell(grid, 0, 1, 'ArrowDown'), { row: 1, col: 0 }, 'nearest cell with scenes in the next row');
    assert.deepEqual(nextCell(grid, 1, 3, 'ArrowDown'), { row: 3, col: 1 }, 'rows with nothing are skipped');
    assert.deepEqual(nextCell(grid, 3, 1, 'ArrowUp'), { row: 1, col: 0 });
    assert.deepEqual(nextCell(grid, 1, 0, 'End'), { row: 1, col: 3 });
    assert.deepEqual(nextCell(grid, 1, 3, 'Home'), { row: 1, col: 0 });
    assert.equal(nextCell(grid, 1, 0, 'Home'), null);
    assert.equal(nextCell(grid, 0, 1, 'a'), null);
  });

  test('a cell opens a URL that selects it; the page then names its scenes as links to them; those links parse back to the scene', async () => {
    const { parseRoute } = mod('/src/routes.js');
    const { parseInsightsSearch } = mod('/src/insights/model.js');
    const first = [...page().matchAll(/<a\b[^>]*\bdata-cell="[^"]*"[^>]*\bhref="([^"]*)"/g)][0] ?? [...page().matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*\bdata-cell=/g)][0];
    const href = decode(first[1]);
    const url = new URL(href, 'http://x');
    assert.deepEqual(parseRoute(url.pathname, url.search), { name: 'tab', bookId: BOOK, tab: 'insights' });
    const cell = parseInsightsSearch(url.search);
    assert.ok(cell && cell.id.startsWith('entry_'));
    const markup = page({ cell, entries: d.codex.entries, entryChapters: d.codex.chapters });
    const region = /<div class="ins-cell-detail"[\s\S]*?<\/div>/.exec(markup);
    assert.ok(region, 'the selected cell has a detail region');
    assert.match(region[0], /role="region"/);
    const links = hrefs(region[0]);
    const sceneLinks = links.filter((x) => /\?scene=/.test(x));
    assert.ok(sceneLinks.length > 0, 'at least one scene link');
    for (const l of sceneLinks) {
      const u = new URL(l, 'http://x');
      const route = parseRoute(u.pathname, u.search);
      assert.equal(route.name, 'book');
      assert.ok(route.sceneId.startsWith('scene_'));
    }
    assert.ok(links.some((x) => x.includes('/codex?entry=')), 'and a link to the entry in the Codex');
    assert.match(markup, /aria-current="true"/);
    assert.deepEqual(audit(region[0], { page: false, landmarks: [] }), []);
  });

  test('the bars link to their source: a status bar opens the outline filtered to that status, a chapter column the outline, a scene column the scene', () => {
    const l = hrefs(page());
    assert.ok(l.includes(`/books/${BOOK}?view=outline&status=drafting`));
    assert.ok(l.includes(`/books/${BOOK}?view=outline`));
    assert.ok(l.some((x) => x === `/books/${BOOK}?scene=${ARRIVAL}`));
    assert.ok(l.some((x) => x.includes('/codex?entry=entry_')));
  });
});

describe('Tasks page', () => {
  test('the list: one row in the tab order, the opened row marked current, counts in the sidebar, status/source/label filters', () => {
    const markup = tasksPage({ selectedId: d.made.id, opened: d.opened });
    const rows = [...markup.matchAll(/<button\b([^>]*\bcf-row[^>]*)>/g)].map((x) => x[1]);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /tabindex="0"/);
    assert.match(rows[0], /aria-current="true"/);
    const t = text(markup);
    assert.match(t, /All 1/);
    assert.match(t, /Open 1/);
    assert.match(t, /Done 0/);
    assert.ok(markup.includes('aria-label="Source"') && markup.includes('aria-label="Label"'));
    assert.match(t, /Maren Hollis: Eyes Grey in the codex, green in the text/);
  });

  test('an opened task: its status actions, the finding, notes with the evidence, and an Open link that selects the quote in the scene', () => {
    const { parseRoute } = mod('/src/routes.js');
    const { parseSelect, openTargetHref, statusActions } = mod('/src/tasks/model.js');
    const markup = tasksPage({ selectedId: d.made.id, opened: d.opened, handlers: { onStatus: noop, onNew: noop } });
    assert.deepEqual(buttons(markup).filter((b) => ['Start', 'Mark done', 'Drop'].includes(b.text)).map((b) => b.text), ['Start', 'Mark done', 'Drop']);
    assert.ok(markup.includes(CF1));
    assert.match(text(markup), /green eyes ringed with salt/);
    const open = [...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*aria-label="(Open[^"]*)"/g)];
    assert.equal(open.length, 1);
    assert.match(open[0][2], /at the text/);
    const url = new URL(decode(open[0][1]), 'http://x');
    const route = parseRoute(url.pathname, url.search);
    assert.deepEqual([route.name, route.sceneId], ['book', ARRIVAL]);
    const sel = parseSelect(url.search);
    const sceneBody = d.opened.targets[0].selection;
    assert.deepEqual(sel, { from: sceneBody.from, to: sceneBody.to });
    assert.equal(url.searchParams.get('line'), String(sceneBody.line));
    assert.match(text(markup), /line 17: “green eyes”/);
    assert.deepEqual(statusActions('open').map((a) => a.to), ['doing', 'done', 'dropped']);
    assert.deepEqual(statusActions('done').map((a) => a.to), ['open']);
    assert.equal(openTargetHref(BOOK, { id: 'x', kind: null, found: false, selection: null }), null, 'a target that is gone has no Open');
  });

  test('tasks are a board of cards; the opened task is in a dialog with a close button, and nothing opened means no dialog', () => {
    const closed = tasksPage({});
    assert.match(closed, /<ul[^>]*class="nt-board cf-list"/);
    assert.ok(!/role="dialog"/.test(closed));
    const open = tasksPage({ selectedId: d.made.id, opened: d.opened });
    assert.match(open, /role="dialog"[^>]*aria-modal="true"/);
    assert.match(open, /<button[^>]*aria-label="Close task"/);
  });

  test('a target whose quote cannot be found opens the scene with a notice, and says so on the page', () => {
    const { openTargetHref, noticeText } = mod('/src/tasks/model.js');
    const opened = clone(d.opened);
    opened.targets[0] = { ...opened.targets[0], found: false, reason: 'not_found', selection: null, message: 'The quote can no longer be found in the scene. It was probably reworded. The scene is open.' };
    const markup = tasksPage({ selectedId: d.made.id, opened });
    assert.match(text(markup), /can no longer be found in the scene/);
    const href = openTargetHref(BOOK, opened.targets[0]);
    assert.match(href, new RegExp(`\\?scene=${ARRIVAL}&notice=quote-not-found$`));
    assert.match(noticeText(new URL(href, 'http://x').search), /can no longer be found in this scene/);
    assert.equal(noticeText('?x=1'), null);
  });

  test('flow: Tasks, one task, Open, Mark done: the requests and URLs of each step', () => {
    const { tasksPageHref, parseTasksSearch, statusRequest, taskUrl, filterTasks, createTaskRequest } = mod('/src/tasks/model.js');
    const href = tasksPageHref(BOOK, d.made.id);
    assert.deepEqual(parseTasksSearch(new URL(href, 'http://x').search), { task: d.made.id, status: null });
    assert.equal(taskUrl(BOOK, d.made.id), `/api/books/${BOOK}/tasks/${d.made.id}`);
    assert.deepEqual(statusRequest(BOOK, d.made.id, 'done'), { method: 'POST', url: `/api/books/${BOOK}/tasks/${d.made.id}/status`, body: { status: 'done' } });
    assert.equal(createTaskRequest(BOOK, { title: 'x' }).url, `/api/books/${BOOK}/tasks`);
    const tasks = [{ id: 'a', status: 'open', source: { kind: 'manual' }, labels: ['Eyes'] }, { id: 'b', status: 'done', source: { kind: 'continuity' }, labels: [] }];
    assert.deepEqual(filterTasks(tasks, { status: 'done' }).map((t) => t.id), ['b']);
    assert.deepEqual(filterTasks(tasks, { source: 'manual' }).map((t) => t.id), ['a']);
    assert.deepEqual(filterTasks(tasks, { label: 'eyes' }).map((t) => t.id), ['a']);
    assert.deepEqual(filterTasks(tasks).map((t) => t.id), ['a', 'b']);
    assert.deepEqual(parseTasksSearch('?status=weird'), { task: null, status: null });
  });

  test('no tasks: the page says how to make one, and the New task dialog is a named, modal form', () => {
    const empty = tasksPage({ data: { tasks: [], counts: { open: 0, doing: 0, done: 0, dropped: 0, total: 0 }, labels: [] }, handlers: { onNew: noop } });
    assert.match(text(empty), /Make a task from a continuity finding or an author check, or press New task/);
    const dialog = html(h(mod('/src/tasks/TasksPage.jsx').NewTaskDialog, { onSubmit: noop, onClose: noop }));
    assert.match(dialog, /role="dialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /<label[^>]*>What needs doing\?<\/label>/);
  });
});

describe('Make a task', () => {
  test('a continuity finding has Make a task; an acknowledged one does not', () => {
    const { FindingDetail } = mod('/src/continuity/ContinuityPage.jsx');
    const finding = d.continuity.findings[0];
    const markup = html(h(FindingDetail, { bookId: BOOK, finding, handlers: { onAcknowledge: noop } }));
    assert.ok(buttons(markup).some((b) => b.text === 'Make a task'));
    const acknowledged = html(h(FindingDetail, { bookId: BOOK, finding: { ...finding, exception: { file: 'planning/continuity/x.md', slug: 'x' } }, handlers: {} }));
    assert.ok(!buttons(acknowledged).some((b) => b.text === 'Make a task'));
  });

  test('the check report offers it where the report is opened from the editor (makeTask) and stays button-free elsewhere', () => {
    const { CheckReport } = mod('/src/suggestions/CheckReport.jsx');
    const plain = html(h(CheckReport, { bookId: BOOK, report: d.check }));
    assert.equal(buttons(plain).length, 0);
    const withTask = html(h(CheckReport, { bookId: BOOK, report: d.check, makeTask: true }));
    assert.equal(buttons(withTask).filter((b) => b.text === 'Make a task').length, d.check.findings.length);
    assert.deepEqual(audit(withTask, { page: false, landmarks: [] }).filter((x) => /name/i.test(x) && !/share the accessible name/.test(x)), []);
  });
});

describe('timer panel', () => {
  test('idle: kind, minutes and (for a sprint) a word target are labelled; Start is a button', () => {
    const markup = html(h(mod('/src/writing/TimerPanel.jsx').TimerPanel, { bookId: BOOK }));
    assert.match(markup, /<legend class="sr-only">Kind<\/legend>/);
    assert.equal([...markup.matchAll(/type="radio"/g)].length, 2);
    assert.match(markup, /<label[^>]*>Minutes<\/label>/);
    assert.match(markup, /<label[^>]*>Word target \(optional\)<\/label>/);
    assert.ok(buttons(markup).some((b) => b.text === 'Start'));
    assert.deepEqual(audit(`<main id="main"><h1>T</h1><h2>Progress</h2>${markup}</main>`, { page: false, landmarks: ['main'] }), []);
  });

  test('running: the time left is a named timer, with Pause (Resume when paused), Finish now and Abandon; the clock is not a live region', () => {
    const { TimerRunning } = mod('/src/writing/TimerPanel.jsx');
    const timer = { kind: 'sprint', bookId: BOOK, status: 'running', startedAt: 0, plannedMs: 1_500_000, activeMs: 300_000, lastAt: 0, wordTarget: 300, scenes: [], announced: 20 };
    const markup = html(h(TimerRunning, { timer, here: true, onPause: noop, onResume: noop, onFinish: noop, onAbandon: noop }));
    assert.match(markup, /<span role="timer" aria-label="Time left">20:00<\/span>/);
    assert.ok(!/aria-live/.test(markup), 'minutes are announced in the shared live region, not here');
    assert.deepEqual(buttons(markup).map((b) => b.text), ['Pause', 'Finish now', 'Abandon']);
    const paused = html(h(TimerRunning, { timer: { ...timer, status: 'paused' }, here: true, onPause: noop, onResume: noop, onFinish: noop, onAbandon: noop }));
    assert.deepEqual(buttons(paused).map((b) => b.text), ['Resume', 'Finish now', 'Abandon']);
    assert.match(text(paused), /paused/);
  });
});
