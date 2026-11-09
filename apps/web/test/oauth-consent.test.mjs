// The OAuth consent page (/oauth/authorize): what the owner sees when an AI app (claude.ai, ChatGPT) signs in, and the name rule it shares with Settings.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let m;
let panel;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m = await vite.ssrLoadModule('/src/integrations/OAuthConsent.jsx');
  panel = await vite.ssrLoadModule('/src/integrations/ClaudePanel.jsx');
});
after(async () => {
  await vite?.close();
});

const INFO = {
  client: { name: 'Claude', redirect_host: 'claude.ai' },
  name: 'claude',
  taken: ['mcp-laptop'],
  permissions: { available: ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft'], ticked: ['read', 'propose'], asked: [] },
  books: [{ id: 'b1', slug: 'salt-orchard', title: 'Salt Orchard' }],
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

test('the form names the app and where it returns, suggests the name and ticks read and propose only', () => {
  const html = renderToStaticMarkup(h(m.ConsentView, { state: { kind: 'ready', info: INFO } }));
  const t = text(html);
  assert.ok(t.includes('Claude wants to connect to your StoryForge'), t);
  assert.ok(t.includes('you go back to claude.ai'), t);
  assert.match(html, /<input id="[^"]*-name" type="text"[^>]*value="claude"/);
  const boxes = [...html.matchAll(/<input type="checkbox"([^>]*)\/><span>([^<]*)<\/span>/g)].map((x) => [x[2].split(' ')[0], x[1].includes('checked')]);
  assert.deepEqual(boxes, [['Suggest', true], ['Edit', false], ['Change', false], ['Workspace', false], ['Create', false]]);
  assert.match(html, /<button type="submit" class="btn btn-primary">Allow<\/button>/);
  assert.match(html, /<button type="button" class="btn">Deny<\/button>/);
});

test('a refused request explains itself, and offers the way back only when the server gave one', () => {
  const owner = renderToStaticMarkup(h(m.ConsentView, { state: { kind: 'error', message: 'Only the owner of this StoryForge can connect an AI app.' } }));
  assert.ok(text(owner).includes('Only the owner'));
  assert.ok(!owner.includes('Return to the app'));
  const back = renderToStaticMarkup(h(m.ConsentView, { state: { kind: 'error', message: 'a PKCE code_challenge is required', redirect: 'https://claude.ai/cb?error=invalid_request' } }));
  assert.ok(back.includes('Return to the app'));
  assert.ok(text(renderToStaticMarkup(h(m.ConsentView, { state: { kind: 'leaving', app: 'Claude' } }))).includes('Returning you to Claude'));
});

test('connection names follow the Settings rule', () => {
  assert.equal(m.nameProblem('claude', []), null);
  assert.match(m.nameProblem('', []), /name/);
  assert.match(m.nameProblem('Bad Name', []), /lower-case/);
  assert.match(m.nameProblem('laptop', ['mcp-laptop']), /already/);
});

test('Settings tells a shared-mode owner how claude.ai and ChatGPT connect', () => {
  const shared = renderToStaticMarkup(h(panel.ClaudeView, { data: { grants: [], books: [] }, mode: 'shared', serverAddress: 'https://app.example/mcp' }));
  assert.ok(text(shared).includes('claude.ai, ChatGPT and Claude Code can sign in instead of using a key'));
  assert.ok(shared.includes('<code>https://app.example/mcp</code>'));
  const personal = renderToStaticMarkup(h(panel.ClaudeView, { data: { grants: [], books: [] }, mode: null, serverAddress: 'http://127.0.0.1:4317/mcp' }));
  assert.ok(!personal.includes('sign in instead of using a key'));
});
