// M08-J03: render tests (no browser, no network) for secure key storage in Settings, the connection test result, token lines, and the cover drafts dialogs.
// Same method as ai-render.test.mjs: the AI components' `../api.js` and `./useExchange.js` are replaced by test doubles (ai-stubs.mjs); everything else is the real component.
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
  mod.requests = await vite.ssrLoadModule('/src/ai/requests.js');
  mod.parts = await vite.ssrLoadModule('/src/ai/parts.jsx');
  mod.settings = await vite.ssrLoadModule('/src/ai/SettingsView.jsx');
  mod.cover = await vite.ssrLoadModule('/src/ai/CoverDrafts.jsx');
  mod.panel = await vite.ssrLoadModule('/src/ai/AiPanel.jsx');
});
after(async () => {
  await vite?.close();
});
afterEach(() => {
  delete globalThis.__sfApi;
  delete globalThis.__sfExchange;
});

const base = { contextBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' };
const PLAIN = { ...base, id: 'prof_plain', name: 'Plain Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'big', keyStorage: 'config', locality: 'cloud', host: 'api.example.com', hasKey: true };
const SECURE = { ...base, id: 'prof_sec', name: 'Secure Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'big', keyStorage: 'secure', locality: 'cloud', host: 'api.example.com', hasKey: true, storage: 'secure' };
const IMAGE = { ...base, id: 'prof_img', name: 'Pictures', kind: 'openai-compatible-images', baseUrl: 'https://images.example.com/v1', model: 'image-1', keyStorage: 'secure', locality: 'cloud', host: 'images.example.com', hasKey: true };
const FILE = 'C:\\Users\\me\\AppData\\Roaming\\StoryForge\\ai.json';
const api = (profiles, keystore) => ({ '/api/ai/profiles': { profiles, configFile: FILE, ...(keystore ? { keystore } : {}) }, '/api/books': [] });
const EMPTY = { kind: 'openai-compatible', name: '', baseUrl: '', model: '', temperature: '', maxTokens: '', contextBudget: '8000', keyStorage: 'secure', apiKey: '' };

describe('secure key storage in Settings', () => {
  test('the secure choice is offered first only when a backend is reported, and says where the key goes', () => {
    const form = (over) => html(h(mod.settings.ProfileForm, { initial: EMPTY, hasKey: false, configFile: FILE, saving: false, error: null, onSave() {}, onCancel() {}, title: 'Add a provider', ...over }));
    const withBackend = form({ secureBackend: 'dpapi' });
    const radios = withBackend.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    assert.deepEqual(radios.map((r) => /value="([^"]+)"/.exec(r)[1]), ['secure', 'none', 'session', 'config']);
    assert.match(radios[0], /checked/);
    assert.match(text(withBackend), /Windows protected storage \(DPAPI\)/);
    assert.match(text(withBackend), /never put in a book, a backup, an export or the settings file/);
    const without = form({ initial: { ...EMPTY, keyStorage: 'none' } });
    assert.equal((without.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).length, 3);
  });

  test('Settings shows the active backend, "Move key to secure storage" only for a saved plain-text key, and secure keys in words', () => {
    globalThis.__sfApi = api([PLAIN, SECURE], { backend: 'file-key', locked: false, message: null });
    const out = html(h(mod.settings.SettingsView));
    const t = text(out);
    assert.match(t, /Keys are kept by: an encrypted file with its own key/);
    assert.equal((t.match(/Move key to secure storage/g) ?? []).length, 1);
    assert.match(t, /key saved in the settings file \(plain text\)/);
    assert.match(t, /key kept in secure storage/);
    assert.doesNotMatch(out, /role="alert"/);
  });

  test('without a backend report there is no move button; a locked store is a clear alert, not a crash', () => {
    globalThis.__sfApi = api([PLAIN]);
    assert.doesNotMatch(text(html(h(mod.settings.SettingsView))), /Move key to secure storage/);
    globalThis.__sfApi = api([SECURE], { backend: 'dpapi', locked: true, message: 'cannot unlock stored keys: they were protected for another Windows user or computer' });
    const out = html(h(mod.settings.SettingsView));
    assert.match(out, /role="alert"/);
    assert.match(text(out), /cannot unlock stored keys: they were protected for another Windows user/);
  });

  test('an image provider has "Test connection" but no chat test message; a cached connection test is shown (models, streaming, usage)', () => {
    const found = { models: ['a-model', 'b-model'], ollama: true, streaming: true, usageReported: false };
    globalThis.__sfApi = api([IMAGE, { ...SECURE, capabilities: found }], { backend: 'dpapi', locked: false, message: null });
    const t = text(html(h(mod.settings.SettingsView)));
    assert.equal((t.match(/Test connection/g) ?? []).length, 2);
    assert.equal((t.match(/Send a test message/g) ?? []).length, 1);
    assert.match(t, /2 models: a-model, b-model \(Ollama detected\)/);
    assert.match(t, /Streaming: yes · Token usage: not reported \(shown as estimated\)/);
  });
});

describe('tokens and streaming', () => {
  test('a reply shows its tokens as reported or as estimated', () => {
    const line = (tokens) => text(html(h(mod.parts.TokensLine, { tokens })));
    assert.match(line({ promptTokens: 1234, completionTokens: 56, totalTokens: 1290, estimated: false }), /1,234 prompt \+ 56 reply tokens \(reported by the provider\)/);
    assert.match(line({ promptTokens: 10, completionTokens: 2, totalTokens: 12, estimated: true }), /\(estimated: the provider reported none\)/);
    assert.equal(html(h(mod.parts.TokensLine, { tokens: null })), '');
  });

  test('a streaming reply is marked not final and has Cancel; the panel shows it while it arrives', () => {
    const out = html(h(mod.parts.StreamingReply, { text: 'Once upon', onCancel() {} }));
    assert.match(text(out), /Not final: nothing is applied or saved until the reply is complete/);
    assert.match(out, />Cancel</);
    assert.match(out, /Once upon/);
    globalThis.__sfExchange = { streaming: true, streamText: 'partial words', busy: true };
    const panel = html(h(mod.panel.AiPanel, { book: { id: 'book_1', title: 'B', path: 'b', acts: [] }, active: { ...SECURE, locality: 'cloud' }, records: false, scene: null, onClose() {} }));
    assert.match(text(panel), /Reply arriving/);
    assert.match(panel, /partial words/);
  });

  test('a locked key store reads as a clear sentence in the panel', () => {
    assert.match(mod.requests.problemText({ status: 409, json: { code: 'KEYS_LOCKED', message: 'cannot unlock stored keys: the key file does not match' } }), /cannot unlock stored keys.*Nothing was sent/);
  });
});

describe('cover drafts', () => {
  const INFO = {
    available: true,
    provider: { id: 'prof_img', name: 'Pictures', model: 'image-1', host: 'images.example.com', locality: 'cloud' },
    prompt: 'A cover for "The Salt Orchard".',
    maxPromptChars: 4000,
    drafts: [{ name: 'cover-20261103-091500-1.png', created: '2026-11-03T09:15:00.000Z', prompt: 'A drowned orchard', isCover: false }],
  };
  const BOOKX = { id: 'book_1', title: 'B' };

  test('no button without an image provider (or before the server answered); with one, the Cover drafts button', () => {
    assert.equal(html(h(mod.cover.CoverDraftsButton, { book: BOOKX })), '', 'nothing before the server answers');
    globalThis.__sfApi = { '/api/books/book_1/ai/cover': { ...INFO, available: false, provider: null } };
    assert.equal(html(h(mod.cover.CoverDraftsButton, { book: BOOKX })), '', 'no image provider: no button');
    globalThis.__sfApi = { '/api/books/book_1/ai/cover': INFO };
    assert.match(text(html(h(mod.cover.CoverDraftsButton, { book: BOOKX }))), /Cover drafts/);
  });

  test('the drafts dialog lists drafts with Use as cover and Delete, and starts with Generate a draft', () => {
    const t = text(html(h(mod.cover.CoverDraftsDialog, { book: BOOKX, info: INFO, onChanged() {}, onClose() {} })));
    assert.match(t, /A drowned orchard/);
    assert.match(t, /Use as cover/);
    assert.match(t, /Delete draft/);
    assert.match(t, /Generate a draft/);
    assert.match(t, /never replace your cover by themselves/);
  });

  test('the consent dialog names exactly what leaves: the prompt only, the provider, its host and cloud or local', () => {
    const consent = (provider) => text(html(h(mod.cover.ConsentDialog, { info: { ...INFO, provider }, prompt: 'A lighthouse at dusk', sending: false, error: null, onSend() {}, onClose() {} })));
    const cloud = consent(INFO.provider);
    assert.match(cloud, /only the text below/);
    assert.match(cloud, /A lighthouse at dusk/);
    assert.match(cloud, /images\.example\.com +, which is not on this computer/);
    assert.match(cloud, /Pictures · image-1/);
    assert.match(cloud, /No scene, note, file or other part of your book is sent/);
    assert.match(cloud, /Cloud/);
    const local = consent({ ...INFO.provider, host: '127.0.0.1:8188', locality: 'local' });
    assert.match(local, /127\.0\.0\.1:8188 +, a server on this computer/);
    assert.match(local, /Local/);
  });
});
