// M12 W1, render level: the AI level control in Settings (four levels, one plain line each, the effective level and where it comes from), the two new token
// permissions (Workspace docs and ledgers, Create chapters and scenes) in Settings -> AI connections and the Plugins panel, and the AI Activity list with Undo.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { AI_LEVELS, DEFAULT_AI_LEVEL } from '../../../packages/format/src/preferences.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let level;
let claude;
let plugins;
let activity;
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  level = await vite.ssrLoadModule('/src/prefs/AiLevelSettings.jsx');
  claude = await vite.ssrLoadModule('/src/integrations/ClaudePanel.jsx');
  plugins = await vite.ssrLoadModule('/src/integrations/PluginsPanel.jsx');
  activity = await vite.ssrLoadModule('/src/insights/AiActivityPanel.jsx');
});
after(async () => {
  await vite?.close();
});

describe('Settings -> AI level', () => {
  test('the four levels are the format levels, lowest first, each with its plain line', () => {
    assert.deepEqual(level.AI_LEVEL_CHOICES.map((c) => c.id), AI_LEVELS);
    assert.equal(level.DEFAULT_LEVEL, DEFAULT_AI_LEVEL);
    const lines = Object.fromEntries(level.AI_LEVEL_CHOICES.map((c) => [c.label, c.line]));
    assert.equal(lines.Off, 'AI can only read.');
    assert.match(lines.Advisor, /^Suggests edits, adds tasks, runs checks/);
    assert.match(lines.Planner, /^Also changes the plan, canvas, workspace docs and ledgers/);
    assert.match(lines['Co-writer'], /^Also creates new chapters and scenes as drafts/);
  });

  test('a control shows the level in effect, its line and where it comes from, and offers the four levels plus "follow"', () => {
    const control = (props) => html(h(level.AiLevelControl, { title: 'The Salt Orchard', inherit: 'Follow the library default', own: null, effective: 'planner', source: 'builtin', onChange: () => {}, ...props }));
    const none = control({});
    const t = text(none);
    assert.match(t, /In effect: Planner , from the built-in default\. Also changes the plan/);
    assert.match(none, /<option value="" selected="">Follow the library default<\/option>/);
    for (const id of AI_LEVELS) assert.match(none, new RegExp(`<option value="${id}"`));
    assert.match(text(control({ own: 'off', effective: 'off', source: 'book' })), /In effect: Off , from set for this book \(book\.md\)\. AI can only read\./);
    assert.match(control({ own: 'advisor', effective: 'advisor', source: 'book' }), /<option value="advisor" selected="">Advisor<\/option>/);
    assert.match(text(control({ effective: 'cowriter', source: 'library' })), /In effect: Co-writer , from the library default \(library\.md\)/);
  });

  test('the select value "" means "follow the layer above" (null); a level is passed on as it is', () => {
    assert.equal(level.levelFromChoice(''), null);
    for (const id of AI_LEVELS) assert.equal(level.levelFromChoice(id), id);
  });

  test('the section lists the legend, the library default and one row per book; no library default without a book', () => {
    const books = [{ id: 'book_1', title: 'The Salt Orchard' }, { id: 'book_2', title: 'Second Book' }];
    const out = html(h(level.AiLevelView, { books, library: { own: 'advisor', effective: 'advisor', source: 'library' } }));
    const t = text(out);
    assert.match(t, /AI level/);
    for (const c of level.AI_LEVEL_CHOICES) assert.ok(t.includes(`${c.label} : ${c.line}`), c.label);
    assert.match(t, /Library default/);
    assert.match(t, /The Salt Orchard/);
    assert.match(t, /Second Book/);
    assert.match(t, /the book's level always wins/);
    assert.match(t, /AI Activity/);
    const empty = text(html(h(level.AiLevelView, { books: [], library: null })));
    assert.match(empty, /No books yet\./);
    assert.doesNotMatch(empty, /Library default/);
    assert.match(text(html(h(level.AiLevelView, { books, library: null, status: 'Saved.' }))), /Saved\./);
  });

  test('sourceText names each layer', () => {
    assert.match(level.sourceText('book'), /book\.md/);
    assert.match(level.sourceText('library'), /library\.md/);
    assert.match(level.sourceText('profile'), /profile/);
    assert.match(level.sourceText(undefined), /built-in/);
  });
});

describe('token permissions: workspace and draft', () => {
  test('connectionPermissions adds workspace and draft after plan, only when ticked', () => {
    assert.deepEqual(claude.connectionPermissions(true, false, false, true), ['read', 'propose', 'workspace']);
    assert.deepEqual(claude.connectionPermissions(false, false, false, false, true), ['read', 'draft']);
    assert.deepEqual(claude.connectionPermissions(true, true, true, true, true), ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft']);
    assert.deepEqual(claude.connectionPermissions(true), ['read', 'propose'], 'default: neither');
  });

  test('the connect form has both checkboxes, off by default, with one-line explanations and the AI-level note', () => {
    const out = html(h(claude.ClaudeView, { data: { grants: [], books: [] }, mode: 'personal' }));
    const t = text(out);
    assert.match(t, /Workspace docs and ledgers/);
    assert.match(t, /Create chapters and scenes/);
    assert.match(t, /The book's AI level \(Settings, AI level\) still limits what is allowed/);
    const boxes = [...out.matchAll(/<label class="choice"><input type="checkbox"([^>]*)\/><span>([^<]*)<\/span><\/label>/g)];
    const named = (name) => boxes.find((m) => m[2].startsWith(name));
    for (const name of ['Workspace docs and ledgers', 'Create chapters and scenes']) {
      const box = named(name);
      assert.ok(box, name);
      assert.doesNotMatch(box[1], /checked/, `${name} is off by default`);
    }
    assert.match(named('The AI may suggest changes')[1], /checked/, 'suggest stays on by default');
  });

  test('a connection with the new permissions says what it can do', () => {
    const grant = { id: 'tok_01S8000000000000000000AAAA', plugin: 'mcp-laptop', permissions: ['read', 'workspace', 'draft'], books: 'all', created: 1_793_000_000_000, last_used: null, revoked: false };
    const t = text(html(h(claude.ClaudeView, { data: { grants: [grant], books: [] }, mode: 'personal' })));
    assert.match(t, /Can: read your books, edit workspace docs and ledgers, create chapters and scenes\./);
  });

  test('the Plugins panel explains both permissions', () => {
    assert.match(plugins.PERMISSION_TEXT.workspace, /^Workspace docs and ledgers:/);
    assert.match(plugins.PERMISSION_TEXT.draft, /^Create chapters and scenes:/);
    for (const k of ['workspace', 'draft']) assert.match(plugins.PERMISSION_TEXT[k], /AI level still limits/);
    assert.deepEqual(Object.keys(plugins.PERMISSION_TEXT), ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft', 'events']);
  });
});

describe('AI Activity', () => {
  const ITEM = (over = {}) => ({
    opId: '20261107T140300000Z-ABCDEF',
    at: '2026-11-07T14:03:00.000Z',
    actor: { kind: 'plugin', id: 'tok_1', name: 'mcp-laptop' },
    route: 'write',
    summary: 'Changed: planning/canvases/board.canvas',
    files: ['planning/canvases/board.canvas'],
    undone: false,
    undoable: true,
    ...over,
  });

  test('lists each change with who, when and what; Undo only where it can work', () => {
    const items = [ITEM(), ITEM({ opId: '2', summary: 'Created clue: planning/clues/x.md', undone: true }), ITEM({ opId: '3', summary: 'Created canvas', undoable: false })];
    const out = html(h(activity.AiActivityView, { items }));
    const t = text(out);
    assert.match(t, /AI Activity/);
    assert.match(t, /laptop 2026-11-07 14:03 UTC/);
    assert.match(t, /Changed: planning\/canvases\/board\.canvas/);
    assert.equal((out.match(/>Undo</g) ?? []).length, 1, 'one Undo button');
    assert.match(out, /aria-label="Undo: Changed: planning\/canvases\/board\.canvas"/);
    assert.match(t, /Undone\./);
    assert.match(t, /This change cannot be undone automatically\./);
  });

  test('a scene or chapter the AI created shows Archive instead of Undo; other items keep Undo', () => {
    const items = [
      ITEM({ opId: '1', summary: 'Insert scene: manuscript/x.md', undoable: false, archivable: true, target: { kind: 'scene', id: 'scene_X' } }),
      ITEM({ opId: '2', summary: 'Create chapter: manuscript/ch-004/chapter.md', undoable: false, archivable: true, target: { kind: 'chapter', id: 4 } }),
      ITEM({ opId: '3' }),
    ];
    const out = html(h(activity.AiActivityView, { items }));
    assert.equal((out.match(/>Archive</g) ?? []).length, 2);
    assert.equal((out.match(/>Undo</g) ?? []).length, 1);
    assert.match(out, /aria-label="Archive: Insert scene: manuscript\/x\.md"/);
    assert.doesNotMatch(out, /aria-label="Undo: Insert scene/);
    assert.match(text(html(h(activity.AiActivityView, { items: [items[0]], busy: '1' }))), /Archiving…/);
  });

  test('empty, loading, error, message and busy states', () => {
    assert.match(text(html(h(activity.AiActivityView, { items: [] }))), /No AI connection has changed this book yet\./);
    assert.match(text(html(h(activity.AiActivityView, { items: null }))), /Loading/);
    const failed = html(h(activity.AiActivityView, { items: null, error: 'down' }));
    assert.match(failed, /role="alert"/);
    assert.doesNotMatch(text(failed), /Loading/);
    assert.match(text(html(h(activity.AiActivityView, { items: [ITEM()], message: 'Not undone: x' }))), /Not undone: x/);
    const busy = html(h(activity.AiActivityView, { items: [ITEM()], busy: ITEM().opId }));
    assert.match(busy, /disabled=""/);
    assert.match(text(busy), /Undoing…/);
  });

  test('the url and the names', () => {
    assert.equal(activity.aiActivityUrl('book_1'), '/api/books/book_1/ai-activity');
    assert.equal(activity.actorName({ name: 'mcp-laptop' }), 'laptop');
    assert.equal(activity.actorName({ name: 'word-frequency' }), 'word-frequency');
    assert.equal(activity.actorName(undefined), 'an AI connection');
    assert.equal(activity.whenText('2026-11-07T14:03:00.000Z'), '2026-11-07 14:03 UTC');
  });
});
