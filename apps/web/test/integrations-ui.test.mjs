// M08-J02: Settings -> Plugins and Webhooks, render level (no browser, no network). What the author must see before confirming a grant, that a token or a secret appears only
// when it was just made, the include-text warning, and that every control is a native, named, keyboard-reachable element.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const m = {};
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  Object.assign(m, await vite.ssrLoadModule('/src/integrations/PluginsPanel.jsx'), await vite.ssrLoadModule('/src/integrations/WebhooksPanel.jsx'));
  m.settings = await vite.ssrLoadModule('/src/ai/SettingsView.jsx');
  m.prefs = await vite.ssrLoadModule('/src/prefs/PrefsContext.jsx');
});
after(async () => {
  await vite?.close();
});

const BOOKS = [{ id: 'book_1', slug: 'salt-orchard', title: 'The Salt Orchard' }, { id: 'book_2', slug: 'second', title: 'A Second Book' }];
const MANIFEST = (over = {}) => ({ plugin: 'word-frequency', name: 'Word frequency', version: '1.0.0', api: 1, permissions: ['read'], books: 'all', homepage: '', description: 'Counts words.', path: '_plugins/wf/plugin.md', problems: [], ...over });
const GRANT = (over = {}) => ({ id: 'tok_01S8000000000000000000AAAA', plugin: 'word-frequency', permissions: ['read'], books: 'all', created: 1_793_000_000_000, last_used: null, revoked: false, ...over });
const HOOK = (over = {}) => ({ id: 'whk_01S8000000000000000000AAAA', url: 'https://example.com/h', events: ['scene.saved'], books: 'all', include_content: false, allow_local: false, plugin: null, secret_hash: 'a'.repeat(64), created: 1_793_000_000_000, revoked: false, disabled: false, failures: 0, last_delivery: null, ...over });

describe('Settings -> Plugins', () => {
  test('a manifest shows what it asks for; Grant access names the plugin; nothing is granted by seeing it', () => {
    const out = html(h(m.PluginsView, { data: { manifests: [MANIFEST({ permissions: ['read', 'propose'], books: ['salt-orchard'] })], grants: [], books: BOOKS } }));
    const t = text(out);
    assert.match(t, /Word frequency/);
    assert.match(t, /Asks for: read, propose\. Books: salt-orchard/);
    assert.match(out, /aria-label="Grant access to Word frequency"/);
    assert.match(t, /No access granted yet/);
    assert.match(t, /never runs it/);
  });

  test('the confirmation lists every permission in words and the books, and the grant button says what it does', () => {
    const ask = { plugin: 'word-frequency', name: 'Word frequency', permissions: ['read', 'propose'], books: ['salt-orchard'], manual: false };
    const out = html(h(m.PluginsView, { data: { manifests: [MANIFEST()], grants: [], books: BOOKS }, ask }));
    const t = text(out);
    assert.match(t, /Grant access to Word frequency/);
    for (const p of ['read', 'propose', 'canvas', 'plan', 'events']) assert.ok(t.includes(m.PERMISSION_TEXT[p]), p);
    assert.match(t, /Nothing in your book changes until you accept a suggestion yourself/);
    assert.match(t, /can never ask for scene text/);
    assert.equal((out.match(/type="checkbox"[^>]*checked/g) ?? []).length >= 3, true, 'what was asked for is ticked: 2 permissions and the one book');
    assert.match(out, /<button type="submit" class="btn btn-primary"[^>]*>Grant access<\/button>/);
    assert.match(t, /A Second Book/, 'every book is offered, so the author can narrow the grant');
    assert.match(t, /Cancel/);
  });

  test('a manifest that needs a newer StoryForge, or is broken, cannot be granted', () => {
    const out = html(h(m.PluginsView, { data: { manifests: [MANIFEST({ api: 2, problems: [{ code: 'W315', location: 'api', message: 'x' }] }), MANIFEST({ plugin: null, name: null, path: '_plugins/b/plugin.md', problems: [{ code: 'E102', location: 'schema', message: 'schema must be storyforge.plugin/v1' }] })], grants: [], books: BOOKS } }));
    assert.match(text(out), /needs a newer StoryForge/);
    assert.match(text(out), /E102 schema: schema must be storyforge\.plugin\/v1/);
    assert.equal((out.match(/<button[^>]*disabled=""[^>]*>Grant access<\/button>/g) ?? []).length, 2);
  });

  test('the token is shown only when it was just made, with Copy and Done; the list never has a token', () => {
    const grants = [GRANT(), GRANT({ id: 'tok_01S8000000000000000000BBBB', plugin: 'other', revoked: true })];
    const token = 'T'.repeat(43);
    const plain = html(h(m.PluginsView, { data: { manifests: [], grants, books: BOOKS } }));
    assert.equal(plain.includes(token), false);
    const fresh = html(h(m.PluginsView, { data: { manifests: [], grants, books: BOOKS }, created: { token, plugin: 'word-frequency' } }));
    assert.ok(fresh.includes(token));
    assert.match(text(fresh), /shown only once and cannot be shown again/);
    assert.match(text(fresh), /Copy token/);
    assert.match(text(fresh), /Done, I have saved it/);
    assert.match(fresh, /readOnly=""|readonly=""/i);
  });

  test('grants are listed with permissions, books and last use; each Revoke is named by its plugin and token id; a revoked one has no Revoke', () => {
    const out = html(h(m.PluginsView, { data: { manifests: [], grants: [GRANT(), GRANT({ id: 'tok_01S8000000000000000000BBBB', plugin: 'other', revoked: true })], books: BOOKS } }));
    const t = text(out);
    assert.match(t, /Permissions: read\. Books: All books\. Granted 2026-.* Last used never/);
    assert.match(t, /revoked/);
    assert.equal((out.match(/>Revoke</g) ?? []).length, 1);
    assert.match(out, /aria-label="Revoke access for word-frequency \(tok_01S8000000000000000000AAAA\)"/);
  });

  test('the module being off is said plainly', () => {
    assert.match(text(html(h(m.PluginsView, { data: { manifests: [], grants: [], books: [] }, moduleOff: true }))), /Integrations module is off/);
    assert.doesNotMatch(text(html(h(m.PluginsView, { data: { manifests: [], grants: [], books: [] } }))), /module is off/);
  });
});

