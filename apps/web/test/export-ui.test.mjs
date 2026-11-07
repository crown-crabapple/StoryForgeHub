// M05-J03 acceptance 9: the Export dialog (format radios, scene titles, status checkboxes, PDF page size), the
// Back up book action (provenance checkbox, unchecked, one-line explanation) and the Restore from backup dialog
// (file picker + folder name). Server-rendered with renderToStaticMarkup (no browser, no network), like
// new-book.test.mjs.
//
// The contract names behaviour, not modules or props, so the components are looked up by likely locations and export
// names (LOCATE below) and are given every plausible spelling of each prop. A missing unit fails with
// "implementation missing: ..." rather than skipping. NAMES THAT NEED ALIGNING WITH THE IMPLEMENTATION: ExportDialog,
// BackupDialog (or the backup option inside ExportDialog), RestoreDialog / RestoreBackupDialog.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

const DIRS = ['/src', '/src/export', '/src/backup', '/src/library', '/src/shell', '/src/dialogs', '/src/books', '/src/library/dialogs'];
const NAMES = ['ExportDialog', 'ExportBookDialog', 'BackupDialog', 'BackupBookDialog', 'RestoreDialog', 'RestoreBackupDialog', 'RestoreFromBackupDialog', 'ExportBackup', 'ExportMenu', 'BackupAndExport', 'ExportDialogs'];
const MODULES = ['/src/LibraryView.jsx', '/src/BookView.jsx', '/src/library/LibraryPage.jsx', '/src/library/StartFlows.jsx', ...NAMES.flatMap((n) => DIRS.map((d) => `${d}/${n}.jsx`))];
const LOCATE = {
  Export: ['ExportDialog', 'ExportBookDialog', 'ExportBook'],
  Backup: ['BackupDialog', 'BackupBookDialog', 'BackupBook'],
  Restore: ['RestoreDialog', 'RestoreBackupDialog', 'RestoreFromBackupDialog', 'RestoreBook'],
  Page: ['LibraryPage'],
};

let vite;
let exportsAll = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of MODULES) {
    try {
      exportsAll = { ...exportsAll, ...(await vite.ssrLoadModule(p)) };
    } catch {
      /* module does not exist (yet) */
    }
  }
});
after(async () => {
  await vite?.close();
});

function find(kind) {
  for (const name of LOCATE[kind]) if (exportsAll[name] !== undefined) return exportsAll[name];
  return undefined;
}
function unit(kind) {
  const u = find(kind);
  if (u === undefined) assert.fail(`implementation missing: no export named one of ${LOCATE[kind].join(' | ')} under apps/web/src (${DIRS.join(', ')})`);
  return u;
}

const render = (el) => renderToStaticMarkup(el);
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plainText = (html) => text(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) ?? []).length;
const noop = () => {};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STATUSES = ['idea', 'outline', 'drafting', 'revised', 'final'];
/** The shape of GET /api/books/:id: acts -> chapters -> scenes, each scene with its status. The dialog offers the statuses in use. */
const detail = (statuses) => ({
  id: 'book_01S5000000000000000000000A',
  slug: 'salt-orchard',
  title: 'The Salt Orchard',
  statuses,
  scene_statuses: statuses,
  acts: [{ act: 1, title: 'Low Water', chapters: [{ chapter: 1, label: 'Chapter One', title: 'The Drowned Rows', scenes: statuses.map((status, i) => ({ id: 'scene_' + i, title: 'Scene ' + i, status })) }] }],
});
const BOOK = detail(STATUSES);

