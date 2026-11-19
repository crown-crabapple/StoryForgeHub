// M13-J02 section 5, render level: the Grammar rail panel in each state, the Grammar settings section, the editor wiring (source scan) and the command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { GRAMMAR_DIALECTS } from '../../../packages/format/src/preferences.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let panel;
let settings;
let registry;
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  panel = await vite.ssrLoadModule('/src/grammar/RailGrammar.jsx');
  settings = await vite.ssrLoadModule('/src/prefs/GrammarSettings.jsx');
  registry = await vite.ssrLoadModule('/src/shortcuts/registry.js');
});
after(async () => {
  await vite?.close();
});

const finding = (over = {}) => ({
  id: 'f1',
  category: 'spelling',
  severity: 'warning',
  advisory: false,
  ruleId: 'SpellCheck',
  original: 'Mara',
  message: 'Did you mean to spell it differently?',
  replacements: ['Mare', ''],
  range: { from: 4, to: 8 },
  ...over,
});
const snap = (over = {}) => ({ state: 'completed', reason: null, findings: [], checkedAt: '2026-01-01T00:00:00.000Z', ...over });
const view = (snapshot, extra = {}) => html(h(panel.GrammarPanelView, { snapshot, ...extra }));

describe('the Grammar rail panel', () => {
  test('off: says so with a link to Settings, and no Check scene button', () => {
    for (const s of [null, snap({ state: 'disabled', checkedAt: null })]) {
      const out = view(s);
      assert.match(text(out), /Grammar checks are off for this book\. Turn them on in Settings ./);
      assert.match(out, /href="\/settings"/);
      assert.doesNotMatch(out, /Check scene/);
      assert.doesNotMatch(text(out), /No suggestions/);
    }
  });

  test('loading and checking are said in words, never "No suggestions"', () => {
    assert.match(text(view(snap({ state: 'ready', checkedAt: null }))), /Loading the checker/);
    assert.match(text(view(snap({ state: 'running', checkedAt: null }))), /Loading the checker/);
    const running = view(snap({ state: 'running' }));
    assert.match(text(running), /Checking…/);
    assert.doesNotMatch(text(running), /No suggestions/);
  });

  test('completed with nothing found: "No suggestions" in a polite live region, with the Check scene button', () => {
    const out = view(snap());
    assert.match(out, /<p class="muted gr-status" aria-live="polite">No suggestions<\/p>/);
    assert.match(out, /<button type="button" class="btn btn-small">Check scene<\/button>/);
    assert.doesNotMatch(out, /cf-card/);
  });

  test('completed with findings: count, category, flagged text button, message, replacements, Ignore, Add to dictionary, Turn off this rule', () => {
    const out = view(snap({ findings: [finding(), finding({ id: 'f2', category: 'grammar', ruleId: 'AnA', original: 'an', message: 'Use "a".', replacements: ['a'] })] }));
    const t = text(out);
    assert.match(t, /2 suggestions/);
    assert.match(out, /aria-live="polite">2 suggestions</);
    assert.match(t, /Spelling/);
    assert.match(t, /Did you mean to spell it differently\?/);
    assert.match(out, /aria-label="Show “Mara” in the text"/);
    assert.match(out, />Replace with ‘Mare’<\/button>/);
    assert.match(out, />Delete<\/button>/);
    assert.match(out, />Replace with ‘a’<\/button>/);
    assert.equal(out.match(/>Ignore<\/button>/g).length, 2);
    assert.equal(out.match(/>Turn off this rule<\/button>/g).length, 2);
    assert.equal(out.match(/>Add to dictionary<\/button>/g).length, 1, 'only the spelling finding offers the dictionary');
    assert.doesNotMatch(out, /Codex name/);
    assert.doesNotMatch(t, /No suggestions/);
    assert.match(out, /<ul class="cf-cards" aria-label="Grammar suggestions in this scene">/);
  });

  test('a spelling finding that is a Codex name or alias is labelled and offers Add to dictionary first (exact, case-sensitive)', () => {
    const names = panel.codexNameSet({ entries: [{ name: 'Mara Vell', aliases: ['Mara'] }, { name: 'Kestrel' }] });
    assert.deepEqual([...names].sort(), ['Kestrel', 'Mara', 'Mara Vell']);
    const out = view(snap({ findings: [finding()] }), { codexNames: names });
    assert.match(out, /Codex name/);
    assert.ok(out.indexOf('Add to dictionary') < out.indexOf('Replace with'), 'Add to dictionary comes before the replacements');
    const lower = view(snap({ findings: [finding({ original: 'mara' })] }), { codexNames: names });
    assert.doesNotMatch(lower, /Codex name/);
    const grammar = view(snap({ findings: [finding({ category: 'grammar', original: 'Mara' })] }), { codexNames: names });
    assert.doesNotMatch(grammar, /Codex name/);
  });

  test('unavailable shows the reason; failed shows the failure; neither says "No suggestions"', () => {
    const reason = 'This scene does not look like English. Grammar checks support English only.';
    const un = view(snap({ state: 'unavailable', reason }));
    assert.match(text(un), /This scene does not look like English\. Grammar checks support English only\./);
    assert.doesNotMatch(text(un), /No suggestions/);
    const failed = view(snap({ state: 'failed', reason: 'The worker could not start' }));
    assert.match(text(failed), /The grammar checker could not run: The worker could not start/);
    assert.doesNotMatch(text(failed), /No suggestions/);
  });

  test('a note (such as the stale message) is shown in a status region', () => {
    assert.equal(panel.STALE_NOTE, 'The text changed; checking again');
    assert.match(view(snap(), { note: panel.STALE_NOTE }), /<p class="muted" role="status">The text changed; checking again<\/p>/);
  });

  test('replacement labels', () => {
    assert.equal(panel.replaceLabel(''), 'Delete');
    assert.equal(panel.replaceLabel('a'), 'Replace with ‘a’');
  });
});

