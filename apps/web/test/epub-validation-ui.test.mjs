// M13-J04: EPUB validation in the Export dialog and in Settings. Server-rendered with renderToStaticMarkup (no browser, no network), like export-ui.test.mjs; the flow (start, poll, cancel,
// remember the choice) is tested through the request helpers with a fake fetch and a fake sleep.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const src = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

let vite;
let Dialog;
let Panel;
let Settings;
let V;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  Dialog = (await vite.ssrLoadModule('/src/export/ExportDialog.jsx')).ExportDialog;
  Panel = (await vite.ssrLoadModule('/src/export/ValidationPanel.jsx')).ValidationPanel;
  Settings = await vite.ssrLoadModule('/src/prefs/EpubSettings.jsx');
  V = await vite.ssrLoadModule('/src/export/validation.js');
});
after(async () => {
  await vite?.close();
});

const render = (el) => renderToStaticMarkup(el);
const decode = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const noop = () => {};
const BOOK_ID = 'book_01S5000000000000000000000A';
const SCENE_A = 'scene_01S50000000000000000000002';
const SCENE_B = 'scene_01S50000000000000000000003';
const BOOK = { id: BOOK_ID, slug: 'salt-orchard', title: 'The Salt Orchard', acts: [] };
const LIMITS = 'EPUBCheck checks the file against the EPUB standard. It does not check editing, full accessibility or whether a store will accept the book.';

/** The first opening tag of `tag` whose text includes `needle`, or null. */
const tagWith = (html, tag, needle) => (html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? []).find((t) => t.includes(needle)) ?? null;

const dialog = (extra = {}) => render(h(Dialog, { book: BOOK, onClose: noop, ...extra }));
const panel = (props) => render(h(Panel, { bookId: BOOK_ID, phase: 'done', ...props }));
const job = (result, extra = {}) => ({ state: 'completed', filename: 'salt-orchard.epub', explanations: {}, sources: {}, chapters: {}, result, ...extra });
const result = (outcome, extra = {}) => ({ schema: 'storyforge.validation/v1', validator: 'epubcheck', validatorVersion: '5.4.0', artifact: { kind: 'epub', sha256: 'a'.repeat(64), name: 'salt-orchard.epub' }, checkedAt: '2026-01-01T00:00:00.000Z', outcome, messages: [], report: null, detail: null, ...extra });
const msg = (code, severity, extra = {}) => ({ code, severity, message: `${code} says so.`, location: null, sceneId: null, chapterId: null, ...extra });

describe('the Export dialog', () => {
  test('the checkbox is offered only with EPUB selected, unticked unless the book remembers it', () => {
    assert.ok(!dialog().includes('Validate with EPUBCheck'), 'Word is the default format: no checkbox');
    assert.ok(!dialog({ initialFormat: 'pdf' }).includes('Validate with EPUBCheck'));
    const epub = dialog({ initialFormat: 'epub' });
    assert.ok(tagWith(epub, 'input', 'name="export-validate"')?.includes('type="checkbox"'));
    assert.ok(plain(epub).includes('Validate with EPUBCheck'));
    assert.ok(!tagWith(epub, 'input', 'name="export-validate"').includes('checked'), 'not ticked by default');
    assert.ok(tagWith(dialog({ initialFormat: 'epub', initialValidate: true }), 'input', 'name="export-validate"').includes('checked=""'));
    assert.ok(tagWith(epub, 'input', 'name="export-validate"').includes('aria-describedby="export-validate-hint"'));
    assert.match(epub, /id="export-validate-hint"/);
  });

  test('unticked, the export button is the same as before; ticked it says it also checks, and the dialog shows no outcome until a check has run', () => {
    const off = dialog({ initialFormat: 'epub' });
    assert.match(off, /<button type="submit"[^>]*>Export<\/button>/);
    const on = dialog({ initialFormat: 'epub', initialValidate: true });
    assert.match(on, /<button type="submit"[^>]*>Export and check<\/button>/);
    for (const html of [off, on]) {
      assert.ok(!html.includes('Checking the EPUB'));
      assert.ok(!html.includes(LIMITS), 'the limits sentence belongs to a check, not to every export');
      assert.ok(!html.includes('Download EPUB'));
    }
  });
});

