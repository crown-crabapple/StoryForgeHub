// Settings -> AI connections (MCP), render level: the slug rule (including names already in use), the setup text for each client, the list of keys, and that a
// key and its setup appear only when one was just made.
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

describe('Settings -> AI connections (MCP)', () => {
  test('connectionSlug builds mcp-<name>, rejects what the plugin rule rejects, and refuses a name already in use', () => {
    assert.deepEqual(c.connectionSlug(' Laptop '), { ok: true, slug: 'mcp-laptop' });
    assert.deepEqual(c.connectionSlug('work-pc-2'), { ok: true, slug: 'mcp-work-pc-2' });
    for (const bad of ['', '   ', 'my laptop', 'a--b', '-a', 'a-', 'under_score', 'é']) assert.equal(c.connectionSlug(bad).ok, false, bad);
    const taken = c.connectionSlug('Laptop', ['mcp-laptop']);
    assert.equal(taken.ok, false);
    assert.match(taken.message, /already have a connection named laptop/);
    assert.deepEqual(c.connectionSlug('desktop', ['mcp-laptop']), { ok: true, slug: 'mcp-desktop' });
  });

  test('connectionPermissions: read always, propose and canvas when ticked, never events', () => {
    assert.deepEqual(c.connectionPermissions(true), ['read', 'propose']);
    assert.deepEqual(c.connectionPermissions(false), ['read']);
    assert.deepEqual(c.connectionPermissions(true, true), ['read', 'propose', 'canvas']);
    assert.deepEqual(c.connectionPermissions(false, true), ['read', 'canvas']);
    assert.deepEqual(c.connectionPermissions(false, false), ['read']);
  });

  test('connectSnippets fills in the key and origin; Claude Desktop only outside shared mode', () => {
    const p = c.connectSnippets({ token: 'tok_SECRET', origin: 'http://127.0.0.1:4317', mode: 'personal' });
    assert.equal(p.address, 'http://127.0.0.1:4317/mcp');
    assert.equal(p.header, 'Authorization: Bearer tok_SECRET');
    assert.equal(p.claudeCode, 'claude mcp add --transport http storyforge http://127.0.0.1:4317/mcp --header "Authorization: Bearer tok_SECRET"');
    const cfg = JSON.parse(p.claudeDesktop);
    assert.equal(cfg.mcpServers.storyforge.env.STORYFORGE_TOKEN, 'tok_SECRET');
    assert.deepEqual(cfg.mcpServers.storyforge.args, ['<path to StoryForge>/apps/server/src/main.mjs', 'mcp']);
    assert.equal(c.connectSnippets({ token: 't', origin: 'https://x.example', mode: 'shared' }).claudeDesktop, null);
  });

  test('setupBlocks and clientsFor: one set of copy blocks per client; no Claude Desktop in shared mode', () => {
    const s = c.connectSnippets({ token: 'tok_K', origin: 'https://x.example', mode: 'personal' });
    assert.deepEqual(c.setupBlocks('claude-code', s).map((b) => b.label), ['Claude Code command']);
    assert.deepEqual(c.setupBlocks('claude-desktop', s).map((b) => b.label), ['Claude Desktop config (claude_desktop_config.json)']);
    assert.deepEqual(c.setupBlocks('other', s), [
      { label: 'Server address (Streamable HTTP)', text: 'https://x.example/mcp' },
      { label: 'Header', text: 'Authorization: Bearer tok_K' },
    ]);
    const shared = c.connectSnippets({ token: 'tok_K', origin: 'https://x.example', mode: 'shared' });
    assert.deepEqual(c.setupBlocks('claude-desktop', shared).map((b) => b.label), ['Server address (Streamable HTTP)', 'Header'], 'falls back to the generic setup');
    assert.deepEqual(c.clientsFor('personal').map((x) => x.id), ['claude-code', 'claude-desktop', 'other']);
    assert.deepEqual(c.clientsFor('shared').map((x) => x.id), ['claude-code', 'other']);
  });

  test('the view lists every live mcp- connection with its last use, and offers another', () => {
    const data = {
      grants: [
        GRANT({ permissions: ['read', 'propose'], last_used: 1_793_100_000_000 }),
        GRANT({ id: 'tok_4', plugin: 'mcp-desktop' }),
        GRANT({ id: 'tok_2', plugin: 'word-frequency' }),
        GRANT({ id: 'tok_3', plugin: 'mcp-old', revoked: true }),
      ],
      books: BOOKS,
    };
    const out = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'personal' }));
    const t = text(out);
    assert.match(t, /AI connections \(MCP\)/);
    assert.match(t, /Your connections \(2\)/);
    assert.match(t, /laptop/);
    assert.match(t, /desktop/);
    assert.match(t, /read your books, suggest changes/);
    assert.match(t, /Last used 2026-10-27\./);
    assert.match(t, /Not used yet\./);
    assert.match(t, /Add another connection/);
    assert.match(t, /The AI may edit canvases \(planning boards only, never your prose\)/);
    assert.match(t, /AI client Claude Code Claude Desktop Other MCP client/);
    assert.match(html(h(c.ClaudeView, { data: { grants: [GRANT({ permissions: ['read', 'canvas'] })], books: BOOKS }, origin: 'http://h', mode: 'personal' })), /read your books, edit canvases/);
    assert.doesNotMatch(t, /word-frequency|old/);
    assert.match(out, /aria-label="Revoke the connection laptop"/);
    assert.match(out, /aria-label="Revoke the connection desktop"/);
    assert.doesNotMatch(out, /Access token for/);
    const empty = text(html(h(c.ClaudeView, { data: { grants: [], books: BOOKS }, origin: 'http://h', mode: 'shared' })));
    assert.match(empty, /No connections yet\. New connection/);
    assert.doesNotMatch(empty, /Claude Desktop/, 'shared mode does not offer Claude Desktop');
  });

  test('a key just made shows once, with setup for the client picked', () => {
    const data = { grants: [GRANT()], books: BOOKS };
    const code = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'shared', created: { token: 'tok_ABC', plugin: 'mcp-laptop', client: 'claude-code' } }));
    assert.match(code, /Access token for mcp-laptop/);
    assert.match(code, /Claude Code command/);
    assert.doesNotMatch(code, /Claude Desktop config/);
    const other = text(html(h(c.ClaudeView, { data, origin: 'https://x.example', mode: 'shared', created: { token: 'tok_ABC', plugin: 'mcp-agent', client: 'other' } })));
    assert.match(other, /Server address \(Streamable HTTP\)/);
    assert.match(other, /Authorization: Bearer tok_ABC/);
    assert.doesNotMatch(other, /Claude Code command/);
    const desk = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'personal', created: { token: 'tok_ABC', plugin: 'mcp-desktop', client: 'claude-desktop' } }));
    assert.match(desk, /Claude Desktop config/);
    const deskShared = html(h(c.ClaudeView, { data, origin: 'http://h', mode: 'shared', created: { token: 'tok_ABC', plugin: 'mcp-desktop', client: 'claude-desktop' } }));
    assert.doesNotMatch(deskShared, /Claude Desktop config/, 'shared mode falls back to the first client');
    assert.match(deskShared, /Claude Code command/);
  });
});
