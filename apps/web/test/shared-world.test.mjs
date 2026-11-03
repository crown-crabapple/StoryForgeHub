// M07-J01b: the UI of series shared worlds, cross-book links, labels, typed fields and library templates, rendered with what the API returns for a copy of the
// tidewater fixture (series tidewater: books salt-orchard-2 and low-tide, a standalone pilgrims-road, a library template mystery-arc) plus the pure logic behind it.
// Server-rendered with renderToStaticMarkup (no browser), like codex-render.test.mjs. What a render cannot show (clicks, focus) is in the browser walk.
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
import { contrast, parseTokens, rgb } from './color.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.resolve(webDir, '../../packages/format/fixtures/valid');
const SO = 'book_01W10000000000000000000006';
const LT = 'book_01W1000000000000000000000A';
const PR = 'book_01W1000000000000000000000E';
const VESSEL = 'entry_01W10000000000000000000009';
const ILSE = 'entry_01W10000000000000000000003';

let vite;
const m = {};
const d = {};
const noop = () => {};
const clone = (o) => JSON.parse(JSON.stringify(o));
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const html = (el) => renderToStaticMarkup(el);
const count = (markup, re) => (markup.match(re) ?? []).length;
/** The attributes of every tag that matches, whatever order React wrote them in. */
const tagsOf = (markup, re) => [...markup.matchAll(re)].map((t) => Object.fromEntries([...t[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])])));

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of [
    '/src/world/model.js', '/src/world/LabelChip.jsx', '/src/world/LabelManager.jsx', '/src/world/SaveAsTemplateDialog.jsx', '/src/world/TypedFieldInput.jsx',
    '/src/codex/model.js', '/src/codex/CodexPage.jsx', '/src/codex/CodexCard.jsx', '/src/codex/EntryInspector.jsx', '/src/codex/dialogs.jsx', '/src/codex/requests.js', '/src/codex/LinkedText.jsx',
    '/src/editor/LinkPicker.jsx', '/src/library/NewBookDialog.jsx', '/src/planning/PlanningWorkspace.jsx', '/src/planning/model.js', '/src/shell/Inspector.jsx', '/src/structure/PreviewDialog.jsx',
    '/src/export/BookActions.jsx', '/src/ProseView.jsx',
  ]) Object.assign(m, await vite.ssrLoadModule(p));

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-world-'));
  const root = path.join(base, 'tidewater');
  await fs.cp(path.join(FIXTURES, 'tidewater'), root, { recursive: true });
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    for (const [key, id] of [['so', SO], ['lt', LT], ['pr', PR]]) {
      const list = await repo.listCodexEntries(id);
      d[key] = { bookId: id, entries: clone(list.entries), chapters: clone(list.chapters), series: list.series ?? null, types: clone(await repo.getCodexTypes(id)), labels: clone(await repo.getLabels(id)), targets: clone(await repo.getLinkTargets(id)) };
    }
    d.book = clone(await repo.getBook(SO));
    d.planning = clone(await repo.listThreads(SO));
    d.diagnostics = clone(await repo.getDiagnostics(LT));
    d.templates = clone(await repo.listTemplates());
  } finally {
    await repo.close?.();
  }
});
after(async () => {
  await vite?.close();
});

const defsOf = (labels) => [...labels.book.labels.map((l) => ({ ...l, scope: 'book' })), ...(labels.series?.labels ?? []).map((l) => ({ ...l, scope: 'series' }))];
const page = (key, props = {}) => {
  const set = d[key];
  return html(h(m.CodexPage, { bookId: set.bookId, types: set.types, entries: set.entries, chapters: set.chapters, typeKey: 'all', series: set.series, labelDefs: defsOf(set.labels), onLabel: noop, ...props }));
};