function exportDialog(extra = {}) {
  const Dialog = unit('Export');
  return render(
    h(Dialog, {
      book: BOOK,
      bookId: BOOK.id,
      slug: BOOK.slug,
      title: BOOK.title,
      statuses: STATUSES,
      bookStatuses: STATUSES,
      sceneStatuses: STATUSES,
      onClose: noop,
      onCancel: noop,
      onExport: noop,
      ...extra,
    }),
  );
}
/** The backup option may be its own dialog or part of the export dialog; returns the markup that holds it. */
function backupHtml(extra = {}) {
  const Backup = find('Backup');
  if (Backup) return render(h(Backup, { book: BOOK, bookId: BOOK.id, slug: BOOK.slug, title: BOOK.title, onClose: noop, onCancel: noop, onBackup: noop, ...extra }));
  return exportDialog(extra);
}
function restoreDialog(extra = {}) {
  const Dialog = unit('Restore');
  return render(h(Dialog, { onClose: noop, onCancel: noop, onRestore: noop, onRestored: noop, onDone: noop, ...extra }));
}

/** All <label> elements as { text, control } where control is the form control the label points at (wrapped or for=). */
function labelled(html) {
  const out = [];
  for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const forId = /\bfor="([^"]+)"/.exec(m[1])?.[1];
    let el;
    if (forId) el = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].find((c) => new RegExp(`\\bid="${escRe(forId)}"`).test(c[2]));
    else el = /<(input|select|textarea)\b([^>]*)>/.exec(m[2]);
    out.push({ text: plainText(m[2]), tag: el?.[1], attrs: el?.[2] ?? '', html: el?.[0] ?? '' });
  }
  return out;
}
const attr = (attrs, name) => new RegExp(`\\b${name}(?:="([^"]*)")?`).exec(attrs)?.[1];
const hasAttr = (attrs, name) => new RegExp(`\\b${name}\\b`).test(attrs);
const buttons = (html) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((b) => ({ attrs: b[1], label: plainText(b[2]) }));

// ---------------------------------------------------------------- Export dialog

test('Export dialog: an accessible modal named Export with an Export button and a Cancel button that never submits', () => {
  const html = exportDialog();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="[^"]*export[^"]*"/i);
  const bs = buttons(html);
  const exp = bs.find((b) => /^export\b/i.test(b.label));
  const cancel = bs.find((b) => /^(cancel|close)$/i.test(b.label));
  assert.ok(exp, `an Export button; buttons: ${bs.map((b) => b.label)}`);
  assert.ok(cancel, 'a Cancel (or Close) button');
  assert.match(cancel.attrs, /type="button"/, 'Cancel never submits');
  assert.equal(count(html, /<a\b/g), 0, 'no stray links');
});

test('Export dialog: Markdown, Word, EPUB and PDF radios in one group, exactly one preselected, each with its format value', () => {
  const html = exportDialog();
  const radios = [...html.matchAll(/<input\b([^>]*type="radio"[^>]*)>/g)].map((m) => m[1]);
  const formatRadios = radios.filter((r) => /markdown|docx|epub|pdf|word|md/i.test(attr(r, 'value') ?? ''));
  assert.equal(formatRadios.length, 4, `four format radios; radios: ${radios.map((r) => attr(r, 'value'))}`);
  assert.equal(new Set(formatRadios.map((r) => attr(r, 'name'))).size, 1, 'one radio group');
  const values = formatRadios.map((r) => (attr(r, 'value') ?? '').toLowerCase());
  for (const want of [/^(markdown|md)$/, /^(docx|word)$/, /^epub$/, /^pdf$/]) assert.ok(values.some((v) => want.test(v)), `a value matching ${want}: ${values}`);
  assert.equal(count(formatRadios.join('\n'), /\bchecked\b/g), 1, 'exactly one is preselected');
  const labels = labelled(html).filter((l) => l.tag === 'input' && /radio/.test(l.attrs)).map((l) => l.text);
  for (const want of ['Markdown', 'Word', 'EPUB', 'PDF']) assert.ok(labels.some((t) => t.startsWith(want)), `radio labelled ${want}; labels: ${labels}`);
});

test('Export dialog: "Include scene titles" is a checkbox, unchecked by default', () => {
  const html = exportDialog();
  const l = labelled(html).find((x) => /include scene titles/i.test(x.text));
  assert.ok(l, `a label "Include scene titles"; labels: ${labelled(html).map((x) => x.text)}`);
  assert.equal(l.tag, 'input');
  assert.match(l.attrs, /type="checkbox"/);
  assert.ok(!hasAttr(l.attrs, 'checked'), 'default off (scenes are separated by a scene break)');
});

