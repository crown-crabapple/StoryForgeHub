// M03-J04 acceptance 6 (focus mode: pure logic) and the pure half of 7 (goal card numbers, session tracker).
// Render tests (rail, focus layout) are below the pure ones. Fake clock and timers; no browser, no network.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import {
  DEFAULT_FOCUS_OPTIONS,
  DIM_OPACITY,
  FOCUS_OPTIONS_KEY,
  TYPEWRITER_RATIO,
  focusKeyAction,
  paragraphBounds,
  readFocusOptions,
  typewriterDelta,
  writeFocusOptions,
} from '../src/writing/focus.js';
import { applyWords, goalLine, goalPercent, parseGoal, signed, streakLabel } from '../src/writing/goal.js';
import { IDLE_MS, createSessionTracker } from '../src/writing/session-tracker.js';
import { SAFETY_NOTE, newestFirst, revisionSummary, whenLabel } from '../src/writing/revisions.js';
import { bodyLinkRefs, bookProgress, chapterProgress, sceneLinkItems, sceneNoteList } from '../src/writing/scene-context.js';

// ------------------------------------------------------------------ focus keymap

const webDir = fileURLToPath(new URL('..', import.meta.url));
const key = (k, mods = {}) => ({ key: k, ...mods });

test('focus keymap: Ctrl+Shift+F and Cmd+Shift+F toggle, in either case, whether or not focus is on', () => {
  for (const focus of [false, true]) {
    assert.equal(focusKeyAction(key('F', { ctrlKey: true, shiftKey: true }), { focus }), 'toggle');
    assert.equal(focusKeyAction(key('f', { ctrlKey: true, shiftKey: true }), { focus }), 'toggle');
    assert.equal(focusKeyAction(key('F', { metaKey: true, shiftKey: true }), { focus }), 'toggle');
  }
});

test('focus keymap: F without Shift, without Ctrl/Cmd, or with Alt is not the shortcut', () => {
  const st = { focus: false };
  assert.equal(focusKeyAction(key('f', { ctrlKey: true }), st), null);
  assert.equal(focusKeyAction(key('F', { shiftKey: true }), st), null);
  assert.equal(focusKeyAction(key('f'), st), null);
  assert.equal(focusKeyAction(key('F', { ctrlKey: true, shiftKey: true, altKey: true }), st), null);
  assert.equal(focusKeyAction(key('g', { ctrlKey: true, shiftKey: true }), st), null);
});

test('focus keymap: Escape exits only while focus mode is on', () => {
  assert.equal(focusKeyAction(key('Escape'), { focus: true }), 'exit');
  assert.equal(focusKeyAction(key('Escape'), { focus: false }), null);
});

test('focus keymap: nothing happens while a dialog is open (Escape belongs to the dialog), not even the shortcut', () => {
  assert.equal(focusKeyAction(key('Escape'), { focus: true, dialogOpen: true }), null);
  assert.equal(focusKeyAction(key('F', { ctrlKey: true, shiftKey: true }), { focus: true, dialogOpen: true }), null);
  assert.equal(focusKeyAction(key('F', { ctrlKey: true, shiftKey: true }), { focus: false, dialogOpen: true }), null);
});

test('focus keymap: ordinary typing keys are never claimed', () => {
  for (const k of ['a', 'Enter', 'Tab', 'Backspace', ' ', 'ArrowDown']) {
    assert.equal(focusKeyAction(key(k), { focus: true }), null, k);
  }
});

// ------------------------------------------------------------------ focus options (safe storage)

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

test('focus options: defaults are both off', () => {
  assert.deepEqual(DEFAULT_FOCUS_OPTIONS, { typewriter: false, dim: false });
  assert.deepEqual(readFocusOptions(memoryStorage()), { typewriter: false, dim: false });
});

test('focus options: write then read round-trips, under the documented key', () => {
  const s = memoryStorage();
  writeFocusOptions(s, { typewriter: true, dim: false });
  assert.ok(FOCUS_OPTIONS_KEY in s.data);
  assert.deepEqual(readFocusOptions(s), { typewriter: true, dim: false });
  writeFocusOptions(s, { typewriter: true, dim: true });
  assert.deepEqual(readFocusOptions(s), { typewriter: true, dim: true });
});

test('focus options: only booleans are stored; stray values and extra keys are ignored on read', () => {
  const s = memoryStorage({ [FOCUS_OPTIONS_KEY]: JSON.stringify({ typewriter: 'yes', dim: 1, extra: 'x' }) });
  assert.deepEqual(readFocusOptions(s), { typewriter: false, dim: false });
  const t = memoryStorage();
  writeFocusOptions(t, { typewriter: 'truthy', dim: true });
  assert.deepEqual(JSON.parse(t.data[FOCUS_OPTIONS_KEY]), { typewriter: false, dim: true });
});

