// M05-J03 acceptance 3: structure of each format, checked with independent readers (zip central directory, strict XML
// tag balance, PDF xref). Also the Markdown shape from contract 1.2 and inline emphasis.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { exportBook } from '../src/index.mjs';
import { ORDER, cleanup, checkXml, copyBook, docxParagraphs, editScene, parsePdf, phrasesFor, readEpub, readZip, htmlText, orderProblems, decodeEntities } from './helpers.mjs';

after(cleanup);

// ---------------------------------------------------------------- Markdown

test('markdown: title, chapter headings, scene breaks, LF only, UTF-8 without BOM, one trailing newline', async () => {
  const { bytes } = await exportBook(copyBook(), 'markdown', {});
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no BOM');
  const t = bytes.toString('utf8');
  assert.ok(!t.includes('\r'), 'LF line endings');
  assert.ok(t.endsWith('\n') && !t.endsWith('\n\n'), 'ends with exactly one newline');
  assert.ok(!t.includes('\ufffd'), 'valid UTF-8');
  assert.ok(t.startsWith('# The Salt Orchard\n'), JSON.stringify(t.slice(0, 40)));
  const lines = t.split('\n');
  const heads = ['## Prologue: Before the Tide', '## Chapter One: The Drowned Rows', '## Chapter Two: The Grafting'].map((h) => lines.indexOf(h));
  assert.ok(heads.every((i) => i >= 0), `chapter headings present: ${heads}`);
  assert.ok(heads[0] < heads[1] && heads[1] < heads[2]);
  assert.equal(lines.filter((l) => l === '* * *').length, 3, 'one scene break between the scenes of each chapter with two scenes');
  assert.ok(t.includes('\n\n* * *\n\n'), 'scenes joined with a blank-line-delimited break');
});

test('markdown: *em*, _em_ and **strong** are kept as Markdown', async () => {
  const root = copyBook();
  editScene(root, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md', (t) => t.replace('Past the dunes', 'She was *slow*, _quiet_ and **loud** in turn. Past the dunes'));
  const t = (await exportBook(root, 'markdown', {})).bytes.toString('utf8');
  assert.match(t, /She was \*slow\*, _quiet_ and \*\*loud\*\* in turn\./);
});

// ---------------------------------------------------------------- DOCX

const DOCX_PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml'];

test('docx: required parts present, every part is well-formed XML, relationships and content types cover the parts', async () => {
  const { bytes } = await exportBook(copyBook(), 'docx', {});
  const z = readZip(bytes);
  const names = z.entries.map((e) => e.name);
  for (const p of DOCX_PARTS) assert.ok(names.includes(p), `part ${p}`);
  assert.equal(new Set(names).size, names.length, 'no duplicate entries');
  for (const e of z.entries) {
    if (/\.(xml|rels)$/.test(e.name)) assert.deepEqual(checkXml(e.data.toString('utf8')), [], `${e.name} well-formed`);
  }
  const get = (n) => z.entries.find((e) => e.name === n).data.toString('utf8');
  assert.match(get('[Content_Types].xml'), /\/word\/document\.xml/);
  assert.match(get('_rels/.rels'), /word\/document\.xml/);
  assert.match(get('_rels/.rels'), /docProps\/core\.xml/);
  assert.match(get('word/_rels/document.xml.rels'), /styles\.xml/);
  assert.match(get('docProps/core.xml'), /<dc:title>The Salt Orchard<\/dc:title>/);
});

/** Style definitions of word/styles.xml by id, plus the document defaults. */
function readStyles(z) {
  const xml = z.entries.find((e) => e.name === 'word/styles.xml').data.toString('utf8');
  const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(xml)?.[0] ?? '';
  const styles = new Map([...xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[\s\S]*?<\/w:style>/g)].map((m) => [m[1], m[0]]));
  return { xml, defaults, styles };
}

test('docx: styles - Normal is 12 pt Times-like serif double spaced with a first-line indent; Heading1 exists', async () => {
  const { defaults, styles } = readStyles(readZip((await exportBook(copyBook(), 'docx', {})).bytes));
  const normal = styles.get('Normal');
  assert.ok(normal, 'Normal style');
  const effective = defaults + normal; // what a paragraph in the Normal style inherits
  assert.match(effective, /<w:sz w:val="24"\s*\/>/, '12 pt = 24 half-points');
  assert.match(effective, /w:ascii="(Times New Roman|Georgia|Cambria|Garamond|Palatino[^"]*|Liberation Serif|Book Antiqua)"/, 'serif font');
  assert.match(effective, /<w:spacing\b[^>]*w:line="480"/, 'double spaced');
  assert.match(effective, /<w:ind\b[^>]*w:firstLine="\d+"/, 'first-line indent');
  assert.ok(styles.has('Heading1'));
});


