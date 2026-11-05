// Settings -> Connect Claude, render level: the slug rule, the setup text, and that the token and snippets appear only when a token was just made.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let c;
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  c = await vite.ssrLoadModule('/src/integrations/ClaudePanel.jsx');
});
after(async () => {
  await vite?.close();
});

const BOOKS = [{ id: 'book_1', slug: 'salt-orchard', title: 'The Salt Orchard' }];
const GRANT = (over = {}) => ({ id: 'tok_01S8000000000000000000AAAA', plugin: 'mcp-laptop', permissions: ['read'], books: 'all', created: 1_793_000_000_000, last_used: null, revoked: false, ...over });

describe('Settings -> Connect Claude', () => {
  test('connectionSlug builds mcp-<name> and rejects what the plugin rule rejects', () => {
    assert.deepEqual(c.connectionSlug(' Laptop '), { ok: true, slug: 'mcp-laptop' });
    assert.deepEqual(c.connectionSlug('work-pc-2'), { ok: true, slug: 'mcp-work-pc-2' });
    for (const bad of ['', '   ', 'my laptop', 'a--b', '-a', 'a-', 'under_score', 'é']) assert.equal(c.connectionSlug(bad).ok, false, bad);
  });

  test('connectionPermissions: read always, propose and canvas when ticked, never events', () => {
    assert.deepEqual(c.connectionPermissions(true), ['read', 'propose']);
    assert.deepEqual(c.connectionPermissions(false), ['read']);
    assert.deepEqual(c.connectionPermissions(true, true), ['read', 'propose', 'canvas']);
    assert.deepEqual(c.connectionPermissions(false, true), ['read', 'canvas']);
    assert.deepEqual(c.connectionPermissions(false, false), ['read']);
  });

  test('connectSnippets fills in the token and origin; Claude Desktop only outside shared mode', () => {
    const p = c.connectSnippets({ token: 'tok_SECRET', origin: 'http://127.0.0.1:4317', mode: 'personal' });
    assert.equal(p.address, 'http://127.0.0.1:4317/mcp');
    assert.equal(p.claudeCode, 'claude mcp add --transport http storyforge http://127.0.0.1:4317/mcp --header "Authorization: Bearer tok_SECRET"');
    const cfg = JSON.parse(p.claudeDesktop);
    assert.equal(cfg.mcpServers.storyforge.env.STORYFORGE_TOKEN, 'tok_SECRET');
    assert.deepEqual(cfg.mcpServers.storyforge.args, ['<path to StoryForge>/apps/server/src/main.mjs', 'mcp']);
    assert.equal(c.connectSnippets({ token: 't', origin: 'https://x.example', mode: 'shared' }).claudeDesktop, null);
  });

  test('the view lists only live mcp- connections, shows the token and snippets only when just created', () => {
    const data = { grants: [GRANT({ permissions: ['read', 'propose'] }), GRANT({ id: 'tok_2', plugin: 'word-frequency' }), GRANT({ id: 'tok_3', plugin: 'mcp-old', revoked: true })], books: BOOKS };
    const out = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'personal' }));
    const t = text(out);
    assert.match(t, /laptop/);
    assert.match(t, /read your books, suggest changes/);
    assert.match(t, /Claude may edit canvases \(planning boards only, never your prose\)/);
    assert.match(html(h(c.ClaudeView, { data: { grants: [GRANT({ permissions: ['read', 'canvas'] })], books: BOOKS }, origin: 'http://h', mode: 'personal' })), /read your books, edit canvases/);
    assert.doesNotMatch(t, /word-frequency|old/);
    assert.match(out, /aria-label="Revoke the connection laptop"/);
    assert.doesNotMatch(out, /Access token for/);
    const shown = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'shared', created: { token: 'tok_ABC', plugin: 'mcp-laptop' } }));
    assert.match(shown, /Access token for mcp-laptop/);
    assert.match(shown, /Claude Code command/);
    assert.doesNotMatch(shown, /Claude Desktop config/);
  });
});