test('focus options: broken JSON, missing, null and throwing storage all fall back to defaults without throwing', () => {
  assert.deepEqual(readFocusOptions(memoryStorage({ [FOCUS_OPTIONS_KEY]: '{not json' })), DEFAULT_FOCUS_OPTIONS);
  assert.deepEqual(readFocusOptions(null), DEFAULT_FOCUS_OPTIONS);
  assert.deepEqual(readFocusOptions(undefined), DEFAULT_FOCUS_OPTIONS);
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(readFocusOptions(blocked), DEFAULT_FOCUS_OPTIONS);
  assert.doesNotThrow(() => writeFocusOptions(blocked, { typewriter: true, dim: true }));
  assert.doesNotThrow(() => writeFocusOptions(null, { typewriter: true, dim: true }));
});

// ------------------------------------------------------------------ typewriter and dim helpers

test('typewriter: the caret line is moved to ~40% from the top', () => {
  assert.equal(TYPEWRITER_RATIO, 0.4);
  // container at y=100, 500 high: target line is y=300; caret at 460 -> scroll down 160
  assert.equal(typewriterDelta({ caretTop: 460, containerTop: 100, containerHeight: 500 }), 160);
  // already at the target
  assert.equal(typewriterDelta({ caretTop: 300, containerTop: 100, containerHeight: 500 }), 0);
  // above the target: scroll up
  assert.equal(typewriterDelta({ caretTop: 150, containerTop: 100, containerHeight: 500 }), -150);
  assert.equal(typewriterDelta({ caretTop: 500, containerTop: 0, containerHeight: 1000, ratio: 0.5 }), 0);
});

test('dim: the caret paragraph is the run of non-blank lines around the caret', () => {
  const lines = ['first para', 'still first', '', 'second para', '', '', 'third'];
  assert.deepEqual(paragraphBounds(lines, 0), { from: 0, to: 1 });
  assert.deepEqual(paragraphBounds(lines, 1), { from: 0, to: 1 });
  assert.deepEqual(paragraphBounds(lines, 3), { from: 3, to: 3 });
  assert.deepEqual(paragraphBounds(lines, 6), { from: 6, to: 6 });
});

test('dim: a blank line, an out-of-range index and a one-line document', () => {
  const lines = ['a', '', 'b'];
  assert.deepEqual(paragraphBounds(lines, 1), { from: 1, to: 1 });
  assert.deepEqual(paragraphBounds(lines, 99), { from: 99, to: 99 });
  assert.deepEqual(paragraphBounds(lines, -1), { from: -1, to: -1 });
  assert.deepEqual(paragraphBounds(['only'], 0), { from: 0, to: 0 });
  assert.deepEqual(paragraphBounds([], 0), { from: 0, to: 0 });
  assert.deepEqual(paragraphBounds(['a', '   ', 'b'], 1), { from: 1, to: 1 }, 'whitespace-only counts as blank');
});

test('dim: other paragraphs are at 45% opacity', () => {
  assert.equal(DIM_OPACITY, 0.45);
});

test('typewriter and dim are decoration-only: the helpers take no text and cannot change it', () => {
  const lines = Object.freeze(['one', 'two', '', 'three']);
  const before = JSON.stringify(lines);
  paragraphBounds(lines, 1);
  assert.equal(JSON.stringify(lines), before);
  assert.equal(typeof typewriterDelta({ caretTop: 1, containerTop: 0, containerHeight: 10 }), 'number');
});

// ------------------------------------------------------------------ goal card numbers

const today = (added, removed = 0) => ({ added, removed, net: added - removed, minutes: 0, sessions: 0 });

test('goalLine: "Today 412 / 500 words" with a goal; singular/plural without', () => {
  assert.equal(goalLine(today(412), 500), 'Today 412 / 500 words');
  assert.equal(goalLine(today(500, 88), 500), 'Today 412 / 500 words');
  assert.equal(goalLine(today(0), 500), 'Today 0 / 500 words');
  assert.equal(goalLine(today(412), null), 'Today 412 words');
  assert.equal(goalLine(today(1), null), 'Today 1 word');
  assert.equal(goalLine(today(0), null), 'Today 0 words');
});

test('goalPercent: whole percent, clamped to 0..100, 0 without a valid goal', () => {
  assert.equal(goalPercent(412, 500), 82);
  assert.equal(goalPercent(0, 500), 0);
  assert.equal(goalPercent(500, 500), 100);
  assert.equal(goalPercent(900, 500), 100);
  assert.equal(goalPercent(-50, 500), 0);
  assert.equal(goalPercent(100, null), 0);
  assert.equal(goalPercent(100, 0), 0);
  assert.equal(goalPercent(1, 3), 33);
});

