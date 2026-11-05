// M05-J02 acceptance 1 and 5 (web side): render tests (no browser, no network) for the editor rail "Continuity" section, the review queue (filters, list,
// detail with both sources, Acknowledge dialog, Acknowledged list, stale exceptions, keyboard navigation), plus the pure projections they use.
//
// Data is the real answer of the core repository (getContinuity) over temp copies of valid/salt-orchard, valid/continuity-cases and valid/continuity-exception.
// Expected text is read from the fixture FILES, not from the product's code. Component props follow the JSDoc of apps/web/src/continuity/*.
// Contract: docs/contracts/M05-J02-continuity-review.md sections 2, 3, 4 and acceptance 1 and 5.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { RULES } from '../../../packages/continuity/src/index.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.resolve(webDir, '../../packages/format/fixtures/valid');
const SO = 'book_01S5000000000000000000000A';
const PROLOGUE = 'scene_01S50000000000000000000001';
const ARRIVAL = 'scene_01S50000000000000000000002';
const FP = 'cf1-e85d78f4354c4ffc';
const MAREN = 'codex/characters/maren-hollis.md';
const ARRIVAL_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';

let vite;
const mod = {};
const sets = {};

async function load(fixture) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cfr-'));
  const root = path.join(base, fixture);
  await fs.cp(path.join(FIXTURES, fixture), root, { recursive: true });
  const repo = createFsRepository(root);
  try {
    const [book] = await repo.continuityBooks();
    return { root, bookId: book.id, result: JSON.parse(JSON.stringify(await repo.getContinuity(book.id))) };
  } finally {
    await repo.close?.();
  }
}

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.model = await vite.ssrLoadModule('/src/continuity/model.js');
  mod.page = await vite.ssrLoadModule('/src/continuity/ContinuityPage.jsx');
  mod.both = await vite.ssrLoadModule('/src/continuity/ShowBoth.jsx');
  mod.rail = await vite.ssrLoadModule('/src/continuity/RailContinuity.jsx');
  mod.actions = await vite.ssrLoadModule('/src/continuity/useContinuityActions.jsx');
  mod.req = await vite.ssrLoadModule('/src/continuity/requests.js');
  mod.shell = await vite.ssrLoadModule('/src/shell/Inspector.jsx');
  mod.routes = await vite.ssrLoadModule('/src/routes.js');
  sets.so = await load('salt-orchard');
  sets.cases = await load('continuity-cases');
  sets.exc = await load('continuity-exception');
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const anchors = (html) => [...decode(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: /href="([^"]*)"/.exec(m[1])?.[1] ?? null, text: textOf(m[2]) }));
const buttons = (html) => [...decode(html).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], text: textOf(m[2]) }));
const noop = () => {};
const BOOK = { id: SO, slug: 'salt-orchard', title: 'The Salt Orchard', path: '' };
const scene = (id, extra = {}) => ({ id, title: 'Arrival', path: ARRIVAL_REL, front_matter: {}, body: 'Text.\n', sha256: 'abc', ...extra });
const soFinding = () => sets.so.result.findings[0];

const finding = (over = {}) => ({
  fingerprint: 'cf1-0000000000000001', rule: 'CF1', rule_version: 1, severity: 'warning', title: 'A finding', message: 'one thing conflicts with another',
  subject: { kind: 'entry', id: 'entry_X', slug: 'x', name: 'X' },
  sources: [{ role: 'canon', kind: 'entry', id: 'entry_X', file: 'codex/x.md', heading: 'X', location: 'fields.Eyes', line: 5, range: null, excerpt: 'Eyes: Grey' },
    { role: 'text', kind: 'scene', id: 'scene_A', file: 'manuscript/a.md', heading: 'A', location: 'line 9', line: 9, range: { from: 1, to: 4 }, excerpt: 'green' }],
  ...over,
});
const renderPage = (set, props = {}) => renderToStaticMarkup(h(mod.page.ContinuityPage, { bookId: set.bookId, result: set.result, ...props }));
const rowsOf = (html) => [...html.matchAll(/<button[^>]*class="[^"]*cf-row[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1]));
const sidebarCount = (html, label) => {
  const aside = /<aside[^>]*aria-label="Continuity filters"[\s\S]*?<\/aside>/.exec(html)[0];
  const row = buttons(aside).find((b) => b.text.startsWith(label));
  return row ? Number(/(\d+)$/.exec(row.text)?.[1]) : null;
};

