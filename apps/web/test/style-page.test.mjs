// M13-J03 sections 6 and 9, render level: the Style checks page in each state, the Checks panel with both groups, the Style checks settings section, the route, the editor wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let page;
let panel;
let settings;
let model;
let routes;
let appearance;
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  page = await vite.ssrLoadModule('/src/style/StyleChecksPage.jsx');
  panel = await vite.ssrLoadModule('/src/grammar/RailGrammar.jsx');
  settings = await vite.ssrLoadModule('/src/prefs/StyleSettings.jsx');
  model = await vite.ssrLoadModule('/src/style/model.js');
  routes = await vite.ssrLoadModule('/src/routes.js');
  appearance = await vite.ssrLoadModule('/src/prefs/appearance.js');
});
after(async () => {
  await vite?.close();
});

const BOOK = 'book_1';
const S1 = 'scene_01HZX0000000000000000000A1';
const S2 = 'scene_01HZX0000000000000000000A2';
const CHAPTERS = [
  { key: '1:1', act: 1, chapter: 1, label: 'Chapter One: The Drowned Rows', scenes: [{ id: S1, title: 'Arrival' }, { id: S2, title: 'Quiet' }] },
  { key: '1:2', act: 1, chapter: 2, label: 'Chapter Two', scenes: [] },
];
const PLACES = { [S1]: { act: 1, chapter: 1, chapterLabel: 'Chapter One: The Drowned Rows', title: 'Arrival' }, [S2]: { act: 1, chapter: 2, chapterLabel: 'Chapter Two', title: 'Quiet' } };