test('signed and streakLabel', () => {
  assert.equal(signed(128), '+128');
  assert.equal(signed(0), '+0');
  assert.equal(signed(-12), '-12');
  assert.equal(streakLabel(3), '3 days');
  assert.equal(streakLabel(1), '1 day');
  assert.equal(streakLabel(0), null);
  assert.equal(streakLabel(-1), null);
});

test('parseGoal: whole numbers 1..999999999 only', () => {
  assert.equal(parseGoal('500'), 500);
  assert.equal(parseGoal('  500 '), 500);
  assert.equal(parseGoal('1'), 1);
  assert.equal(parseGoal('999999999'), 999999999);
  for (const bad of ['0', '-5', '1.5', '', 'abc', '5e2', '1000000000', '12 34', '+5', '0x10']) assert.equal(parseGoal(bad), null, JSON.stringify(bad));
});

test('applyWords adds a save\'s words to today without touching the input or the goal/streak', () => {
  const act = Object.freeze({ goal: 500, today: Object.freeze(today(400, 20)), days: [], streak: 2 });
  const next = applyWords(act, { added: 30, removed: 5 });
  assert.deepEqual(next.today, { added: 430, removed: 25, net: 405, minutes: 0, sessions: 0 });
  assert.equal(next.goal, 500);
  assert.equal(next.streak, 2);
  assert.equal(act.today.added, 400, 'input unchanged');
  assert.equal(applyWords(act, {}).today.net, 380, 'missing fields count as 0');
});

// ------------------------------------------------------------------ session tracker (fake clock + timers)

function fakeEnv(start = 1_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    timers,
    api: {
      setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; },
    },
    live: () => timers.filter((x) => !x.cleared),
    fire() { const h = this.live().at(-1); h.cleared = true; h.fn(); },
  };
}

function tracker(opts = {}) {
  const env = fakeEnv();
  const reports = [];
  const changes = [];
  const tr = createSessionTracker({ report: (m) => reports.push(m), now: env.now, timers: env.api, onChange: (s) => changes.push(s), ...opts });
  return { env, tr, reports, changes };
}

const MIN = 60_000;

test('session: idle limit is 10 minutes', () => {
  assert.equal(IDLE_MS, 10 * MIN);
});

test('session: nothing runs until the first edit; the first edit starts it and arms a 10-minute idle timer', () => {
  const { env, tr, reports } = tracker();
  assert.equal(tr.snapshot().active, false);
  assert.equal(tr.end(), null, 'ending a session that never started reports nothing');
  assert.deepEqual(reports, []);
  tr.edit();
  assert.equal(tr.snapshot().active, true);
  assert.equal(env.live().length, 1);
  assert.equal(env.live()[0].ms, 10 * MIN);
});

test('session: 10 minutes without edits ends it and reports the active span (first edit to last edit)', () => {
  const { env, tr, reports } = tracker();
  tr.edit();
  env.advance(12 * MIN);
  tr.edit();
  env.advance(10 * MIN); // idle for 10 min: timer fires
  env.fire();
  assert.deepEqual(reports, [12], 'span is first edit to last edit, not including the idle tail');
  assert.equal(tr.snapshot().active, false);
});

test('session: every edit restarts the idle timer (old timer cleared, one live timer)', () => {
  const { env, tr } = tracker();
  tr.edit();
  env.advance(3 * MIN);
  tr.edit();
  env.advance(3 * MIN);
  tr.edit();
  assert.equal(env.live().length, 1);
  assert.equal(env.timers.length, 3);
});

test('session: a session shorter than a minute still reports 1 (minutes >= 1)', () => {
  const { env, tr, reports } = tracker();
  tr.edit();
  env.advance(5_000);
  tr.edit();
  assert.equal(tr.end(), 1);
  assert.deepEqual(reports, [1]);
});

test('session: a single edit alone reports 1 minute', () => {
  const { tr, reports } = tracker();
  tr.edit();
  tr.end();
  assert.deepEqual(reports, [1]);
});

test('session: end() on leaving the book or hiding the page reports once and clears the timer; a second end() is a no-op', () => {
  const { env, tr, reports } = tracker();
  tr.edit();
  env.advance(30 * MIN);
  tr.edit();
  assert.equal(tr.end(), 30);
  assert.equal(env.live().length, 0);
  assert.equal(tr.end(), null);
  assert.deepEqual(reports, [30]);
});