// ================================================================================================ rail

describe('acceptance 5: the editor rail "Continuity" section', () => {
  const rail = (id, continuity, extra = {}) => renderToStaticMarkup(h(mod.rail.RailContinuity, { book: BOOK, scene: scene(id), continuity, ...extra }));

  test('Arrival: the CF1 card with severity, title, message, both sources as file/line links, Show both and Acknowledge…, count in the title', () => {
    const html = rail(ARRIVAL, sets.so.result);
    const f = soFinding();
    assert.equal(f.fingerprint, FP);
    const t = textOf(html);
    assert.match(html, /<h2[^>]*>[\s\S]*Continuity[\s\S]*1[\s\S]*<\/h2>/, 'count badge in the section title');
    assert.ok(t.includes(f.title), 'title');
    assert.ok(t.includes(f.message), 'one-line message');
    assert.match(html, /data-severity="warning"/, 'severity dot');
    const links = anchors(html).map((a) => a.text);
    assert.ok(links.some((x) => x.includes(MAREN) && x.includes('line 13')), `codex source link: ${links}`);
    assert.ok(links.some((x) => x.includes(ARRIVAL_REL) && x.includes('line 17')), `scene source link: ${links}`);
    const labels = buttons(html).map((b) => b.text);
    assert.ok(labels.includes('Show both'));
    assert.ok(labels.includes('Acknowledge…'));
  });

  test('a scene with no findings: "No continuity findings for this scene." and a "Review all (N)" link to the queue', () => {
    const html = rail(PROLOGUE, sets.so.result);
    assert.ok(textOf(html).includes('No continuity findings for this scene.'));
    assert.ok(!buttons(html).some((b) => b.text === 'Acknowledge…'));
    const review = anchors(html).find((a) => a.text === 'Review all (1)');
    assert.ok(review, `link: ${JSON.stringify(anchors(html))}`);
    assert.equal(review.href, `/books/${SO}/continuity`);
  });

  test('a book with no findings at all: empty state and Review all (0); still loading: Loading…', () => {
    const empty = rail(ARRIVAL, { ...sets.so.result, findings: [] });
    assert.ok(textOf(empty).includes('No continuity findings for this scene.'));
    assert.ok(textOf(empty).includes('Review all (0)'));
    assert.ok(textOf(rail(ARRIVAL, null)).includes('Loading'));
  });

  test('only findings with a source in the open scene (by scene ID), errors first, count equals the cards', () => {
    const err = finding({ fingerprint: 'th1-0000000000000002', rule: 'TH1', severity: 'error', title: 'Error first' });
    const warn = finding({ fingerprint: 'cf1-0000000000000003', title: 'Warning second' });
    const other = finding({ fingerprint: 'cf1-0000000000000004', title: 'Elsewhere', sources: [{ ...finding().sources[1], id: 'scene_B' }] });
    const html = rail('scene_A', { findings: [err, warn, other], suppressed: [], stale_exceptions: [] });
    const t = textOf(html);
    assert.ok(t.indexOf('Error first') > -1 && t.indexOf('Error first') < t.indexOf('Warning second'));
    assert.ok(!t.includes('Elsewhere'));
    assert.equal((html.match(/class="cf-card"/g) ?? []).length, 2);
    assert.match(html, /aria-label="2 findings"|>2</);
    assert.ok(t.includes('Review all (3)'), 'Review all counts the whole book');
  });

  test('non-blocking: the rail never renders a modal dialog for a finding', () => {
    const html = rail(ARRIVAL, sets.so.result);
    assert.ok(!/role="dialog"|aria-modal|role="alertdialog"/.test(html));
  });

  test('the composed rail shows the Continuity section from the `continuity` data and no longer the M05 placeholder', () => {
    const base = { book: BOOK, scene: scene(ARRIVAL), diagnostics: { items: [], error: null, loading: false }, objects: [] };
    const html = renderToStaticMarkup(h(mod.shell.SceneInspector, { ...base, continuity: sets.so.result }));
    assert.ok(textOf(html).includes(soFinding().title));
    assert.ok(!html.includes('Continuity checks arrive in M05'));
    const loading = renderToStaticMarkup(h(mod.shell.SceneInspector, { ...base, continuity: null }));
    assert.ok(!loading.includes('Continuity checks arrive in M05'));
  });
});