describe('Codex: shared entries', () => {
  test('a shared entry has the "Shared · <series title>" badge; the book\'s own entries do not', () => {
    const markup = page('so');
    assert.equal(count(markup, /class="shared-badge"/g), 2, 'ilse-hollis and port-aldine are shared');
    assert.match(textOf(markup), /Shared · The Tidewater Books/);
    const cards = [...markup.matchAll(/<button[^>]*class="codex-card"[^>]*data-entry-id="([^"]+)"[\s\S]*?<\/button>/g)];
    const withBadge = cards.filter((c) => c[0].includes('shared-badge')).map((c) => c[1]);
    assert.deepEqual(withBadge.sort(), ['entry_01W10000000000000000000003', 'entry_01W10000000000000000000004']);
  });

  test('the All / This book / Shared filter is there for a book in a series, with All pressed; not for a standalone book', () => {
    const markup = page('so');
    const group = /<div class="chips" role="group" aria-label="Where">([\s\S]*?)<\/div>/.exec(markup);
    assert.ok(group, 'a Where group');
    assert.deepEqual([...group[1].matchAll(/<button[^>]*aria-pressed="(\w+)"[^>]*>([^<]*)<\/button>/g)].map((x) => [x[2], x[1]]), [['All', 'true'], ['This book', 'false'], ['Shared', 'false']]);
    assert.equal(page('pr').includes('aria-label="Where"'), false);
  });

  test('Shared shows only the series\' entries and This book only the book\'s own', () => {
    const names = (markup) => [...markup.matchAll(/class="codex-card-name">([^<]*)</g)].map((x) => decode(x[1])).sort();
    assert.deepEqual(names(page('so', { scope: 'shared' })), ['Ilse Hollis', 'Port Aldine']);
    assert.deepEqual(names(page('so', { scope: 'book' })), ['Gull and Ledger', 'Maren Hollis']);
    assert.equal(names(page('so', { scope: 'all' })).length, 4);
    assert.equal(names(page('pr', { scope: 'shared' })).length, 0, 'nothing is shared with a standalone book');
  });

  test('opening a shared entry shows its series path, the notice, and Copy into this book (not Move to series)', () => {
    const ilse = d.so.entries.find((e) => e.id === ILSE);
    const markup = page('so', { selectedId: ILSE, actions: () => ({ onEdit: noop, onCopyIntoBook: noop, onEditText: noop }) });
    const detail = /<aside aria-label="Entry details"[\s\S]*<\/aside>/.exec(markup)[0];
    assert.match(textOf(detail), /Series file: tidewater\/codex\/characters\/ilse-hollis\.md/);
    assert.match(textOf(detail), /Changes apply to every book in this series\./);
    assert.match(detail, /Copy into this book…/);
    assert.doesNotMatch(detail, /Move to series…/);
    assert.equal(ilse.shared, true);
  });

  test('a book\'s own entry offers Move to series…, not Copy into this book…', () => {
    const maren = d.so.entries.find((e) => e.slug === 'maren-hollis');
    const markup = page('so', { selectedId: maren.id, actions: () => ({ onMoveToSeries: noop, onEdit: noop }) });
    const detail = /<aside aria-label="Entry details"[\s\S]*<\/aside>/.exec(markup)[0];
    assert.match(detail, /Move to series…/);
    assert.doesNotMatch(detail, /Copy into this book…/);
    assert.doesNotMatch(detail, /Series file:/);
  });

  test('label chips show on cards and in the inspector; the label filter narrows the grid', () => {
    const markup = page('so');
    assert.match(markup, /class="label-chip"[^>]*data-label="Mystery"/);
    assert.match(markup, /<select[^>]*name="label"/);
    const names = [...page('so', { label: 'Backstory' }).matchAll(/class="codex-card-name">([^<]*)</g)].map((x) => decode(x[1]));
    assert.deepEqual(names, ['Maren Hollis']);
    assert.match(page('so', { label: 'Nothing' }), /No entries match/);
  });

  test('the Edit dialog of a shared entry says first that the change applies to every book in the series', () => {
    const ilse = d.so.entries.find((e) => e.id === ILSE);
    const markup = html(h(m.EditFieldsDialog, { bookId: SO, entry: ilse, entries: d.so.entries, types: d.so.types, labelDefs: defsOf(d.so.labels), onClose: noop, onPreview: noop }));
    assert.match(textOf(markup), /Shared · The Tidewater Books Changes apply to every book in this series\./);
    // its relationships offer only shared entries (shared canon cannot depend on one book's private canon)
    const options = [...(/aria-label="Related entry"[\s\S]*?<\/select>/.exec(markup)?.[0] ?? '').matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]).filter(Boolean);
    assert.ok(options.every((slug) => ['port-aldine'].includes(slug)), `only shared entries: ${options}`);
  });

  test('a copy that was made shows its W309 in the entry\'s own problems', () => {
    const local = { ...d.lt.entries.find((e) => e.slug === 'port-aldine'), problems: [{ code: 'W309', severity: 'warning', location: 'slug', message: 'this entry shadows the series entry port-aldine; links in this book reach this one' }] };
    const markup = html(h(m.EntryInspector, { bookId: LT, entry: local, types: d.lt.types }));
    assert.match(textOf(markup), /W309 this entry shadows the series entry port-aldine/);
  });
});