describe('the check in the dialog', () => {
  test('running: "Checking the EPUB…", a Cancel button and the limits sentence', () => {
    const html = panel({ phase: 'running' });
    assert.ok(plain(html).includes('Checking the EPUB…'));
    assert.match(html, /<button type="button" class="btn">Cancel<\/button>/);
    assert.ok(plain(html).includes(LIMITS));
    assert.match(html, /role="status"/);
    assert.match(panel({ phase: 'running', cancelling: true }), /disabled="">Cancelling…<\/button>/);
    assert.match(panel({ phase: 'running', canCancel: false }), /disabled="">Cancel<\/button>/);
    assert.ok(!html.includes('Download EPUB'), 'nothing to download until the check is over');
  });

  const WORDS = [
    ['passed', 'Passed'],
    ['passed-with-warnings', 'Passed with warnings'],
    ['failed', 'Failed'],
    ['cancelled', 'Not checked'],
    ['unavailable', 'Validator unavailable'],
    ['error', 'Check could not run'],
  ];
  for (const [outcome, word] of WORDS) {
    test(`outcome ${outcome}: "${word}", the limits sentence and both downloads, whatever the outcome`, () => {
      const html = panel({ job: job(result(outcome, outcome === 'unavailable' || outcome === 'error' || outcome === 'cancelled' ? { detail: 'The reason in plain words.', validatorVersion: null, checkedAt: null } : {})) });
      assert.match(html, new RegExp(`<strong>${word}</strong>`));
      assert.match(html, new RegExp(`data-outcome="${outcome}"`));
      const text = plain(html);
      assert.ok(text.includes(LIMITS));
      assert.ok(text.includes('Download EPUB') && text.includes('Download report'));
      assert.match(html, /<button type="button" class="btn">Download EPUB<\/button>/);
      const passes = outcome === 'passed' || outcome === 'passed-with-warnings';
      assert.equal(/Passed/.test(text), passes, `"Passed" appears only for a pass (${outcome})`);
    });
  }

  test('unavailable: the reason and "Set it up in Settings" as a link; error: the detail; cancelled: the reason', () => {
    const unavailable = panel({ job: job(result('unavailable', { detail: 'Java was not found.', validatorVersion: null, checkedAt: null })) });
    assert.ok(plain(unavailable).includes('Java was not found.'));
    assert.ok(plain(unavailable).includes('Set it up in Settings'));
    assert.match(unavailable, /<a href="\/settings">Settings<\/a>/);
    const error = panel({ job: job(result('error', { detail: 'Java stopped with code 3.', validatorVersion: null, checkedAt: null }), { state: 'failed' }) });
    assert.ok(plain(error).includes('Java stopped with code 3.'));
    assert.ok(!plain(error).includes('Set it up in Settings'));
    assert.ok(plain(panel({ job: job(result('cancelled', { detail: 'You stopped the check before it finished.', validatorVersion: null, checkedAt: null }), { state: 'cancelled' }) })).includes('You stopped the check'));
  });

  test('no result at all, or an outcome the app does not know, is never shown as passed', () => {
    for (const j of [null, job(null, { state: 'failed' }), job(result('mystery'))]) {
      const text = plain(panel({ job: j }));
      assert.ok(text.includes('Check could not run'));
      assert.ok(!/Passed/.test(text));
      assert.ok(text.includes('Download EPUB'), 'the file is still offered');
    }
  });

  test('messages are listed by severity with the explanation, the original code and message, the location and a link to the scene', () => {
    const messages = [
      msg('PKG-001', 'warning', { location: { path: 'META-INF/container.xml', line: null, column: null } }),
      msg('RSC-007', 'error', { location: { path: 'OEBPS/chapter-001.xhtml', line: 12, column: 4 }, sceneId: SCENE_A }),
      msg('OPF-014', 'fatal'),
      msg('RSC-005', 'error', { location: { path: 'OEBPS/chapter-002.xhtml', line: 3, column: 1 }, chapterId: 'chap_01S5000000000000000000000X' }),
    ];
    const html = panel({
      job: job(result('failed', { messages }), {
        explanations: { 'RSC-007': 'A file the book points at is missing.' },
        sources: { [SCENE_A]: { title: 'Arrival', chapterLabel: 'Chapter 1' } },
        chapters: { chap_01S5000000000000000000000X: { chapterLabel: 'Chapter 2', sceneId: SCENE_B } },
      }),
    });
    const text = plain(html);
    assert.ok(text.includes('4 messages'));
    assert.ok(text.indexOf('Fatal errors') < text.indexOf('Errors (2)') && text.indexOf('Errors (2)') < text.indexOf('Warnings (1)'), 'most serious first');
    assert.ok(text.includes('A file the book points at is missing.'));
    assert.ok(text.includes('RSC-007 RSC-007 says so.'), 'the original code and EPUBCheck message');
    assert.ok(text.includes('OEBPS/chapter-001.xhtml, line 12, column 4'));
    assert.ok(text.includes('META-INF/container.xml'));
    assert.ok(!text.includes('PKG-001 PKG-001 says so. line'), 'a null line is not printed');
    assert.ok(text.includes('RSC-005 RSC-005 says so.'), 'no explanation: EPUBCheck\'s own message is shown');
    assert.ok(html.includes(`<a href="/books/${BOOK_ID}?scene=${SCENE_A}" class="btn btn-small">Open the scene &quot;Arrival&quot; (Chapter 1)</a>`));
    assert.ok(html.includes(`<a href="/books/${BOOK_ID}?scene=${SCENE_B}" class="btn btn-small">Open chapter Chapter 2</a>`));
    assert.equal((html.match(/class="btn btn-small"/g) ?? []).length, 2, 'messages in other files have no link');
  });

  test('a long list is cut on screen and says how many are in the report', () => {
    const messages = Array.from({ length: 230 }, (_, i) => msg('HTM-001', 'warning', { message: `Warning number ${i}` }));
    const html = panel({ job: job(result('passed-with-warnings', { messages })) });
    assert.equal((html.match(/class="validation-message"/g) ?? []).length, V.MAX_SHOWN);
    assert.ok(plain(html).includes('30 more messages are in the report.'));
  });
});