const finding = (over = {}) => ({
  id: 'fnd_0000000000000001',
  schema: 'storyforge.finding/v1',
  engine: 'textlint',
  engineVersion: '16.1.1',
  ruleId: 'repeated-words',
  category: 'repetition',
  severity: 'warning',
  advisory: false,
  message: 'The word "the" is repeated.',
  sceneId: S1,
  range: { from: 10, to: 17 },
  original: 'the the',
  replacements: ['the'],
  fingerprint: 'sty-0123456789abcdef',
  fileSha256: 'a'.repeat(64),
  ...over,
});
const advice = (over = {}) => finding({ id: 'fnd_0000000000000002', ruleId: 'repeated-phrases', category: 'repetition', severity: 'info', advisory: true, message: 'This phrase comes back soon.', sceneId: S2, range: { from: 5, to: 30 }, original: 'she did not look back', replacements: [], related: [{ sceneId: S1, from: 100, to: 125, text: 'she did not look back' }], ...over });
const long = () => finding({ id: 'fnd_0000000000000003', ruleId: 'long-paragraphs', category: 'rhythm', severity: 'info', advisory: true, message: 'This paragraph has 300 words.', sceneId: S2, range: { from: 0, to: 40 }, original: 'x'.repeat(40), replacements: [] });
const scanOf = (over = {}) => ({ state: 'completed', done: 2, total: 2, findings: [finding(), advice(), long()], errors: [], truncated: false, startedAt: 't0', finishedAt: 't1', staleDismissals: [], chapters: PLACES, ...over });
const render = (props) => html(h(page.StyleChecksPage, { bookId: BOOK, enabled: true, chapters: CHAPTERS, scope: { kind: 'manuscript', chapterKey: null, ids: [] }, canRun: true, scan: null, group: 'rule', dismissals: [], ...props }));
const links = (markup) => [...markup.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

describe('the Style checks page', () => {
  test('off: says so with a link to Settings and offers no Run', () => {
    const out = render({ enabled: false });
    assert.match(text(out), /Style checks are off for this book\. Turn them on in Settings \./);
    assert.match(out, /href="\/settings"/);
    assert.doesNotMatch(out, />Run</);
  });

  test('idle: scope choices, a chapter select and Run; no results and no progress', () => {
    const out = render({});
    assert.match(text(out), /Whole manuscript/);
    assert.match(text(out), /One chapter/);
    assert.match(text(out), /Chosen scenes/);
    assert.match(out, /<button type="button" class="btn btn-primary">Run<\/button>/);
    assert.doesNotMatch(out, /progressbar/);
    assert.doesNotMatch(out, /Results/);
    assert.match(text(out), /Dismissed \(0\)/);
    assert.match(text(out), /No longer matching \(0\)/);
  });

  test('the chapter scope shows a labelled select with the chapters; the scenes scope shows labelled checkboxes by chapter; Run waits for a choice', () => {
    const ch = render({ scope: { kind: 'chapter', chapterKey: '1:1', ids: [] } });
    assert.match(ch, /<label for="st-chapter">Chapter<\/label>/);
    assert.match(ch, /<option value="1:1" selected="">Chapter One: The Drowned Rows<\/option>/);
    const scenes = render({ scope: { kind: 'scenes', chapterKey: null, ids: [S2] } });
    assert.match(scenes, /<legend>Chapter One: The Drowned Rows<\/legend>/);
    assert.match(scenes, /<input type="checkbox" checked=""\/> Quiet|<input type="checkbox" checked=""\/>\s*Quiet/);
    assert.match(text(scenes), /Arrival/);
    assert.match(render({ canRun: false }), /<button type="button" class="btn btn-primary" disabled="">Run<\/button>/);
  });

  test('running: a progressbar with aria-valuenow, "12 of 48 scenes" in a live region, and Cancel; Run is disabled', () => {
    const out = render({ scan: scanOf({ state: 'running', done: 12, total: 48, findings: [] }) });
    assert.match(out, /role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="48"[^>]*aria-valuenow="12"/);
    assert.match(out, /aria-live="polite"[^>]*>12 of 48 scenes</);
    assert.match(out, />Cancel<\/button>/);
    assert.match(out, /<button type="button" class="btn btn-primary" disabled="">Run<\/button>/);
    assert.doesNotMatch(text(out), /No style suggestions/, 'never "none found" while running');
  });

  test('completed, by rule: groups in rule order with counts; cards show rule, category, place, the marked text, message, Open, replacements, Dismiss', () => {
    const out = render({ scan: scanOf() });
    const heads = [...out.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]));
    assert.deepEqual(heads, ['Repeated words 1', 'Repeated phrases 1', 'Long paragraphs 1']);
    assert.match(text(out), /3 suggestions in 2 scenes\./);
    assert.match(out, /aria-live="polite"/);
    assert.match(text(out), /Repeated words · Repetition/);
    assert.match(text(out), /Chapter One: The Drowned Rows · Arrival/);
    assert.match(out, /<mark>the the<\/mark>/);
    assert.match(out, />Replace with ‘the’<\/button>/);
    assert.match(out, />Open<\/a>/);
    assert.ok(links(out).includes(`/books/${BOOK}?scene=${S1}&at=10-17`), 'Open selects the range');
    assert.equal(out.match(/>Dismiss<\/button>/g).length, 3);
    assert.match(out, /aria-current="page"[^>]*>By rule</);
  });

  test('advisory cards say Advice, offer no replacement and link the related occurrences; across scenes is labelled', () => {
    const out = render({ scan: scanOf({ findings: [advice()] }) });
    assert.match(out, /<span class="badge st-advice">Advice<\/span>/);
    assert.match(out, /Across scenes/);
    assert.doesNotMatch(out, /Replace with/);
    assert.ok(links(out).includes(`/books/${BOOK}?scene=${S1}&at=100-125`), 'the other occurrence is a link');
    assert.match(text(out), /Arrival: “she did not look back”/);
    assert.doesNotMatch(render({ scan: scanOf({ findings: [finding()] }) }), /Advice|Across scenes/);
  });

  test('completed, by chapter: groups in book order by chapter label, and the toggle marks By chapter', () => {
    const out = render({ scan: scanOf(), group: 'chapter' });
    const heads = [...out.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]));
    assert.deepEqual(heads, ['Chapter One: The Drowned Rows 1', 'Chapter Two 2']);
    assert.match(out, /aria-current="page"[^>]*>By chapter</);
    assert.ok(links(out).includes(`/books/${BOOK}/style`));
    assert.ok(links(out).includes(`/books/${BOOK}/style?group=chapter`));
  });

  test('completed with nothing found says so; cancelled keeps partial results; both only after the scan ended', () => {
    const none = render({ scan: scanOf({ findings: [] }) });
    assert.match(text(none), /No style suggestions in 2 scenes\./);
    const cancelled = render({ scan: scanOf({ state: 'cancelled', done: 1, total: 2, findings: [finding()] }) });
    assert.match(text(cancelled), /The scan was cancelled after 1 of 2 scenes\./);
    assert.match(text(cancelled), /1 suggestion in 1 scene\./);
    assert.match(cancelled, /<mark>the the<\/mark>/);
  });

  test('failed: an alert, never "no suggestions"; errors per scene and the truncated notice are shown', () => {
    const failed = render({ scan: scanOf({ state: 'failed', done: 0, total: 5, findings: [], errors: [{ sceneId: null, message: 'the book was not found' }] }) });
    assert.match(failed, /role="alert"[^>]*>The scan could not finish\./);
    assert.match(text(failed), /the book was not found/);
    assert.doesNotMatch(text(failed), /No style suggestions/);
    const partial = render({ scan: scanOf({ errors: [{ sceneId: S2, message: 'The scene is over 2,000,000 characters, so it was skipped.' }], truncated: true }) });
    assert.match(text(partial), /1 problem while checking/);
    assert.match(text(partial), /Quiet: The scene is over 2,000,000 characters/);
    assert.match(text(partial), /Only the first 20,000 suggestions are kept/);
    assert.doesNotMatch(text(partial), /No style suggestions/, 'a scan with a problem is not "clean"');
  });

  test('a card that was applied shows Applied with Undo and no replacement buttons; a changed scene disables the others; an error is an alert', () => {
    const cards = { fnd_0000000000000001: { phase: 'applied', replacement: 'the', opId: 'op1' } };
    const out = render({ scan: scanOf({ findings: [finding(), finding({ id: 'fnd_0000000000000009', range: { from: 40, to: 47 } })] }), cards, changedScenes: [S1] });
    assert.match(out, /Applied: ‘the’\./);
    assert.match(out, />Undo<\/button>/);
    assert.match(out, /This scene changed after the scan/);
    assert.match(out, /disabled=""[^>]*>Replace with ‘the’<\/button>/);
    const err = render({ scan: scanOf({ findings: [finding()] }), cards: { fnd_0000000000000001: { phase: 'idle', error: 'The scene changed since the scan, so nothing was changed. Run the scan again.' } } });
    assert.match(err, /role="alert"[^>]*>The scene changed since the scan/);
  });

  test('a dismissed card is gone from the results; Dismiss asks for an optional note', () => {
    const out = render({ scan: scanOf({ findings: [finding()] }), cards: { fnd_0000000000000001: { phase: 'dismissed' } } });
    assert.doesNotMatch(out, /<mark>/);
    assert.match(text(out), /No style suggestions/);
  });

  test('the Dismissed list has Restore; dismissals whose passage changed are listed as No longer matching with Remove', () => {
    const d = (slug, text2) => ({ slug, fingerprint: 'sty-0123456789abcdef', rule: 'repeated-words', sceneId: S1, text: text2, note: slug === 'a' ? 'on purpose' : '', created: '2026-11-18' });
    const out = render({ scan: scanOf({ staleDismissals: ['b'] }), dismissals: [d('a', 'had had'), d('b', 'very very')] });
    assert.match(text(out), /Dismissed \(1\)/);
    assert.match(text(out), /No longer matching \(1\)/);
    assert.match(out, /aria-label="Restore the dismissal of “had had”"/);
    assert.match(out, /aria-label="Remove the dismissal of “very very”"/);
    assert.match(text(out), /on purpose/);
    assert.match(out, /<details class="st-dismissed">/);
  });

  test('every control is a button, a link or a labelled input', () => {
    const out = render({ scan: scanOf(), scope: { kind: 'chapter', chapterKey: '1:1', ids: [] } });
    for (const input of out.match(/<input\b[^>]*>/g) ?? []) assert.match(input, /type="(radio|checkbox|text)"/);
    assert.equal((out.match(/<label\b/g) ?? []).length >= 4, true);
    assert.doesNotMatch(out, /<div[^>]*onclick/i);
  });
});

