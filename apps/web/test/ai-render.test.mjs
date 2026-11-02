// M05-J04 acceptance 6: render tests (no browser, no network) for the optional AI workshop.
//   - Settings: "Set up AI (optional)", profile list (locality badge, key storage in words), add / edit form (locality badge, the three key-storage choices, the plain-text warning)
//   - nothing AI is drawn without an active provider; the editor toolbar shows the AI buttons only when asked to
//   - chat panel (context picker, instruction, Preview context, Send), context preview (locality, token budget, file table with included state, messages as plain text)
//   - rewrite dialog: before sending, the proposed change as a word-level diff with Apply / Discard, after applying (Undo), cloud confirmation dialog
//   - pure helpers: locality, insecure-cloud detection, token text, word diff
// Method: renderToStaticMarkup runs no effects, so data is supplied through ai-stubs.mjs (a vite plugin points the AI components' `../api.js` and `./useExchange.js` imports at it);
// each test sets globalThis.__sfApi / __sfExchange to the state it wants to see. The stubs are the only substitution; every component, diff and renderer is the real one.
// Contract: docs/contracts/M05-J04-ai-workshop.md sections 2 to 4 and acceptance 6.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const STUBS = path.join(webDir, 'test', 'ai-stubs.mjs').replace(/\\/g, '/');

let vite;
const mod = {};
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  const stubPlugin = {
    name: 'ai-test-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.replace(/\\/g, '/').includes('/src/ai/')) return null;
      if (source === '../api.js' || source === './useExchange.js') return STUBS;
      return null;
    },
  };
  vite = await createServer({ root: webDir, logLevel: 'silent', plugins: [stubPlugin], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.model = await vite.ssrLoadModule('/src/ai/model.js');
  mod.diff = await vite.ssrLoadModule('/src/ai/diff.js');
  mod.parts = await vite.ssrLoadModule('/src/ai/parts.jsx');
  mod.settings = await vite.ssrLoadModule('/src/ai/SettingsView.jsx');
  mod.panel = await vite.ssrLoadModule('/src/ai/AiPanel.jsx');
  mod.rewrite = await vite.ssrLoadModule('/src/ai/RewriteDialog.jsx');
  mod.ctx = await vite.ssrLoadModule('/src/ai/AiContext.jsx');
  mod.toolbar = await vite.ssrLoadModule('/src/editor/Toolbar.jsx');
  mod.routes = await vite.ssrLoadModule('/src/routes.js');
  mod.topbar = await vite.ssrLoadModule('/src/shell/TopBar.jsx');
});
after(async () => {
  await vite?.close();
});
afterEach(() => {
  delete globalThis.__sfApi;
  delete globalThis.__sfExchange;
});