test('session: the next edit after an ended session starts a fresh one with net reset to 0', () => {
  const { env, tr, reports } = tracker();
  tr.edit();
  tr.words({ added: 100, removed: 0 });
  env.advance(2 * MIN);
  tr.edit();
  tr.end();
  assert.equal(tr.snapshot().net, 100, 'net stays visible until the next session starts');
  env.advance(5 * MIN);
  tr.edit();
  assert.equal(tr.snapshot().net, 0);
  env.advance(3 * MIN);
  tr.edit();
  tr.end();
  assert.deepEqual(reports, [2, 3]);
});

test('session: words() accumulates "This session" as added - removed and notifies', () => {
  const { tr, changes } = tracker();
  tr.edit();
  tr.words({ added: 128, removed: 0 });
  tr.words({ added: 10, removed: 40 });
  assert.equal(tr.snapshot().net, 98);
  assert.deepEqual(changes.at(-1), { active: true, net: 98 });
});

test('session: dispose() stops the timer and reports nothing', () => {
  const { env, tr, reports } = tracker();
  tr.edit();
  env.advance(20 * MIN);
  tr.edit();
  tr.dispose();
  assert.equal(env.live().length, 0);
  assert.deepEqual(reports, []);
  assert.equal(tr.snapshot().active, false);
});

test('session: a custom idle length is honoured', () => {
  const { env, tr } = tracker({ idleMs: 1234 });
  tr.edit();
  assert.equal(env.live()[0].ms, 1234);
});

// ------------------------------------------------------------------ scene context (right rail data)

const OBJECTS = [
  { id: 'entry_M', kind: 'entry', slug: 'maren-hollis', title: 'Maren Hollis', type: 'character' },
  { id: 'entry_P', kind: 'entry', slug: 'pell', title: 'Pell', type: 'character' },
  { id: 'entry_T', kind: 'entry', slug: 'tobin-reyes', title: 'Tobin Reyes', type: 'character' },
  { id: 'entry_S', kind: 'entry', slug: 'salt-orchard', title: 'The Salt Orchard', type: 'location' },
  { id: 'entry_A', kind: 'entry', slug: 'port-aldine', title: 'Port Aldine', type: 'location' },
  { id: 'entry_F', kind: 'entry', slug: 'ferry-bell', title: 'Ferry Bell', type: 'object' },
  { id: 'thread_K', kind: 'thread', slug: 'brass-key', title: 'The brass key', type: null },
];

test('sceneNoteList: every note with its 1-based line, in order; ordinary comments are not notes', () => {
  const body = 'first line\n\n<!-- note: check the tide -->\ntext\n<!-- opaque: keep -->\n\n<!-- note: second -->\n';
  const notes = sceneNoteList(body);
  assert.deepEqual(notes.map((n) => [n.text, n.line]), [['check the tide', 3], ['second', 7]]);
  for (const n of notes) assert.equal(body.slice(n.offset).startsWith('<!-- note:'), true, 'offset points at the comment (for moving the caret)');
});

test('sceneNoteList: none, empty body, CRLF line counting, and a note inside a fenced block is ignored', () => {
  assert.deepEqual(sceneNoteList(''), []);
  assert.deepEqual(sceneNoteList('just prose\n'), []);
  assert.deepEqual(sceneNoteList('a\r\nb\r\n<!-- note: x -->\r\n').map((n) => n.line), [3]);
  assert.deepEqual(sceneNoteList('```\n<!-- note: not a note -->\n```\n'), []);
});

test('sceneNoteList: a note on the first line is line 1, offset 0', () => {
  const [n] = sceneNoteList('<!-- note: top -->\nrest');
  assert.deepEqual([n.line, n.offset], [1, 0]);
});

test('bodyLinkRefs: slugs without labels or heading anchors, in order, ignoring links in code', () => {
  const body = 'See [[pell]] and [[tobin-reyes|the ferryman]] near [[salt-orchard#Overview]].\n\n```\n[[not-a-link]]\n```\n`[[inline-code]]`\n';
  assert.deepEqual(bodyLinkRefs(body), ['pell', 'tobin-reyes', 'salt-orchard']);
  assert.deepEqual(bodyLinkRefs(''), []);
});

test('sceneLinkItems: front-matter people, places and threads are grouped and not "mentioned"', () => {
  const front = { characters: ['maren-hollis', 'pell'], locations: ['salt-orchard'], plot_threads: ['brass-key'] };
  const items = sceneLinkItems(front, 'Plain body.', OBJECTS);
  assert.deepEqual(items.map((i) => [i.ref, i.group, i.mentioned]), [
    ['maren-hollis', 'characters', false],
    ['pell', 'characters', false],
    ['salt-orchard', 'locations', false],
    ['brass-key', 'threads', false],
  ]);
  assert.equal(items[0].name, 'Maren Hollis');
  assert.equal(items[3].name, 'The brass key');
});