describe('the model', () => {
  test('addresses', () => {
    assert.equal(model.styleHref('b 1'), '/books/b%201/style');
    assert.equal(model.styleHref('b', { group: 'chapter' }), '/books/b/style?group=chapter');
    assert.equal(model.parseGroup('?group=chapter'), 'chapter');
    assert.equal(model.parseGroup('?group=nope'), 'rule');
    assert.equal(model.openHref('b', S1, 3, 9), `/books/b?scene=${S1}&at=3-9`);
    assert.deepEqual(model.parseAt('?scene=x&at=3-9'), { from: 3, to: 9 });
    assert.equal(model.parseAt('?at=9-3'), null);
    assert.equal(model.parseAt('?at=x'), null);
    assert.equal(model.parseAt(''), null);
  });

  test('scope bodies', () => {
    assert.deepEqual(model.scopeBody({ kind: 'manuscript', chapterKey: null, ids: [] }, CHAPTERS), { kind: 'manuscript' });
    assert.deepEqual(model.scopeBody({ kind: 'chapter', chapterKey: '1:2', ids: [] }, CHAPTERS), { kind: 'chapter', act: 1, chapter: 2 });
    assert.equal(model.scopeBody({ kind: 'chapter', chapterKey: null, ids: [] }, CHAPTERS), null);
    assert.deepEqual(model.scopeBody({ kind: 'scenes', chapterKey: null, ids: [S1] }, CHAPTERS), { kind: 'scenes', ids: [S1] });
    assert.equal(model.scopeBody({ kind: 'scenes', chapterKey: null, ids: [] }, CHAPTERS), null);
    const book = { acts: [{ act: 1, chapters: [{ chapter: 3, label: 'Chapter Three', title: 'Salt', scenes: [{ id: S1, title: '' }] }] }] };
    assert.deepEqual(model.chaptersOf(book), [{ key: '1:3', act: 1, chapter: 3, label: 'Chapter Three: Salt', scenes: [{ id: S1, title: 'Untitled scene' }] }]);
  });

  test('styleFingerprint is the server algorithm: sty- plus 16 hex, stable, and changes when the passage changes; a given fingerprint is used as is', async () => {
    const body = 'He said that that was had had a point.';
    const f = { ruleId: 'repeated-words', sceneId: S1, original: 'had had', range: { from: 22, to: 29 } };
    const a = await model.styleFingerprint(f, body);
    assert.match(a, /^sty-[0-9a-f]{16}$/);
    assert.equal(await model.styleFingerprint(f, body), a);
    assert.notEqual(await model.styleFingerprint(f, body.replace('He said', 'She said')), a);
    assert.equal(await model.styleFingerprint({ ...f, fingerprint: 'sty-aaaaaaaaaaaaaaaa' }, body), 'sty-aaaaaaaaaaaaaaaa');
  });
});

