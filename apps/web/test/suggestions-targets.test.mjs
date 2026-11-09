// Suggestions on any target (not only scenes): the Codex entry inspector section and card badge, the AI Workspace "Suggestions" section and its Overview line,
// read-only roles (no Accept / Decline), and the scene rail still working through its old `scene` prop. Render tests: no browser, no network.
// Fixtures follow the shape the server sends (core summary(): target, target_kind, target_title, source, created, hunks, pending). `../api.js` of apps/web/src/suggestions/ is
// replaced by suggestions-stubs.mjs (renderToStaticMarkup runs no effects), as in suggestions-render.test.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const STUBS = path.join(webDir, 'test', 'suggestions-stubs.mjs').replace(/\\/g, '/');
const BOOK = 'salt-orchard';
const ENTRY = 'ent_maren';

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (markup) => decode(markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
const hrefs = (markup) => [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((x) => decode(x[1]));
const buttons = (markup) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((x) => text(x[1]));

const hunk = { id: 'h1', line: 3, lines: 1, status: 'pending', originalLines: ['Eyes: grey'], newLines: ['Eyes: green'], stale: false };
const sg = (id, over = {}) => ({
  id,
  path: `suggestions/2026/${id}.md`,
  target: ENTRY,
  target_path: '',
  target_title: 'Maren Hollis',
  target_kind: 'entry',
  target_missing: false,
  source: 'ai',
  by: null,
  mode: 'suggest',
  created: '2026-11-05T09:30:00Z',
  status: 'pending',
  ai: { provider: 'Test provider', model: 'test-model', locality: 'local' },
  rationale: '',
  hunks: [{ id: 'h1', line: 3, lines: 1, status: 'pending' }],
  pending: 1,
  ...over,
});
const FOR_ENTRY = [sg('s_entry_ai'), sg('s_entry_decided', { source: 'plugin', pending: 0, status: 'declined', hunks: [{ id: 'h1', line: 3, lines: 1, status: 'declined' }] })];
const ALL_OPEN = [
  sg('s_entry_ai'),
  sg('s_scene_author', { target: 'scn_arrival', target_kind: 'scene', target_title: 'Arrival', source: 'author' }),
  sg('s_thread_plugin', { target: 'thr_key', target_kind: 'thread', target_title: 'The key will matter', source: 'plugin' }),
  sg('s_event_ai', { target: 'evt_storm', target_kind: 'event', target_title: 'The storm', source: 'ai' }),
  sg('s_entry_second', { source: 'claude-book' }),
];

let vite;
const m = {};
before(async () => {
  const stubPlugin = {
    name: 'suggestions-targets-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.replace(/\\/g, '/').includes('/src/suggestions/')) return null;
      return source === '../api.js' ? STUBS : null;
    },
  };
  vite = await createServer({ root: webDir, logLevel: 'silent', plugins: [stubPlugin], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of ['/src/suggestions/RailSuggestions.jsx', '/src/codex/EntryInspector.jsx', '/src/codex/CodexCard.jsx', '/src/workspace/WorkspacePage.jsx', '/src/workspace/model.js', '/src/collab/model.js']) {
    m[p] = await vite.ssrLoadModule(p);
  }
});
after(async () => {
  await vite?.close();
});
afterEach(() => {
  globalThis.__sfApi = undefined;
});

const rail = () => m['/src/suggestions/RailSuggestions.jsx'];
const ENTRY_DATA = { id: ENTRY, slug: 'maren-hollis', name: 'Maren Hollis', type: 'character', status: 'canon', sections: [], fields: {}, appears_in: [], related: [] };

describe('Codex entry inspector', () => {
  const inspector = (entryRail) => renderToStaticMarkup(h(m['/src/codex/EntryInspector.jsx'].EntryInspector, { bookId: BOOK, entry: ENTRY_DATA, types: [{ type: 'character', name: 'Character' }], suggestions: entryRail }));
  const entryRail = () => h(rail().RailSuggestions, { book: { id: BOOK }, target: { id: ENTRY, kind: 'entry', title: 'Maren Hollis' } });

  test('shows the Suggestions section for the entry: count badge, source, changes waiting, Review; decided ones under Decided', () => {
    globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions?target=${ENTRY}`]: { suggestions: FOR_ENTRY } };
    const markup = inspector(entryRail());
    const t = text(markup);
    assert.match(t, /Suggestions/);
    assert.match(markup, /class="badge"[^>]*>1</);
    assert.match(t, /\bAI\b/);
    assert.match(t, /Test provider/);
    assert.match(t, /1 of 1 change waiting/);
    assert.ok(buttons(markup).includes('Review'));
    assert.match(t, /Decided \(1\)/);
    assert.match(t, /Plugin/);
  });

  test('an entry with nothing pending says so for the entry; while loading it does not claim that', () => {
    globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions?target=${ENTRY}`]: { suggestions: [] } };
    assert.match(text(inspector(entryRail())), /No pending suggestions for this entry\./);
    globalThis.__sfApi = {};
    assert.doesNotMatch(text(inspector(entryRail())), /No pending suggestions/);
  });

  test('without the slot (module off) there is no Suggestions section', () => {
    assert.doesNotMatch(text(inspector(null)), /Suggestions/);
  });

  test('a card carries a pending-count badge only when above 0', () => {
    const card = (pending) => renderToStaticMarkup(h(m['/src/codex/CodexCard.jsx'].CodexCard, { entry: ENTRY_DATA, pending }));
    assert.match(card(2), /aria-label="2 pending suggestions"[^>]*>2</);
    assert.match(card(1), /aria-label="1 pending suggestion"/);
    assert.doesNotMatch(card(0), /class="badge"/);
  });
});