test('Export dialog: "Leave out scenes with status..." offers one unchecked checkbox per status of the book', () => {
  const html = exportDialog();
  const plain = plainText(html);
  assert.match(plain, /Leave out scenes with status/i);
  const boxes = labelled(html).filter((l) => l.tag === 'input' && /type="checkbox"/.test(l.attrs) && STATUSES.some((s) => l.text.toLowerCase() === s));
  assert.deepEqual(boxes.map((b) => b.text.toLowerCase()).sort(), [...STATUSES].sort(), 'one checkbox per status');
  for (const b of boxes) assert.ok(!hasAttr(b.attrs, 'checked'), `${b.text} unchecked by default`);
  // they are grouped under the heading for assistive technology
  assert.match(html, /<(fieldset|div|ul)\b[^>]*(role="group"|aria-labelledby)|<fieldset\b/, 'the status boxes are a labelled group');
});

test('Export dialog: a book with no scenes still renders (it falls back to the standard statuses), never a crash', () => {
  const html = exportDialog({ statuses: [], bookStatuses: [], sceneStatuses: [], book: { ...detail([]), acts: [] } });
  assert.match(html, /role="dialog"/);
});

test('Export dialog: a page size choice for PDF offers Letter and A4', () => {
  const html = exportDialog();
  const plain = plainText(html);
  assert.match(plain, /Letter/);
  assert.match(plain, /A4/);
  const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].filter((s) => /letter/i.test(s[2]) && /a4/i.test(s[2]));
  const radios = [...html.matchAll(/<input\b([^>]*type="radio"[^>]*)>/g)].filter((r) => /^(letter|a4)$/i.test(attr(r[1], 'value') ?? ''));
  assert.ok(selects.length === 1 || radios.length === 2, 'a select with both sizes, or two radios');
  if (selects.length) assert.equal(count(selects[0][2], /<option\b/g), 2);
  assert.match(plain, /PDF/);
});

test('Export dialog: every control has an accessible name and is keyboard reachable (no tabindex=-1, no div buttons)', () => {
  const html = exportDialog();
  for (const l of labelled(html)) assert.ok(l.text.length > 0, 'label text present');
  const unlabelled = [...html.matchAll(/<input\b([^>]*)>/g)].filter((m) => !/type="hidden"/.test(m[1])).filter((m) => {
    const id = attr(m[1], 'id');
    const wrapped = labelled(html).some((l) => l.html === m[0]);
    return !wrapped && !(attr(m[1], 'aria-label') || attr(m[1], 'aria-labelledby')) && !(id && new RegExp(`for="${escRe(id)}"`).test(html));
  });
  assert.equal(unlabelled.length, 0, `inputs without a label: ${unlabelled.map((m) => m[0])}`);
  assert.doesNotMatch(html, /tabindex="-1"[^>]*type="(radio|checkbox)"/);
  assert.doesNotMatch(html, /<div\b[^>]*role="button"/);
});

// ---------------------------------------------------------------- Back up book

test('Back up: an action reachable from the book view ("Back up book...") exists as a component', () => {
  const html = backupHtml();
  assert.match(plainText(html), /back ?up/i);
  const bs = buttons(html);
  assert.ok(bs.some((b) => /^(back up|download backup|backup)\b/i.test(b.label)), `a Back up button; buttons: ${bs.map((b) => b.label)}`);
});

