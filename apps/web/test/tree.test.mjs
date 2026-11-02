// M03-J01 acceptance 10: the manuscript tree (statuses with text labels, POV chips, word counts, collapse
// toggles, Archived section with Restore), row menus as real buttons, and the Preview dialog (file list + diffs).
// Server-rendered with renderToStaticMarkup (no browser, no network), like new-book.test.mjs.
//
// The contract names behaviour, not modules or props, so every .jsx under apps/web/src is loaded and the
// units are looked up by likely export names (LOCATE). A missing unit fails with "implementation missing: ...".
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { contrast, lightness, parseTokens, rgb } from './color.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(webDir, 'src');

function jsxFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsxFiles(full));
    else if (e.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

const LOCATE = {
  Tree: ['ManuscriptTree', 'Outline', 'OutlineTree', 'Tree'],
  Preview: ['PreviewDialog', 'ChangePreview', 'ChangesPreview', 'StructurePreview', 'Preview'],
};

let vite;
const exportsAll = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const file of jsxFiles(srcDir)) {
    const url = `/${relative(webDir, file).split('\\').join('/')}`;
    try {
      const mod = await vite.ssrLoadModule(url);
      for (const [k, v] of Object.entries(mod)) if (!(k in exportsAll)) exportsAll[k] = v;
    } catch {
      /* a module that cannot load in SSR is not one of ours */
    }
  }
});
after(async () => {
  await vite?.close();
});

function unit(kind) {
  for (const name of LOCATE[kind]) if (exportsAll[name] !== undefined) return exportsAll[name];
  assert.fail(`implementation missing: no export named one of ${LOCATE[kind].join(' | ')} under apps/web/src`);
}

const render = (el) => renderToStaticMarkup(el);
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plainText = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const noop = () => {};

// ---------------------------------------------------------------- fixture: the shape /api/books/:id returns

const BOOK_ID = 'book_01S5000000000000000000000A';
const scene = (id, title, extra = {}) => ({
  id, title, position: 1, act: 1, chapter: 1, sequence: 10, status: 'drafting', pov: null, word_count: 10, path: `manuscript/${id}.md`, ...extra,
});
const S_OUTLINE = scene('scene_a', 'Arrival', { status: 'outline', pov: 'maren-hollis', word_count: 41 });
const S_DRAFTING = scene('scene_b', 'The Key', { status: 'drafting', pov: 'pell', word_count: 24 });
const S_REVISED = scene('scene_c', '', { chapter: 2, status: 'revised', pov: null, word_count: 7 });
const S_FINAL = scene('scene_d', 'Wall', { act: 2, chapter: 3, status: 'final', pov: 'ilse-hollis', word_count: 123 });
const S_BROKEN = scene('scene_e', 'Broken', { act: 2, chapter: 3, status: null, word_count: 0, problem: { code: 'E101', message: 'bad front matter' } });
const BOOK = {
  id: BOOK_ID,
  slug: 'salt-orchard',
  title: 'The Salt Orchard',
  path: '',
  status: 'drafting',
  scene_count: 5,
  word_count: 195,
  acts: [
    {
      act: 1,
      label: 'Act 1',
      title: 'Low Water',
      chapters: [
        { chapter: 1, label: 'Chapter One', title: 'The Drowned Rows', scenes: [S_OUTLINE, S_DRAFTING] },
        { chapter: 2, label: 'Chapter Two', title: null, scenes: [S_REVISED] },
      ],
    },
    { act: 2, label: 'Act 2', title: 'High Water', chapters: [{ chapter: 3, label: 'Chapter Three', title: 'The Wall', scenes: [S_FINAL, S_BROKEN] }] },
  ],
  excluded: [
    { id: 'scene_x', path: 'archive/manuscript/act-01-low-water/ch-002-the-grafting/0030-the-cut-scene.md', reason: 'archived' },
    { id: 'scene_y', path: 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key-alt.md', reason: 'variant' },
  ],
};

/** The tree gets the book plus every plausible callback; unknown props are ignored by React components. */
function tree(extra = {}) {
  const Tree = unit('Tree');
  return decode(
    render(
      h(Tree, {
        book: BOOK, bookId: BOOK_ID, activeId: 'scene_b', selectedId: 'scene_b', sceneId: 'scene_b', archived: BOOK.excluded.filter((e) => e.reason === 'archived'),
        onAction: noop, onRestore: noop, onOpen: noop, onSelect: noop, ...extra,
      }),
    ),
  );
}

/** The smallest <li> that contains `needle`. */
function rowOf(html, needle) {
  const at = html.indexOf(needle);
  assert.ok(at >= 0, `"${needle}" is rendered`);
  const start = html.lastIndexOf('<li', at);
  const end = html.indexOf('</li>', at);
  assert.ok(start >= 0 && end > at, `"${needle}" sits in a list item`);
  return html.slice(start, end + 5);
}
const skeleton = (html) => html.replace(/>[^<]*</g, '><').replace(/href="[^"]*"/g, '').replace(/\bid="[^"]*"/g, '').replace(/aria-label="[^"]*"/g, '');
const buttons = (html) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], inner: m[2], name: (/aria-label="([^"]*)"/.exec(m[1])?.[1] ?? plainText(m[2])) }));