describe('review dialog for an entry target', () => {
  const detail = { ...sg('s_entry_ai'), hunks: [hunk] };
  const dialog = (canDecide) => {
    globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions/s_entry_ai`]: detail };
    const actions = { decide() {}, busy: false, error: null, stamp: 0 };
    return renderToStaticMarkup(h(rail().SuggestionDialog, { bookId: BOOK, suggestionId: 's_entry_ai', actions, canDecide, onClose() {} }));
  };

  test('an editor or owner sees the entry proposal side by side with Accept / Decline', () => {
    const markup = dialog(true);
    const t = text(markup);
    assert.match(t, /Maren Hollis/);
    assert.match(t, /Eyes: grey/);
    assert.match(t, /Eyes: green/);
    const labels = buttons(markup);
    for (const l of ['Accept', 'Decline', 'Accept all', 'Decline all']) assert.ok(labels.includes(l), l);
  });

  test('a read-only role sees the same changes but no Accept or Decline', () => {
    const markup = dialog(false);
    assert.match(text(markup), /Eyes: green/);
    const labels = buttons(markup);
    assert.ok(!labels.some((l) => /^(Accept|Decline)/.test(l)), labels.join('|'));
    assert.ok(labels.includes('Done'));
  });

  test('the ability that gates it is false for viewers and reviewers, true for editors', () => {
    const { abilities } = m['/src/collab/model.js'];
    const shared = (role) => abilities({ mode: 'shared', user: { role } });
    assert.equal(shared('viewer').decide, false);
    assert.equal(shared('reviewer').decide, false);
    assert.equal(shared('editor').decide, true);
  });
});

describe('AI Workspace: Suggestions section', () => {
  const page = () => m['/src/workspace/WorkspacePage.jsx'];
  const section = (data, props = {}) => renderToStaticMarkup(h(page().SuggestionsSection, { bookId: BOOK, data, ...props }));

  test('is a section after AI tasks (and the nav can leave it out when the module is off)', () => {
    const nav = (props) => [...renderToStaticMarkup(h(page().SectionNav, { bookId: BOOK, active: 'tasks', ...props })).matchAll(/<a\b[^>]*>([^<]*)</g)].map((x) => x[1]);
    assert.deepEqual(nav({}), ['Overview', 'Docs', 'Chapter state', 'Ledgers', 'AI tasks', 'Suggestions', 'AI Activity']);
    assert.ok(!nav({ suggestions: false }).includes('Suggestions'));
    assert.equal(m['/src/workspace/model.js'].parseWorkspaceSearch('?section=suggestions').section, 'suggestions');
  });

  test('groups every pending suggestion by target, with kind, source label and date', () => {
    const markup = section({ suggestions: [...ALL_OPEN, sg('s_done', { pending: 0, status: 'declined' })] });
    const groups = [...markup.matchAll(/<div[^>]*role="group"[^>]*aria-label="([^"]*)"/g)].map((x) => decode(x[1]));
    assert.deepEqual(groups, ['Maren Hollis', 'Arrival', 'The key will matter', 'The storm']);
    const t = text(markup);
    for (const label of ['Codex entry', 'Scene', 'Thread', 'Event', 'AI', 'Author', 'Plugin', 'Claude-Book']) assert.ok(new RegExp(`\\b${label}\\b`).test(t), label);
    assert.match(t, /2026-11-05/);
    // the two entry suggestions share one group; the decided one is not listed
    assert.equal((markup.match(/class="sg-row"/g) ?? []).length, 5);
    assert.equal(buttons(markup).filter((l) => l === 'Review').length, 5);
  });

  test('links each target: scene to the editor, entry to the Codex with that entry selected, thread to Threads, event to the Timeline', () => {
    const links = hrefs(section({ suggestions: ALL_OPEN }));
    assert.ok(links.includes(`/books/${BOOK}?scene=scn_arrival`), links.join(' '));
    assert.ok(links.includes(`/books/${BOOK}/codex?entry=${ENTRY}`), links.join(' '));
    assert.ok(links.some((l) => l.includes('thread=thr_key')), links.join(' '));
    assert.ok(links.some((l) => l.includes('/timeline') && l.includes('event=evt_storm')), links.join(' '));
  });

  test('a target that is gone has no link; an empty list and a loading list say different things', () => {
    const gone = section({ suggestions: [sg('s_gone', { target_missing: true, target_kind: null, target_title: null, target_path: 'characters/old.md' })] });
    assert.ok(!hrefs(gone).some((l) => l.includes('codex')));
    assert.match(text(section({ suggestions: [] })), /No pending suggestions\./);
    assert.match(text(section(null)), /Loading/);
  });

  test('read-only: the list and Review are there, and the section itself has no Accept or Decline', () => {
    const labels = buttons(section({ suggestions: ALL_OPEN }));
    assert.ok(labels.includes('Review'));
    assert.ok(!labels.some((l) => /^(Accept|Decline)/.test(l)));
  });

  test('the Overview mentions how many suggestions wait, with a link to the section; nothing when none or unknown', () => {
    const overview = (pending) => renderToStaticMarkup(h(page().OverviewSection, { bookId: BOOK, pending, level: null, list: { docs: [] } }));
    assert.match(text(overview(3)), /3 suggestions waiting for you/);
    assert.match(text(overview(1)), /1 suggestion waiting for you/);
    assert.ok(hrefs(overview(3)).includes(`/books/${BOOK}/workspace?section=suggestions`), hrefs(overview(3)).join(' '));
    assert.doesNotMatch(text(overview(0)), /waiting for you/);
    assert.doesNotMatch(text(overview(null)), /waiting for you/);
  });
});

describe('scene rail (unchanged call site)', () => {
  test('RailSuggestions still takes `scene` and lists by the scene id', () => {
    globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions?target=scn_arrival`]: { suggestions: [sg('s1', { target: 'scn_arrival', target_kind: 'scene' })] } };
    const markup = renderToStaticMarkup(h(rail().RailSuggestions, { book: { id: BOOK }, scene: { id: 'scn_arrival' } }));
    assert.match(markup, /class="badge"[^>]*>1</);
    assert.ok(buttons(markup).includes('Review'));
    globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions?target=scn_arrival`]: { suggestions: [] } };
    assert.match(text(renderToStaticMarkup(h(rail().RailSuggestions, { book: { id: BOOK }, scene: { id: 'scn_arrival' } }))), /No pending suggestions for this scene\./);
  });
});