test('docx: one Heading1 per chapter, each chapter starts on a new page, scene breaks are centred "* * *"', async () => {
  const z = readZip((await exportBook(copyBook(), 'docx', {})).bytes);
  const doc = z.entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const { styles } = readStyles(z);
  const paras = docxParagraphs(doc);
  const styleOf = (p) => /<w:pStyle w:val="([^"]+)"/.exec(p.xml)?.[1] ?? 'Normal';
  const h1 = paras.filter((p) => styleOf(p) === 'Heading1');
  const h1text = h1.map((p) => p.text).join(' | ');
  for (const t of ['Before the Tide', 'The Drowned Rows', 'The Grafting']) assert.ok(h1text.includes(t), 'Heading1 for ' + t + ': ' + h1text);
  assert.ok(h1.length >= 4, 'at least one Heading1 per chapter (4 chapters): ' + h1text);

  // does a paragraph start a new page? explicit paragraph property wins over the style; w:val="0"/"false" switches it off
  const startsPage = (p) => {
    const own = /<w:pageBreakBefore\b([^>]*)\/>/.exec(p.xml);
    if (own) return !/w:val="(0|false|off)"/.test(own[1]);
    if (/<w:br\b[^>]*w:type="page"/.test(p.xml)) return true;
    const st = styles.get(styleOf(p)) ?? '';
    return /<w:pageBreakBefore\s*\/>/.test(st);
  };
  paras.forEach((p, i) => {
    if (styleOf(p) !== 'Heading1') return;
    const prev = paras[i - 1];
    assert.ok(startsPage(p) || (prev && startsPage(prev) && styleOf(prev) !== 'Normal'), 'chapter "' + p.text + '" starts a page itself or directly follows a part page');
  });

  const sceneBreaks = paras.filter((p) => p.text.trim() === '* * *');
  assert.equal(sceneBreaks.length, 3);
  for (const p of sceneBreaks) {
    const centred = /<w:jc w:val="center"\s*\/>/.test(p.xml) || /<w:jc w:val="center"\s*\/>/.test(styles.get(styleOf(p)) ?? '');
    assert.ok(centred, 'scene break is centred (paragraph or its style)');
  }
  const body = paras.find((p) => p.text.startsWith('The key was colder'));
  assert.ok(body, 'body paragraph found');
  assert.ok(!/Heading/.test(styleOf(body)));
});


