// M05-J07 acceptance 8: render tests (no browser, no network) for the Receipts rail section, the lineage steps, the selected-passage panel, the integrity list and the
// export dialog's "What to include" options with the evidence warning.
// Data is the real answer of a server process that ran the section 8.1 scenario on a copy of valid/salt-orchard (apps/server/test/receipts-helpers.mjs), plus the answers of
// two copies of it that were tampered with. Expected text comes from the contract and from the receipt files on disk, not from the components.
// Method: renderToStaticMarkup runs no effects, so the rail's own request is answered by suggestions-stubs.mjs (a vite plugin points `../api.js` at it for apps/web/src/receipts/),
// and the export dialog's initial "include" choice is switched by a useState shim for that one file (test seam: the state that starts as 'manuscript' starts as globalThis.__sfInclude).
// Contract: docs/contracts/M05-J07-receipts.md sections 4, 5, 6 and acceptance 8.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { ARRIVAL, ARRIVAL_PATH, NOTE, PROVIDER, MODEL, RCPT, chainOf, copyDir, readReceipts, runScenario, stepText } from '../../server/test/receipts-helpers.mjs';
import { makeHome, startApp, startMockProvider, stopAll } from '../../server/test/ai-helpers.mjs';
import { NEW } from '../../server/test/suggest-helpers.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const STUBS = path.join(webDir, 'test', 'suggestions-stubs.mjs').replace(/\\/g, '/');
const SHIM = path.join(webDir, 'test', 'receipts-usestate-shim.mjs').replace(/\\/g, '/');
const BOOK_ID = 'book_01S5000000000000000000000A';
const BOOK_PROPS = { id: BOOK_ID, title: 'The Salt Orchard', slug: 'salt-orchard' };
const SCENE = { id: ARRIVAL, path: ARRIVAL_PATH, title: 'Arrival' };
const EVIDENCE_WARNING = 'This contains your full text history and any prompts you chose to keep.';

let vite;
let mock;
let chain;
const mod = {};
const data = {};
const html = (el) => renderToStaticMarkup(el);
const text = (markup) => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const count = (markup, re) => (markup.match(re) ?? []).length;
const buttons = (markup) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));