describe('the model', () => {
  test('outcome words: only passed and passed-with-warnings pass', () => {
    assert.deepEqual(V.outcomeView('passed'), { word: 'Passed', tone: 'good', pass: true });
    assert.equal(V.outcomeView('passed-with-warnings').pass, true);
    for (const o of ['failed', 'cancelled', 'not-checked', 'unavailable', 'error', 'mystery', undefined, null, 5, '__proto__']) assert.equal(V.outcomeView(o).pass, false, String(o));
    assert.equal(V.outcomeView('not-checked').word, 'Not checked');
    assert.equal(V.outcomeView('mystery').word, 'Check could not run');
    assert.equal(V.LIMITS_SENTENCE, LIMITS);
  });

  test('groupMessages orders by severity and keeps unknown severities last', () => {
    const g = V.groupMessages([msg('A', 'usage'), msg('B', 'weird'), msg('C', 'fatal'), msg('D', 'info'), msg('E', 'warning'), msg('F', 'error')]);
    assert.deepEqual(g.groups.map((x) => x.key), ['fatal', 'error', 'warning', 'info', 'usage', '']);
    assert.equal(g.total, 6);
    assert.equal(g.hidden, 0);
    const cut = V.groupMessages([msg('A', 'error'), msg('B', 'error'), msg('C', 'warning')], 2);
    assert.equal(cut.hidden, 1);
    assert.deepEqual(V.groupMessages(undefined), { groups: [], total: 0, hidden: 0 });
  });

  test('locationText and sourceLink', () => {
    assert.equal(V.locationText({ path: 'a.xhtml', line: 3, column: 9 }), 'a.xhtml, line 3, column 9');
    assert.equal(V.locationText({ path: 'a.xhtml', line: null, column: null }), 'a.xhtml');
    assert.equal(V.locationText(null), '');
    assert.equal(V.sourceLink(msg('A', 'error'), {}, BOOK_ID), null);
    assert.deepEqual(V.sourceLink(msg('A', 'error', { sceneId: SCENE_A }), {}, BOOK_ID), { href: `/books/${BOOK_ID}?scene=${SCENE_A}`, label: 'Open the scene' });
    assert.deepEqual(V.sourceLink(msg('A', 'error', { chapterId: 'chap_X' }), { chapters: { chap_X: { chapterLabel: 'Chapter 9', sceneId: null } } }, BOOK_ID), { href: null, label: 'In chapter Chapter 9' });
    assert.equal(V.sceneHref('book id', 'scene/1'), '/books/book%20id?scene=scene%2F1');
  });
});

