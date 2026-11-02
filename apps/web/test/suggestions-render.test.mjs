// M05-J06 acceptance 8: render tests (no browser, no network) for
//   - the editor rail "Suggestions" section (count badge, source badge, Review, Decided with outcomes),
//   - the review view (side by side original | proposed per hunk, word-level marks, Accept / Decline per hunk, Accept all / Decline all, status chips, AI provider and locality),
//   - the "Suggestions" group of the Continuity tab sidebar (all pending, by target; Decided),
//   - the check report panel (findings with evidence and Open links) and the editor toolbar's "Check scene" button.
// Data is the real answer of the core repository (listSuggestions / getSuggestion / checkScene) over a temp copy of valid/salt-orchard holding suggestions written from the
// contract's layout (apps/server/test/suggest-helpers.mjs). Expected text comes from the fixture files and the contract, not from the components.
// Method: renderToStaticMarkup runs no effects, so the rail's own list comes from suggestions-stubs.mjs (a vite plugin points `../api.js` at it for apps/web/src/suggestions/).
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 2, 5 and acceptance 8.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { copyFixture } from '../../server/test/helpers.mjs';
import { ARRIVAL, ARRIVAL_PATH, BOOK, CF1, NEW, suggestionText, withSuggestion } from '../../server/test/suggest-helpers.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const STUBS = path.join(webDir, 'test', 'suggestions-stubs.mjs').replace(/\\/g, '/');
const AI_ID = 'note_01S50000000000000000000J07';
const AI_PATH = 'suggestions/2026/20261101-090000-arrival-ai.md';
const SCENE = { id: ARRIVAL, path: ARRIVAL_PATH, title: 'Arrival' };
const BOOK_PROPS = { id: BOOK, title: 'The Salt Orchard' };

let vite;
const mod = {};
const data = {};
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (markup, re) => (markup.match(re) ?? []).length;
const buttons = (markup) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0], label: text(m[1]) }));