describe('Codex: new entry, where', () => {
  const dialog = (key, extra = {}) =>
    html(h(m.NewEntryDialog, { bookId: d[key].bookId, types: d[key].types, takenSlugs: new Set(), series: d[key].series, sharedSlugs: new Set(['ilse-hollis']), onClose: noop, onPreview: noop, ...extra }));

  test('a book in a series is asked "Where": This book or Series (shared); a standalone book is not asked', () => {
    const markup = dialog('so');
    const radios = [...markup.matchAll(/<input[^>]*name="where"[^>]*>/g)].map((x) => [/value="(\w+)"/.exec(x[0])[1], x[0].includes('checked=""')]);
    assert.deepEqual(radios, [['book', true], ['series', false]]);
    assert.match(textOf(markup), /Series \(shared\): The Tidewater Books/);
    assert.equal(dialog('pr').includes('name="where"'), false);
  });

  test('the request has where: series only for the series choice, and the type of a new type goes there too', () => {
    const own = m.newEntryRequests(SO, { type: 'character', name: 'A', slug: 'a' });
    assert.equal('where' in own[0].body, false);
    const shared = m.newEntryRequests(SO, { type: 'ship', name: 'A', slug: 'a', where: 'series', newType: { name: 'Ship', fields: [{ label: 'Tonnage', kind: 'number' }, 'Master'] } });
    assert.deepEqual([shared[0].url, shared[0].body.where], [`/api/books/${SO}/codex/types`, 'series']);
    assert.deepEqual([shared[1].url, shared[1].body.where], [`/api/books/${SO}/entries`, 'series']);
    assert.deepEqual(shared[0].body.fields, [{ label: 'Tonnage', kind: 'number' }, 'Master']);
    assert.deepEqual(shared[1].body.fields, [{ label: 'Tonnage', value: '' }, { label: 'Master', value: '' }]);
  });

  test('the new requests: move to series, copy into this book', () => {
    assert.deepEqual(m.moveToSeriesRequest(SO, ILSE), { method: 'POST', url: `/api/books/${SO}/entries/${ILSE}/move-to-series`, body: {} });
    assert.deepEqual(m.copyToBookRequest(LT, ILSE), { method: 'POST', url: `/api/books/${LT}/entries/${ILSE}/copy-to-book`, body: {} });
  });

  test('refusals are put into words: no series, the series has the slug, the copy already exists', () => {
    assert.match(m.explainCodexFailure(400, { code: 'REFUSED_NO_SERIES' }), /not in a series/);
    assert.match(m.explainCodexFailure(409, { code: 'SLUG_TAKEN', message: 'the series tidewater already has an entry with the slug "port-aldine"' }), /^The series tidewater already has an entry with the slug "port-aldine"\. Nothing was changed\.$/);
    assert.match(m.explainCodexFailure(409, { code: 'SLUG_TAKEN', message: 'this book already has an entry, thread or event with the slug "x"' }), /^This book already has/);
    assert.match(m.explainCodexFailure(409, { code: 'SLUG_TAKEN' }), /already used by another entry/);
  });
});