test('sceneLinkItems: body-only links are "mentioned"; a link already in front matter is listed once, not mentioned', () => {
  const front = { characters: ['pell'] };
  const body = 'Pell looked at [[pell]] and [[tobin-reyes]] by the [[ferry-bell]], then [[tobin-reyes]] again.';
  const items = sceneLinkItems(front, body, OBJECTS);
  assert.deepEqual(items.map((i) => [i.ref, i.mentioned]), [['pell', false], ['tobin-reyes', true], ['ferry-bell', true]]);
  assert.equal(items.find((i) => i.ref === 'ferry-bell').group, 'other');
  assert.equal(items.find((i) => i.ref === 'tobin-reyes').group, 'characters');
});

test('sceneLinkItems: an entry named by slug in front matter and by id in the body is one item', () => {
  const items = sceneLinkItems({ characters: ['pell'] }, 'See [[entry_P]].', OBJECTS);
  assert.equal(items.length, 1);
  assert.equal(items[0].mentioned, false);
});

test('sceneLinkItems: unknown refs are kept under their own name; no front matter, no objects, no links', () => {
  const items = sceneLinkItems(null, 'Hello [[who-knows]].', null);
  assert.deepEqual(items.map((i) => [i.ref, i.name, i.group, i.mentioned]), [['who-knows', 'who-knows', 'other', true]]);
  assert.deepEqual(sceneLinkItems(undefined, '', undefined), []);
  assert.deepEqual(sceneLinkItems({ characters: [] }, 'x', OBJECTS), []);
  assert.deepEqual(sceneLinkItems({ characters: [null, '', 5] }, 'x', OBJECTS), []);
});

test('chapterProgress: final/total and percent; an empty chapter is 0/0', () => {
  assert.deepEqual(chapterProgress([{ status: 'final' }, { status: 'drafting' }, { status: 'final' }, { status: 'outline' }]), { final: 2, total: 4, percent: 50 });
  assert.deepEqual(chapterProgress([]), { final: 0, total: 0, percent: 0 });
  assert.deepEqual(chapterProgress([{ status: 'revised' }, {}]), { final: 0, total: 2, percent: 0 });
  assert.equal(chapterProgress([{ status: 'final' }]).percent, 100);
});

test('bookProgress: words against word_target; null without a valid target; clamped at 100', () => {
  assert.deepEqual(bookProgress(45000, 90000), { words: 45000, target: 90000, percent: 50 });
  assert.equal(bookProgress(10, null), null);
  assert.equal(bookProgress(10, undefined), null);
  assert.equal(bookProgress(10, 0), null);
  assert.equal(bookProgress(10, 2.5), null);
  assert.equal(bookProgress(120000, 90000).percent, 100);
  assert.equal(bookProgress(0, 90000).percent, 0);
});

// ------------------------------------------------------------------ revisions wording and order

const LOCAL_NOW = new Date(2026, 10, 1, 15, 0, 0).getTime();
const localIso = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).toISOString();

test('whenLabel: Today / Yesterday / date, in local time', () => {
  assert.equal(whenLabel(localIso(2026, 10, 1, 14, 2), LOCAL_NOW), 'Today 14:02');
  assert.equal(whenLabel(localIso(2026, 10, 1, 0, 5), LOCAL_NOW), 'Today 00:05');
  assert.equal(whenLabel(localIso(2026, 9, 31, 9, 30), LOCAL_NOW), 'Yesterday 09:30');
  assert.equal(whenLabel(localIso(2026, 9, 30, 14, 2), LOCAL_NOW), 'Oct 30 14:02');
  assert.equal(whenLabel('garbage', LOCAL_NOW), 'garbage');
});

test('revisionSummary: "Today 14:02 · session · 812 words", singular word, missing words as 0', () => {
  const at = localIso(2026, 10, 1, 14, 2);
  assert.equal(revisionSummary({ at, reason: 'session', words: 812 }, LOCAL_NOW), 'Today 14:02 · session · 812 words');
  assert.equal(revisionSummary({ at, reason: 'manual', words: 1 }, LOCAL_NOW), 'Today 14:02 · manual · 1 word');
  assert.equal(revisionSummary({ at, reason: 'restore' }, LOCAL_NOW), 'Today 14:02 · restore · 0 words');
});

test('newestFirst sorts descending by time, ties by file name, and does not mutate the input', () => {
  const list = [
    { at: '2026-11-01T10:00:00.000Z', file: 'a' },
    { at: '2026-11-01T12:00:00.000Z', file: 'b' },
    { at: '2026-11-01T12:00:00.000Z', file: 'c' },
    { at: '2026-10-31T08:00:00.000Z', file: 'd' },
  ];
  const copy = JSON.parse(JSON.stringify(list));
  assert.deepEqual(newestFirst(list).map((e) => e.file), ['c', 'b', 'a', 'd']);
  assert.deepEqual(list, copy);
  assert.deepEqual(newestFirst([]), []);
});