// ================================================================================================ show both

describe('acceptance 1/5: Show both', () => {
  const linesOf = async (root, rel, line, radius = 3) => {
    const all = (await fs.readFile(path.join(root, ...rel.split('/')), 'utf8')).split(/\r?\n/);
    const out = [];
    for (let n = Math.max(1, line - radius); n <= Math.min(all.length, line + radius); n++) out.push({ n, text: all[n - 1] });
    return out;
  };

  test('two panels: heading, file path, line number, +-3 lines with the evidence range highlighted (`Eyes: Grey` in the codex, "green eyes" in the scene)', async () => {
    const f = soFinding();
    const [canon, text] = f.sources;
    const panel = async (source) => renderToStaticMarkup(h(mod.both.SourcePanel, { bookId: SO, source, context: { lines: await linesOf(sets.so.root, source.file, source.line) } }));
    const c = await panel(canon);
    const s = await panel(text);
    for (const [html, src] of [[c, canon], [s, text]]) {
      const t = textOf(html);
      assert.ok(t.includes(src.heading) && t.includes(src.file) && t.includes(`line ${src.line}`), `heading, file and line of ${src.file}`);
      assert.equal((html.match(/class="cf-line[ "]/g) ?? []).length, 7, 'evidence line +-3');
    }
    assert.ok(textOf(c).includes('Eyes: Grey'));
    assert.match(s, /<mark[^>]*>green eyes<\/mark>/, 'the evidence range of the scene is highlighted');
    assert.match(c, /aria-current="true"[\s\S]{0,200}13/, 'the codex evidence line is marked');
  });

  test('context lines near the start of a file (fewer than 3 lines before) are drawn as given', () => {
    const html = renderToStaticMarkup(h(mod.both.SourcePanel, { bookId: SO, source: soFinding().sources[0], context: { lines: [{ n: 1, text: '---' }, { n: 2, text: 'schema: x' }] } }));
    assert.equal((html.match(/class="cf-line[ "]/g) ?? []).length, 2);
  });

  test('loading and unreadable states do not crash and still show where the source is', () => {
    const src = soFinding().sources[1];
    for (const context of [null, false]) {
      const html = renderToStaticMarkup(h(mod.both.SourcePanel, { bookId: SO, source: src, context }));
      assert.ok(textOf(html).includes(src.file));
      assert.ok(!html.includes('<mark'));
    }
  });

  test('ShowBoth draws one panel per source, in order', () => {
    const html = renderToStaticMarkup(h(mod.both.ShowBoth, { bookId: SO, finding: soFinding() }));
    assert.equal((html.match(/class="cf-panel"/g) ?? []).length, 2);
    const t = textOf(html);
    assert.ok(t.indexOf(MAREN) < t.indexOf(ARRIVAL_REL), 'canon first');
  });

  test('splitEvidence: before / mark / after around the range; a range off the line is clipped; no range marks nothing', () => {
    const m = mod.model;
    assert.deepEqual(m.splitEvidence('her green eyes ringed', { from: 4, to: 14 }), { before: 'her ', mark: 'green eyes', after: ' ringed' });
    assert.deepEqual(m.splitEvidence('abc', { from: 2, to: 99 }), { before: 'ab', mark: 'c', after: '' });
    assert.deepEqual(m.splitEvidence('abc', null), { before: 'abc', mark: '', after: '' });
    assert.equal(m.splitEvidence('abc', { from: 50, to: 60 }).mark, '');
  });
});