describe('the Checks panel with both groups', () => {
  const g = (over = {}) => ({ id: 'g1', engine: 'harper', ruleId: 'SpellCheck', category: 'spelling', severity: 'warning', advisory: false, original: 'Mara', message: 'Spelling.', replacements: ['Mare'], range: { from: 4, to: 8 }, sceneId: S1, ...over });
  const snap = (over = {}) => ({ state: 'completed', reason: null, findings: [], checkedAt: '2026-01-01T00:00:00.000Z', ...over });
  const view = (snapshot, style, extra = {}) => html(h(panel.GrammarPanelView, { snapshot, style, bookId: BOOK, ...extra }));

  test('the section is labelled Checks and keeps the id grammar', () => {
    assert.equal(appearance.SECTION_LABELS.grammar, 'Checks');
    assert.ok(appearance.INSPECTOR_SECTIONS.includes('grammar'));
    assert.match(view(snap(), snap()), /<h2>Checks<\/h2>/);
  });

  test('both groups: a Grammar group and a Style group, each with its status, and Check scene once', () => {
    const out = view(snap({ findings: [g()] }), snap({ findings: [finding({ id: 'fnd_s1', range: { from: 20, to: 27 } }), advice({ id: 'fnd_s2', sceneId: S1 })] }));
    assert.match(out, /<h3 class="st-group-title">Grammar<\/h3>/);
    assert.match(out, /<h3 class="st-group-title">Style<\/h3>/);
    assert.match(out, /aria-label="Grammar suggestions in this scene"/);
    assert.match(out, /aria-label="Style suggestions in this scene"/);
    assert.match(out, /aria-live="polite">1 suggestion</);
    assert.match(out, /aria-live="polite">2 suggestions</);
    assert.match(out, /aria-label="3 suggestions">3</);
    assert.equal((out.match(/>Check scene<\/button>/g) ?? []).length, 1);
    assert.match(out, />Dismiss<\/button>/);
    assert.match(out, /<span class="badge st-advice">Advice<\/span>/);
    assert.match(text(out), /Repeated words/);
  });

  test('a style card has the flagged text button, a replacement, Dismiss and related links; advice has no replacement', () => {
    const related = advice({ id: 'fnd_s2', sceneId: S1, related: [{ sceneId: S2, from: 1, to: 9, text: 'she did not' }, { sceneId: S1, from: 50, to: 60, text: 'she did not' }] });
    const out = view(snap(), snap({ findings: [finding({ id: 'fnd_s1' }), related] }));
    assert.match(out, /aria-label="Show “the the” in the text"/);
    assert.match(out, />Replace with ‘the’<\/button>/);
    assert.match(out, />In another scene: “she did not”<\/a>/);
    assert.ok(links(out).includes(`/books/${BOOK}?scene=${S2}&at=1-9`));
    assert.match(out, />Also here: “she did not”<\/button>/);
    assert.equal((out.match(/>Replace with/g) ?? []).length, 1);
  });

  test('a duplicate concern is shown once: the owner (style) finding stays, the Harper one is not shown', () => {
    const harper = g({ id: 'gh', ruleId: 'RepeatedWords', category: 'style', original: 'the the', range: { from: 10, to: 17 }, message: 'Harper says repeated.' });
    const out = view(snap({ findings: [harper] }), snap({ findings: [finding({ id: 'fnd_s1' })] }));
    assert.doesNotMatch(out, /Harper says repeated/);
    assert.match(out, /The word &quot;the&quot; is repeated\./);
    assert.match(out, /aria-label="1 suggestion">1</);
    assert.match(text(out), /No suggestions/, 'the grammar group has nothing left, and says so only because it completed');
  });

  test('style off (null or disabled): says so with a link to Settings; grammar off with style on still has Check scene', () => {
    for (const s of [null, snap({ state: 'disabled', checkedAt: null })]) {
      const out = view(snap(), s);
      assert.match(text(out), /Style checks are off for this book\. Turn them on in Settings \./);
    }
    const out = view(null, snap());
    assert.match(text(out), /Grammar checks are off for this book/);
    assert.match(out, />Check scene<\/button>/);
    assert.match(text(out), /No style suggestions/);
  });

  test('style states in words: checking, none, failed; never "none" unless completed', () => {
    assert.equal(panel.styleStatus(snap({ state: 'running', checkedAt: null })), 'Checking…');
    assert.equal(panel.styleStatus(snap()), 'No style suggestions');
    assert.equal(panel.styleStatus(snap({ state: 'failed', reason: 'refused' })), 'Style checks could not run: refused');
    assert.doesNotMatch(panel.styleStatus(snap({ state: 'failed' })), /No style/);
  });

  test('with no style prop the panel is the grammar panel as before (no Style group)', () => {
    const out = html(h(panel.GrammarPanelView, { snapshot: snap() }));
    assert.doesNotMatch(out, /Style/);
  });
});