// ---------------------------------------------------------------- the tree

test('tree: every act, chapter and scene is listed in order, with act / chapter labels and titles', () => {
  const html = tree();
  const order = ['Act 1', 'Low Water', 'Chapter One', 'The Drowned Rows', 'Arrival', 'The Key', 'Chapter Two', 'Act 2', 'High Water', 'Chapter Three', 'The Wall', 'Wall', 'Broken'];
  let at = -1;
  for (const s of order) {
    const i = html.indexOf(s, at + 1);
    assert.ok(i > at, `"${s}" appears after the previous item`);
    at = i;
  }
});

test('tree: a scene with no title reads "Untitled scene"', () => {
  assert.match(plainText(rowOf(tree(), 'Untitled scene')), /Untitled scene/);
});

test('tree: each scene shows its status as a text label, and the four statuses look different (not hue only, not text only)', () => {
  const html = tree();
  const rows = {
    outline: rowOf(html, 'Arrival'),
    drafting: rowOf(html, 'The Key'),
    revised: rowOf(html, 'Untitled scene'),
    final: rowOf(html, '>Wall<'),
  };
  for (const [status, row] of Object.entries(rows)) {
    const t = plainText(row).toLowerCase();
    assert.match(t, new RegExp(`\\b${status}\\b`), `${status} row has the word "${status}" (text label for screen readers)`);
    for (const other of Object.keys(rows).filter((s) => s !== status)) assert.doesNotMatch(t, new RegExp(`\\b${other}\\b`), `${status} row does not say "${other}"`);
  }
  const shapes = Object.values(rows).map(skeleton);
  assert.equal(new Set(shapes).size, 4, 'each status has its own dot markup (class / data attribute)');
});