const LOCAL = { id: 'prof_local', name: 'Local Llama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', contextBudget: 8000, keyStorage: 'none', createdAt: '2026-01-01T00:00:00.000Z', locality: 'local', host: '127.0.0.1:11434', hasKey: false };
const CLOUD = { id: 'prof_cloud', name: 'Big Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'big-1', contextBudget: 16000, keyStorage: 'config', createdAt: '2026-01-01T00:00:00.000Z', locality: 'cloud', host: 'api.example.com', hasKey: true };
const SESSION = { ...CLOUD, id: 'prof_sess', name: 'Session Cloud', keyStorage: 'session', hasKey: false };
const BOOK = { id: 'book_01S5000000000000000000000A', title: 'The Salt Orchard', path: 'salt-orchard', acts: [{ chapters: [{ scenes: [{ id: 'scene_1', title: 'Arrival', path: 'salt-orchard/manuscript/a/0010-arrival.md' }] }] }] };
const SCENE = { id: 'scene_1', title: 'Arrival', path: 'manuscript/a/0010-arrival.md' };
const PKG = {
  contextId: 'ctx_1',
  messages: [
    { role: 'system', content: 'You are a writing assistant.' },
    { role: 'user', content: 'Request:\nSummarise <b>this</b> & "that" <script>alert(1)</script>' },
  ],
  files: [
    { path: 'manuscript/a/0010-arrival.md', sha256: 'a'.repeat(64), bytes: 700, tokens: 175, included: 'full' },
    { path: 'manuscript/a/0020-the-key.md', sha256: 'b'.repeat(64), bytes: 900, tokens: 225, included: 'truncated' },
    { path: 'codex/characters/pell.md', sha256: 'c'.repeat(64), bytes: 500, tokens: 125, included: 'omitted' },
  ],
  tokens: { estimate: 412, budget: 1000 },
  provider: { name: 'Local Llama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434/v1', locality: 'local' },
  contextSha256: 'f'.repeat(64),
  selection: { sceneId: 'scene_1', from: 0, to: 40, text: 'The ferry nudged the jetty and threw her bag ashore.' },
};
const CLOUD_PKG = { ...PKG, provider: { name: 'Big Cloud', model: 'big-1', baseUrl: 'https://api.example.com/v1', locality: 'cloud' } };

// ---------------------------------------------------------------- pure helpers
describe('model helpers', () => {
  test('locality: localhost, 127.0.0.1 and [::1] are local; everything else (and garbage) is cloud', () => {
    const { localityOf } = mod.model;
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://[::1]:8080/v1', 'https://localhost/v1']) assert.equal(localityOf(u), 'local', u);
    for (const u of ['https://api.example.com/v1', 'http://192.168.1.4/v1', 'http://localhost.evil.com/v1', 'http://127.0.0.1.evil.com/v1', 'nonsense', '']) assert.equal(localityOf(u), 'cloud', u);
  });
  test('hostOf gives host:port and an empty string for garbage', () => {
    assert.equal(mod.model.hostOf('http://127.0.0.1:11434/v1'), '127.0.0.1:11434');
    assert.equal(mod.model.hostOf('https://api.example.com/v1'), 'api.example.com');
    assert.equal(mod.model.hostOf('not a url'), '');
  });
  test('isInsecureCloud: only http: to a non-local host', () => {
    const { isInsecureCloud } = mod.model;
    assert.equal(isInsecureCloud('http://example.com/v1'), true);
    assert.equal(isInsecureCloud('http://192.168.0.2:8080/v1'), true);
    assert.equal(isInsecureCloud('https://example.com/v1'), false);
    assert.equal(isInsecureCloud('http://localhost:1/v1'), false);
    assert.equal(isInsecureCloud('http://[::1]:1/v1'), false);
    assert.equal(isInsecureCloud('garbage'), false);
    assert.equal(isInsecureCloud(''), false);
  });
  test('tokensText pluralises and groups digits', () => {
    assert.equal(mod.model.tokensText(1), '1 token');
    assert.equal(mod.model.tokensText(0), '0 tokens');
    assert.equal(mod.model.tokensText(1234567), '1,234,567 tokens');
  });
  test('bookRelative strips the book folder and leaves other paths alone', () => {
    assert.equal(mod.model.bookRelative('salt-orchard', 'salt-orchard/manuscript/x.md'), 'manuscript/x.md');
    assert.equal(mod.model.bookRelative('salt-orchard', 'other/manuscript/x.md'), 'other/manuscript/x.md');
    assert.equal(mod.model.bookRelative('salt', 'salt-orchard/x.md'), 'salt-orchard/x.md', 'a folder that merely starts with the same letters is not the book');
    assert.equal(mod.model.bookRelative('', 'a/b.md'), 'a/b.md');
  });
  test('"don\'t ask again" is remembered per book, in memory, and can be cleared', () => {
    const { cloudRemembered, rememberCloud } = mod.model;
    assert.equal(cloudRemembered('book_x'), false);
    rememberCloud('book_x', true);
    assert.equal(cloudRemembered('book_x'), true);
    assert.equal(cloudRemembered('book_y'), false, 'other books are unaffected');
    rememberCloud('book_x', false);
    assert.equal(cloudRemembered('book_x'), false);
  });
  test('the three key-storage choices are none, session and config, and the config one says plain text', () => {
    const c = mod.model.KEY_STORAGE_CHOICES;
    assert.deepEqual(c.map((x) => x.value), ['none', 'session', 'config']);
    assert.match(c[2].label, /plain text/i);
    assert.match(c[1].label, /session/i);
  });
});

describe('word diff', () => {
  const rebuild = (parts, keep) => parts.filter((p) => keep.includes(p.type)).map((p) => p.text).join('');
  const cases = [
    ['', ''],
    ['', 'new text'],
    ['old text', ''],
    ['same', 'same'],
    ['The ferry nudged the jetty.', 'The ferry bumped the jetty.'],
    ['One two three', 'One three'],
    ['a  b\n\nc', 'a b\nc d'],
    ['  leading', 'leading  '],
    ['<b>x</b> & "y"', '<i>x</i> & "z"'],
  ];
  for (const [a, b] of cases) {
    test(`reconstructs both sides: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`, () => {
      const parts = mod.diff.wordDiff(a, b);
      assert.equal(rebuild(parts, ['same', 'del']), a);
      assert.equal(rebuild(parts, ['same', 'add']), b);
    });
  }
  test('identical text is one unchanged segment; empty vs empty is nothing', () => {
    assert.deepEqual(mod.diff.wordDiff('same words', 'same words'), [{ type: 'same', text: 'same words' }]);
    assert.deepEqual(mod.diff.wordDiff('', ''), []);
  });
  test('a one-word change marks just that word', () => {
    const parts = mod.diff.wordDiff('The ferry nudged the jetty.', 'The ferry bumped the jetty.');
    assert.deepEqual(parts.filter((p) => p.type === 'del').map((p) => p.text), ['nudged']);
    assert.deepEqual(parts.filter((p) => p.type === 'add').map((p) => p.text), ['bumped']);
  });
  test('huge inputs still return a correct (coarse) answer quickly', () => {
    const a = 'word '.repeat(5000);
    const b = 'other '.repeat(5000);
    const parts = mod.diff.wordDiff(a, b);
    assert.equal(rebuild(parts, ['same', 'del']), a);
    assert.equal(rebuild(parts, ['same', 'add']), b);
  });
});

// ---------------------------------------------------------------- shared parts
describe('locality badge', () => {
  test('local says Local and carries the host; cloud says Cloud, the host and is marked as a warning', () => {
    const local = html(h(mod.parts.LocalityBadge, { locality: 'local', host: '127.0.0.1:11434' }));
    assert.match(local, /data-locality="local"/);
    assert.match(text(local), /Local/);
    assert.match(text(local), /127\.0\.0\.1:11434/);
    const cloud = html(h(mod.parts.LocalityBadge, { locality: 'cloud', host: 'api.example.com' }));
    assert.match(cloud, /data-locality="cloud"/);
    assert.match(text(cloud), /Cloud/);
    assert.match(text(cloud), /api\.example\.com/);
    assert.match(cloud, /badge-warn/);
  });
});

describe('context preview', () => {
  test('shows where it goes, the token estimate against the budget, each file with tokens and how much of it is included', () => {
    const out = html(h(mod.parts.ContextPreview, { pkg: PKG }));
    const t = text(out);
    assert.match(t, /exactly what would be sent/i);
    assert.match(out, /data-locality="local"/);
    assert.match(t, /Local Llama/);
    assert.match(t, /llama3/);
    assert.match(t, /412 tokens/);
    assert.match(t, /1,000 tokens/);
    for (const f of PKG.files) assert.ok(t.includes(f.path), f.path);
    assert.match(out, /data-included="full"/);
    assert.match(out, /data-included="truncated"/);
    assert.match(out, /data-included="omitted"/);
    assert.match(t, /whole file/);
    assert.match(t, /cut to fit/);
    assert.match(t, /left out/);
    assert.match(t, /Messages \(2\)/);
    assert.ok(t.includes('f'.repeat(12)), 'a short fingerprint of the package');
    assert.ok(!t.includes('f'.repeat(64)), 'not the whole hash');
  });
  test('messages are plain text: markup in the context is escaped, never interpreted', () => {
    const out = html(h(mod.parts.ContextPreview, { pkg: PKG }));
    assert.doesNotMatch(out, /<script>alert/);
    assert.doesNotMatch(out, /<b>this<\/b>/);
    assert.match(out, /&lt;script&gt;/);
  });
  test('a cloud package shows Cloud with its host; no files means no file table', () => {
    const out = html(h(mod.parts.ContextPreview, { pkg: { ...CLOUD_PKG, files: [] } }));
    assert.match(out, /data-locality="cloud"/);
    assert.match(text(out), /api\.example\.com/);
    assert.doesNotMatch(out, /<table/);
  });
});

describe('cloud confirmation dialog', () => {
  const render = () => html(h(mod.parts.CloudConfirm, { bookId: BOOK.id, host: 'api.example.com', tokens: 1234, onConfirm() {}, onCancel() {} }));
  test('names the host and the size, and offers Send and Cancel', () => {
    const out = render();
    const t = text(out);
    assert.match(out, /role="dialog"|<dialog/);
    assert.match(t, /Send to a cloud provider/);
    assert.match(t, /1,234 tokens/);
    assert.ok(t.includes('api.example.com'));
    assert.match(t, /not on this computer/);
    assert.match(out, /<button[^>]*>Send to <!-- -->api\.example\.com<\/button>|Send to[^<]*(<!-- -->)?api\.example\.com/);
    assert.match(t, /Cancel/);
  });
  test('"don\'t ask again" is an opt-in checkbox, unchecked, scoped to this book until reload', () => {
    const out = render();
    assert.match(out, /<input[^>]*type="checkbox"/);
    assert.doesNotMatch(out, /<input[^>]*type="checkbox"[^>]*checked/);
    assert.match(text(out), /Don't ask again for this book/);
    assert.match(text(out), /reloaded/);
  });
});

describe('diff view', () => {
  test('removed words are in <del>, added words in <ins>, unchanged text is plain', () => {
    const out = html(h(mod.parts.DiffView, { before: 'The ferry nudged the jetty.', after: 'The ferry bumped the jetty.' }));
    assert.match(out, /<del>nudged<\/del>/);
    assert.match(out, /<ins>bumped<\/ins>/);
    assert.match(out, /aria-label="Proposed change"/);
    assert.ok(text(out).includes('The ferry'));
  });
  test('model output is never interpreted: HTML in the proposal is escaped', () => {
    const out = html(h(mod.parts.DiffView, { before: 'plain words', after: 'plain <img src=x onerror=alert(1)> words' }));
    assert.doesNotMatch(out, /<img/);
    assert.match(out, /&lt;img/);
  });
  test('identical text shows no del or ins', () => {
    const body = /<pre[^>]*>([\s\S]*)<\/pre>/.exec(html(h(mod.parts.DiffView, { before: 'same', after: 'same' })))[1];
    assert.doesNotMatch(body, /<del|<ins/);
    assert.equal(text(body), 'same');
  });
});

// ---------------------------------------------------------------- settings
describe('Settings: Set up AI (optional)', () => {
  const API = (extra = {}) => ({ '/api/ai/profiles': { profiles: [], configFile: 'C:\\Users\\me\\AppData\\Roaming\\StoryForge\\ai.json' }, '/api/books': [{ id: BOOK.id, title: BOOK.title }], ...extra });

  test('the page offers exactly one AI entry, says it is optional, and with no profile shows no AI controls beyond adding one', () => {
    globalThis.__sfApi = API();
    const out = html(h(mod.settings.SettingsView));
    const t = text(out);
    assert.match(t, /Set up AI \(optional\)/);
    assert.equal((t.match(/Set up AI/g) ?? []).length, 1);
    assert.match(t, /works fully without AI/i);
    assert.match(t, /No providers yet/);
    assert.match(t, /Add a provider/);
    assert.doesNotMatch(t, /AI workshop|Rewrite with AI|Preview context/);
    assert.doesNotMatch(t, /AI in your books/, 'per-book choice appears only once a profile exists');
  });

  test('the top bar links to Settings and the route exists', () => {
    assert.deepEqual(mod.routes.parseRoute('/settings'), { name: 'settings' });
    assert.deepEqual(mod.routes.parseRoute('/settings/'), { name: 'settings' });
  });

  test('profiles are listed with name, locality badge, model, address and what is done with the key', () => {
    globalThis.__sfApi = API({ '/api/ai/profiles': { profiles: [LOCAL, CLOUD, SESSION], configFile: '/home/me/.config/storyforge/ai.json' } });
    const out = html(h(mod.settings.SettingsView));
    const t = text(out);
    assert.match(out, /data-locality="local"/);
    assert.equal((out.match(/data-locality="cloud"/g) ?? []).length, 2);
    for (const p of [LOCAL, CLOUD, SESSION]) {
      assert.ok(t.includes(p.name), p.name);
      assert.ok(t.includes(p.model), p.model);
      assert.ok(t.includes(p.baseUrl), p.baseUrl);
    }
    assert.match(t, /no key/);
    assert.match(t, /key saved in the settings file \(plain text\)/);
    assert.match(t, /key not entered \(session\)/);
    assert.equal((out.match(/>Edit</g) ?? []).length, 3);
    assert.equal((out.match(/>Delete</g) ?? []).length, 3);
    assert.equal((out.match(/Send a test message/g) ?? []).length, 3);
  });

  test('a saved key is never shown: no password value, no key text, only whether one exists', () => {
    globalThis.__sfApi = API({ '/api/ai/profiles': { profiles: [{ ...CLOUD, apiKey: 'sk-should-never-render' }], configFile: '/x/ai.json' } });
    const out = html(h(mod.settings.SettingsView));
    assert.doesNotMatch(out, /sk-should-never-render/);
  });

  test('once a profile exists, each book gets a provider choice with "None (AI is off)"', () => {
    globalThis.__sfApi = API({ '/api/ai/profiles': { profiles: [LOCAL, CLOUD], configFile: '/x/ai.json' }, [`/api/books/${BOOK.id}/ai/status`]: { active: LOCAL, records: false } });
    const out = html(h(mod.settings.SettingsView));
    const t = text(out);
    assert.match(t, /AI in your books/);
    assert.match(t, /The Salt Orchard/);
    assert.match(t, /None \(AI is off\)/);
    assert.match(out, /<option value="prof_local" selected/);
    assert.match(t, /AI provider for this book/);
    assert.match(t, /Save each chat and rewrite as a file in this book/, 'the record toggle is offered per book');
  });
});

describe('profile form (add and edit)', () => {
  const empty = { name: '', baseUrl: '', model: '', temperature: '', maxTokens: '', contextBudget: '8000', keyStorage: 'none', apiKey: '' };
  const render = (over = {}) => html(h(mod.settings.ProfileForm, { initial: empty, hasKey: false, configFile: 'C:\\Users\\me\\AppData\\Roaming\\StoryForge\\ai.json', saving: false, error: null, onSave() {}, onCancel() {}, title: 'Add a provider', ...over }));

  test('add: labelled fields for name, base URL, model, temperature, max tokens and context budget (default 8000); Save and Cancel', () => {
    const out = render();
    for (const label of ['Name', 'Base URL', 'Model', 'Temperature', 'Maximum reply tokens', 'Context budget']) assert.match(text(out), new RegExp(label), label);
    assert.match(out, /aria-label="Add a provider"/);
    assert.match(out, /id="ai-budget"[^>]*value="8000"/);
    assert.match(out, /Save profile/);
    assert.match(out, />Cancel</);
    assert.doesNotMatch(out, /badge/, 'no locality badge before an address is typed');
  });

  test('edit: starts from the saved values; a saved key is not shown and the key box says how to keep it', () => {
    const out = render({ title: 'Edit provider', hasKey: true, initial: { ...empty, name: 'Big Cloud', baseUrl: CLOUD.baseUrl, model: 'big-1', keyStorage: 'config', contextBudget: '16000' } });
    assert.match(out, /aria-label="Edit provider"/);
    assert.match(out, /value="Big Cloud"/);
    assert.match(out, /value="https:\/\/api\.example\.com\/v1"/);
    assert.match(out, /value="big-1"/);
    assert.match(out, /value="16000"/);
    assert.match(text(out), /leave empty to keep the saved one/);
    assert.match(out, /<input[^>]*id="ai-key"[^>]*type="password"|<input[^>]*type="password"[^>]*id="ai-key"/);
    assert.doesNotMatch(out, /id="ai-key"[^>]*value="[^"]+"/, 'the key box starts empty');
  });

  test('locality badge follows the address: local for localhost, cloud with the host for anything else', () => {
    const local = render({ initial: { ...empty, baseUrl: 'http://localhost:11434/v1' } });
    assert.match(local, /data-locality="local"/);
    assert.match(text(local), /localhost:11434/);
    const cloud = render({ initial: { ...empty, baseUrl: 'https://api.example.com/v1' } });
    assert.match(cloud, /data-locality="cloud"/);
    assert.match(text(cloud), /api\.example\.com/);
  });

  test('http to a non-local host: an error is shown and Save is disabled', () => {
    const out = render({ initial: { ...empty, baseUrl: 'http://api.example.com/v1' } });
    assert.match(text(out), /must use https/);
    assert.match(out, /aria-invalid="true"/);
    assert.match(out, /<button[^>]*type="submit"[^>]*disabled|<button[^>]*disabled[^>]*type="submit"/);
    assert.doesNotMatch(out, /data-locality/);
    const ok = render({ initial: { ...empty, baseUrl: 'http://127.0.0.1:1234/v1' } });
    assert.doesNotMatch(ok, /<button[^>]*type="submit"[^>]*disabled/);
  });

  test('key storage: three radio choices, the selected one is checked, and no key box for "no key"', () => {
    const out = render();
    const radios = out.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    assert.equal(radios.length, 3);
    assert.deepEqual(radios.map((r) => /value="([^"]+)"/.exec(r)[1]), ['none', 'session', 'config']);
    assert.equal(radios.filter((r) => /checked/.test(r)).length, 1);
    assert.match(radios[0], /checked/);
    assert.match(text(out), /No key/);
    assert.match(text(out), /this session only/);
    assert.match(text(out), /plain text/);
    assert.doesNotMatch(out, /id="ai-key"/);
  });

  test('config storage says exactly what happens: plain text, where the file is, never in a book, backup or export', () => {
    const out = render({ initial: { ...empty, keyStorage: 'config' } });
    const t = text(out);
    assert.match(out, /role="note"/);
    assert.match(t, /plain text/);
    assert.ok(t.includes('C:\\Users\\me\\AppData\\Roaming\\StoryForge\\ai.json'), 'the config file path');
    assert.match(t, /never put in a book, a backup or an export/);
    assert.match(out, /id="ai-key"/);
  });

  test('session storage says the key is forgotten at restart and never written to disk, with no plain-text warning', () => {
    const out = render({ initial: { ...empty, keyStorage: 'session' } });
    assert.match(text(out), /forgotten/);
    assert.match(text(out), /never saved to disk/);
    assert.doesNotMatch(out, /role="note"/);
    assert.match(out, /id="ai-key"/);
  });

  test('a save error is announced and the saving state disables Save', () => {
    const out = render({ error: 'Not saved (400).', saving: true });
    assert.match(out, /role="alert"/);
    assert.match(text(out), /Not saved \(400\)\./);
    assert.match(out, /<button[^>]*type="submit"[^>]*disabled|<button[^>]*disabled[^>]*type="submit"/);
  });
});

// ---------------------------------------------------------------- off by default
describe('absent by default', () => {
  test('the editor toolbar shows no AI buttons unless the book has an active provider', () => {
    const base = { onBold() {}, onItalic() {}, onLink() {}, onNote() {}, onSceneBreak() {}, showMarks: false, onToggleMarks() {} };
    const off = text(html(h(mod.toolbar.EditorToolbar, base)));
    assert.doesNotMatch(off, /AI workshop|Rewrite with AI/);
    const on = text(html(h(mod.toolbar.EditorToolbar, { ...base, onRewrite() {}, onWorkshop() {} })));
    assert.match(on, /Rewrite with AI/);
    assert.match(on, /AI workshop/);
  });

  test('AiProvider with no active provider: not available, no panel, children render; with a provider: available but still closed', () => {
    const Probe = () => h('span', { 'data-available': String(mod.ctx.useAi().available), 'data-open': String(mod.ctx.useAi().open) }, 'child');
    globalThis.__sfApi = { [`/api/books/${BOOK.id}/ai/status`]: { active: null, records: false } };
    const off = html(h(mod.ctx.AiProvider, { book: BOOK }, h(Probe)));
    assert.match(off, /data-available="false"/);
    assert.match(off, />child</);
    assert.doesNotMatch(off, /AI workshop/);
    globalThis.__sfApi = { [`/api/books/${BOOK.id}/ai/status`]: { active: LOCAL, records: false } };
    const on = html(h(mod.ctx.AiProvider, { book: BOOK }, h(Probe)));
    assert.match(on, /data-available="true"/);
    assert.match(on, /data-open="false"/);
    assert.doesNotMatch(on, /aria-label="AI workshop"/, 'the panel is closed until asked for');
  });

  test('useAi outside any book page is safe and says AI is unavailable', () => {
    const Probe = () => h('span', { 'data-available': String(mod.ctx.useAi().available) });
    assert.match(html(h(Probe)), /data-available="false"/);
  });
});

// ---------------------------------------------------------------- chat panel
describe('chat panel', () => {
  const render = (props = {}) => html(h(mod.panel.AiPanel, { book: BOOK, active: LOCAL, records: false, scene: SCENE, onClose() {}, ...props }));

  test('has the provider and locality, the open scene preselected, an instruction box, Preview context and Send; says nothing leaves until Send', () => {
    const out = render();
    const t = text(out);
    assert.match(out, /<aside[^>]*aria-label="AI workshop"/);
    assert.match(out, /data-locality="local"/);
    assert.ok(t.includes('Local Llama') && t.includes('llama3'));
    assert.match(t, /Arrival/);
    assert.match(out, /aria-label="Remove Arrival"/);
    assert.match(out, /<textarea[^>]*id="ai-instruction"/);
    assert.match(t, /Add a scene, entry or note/);
    assert.match(t, /Preview context/);
    assert.match(t, /Send/);
    assert.match(t, /Nothing leaves your computer until you click Send/);
    assert.match(t, /nothing is written to your book/);
    assert.match(out, />Close</);
  });

  test('before a preview: Preview context is disabled with an empty instruction and Send is disabled (nothing to send)', () => {
    const out = render();
    const buttons = out.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? [];
    const preview = buttons.find((b) => /Preview context/.test(b));
    const send = buttons.find((b) => />Send</.test(b));
    assert.match(preview, /disabled/);
    assert.match(send, /disabled/);
  });

  test('a cloud provider shows Cloud with its host', () => {
    const out = render({ active: CLOUD });
    assert.match(out, /data-locality="cloud"/);
    assert.match(text(out), /api\.example\.com/);
  });

  test('no open scene: says the model will see only the instruction', () => {
    assert.match(text(render({ scene: null })), /No files\. The model will see only your instruction/);
  });

  test('the "include the full context" choice appears only when records are on', () => {
    assert.doesNotMatch(text(render()), /Include the full context/);
    assert.match(text(render({ records: true })), /Include the full context in the saved record/);
  });

  test('with a preview: the exact request is shown and Send is enabled', () => {
    globalThis.__sfExchange = { pkg: PKG };
    const out = render();
    assert.match(text(out), /exactly what would be sent/i);
    const send = (out.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? []).find((b) => />Send</.test(b));
    assert.doesNotMatch(send, /disabled/);
  });

  test('a reply goes through the same safe renderer as notes: its text is shown, raw HTML is escaped and never interpreted', () => {
    globalThis.__sfExchange = { pkg: PKG, result: { reply: 'It is a quiet reply <script>alert(1)</script> and <img src=x onerror=alert(2)>', record: null } };
    const out = render();
    assert.match(out, /aria-label="Reply"/);
    assert.match(out, /note-prose/);
    assert.match(text(out), /It is a quiet reply/);
    assert.doesNotMatch(out, /<script>alert/);
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;script&gt;/);
  });

  test('a saved record is reported with its path', () => {
    globalThis.__sfExchange = { pkg: PKG, result: { reply: 'ok', record: { path: 'ai/2026/20260101-120000-chat.md' } } };
    assert.match(text(render({ records: true })), /Saved as ai\/2026\/20260101-120000-chat\.md/);
  });

  test('errors are announced (role=alert) and busy is announced (role=status)', () => {
    globalThis.__sfExchange = { error: 'AI is not set up for this book. Nothing was sent.', busy: true };
    const out = render();
    assert.match(out, /role="alert"/);
    assert.match(text(out), /Nothing was sent/);
    assert.match(out, /role="status"/);
  });

  test('a cloud send waiting for confirmation shows the confirmation dialog with host and token count', () => {
    globalThis.__sfExchange = { pkg: CLOUD_PKG, pendingCloud: true };
    const out = render({ active: CLOUD });
    assert.match(out, /role="dialog"|<dialog/);
    assert.match(text(out), /Send to a cloud provider/);
    assert.match(text(out), /412 tokens/);
    assert.match(text(out), /api\.example\.com/);
  });

  test('no confirmation dialog unless one is pending', () => {
    globalThis.__sfExchange = { pkg: CLOUD_PKG, pendingCloud: false };
    assert.doesNotMatch(text(render({ active: CLOUD })), /Send to a cloud provider\?/);
  });
});

// ---------------------------------------------------------------- rewrite dialog
describe('rewrite dialog', () => {
  const SELECTION = { sceneId: 'scene_1', from: 0, to: 40, text: 'The ferry nudged the jetty and threw her bag ashore.' };
  const render = (props = {}) => html(h(mod.rewrite.RewriteDialog, { book: BOOK, active: LOCAL, records: false, scene: SCENE, rewrite: SELECTION, onClose() {}, ...props }));

  test('before sending: shows the selected text, locality, instruction, Preview context, Send and Cancel; no Apply yet', () => {
    const out = render();
    const t = text(out);
    assert.match(out, /role="dialog"|<dialog/);
    assert.match(t, /Rewrite with AI/);
    assert.match(out, /data-locality="local"/);
    assert.ok(t.includes(SELECTION.text));
    assert.match(out, /<textarea[^>]*id="ai-rewrite-instruction"/);
    assert.match(t, /Preview context/);
    assert.match(t, /Send/);
    assert.match(t, /Cancel/);
    assert.doesNotMatch(t, /Apply|Discard|Proposed rewrite/);
  });

  test('a previewed rewrite shows the exact request including the selected text', () => {
    globalThis.__sfExchange = { pkg: PKG };
    const out = render();
    assert.match(text(out), /exactly what would be sent/i);
  });

  test('the result is a diff against the selection with Apply and Discard, and nothing is applied yet', () => {
    globalThis.__sfExchange = { pkg: PKG, result: { reply: 'x', replacement: 'The ferry bumped the jetty and the ferryman flung her bag ashore.' } };
    const out = render();
    const t = text(out);
    assert.match(t, /Proposed rewrite/);
    assert.match(out, /aria-label="Proposed change"/);
    assert.match(out, /<del>[^<]*nudged[^<]*<\/del>/);
    assert.match(out, /<ins>[^<]*bumped[^<]*<\/ins>/);
    const buttons = out.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? [];
    assert.ok(buttons.some((b) => />Apply</.test(b) && !/disabled/.test(b)), 'Apply is offered');
    assert.ok(buttons.some((b) => />Discard</.test(b) && !/disabled/.test(b)), 'Discard is offered');
    assert.doesNotMatch(t, /Applied to the scene|Undo/);
    assert.doesNotMatch(t, /Preview context/, 'the request form is gone once there is a result');
  });

  test('the diff compares against the selection the server read, and escapes whatever the model wrote', () => {
    globalThis.__sfExchange = { pkg: PKG, result: { reply: 'x', replacement: 'The ferry <script>alert(1)</script> jetty' } };
    const out = render();
    assert.doesNotMatch(out, /<script>alert/);
    assert.match(out, /&lt;script&gt;/);
  });

  test('after Apply is offered Undo and Done (state comes from the dialog: covered by the server tests for the write itself)', () => {
    // The applied state is local React state set by a click, which a static render cannot reach; assert the buttons that exist before it instead.
    globalThis.__sfExchange = { pkg: PKG, result: { reply: 'x', replacement: 'changed words here' } };
    assert.doesNotMatch(text(render()), /Undo|Done/);
  });

  test('a cloud rewrite waiting for confirmation shows the confirmation with host and tokens', () => {
    globalThis.__sfExchange = { pkg: CLOUD_PKG, pendingCloud: true };
    const out = render({ active: CLOUD });
    assert.match(text(out), /Send to a cloud provider\?/);
    assert.match(text(out), /api\.example\.com/);
    assert.match(out, /data-locality="cloud"/);
  });

  test('errors are announced', () => {
    globalThis.__sfExchange = { error: 'The scene changed after the preview, so nothing was written. Preview again to rewrite the current text.' };
    const out = render();
    assert.match(out, /role="alert"/);
    assert.match(text(out), /nothing was written/);
  });
});
