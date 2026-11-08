// M12 W4 (web side): the "Continuity settings" panel of the Continuity page and its pure helpers (render tests, no browser, no network).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { RULES } from '../../../packages/continuity/src/index.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
const mod = {};

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.model = await vite.ssrLoadModule('/src/continuity/model.js');
  mod.req = await vite.ssrLoadModule('/src/continuity/requests.js');
  mod.panel = await vite.ssrLoadModule('/src/continuity/ContinuitySettings.jsx');
  mod.page = await vite.ssrLoadModule('/src/continuity/ContinuityPage.jsx');
});
after(async () => {
  await vite?.close();
});

test('every engine rule has a plain name and description in the web table (CS1, CS2 and TH2 included)', () => {
  for (const r of RULES) assert.ok(mod.model.RULE_INFO[r.id], `${r.id} is in RULE_INFO`);
  assert.deepEqual(mod.model.RULE_IDS.filter((id) => ['CS1', 'CS2', 'TH2'].includes(id)), ['CS1', 'CS2', 'TH2']);
  for (const id of ['CS1', 'CS2', 'TH2']) assert.equal(mod.model.familyOf(id), 'facts', id);
});

test('new-rule findings are listed like the others, under their plain names and in the rule filter', () => {
  const finding = (rule, title) => ({ fingerprint: `${rule.toLowerCase()}-0123456789abcdef`, rule, rule_version: 1, severity: rule === 'TH2' ? 'warning' : 'error', title, message: 'm', subject: { kind: 'entry', id: 'entry_1', name: 'Pell' }, sources: [{ file: 'a.md', heading: 'A', line: 2, location: 'x', kind: 'scene', role: 'text', id: 'scene_1', range: null, excerpt: '' }], related: [] });
  const result = { findings: [finding('CS1', 'Pell is on the page after dying'), finding('CS2', 'Knife is used after being lost'), finding('TH2', '"Key" is overdue')], suppressed: [], stale_exceptions: [] };
  const html = renderToStaticMarkup(h(mod.page.ContinuityPage, { bookId: 'book_1', result }));
  for (const t of ['Pell is on the page after dying', 'Knife is used after being lost', '&quot;Key&quot; is overdue', 'Dead on the page', 'Gone object used', 'Promise overdue']) assert.ok(html.includes(t), t);
  const only = mod.model.queueModel(result, { rule: 'TH2' });
  assert.deepEqual(only.rows.map((r) => r.rule), ['TH2']);
});

test('settings helpers: the form state from the answer, and the body that leaves out rules on Default', () => {
  const draft = mod.model.settingsDraft({ overdue_chapters: 8, severity: { CS1: 'warning', TH2: 'off' } });
  assert.deepEqual(draft, { overdue: '8', severity: { CS1: 'warning', TH2: 'off' } });
  assert.deepEqual(mod.model.settingsDraft(null), { overdue: '12', severity: {} });
  assert.deepEqual(mod.model.settingsBody({ overdue: '9', severity: { TH2: 'off', CS1: '', PL1: 'info' } }), { overdue_chapters: 9, severity: { PL1: 'info', TH2: 'off' } });
  assert.deepEqual(mod.req.saveSettingsRequest('book_1', { overdue_chapters: 9, severity: {} }), { method: 'POST', url: '/api/books/book_1/continuity/settings', body: { overdue_chapters: 9, severity: {} } });
  assert.equal(mod.req.settingsUrl('book 1'), '/api/books/book%201/continuity/settings');
});

test('the settings panel shows overdue chapters and a severity choice for every rule, with Off', () => {
  const html = renderToStaticMarkup(h(mod.panel.ContinuitySettings, { settings: { exists: true, overdue_chapters: 7, severity: { CS1: 'off', PL1: 'info' } }, onSave: () => {} }));
  assert.match(html, /<summary>Continuity settings<\/summary>/);
  assert.match(html, /name="overdue_chapters"[^>]*value="7"/);
  for (const r of RULES) assert.ok(html.includes(`name="severity-${r.id}"`), `${r.id} has a select`);
  assert.match(html, /<option value="off" selected="">Off<\/option>/);
  assert.match(html, /<option value="info" selected="">Info<\/option>/);
  assert.match(html, /planning\/continuity\/settings\.md/);
  const bad = renderToStaticMarkup(h(mod.panel.ContinuitySettings, { settings: { overdue_chapters: 7, severity: {} }, error: 'Not saved.', saved: false, onSave: () => {} }));
  assert.match(bad, /role="alert"[^>]*>Not saved\./);
});

test('the page renders the settings panel only when it is given one', () => {
  const result = { findings: [], suppressed: [], stale_exceptions: [] };
  const without = renderToStaticMarkup(h(mod.page.ContinuityPage, { bookId: 'book_1', result }));
  assert.ok(!without.includes('Continuity settings</summary>'));
  const panel = h(mod.panel.ContinuitySettings, { settings: { overdue_chapters: 12, severity: {} }, onSave: () => {} });
  const withPanel = renderToStaticMarkup(h(mod.page.ContinuityPage, { bookId: 'book_1', result, settingsPanel: panel }));
  assert.ok(withPanel.includes('Continuity settings</summary>'));
});