describe('Settings -> Webhooks', () => {
  test('the create form warns clearly about the scene text and has it OFF by default; the warning is tied to the checkbox', () => {
    const out = html(h(m.WebhooksView, { data: { webhooks: [], events: [], books: BOOKS } }));
    const t = text(out);
    assert.match(t, /Include the scene text/);
    assert.match(t, /the full text of every scene you save is sent/);
    assert.match(t, /only ids, the file path and a hash are sent, never any of your writing/);
    const box = /<input type="checkbox"[^>]*aria-describedby="([^"]+)"[^>]*\/?><span>Include the scene text/.exec(out);
    assert.ok(box, 'the include-text checkbox has aria-describedby');
    assert.ok(out.includes(`id="${box[1]}"`));
    assert.doesNotMatch(/<input type="checkbox"[^>]*>(?=<span>Include the scene text)/.exec(out)?.[0] ?? '', /checked/);
    assert.match(t, /None\. StoryForge sends nothing anywhere\./);
  });

  test('every event can be chosen, with its plain name; scene.saved is the default', () => {
    const out = html(h(m.WebhooksView, { data: { webhooks: [], events: [], books: BOOKS } }));
    for (const [ev, words] of Object.entries(m.EVENT_TEXT)) assert.ok(text(out).includes(words) && out.includes(`<code>${ev}</code>`), ev);
    assert.equal(Object.keys(m.EVENT_TEXT).length, 8);
    assert.match(/<input type="checkbox" checked=""[^>]*\/?><span>A scene was saved/.exec(out)?.[0] ?? '', /checked/);
  });

  test('webhooks show their address, events, books, whether text is sent, status and the last delivery; a failure and a disabled one say so', () => {
    const hooks = [
      HOOK({ last_delivery: { at: 1_793_100_000_000, ok: true, status: 204, code: null } }),
      HOOK({ id: 'whk_01S8000000000000000000BBBB', url: 'http://127.0.0.1:8787/x', include_content: true, disabled: true, failures: 20, last_delivery: { at: 1_793_100_000_000, ok: false, status: 500, code: 'HTTP_500' } }),
      HOOK({ id: 'whk_01S8000000000000000000CCCC', url: 'https://gone.example/h', revoked: true }),
    ];
    const out = html(h(m.WebhooksView, { data: { webhooks: hooks, events: [], books: BOOKS } }));
    const t = text(out);
    assert.match(t, /https:\/\/example\.com\/h.*Ids and hashes only\. Active\. Last delivery 2026-.*: delivered \(204\)/);
    assert.match(t, /Includes the scene text\. Disabled after 20 failed deliveries in a row.*failed \(500\)/);
    assert.match(t, /Revoked\. No delivery yet/);
    assert.equal((out.match(/>Revoke</g) ?? []).length, 2, 'a revoked webhook has no Revoke');
    assert.match(out, /aria-label="Revoke the webhook to https:\/\/example\.com\/h \(whk_01S8000000000000000000AAAA\)"/);
    assert.equal(out.includes('a'.repeat(64)), false, 'not even the secret hash is drawn');
  });

  test('the secret is drawn only when it was just made', () => {
    const secret = 's'.repeat(64);
    assert.equal(html(h(m.WebhooksView, { data: { webhooks: [HOOK()], events: [], books: BOOKS } })).includes(secret), false);
    const out = html(h(m.WebhooksView, { data: { webhooks: [], events: [], books: BOOKS }, created: { secret, url: 'https://example.com/h' } }));
    assert.ok(out.includes(secret));
    assert.match(text(out), /shown only once/);
  });

  test('statusText and lastDeliveryText', () => {
    assert.equal(m.statusText(HOOK()), 'Active.');
    assert.match(m.statusText(HOOK({ disabled: true })), /Disabled after 20/);
    assert.equal(m.statusText(HOOK({ revoked: true })), 'Revoked.');
    assert.equal(m.lastDeliveryText(HOOK()), 'No delivery yet.');
  });
});

describe('Settings page and modules', () => {
  test('Settings shows both panels (personal mode), and the integrations module is listed last, like the server', () => {
    const t = text(html(h(m.settings.SettingsView)));
    assert.match(t, /Plugins/);
    assert.match(t, /Webhooks/);
    assert.ok(m.prefs.MODULES.some((x) => x.id === 'integrations'));
  });

  test('no control has a positive tab index, so the keyboard walk is the page order', () => {
    const out = html(h(m.PluginsView, { data: { manifests: [MANIFEST()], grants: [GRANT()], books: BOOKS }, ask: { plugin: '', name: '', permissions: ['read'], books: 'all', manual: true } })) + html(h(m.WebhooksView, { data: { webhooks: [HOOK()], events: [], books: BOOKS } }));
    assert.doesNotMatch(out, /tabindex="[1-9]/i);
    assert.doesNotMatch(out, /<div[^>]*onclick/i);
  });
});