/** A fake fetch: answers from a list of [status, json] in order and records the calls. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    const [status, json] = next;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

describe('the flow', () => {
  test('start posts only the manuscript options with the write header; 202 gives the id; refusals are put into words', async () => {
    const f = fakeFetch([202, { validationId: 'val_1' }]);
    assert.deepEqual(await V.startValidation(BOOK_ID, { sceneTitles: true, excludeStatuses: ['final'] }, f), { ok: true, id: 'val_1' });
    assert.equal(f.calls[0].url, `/api/books/${BOOK_ID}/export/validations`);
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].headers['x-storyforge'], '1');
    assert.deepEqual(JSON.parse(f.calls[0].body), { sceneTitles: true, excludeStatuses: ['final'], include: 'manuscript' });
    const busy = await V.startValidation(BOOK_ID, {}, fakeFetch([409, { code: 'VALIDATION_RUNNING' }]));
    assert.equal(busy.ok, false);
    assert.match(busy.message, /already running/);
    assert.match((await V.startValidation(BOOK_ID, {}, fakeFetch(new Error('offline')))).message, /could not be reached/);
    assert.match((await V.startValidation(BOOK_ID, {}, fakeFetch([500, { error: 'export_failed', problems: ['x'] }]))).message, /did not match your manuscript/);
    assert.match((await V.startValidation(BOOK_ID, {}, fakeFetch([404, null]))).message, /not there any more/);
  });

  test('polling asks every 500 ms until the check is no longer running, and tells every answer to onUpdate', async () => {
    const f = fakeFetch([200, { state: 'running', result: null }], [200, { state: 'running', result: null }], [200, { state: 'completed', result: result('passed') }]);
    const slept = [];
    const seen = [];
    const done = await V.pollValidation(BOOK_ID, 'val_1', { fetchImpl: f, sleep: async (ms) => slept.push(ms), onUpdate: (j) => seen.push(j.state) });
    assert.equal(done.ok, true);
    assert.equal(done.job.result.outcome, 'passed');
    assert.deepEqual(slept, [500, 500]);
    assert.deepEqual(seen, ['running', 'running', 'completed']);
    assert.equal(V.POLL_MS, 500);
    assert.deepEqual(f.calls.map((c) => c.url), Array(3).fill(`/api/books/${BOOK_ID}/export/validations/val_1`));
  });

  test('polling stops quietly when the dialog goes away, and reports a lost check', async () => {
    const ctrl = new AbortController();
    const f = fakeFetch([200, { state: 'running', result: null }]);
    const stopped = await V.pollValidation(BOOK_ID, 'val_1', { fetchImpl: f, sleep: async () => ctrl.abort() , signal: ctrl.signal });
    assert.equal(stopped, null);
    assert.equal(f.calls.length, 1);
    const gone = await V.pollValidation(BOOK_ID, 'val_1', { fetchImpl: fakeFetch([404, { error: 'not_found' }]), sleep: noop });
    assert.equal(gone.ok, false);
    assert.match(gone.message, /not there any more/);
  });

  test('cancel posts to the cancel route; the file and report addresses are the job\'s', async () => {
    const f = fakeFetch([200, { ok: true, cancelled: true, state: 'cancelled' }]);
    assert.deepEqual(await V.cancelValidation(BOOK_ID, 'val_1', f), { ok: true });
    assert.equal(f.calls[0].url, `/api/books/${BOOK_ID}/export/validations/val_1/cancel`);
    assert.equal(f.calls[0].method, 'POST');
    const u = V.validationUrls(BOOK_ID);
    assert.equal(u.file('val_1'), `/api/books/${BOOK_ID}/export/validations/val_1/file`);
    assert.equal(u.report('val_1'), `/api/books/${BOOK_ID}/export/validations/val_1/report`);
  });

  test('the checkbox is remembered through checks/epub and read back from the effective preferences', async () => {
    const f = fakeFetch([200, { ok: true, epub: { validate: true } }]);
    assert.deepEqual(await V.saveValidateChoice(BOOK_ID, true, f), { ok: true });
    assert.equal(f.calls[0].url, `/api/books/${BOOK_ID}/checks/epub`);
    assert.deepEqual(JSON.parse(f.calls[0].body), { validate: true });
    assert.equal(f.calls[0].headers['x-storyforge'], '1');
    assert.equal((await V.saveValidateChoice(BOOK_ID, true, fakeFetch([403, null]))).ok, false);
    assert.match((await V.saveValidateChoice(BOOK_ID, true, fakeFetch(new Error('offline')))).message, /not remembered/);
    assert.equal(V.validateChoiceOf({ effective: { checks: { epub: { validate: true } } } }), true);
    assert.equal(V.validateChoiceOf({ effective: { checks: { epub: { validate: false } } } }), false);
    assert.equal(V.validateChoiceOf(null), false);
    assert.equal(V.preferencesUrl(BOOK_ID), `/api/preferences?book=${BOOK_ID}`);
  });
});

describe('Settings: EPUB validation (optional)', () => {
  const view = (props = {}) => render(h(Settings.EpubSettingsView, { java: '', epubcheckJar: '', ...props }));

  test('the heading, two labelled path fields with their values, Save and Check setup, and plain instructions without a web address', () => {
    const html = view({ java: 'C:\\Java\\bin\\java.exe', epubcheckJar: 'C:\\tools\\epubcheck.jar' });
    assert.match(html, /<h2 id="epub-validation-heading">EPUB validation \(optional\)<\/h2>/);
    assert.match(html, /<section aria-labelledby="epub-validation-heading"/);
    assert.match(html, /<label for="([^"]+-java)">Java program \(java or java\.exe\)<\/label><input id="\1" type="text"/);
    assert.ok(tagWith(html, 'input', '-java"').includes('value="C:\\Java\\bin\\java.exe"'));
    assert.match(html, /<label for="([^"]+-jar)">EPUBCheck file \(epubcheck\.jar\)<\/label><input id="\1" type="text"/);
    assert.ok(tagWith(html, 'input', '-jar"').includes('value="C:\\tools\\epubcheck.jar"'));
    assert.match(html, /<button type="submit" class="btn btn-primary">Save<\/button>/);
    assert.match(html, /<button type="button" class="btn">Check setup<\/button>/);
    const text = plain(html);
    assert.ok(text.includes('Java 8 or newer'));
    assert.ok(text.includes('EPUBCheck 5 (tested with 5.4.0)'));
    assert.ok(text.includes('never downloads or installs them'));
    assert.ok(!/https?:|www\./i.test(html), 'no web address in the app');
  });

  test('Check setup shows the status: ready with version, or not ready with the reason; busy disables the buttons', () => {
    const ready = plain(view({ status: { java: { state: 'ready', path: '/usr/bin/java', version: '21', reason: null }, epubcheck: { state: 'ready', path: '/x/epubcheck.jar', version: '5.4.0', reason: null } } }));
    assert.ok(ready.includes('Java: ready, version 21 (/usr/bin/java)'));
    assert.ok(ready.includes('EPUBCheck: ready, version 5.4.0 (/x/epubcheck.jar)'));
    const bad = plain(view({ status: { java: { state: 'unavailable', path: 'java', version: null, reason: 'Java was not found.' }, epubcheck: { state: 'unavailable', path: null, version: null, reason: 'EPUBCheck is not set up. Choose the epubcheck.jar file in Settings.' } } }));
    assert.ok(bad.includes('Java: not ready. Java was not found.'));
    assert.ok(bad.includes('EPUBCheck: not ready. EPUBCheck is not set up.'));
    assert.ok(plain(view({ status: 'checking' })).includes('Checking…'));
    assert.ok(plain(view({ message: 'Saved.' })).includes('Saved.'));
    assert.equal((view({ busy: true }).match(/disabled=""/g) ?? []).length, 2);
    assert.ok(!view().includes('Setup status'), 'no status until asked');
  });

  test('an empty field clears the setting; the body has both fields', () => {
    assert.deepEqual(Settings.toolsBody('  ', ' /a/epubcheck.jar '), { java: null, epubcheckJar: '/a/epubcheck.jar' });
    assert.deepEqual(Settings.toolsBody('/j/java', ''), { java: '/j/java', epubcheckJar: null });
  });

  test('it sits in the owner-only block of Settings, with the other admin sections', async () => {
    const text = await readFile(src('ai/SettingsView.jsx'), 'utf8');
    const open = text.indexOf("(mode !== 'shared' || user?.role === 'owner') && (");
    const close = text.indexOf('</>', open);
    const at = text.indexOf('<EpubSettings />');
    assert.ok(open > 0 && at > open && at < close, 'EpubSettings is inside the owner block');
  });
});

describe('house rules for the new files', () => {
  const FILES = ['export/validation.js', 'export/ValidationPanel.jsx', 'export/ExportDialog.jsx', 'prefs/EpubSettings.jsx'];
  test('no web address anywhere in them', async () => {
    for (const f of FILES) assert.ok(!/https?:\/\//i.test(await readFile(src(f), 'utf8')), f);
  });
  test('onClick only on a button, a Link or an anchor; no key handling; no inline click on a div or span', async () => {
    for (const f of FILES.filter((x) => x.endsWith('.jsx'))) {
      const text = await readFile(src(f), 'utf8');
      for (const m of text.matchAll(/<(\w+)[^<>]*?onClick=/g)) assert.ok(['button', 'Link', 'a'].includes(m[1]), `${f}: onClick on <${m[1]}>`);
      assert.ok(!/onKeyDown|keydown|\be\.key\b|event\.key/.test(text), `${f} reads keys`);
    }
  });
  test('every control has a name: the settings inputs have a label that points at them, the checkbox sits in its label, buttons have text', () => {
    const settings = render(h(Settings.EpubSettingsView, { java: '', epubcheckJar: '' }));
    for (const m of settings.matchAll(/<input id="([^"]+)"/g)) assert.match(settings, new RegExp(`<label for="${m[1]}">`));
    const html = dialog({ initialFormat: 'epub', initialValidate: true }) + panel({ job: job(result('failed', { messages: [msg('RSC-007', 'error')] })) }) + settings;
    assert.ok(!/<button[^>]*><\/button>/.test(html), 'a button with no text');
    assert.match(dialog({ initialFormat: 'epub' }), /<label class="choice"><input type="checkbox"[^>]*name="export-validate"[^>]*\/><span>Validate with EPUBCheck<\/span><\/label>/);
  });
});