// ================================================================================================ queue

describe('acceptance 5: the review queue', () => {
  test('All: one row per engine finding, in the engine order, nothing filtered away (cases fixture: 12 findings, 5 rules)', () => {
    const set = sets.cases;
    const html = renderPage(set);
    const rows = rowsOf(html);
    assert.equal(rows.length, set.result.findings.length);
    assert.equal(rows.length, 12);
    set.result.findings.forEach((f, i) => assert.ok(rows[i].includes(f.title), `row ${i} is "${f.title}": ${rows[i]}`));
    assert.equal(sidebarCount(html, 'All'), 12);
  });

  test('each row shows severity, the rule name, the title, the subject and the first source', () => {
    const f = sets.cases.result.findings.find((x) => x.rule === 'CF1' && x.sources.some((s) => s.kind === 'research'));
    const row = rowsOf(renderPage(sets.cases)).find((r) => r.includes(f.title));
    assert.ok(/warning/i.test(row), `severity: ${row}`);
    assert.ok(row.includes('Fact conflict'), 'plain rule name');
    assert.ok(row.includes(f.subject.name), 'subject');
    assert.ok(row.includes(f.sources[0].file), 'first source');
  });

  test('Errors / Warnings / Info filters show exactly the findings of that severity, and the sidebar counts match', () => {
    const all = sets.cases.result.findings;
    for (const [status, label] of [['error', 'Errors'], ['warning', 'Warnings'], ['info', 'Info']]) {
      const want = all.filter((f) => f.severity === status);
      const html = renderPage(sets.cases, { filter: { status, rule: null, subject: null } });
      assert.deepEqual(rowsOf(html).map((r) => want.find((f) => r.includes(f.title))?.title), want.map((f) => f.title), status);
      assert.equal(sidebarCount(html, label), want.length, `${label} count`);
    }
  });

  test('rule filter: CF1 shows only fact conflicts, TH1 only thread findings; the sidebar lists every rule with its plain name', () => {
    const all = sets.cases.result.findings;
    const cf1 = renderPage(sets.cases, { filter: { status: 'all', rule: 'CF1', subject: null } });
    assert.equal(rowsOf(cf1).length, all.filter((f) => f.rule === 'CF1').length);
    assert.ok(rowsOf(cf1).every((r) => r.includes('Fact conflict')));
    const th1 = renderPage(sets.cases, { filter: { status: 'all', rule: 'TH1', subject: null } });
    assert.equal(rowsOf(th1).length, all.filter((f) => f.rule === 'TH1').length);
    const aside = textOf(/<aside[^>]*aria-label="Continuity filters"[\s\S]*?<\/aside>/.exec(cf1)[0]);
    for (const r of RULES) assert.ok(aside.includes(r.id), `${r.id} in the sidebar`);
    assert.ok(aside.includes('Fact conflict') && aside.includes('Timeline impossibility') && aside.includes('Character knowledge'));
  });

  test('rule and status filters combine; a combination with no findings shows the empty state', () => {
    const html = renderPage(sets.cases, { filter: { status: 'error', rule: 'CF1', subject: null } });
    assert.equal(rowsOf(html).length, 0);
    assert.ok(textOf(html).includes('No findings'));
  });

  test('subject filter (character / entry): only that subject; the choices list each subject that has findings', () => {
    const all = sets.cases.result.findings;
    const cleo = all.filter((f) => f.subject.slug === 'cleo-marsh');
    assert.ok(cleo.length >= 2);
    const key = `${cleo[0].subject.kind}:${cleo[0].subject.id}`;
    const html = renderPage(sets.cases, { filter: { status: 'all', rule: null, subject: key } });
    assert.equal(rowsOf(html).length, cleo.length);
    assert.ok(rowsOf(html).every((r) => r.includes('Cleo Marsh')));
    const select = /<select[^>]*>[\s\S]*?<\/select>/.exec(html)[0];
    for (const f of all) assert.ok(decode(select).includes(f.subject.name ?? f.subject.slug), `option for ${f.subject.slug}`);
  });

  test('empty book: "No findings" empty state, nothing selectable', () => {
    const html = renderPage(sets.exc);
    assert.equal(rowsOf(html).length, 0);
    assert.ok(textOf(html).includes('No findings'));
  });

  test('the page says findings are advice', () => {
    assert.match(textOf(renderPage(sets.so)), /advice/i);
  });

  test('findings are a board of cards; the selected one opens in a dialog with a close button, and nothing selected means no dialog', () => {
    const f = sets.cases.result.findings[0];
    const closed = renderPage(sets.cases);
    assert.match(closed, /<ul[^>]*class="nt-board cf-list"/);
    assert.ok(!/role="dialog"/.test(closed));
    const open = renderPage(sets.cases, { selectedFp: f.fingerprint });
    assert.match(open, /role="dialog"[^>]*aria-modal="true"/);
    assert.match(open, /<button[^>]*aria-label="Close finding"/);
    assert.ok(textOf(/role="dialog"[\s\S]*$/.exec(open)[0]).includes(f.title));
  });
});