test('status dots: the four statuses differ in lightness by clear steps (not hue only) and each is visible on the dark surfaces', () => {
  const css = readFileSync(join(srcDir, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const { root } = parseTokens();
  const resolve = (v) => {
    const name = /^var\((--[\w-]+)\)$/.exec(v.trim())?.[1];
    const hex = name ? root[name] : v.trim();
    assert.match(hex ?? '', /^#[0-9A-Fa-f]{6}$/, `cannot resolve colour "${v}"`);
    return rgb(hex);
  };
  const rule = (selector) => {
    const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((r) => r[1].split(',').some((x) => x.trim().replace(/"/g, "'") === selector));
    assert.ok(m.length > 0, `styles.css has a rule for ${selector}`);
    return Object.assign({}, ...m.map((r) => Object.fromEntries([...r[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]))));
  };
  const base = rule('.status-dot');
  const mark = {};
  for (const status of ['outline', 'drafting', 'revised', 'final']) {
    const own = status === 'outline' ? {} : rule(`.status-dot[data-status='${status}']`);
    const d = { ...base, ...own };
    const colour = status === 'outline' ? d['border-color'] ?? d.border.split(' ').at(-1) : d.background ?? d['background-color'];
    mark[status] = resolve(String(colour).replace(/^.*(var\([^)]+\)|#[0-9A-Fa-f]{6}).*$/, '$1'));
  }
  const L = Object.fromEntries(Object.entries(mark).map(([k, v]) => [k, lightness(v)]));
  const names = Object.keys(L);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) assert.ok(Math.abs(L[names[i]] - L[names[j]]) >= 5, `${names[i]} (L*=${L[names[i]].toFixed(1)}) and ${names[j]} (L*=${L[names[j]].toFixed(1)}) are at least 5 lightness steps apart`);
  }
  for (const status of names) for (const surface of ['--bg', '--surface']) assert.ok(contrast(mark[status], rgb(root[surface])) >= 3, `${status} dot has 3:1 contrast on ${surface}`);
});

test('tree: POV shows as an initial chip, only for scenes that have a POV', () => {
  const html = tree();
  assert.match(rowOf(html, 'Arrival'), />M</, 'maren-hollis -> M');
  assert.match(rowOf(html, 'The Key'), />P</, 'pell -> P');
  assert.match(rowOf(html, '>Wall<'), />I</, 'ilse-hollis -> I');
  assert.doesNotMatch(rowOf(html, 'Untitled scene'), />[A-Z]</, 'no POV, no chip');
});

test('tree: scenes show their word counts; chapters show total words and scene count; acts show total words', () => {
  const html = tree();
  const num = (n) => new RegExp(`(?<!\\d)${n}(?!\\d)`); // "41w" counts: the unit letter sticks to the number
  assert.match(plainText(rowOf(html, 'Arrival')), num(41));
  assert.match(plainText(rowOf(html, 'The Key')), num(24));
  assert.match(plainText(rowOf(html, '>Wall<')), num(123));
  // chapter and act rows are not <li>s of their own (they hold the nested list), so look at the row element itself
  const rowText = (label) => {
    const i = html.indexOf(label);
    const end = html.indexOf('<ul', i);
    return plainText(html.slice(i, end > -1 ? end : undefined));
  };
  const ch1 = rowText('Chapter One');
  assert.match(ch1, num(65), `chapter one total words (41 + 24): ${ch1}`);
  assert.match(ch1, /(?<![\d,])2 scenes/, `chapter one scene count: ${ch1}`);
  const ch3 = rowText('Chapter Three');
  assert.match(ch3, num(123), `chapter three total words: ${ch3}`);
  assert.match(ch3, /(?<![\d,])2 scenes/, `chapter three scene count: ${ch3}`);
  const act1 = rowText('Act 1');
  assert.match(act1, num(72), `act one total words (41 + 24 + 7): ${act1}`);
  assert.match(rowText('Act 2'), num(123));
});

test('tree: the selected scene is marked (aria-current) and only that one', () => {
  const html = tree();
  assert.equal((html.match(/aria-current="/g) ?? []).length, 1);
  assert.match(rowOf(html, 'The Key'), /aria-current="/);
});

test('tree: a scene whose file cannot be read carries the "can\'t be read" marker', () => {
  const html = tree();
  assert.match(plainText(rowOf(html, 'Broken')), /can't be read/);
  assert.doesNotMatch(plainText(rowOf(html, 'Arrival')), /can't be read/);
});

test('tree: scenes are links that open the scene; the tree is plain lists, not an ARIA tree widget', () => {
  const html = tree();
  assert.match(rowOf(html, 'The Key'), /<a [^>]*href="[^"]*scene=scene_b/);
  assert.doesNotMatch(html, /role="tree(item)?"/);
});

test('tree: acts and chapters each have a real collapse toggle button (expanded by default)', () => {
  const html = tree();
  const toggles = buttons(html).filter((b) => /aria-expanded="true"/.test(b.attrs));
  assert.ok(toggles.length >= 5, `at least 2 acts + 3 chapters have expanded toggles, found ${toggles.length}`);
  for (const b of toggles) assert.match(b.attrs, /type="button"/);
  assert.ok(toggles.some((b) => /Act 1/.test(b.name) || /Act 1/.test(b.inner)), 'the Act 1 toggle names its act');
  assert.ok(toggles.some((b) => /Chapter One/.test(b.name) || /Chapter One/.test(b.inner)), 'the Chapter One toggle names its chapter');
});

test('tree: renders with no localStorage and no window (collapse memory is optional)', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.doesNotThrow(() => tree());
});

// ---------------------------------------------------------------- Archived section

test('tree: an Archived section lists archived scenes (not variants), each with a Restore button, collapsed by default', () => {
  const html = tree();
  const at = html.search(/Archived/);
  assert.ok(at >= 0, 'an "Archived" heading exists');
  const section = html.slice(at);
  assert.match(plainText(section), /the cut scene/i, 'archived scene is listed by name (from its file name; the API gives only id/path/reason)');
  assert.doesNotMatch(plainText(section), /key alt/i, 'a variant is not archived');
  const restore = buttons(section).filter((b) => /^Restore\b/i.test(plainText(b.inner)) || /^Restore\b/i.test(b.name));
  assert.equal(restore.length, 1, `one Restore button per archived scene, got ${restore.length}`);
  assert.match(restore[0].attrs, /type="button"/);
  // collapsed by default: a <details> without `open`, or a toggle with aria-expanded="false" and a hidden list
  const details = /<details\b([^>]*)>(?:(?!<\/details>)[\s\S])*Archived/.exec(html);
  const toggle = buttons(html).find((b) => /Archived/.test(plainText(b.inner)) && /aria-expanded=/.test(b.attrs));
  const closedDetails = details && !/\bopen\b/.test(details[1]);
  const closedToggle = toggle && /aria-expanded="false"/.test(toggle.attrs) && /<ul\b[^>]*\bhidden\b[^>]*>(?:(?!<\/ul>)[\s\S])*Restore/.test(html);
  assert.ok(closedDetails || closedToggle, 'the Archived section is closed (and its list hidden) until the author opens it');
});

test('tree: with nothing archived there is no Restore button', () => {
  const html = tree({ book: { ...BOOK, excluded: [] }, archived: [] });
  assert.equal(buttons(html).filter((b) => /^Restore\b/i.test(plainText(b.inner))).length, 0);
});

// ---------------------------------------------------------------- row menus

test('tree: every act, chapter and scene row has a real "More actions for <name>" button, closed by default', () => {
  const html = tree();
  const more = buttons(html).filter((b) => /^More actions for /.test(b.name));
  assert.ok(more.length >= 10, `2 acts + 3 chapters + 5 scenes = 10 menu buttons, found ${more.length}`);
  for (const b of more) {
    assert.match(b.attrs, /type="button"/, b.name);
    assert.match(b.attrs, /aria-haspopup/, `${b.name} announces a popup`);
    assert.match(b.attrs, /aria-expanded="false"/, `${b.name} is closed`);
  }
  const names = more.map((b) => b.name);
  assert.ok(names.includes('More actions for Arrival'), `scene menu is named for the scene: ${names}`);
  assert.ok(names.some((n) => /More actions for .*Chapter One/.test(n) || /More actions for .*Drowned Rows/.test(n)));
  assert.ok(names.some((n) => /More actions for .*Act 1/.test(n) || /More actions for .*Low Water/.test(n)));
  assert.equal(new Set(names).size, names.length, 'each menu button has a unique accessible name');
  assert.doesNotMatch(html, /role="menu"/, 'no menu is open on first render');
});

test('tree: a scene row is not a nest of interactive elements (menu button is a sibling of the scene link, not inside it)', () => {
  const row = rowOf(tree(), 'Arrival');
  const link = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(row);
  assert.ok(link, 'scene link');
  assert.doesNotMatch(link[0], /<button\b/, 'no <button> inside the link');
});

// ---------------------------------------------------------------- Preview dialog

const CHANGES = [
  {
    from: 'manuscript/act-01/ch-001/0020-the-key.md',
    to: 'manuscript/act-01/ch-001/0020-the-key.md',
    before_sha256: 'a'.repeat(64),
    after_sha256: 'b'.repeat(64),
    diff: '--- a/manuscript/act-01/ch-001/0020-the-key.md\n+++ b/manuscript/act-01/ch-001/0020-the-key.md\n@@ -3,3 +3,3 @@\n id: scene_b\n-title: The Key\n+title: The Brass Key\n act: 1\n',
  },
  {
    from: 'manuscript/act-01/ch-001/0010-arrival.md',
    to: 'archive/manuscript/act-01/ch-001/0010-arrival.md',
    before_sha256: 'c'.repeat(64),
    after_sha256: 'd'.repeat(64),
    diff: '',
  },
  {
    from: null,
    to: 'manuscript/act-02/ch-004-aftermath/chapter.md',
    before_sha256: null,
    after_sha256: 'e'.repeat(64),
    diff: '--- /dev/null\n+++ b/manuscript/act-02/ch-004-aftermath/chapter.md\n@@ -0,0 +1,4 @@\n+---\n+schema: storyforge.chapter/v1\n+title: Aftermath\n+---\n',
  },
];

function preview(over = {}, { busy = false } = {}) {
  const Preview = unit('Preview');
  const p = { title: 'Rename scene', changes: CHANGES, notes: [], error: null, extraAction: null, ...over };
  return decode(render(h(Preview, { preview: p, busy, onApply: noop, onCancel: noop })));
}

test('Preview dialog: an accessible modal that lists every file the change would touch', () => {
  const html = preview();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="[^"]+"/, 'has an accessible name');
  assert.match(html, /<h2>Rename scene<\/h2>/, 'and a visible heading');
  for (const f of ['0020-the-key.md', '0010-arrival.md', 'ch-004-aftermath/chapter.md']) assert.ok(html.includes(f), `${f} is listed`);
  assert.match(plainText(html), /3 files would change/);
  assert.match(plainText(html), /Nothing is written until you press Apply/);
});

test('Preview dialog: says what happens to each file (edited / archived / created) in words', () => {
  const t = plainText(preview());
  assert.match(t, /\bEdit\b.*0020-the-key\.md/);
  assert.match(t, /\bArchive\b.*0010-arrival\.md/);
  assert.match(t, /\bNew file\b.*chapter\.md/);
});

test('Preview dialog: a moved file shows both where it was and where it goes', () => {
  const html = preview();
  assert.ok(html.includes('manuscript/act-01/ch-001/0010-arrival.md -&gt; archive/manuscript/act-01/ch-001/0010-arrival.md') || /manuscript\/act-01\/ch-001\/0010-arrival\.md[^<]*archive\/manuscript\/act-01\/ch-001\/0010-arrival\.md/.test(html));
});

test('Preview dialog: diffs show removed and added lines with their - / + markers (not colour alone) in a monospace block', () => {
  const html = preview();
  assert.match(html, /<pre\b[^>]*>/, 'diff is in a <pre>');
  assert.match(html, /-title: The Key/, 'removed line keeps its "-"');
  assert.match(html, /\+title: The Brass Key/, 'added line keeps its "+"');
  assert.match(html, /@@ -3,3 \+3,3 @@/, 'hunk header shown');
  const pre = /<pre\b[^>]*aria-label="([^"]*)"/.exec(html);
  assert.ok(pre, 'each diff block has an accessible name');
  assert.match(pre[1], /0020-the-key\.md/);
});

test('Preview dialog: a change with no text diff (a pure move) has no empty diff block', () => {
  const only = [CHANGES[1]];
  const html = preview({ changes: only });
  assert.doesNotMatch(html, /<pre\b/);
  assert.match(plainText(html), /1 file would change/);
});

test('Preview dialog: very long diffs are cut with a visible "more lines" note, not dropped silently', () => {
  const long = { ...CHANGES[0], diff: `@@ -1,300 +1,300 @@\n${Array.from({ length: 300 }, (_, i) => `+line ${i}`).join('\n')}\n` };
  const html = preview({ changes: [long] });
  assert.match(plainText(html), /\d+ more lines/);
  assert.ok(html.includes('+line 0'));
  assert.ok(!html.includes('+line 299'));
});

test('Preview dialog: diff text is escaped (a "<script>" in a title is shown, never run)', () => {
  const evil = [{ from: 'a.md', to: 'a.md', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64), diff: '@@ -1 +1 @@\n-title: x\n+title: <script>alert(1)</script>\n' }];
  const raw = render(h(unit('Preview'), { preview: { title: 'x', changes: evil }, onApply: noop, onCancel: noop }));
  assert.doesNotMatch(raw, /<script>alert/);
  assert.match(raw, /&lt;script&gt;/);
  const rawPath = render(h(unit('Preview'), { preview: { title: '<b>t</b>', changes: [{ ...evil[0], to: '<img src=x>.md', from: '<img src=x>.md' }] }, onApply: noop, onCancel: noop }));
  assert.doesNotMatch(rawPath, /<img src=x>/);
  assert.doesNotMatch(rawPath, /<b>t<\/b>/);
});

test('Preview dialog: Apply and Cancel are real buttons; Apply is enabled when there is something to apply', () => {
  const bs = buttons(preview());
  const apply = bs.find((b) => /^apply\b/i.test(plainText(b.inner)));
  const cancel = bs.find((b) => /^cancel\b/i.test(plainText(b.inner)));
  assert.ok(apply, `an Apply button exists: ${bs.map((b) => b.name)}`);
  assert.ok(cancel, 'a Cancel button exists');
  assert.match(apply.attrs, /type="button"/);
  assert.match(cancel.attrs, /type="button"/);
  assert.doesNotMatch(apply.attrs, /\bdisabled\b/);
  assert.doesNotMatch(cancel.attrs, /\bdisabled\b/);
});

test('Preview dialog: Apply is disabled while a request is in flight', () => {
  const apply = buttons(preview({}, { busy: true })).find((b) => /^apply\b/i.test(plainText(b.inner)));
  assert.match(apply.attrs, /\bdisabled\b/);
});

test('Preview dialog: with nothing to change it says so and Apply is disabled', () => {
  const html = preview({ changes: [] });
  assert.match(plainText(html), /nothing would change/i);
  const apply = buttons(html).find((b) => /^apply\b/i.test(plainText(b.inner)));
  assert.ok(!apply || /\bdisabled\b/.test(apply.attrs), 'Apply cannot be pressed');
});

test('Preview dialog: a refused plan shows the reason as an alert and Apply is disabled', () => {
  const reason = 'There is no free chapter number there. Renumber the chapters first.';
  const html = preview({ changes: [], error: reason });
  assert.match(html, /role="alert"/);
  assert.ok(plainText(html).includes(reason));
  const apply = buttons(html).find((b) => /^apply\b/i.test(plainText(b.inner)));
  assert.ok(!apply || /\bdisabled\b/.test(apply.attrs), 'cannot apply a refused plan');
});

test('Preview dialog: NO_CHAPTER_GAP offers a "Renumber chapters" button next to Cancel', () => {
  const html = preview({ changes: [], error: 'No gap.', extraAction: { label: 'Renumber chapters...', run: noop } });
  const names = buttons(html).map((b) => plainText(b.inner));
  assert.ok(names.some((n) => /^renumber chapters/i.test(n)), names.join(' | '));
});

test('Preview dialog: lists what a merge does not copy over (characters / plot threads of the second scene)', () => {
  const html = preview({ notes: [{ heading: 'These fields of the second scene are not merged. Copy them by hand if you want them:', items: ['characters: pell', 'plot_threads: brass-key'] }] });
  const t = plainText(html);
  assert.match(t, /not merged/);
  assert.match(t, /characters: pell/);
  assert.match(t, /plot_threads: brass-key/);
});