before(async () => {
  const stubPlugin = {
    name: 'suggestions-test-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.replace(/\\/g, '/').includes('/src/suggestions/')) return null;
      return source === '../api.js' ? STUBS : null;
    },
  };
  vite = await createServer({ root: webDir, logLevel: 'silent', plugins: [stubPlugin], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.rail = await vite.ssrLoadModule('/src/suggestions/RailSuggestions.jsx');
  mod.review = await vite.ssrLoadModule('/src/suggestions/SuggestionReview.jsx');
  mod.group = await vite.ssrLoadModule('/src/suggestions/SuggestionsGroup.jsx');
  mod.check = await vite.ssrLoadModule('/src/suggestions/CheckReport.jsx');
  mod.page = await vite.ssrLoadModule('/src/continuity/ContinuityPage.jsx');
  mod.toolbar = await vite.ssrLoadModule('/src/editor/Toolbar.jsx');

  // real repository answers
  const root = await copyFixture('valid/salt-orchard');
  await withSuggestion()(root);
  const pristine = await fs.readFile(path.join(root, ...ARRIVAL_PATH.split('/')), 'utf8');
  // a decided AI suggestion (every hunk declined), written next to the pending one
  const aiText = suggestionText(pristine, { 17: NEW[17] }, { id: AI_ID, extra: { source: 'ai', created: '2026-11-01T09:00:00Z', ai: { provider: 'Test provider', model: 'test-model', locality: 'local', context_sha256: 'a'.repeat(64) } } })
    .replace(/status: pending/g, 'status: declined');
  await fs.writeFile(path.join(root, ...AI_PATH.split('/')), aiText);
  const repo = createFsRepository(root);
  try {
    data.list = clone((await repo.listSuggestions(BOOK, { target: ARRIVAL })).suggestions);
    data.all = clone((await repo.listSuggestions(BOOK)).suggestions);
    const one = (id) => repo.getSuggestion(BOOK, id).then((r) => clone(r.suggestion));
    data.pending = await one('note_01S50000000000000000000J06');
    data.ai = await one(AI_ID);
    const rep = await repo.checkScene(BOOK, ARRIVAL);
    data.report = clone({ scene: rep.scene, at: rep.at, findings: rep.findings, summary: rep.summary });
    const [book] = await repo.continuityBooks();
    data.continuity = clone(await repo.getContinuity(book.id));
  } finally {
    await repo.close?.();
  }
});
after(async () => {
  await vite?.close();
});
afterEach(() => {
  globalThis.__sfApi = undefined;
});

const railList = (list) => {
  globalThis.__sfApi = { [`/api/books/${BOOK}/suggestions?target=${ARRIVAL}`]: { suggestions: list } };
  return html(h(mod.rail.RailSuggestions, { book: BOOK_PROPS, scene: SCENE }));
};

describe('fixture data (guards the tests below against an empty answer)', () => {
  test('the repository answered with one pending Claude-Book suggestion (3 hunks) and one decided AI suggestion for Arrival', () => {
    assert.equal(data.list.length, 2, JSON.stringify(data.list.map((s) => s.id)));
    assert.equal(data.pending.hunks.length, 3);
    assert.equal(data.pending.source, 'claude-book');
    assert.equal(data.ai.source, 'ai');
    assert.ok(data.ai.hunks.every((x) => x.status === 'declined'));
    assert.equal(data.report.findings.some((f) => f.fingerprint === CF1), true);
  });
});

describe('editor rail: Suggestions section', () => {
  test('shows the heading, a pending count badge, the source, how many changes wait, and a Review button', () => {
    const t = text(railList(data.list));
    assert.match(t, /Suggestions/);
    const markup = railList(data.list);
    assert.match(markup, /class="badge"[^>]*>1</, 'count badge shows 1 pending suggestion');
    assert.match(t, /Claude-Book/);
    assert.match(t, /3 of 3 changes waiting/);
    assert.ok(buttons(markup).some((b) => b.label === 'Review'), 'Review button');
  });
  test('decided suggestions stay listed under "Decided" with their outcome and, for AI, the provider and locality', () => {
    const t = text(railList(data.list));
    assert.match(t, /Decided \(1\)/);
    assert.match(t, /1 declined/);
    assert.match(t, /Test provider/);
    assert.match(t, /test-model/);
    assert.match(t, /Local/);
    assert.match(t, /\bAI\b/);
  });
  test('with nothing pending there is no count badge and the section says so', () => {
    const markup = railList(data.list.filter((s) => s.pending === 0));
    assert.doesNotMatch(markup, /class="badge"/);
    assert.match(text(markup), /No pending suggestions/i);
  });
  test('while the list is loading it shows a loading note, not an empty claim', () => {
    globalThis.__sfApi = {};
    const markup = html(h(mod.rail.RailSuggestions, { book: BOOK_PROPS, scene: SCENE }));
    assert.match(text(markup), /Loading/);
    assert.doesNotMatch(text(markup), /No pending suggestions/i);
  });
});

describe('review view', () => {
  const handlers = { onAccept() {}, onDecline() {}, onAcceptAll() {}, onDeclineAll() {} };
  const render = (suggestion, props = {}) => html(h(mod.review.SuggestionReview, { suggestion, handlers, ...props }));

  test('every hunk gets its own Accept and Decline button, plus Accept all and Decline all', () => {
    const markup = render(data.pending);
    const labels = buttons(markup).map((b) => b.label);
    assert.equal(labels.filter((l) => l === 'Accept').length, 3);
    assert.equal(labels.filter((l) => l === 'Decline').length, 3);
    assert.equal(labels.filter((l) => l === 'Accept all').length, 1);
    assert.equal(labels.filter((l) => l === 'Decline all').length, 1);
  });
  test('the per-hunk buttons say which hunk they decide (accessible names)', () => {
    const markup = render(data.pending);
    for (const id of ['h1', 'h2', 'h3']) {
      assert.match(markup, new RegExp(`aria-label="Accept[^"]*\\b${id}\\b`), `Accept ${id}`);
      assert.match(markup, new RegExp(`aria-label="Decline[^"]*\\b${id}\\b`), `Decline ${id}`);
    }
  });
  test('each hunk shows the original and the proposed text side by side, from the real file lines', () => {
    const markup = render(data.pending);
    assert.equal(count(markup, /aria-label="Original"/g), 3);
    assert.equal(count(markup, /aria-label="Proposed"/g), 3);
    const t = text(markup);
    assert.ok(t.includes('The ferry nudged the jetty'), 'original line 15');
    assert.ok(t.includes('The ferry bumped the jetty'), 'proposed line 15');
    assert.ok(t.includes('half under water'));
    assert.ok(t.includes('half drowned'));
    // Original comes before Proposed within each hunk
    const first = markup.indexOf('aria-label="Original"');
    assert.ok(first > -1 && first < markup.indexOf('aria-label="Proposed"'));
  });
  test('the words that changed are marked (not by colour alone): green is struck from the original, grey is added to the proposal', () => {
    const markup = render(data.pending);
    assert.match(markup, /<del[^>]*>[^<]*green[^<]*<\/del>/);
    assert.match(markup, /<ins[^>]*>[^<]*grey[^<]*<\/ins>/);
    assert.doesNotMatch(markup, /<ins[^>]*>[^<]*green/);
  });
  test('hunks show their line numbers and a Pending chip; the suggestion shows its source badge', () => {
    const markup = render(data.pending);
    const t = text(markup);
    for (const n of [15, 17, 19]) assert.ok(new RegExp(`Line ${n}\\b`).test(t), `line ${n}`);
    assert.equal(count(t, /Pending/g) >= 3, true);
    assert.match(t, /Claude-Book/);
    assert.match(t, /Arrival/);
  });
  test('an AI suggestion shows the AI badge with provider, model and locality', () => {
    const t = text(render(data.ai));
    assert.match(t, /\bAI\b/);
    assert.match(t, /Test provider/);
    assert.match(t, /test-model/);
    assert.match(t, /Local/);
  });
  test('a partly decided suggestion: the accepted hunk has a status chip and no buttons, the others keep theirs', () => {
    const s = clone(data.pending);
    s.hunks[1].status = 'accepted';
    s.hunks[1].decided = '2026-11-02T14:05:00Z';
    s.status = 'partial';
    s.pending = 2;
    const markup = render(s);
    const labels = buttons(markup).map((b) => b.label);
    assert.equal(labels.filter((l) => l === 'Accept').length, 2);
    assert.equal(labels.filter((l) => l === 'Decline').length, 2);
    assert.doesNotMatch(markup, /aria-label="Accept[^"]*\bh2\b/);
    assert.match(markup, /aria-label="Accept[^"]*\bh1\b/);
    assert.match(text(markup), /Accepted/);
  });
  test('a decided suggestion has no Accept / Decline buttons at all and states each hunk outcome', () => {
    const markup = render(data.ai);
    assert.deepEqual(buttons(markup), []);
    assert.match(text(markup), /Declined/);
  });
  test('a stale hunk cannot be accepted from the UI (button disabled) but can still be declined', () => {
    const s = clone(data.pending);
    s.hunks[0].stale = true;
    const markup = render(s);
    const accept = buttons(markup).find((b) => /aria-label="Accept[^"]*\bh1\b/.test(b.tag));
    assert.ok(accept && /disabled/.test(accept.tag), 'Accept h1 disabled');
    const decline = buttons(markup).find((b) => /aria-label="Decline[^"]*\bh1\b/.test(b.tag));
    assert.ok(decline && !/disabled/.test(decline.tag), 'Decline h1 enabled');
  });
  test('a failure message is shown as an alert', () => {
    assert.match(render(data.pending, { error: 'The lines this change was made for have changed.' }), /role="alert"[^>]*>[^<]*have changed/);
  });
  test('a new-file suggestion (no original) is shown as a new file', () => {
    const s = clone(data.pending);
    s.new_file = true;
    s.target = '';
    s.target_title = undefined;
    s.target_path = 'planning/timeline/chapter-01-state.md';
    s.hunks = [{ id: 'h1', line: 1, lines: 0, status: 'pending', originalLines: [], newLines: ['---', 'schema: storyforge.event/v1', '---'], stale: false }];
    const t = text(render(s));
    assert.match(t, /New file/i);
    assert.match(t, /schema: storyforge\.event\/v1/);
  });
});