test('docx: *em* / _em_ become italic runs and **strong** a bold run; the markers are gone', async () => {
  const root = copyBook();
  editScene(root, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md', (t) => t.replace('Past the dunes', 'She was *slow*, _quiet_ and **loud** in turn. Past the dunes'));
  const z = readZip((await exportBook(root, 'docx', {})).bytes);
  const doc = z.entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const runs = [...doc.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].map((m) => ({ xml: m[1], text: decodeEntities([...m[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join('')) }));
  const run = (txt) => runs.find((r) => r.text === txt);
  assert.match(run('slow')?.xml ?? '', /<w:i\b/, 'slow is italic');
  assert.match(run('quiet')?.xml ?? '', /<w:i\b/, 'quiet is italic');
  assert.match(run('loud')?.xml ?? '', /<w:b\b/, 'loud is bold');
  assert.ok(!/<w:b\b/.test(run('slow')?.xml ?? '') && !/<w:i\b/.test(run('loud')?.xml ?? ''), 'no cross-contamination');
  const text = docxParagraphs(doc).map((p) => p.text).join('\n');
  assert.ok(text.includes('She was slow, quiet and loud in turn.'), 'markers removed');
});

// ---------------------------------------------------------------- EPUB

test('epub: mimetype first and stored, container/opf/nav references valid, all XML well-formed, spine in chapter order', async () => {
  const { bytes } = await exportBook(copyBook(), 'epub', {});
  const ep = readEpub(bytes);
  const first = ep.zip.entries[0];
  assert.equal(first.name, 'mimetype', 'mimetype is the first entry');
  assert.equal(first.method, 0, 'mimetype is stored, not deflated');
  assert.equal(first.localOffset, 0);
  assert.equal(first.data.toString('latin1'), 'application/epub+zip');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.subarray(30, 38).toString('latin1'), 'mimetype', 'mimetype name is at the front of the file');
  assert.equal(bytes.readUInt16LE(28), 0, 'no extra field before the mimetype data (readers sniff the bytes)');

  for (const e of ep.zip.entries) {
    if (/\.(xml|opf|xhtml|ncx)$/.test(e.name)) assert.deepEqual(checkXml(e.data.toString('utf8')), [], `${e.name} well-formed`);
  }
  assert.equal(ep.opfPath, 'OEBPS/content.opf');
  assert.ok(ep.byName.has('OEBPS/content.opf'));
  assert.ok(ep.byName.has('OEBPS/nav.xhtml'));
  assert.match(ep.container, /media-type="application\/oebps-package\+xml"/);

  assert.match(ep.opf, /<package\b[^>]*version="3\.0"/);
  assert.match(ep.opf, /<dc:identifier[^>]*>[^<]*book_01S5000000000000000000000A[^<]*<\/dc:identifier>/);
  assert.match(ep.opf, /<dc:title[^>]*>The Salt Orchard<\/dc:title>/);
  assert.match(ep.opf, /<dc:language[^>]*>en<\/dc:language>/);
  assert.match(ep.opf, /<meta[^>]*property="dcterms:modified"[^>]*>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);

  for (const [id, item] of ep.manifest) assert.ok(ep.byName.has(item.path), `manifest item ${id} -> ${item.href} exists`);
  const nav = [...ep.manifest.values()].find((m) => /\bnav\b/.test(m.properties));
  assert.ok(nav, 'a manifest item with properties="nav"');
  assert.equal(nav.path, 'OEBPS/nav.xhtml');
  assert.ok(ep.manifest.size >= 5, 'nav, css, four chapters at least');
  assert.ok([...ep.manifest.values()].some((m) => m.type === 'text/css'), 'a small CSS');

  const chapters = ep.spine.filter((p) => p !== nav.path);
  assert.ok(chapters.length >= 4, `one XHTML per chapter: ${chapters}`);
  assert.ok(chapters.every((p) => ep.byName.has(p)), 'spine targets exist');
  // the spine reads the book in order: each chapter file holds its scenes, and later chapters hold later scenes
  const perFile = chapters.map((p) => htmlText(ep.byName.get(p).data.toString('utf8')));
  assert.deepEqual(orderProblems(perFile.join('\n'), phrasesFor(ORDER)), []);
  const ownerOf = (phrase) => perFile.findIndex((t) => t.replace(/\s+/g, ' ').includes(phrase));
  const owners = phrasesFor(ORDER).map(ownerOf);
  assert.ok(owners.every((o) => o >= 0));
  assert.deepEqual(owners, [...owners].sort((a, b) => a - b), 'chapter files follow scene order');
  assert.deepEqual([...new Set(owners)].length, 4, 'four chapter files hold the scenes');
  // chapter titles and the nav list the chapters in the same order
  const navText = htmlText(ep.byName.get(nav.path).data.toString('utf8')).replace(/\s+/g, ' ');
  assert.deepEqual(orderProblems(navText, ['Before the Tide', 'The Drowned Rows', 'The Grafting']), []);
  // every nav link points at a file of the package
  for (const m of ep.byName.get(nav.path).data.toString('utf8').matchAll(/<a\b[^>]*href="([^"#]+)/g)) {
    assert.ok(ep.byName.has('OEBPS/' + decodeEntities(m[1])), `nav link ${m[1]} resolves`);
  }
});

test('epub: *em* and **strong** become <em> and <strong>', async () => {
  const root = copyBook();
  editScene(root, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md', (t) => t.replace('Past the dunes', 'She was *slow* and **loud**. Past the dunes'));
  const ep = readEpub((await exportBook(root, 'epub', {})).bytes);
  const html = ep.spine.map((p) => ep.byName.get(p).data.toString('utf8')).join('\n');
  assert.match(html, /<em>slow<\/em>/);
  assert.match(html, /<strong>loud<\/strong>/);
});

// ---------------------------------------------------------------- PDF

test('pdf: header, xref offsets, trailer, pages, a footer number on every page, standard fonts only', async () => {
  const { bytes } = await exportBook(copyBook(), 'pdf', {});
  const pdf = parsePdf(bytes);
  assert.deepEqual(pdf.problems, []);
  assert.ok(pdf.objectCount > 5);
  assert.ok(pdf.pages.length > 1, `page count ${pdf.pages.length}`);
  assert.ok(pdf.pages.length >= 5, 'a title page and a new page for each of four chapters');
  pdf.pages.forEach((p, i) => {
    assert.deepEqual(p.mediaBox.map(Math.round), [0, 0, 612, 792], `page ${i + 1} is US Letter`);
    const footer = p.lines.find((l) => l.trim().length <= 8 && l.replace(/\D/g, '') === String(i + 1) && /^\D*\d+\D*$/.test(l));
    assert.ok(footer !== undefined, `page ${i + 1} has a footer number; last strings: ${JSON.stringify(p.lines.slice(-3))}`);
  });
  assert.ok(pdf.fonts.has('Times-Roman'), [...pdf.fonts].join());
  for (const f of pdf.fonts) assert.match(f, /^Times-(Roman|Italic|Bold|BoldItalic)$/, 'only standard-14 Times');
  assert.ok(pdf.winAnsi, 'WinAnsiEncoding');
  assert.ok(!pdf.embedsFont, 'no font embedding');
  assert.ok(pdf.fonts.has('Times-Italic') && pdf.fonts.has('Times-Bold'), 'italic and bold fonts are available');
});

test('pdf: the title page carries the title, and the content is exactly the phrases of the included scenes', async () => {
  const pdf = parsePdf((await exportBook(copyBook(), 'pdf', {})).bytes);
  assert.ok(pdf.pages[0].lines.join(' ').includes('The Salt Orchard'), JSON.stringify(pdf.pages[0].lines));
  assert.deepEqual(orderProblems(pdf.text, phrasesFor(ORDER)), []);
});

// Times-Roman advance widths (AFM, 1/1000 em) for the characters the fixture uses; anything else counts 500.
const TIMES = { ' ': 250, ',': 250, '.': 250, '-': 333, "'": 333, '!': 333, '?': 444, ';': 278, ':': 278, '(': 333, ')': 333, '[': 333, ']': 333, '@': 921, '*': 500, '_': 500, '': 1000, '': 500, '': 444, '': 444, '': 333, '': 333 };
'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, k) => { TIMES[c] = [444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444][k]; });
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, k) => { TIMES[c] = [722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611][k]; });
const width12 = (line) => [...line].reduce((w, c) => w + (TIMES[c] ?? 500), 0) * 12 / 1000;

test('pdf: body lines are 12 pt Times on a 24 pt leading, inside the 1 inch margins, none wider than the 6.5 in text block', async () => {
  const pdf = parsePdf((await exportBook(copyBook(), 'pdf', {})).bytes);
  let checked = 0;
  for (const [pi, page] of pdf.pages.entries()) {
    const body = page.blocks.filter((b) => b.size === 12 && b.text.trim() !== '');
    for (const b of body) {
      assert.ok(b.x >= 72 - 0.01, 'page ' + (pi + 1) + ': left margin, x=' + b.x + ' for ' + JSON.stringify(b.text));
      assert.ok(b.y >= 72 - 0.01 && b.y <= 720, 'page ' + (pi + 1) + ': inside the top and bottom margins, y=' + b.y);
      assert.ok(b.x + width12(b.text) <= 540 + 0.5, 'page ' + (pi + 1) + ': right margin: ' + JSON.stringify(b.text) + ' ends at ' + (b.x + width12(b.text)).toFixed(1));
      checked++;
    }
    const ys = body.map((b) => b.y);
    for (let k = 1; k < ys.length; k++) {
      const d = ys[k - 1] - ys[k];
      assert.ok(d > 0 && Math.abs(d / 24 - Math.round(d / 24)) < 1e-6, 'page ' + (pi + 1) + ': 24 pt leading, got ' + d);
    }
  }
  assert.ok(checked >= 10, 'enough body lines to be meaningful (' + checked + ')');
  const widths = pdf.pages.flatMap((p) => p.blocks.filter((b) => b.size === 12 && b.text.length > 40).map((b) => b.x + width12(b.text) - 72));
  assert.ok(Math.max(...widths) > 380, 'lines are filled, not wrapped far too early');
});