describe('acceptance 5: detail with both sources', () => {
  const detail = (f, handlers = {}) => renderToStaticMarkup(h(mod.page.FindingDetail, { bookId: sets.so.bookId, finding: f, handlers }));

  test('Arrival CF1: message, rule description, fingerprint, both sources with file and line and an Open link each, Show both and Acknowledge…', () => {
    const f = soFinding();
    const html = detail(f, { onAcknowledge: noop });
    const t = textOf(html);
    assert.ok(t.includes(f.title) && t.includes(f.message));
    assert.ok(t.includes(RULES.find((r) => r.id === 'CF1').description.split('. ')[0]), 'rule description from RULES');
    assert.ok(t.includes(FP), 'fingerprint');
    assert.ok(buttons(html).some((b) => /copy/i.test(b.text)), 'copyable');
    assert.ok(t.includes(`${MAREN}`) && t.includes('line 13'));
    assert.ok(t.includes(`${ARRIVAL_REL}`) && t.includes('line 17'));
    assert.equal(anchors(html).filter((a) => a.text === 'Open').length, 2, 'Open on each source');
    const labels = buttons(html).map((b) => b.text);
    assert.ok(labels.includes('Show both') && labels.includes('Acknowledge…'));
    assert.ok(!labels.includes('Restore finding'));
  });

  test('Open goes to the right place per source kind: entry -> Codex entry, event -> Timeline ?event=, thread -> Threads, research -> Notes, scene -> the scene', () => {
    const seen = new Set();
    for (const f of sets.cases.result.findings) {
      for (const s of f.sources) {
        const href = mod.model.sourceHref(sets.cases.bookId, s);
        const b = encodeURIComponent(sets.cases.bookId);
        if (s.kind === 'entry') assert.ok(href.startsWith(`/books/${b}/codex`) && href.includes(`entry=${s.id}`), href);
        if (s.kind === 'event') assert.ok(href.startsWith(`/books/${b}/timeline`) && href.includes(`event=${s.id}`), href);
        if (s.kind === 'thread') assert.ok(href.startsWith(`/books/${b}`) && href.includes('threads') && href.includes(s.id), href);
        if (s.kind === 'research') assert.ok(href.startsWith(`/books/${b}/notes`) && href.includes(`note=${s.id}`), href);
        if (s.kind === 'scene') assert.ok(href.startsWith(`/books/${b}`) && href.includes(s.id), href);
        seen.add(s.kind);
      }
    }
    assert.deepEqual([...seen].sort(), ['entry', 'event', 'research', 'scene', 'thread']);
    assert.match(mod.model.sourceHref(SO, { kind: 'scene', id: ARRIVAL }, 12), /line=12/, 'a scene opens at ?line=N');
  });

  test('the rendered Open links of an event finding point into the Timeline', () => {
    const f = sets.cases.result.findings.find((x) => x.rule === 'KN1');
    const html = renderToStaticMarkup(h(mod.page.FindingDetail, { bookId: sets.cases.bookId, finding: f }));
    const opens = anchors(html).filter((a) => a.text === 'Open');
    assert.equal(opens.length, f.sources.length);
    assert.ok(opens.every((a) => a.href.includes('/timeline') && a.href.includes('event=')));
  });

  test('nothing selected: a prompt, no actions', () => {
    const html = detail(null);
    assert.ok(textOf(html).length > 0);
    assert.ok(!buttons(html).some((b) => b.text === 'Acknowledge…'));
  });
});

