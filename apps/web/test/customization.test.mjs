// M07-J04: themes, typography, layouts, panels, shortcuts and module switches as the browser code sees them. Server-rendered with fixture answers of GET /api/preferences
// (no browser, no network), plus the pure parts (registry, theme gate, CSS variables) and a scan of the source for key handling the registry must cover.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { audit, parse, walk } from './a11y-check.mjs';
import { parseTokens } from './color.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const src = join(webDir, 'src');
let vite;
const m = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of [
    '/src/prefs/PrefsContext.jsx', '/src/prefs/appearance.js', '/src/prefs/themes.js', '/src/prefs/PreferencesSettings.jsx', '/src/prefs/PromptRunner.jsx', '/src/shell/Workspace.jsx',
    '/src/shell/ProjectNav.jsx', '/src/shell/RailSlot.jsx', '/src/planning/PlanningWorkspace.jsx', '/src/shortcuts/registry.js', '/src/shortcuts/ShortcutsContext.jsx', '/src/writing/focus.js',
    '/src/editor/Toolbar.jsx', '/src/routes.js',
  ]) Object.assign(m, await vite.ssrLoadModule(p));
});
after(async () => {
  await vite?.close();
});

const html = (el) => renderToStaticMarkup(el);
const noop = () => {};
const { root: TOKENS } = parseTokens();

// ---------------------------------------------------------------- fixtures: what GET /api/preferences answers

const ALL_ON = Object.fromEntries(['ai', 'continuity', 'receipts', 'suggestions', 'timeline', 'board', 'threads', 'insights', 'tasks', 'research', 'planner', 'integrations', 'workspace'].map((id) => [id, { on: true, source: 'builtin', locked: false }]));
const DEFAULTS = { theme: 'dark', typography: { family: 'serif', size: 18, lineHeight: 1.7, paragraphSpacing: 0, letterSpacing: 0, measure: 72 }, layout: { name: 'Writing' }, shortcuts: {}, modules: {}, labels: {}, export: {} };
/** A preferences answer for `effective` overrides, modules off, and the profile's own parts. */
function prefs({ effective = {}, off = [], profile = {}, locked = [] } = {}) {
  const modules = Object.fromEntries(Object.entries(ALL_ON).map(([id, v]) => [id, off.includes(id) ? { on: false, source: locked.includes(id) ? 'book' : 'profile', locked: locked.includes(id) } : v]));
  return {
    profile: { name: 'default', names: ['default'], customThemes: profile.customThemes ?? {}, layouts: profile.layouts ?? {} },
    layers: { library: null, book: null, profile: profile.layer ?? {} },
    effective: { ...DEFAULTS, ...effective },
    sources: {},
    order: null,
    modules,
    warnings: [],
  };
}
const withPrefs = (fx, ...children) => h(m.PrefsProvider, { initial: fx }, h(m.ShortcutsProvider, null, ...children));
const styleOf = (markup) => /<style id="sf-prefs"[^>]*>([^<]*)<\/style>/.exec(markup)?.[1] ?? '';
const varsOf = (css) => Object.fromEntries([...css.matchAll(/(--[\w-]+):([^;}]+)/g)].map((x) => [x[1], x[2]]));
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// ---------------------------------------------------------------- the default look is the reference look

describe('defaults', () => {
  test('with the built-in preferences the variables are the values of tokens.css, and no colour is overridden', () => {
    const css = unescape(styleOf(html(withPrefs(prefs(), h('p', null, 'x')))));
    const v = varsOf(css);
    assert.equal(v['--font-prose'], TOKENS['--font-prose']);
    assert.equal(v['--fs-prose'], TOKENS['--fs-prose']);
    assert.equal(v['--lh-prose'], TOKENS['--lh-prose']);
    assert.equal(v['--measure'], TOKENS['--measure']);
    assert.equal(v['--rail'], TOKENS['--rail']);
    assert.equal(v['--inspector'], TOKENS['--inspector']);
    assert.equal(v['--ls-prose'], '0em');
    assert.equal(v['--para-space'], '0em');
    assert.match(css, /color-scheme:dark/);
    for (const k of m.THEME_TOKENS) assert.equal(v[k], undefined, `${k} is left to tokens.css`);
  });

  test('without any provider (before the server answers) the app is the reference look with every module on', () => {
    const markup = html(h(m.Workspace, { rail: h('p', null, 'rail'), inspector: h('p', null, 'inspector') }, h('p', null, 'page')));
    assert.match(markup, /class="rail"/);
    assert.match(markup, /class="inspector"/);
    assert.equal(m.DEFAULT_EFFECTIVE.modules.ai, true);
  });

  test('the built-in typography and layout in the app are the reference values', () => {
    assert.deepEqual({ ...m.DEFAULT_TYPOGRAPHY }, DEFAULTS.typography);
    assert.equal(m.LAYOUT_PRESETS.Writing.rail.width, 260);
    assert.equal(m.LAYOUT_PRESETS.Writing.inspector.width, 340);
    assert.equal(m.LAYOUT_PRESETS.Writing.pinned, null);
    assert.equal(m.FONT_STACKS.serif, TOKENS['--font-prose']);
  });
});