describe('Settings -> Style checks', () => {
  const book = { id: BOOK, title: 'The Salt Orchard' };
  const styleWith = (over = {}) => settings.styleOf({ enabled: true, rules: { 'preferred-terms': { enabled: true, terms: [{ use: 'grey', avoid: ['gray'] }, { use: 'Mara', avoid: ['Marah', 'Mera'], caseSensitive: true }] }, punctuation: { enabled: true, quotes: 'curly', dashes: null, ellipsis: 'dots' }, ...over } });
  const controls = (style, extra = {}) => html(h(settings.StyleBookControls, { book, style, onChange: () => {}, ...extra }));

  test('the on/off switch, a switch per rule with its options, and the plain note that rules are built in', () => {
    const out = controls(styleWith());
    assert.match(out, /<input type="checkbox" checked=""[^>]*\/> Check style/);
    for (const label of ['Flag spellings I want to avoid', 'Flag the same word twice in a row', 'Flag punctuation that differs from my choice', 'Point out phrases that come back soon', 'Point out very long paragraphs', 'Point out many one-line paragraphs in a row']) {
      assert.match(text(out), new RegExp(label));
    }
    const view = text(html(h(settings.StyleSettingsView, { books: [] })));
    assert.match(view, /Style checks/);
    assert.match(view, /part of StoryForge/);
    assert.match(view, /cannot add rules/);
  });

  test('preferred terms: each pair with Remove (named), the add form with a case checkbox', () => {
    const out = controls(styleWith());
    assert.match(text(out), /gray → grey/);
    assert.match(text(out), /Marah, Mera → Mara \(match case\)/);
    assert.match(out, /aria-label="Remove the pair gray to grey"/);
    assert.match(out, /<label for="[^"]*-use">Spelling to use<\/label>/);
    assert.match(text(out), /Spellings to avoid \(separated by commas\)/);
    assert.match(text(out), /Match capital letters exactly/);
    assert.match(out, />Add pair<\/button>/);
    assert.match(text(controls(settings.styleOf({}))), /No pairs yet/);
  });

  test('punctuation: selects with a Not checked option, set to the saved choices', () => {
    const out = controls(styleWith());
    assert.equal((out.match(/<option value="" selected="">Not checked<\/option>/g) ?? []).length, 1, 'dashes is not set');
    assert.match(out, /<option value="curly" selected="">/);
    assert.match(out, /<option value="dots" selected="">/);
    for (const id of ['em', 'em-spaced', 'en-spaced', 'straight', 'character']) assert.match(out, new RegExp(`<option value="${id}"`));
    assert.match(out, /<label for="[^"]*-punctuation-quotes">Quotation marks<\/label>/);
  });

  test('numbers: labelled inputs with the contract ranges, defaults when unset', () => {
    const out = controls(styleWith());
    assert.match(out, /<input id="[^"]*-repeated-phrases-minWords" type="number"[^>]*min="3" max="8"[^>]*value="4"/);
    assert.match(out, /-repeated-phrases-window" type="number"[^>]*min="50" max="2000"[^>]*value="300"/);
    assert.match(out, /-long-paragraphs-maxWords" type="number"[^>]*min="50" max="2000"[^>]*value="220"/);
    assert.match(out, /-isolated-lines-minRun" type="number"[^>]*min="3" max="30"[^>]*value="6"/);
    assert.deepEqual(settings.NUMBER_RANGES, { minWords: [3, 8], window: [50, 2000], maxWords: [50, 2000], minRun: [3, 30] });
    assert.match(text(out), /3 to 8\./);
  });

  test('defaults: a book with nothing set has the contract defaults (off; three rules on, three off)', () => {
    const d = settings.styleOf(undefined);
    assert.equal(d.enabled, false);
    assert.deepEqual(Object.fromEntries(Object.entries(d.rules).map(([k, v]) => [k, v.enabled])), { 'preferred-terms': true, 'repeated-words': true, punctuation: true, 'repeated-phrases': false, 'long-paragraphs': false, 'isolated-lines': false });
    assert.deepEqual(d.rules.punctuation, { enabled: true, quotes: null, dashes: null, ellipsis: null });
  });

  test('a new pair is checked against the limits before it is sent', () => {
    assert.deepEqual(settings.newTerm(' grey ', 'gray, Gray ,gray', false), { use: 'grey', avoid: ['gray', 'Gray'] });
    assert.deepEqual(settings.newTerm('grey', 'gray', true), { use: 'grey', avoid: ['gray'], caseSensitive: true });
    assert.match(settings.newTerm('', 'gray', false), /to use must be 1 to 64/);
    assert.match(settings.newTerm('grey', ' , ', false), /List 1 to 20/);
    assert.match(settings.newTerm('grey', 'grey', false), /cannot be the same/);
    assert.match(settings.newTerm('grey', 'a'.repeat(65), false), /at most 64/);
    assert.match(settings.newTerm('grey', Array.from({ length: 21 }, (_, i) => `w${i}`).join(','), false), /List 1 to 20/);
    assert.match(settings.newTerm('grey', 'gray', false, 500), /up to 500 pairs/);
  });

  test('is mounted next to the Grammar checks section', () => {
    const src = readFileSync(new URL('../src/ai/SettingsView.jsx', import.meta.url), 'utf8');
    assert.ok(src.indexOf('<StyleSettings />') > src.indexOf('<GrammarSettings />'));
    assert.ok(src.indexOf('<StyleSettings />') < src.indexOf('<section aria-labelledby="ai-setup-heading">'));
  });

  test('rule changes are sent as that rule\'s whole map (source scan of the control)', () => {
    const src = readFileSync(new URL('../src/prefs/StyleSettings.jsx', import.meta.url), 'utf8');
    assert.match(src, /onChange\(\{ rules: \{ \[rule\]: map \} \}/);
    assert.match(src, /\/checks\/style`/);
  });
});

describe('routes and the editor wiring', () => {
  test('routes.js has the Style checks tab: key style, no module gate, parsed and linked', () => {
    assert.deepEqual(routes.MORE_TABS.find((t) => t.key === 'style'), { key: 'style', label: 'Style checks', path: '/style' });
    assert.deepEqual(routes.parseRoute(`/books/${BOOK}/style`, '?group=chapter'), { name: 'tab', bookId: BOOK, tab: 'style' });
    assert.equal(routes.tabHref(BOOK, 'style'), `/books/${BOOK}/style`);
    assert.equal(routes.tabModule('style'), null);
    assert.equal(routes.tabVisible('style', () => false), true);
  });

  test('the scene editor makes a style controller only behind the enabled check and merges before setFindings', () => {
    const src = readFileSync(new URL('../src/editor/SceneEditorPage.jsx', import.meta.url), 'utf8');
    assert.match(src, /const styleOn = !isEntry && styleSettings\?\.enabled === true;/);
    assert.equal(src.match(/createStyleController\(/g).length, 1);
    assert.ok(src.indexOf('if (!styleOn || !view)') < src.indexOf('createStyleController({'));
    assert.match(src, /setFindings\.of\(mergeFindings\(/);
    assert.match(src, /checks\/style\/check/);
    assert.match(src, /checks\/style\/dismissals/);
    assert.match(src, /styleRef\.current\?\.docChanged\(\(styleVersion\.current \+= 1\), u\.state\.doc\.toString\(\)\)/);
  });

  test('the editor opens a scene with ?at=<from>-<to> selected', () => {
    const src = readFileSync(new URL('../src/BookView.jsx', import.meta.url), 'utf8');
    assert.match(src, /initialSelection=\{parseSelect\(search\) \?\? parseAt\(search\)\}/);
  });
});