describe('acceptance 5: Acknowledge dialog', () => {
  const dialog = (props = {}) => renderToStaticMarkup(h(mod.actions.AcknowledgeDialog, { finding: soFinding(), onSubmit: noop, onClose: noop, ...props }));

  test('a modal dialog: required multi-line rationale, title prefilled with the finding title, the "creates planning/continuity/<slug>.md" notice, Save and Cancel', () => {
    const html = dialog();
    assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
    const ta = /<textarea\b([^>]*)>/.exec(html);
    assert.ok(ta, 'a textarea for the rationale');
    assert.ok(/required|aria-required="true"/.test(ta[1]), 'rationale is required');
    assert.ok(decode(html).includes(`value="${soFinding().title}"`), 'title prefilled');
    const t = textOf(html);
    assert.match(t, /This creates planning\/continuity\/[a-z0-9-]+\.md/);
    assert.ok(t.includes('a Markdown file you can edit or delete'));
    assert.ok(t.includes('It hides only this finding; if the facts change, a new finding appears.'));
    const labels = buttons(html).map((b) => b.text);
    assert.ok(labels.includes('Save') && labels.includes('Cancel'));
  });

  test('before anything is typed there is no error; a refusal from the server is shown as an alert in words', () => {
    assert.ok(!/role="alert"/.test(dialog()));
    assert.ok(!/aria-invalid="true"/.test(dialog()));
    const withError = dialog({ error: mod.req.explainContinuityFailure(400, { code: 'RATIONALE_REQUIRED' }) });
    assert.match(withError, /role="alert"/);
    assert.ok(textOf(withError).length > textOf(dialog()).length);
  });

  test('each refusal code has its own plain message; the request carries the fingerprint and rationale and only sends a title when given', () => {
    const explain = mod.req.explainContinuityFailure;
    const msgs = ['RATIONALE_REQUIRED', 'ALREADY_EXCEPTED', 'FINDING_NOT_FOUND'].map((code) => explain(code === 'FINDING_NOT_FOUND' ? 404 : code === 'ALREADY_EXCEPTED' ? 409 : 400, { code }));
    assert.equal(new Set(msgs).size, 3);
    for (const m of msgs) assert.ok(m.length > 10);
    const r = mod.req.acknowledgeRequest(SO, { fingerprint: FP, rationale: 'because', title: 'My title' });
    assert.equal(r.method, 'POST');
    assert.equal(r.url, `/api/books/${SO}/continuity/exceptions`);
    assert.deepEqual(r.body, { fingerprint: FP, rationale: 'because', title: 'My title' });
    assert.ok(!('title' in mod.req.acknowledgeRequest(SO, { fingerprint: FP, rationale: 'because' }).body));
    const d = mod.req.archiveExceptionRequest(SO, 'maren-eyes');
    assert.equal(d.method, 'DELETE');
    assert.equal(d.url, `/api/books/${SO}/continuity/exceptions/maren-eyes`);
  });
});