describe('typed fields', () => {
  const vessel = () => d.so.entries.find((e) => e.id === VESSEL);
  const edit = (entry) => html(h(m.EditFieldsDialog, { bookId: SO, entry, entries: d.so.entries, types: d.so.types, labelDefs: null, onClose: noop, onPreview: noop }));

  test('the entry editor draws each field by its declared kind', () => {
    const markup = edit(vessel());
    // one chunk per field row: its label input, then the typed input
    const heads = [...markup.matchAll(/<input[^>]*aria-label="Field label"[^>]*>/g)];
    const row = (label) => {
      const at = heads.findIndex((t) => tagsOf(t[0], /<input[^>]*>/g)[0].value === label);
      return markup.slice(heads[at].index, heads[at + 1]?.index ?? markup.length);
    };
    const field = (label) => [null, /data-kind="(\w+)"/.exec(row(label))[1], /<div class="typed-field"[\s\S]*/.exec(row(label))[0]];
    const kindOf = (label) => field(label)[1];
    assert.deepEqual(['Master', 'Tonnage', 'Launched', 'Home port', 'Rig', 'Cargoes', 'Notes'].map(kindOf), ['text', 'number', 'date', 'link', 'choice', 'list', 'text']);
    assert.deepEqual(tagsOf(field('Tonnage')[2], /<input[^>]*>/g).map((t) => [t.type, t.value]), [['number', '42']]);
    assert.deepEqual(tagsOf(field('Launched')[2], /<input[^>]*>/g).map((t) => [t.type, t.value]), [['date', '1891-04-12']]);
    const rig = field('Rig')[2];
    assert.match(rig, /<select[^>]*>/);
    assert.deepEqual([...rig.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', 'sloop', 'ketch', 'schooner']);
    assert.match(rig, /<option[^>]*value="ketch"[^>]*selected=""|<option[^>]*selected=""[^>]*value="ketch"/);
    assert.match(field('Home port')[2], /Pick…/);
    const cargoes = field('Cargoes')[2];
    assert.deepEqual(tagsOf(cargoes, /<input[^>]*>/g).map((t) => [t['aria-label'], t.value]), [['Cargoes item 1', 'salt'], ['Cargoes item 2', 'tar']]);
    assert.match(cargoes, /Add item/);
  });

  test('a value that does not fit shows the W312 text inline, tied to its input; a value that fits shows none', () => {
    assert.equal(count(edit(vessel()), /data-code="W312"/g), 0);
    const bad = { ...vessel(), fields: { ...vessel().fields, Tonnage: 'heavy', Rig: 'junk' } };
    const markup = edit(bad);
    assert.equal(count(markup, /data-code="W312"/g), 2);
    assert.match(textOf(markup), /Tonnage should be a number value \(W312\)\. You can still save it\./);
    assert.match(textOf(markup), /Rig should be a choice value \(W312\)/);
    const warned = tagsOf(markup, /<input[^>]*aria-label="Value of Tonnage"[^>]*>/g)[0];
    assert.equal(warned['aria-invalid'], 'true');
    const id = warned['aria-describedby'];
    assert.ok(markup.includes(`id="${id}"`), 'aria-describedby points at the warning');
    assert.match(markup, /junk \(not a choice\)<\/option>/);
  });

  test('fitsKind is the validator\'s rule', () => {
    const f = m.fitsKind;
    assert.ok(f('number', 42) && !f('number', '42') && !f('number', 'a lot') && f('number', ''));
    assert.ok(f('date', '1891-04-12') && !f('date', '1891-02-30') && !f('date', '12 April 1891') && !f('date', 18910412));
    assert.ok(f('choice', 'ketch', ['sloop', 'ketch']) && !f('choice', 'yawl', ['sloop', 'ketch']));
    assert.ok(f('link', '[[port-aldine]]') && f('link', '[[low-tide:the-lost-ledger]]') && !f('link', 'port-aldine') && !f('link', '[[a]] and [[b]]'));
    assert.ok(f('list', ['a', 'b']) && f('list', []) && !f('list', 'a, b') && !f('list', [1]));
    assert.ok(f('text', 'x') && f('text', 3) && f('text', true));
    assert.equal(m.w312Text('Tonnage', 'number'), 'Tonnage should be a number value');
  });

  test('what is typed becomes the right value: a number, a list, a text that does not fit stays text', () => {
    assert.equal(m.coerceTyped('number', '44', 42), 44);
    assert.equal(m.coerceTyped('number', 'heavy', 42), 'heavy');
    assert.equal(m.coerceTyped('number', '42', 42), 42);
    assert.deepEqual(m.coerceTyped('list', 'salt\ntar\n\nkelp', ['salt', 'tar']), ['salt', 'tar', 'kelp']);
    assert.deepEqual(m.coerceTyped('list', '', undefined), []);
    assert.equal(m.coerceTyped('date', '1891-04-12', undefined), '1891-04-12');
    assert.equal(m.coerceTyped(undefined, '34', undefined), 34);
  });

  test('the type\'s field lines: a label, or Label | kind | choices', () => {
    assert.deepEqual(m.parseFieldLine('Master'), { field: 'Master' });
    assert.deepEqual(m.parseFieldLine('Tonnage | number'), { field: { label: 'Tonnage', kind: 'number' } });
    assert.deepEqual(m.parseFieldLine('Rig | choice | sloop, ketch'), { field: { label: 'Rig', kind: 'choice', choices: ['sloop', 'ketch'] } });
    assert.deepEqual(m.parseFieldLine('Notes | text'), { field: 'Notes' });
    assert.match(m.parseFieldLine('Rig | choice').error, /needs its choices/);
    assert.match(m.parseFieldLine('Rig | colour').error, /not a field kind/);
    assert.equal(m.fieldLines(['Master', { label: 'Rig', kind: 'choice', choices: ['a', 'b'] }]), 'Master\nRig | choice | a, b');
  });
});

describe('labels', () => {
  test('the label manager lists the book\'s labels and, for a book in a series, the series\' (with the notice)', () => {
    const markup = html(h(m.LabelManager, { bookId: SO, data: d.so.labels, onClose: noop }));
    const t = textOf(markup);
    assert.match(t, /This book/);
    assert.match(t, /Series: The Tidewater Books/);
    assert.match(t, /Changes apply to every book in this series\./);
    assert.equal(count(markup, /<form class="label-section"/g), 2);
    assert.deepEqual(tagsOf(markup, /<input[^>]*aria-label="Name of label \d"[^>]*>/g).map((t) => t.value), ['Draft Two', 'Mystery', 'Backstory']);
    assert.equal(count(html(h(m.LabelManager, { bookId: PR, data: d.pr.labels, onClose: noop })), /<form class="label-section"/g), 1, 'a standalone book has only its own');
  });

  test('every colour gets the contrast check against the dark surface; a colour that is too dark says so and what to do', () => {
    const markup = html(h(m.LabelManager, { bookId: SO, data: d.so.labels, onClose: noop }));
    const checks = [...markup.matchAll(/data-contrast="(\w+)">([^<]*)</g)].map((x) => [x[1], decode(x[2])]);
    assert.equal(checks.length, 3);
    assert.deepEqual(checks.map((c) => c[0]), ['ok', 'ok', 'low'], '#2E7D32, #B5446E ok; #3A5F7D is under 3:1');
    assert.match(checks[2][1], /needs 3:1\. Choose a lighter colour\./);
    assert.match(checks[0][1], /Fine\./);
    // the hex input is tied to its check
    const hex = tagsOf(markup, /<input[^>]*aria-label="Colour of Backstory \(#RRGGBB\)"[^>]*>/g)[0];
    assert.equal(hex['aria-invalid'], 'true');
    assert.ok(markup.includes(`id="${hex['aria-describedby']}"`));
  });

  test('contrast maths: the dark surfaces are the M06 tokens, and the ratio is WCAG\'s', () => {
    const { root } = parseTokens();
    for (const [token, hex] of Object.entries(m.SURFACES)) assert.equal(root[token].toUpperCase(), hex, `${token} in tokens.css`);
    const white = m.labelContrast('#FFFFFF');
    const expected = Math.min(...Object.values(m.SURFACES).map((s) => contrast(rgb('#FFFFFF'), rgb(s))));
    assert.ok(Math.abs(white - expected) < 1e-9);
    assert.ok(m.labelContrast('#000000') < 1.2);
    assert.equal(m.labelContrast('red'), null);
    assert.equal(m.contrastCheck('#B5446E').ok, true);
    assert.equal(m.contrastCheck('#2A2A31').ok, false);
    assert.match(m.contrastCheck('nope').text, /#RRGGBB/);
  });

  test('what blocks saving: an empty or repeated name, a bad colour, a new colour that is too dark; a colour the file already has never blocks', () => {
    const saved = [{ name: 'Backstory', color: '#3A5F7D' }];
    const { labelsProblem } = m;
    assert.equal(labelsProblem([{ name: 'Backstory', color: '#3A5F7D' }], saved), null);
    assert.match(labelsProblem([{ name: ' ', color: '#B5446E' }], saved), /needs a name/);
    assert.match(labelsProblem([{ name: 'A', color: '#B5446E' }, { name: 'a', color: '#C98BDB' }], saved), /listed twice/);
    assert.match(labelsProblem([{ name: 'A', color: 'green' }], saved), /#RRGGBB/);
    assert.match(labelsProblem([{ name: 'Backstory', color: '#222233' }], saved), /too dark/);
    assert.match(labelsProblem([{ name: 'New', color: '#222233' }], saved), /too dark/);
    assert.equal(labelsProblem([{ name: 'New', color: '#C98BDB' }], saved), null);
  });

  test('the Board and the Outline show a scene\'s labels as chips and filter by label', () => {
    const planning = (view, props = {}) => html(h(m.PlanningWorkspace, { book: d.book, planning: d.planning, objects: [], view, render: ({ main }) => main, ...props }));
    for (const view of ['board', 'outline']) {
      const markup = planning(view);
      assert.deepEqual([...markup.matchAll(/data-label="([^"]+)"/g)].map((x) => x[1]).sort(), ['Draft Two', 'Mystery'], `${view} chips`);
      const select = /<select name="label"[\s\S]*?<\/select>/.exec(markup)?.[0] ?? '';
      assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', 'Draft Two', 'Mystery', 'Backstory'], `${view} filter options`);
    }
    // the model carries the labels and the filter works on it
    const model = m.buildModel(d.book, d.planning);
    assert.deepEqual(model.scenes[0].labels, ['Mystery', 'Draft Two']);
    assert.equal(m.outlineRows(model, { label: 'mystery' })[0].chapters[0].scenes.length, 1);
    assert.equal(m.outlineRows(model, { label: 'Backstory' }).length, 0);
    assert.equal(m.outlineRows(model, {})[0].chapters[0].scenes.length, 1);
  });

  test('a label with no definition still shows as a chip, without a colour', () => {
    const markup = html(h(m.LabelChip, { name: 'Stray', defs: [] }));
    assert.match(markup, /data-label="Stray"/);
    assert.doesNotMatch(markup, /--label/);
    assert.match(html(h(m.LabelChip, { name: 'mystery', defs: [{ name: 'Mystery', color: '#B5446E' }] })), /--label:#B5446E/);
  });
});

describe('cross-book links and the link picker', () => {
  test('the picker lists this book\'s targets, then the series\' shared entries, then other books\' written book-slug:slug', () => {
    const groups = m.pickerGroups(d.lt.targets, null, '');
    assert.deepEqual(groups.slice(0, 2).map((g) => g.title), ['This book', 'Series: The Tidewater Books (shared)']);
    assert.ok(groups.slice(2).every((g) => g.title.startsWith('Other book: ')));
    assert.deepEqual(groups[0].items.map((i) => i.ref).sort(), ['port-aldine', 'the-lost-ledger']);
    assert.deepEqual(groups[1].items.map((i) => i.ref), ['ilse-hollis', 'port-aldine']);
    const other = groups.find((g) => g.key === 'book:salt-orchard-2');
    assert.deepEqual(other.items.map((i) => i.ref).sort(), ['salt-orchard-2:gull-and-ledger', 'salt-orchard-2:maren-hollis']);
    assert.deepEqual(m.pickerGroups(d.lt.targets, null, 'ledger').flatMap((g) => g.items.map((i) => i.ref)), ['the-lost-ledger', 'salt-orchard-2:gull-and-ledger']);
    // without targets it is the old picker: the book's objects only
    assert.deepEqual(m.pickerGroups(null, [{ id: 'x', kind: 'entry', slug: 'a', title: 'A' }], '').map((g) => g.items.map((i) => i.ref)), [['a']]);
  });

  test('the picker dialog shows the three groups, each item with the text it inserts', () => {
    const markup = html(h(m.LinkPicker, { objects: null, targets: d.lt.targets, selectedText: '', onPick: noop, onClose: noop }));
    const t = textOf(markup);
    assert.match(t, /This book/);
    assert.match(t, /Series: The Tidewater Books \(shared\)/);
    assert.match(t, /Other book: Salt Orchard Two/);
    assert.match(t, /Maren Hollis Codex · character · salt-orchard-2:maren-hollis/);
    assert.equal(count(markup, /<h3 class="picker-group-title"/g), 4);
  });

  test('a link into another book opens that book on that entry, thread or event', () => {
    const href = (book, entry) => `/books/${book}/codex?entry=${entry}`;
    const cross = (ref, bookId = LT) => m.crossBookTarget(ref, d[bookId === LT ? 'lt' : 'so'].targets, bookId, href);
    assert.deepEqual(cross('salt-orchard-2:maren-hollis'), { href: `/books/${SO}/codex?entry=entry_01W10000000000000000000008`, name: 'Maren Hollis' });
    assert.deepEqual(cross('low-tide:the-lost-ledger', SO), { href: `/books/${LT}?view=threads&thread=the-lost-ledger`, name: 'The lost ledger' });
    assert.deepEqual(cross('tidewater:ilse-hollis'), { href: href(LT, ILSE), name: 'Ilse Hollis' }, 'a series prefix names a shared entry, opened in the book being read');
    assert.equal(cross('nowhere:x'), null);
    assert.equal(cross('salt-orchard-2:nothing'), null);
    assert.equal(cross('plain'), null);
  });

  test('LinkedText makes a cross-book link a real link to the other book', () => {
    const linkOf = (ref) => m.crossBookTarget(ref, d.so.targets, SO, (b, id) => `/books/${b}/codex?entry=${id}`);
    const markup = html(h(m.LinkedText, { text: 'Chased in [[low-tide:the-lost-ledger]] and [[low-tide:nothing]]', bookId: SO, resolve: () => null, linkOf }));
    assert.match(markup, new RegExp(`<a href="/books/${LT}\\?view=threads&amp;thread=the-lost-ledger"[^>]*class="codex-link"[^>]*>The lost ledger</a>`));
    assert.match(markup, /<span class="prose-link" title="low-tide:nothing">low-tide:nothing<\/span>/);
  });

  test('ProseView makes the links it knows real links', () => {
    const markup = html(h(m.ProseView, { source: 'See [[low-tide:the-lost-ledger|the ledger]].', linkOf: () => ({ href: '/books/x' }) }));
    assert.match(markup, /<a href="\/books\/x"[^>]*>the ledger<\/a>/);
    assert.match(html(h(m.ProseView, { source: 'See [[a]].' })), /<span class="prose-link" title="a">a<\/span>/);
  });
});

describe('templates', () => {
  test('the New book dialog lists the library\'s templates after the built-in ones, marked as the author\'s own', () => {
    const markup = html(h(m.NewBookDialog, { templates: d.templates, series: [{ slug: 'tidewater', title: 'The Tidewater Books' }], penNames: [], onClose: noop }));
    const radios = tagsOf(markup, /<input[^>]*type="radio"[^>]*>/g).map((t) => t.value);
    assert.deepEqual(radios, ['blank', 'story-circle', 'heros-journey', 'seven-point', 'library:mystery-arc']);
    assert.match(textOf(markup), /Mystery arc Your template/);
    assert.equal(count(markup, /data-source="library"/g), 1);
    assert.equal(count(markup, /data-source="builtin"/g), 4);
  });

  test('a library template that shares a built-in name is a separate card, said so', () => {
    const shadow = { name: 'blank', title: 'My blank', description: 'Mine.', beats: [], acts: 1, chapters: 1, scenes: 1, source: 'library', shadows_builtin: true };
    const markup = html(h(m.NewBookDialog, { templates: [...d.templates.slice(0, 4), shadow], onClose: noop }));
    const radios = tagsOf(markup, /<input[^>]*type="radio"[^>]*>/g).map((t) => t.value);
    assert.deepEqual(radios, ['blank', 'story-circle', 'heros-journey', 'seven-point', 'library:blank']);
    assert.match(textOf(markup), /Your template \(same name as a built-in one\)/);
    assert.equal(m.templateValue(shadow), 'library:blank');
  });

  test('Save as template…: a dialog with the title, the name (filled from the title) and the description', () => {
    const markup = html(h(m.SaveAsTemplateDialog, { bookId: SO, bookTitle: 'Salt Orchard Two', onClose: noop }));
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /<label for="[^"]+">Title<\/label><input[^>]*value="Salt Orchard Two structure"/);
    assert.match(markup, /<label for="[^"]+">Template name<\/label><input[^>]*value="salt-orchard-two-structure"/);
    assert.match(textOf(markup), /Leaves out all story text, entries, receipts and notes\./);
    assert.equal(m.templateNameOf('Mystery: Arc & Clues!'), 'mystery-arc-clues');
  });

  test('the book actions have Labels… and Save as template…', () => {
    const markup = html(h(m.BookActions, { bookId: SO, slug: 'salt-orchard-2', title: 'Salt Orchard Two' }));
    assert.deepEqual([...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((x) => decode(x[1])), ['Export…', 'Back up book…', 'Labels…', 'Save as template…']);
  });
});

describe('problems and preview', () => {
  test('the shared entries\' own problems show in the book\'s problems list with a "Series" badge', () => {
    const items = [...d.diagnostics, { code: 'W312', severity: 'warning', file: 'tidewater/codex/vessels/the-gull.md', location: 'fields.Tonnage', message: 'Tonnage should be a number value', scope: 'series', series: 'tidewater' }];
    const markup = html(h(m.DiagnosticList, { items }));
    assert.equal(count(markup, /class="series-badge"/g), 1);
    const row = /<li class="diag diag-warning">(?:(?!<\/li>)[\s\S])*the-gull[\s\S]*?<\/li>/.exec(markup)[0];
    assert.match(row, /W312 warning<\/strong><span class="series-badge"[^>]*>Series<\/span>/);
    assert.equal(html(h(m.DiagnosticList, { items: d.diagnostics })).includes('series-badge'), false);
  });

  test('the preview says first "Changes apply to every book in this series." and lists the warnings the change will show', () => {
    const preview = { title: 'Copy Ilse into this book', changes: [{ from: null, to: 'tidewater/low-tide/codex/characters/ilse-hollis.md' }], notice: m.SHARED_NOTICE, warnings: ['W309: this entry shadows the series entry ilse-hollis'] };
    const markup = html(h(m.PreviewDialog, { preview, busy: false, onApply: noop, onCancel: noop }));
    assert.match(textOf(markup), /Changes apply to every book in this series\./);
    assert.match(textOf(markup), /W309: this entry shadows the series entry ilse-hollis/);
    assert.ok(markup.indexOf('Changes apply') < markup.indexOf('preview-files'), 'the notice comes before the files');
    assert.equal(html(h(m.PreviewDialog, { preview: { title: 'x', changes: [] }, busy: false, onApply: noop, onCancel: noop })).includes('shared-notice'), false);
  });
});