describe('Continuity tab: Suggestions group', () => {
  const page = (props) => html(h(mod.page.ContinuityPage, { bookId: BOOK, result: data.continuity, ...props }));

  test('lists the pending suggestions by target with a count badge and the number of changes waiting, with Decided below', () => {
    const markup = page({ suggestions: data.all });
    const t = text(markup);
    assert.match(markup, /aria-label="Suggestions"/);
    assert.match(t, /Suggestions\s+1/, 'count badge');
    assert.match(t, /Arrival/, 'grouped under the target title');
    assert.match(t, /Claude-Book/);
    assert.match(t, /Decided \(1\)/);
    assert.match(t, /1 declined/);
  });
  test('the findings are still there next to the group (CF1 reaches the queue)', () => {
    const t = text(page({ suggestions: data.all }));
    assert.match(t, /Eyes Grey in the codex, green in the text/);
  });
  test('without suggestions data the group is not drawn', () => {
    assert.doesNotMatch(page({}), /aria-label="Suggestions"/);
  });
  test('selecting a suggestion reviews it in the right-hand panel instead of a finding', () => {
    const markup = page({ suggestions: data.all, selectedSuggestion: data.pending, selectedSuggestionId: data.pending.id, suggestionHandlers: { onAccept() {}, onDecline() {}, onAcceptAll() {}, onDeclineAll() {} } });
    assert.match(markup, /aria-label="Suggestion"/);
    assert.equal(count(markup, /aria-label="Original"/g), 3);
    assert.ok(buttons(markup).some((b) => b.label === 'Accept all'));
  });
  test('an empty list says there is nothing pending', () => {
    assert.match(text(page({ suggestions: [] })), /No pending suggestions/i);
  });
});