describe('acceptance 5: Acknowledged list and stale exceptions', () => {
  const ackFilter = { status: 'acknowledged', rule: null, subject: null };

  test('Acknowledged lists the suppressed finding (not the live list); its detail shows the rationale heading, the exception file link and Restore finding, no Acknowledge…', () => {
    const set = sets.exc;
    assert.equal(set.result.suppressed.length, 1);
    const f = set.result.suppressed[0].finding;
    const html = renderPage(set, { filter: ackFilter, selectedFp: f.fingerprint, handlers: { onRestore: noop, onRemove: noop } });
    const rows = rowsOf(html);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].includes(f.title));
    const t = textOf(html);
    assert.ok(t.includes('planning/continuity/maren-eyes.md'), 'file link');
    assert.ok(anchors(html).some((a) => a.text === 'planning/continuity/maren-eyes.md'));
    const labels = buttons(html).map((b) => b.text);
    assert.ok(labels.includes('Restore finding'));
    assert.ok(!labels.includes('Acknowledge…'));
    const live = renderPage(set, { filter: { status: 'all', rule: null, subject: null } });
    assert.equal(rowsOf(live).length, 0, 'an acknowledged finding is not in All');
  });

  test('the exception rationale is shown (ExceptionNote reads the exception text; here from the file the Markdown holds)', async () => {
    const raw = await fs.readFile(path.join(sets.exc.root, 'planning', 'continuity', 'maren-eyes.md'), 'utf8');
    const rationale = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    assert.ok(rationale.length > 0);
    assert.equal(mod.model.rationaleOf(raw), rationale);
  });

  test('stale exceptions: listed under Acknowledged with "No longer matches a finding", their file and a Remove button; not listed under All', () => {
    const set = sets.exc;
    assert.deepEqual(set.result.stale_exceptions.map((x) => x.slug), ['old-note']);
    const html = renderPage(set, { filter: ackFilter, handlers: { onRemove: noop } });
    const t = textOf(html);
    assert.ok(t.includes('No longer matches a finding'));
    assert.ok(t.includes('old-note') && t.includes('planning/continuity/old-note.md'));
    assert.ok(buttons(html).some((b) => b.text === 'Remove'));
    const all = renderPage(set, { filter: { status: 'all', rule: null, subject: null }, handlers: { onRemove: noop } });
    assert.ok(!textOf(all).includes('No longer matches a finding'));
    assert.ok(!buttons(all).some((b) => b.text === 'Remove'));
  });

  test('nothing acknowledged: a plain empty state under Acknowledged', () => {
    const html = renderPage(sets.so, { filter: ackFilter });
    assert.equal(rowsOf(html).length, 0);
    assert.ok(/Nothing acknowledged/i.test(textOf(html)));
  });
});

// ================================================================================================ keyboard

describe('acceptance 5: keyboard navigation of the list', () => {
  test('nextRowIndex: ArrowDown / ArrowUp move by one and stop at the ends; Home / End jump; other keys do nothing; an empty list does nothing', () => {
    const n = mod.model.nextRowIndex;
    assert.equal(n(0, 'ArrowDown', 3), 1);
    assert.equal(n(2, 'ArrowDown', 3), 2);
    assert.equal(n(1, 'ArrowUp', 3), 0);
    assert.equal(n(0, 'ArrowUp', 3), 0);
    assert.equal(n(1, 'Home', 3), 0);
    assert.equal(n(0, 'End', 3), 2);
    assert.equal(n(1, 'a', 3), null);
    assert.equal(n(0, 'Enter', 3), null, 'Enter is the button\'s own activation');
    assert.equal(n(0, 'ArrowDown', 0), null);
  });

  test('the list is made of real buttons (Enter opens), exactly one row is in the tab order, and the selected row is marked current', () => {
    const rows = sets.cases.result.findings;
    const html = renderToStaticMarkup(h(mod.page.FindingList, { rows, selectedFp: rows[2].fingerprint, onSelect: noop }));
    const rowButtons = buttons(html);
    assert.equal(rowButtons.length, rows.length);
    assert.equal(rowButtons.filter((b) => /tabindex="0"/.test(b.attrs)).length, 1, 'roving tabindex: one stop');
    assert.ok(/tabindex="0"/.test(rowButtons[2].attrs) && /aria-current="true"/.test(rowButtons[2].attrs));
    assert.ok(rowButtons.every((b, i) => i === 2 || /tabindex="-1"/.test(b.attrs)));
    assert.match(html, /<ul[^>]*aria-label="Findings"/);
  });

  test('with nothing selected the first row is the tab stop', () => {
    const rows = sets.cases.result.findings;
    const html = renderToStaticMarkup(h(mod.page.FindingList, { rows, selectedFp: null, onSelect: noop }));
    assert.ok(/tabindex="0"/.test(buttons(html)[0].attrs));
  });
});