test('Back up: "Include receipts (provenance)" is a checkbox, UNCHECKED, with a one-line explanation', () => {
  const html = backupHtml();
  const l = labelled(html).find((x) => /include receipts/i.test(x.text));
  assert.ok(l, `a label "Include receipts"; labels: ${labelled(html).map((x) => x.text)}`);
  assert.match(l.text, /provenance/i);
  assert.equal(l.tag, 'input');
  assert.match(l.attrs, /type="checkbox"/);
  assert.ok(!hasAttr(l.attrs, 'checked'), 'provenance is opt-in');
  // a short explanation sits next to it: a described-by paragraph, or text in the label's own block
  const described = attr(l.attrs, 'aria-describedby');
  const plain = plainText(html);
  const explained = (described && new RegExp(`id="${escRe(described)}"`).test(html)) || /receipt[^.]*\b(record|history|log|AI|prompt|provenance|generated)/i.test(plain) || /\b(not included|left out|excluded|only if)\b/i.test(plain);
  assert.ok(explained, `a one-line explanation of what receipts are; text: ${plain.slice(0, 400)}`);
});

// ---------------------------------------------------------------- Restore dialog and library entry

test('Restore dialog: an accessible modal with a zip file picker, a folder name field, Restore and Cancel', () => {
  const html = restoreDialog();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="[^"]*restore[^"]*"/i);
  const file = [...html.matchAll(/<input\b([^>]*type="file"[^>]*)>/g)][0];
  assert.ok(file, 'a file input');
  assert.match(attr(file[1], 'accept') ?? '', /\.zip|application\/zip/, 'accepts zip files');
  assert.ok(!hasAttr(file[1], 'multiple'), 'one backup at a time');
  const labels = labelled(html);
  assert.ok(labels.some((l) => /backup|file|zip/i.test(l.text) && /type="file"/.test(l.attrs)), `the file picker is labelled; labels: ${labels.map((l) => l.text)}`);
  const folder = labels.find((l) => /folder/i.test(l.text) && l.tag === 'input' && !/type="file"/.test(l.attrs));
  assert.ok(folder, `a "Folder name" field; labels: ${labels.map((l) => l.text)}`);
  assert.ok(!hasAttr(folder.attrs, 'readonly') && !hasAttr(folder.attrs, 'disabled'), 'folder name is editable');
  const maxlength = attr(folder.attrs, 'maxlength');
  if (maxlength !== undefined) assert.ok(Number(maxlength) <= 60, 'at most 60 characters');
  const bs = buttons(html);
  const restore = bs.find((b) => /^restore\b/i.test(b.label));
  const cancel = bs.find((b) => /^(cancel|close)$/i.test(b.label));
  assert.ok(restore, `a Restore button; buttons: ${bs.map((b) => b.label)}`);
  assert.ok(cancel, 'a Cancel button');
  assert.match(cancel.attrs, /type="button"/);
});

test('Restore dialog: no alert region while there is no error', () => {
  assert.doesNotMatch(restoreDialog(), /role="alert"/);
  assert.match(restoreDialog(), /<form[ >]/);
});

test('Library screen: offers "Restore from backup..." as a real button', () => {
  const Page = unit('Page');
  const html = text(render(h(Page, { books: [{ id: 'b', title: 'Book', slug: 'book', status: 'drafting', scene_count: 1, word_count: 10, error_count: 0, warning_count: 0 }], error: null, loading: false })));
  const b = buttons(html).find((x) => /^restore from backup/i.test(x.label));
  assert.ok(b, `a "Restore from backup..." button; buttons: ${buttons(html).map((x) => x.label)}`);
  assert.match(b.attrs, /type="button"/);
});

test('Library screen: the Restore action is also there for an empty library', () => {
  const Page = unit('Page');
  const html = text(render(h(Page, { books: [], error: null, loading: false })));
  assert.ok(buttons(html).some((x) => /^restore from backup/i.test(x.label)));
});

test('planningExportUrl is the book-relative planning export route', async () => {
  const { planningExportUrl, PLANNING_EXPORT_HINT } = await import('../src/export/requests.js');
  assert.equal(planningExportUrl('book-1'), '/api/books/book-1/export/planning');
  assert.equal(planningExportUrl('a b/c'), '/api/books/a%20b%2Fc/export/planning');
  assert.match(PLANNING_EXPORT_HINT, /Not part of the manuscript\.$/);
});