// ---------------------------------------------------------------- themes and typography become CSS variables only

describe('profiles A and B render different variables', () => {
  const A = prefs({ effective: { theme: 'light', typography: { ...DEFAULTS.typography, family: 'sans', size: 18 }, layout: { name: 'Planning' }, shortcuts: { 'focus.toggle': 'Mod+Shift+K' } } });
  const B = prefs();
  test('light + sans + Planning against dark + serif + Writing', () => {
    const a = varsOf(unescape(styleOf(html(withPrefs(A, h('p', null, 'x'))))));
    const b = varsOf(unescape(styleOf(html(withPrefs(B, h('p', null, 'x'))))));
    assert.equal(a['--bg'], m.LIGHT['--bg']);
    assert.equal(a['--text'], m.LIGHT['--text']);
    assert.equal(b['--bg'], undefined);
    assert.match(a['--font-prose'], /^system-ui/);
    assert.match(b['--font-prose'], /Literata/);
    assert.equal(a['--rail'], '320px');
    assert.equal(b['--rail'], '260px');
    assert.equal(a['--inspector'], '420px');
    assert.equal(b['--inspector'], '340px');
    assert.match(unescape(styleOf(html(withPrefs(A, h('p', null, 'x'))))), /color-scheme:light/);
  });

  test('typography stays inside its ranges and takes "full width"', () => {
    const t = m.typographyVars({ family: 'accessible', size: 99, lineHeight: 0.5, paragraphSpacing: 1.5, letterSpacing: 0.2, measure: 'full' });
    assert.equal(t['--fs-prose'], '24px');
    assert.equal(t['--lh-prose'], '1.4');
    assert.equal(t['--ls-prose'], '0.12em');
    assert.equal(t['--para-space'], '1.5em');
    assert.equal(t['--measure'], '100%');
    assert.match(t['--font-prose'], /Atkinson Hyperlegible', Verdana, sans-serif/);
    assert.equal(m.typographyVars({ measure: 60 })['--measure'], '60ch');
    assert.equal(m.typographyVars({ family: 'nope' })['--font-prose'], m.FONT_STACKS.serif);
    for (const stack of Object.values(m.FONT_STACKS)) assert.doesNotMatch(stack, /https?:|url\(/, 'no downloaded fonts');
  });

  test('a custom theme from the profile is applied over the dark reference and names its colour scheme', () => {
    const fx = prefs({ effective: { theme: 'custom:Paper' }, profile: { customThemes: { Paper: { '--bg': '#FFFFFF', '--surface': '#F4F4F4', '--surface-2': '#EAEAEA', '--text': '#101010', '--text-2': '#202020', '--text-3': '#303030', '--muted': '#404040' } } } });
    const markup = unescape(styleOf(html(withPrefs(fx, h('p', null, 'x')))));
    const v = varsOf(markup);
    assert.equal(v['--bg'], '#FFFFFF');
    assert.equal(v['--accent'], m.DARK['--accent'], 'tokens it does not set keep the reference value');
    assert.match(markup, /color-scheme:light/);
  });

  test('exporting and importing a custom theme round-trips and flags a bad file', () => {
    const text = m.exportTheme('Paper', { '--bg': '#FFFFFF', '--text': '#101010' });
    const back = m.importTheme(text);
    assert.equal(back.ok, true);
    assert.equal(back.name, 'Paper');
    assert.deepEqual(back.tokens, { '--bg': '#FFFFFF', '--text': '#101010' });
    assert.equal(m.importTheme('{nope').ok, false);
    assert.equal(m.importTheme(JSON.stringify({ schema: 'other', name: 'x', tokens: {} })).ok, false);
    assert.equal(m.importTheme(JSON.stringify({ schema: 'storyforge.theme/v1', name: 'x', tokens: { '--bg': 'blue' } })).ok, false);
  });
});

// ---------------------------------------------------------------- layouts and panels

describe('layouts', () => {
  test('the named layouts differ; a custom one saved in the profile is used by name; the preference lays its own widths over the layout', () => {
    assert.equal(m.effectiveLayout({ name: 'Writing' }, {}).inspector.width, 340);
    const planning = m.effectiveLayout({ name: 'Planning' }, {});
    assert.equal(planning.rail.width, 320);
    assert.ok(planning.pinned.includes('events'));
    const review = m.effectiveLayout({ name: 'Review' }, {});
    assert.equal(review.rail.shown, false);
    assert.equal(review.pinned[0], 'continuity');
    const custom = m.effectiveLayout({ name: 'Mine' }, { Mine: { rail: { shown: true, width: 200 }, inspector: { shown: false, width: 300 }, pinned: ['goal'] } });
    assert.equal(custom.rail.width, 200);
    assert.equal(custom.inspector.shown, false);
    assert.deepEqual(custom.pinned, ['goal']);
    assert.equal(m.effectiveLayout({ name: 'Planning', inspector: { width: 500 } }, {}).inspector.width, 500);
    assert.equal(m.effectiveLayout({ name: 'Writing', rail: { width: 9999 } }, {}).rail.width, 480, 'widths stay in range');
    assert.equal(m.effectiveLayout({ name: 'Nope' }, {}).name, 'Nope');
    assert.equal(m.effectiveLayout({ name: 'Nope' }, {}).rail.width, 260, 'an unknown layout name falls back to Writing');
  });

  test('a hidden panel is not drawn and has no width, the main column keeps its place, and the separators are real separators', () => {
    const markup = html(withPrefs(prefs({ effective: { layout: { name: 'Review' } } }), h(m.Workspace, { rail: h('p', null, 'RAIL'), inspector: h('p', null, 'INSPECTOR') }, h('p', null, 'PAGE'))));
    assert.doesNotMatch(markup, /class="rail"/);
    assert.match(markup, /class="inspector"/);
    assert.match(unescape(styleOf(markup)), /--rail:0px/);
    assert.match(unescape(styleOf(markup)), /--inspector:460px/);
    const tree = parse(markup);
    const seps = [...walk(tree)].filter((n) => n.attrs.role === 'separator');
    assert.equal(seps.length, 1, 'only the visible panel has a separator');
    const [sep] = seps;
    assert.equal(sep.attrs['aria-valuenow'], '460');
    assert.equal(sep.attrs['aria-valuemin'], '240');
    assert.equal(sep.attrs['aria-valuemax'], '560');
    assert.equal(sep.attrs['aria-orientation'], 'vertical');
    assert.equal(sep.attrs.tabindex, '0');
    assert.ok(sep.attrs['aria-label']);
  });

  test('both panels shown: two separators, each with its value; the markup passes the render-level audit', () => {
    const markup = html(withPrefs(prefs(), h(m.Workspace, { rail: h('p', null, 'RAIL'), inspector: h('p', null, 'INSPECTOR') }, h('p', null, 'PAGE'))));
    const seps = [...walk(parse(markup))].filter((n) => n.attrs.role === 'separator');
    assert.deepEqual(seps.map((s) => [s.attrs['data-panel'], s.attrs['aria-valuenow']]), [['rail', '260'], ['inspector', '340']]);
    assert.deepEqual(audit(markup, { landmarks: ['main', 'navigation', 'complementary'] }), []);
  });

  test('keyboard resizing: arrows step, Shift steps by four, Home and End go to the limits, nothing leaves the range', () => {
    assert.equal(m.widthForKey('rail', 260, { key: 'ArrowRight' }), 276);
    assert.equal(m.widthForKey('rail', 260, { key: 'ArrowLeft' }), 244);
    assert.equal(m.widthForKey('inspector', 340, { key: 'ArrowLeft' }), 356, 'the right panel grows to the left');
    assert.equal(m.widthForKey('inspector', 340, { key: 'ArrowRight', shiftKey: true }), 276);
    assert.equal(m.widthForKey('rail', 260, { key: 'Home' }), 180);
    assert.equal(m.widthForKey('rail', 260, { key: 'End' }), 480);
    assert.equal(m.widthForKey('rail', 470, { key: 'ArrowRight', shiftKey: true }), 480);
    assert.equal(m.widthForKey('rail', 260, { key: 'a' }), null);
    assert.equal(m.widthForKey('rail', 260, { key: 'ArrowRight', ctrlKey: true }), null, 'a chord with Ctrl is not a resize');
  });

  test('the right panel shows the pinned sections in the pinned order and drops the others; with nothing pinned the children are drawn as they were', () => {
    const slot = (id, module) => h(m.RailSlot, { id, module }, h('i', null, id));
    const sections = ['goal', 'events', 'continuity', 'problems'];
    const pinned = html(withPrefs(prefs({ effective: { layout: { name: 'Review' } } }), ...sections.map((id) => slot(id, id === 'events' ? 'timeline' : id === 'continuity' ? 'continuity' : null))));
    const orders = Object.fromEntries([...walk(parse(pinned))].filter((n) => n.attrs['data-section']).map((n) => [n.attrs['data-section'], /order:(\d+)/.exec(n.attrs.style)[1]]));
    assert.deepEqual(orders, { goal: '7', continuity: '0', problems: '5' }, 'events is not pinned in Review and is left out'); // Review pins comments after continuity (M07-J03b merge)
    const plain = html(withPrefs(prefs(), ...sections.map((id) => slot(id, null))));
    assert.doesNotMatch(plain, /rail-slot/);
    assert.equal((plain.match(/<i>/g) ?? []).length, 4);
  });
});

// ---------------------------------------------------------------- modules

describe('modules', () => {
  const tabs = (markup) => [...walk(parse(markup))].filter((n) => n.attrs.class === 'project-tab').map((n) => n.attrs.href.replace('/books/book_1', '') || '/');
  test('a tab of a module that is off disappears from the project navigation', () => {
    const on = html(withPrefs(prefs(), h(m.ProjectNav, { bookId: 'book_1', active: 'manuscript' })));
    assert.deepEqual(tabs(on), ['/', '/plan', '/codex', '/timeline', '/continuity', '/places', '/notes']);
    const off = html(withPrefs(prefs({ off: ['timeline', 'continuity', 'research', 'board'] }), h(m.ProjectNav, { bookId: 'book_1', active: 'manuscript' })));
    assert.deepEqual(tabs(off), ['/', '/plan', '/codex', '/places']);
    const noPlan = html(withPrefs(prefs({ off: ['planner'] }), h(m.ProjectNav, { bookId: 'book_1', active: 'manuscript' })));
    assert.deepEqual(tabs(noPlan), ['/', '/plan', '/codex', '/timeline', '/continuity', '/places', '/notes'], 'the Plan tab is the canvas page: the board module alone keeps it');
    const neither = html(withPrefs(prefs({ off: ['planner', 'board'] }), h(m.ProjectNav, { bookId: 'book_1', active: 'manuscript' })));
    assert.deepEqual(tabs(neither), ['/', '/codex', '/timeline', '/continuity', '/places', '/notes'], 'with the planner and the board module both off the Plan tab goes');
  });

  test("the pages J02 adds are gated by id: insights and tasks follow their module when they exist", () => {
    assert.equal(m.tabModule('insights'), 'insights');
    assert.equal(m.tabModule('tasks'), 'tasks');
    assert.equal(m.tabModule('timeline'), 'timeline');
    assert.equal(m.tabModule('notes'), 'research');
    assert.equal(m.tabModule('canvas'), null, 'M10: there is no Canvas tab any more');
    assert.equal(m.tabVisible('plan', (id) => id === 'board'), true);
    assert.equal(m.tabVisible('plan', (id) => id === 'planner'), true);
    assert.equal(m.tabVisible('plan', () => false), false);
    assert.equal(m.tabVisible('timeline', (id) => id !== 'timeline'), false);
    assert.equal(m.tabVisible('codex', () => false), true);
    assert.equal(m.tabModule('plan'), 'planner');
    assert.equal(m.tabModule('codex'), null);
    assert.deepEqual(m.MODULES.map((x) => x.id), Object.keys(ALL_ON));
  });

  test('the Board and Threads views follow their modules', () => {
    const views = (markup) => [...walk(parse(markup))].filter((n) => n.attrs.class === 'view-tab').map((n) => n.children.map((c) => c.text ?? '').join('').trim());
    assert.deepEqual(views(html(withPrefs(prefs(), h(m.ViewSwitch, { bookId: 'book_1', view: 'write' })))), ['Write', 'Board', 'Outline', 'Threads']);
    assert.deepEqual(views(html(withPrefs(prefs({ off: ['board', 'threads'] }), h(m.ViewSwitch, { bookId: 'book_1', view: 'write' })))), ['Write', 'Outline']);
  });

  test('a right-rail section of a module that is off is not drawn, whatever the layout pins', () => {
    const out = html(withPrefs(prefs({ off: ['receipts', 'suggestions'] }), h(m.RailSlot, { id: 'receipts', module: 'receipts' }, h('i', null, 'R')), h(m.RailSlot, { id: 'goal' }, h('i', null, 'G'))));
    assert.doesNotMatch(out, /<i>R<\/i>/);
    assert.match(out, /<i>G<\/i>/);
  });

  test('Settings: a module the project turned off is shown as set by the project and cannot be switched on', () => {
    const fx = prefs({ off: ['ai'], locked: ['ai'] });
    const markup = html(withPrefs(fx, h(m.PreferencesSettings)));
    const box = [...walk(parse(markup))].find((n) => n.tag === 'input' && n.attrs.type === 'checkbox' && n.parent.children.some((c) => (c.text ?? '').includes('AI')) && 'disabled' in n.attrs);
    assert.ok(box, 'the AI checkbox is disabled');
    assert.match(markup, /Set by this project \(book\.md\)/);
  });
});

// ---------------------------------------------------------------- shortcuts

describe('shortcut registry', () => {
  test('two commands on one chord in the same scope are refused, naming both; the same chord in another scope is allowed', () => {
    const b = m.bindingsFor({});
    const r = m.validateBinding('editor.bold', 'Mod+I', b);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFLICT');
    assert.deepEqual(r.with, ['Bold', 'Italic']);
    assert.match(r.message, /Italic/);
    assert.match(r.message, /Bold/);
    assert.equal(m.validateBinding('board.moveUp', 'Alt+ArrowUp', b).ok, true, 'its own chord is not a conflict');
    assert.equal(m.validateBinding('editor.bold', 'Alt+ArrowUp', b).ok, true, 'another scope may reuse a chord');
    assert.equal(m.validateBinding('outline.moveDown', 'Alt+ArrowUp', b).code, 'CONFLICT');
  });

  test('reserved chords cannot be taken: Ctrl+W, T, N, L, Ctrl+Tab, F5, Alt+F4, Tab, Shift+Tab, Escape (any spelling)', () => {
    const b = m.bindingsFor({});
    for (const chord of ['Mod+W', 'ctrl+w', 'Cmd+T', 'Mod+N', 'Mod+L', 'Ctrl+Tab', 'F5', 'f5', 'Alt+F4', 'Tab', 'Shift+Tab', 'Escape', 'Esc']) {
      const r = m.validateBinding('editor.bold', chord, b);
      assert.equal(r.ok, false, chord);
      assert.equal(r.code, 'RESERVED', chord);
    }
    assert.equal(m.validateBinding('editor.bold', 'Mod+Shift+K', b).ok, true);
    assert.equal(m.validateBinding('editor.bold', 'nonsense chord', b).code, 'BAD_CHORD');
    assert.equal(m.validateBinding('dialog.close', 'Mod+Q', b).code, 'FIXED', 'Escape and Tab in dialogs cannot be rebound');
    assert.equal(m.validateBinding('no.such', 'Mod+Q', b).code, 'UNKNOWN_COMMAND');
  });

  test('chords read from key events; Ctrl and Cmd are both Mod; ? needs no Shift', () => {
    assert.equal(m.chordFromEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'Mod+Shift+K');
    assert.equal(m.chordFromEvent({ key: 'K', metaKey: true, shiftKey: true }), 'Mod+Shift+K');
    assert.equal(m.chordFromEvent({ key: '?', shiftKey: true }), '?');
    assert.equal(m.chordFromEvent({ key: 'Shift', shiftKey: true }), null);
    assert.equal(m.chordFromEvent({ key: 'ArrowUp', altKey: true }), 'Alt+ArrowUp');
    assert.equal(m.commandForEvent({ key: 'b', ctrlKey: true }, 'editor', m.bindingsFor({})), 'editor.bold');
    assert.equal(m.commandForEvent({ key: 'b', ctrlKey: true }, 'editor', m.bindingsFor({ 'editor.bold': 'Mod+Shift+K' })), null, 'a rebound command leaves its old chord');
    assert.equal(m.commandForEvent({ key: 'K', ctrlKey: true, shiftKey: true }, 'editor', m.bindingsFor({ 'editor.bold': 'Mod+Shift+K' })), 'editor.bold');
    assert.equal(m.toCodeMirror('Mod+Alt+M'), 'Mod-Alt-m');
  });

  test('a removed binding (null) is none; a fixed command keeps its key whatever the profile says; a bad profile chord falls back to the default', () => {
    const b = m.bindingsFor({ 'editor.bold': null, 'dialog.close': 'Mod+Q', 'editor.italic': 'not a chord' });
    assert.equal(b['editor.bold'], null);
    assert.equal(b['dialog.close'], 'Escape');
    assert.equal(b['editor.italic'], 'Mod+I');
  });

  test('focus mode takes its keys from the registry: the default chord, a rebound chord, Escape while focused', () => {
    assert.equal(m.focusKeyAction({ key: 'F', ctrlKey: true, shiftKey: true }, { focus: false }), 'toggle');
    const b = m.bindingsFor({ 'focus.toggle': 'Mod+Shift+K' });
    assert.equal(m.focusKeyAction({ key: 'F', ctrlKey: true, shiftKey: true }, { focus: false }, b), null);
    assert.equal(m.focusKeyAction({ key: 'K', ctrlKey: true, shiftKey: true }, { focus: false }, b), 'toggle');
    assert.equal(m.focusKeyAction({ key: 'Escape' }, { focus: true }, b), 'exit');
    assert.equal(m.focusKeyAction({ key: 'Escape' }, { focus: false }, b), null);
  });

  test('every command has an id, a label, a scope and a default binding (null only by removal); ids are unique and dotted', () => {
    const ids = m.COMMANDS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of m.COMMANDS) {
      assert.match(c.id, /^[a-z]+\.[A-Za-z]+$/);
      assert.ok(c.label.length > 3);
      assert.ok(m.SCOPES.some(([s]) => s === c.scope), `${c.id} scope`);
      assert.equal(m.normalizeChord(c.binding), c.binding, `${c.id} default is written in the registry's spelling`);
      assert.ok(!m.RESERVED_CHORDS.includes(c.binding) || c.fixed, `${c.id} default is reserved only if it is fixed`);
    }
    const defaults = m.bindingsFor({});
    for (const c of m.COMMANDS) {
      const clash = m.COMMANDS.filter((o) => o.id !== c.id && o.scope === c.scope && defaults[o.id] === defaults[c.id]);
      assert.deepEqual(clash.map((o) => o.id), [], `${c.id} shares its default chord in scope ${c.scope}`);
    }
  });
});

describe('the registry covers every shortcut in the code', () => {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(jsx?|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));
  const rel = (f) => relative(src, f).split(sep).join('/');
  const all = files(src).map((f) => [rel(f), readFileSync(f, 'utf8')]);
  /** Source that handles keys: a key handler, a CodeMirror keymap, or a modifier test on an event. */
  const KEY_CODE = /onKeyDown|'keydown'|keymap\.of|\.(ctrlKey|metaKey|altKey)\b|\be\.key\b|\bevent\.key\b/;
  /** Mouse handlers read modifiers to leave ctrl-click and the like to the browser: not shortcuts. */
  const MOUSE_ONLY = new Set(['router.jsx', 'continuity/ShowBoth.jsx']);
  const infra = (f) => f.startsWith('shortcuts/') || f.startsWith('prefs/');

  test('every source file that reads keys is carried out by a registry command, listed as component keys, or is the registry itself', () => {
    const commandFiles = new Set(m.COMMANDS.flatMap((c) => c.files));
    const widgetFiles = new Set(m.WIDGET_KEYS.map((w) => w.file));
    const unknown = all.filter(([f, text]) => KEY_CODE.test(text) && !infra(f) && !MOUSE_ONLY.has(f) && !commandFiles.has(f) && !widgetFiles.has(f)).map(([f]) => f);
    assert.deepEqual(unknown, [], 'a file reads keys but no command and no WIDGET_KEYS entry names it: add the command to src/shortcuts/registry.js');
  });

  test('no file outside the registry spells a chord of its own (Mod-b, Mod-Alt-m, ctrlKey && key === ...)', () => {
    const literal = all.filter(([f, text]) => !infra(f) && /key:\s*'(Mod|Ctrl|Alt|Shift)-/.test(text)).map(([f]) => f);
    assert.deepEqual(literal, []);
    const raw = all.filter(([f, text]) => !infra(f) && !MOUSE_ONLY.has(f) && /\.(ctrlKey|metaKey)\b[^;\n]*\.key\b/.test(text)).map(([f]) => f);
    assert.deepEqual(raw, [], 'a modifier test next to a key test is a chord the registry should own');
  });

  test('every file a command or widget entry names exists, and carries out the command it names', () => {
    const byFile = new Map(all);
    for (const c of m.COMMANDS) {
      for (const f of c.files) assert.ok(byFile.has(f), `${c.id}: ${f} exists`);
      // a command is carried out where it names: the file spells the command id, or asks the registry for its whole scope (commandFor(e, 'outline'))
      if (!c.fixed) assert.ok(c.files.some((f) => byFile.get(f).includes(`'${c.id}'`) || byFile.get(f).includes(`'${c.scope}'`)), `${c.id} is referenced by one of ${c.files.join(', ')}`);
    }
    for (const w of m.WIDGET_KEYS) {
      assert.ok(byFile.has(w.file), `${w.file} exists`);
      if (!infra(w.file)) assert.match(byFile.get(w.file), KEY_CODE, `${w.file} really handles keys (a stale entry is not a shortcut)`);
    }
  });

  test('the files that carry out the commands import the registry (the keymap, focus mode, the outline and the board)', () => {
    const byFile = new Map(all);
    for (const f of ['editor/SceneEditorPage.jsx', 'editor/RawEditor.jsx', 'Outline.jsx', 'planning/BoardView.jsx', 'writing/FocusContext.jsx', 'writing/focus.js', 'editor/Toolbar.jsx']) {
      assert.match(byFile.get(f), /shortcuts\//, `${f} takes its keys from src/shortcuts`);
    }
    assert.doesNotMatch(byFile.get('editor/SceneEditorPage.jsx'), /'Mod-[a-z]/);
    assert.doesNotMatch(byFile.get('editor/RawEditor.jsx'), /'Mod-[a-z]/);
  });
});

describe('the cheat sheet and the toolbar show the live bindings', () => {
  test('the cheat sheet lists every command with its active binding, and the keys of components', () => {
    const bindings = m.bindingsFor({ 'focus.toggle': 'Mod+Shift+K', 'editor.bold': null });
    const markup = html(h(m.ShortcutsDialog, { bindings, onClose: noop }));
    const text = unescape(markup);
    for (const c of m.COMMANDS) assert.ok(text.includes(c.label.replace(/'/g, "'")), `${c.id} is listed`);
    assert.match(text, /<kbd>Ctrl\+Shift\+K<\/kbd>/);
    assert.match(text, /Focus mode on or off/);
    assert.match(text, /<dt>Bold<\/dt><dd><kbd>none<\/kbd>/);
    assert.match(text, /Inside lists, menus and fields/);
    assert.deepEqual(audit(markup), []);
  });

  test('a rebound command shows its new chord on the toolbar button and in aria-keyshortcuts', () => {
    const fx = prefs({ effective: { shortcuts: { 'focus.toggle': 'Mod+Shift+K', 'editor.bold': 'Mod+Alt+B' } } });
    const markup = unescape(html(withPrefs(fx, h(m.EditorToolbar, { onBold: noop, onItalic: noop, onLink: noop, onNote: noop, onSceneBreak: noop, showMarks: false, onToggleMarks: noop, onFocus: noop }))));
    assert.match(markup, /title="Bold \(Ctrl\+Alt\+B\)"/);
    assert.match(markup, /title="Italic \(Ctrl\+I\)"/);
    assert.match(markup, /title="Focus mode \(Ctrl\+Shift\+K\)"/);
    assert.match(markup, /aria-keyshortcuts="Control\+Shift\+K Meta\+Shift\+K"/);
  });
});

// ---------------------------------------------------------------- the keyboard walk (render level)

describe('keyboard walk: every control is reachable and named', () => {
  const interactive = (markup) => [...walk(parse(markup))].filter((n) => ['button', 'select', 'input', 'textarea'].includes(n.tag) || n.attrs.role === 'separator' || (n.attrs.tabindex === '0' && n.attrs.role));
  test('Settings (profile, theme switch, layout switch, typography, shortcuts, features): native controls, every one labelled, none out of the tab order', () => {
    const markup = html(withPrefs(prefs(), h(m.PreferencesSettings)));
    assert.deepEqual(audit(markup), []);
    const controls = interactive(markup);
    assert.ok(controls.length > 60, `controls: ${controls.length}`);
    for (const n of [...walk(parse(markup))]) assert.ok(n.attrs.tabindex === undefined || Number(n.attrs.tabindex) <= 0, 'no positive tabindex');
    // the theme switch and the layout switch are real <select>s reachable by label
    const selects = [...walk(parse(markup))].filter((n) => n.tag === 'select').map((n) => n.attrs.id);
    assert.ok(selects.includes('pref-theme'));
    assert.ok(selects.includes('pref-layout'));
    assert.ok(selects.includes('pref-profile-select'));
    assert.match(markup, /for="pref-theme"/);
    assert.match(markup, /for="pref-layout"/);
  });

  test('every shortcut row offers Change, Remove and Reset with the command in the name; fixed ones say so', () => {
    const markup = unescape(html(withPrefs(prefs(), h(m.PreferencesSettings))));
    for (const c of m.COMMANDS.filter((x) => !x.fixed)) {
      assert.match(markup, new RegExp(`aria-label="Change the shortcut for ${c.label.replace(/[()]/g, '.')}"`));
      assert.match(markup, new RegExp(`aria-label="Remove the shortcut for ${c.label.replace(/[()]/g, '.')}"`));
    }
    assert.ok((markup.match(/Fixed/g) ?? []).length >= m.COMMANDS.filter((x) => x.fixed).length);
  });

  test('Settings, custom theme editor: every token has a labelled text field and a labelled picker; the results are announced', () => {
    const markup = html(withPrefs(prefs(), h(m.PreferencesSettings)));
    for (const t of m.THEME_TOKENS) {
      assert.match(markup, new RegExp(`for="pref-token-${t}"`));
      assert.match(markup, new RegExp(`aria-label="${t} colour picker"`));
    }
  });

  test('the prompt runner is a named modal dialog; its first control is the prompt choice; Preview comes before Send and Send starts disabled', () => {
    const active = { name: 'Local', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1', locality: 'local' };
    const markup = html(h(m.PromptRunner, { book: { id: 'book_1' }, active, scene: { id: 'scene_1', title: 'Arrival', path: 'manuscript/a.md' }, selection: null, onClose: noop }));
    assert.deepEqual(audit(markup), []);
    assert.match(markup, /role="dialog" aria-modal="true" aria-label="Run a prompt"/);
    const controls = [...walk(parse(markup))].filter((n) => ['button', 'select'].includes(n.tag));
    assert.equal(controls[0].tag, 'select');
    const labels = controls.filter((c) => c.tag === 'button').map((c) => c.children.map((x) => x.text ?? '').join('').trim());
    assert.deepEqual(labels, ['Preview context', 'Send', 'Cancel']);
    const send = controls.find((c) => c.children.some((x) => x.text === 'Send'));
    assert.ok('disabled' in send.attrs, 'nothing can be sent before a preview');
  });
});