before(async () => {
  const stubPlugin = {
    name: 'receipts-test-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      const imp = (importer ?? '').replace(/\\/g, '/');
      return imp.includes('/src/receipts/') && source === '../api.js' ? STUBS : null;
    },
    transform(code, id) {
      return id.replace(/\\/g, '/').split('?')[0].endsWith('/src/export/ExportDialog.jsx') ? code.replace("from 'react'", `from '${SHIM}'`) : null;
    },
  };
  vite = await createServer({ root: webDir, logLevel: 'silent', plugins: [stubPlugin], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  mod.rail = await vite.ssrLoadModule('/src/receipts/RailReceipts.jsx');
  mod.model = await vite.ssrLoadModule('/src/receipts/model.js');
  mod.shell = await vite.ssrLoadModule('/src/shell/Inspector.jsx');
  mod.exportDialog = await vite.ssrLoadModule('/src/export/ExportDialog.jsx');
  mod.exportRequests = await vite.ssrLoadModule('/src/export/requests.js');

  // real answers (when the server side is not there, the suites that need them fail with the reason; the dialog suite does not)
  try {
  mock = await startMockProvider({ reply: 'unused' });
  const sc = await runScenario({ mock });
  data.ok = (await sc.app.get(RCPT.receipts(ARRIVAL))).json;
  data.blame = {};
  for (const n of [15, 17, 19]) data.blame[n] = (await sc.app.get(RCPT.blame(ARRIVAL, n, n))).json;
  await sc.app.stop();
  chain = chainOf(await readReceipts(sc.library), ARRIVAL);
  data.library = sc.library;

  const ask = async (library) => {
    const app = await startApp({ library, home: await makeHome(), net: true });
    try {
      return (await app.get(RCPT.receipts(ARRIVAL))).json;
    } finally {
      await app.stop();
    }
  };
  // a receipt byte edited -> RCPT_PARENT_ALTERED on the child
  const tampered = await copyDir(sc.library);
  const first = path.join(tampered, ...chain[0].rel.split('/'));
  const bytes = Buffer.from(await fs.readFile(first));
  const at = bytes.toString('utf8').search(/\n\n[A-Za-z]/) + 2;
  bytes[at] = bytes[at] === 0x58 ? 0x59 : 0x58;
  await fs.writeFile(first, bytes);
  data.altered = await ask(tampered);
  // a scene edit made while StoryForge was stopped -> RCPT_UNRECORDED only
  const outside = await copyDir(sc.library);
  const sceneFile = path.join(outside, ...ARRIVAL_PATH.split('/'));
  await fs.writeFile(sceneFile, (await fs.readFile(sceneFile, 'utf8')).replace('ticket hut', 'ticket kiosk'));
  data.unrecorded = await ask(outside);
  } catch (e) {
    data.error = e;
  }
});
const needData = () => {
  if (data.error) throw new Error(`no real server answers to render: ${data.error.stack ?? data.error}`);
};
after(async () => {
  await vite?.close();
  await mock?.close();
  await stopAll();
});
afterEach(() => {
  globalThis.__sfApi = undefined;
  globalThis.__sfInclude = undefined;
});

const rail = (answer) => {
  globalThis.__sfApi = answer === undefined ? {} : { [mod.model.receiptsUrl(BOOK_ID, ARRIVAL)]: answer };
  return html(h(mod.rail.RailReceipts, { book: BOOK_PROPS, scene: SCENE }));
};

describe('fixture data (guards the tests below against an empty answer)', () => {
  before(needData);
  test('the server answered the scenario with six receipts, a lineage, an ok status, and two tampered answers with problems', () => {
    assert.equal(data.ok.receipts.length, 6);
    assert.equal(data.ok.lineage.length >= 6, true, JSON.stringify(data.ok.lineage));
    assert.deepEqual(data.altered.status.problems.map((p) => p.code), ['RCPT_PARENT_ALTERED']);
    assert.deepEqual(data.unrecorded.status.problems.map((p) => p.code), ['RCPT_UNRECORDED']);
    assert.equal(chain.length, 6);
  });
});

describe('the Receipts rail section', () => {
  test('is in the scene inspector (editor rail) under the heading "Receipts"', () => {
    const markup = html(h(mod.shell.SceneInspector, { book: BOOK_PROPS, scene: { ...SCENE, body: 'x', front_matter: {} }, diagnostics: { items: [] }, objects: null }));
    assert.match(markup, /<h2[^>]*>Receipts<\/h2>/);
  });

  test('has the heading, the lineage, "Where did this come from?", "Record now", the integrity badge and the fixed note', () => {
    needData();
    const markup = rail(data.ok);
    assert.match(markup, /<h2[^>]*>Receipts<\/h2>/);
    assert.equal(count(markup, /<ol[^>]*aria-label="Lineage"/g), 1);
    const labels = buttons(markup);
    assert.ok(labels.includes('Where did this come from?'), labels.join('|'));
    assert.ok(labels.includes('Record now'), labels.join('|'));
    assert.ok(text(markup).includes(NOTE), 'the fixed not-legal-advice note, word for word');
    assert.match(markup, /role="status"/);
  });

  test('while the answer has not arrived it says Loading, not "no receipts"', () => {
    const t = text(rail(undefined));
    assert.match(t, /Loading/);
    assert.doesNotMatch(t, /No receipts/i);
  });

  test('a scene without receipts says so', () => {
    const t = text(rail({ receipts: [], lineage: [], status: { ok: true, receipts: 0, problems: [] } }));
    assert.match(t, /No receipts/i);
    assert.ok(t.includes(NOTE));
  });
});

describe('lineage steps', () => {
  before(needData);
  test('one step per lineage entry, oldest first, in the contract\'s plain words', () => {
    const markup = rail(data.ok);
    const t = text(markup);
    const steps = data.ok.lineage.map(stepText);
    const list = /<ol[^>]*aria-label="Lineage"[^>]*>([\s\S]*?)<\/ol>/.exec(markup)?.[1] ?? '';
    assert.ok(count(list, /<li\b/g) >= steps.length, 'a list item per step');
    let at = -1;
    for (const s of steps) {
      const i = t.indexOf(text(s), at + 1);
      assert.ok(i > at, `step "${s}" is shown after the one before it`);
      at = i;
    }
    for (const want of [/Author wrote \(baseline\)/, /Author edited/, /AI suggested 3 changes/, /Author accepted lines 15/, /Author declined 1 change/, /Author revised lines 19/]) assert.match(t, want);
    // the AI step names provider, model and locality
    assert.ok(t.includes(PROVIDER) && t.includes(MODEL), 'provider and model');
    assert.match(t, new RegExp(`${MODEL}, local`));
  });

  test('each step expands to its details: id, time, actor, hashes, ranges, diff, AI settings and prompt hashes, parent links, file path', () => {
    const markup = rail(data.ok);
    assert.ok(count(markup, /<details\b/g) >= 5, 'steps are expandable');
    const t = text(markup);
    for (const r of chain) {
      assert.ok(t.includes(r.fm.id), `receipt id ${r.fm.id}`);
      assert.ok(t.includes(r.rel), `receipt file path ${r.rel}`);
      if (r.fm.after_sha256) assert.ok(t.includes(r.fm.after_sha256), `after hash of ${r.fm.operation}`);
      assert.ok(t.includes(r.fm.at), `time of ${r.fm.operation}`);
      for (const p of r.fm.parents ?? []) assert.ok(t.includes(p.id), `parent link ${p.id}`);
    }
    const proposal = chain[2].fm;
    for (const k of ['settings_sha256', 'prompt_sha256', 'context_sha256']) assert.ok(t.includes(proposal.ai[k]), `AI ${k}`);
    // the diff of the accepted hunk, with the original and proposed line
    assert.ok(t.includes(`+${NEW[15]}`), 'the accepted line is in the diff');
    assert.ok(t.includes('-The ferry nudged the jetty'), 'the replaced line is in the diff');
    assert.match(t, /lines? 15/);
  });

  test('the rail never offers to edit or delete a receipt (they are records)', () => {
    const labels = buttons(rail(data.ok)).join('|');
    assert.doesNotMatch(labels, /delete|remove|edit|archive|repair|fix/i);
  });
});

describe('selected passage: "Where did this come from?"', () => {
  before(needData);
  const rows = (n) => mod.model.readBlame(data.blame[n]);
  const receipts = () => data.ok.receipts.map(mod.model.readReceipt);
  const panel = (props) => html(h(mod.rail.PassagePanel, { receipts: receipts(), ...props }));

  test('accepted AI line shows "Author text edited with AI"', () => {
    const t = text(panel({ lines: { from: 15, to: 15 }, rows: rows(15) }));
    assert.match(t, /Line 15/);
    assert.match(t, /Author text edited with AI/);
    assert.ok(t.includes(chain[3].fm.id), 'the receipt that introduced it');
  });
  test('declined line shows "Author-written", from the first-seen baseline', () => {
    const t = text(panel({ lines: { from: 17, to: 17 }, rows: rows(17) }));
    assert.match(t, /Author-written/);
    assert.doesNotMatch(t, /edited with AI|AI-generated/);
    assert.ok(t.includes(chain[0].fm.id));
  });
  test('hand-revised line shows "Author-written" from the later author edit', () => {
    const t = text(panel({ lines: { from: 19, to: 19 }, rows: rows(19) }));
    assert.match(t, /Author-written/);
    assert.ok(t.includes(chain[5].fm.id));
    assert.ok(!t.includes(chain[0].fm.id));
  });
  test('the four labels of the contract render as written: AI-generated proposal and Changed outside StoryForge too', () => {
    const synthetic = mod.model.readBlame([
      { line: 3, receiptId: chain[2].fm.id, actor: 'ai', label: 'AI-generated proposal' },
      { line: 4, receiptId: chain[0].fm.id, actor: 'external', label: 'Changed outside StoryForge' },
    ]);
    const t = text(panel({ lines: { from: 3, to: 4 }, rows: synthetic }));
    assert.match(t, /AI-generated proposal/);
    assert.match(t, /Changed outside StoryForge/);
    assert.match(t, /Lines? 3/);
    assert.match(t, /Lines? 4/);
  });
  test('a multi-line selection is described by its range; loading and "nothing selected" are said in words', () => {
    assert.match(text(panel({ lines: { from: 15, to: 19 }, rows: rows(15) })), /Lines 15–19/);
    assert.match(text(panel({ lines: { from: 15, to: 15 }, rows: null })), /Loading/);
    assert.match(text(panel({ lines: null, rows: null, message: 'Select some text in the editor first, then ask again.' })), /Select some text/);
    assert.match(text(panel({ lines: { from: 15, to: 15 }, rows: [] })), /No receipt/i);
  });
});

describe('integrity list', () => {
  before(needData);
  test('a clean chain shows a verified badge and no problem list', () => {
    const markup = rail(data.ok);
    assert.match(text(markup), /verified/i);
    assert.equal(count(markup, /rc-problem\b/g), 0);
    assert.doesNotMatch(text(markup), /RCPT_/);
  });
  test('an altered receipt: badge says a problem was found, and the list names the code, what it means, and the file', () => {
    const markup = rail(data.altered);
    const t = text(markup);
    assert.match(t, /1 problem/i);
    assert.match(t, /RCPT_PARENT_ALTERED/);
    assert.match(t, /changed after it was written|altered/i, 'plain words for the code');
    assert.equal(count(markup, /<li[^>]*class="[^"]*rc-problem\b/g), 1);
    assert.ok(t.includes(data.altered.status.problems[0].file), 'the file the problem is about');
    assert.match(markup, /aria-label="Receipt problems"|role="alert"|role="list"/, 'the list is labelled');
  });
  test('only unrecorded changes: shown as information (not a failure), with the plain explanation', () => {
    const markup = rail(data.unrecorded);
    const t = text(markup);
    assert.match(t, /RCPT_UNRECORDED/);
    assert.match(t, /not in a receipt yet|unrecorded|outside/i);
    assert.doesNotMatch(t, /\d+ problems? found/i, 'info is not an error');
    assert.match(markup, /rc-problem-info/);
  });
  test('the list reports and offers nothing to repair', () => {
    const labels = buttons(rail(data.altered)).join('|');
    assert.doesNotMatch(labels, /repair|fix|delete|rewrite|renumber/i);
  });
});