describe('check report panel and the Check scene button', () => {
  const panel = (report) => html(h(mod.check.CheckReport, { bookId: BOOK, report }));

  test('the report lists the CF1 finding with severity, code, message, the evidence line, file:line and an Open link', () => {
    const markup = panel(data.report);
    const t = text(markup);
    assert.match(t, /CF1/);
    assert.match(t, /Warning/i);
    assert.ok(t.includes('The codex says Maren Hollis'), 'message');
    assert.ok(t.includes('green eyes ringed with salt'), 'evidence');
    assert.ok(t.includes(`${ARRIVAL_PATH}:17`), 'file:line');
    assert.ok(buttons(markup).length === 0, 'the panel has no buttons that edit text');
    const open = [...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>\s*Open\s*<\/a>/g)];
    assert.equal(open.length, 1, 'one Open link per finding');
    assert.ok(open[0][1].includes(BOOK), `Open link points into the book: ${open[0][1]}`);
    assert.doesNotMatch(t, /undefined|NaN/);
  });
  test('the summary counts match the report', () => {
    const t = text(panel(data.report));
    assert.match(t, /1 finding/);
    assert.match(t, /0 errors/);
    assert.match(t, /1 warning\b/);
  });
  test('a clean report says so and shows no finding cards', () => {
    const clean = { scene: SCENE, at: data.report.at, findings: [], summary: { total: 0, errors: 0, warnings: 0, infos: 0, diagnostics: 0, continuity: 0 } };
    const markup = panel(clean);
    assert.match(text(markup), /No problems/i);
    assert.doesNotMatch(markup, /class="cf-card/);
  });
  test('the report says it was a local check that changed nothing', () => {
    assert.match(text(panel(data.report)), /Nothing was written/i);
  });
  test('the dialog shows Checking while the report is pending and the failure text on error', () => {
    const wait = html(h(mod.check.CheckDialog, { bookId: BOOK, sceneTitle: 'Arrival', report: null, onClose() {} }));
    assert.match(text(wait), /Checking/);
    const failed = html(h(mod.check.CheckDialog, { bookId: BOOK, sceneTitle: 'Arrival', report: null, error: 'The check could not run.', onClose() {} }));
    assert.match(failed, /role="alert"[^>]*>[^<]*could not run/);
    const done = html(h(mod.check.CheckDialog, { bookId: BOOK, sceneTitle: 'Arrival', report: data.report, onClose() {} }));
    assert.match(text(done), /Check scene: Arrival/);
    assert.match(text(done), /CF1/);
  });
  test('the editor toolbar shows "Check scene" only when a handler is supplied', () => {
    const base = { onBold() {}, onItalic() {}, onLink() {}, onNote() {}, onSceneBreak() {}, showMarks: false, onToggleMarks() {} };
    const withCheck = html(h(mod.toolbar.EditorToolbar, { ...base, onCheck() {} }));
    assert.ok(buttons(withCheck).some((b) => b.label === 'Check scene'));
    const without = html(h(mod.toolbar.EditorToolbar, base));
    assert.ok(!buttons(without).some((b) => b.label === 'Check scene'));
  });
});