test('the safety note says these are local copies and points to Git or backups', () => {
  assert.equal(SAFETY_NOTE, "Local safety copies on this computer. Use Git or backups for history you can't lose.");
});

// ------------------------------------------------------------------ right rail render (acceptance 7), server-rendered
// Components that fetch (entry preview, revisions list) can only show their loading state under renderToStaticMarkup, so their
// data-dependent wording is covered through the pure helpers above and the server tests.

let vite;
let m;
let shell;
before(async () => {
  vite = await createViteServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const load = (p) => vite.ssrLoadModule(p);
  m = {
    ...(await load('/src/writing/SceneNotes.jsx')),
    ...(await load('/src/writing/LinkedEntries.jsx')),
    ...(await load('/src/writing/GoalCard.jsx')),
    ...(await load('/src/writing/Revisions.jsx')),
    ...(await load('/src/writing/WritingContext.jsx')),
    ...(await load('/src/writing/FocusContext.jsx')),
  };
  shell = {
    ...(await load('/src/shell/Inspector.jsx')),
    ...(await load('/src/shell/Workspace.jsx')),
    ...(await load('/src/shell/AppShell.jsx')),
  };
});
after(async () => {
  await vite?.close();
});

const render = (el) => renderToStaticMarkup(el);
const plain = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&ldquo;|&rdquo;/g, '"');
const count = (html, re) => (html.match(re) ?? []).length;

const BOOK_ID = 'book_01S5000000000000000000000A';

test('rail: Scene notes lists every note with its line number, in order', () => {
  const body = 'Opening.\n\n<!-- note: check the tide times -->\nMore.\n\n<!-- note: rename the ferry -->\n';
  const html = plain(render(createElement(m.SceneNotes, { body })));
  assert.match(html, /Scene notes/);
  assert.equal(count(html, /class="note-jump"/g), 2);
  assert.match(html, /Line 3[\s\S]*check the tide times[\s\S]*Line 6[\s\S]*rename the ferry/);
});

test('rail: Scene notes with no notes says so and offers no jump buttons', () => {
  const html = plain(render(createElement(m.SceneNotes, { body: 'Plain prose only.\n' })));
  assert.match(html, /Scene notes/);
  assert.match(html, /No notes in this scene/);
  assert.equal(count(html, /note-jump/g), 0);
});

test('rail: plain comments and notes inside code are not listed as notes', () => {
  const html = render(createElement(m.SceneNotes, { body: '<!-- opaque: keep -->\n```\n<!-- note: in code -->\n```\n' }));
  assert.equal(count(html, /note-jump/g), 0);
});

const OBJECTS_FOR_RAIL = [
  { id: 'entry_P', kind: 'entry', slug: 'pell', title: 'Pell', type: 'character' },
  { id: 'entry_T', kind: 'entry', slug: 'tobin-reyes', title: 'Tobin Reyes', type: 'character' },
  { id: 'entry_S', kind: 'entry', slug: 'salt-orchard', title: 'The Salt Orchard', type: 'location' },
  { id: 'thread_K', kind: 'thread', slug: 'brass-key', title: 'The brass key', type: null },
];

test('rail: "In this scene" shows front-matter links plainly and body-only links tagged "mentioned"', () => {
  const front = { characters: ['pell'], locations: ['salt-orchard'], plot_threads: ['brass-key'] };
  const body = 'Pell met [[tobin-reyes|the ferryman]] at [[salt-orchard]].';
  const html = plain(render(createElement(m.LinkedEntries, { bookId: BOOK_ID, front, body, objects: OBJECTS_FOR_RAIL })));
  assert.match(html, /In this scene/);
  for (const name of ['Pell', 'Tobin Reyes', 'The Salt Orchard', 'The brass key']) assert.match(html, new RegExp(name));
  assert.equal(count(html, /class="tag">mentioned</g), 1, 'only Tobin is body-only');
  const li = html.split('<li class="link-item">').slice(1);
  const tobin = li.find((x) => x.includes('Tobin Reyes'));
  assert.match(tobin, /mentioned/);
  for (const other of li.filter((x) => !x.includes('Tobin Reyes'))) assert.doesNotMatch(other, /mentioned/);
});

test('rail: every linked entry is a button (collapsed by default, so no preview is rendered yet)', () => {
  const html = render(createElement(m.LinkedEntries, { bookId: BOOK_ID, front: { characters: ['pell'] }, body: '[[tobin-reyes]]', objects: OBJECTS_FOR_RAIL }));
  assert.equal(count(html, /<button type="button" class="link-chip"/g), 2);
  assert.equal(count(html, /aria-expanded="false"/g), 2);
  assert.equal(count(html, /entry-preview/g), 0);
});