describe('Settings -> Grammar checks', () => {
  const book = { id: 'book_1', title: 'The Salt Orchard' };
  const controls = (grammar) => html(h(settings.GrammarBookControls, { book, grammar: { enabled: true, dialect: 'british', words: ['Mara', 'Kestrel'], rules: { SpellCheck: false, LongSentences: true }, ...grammar }, onChange: () => {} }));

  test('the dialect choices are the format dialects', () => {
    assert.deepEqual(settings.DIALECT_CHOICES.map((d) => d.id), GRAMMAR_DIALECTS);
  });

  test('the switch, dialect select, dictionary with Remove and turned-off rules with Turn back on', () => {
    const out = controls({});
    assert.match(out, /<input type="checkbox" checked=""/);
    assert.match(text(out), /Check grammar and spelling \(English\)/);
    assert.match(out, /<option value="british" selected="">British English<\/option>/);
    for (const d of GRAMMAR_DIALECTS) assert.match(out, new RegExp(`<option value="${d}"`));
    assert.match(out, /aria-label="Remove Mara from the dictionary"/);
    assert.match(out, /aria-label="Remove Kestrel from the dictionary"/);
    assert.match(out, /aria-label="Turn back on the rule SpellCheck"/);
    assert.doesNotMatch(out, /Turn back on the rule LongSentences/, 'only rules set to false are listed');
    assert.match(text(out), /Turn back on/);
  });

  test('off, with an empty dictionary and no rules', () => {
    const out = controls({ enabled: false, words: [], rules: {} });
    assert.doesNotMatch(out, /<input type="checkbox" checked=""/);
    assert.match(text(out), /No words yet/);
    assert.match(text(out), /No rules are turned off/);
    assert.doesNotMatch(out, />Remove</);
  });

  test('the section says the checks run on this computer, nothing is sent, and about 20 MB loads only when on', () => {
    const t = text(html(h(settings.GrammarSettingsView, { books: [] })));
    assert.match(t, /Grammar checks/);
    assert.match(t, /run on this computer and nothing is sent anywhere/);
    assert.match(t, /about 20 MB/);
    assert.match(t, /loaded only when checks are on/);
  });

  test('is mounted in Settings outside the owner-only block', () => {
    const src = readFileSync(new URL('../src/ai/SettingsView.jsx', import.meta.url), 'utf8');
    const at = src.indexOf('<GrammarSettings />');
    assert.ok(at > src.indexOf('<AiLevelSettings />'));
    const ownerBlock = src.slice(src.indexOf("{(mode !== 'shared' || user?.role === 'owner') && ("), src.indexOf('<GrammarSettings />'));
    assert.match(ownerBlock, /<\/>\s*\)\}\s*$/, 'the owner-only block is closed before the grammar section');
  });
});

describe('the editor wiring', () => {
  const src = readFileSync(new URL('../src/editor/SceneEditorPage.jsx', import.meta.url), 'utf8');

  test('the worker is created only behind the enabled check, from a literal URL, and never at module load', () => {
    assert.match(src, /new Worker\(new URL\('\.\.\/grammar\/harper\.worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
    assert.equal(src.match(/new Worker\(/g).length, 1);
    assert.equal(src.match(/createGrammarController\(/g).length, 1);
    assert.match(src, /const grammarOn = !isEntry && grammarSettings\?\.enabled === true;/);
    const guard = src.indexOf('if (!grammarOn || !view)');
    assert.ok(guard > 0 && guard < src.indexOf('createGrammarController({'), 'the controller is built after the enabled guard returned');
    assert.ok(src.indexOf('createGrammarController({') < src.indexOf('new Worker('));
  });

  test('findings reach the editor through setFindings; the controller is disposed; every doc change is passed on', () => {
    assert.match(src, /setFindings\.of\(list\)/);
    assert.match(src, /ctl\.dispose\(\)/);
    assert.match(src, /docChanged\(\(grammarVersion\.current \+= 1\), u\.state\.doc\.toString\(\)\)/);
    assert.match(src, /'editor\.checkScene': \(\) =>/);
  });

  test('the bridge carries what the panel needs', () => {
    for (const name of ['grammar:', 'applyFinding(id, index)', 'selectBodyRange(from, to)', 'checkNow:', 'ignoreFinding(id)']) assert.ok(src.includes(name), name);
  });
});

describe('the command', () => {
  test('editor.checkScene is registered: "Check grammar now", editor scope, Mod+Alt+G, handled by the scene editor', () => {
    const c = registry.COMMANDS.find((x) => x.id === 'editor.checkScene');
    assert.ok(c);
    assert.equal(c.label, 'Check grammar now');
    assert.equal(c.scope, 'editor');
    assert.equal(c.binding, 'Mod+Alt+G');
    assert.deepEqual(c.files, ['editor/SceneEditorPage.jsx']);
  });
});