describe('export dialog: What to include', () => {
  const dialog = () => html(h(mod.exportDialog.ExportDialog, { book: { ...BOOK_PROPS, statuses: ['drafting'], acts: [] }, onClose() {} }));
  const includeRadios = (markup) => [...markup.matchAll(/<input\b([^>]*type="radio"[^>]*)>/g)].map((m) => m[1]).filter((a) => /name="export-include"|value="(manuscript|summary|evidence)"/.test(a));
  const val = (attrs) => /value="([^"]*)"/.exec(attrs)?.[1];

  test('three choices in one group, in order: Manuscript only (selected by default), + provenance summary, Complete private evidence package', () => {
    const markup = dialog();
    assert.match(markup, /<legend[^>]*>What to include<\/legend>/);
    const radios = includeRadios(markup);
    assert.deepEqual(radios.map(val), ['manuscript', 'summary', 'evidence']);
    assert.equal(new Set(radios.map((r) => /name="([^"]*)"/.exec(r)?.[1])).size, 1, 'one group');
    assert.deepEqual(radios.map((r) => /\bchecked\b/.test(r)), [true, false, false], 'Manuscript only is the default');
    const t = text(markup);
    const i1 = t.indexOf('Manuscript only');
    const i2 = t.indexOf('Manuscript + provenance summary');
    const i3 = t.indexOf('Complete private evidence package');
    assert.ok(i1 > -1 && i2 > i1 && i3 > i2, `labels in order: ${i1} ${i2} ${i3}`);
  });

  test('the manuscript-only choice promises no provenance, provider or prompt data; the evidence warning is not shown while it is selected', () => {
    const t = text(dialog());
    assert.match(t, /no provenance, provider or prompt/i);
    assert.ok(!t.includes(EVIDENCE_WARNING));
  });

  test('choosing the evidence package shows the warning before download: "This contains your full text history and any prompts you chose to keep."', () => {
    globalThis.__sfInclude = 'evidence';
    const markup = dialog();
    assert.ok(text(markup).includes(EVIDENCE_WARNING));
    const radios = includeRadios(markup);
    assert.deepEqual(radios.map((r) => /\bchecked\b/.test(r)), [false, false, true]);
    assert.ok(buttons(markup).some((b) => /^export\b/i.test(b)), 'the Export button is still the way to download');
  });

  test('choosing the summary shows no evidence warning', () => {
    globalThis.__sfInclude = 'summary';
    const markup = dialog();
    assert.ok(!text(markup).includes(EVIDENCE_WARNING));
    assert.deepEqual(includeRadios(markup).map((r) => /\bchecked\b/.test(r)), [false, true, false]);
  });

  test('the request carries the choice: default asks for the plain manuscript, the others send include=', () => {
    const u = mod.exportRequests.exportUrl;
    assert.doesNotMatch(u(BOOK_ID, { format: 'markdown' }), /include=(summary|evidence)/);
    assert.match(u(BOOK_ID, { format: 'docx', include: 'summary' }), /[?&]include=summary\b/);
    assert.match(u(BOOK_ID, { format: 'markdown', include: 'evidence' }), /[?&]include=evidence\b/);
    assert.equal(mod.exportRequests.EVIDENCE_WARNING, EVIDENCE_WARNING);
  });
});