test('rail: groups characters, locations and threads under their own labels; empty groups are omitted', () => {
  const html = plain(render(createElement(m.LinkedEntries, { bookId: BOOK_ID, front: { characters: ['pell'], plot_threads: ['brass-key'] }, body: '', objects: OBJECTS_FOR_RAIL })));
  assert.match(html, /Characters/);
  assert.match(html, /Plot threads/);
  assert.doesNotMatch(html, /Locations/);
});

test('rail: a scene with no links says nothing is linked', () => {
  const html = plain(render(createElement(m.LinkedEntries, { bookId: BOOK_ID, front: {}, body: 'No links here.', objects: OBJECTS_FOR_RAIL })));
  assert.match(html, /Nothing is linked to this scene yet/);
  assert.equal(count(html, /link-chip/g), 0);
});

test('rail: a body link to an unknown entry is still listed (by its name) and tagged mentioned', () => {
  const html = plain(render(createElement(m.LinkedEntries, { bookId: BOOK_ID, front: {}, body: 'See [[nobody-here]].', objects: OBJECTS_FOR_RAIL })));
  assert.match(html, /nobody-here/);
  assert.match(html, /mentioned/);
});

test('rail: goal card without a goal: "Today N words", no progress bar, "Set a daily goal", "This session +0"', () => {
  const html = plain(render(createElement(m.WritingProvider, { bookId: BOOK_ID }, createElement(m.GoalCard))));
  assert.match(html, /Today 0 words/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(html, /Set a daily goal/);
  assert.match(html, /This session \+0/);
  assert.doesNotMatch(html, /Streak/);
});

test('rail: goal card works with no provider at all (inert)', () => {
  const html = plain(render(createElement(m.GoalCard)));
  assert.match(html, /Today 0 words/);
  assert.match(html, /Set a daily goal/);
});

test('rail: revisions section shows the safety note, a "Save a revision" button and a loading state', () => {
  const html = plain(render(createElement(m.Revisions, { bookId: BOOK_ID, sceneId: 'scene_01S50000000000000000000002' })));
  assert.match(html, /Revisions/);
  assert.ok(html.includes(SAFETY_NOTE), html);
  assert.match(html, /Save a revision/);
});

// ------------------------------------------------------------------ focus mode render

test('focus: the provider starts with focus mode off and the saved options; children render', () => {
  let seen = null;
  function Probe() {
    seen = m.useFocus();
    return createElement('p', null, seen.active ? 'FOCUS ON' : 'FOCUS OFF');
  }
  const html = render(createElement(m.FocusProvider, null, createElement(Probe)));
  assert.match(html, /FOCUS OFF/);
  assert.deepEqual(seen.options, { typewriter: false, dim: false });
});

test('focus: without a provider the hook is inert and never throws', () => {
  let seen = null;
  function Probe() {
    seen = m.useFocus();
    return null;
  }
  render(createElement(Probe));
  assert.equal(seen.active, false);
  assert.doesNotThrow(() => seen.toggle());
  assert.doesNotThrow(() => seen.exit());
});

// ------------------------------------------------------------------ the composed rail (SceneInspector) and shell, focus off


const SCENE_ID = 'scene_01S50000000000000000000003';
const RAIL_SCENE = {
  id: SCENE_ID,
  title: 'The Key',
  path: 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md',
  status: 'drafting',
  pov: 'maren-hollis',
  word_count: 41,
  front_matter: { characters: ['maren-hollis', 'pell'], locations: ['salt-orchard'], plot_threads: ['brass-key'], summary: 'Maren finds the key under the porch step.' },
  body: 'The key was colder than the morning.\n\n<!-- note: check the tide times against chapter 3 -->\n\nShe turned it over twice.\n\n[[pell]] watched from the gate and [[tobin-reyes]] did not.\n',
};
const NO_DIAG = { items: [], error: null, loading: false };
const rail = (scene = RAIL_SCENE, diagnostics = NO_DIAG, objects = OBJECTS_FOR_RAIL) =>
  plain(render(createElement(shell.SceneInspector, { book: { id: BOOK_ID }, scene, diagnostics, objects })));

test('rail: sections appear top to bottom as Goal, Scene, In this scene, Scene notes, Continuity, Problems, Revisions', () => {
  const html = rail();
  const at = (s) => html.indexOf(s);
  const order = ['aria-label="Daily goal"', '>Scene<', '>In this scene<', '>Scene notes<', '>Continuity<', '>Problems<', '>Revisions<'];
  for (const s of order) assert.ok(at(s) >= 0, `missing ${s}`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} must come before ${order[i]}`);
});

test('rail: the Scene section has status and POV selects, summary, words, last saved and the file path with a copy button', () => {
  const html = rail();
  assert.match(html, /<select id="rail-status"/);
  assert.match(html, /<select id="rail-pov"/);
  assert.match(html, /Maren finds the key under the porch step\./);
  assert.match(html, /<dt>Words<\/dt><dd>41<\/dd>/);
  assert.match(html, /Last saved/);
  assert.ok(html.includes('manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md'));
  assert.match(html, /Copy path/);
  for (const s of ['outline', 'drafting', 'revised', 'final']) assert.match(html, new RegExp(`<option value="${s}"`));
});

test('rail: status select shows the scene status as selected', () => {
  assert.match(rail(), /<option value="drafting" selected=""/);
});

test('rail: Continuity is a real section (loading until the findings arrive), not the M05 placeholder', () => {
  const html = rail();
  assert.ok(!/arrive in M05/.test(html));
  assert.match(html, /Continuity<\/h2>[\s\S]{0,40}Loading/);
});

test('rail: the body-only link is tagged mentioned and the note shows its line number', () => {
  const html = rail();
  assert.match(html, /Tobin Reyes[\s\S]{0,80}mentioned/);
  assert.equal(count(html, /class="tag">mentioned</g), 1);
  assert.match(html, /Line 3[\s\S]*check the tide times against chapter 3/);
});

test('rail: problems for this scene are still listed beside the continuity section', () => {
  const diag = { items: [{ code: 'W301', severity: 'warning', file: RAIL_SCENE.path, location: 'body', message: 'resolves only through a previous slug' }], error: null, loading: false };
  const html = rail(RAIL_SCENE, diag);
  assert.match(html, /W301/);
  assert.match(html, />Continuity</);
});

test('rail: the revisions section carries the safety note and a Save a revision button', () => {
  const html = rail();
  assert.ok(html.includes(SAFETY_NOTE));
  assert.match(html, /Save a revision/);
});

test('rail: a scene the editor cannot read (problem or raw) gets no Scene facts, links, notes text or revisions list', () => {
  const html = rail({ ...RAIL_SCENE, problem: { code: 'E100', message: 'bad front matter' } });
  assert.doesNotMatch(html, /id="rail-status"/);
  assert.doesNotMatch(html, />Revisions</);
  assert.doesNotMatch(html, /check the tide times/);
});

test('rail: with no scene open only the book problems section shows (no goal card, no revisions)', () => {
  const html = rail(null);
  assert.match(html, /Book problems/);
  assert.doesNotMatch(html, /Daily goal/);
  assert.doesNotMatch(html, />Revisions</);
});

test('shell: with focus mode off the workspace draws the manuscript rail and the app draws the top bar and project nav', () => {
  const ws = render(createElement(m.FocusProvider, null, createElement(shell.Workspace, { rail: createElement('p', null, 'RAILBODY'), inspector: createElement('p', null, 'INSPECTORBODY') }, createElement('main', null, 'MAINBODY'))));
  assert.match(ws, /data-focus="off"/);
  assert.match(ws, /RAILBODY/);
  assert.match(ws, /INSPECTORBODY/);
  assert.match(ws, /MAINBODY/);
  assert.match(ws, /aria-label="Manuscript"/);
});

test('shell: the focus-off app frame has no app-focus class', () => {
  const html = render(createElement(m.FocusProvider, null, createElement(shell.AppShell, { books: [], bookId: null }, createElement('main', null, 'x'))));
  assert.doesNotMatch(html, /app-focus/);
});

// ------------------------------------------------------------------ typewriter / dim never change the text (acceptance 6)

test('focus extensions: off gives no extensions; each option adds one; the document text is identical with or without them', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { focusExtensions } = await import('../src/editor/focus-extensions.js');
  assert.deepEqual(focusExtensions({ typewriter: false, dim: false }), []);
  assert.equal(focusExtensions({ typewriter: true, dim: false }).length, 1);
  assert.equal(focusExtensions({ typewriter: false, dim: true }).length, 1);
  assert.equal(focusExtensions({ typewriter: true, dim: true }).length, 2);
  const doc = 'First paragraph.\r\nStill first.\n\nSecond 潮 paragraph.\n\n<!-- note: keep -->\n';
  const plainState = EditorState.create({ doc });
  for (const opts of [{ typewriter: true, dim: false }, { typewriter: false, dim: true }, { typewriter: true, dim: true }]) {
    const st = EditorState.create({ doc, extensions: focusExtensions(opts) });
    assert.equal(st.doc.toString(), plainState.doc.toString());
    assert.equal(st.doc.lines, plainState.doc.lines);
  }
});