// ================================================================================================ pure projections and wiring

describe('projections and wiring', () => {
  test('Continuity is a project tab after Timeline at /continuity', () => {
    const tabs = mod.routes.PROJECT_TABS;
    const keys = tabs.map((t) => t.key);
    assert.equal(keys[keys.indexOf('timeline') + 1], 'continuity');
    const tab = tabs.find((t) => t.key === 'continuity');
    assert.equal(tab.label, 'Continuity');
    assert.equal(tab.path, '/continuity');
  });

  test('findingsForScene keeps the engine order and matches scene sources by ID only', () => {
    const a = finding({ fingerprint: 'cf1-0000000000000010', severity: 'error' });
    const b = finding({ fingerprint: 'cf1-0000000000000011' });
    const c = finding({ fingerprint: 'cf1-0000000000000012', sources: [{ ...finding().sources[0], id: 'scene_A' }] });
    const got = mod.model.findingsForScene({ findings: [a, b, c] }, 'scene_A');
    assert.deepEqual(got.map((f) => f.fingerprint), [a.fingerprint, b.fingerprint], 'an entry source with the same id is not a scene source');
    assert.deepEqual(mod.model.findingsForScene(null, 'scene_A'), []);
  });

  test('editor marks: one per scene source with a range, on the body line (file line minus front matter), titled with the finding title; entry sources are not marked', async () => {
    const file = await fs.readFile(path.join(sets.so.root, ...ARRIVAL_REL.split('/')), 'utf8');
    const lines = file.split(/\r?\n/);
    const closing = lines.indexOf('---', 1);
    const frontLines = closing + 1;
    assert.equal(mod.model.frontMatterLines(file), frontLines);
    const marks = mod.model.editorMarks(sets.so.result.findings, ARRIVAL, frontLines);
    assert.equal(marks.length, 1);
    const f = soFinding();
    const src = f.sources.find((s) => s.kind === 'scene');
    assert.equal(marks[0].line, src.line - frontLines);
    assert.deepEqual([marks[0].from, marks[0].to], [src.range.from, src.range.to]);
    assert.equal(marks[0].title, f.title);
    assert.equal(lines[src.line - 1].slice(marks[0].from, marks[0].to), 'green eyes');
    assert.deepEqual(mod.model.editorMarks(sets.so.result.findings, PROLOGUE, frontLines), []);
    assert.equal(mod.model.frontMatterLines('no front matter\n'), 0);
  });

  test('a finding\'s evidence in the front matter yields no editor mark', () => {
    const f = finding({ sources: [{ ...finding().sources[1], line: 3 }] });
    assert.deepEqual(mod.model.editorMarks([f], 'scene_A', 6), []);
  });

  test('the queue shows what the engine reported: acknowledged rows equal `suppressed`, and a fingerprint finds a live or an acknowledged finding', () => {
    const m = mod.model;
    const r = sets.exc.result;
    assert.deepEqual(m.acknowledgedRows(r).map((x) => x.fingerprint), r.suppressed.map((s) => s.finding.fingerprint));
    assert.equal(m.findByFingerprint(r, r.suppressed[0].finding.fingerprint)?.exception.slug, 'maren-eyes');
    assert.equal(m.findByFingerprint(sets.so.result, FP)?.fingerprint, FP);
    assert.equal(m.findByFingerprint(sets.so.result, 'cf1-ffffffffffffffff'), null);
    assert.equal(m.findByFingerprint(sets.so.result, null), null);
  });
});
