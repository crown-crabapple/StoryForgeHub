// M08-J04 section 1 and 2, the parts of the responsive layout that live in the stylesheets: drawers, phone fallbacks, 44 px targets, 16 px fields, reduced motion for the
// drawers, and "no horizontal page scroll at 360 px". Read from the CSS files; no browser (the coordinator checks 375 and 768 px in a real one).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const read = (f) => readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// the order the app loads them in (main.jsx): later files win on equal specificity
const FILES = ['theme/tokens.css', 'theme/base.css', 'styles.css', 'insights/insights.css', 'responsive.css'];

/** Every top-level and @media-nested rule: { media, selector, body }. */
function rules(css) {
  const out = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head.replace(/\s+/g, ' '));
      else if (!head.startsWith('@')) out.push({ media, selector: head.replace(/\s+/g, ' '), body });
      i = j;
    }
  };
  walk(css, null);
  return out;
}
const ALL = FILES.flatMap((f) => rules(read(f)));
const RESP = rules(read('responsive.css'));
const selectorsOf = (r) => r.selector.split(',').map((s) => s.trim());
const maxWidth = (r) => Number(/\(max-width:\s*(\d+)px\)/.exec(r.media ?? '')?.[1] ?? Infinity);
const find = (list, selector, max) => list.find((r) => selectorsOf(r).includes(selector) && maxWidth(r) === max);
const decl = (r, prop) => new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(r?.body ?? '')?.[1]?.trim();

// ---------------------------------------------------------------- the three classes exist

test('breakpoints: a rule set exists for tablet (1199), the 900 px fold and phone (767)', () => {
  for (const w of [1199, 899, 767]) assert.ok(RESP.some((r) => maxWidth(r) === w), `responsive.css has @media (max-width: ${w}px)`);
});

test('desktop: nothing in responsive.css applies at 1200 px or wider except the hidden defaults (the reference look is unchanged)', () => {
  const plain = RESP.filter((r) => r.media === null);
  const allowed = ['.workspace-bar', '.inspector-toggle', '.drawer-scrim', '.matrix-list, .tl-phone-note', 'button.drawer-scrim', '.offline-bar p', '@keyframes'];
  for (const r of plain) assert.ok(allowed.some((a) => r.selector.startsWith(a)) || /^(from|to)$/.test(r.selector), `${r.selector} applies on desktop`);
  for (const r of plain.filter((x) => /^\.(workspace-bar|inspector-toggle|drawer-scrim|matrix-list)/.test(x.selector))) assert.match(r.body, /display:\s*none/, `${r.selector} is hidden on desktop`);
});

// ---------------------------------------------------------------- drawers

test('drawers: the inspector is an off-canvas fixed panel below 1200 px, hidden (not just moved) until opened', () => {
  const closed = find(RESP, '.inspector', 1199);
  assert.ok(closed, 'an .inspector rule at max-width 1199px');
  assert.match(closed.body, /position:\s*fixed/);
  assert.match(closed.body, /transform:\s*translateX\(100%\)/);
  assert.match(closed.body, /visibility:\s*hidden/, 'a closed drawer is out of the tab order and the accessibility tree');
  assert.match(decl(closed, 'width'), /^min\(\d+px,\s*\d+vw\)$/, 'never wider than the window');
  const open = find(RESP, ".inspector[data-open='true']", 1199);
  assert.match(open.body, /visibility:\s*visible/);
  assert.match(open.body, /transform:\s*none/);
});

test('drawers: the rail is an off-canvas fixed panel below 900 px when open, and the existing rule still hides it when closed', () => {
  const open = find(RESP, ".rail[data-open='true']", 899);
  assert.match(open.body, /position:\s*fixed/);
  assert.match(decl(open, 'width'), /^min\(\d+px,\s*\d+vw\)$/);
  assert.match(find(ALL, ".rail[data-open='false']", 899).body, /display:\s*none/);
});

test('drawers: the buttons that open them are shown where the panels are drawers (Details from 1199, Chapters from 899), as flex children of the bar', () => {
  assert.match(find(RESP, '.workspace-bar', 1199).body, /display:\s*flex/);
  assert.match(find(RESP, '.inspector-toggle', 1199).body, /display:\s*inline-flex/);
  assert.match(find(ALL, '.rail-toggle', 899).body, /display:\s*inline-flex/);
});

test('drawers: below 900 px the workspace is one column with only the bar and the text in the grid (the drawers are out of flow)', () => {
  const grid = find(RESP, '.workspace', 899);
  assert.match(grid.body, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(grid.body, /'toggle'\s*'main'/);
});

test('drawers: a scrim sits under an open drawer and over the page', () => {
  const scrim = find(RESP, '.drawer-scrim', 1199);
  assert.match(scrim.body, /position:\s*fixed/);
  const z = (r) => Number(decl(r, 'z-index'));
  assert.ok(z(scrim) < z(find(RESP, '.inspector', 1199)), 'the scrim is below the drawer');
  assert.ok(z(scrim) > 1, 'and above the page');
});

test('split editor and pinned panel: below 900 px the inspector (where the pinned sections live) is not in the page, only behind its button (a tab switch with the text)', () => {
  assert.ok(find(RESP, '.inspector', 1199), 'a drawer at 1199 covers 899 and below');
  assert.ok(find(ALL, '.panel-separator', 899), 'the resize separators are gone below 900 px');
  assert.match(find(ALL, '.panel-separator', 899).body, /display:\s*none/);
  assert.match(find(ALL, ".panel-separator[data-panel='inspector']", 1199).body, /display:\s*none/);
});

// ---------------------------------------------------------------- reduced motion for the drawers

test('reduced motion: drawer motion only exists for people who have not asked for less, and the reduce block names every selector that moves', () => {
  const moving = RESP.filter((r) => /(^|;|\s)(transition|animation)(-[a-z]+)?:/.test(r.body) && !/: reduce\)/.test(r.media ?? ''));
  assert.ok(moving.length >= 2, 'the test finds the drawer motion');
  for (const r of moving) assert.match(r.media ?? '', /prefers-reduced-motion: no-preference/, `${r.selector} moves outside no-preference`);
  const reduce = RESP.filter((r) => /prefers-reduced-motion: reduce/.test(r.media ?? ''));
  const named = new Set(reduce.flatMap(selectorsOf));
  for (const r of moving) for (const sel of selectorsOf(r)) assert.ok(named.has(sel), `${sel} moves and is not named in the reduce block`);
  for (const r of reduce) {
    assert.match(r.body, /transition:\s*none/);
    assert.match(r.body, /animation:\s*none/);
  }
  // and the app-wide universal rule of M06-J03 is still there
  const universal = rules(read('styles.css')).find((r) => /prefers-reduced-motion: reduce/.test(r.media ?? '') && selectorsOf(r).includes('*'));
  assert.match(universal.body, /transition:\s*none\s*!important/);
});

// ---------------------------------------------------------------- phone

const PHONE = (selector) => find(RESP, selector, 767);
const phoneRules = RESP.filter((r) => maxWidth(r) === 767);

test('phone: Board, Matrix and Timeline swap the 2D canvas for a list', () => {
  assert.match(PHONE('.board-columns').body, /flex-direction:\s*column/, 'the Board columns stack');
  assert.match(PHONE('.matrix-wrap').body, /display:\s*none/, 'the matrix table is hidden');
  assert.match(PHONE('.matrix-list').body, /display:\s*block/, 'and its list is shown');
  assert.match(PHONE('.tl-svg').body, /display:\s*none/, 'the timeline plot is hidden (its list of events and its table stay)');
  assert.match(PHONE('.tl-phone-note').body, /display:\s*block/);
  // on larger screens the list forms are hidden
  assert.match(RESP.find((r) => r.media === null && selectorsOf(r).includes('.matrix-list')).body, /display:\s*none/);
});

test('phone: touch targets of at least 44 px for buttons, links in the navigation, selects and text fields', () => {
  const rule = phoneRules.find((r) => /min-height:\s*44px/.test(r.body));
  assert.ok(rule, 'a phone rule with min-height: 44px');
  for (const need of ['button', '.btn', 'select', '.project-tab', '.topbar-link', '.switcher-button', '.row-button', '.btn-small', '[role=\'menuitem\']']) assert.ok(rule.selector.includes(need), `${need} is a 44 px target`);
  assert.match(rule.body, /min-height:\s*44px\s*!important/, 'stronger than the smaller min-heights set on single controls');
  const width = phoneRules.find((r) => /min-width:\s*44px/.test(r.body));
  assert.ok(width && width.selector.includes('.row-button') && width.selector.includes('.rail-toggle'), 'icon-only buttons are 44 px wide too');
  assert.ok(phoneRules.some((r) => /label:has\(> input\[type='checkbox'\]\)/.test(r.selector) && /min-height:\s*44px/.test(r.body)), 'a checkbox or radio is a 44 px target through its label');
  // the one rule that sets a smaller min-height on a control (menu buttons, status toggle) is overridden by it: nothing under 44 px is left without !important
  const small = ALL.filter((r) => maxWidth(r) === Infinity && /(^|;|\s)min-height:\s*(\d+)px/.test(r.body) && Number(decl(r, 'min-height')?.replace('px', '')) < 44 && /^\.(btn|row-button|topbar-button|status-toggle|switcher-button)/.test(r.selector));
  for (const r of small) assert.ok(rule.selector.includes(r.selector.split(' ')[0].split(':')[0]), `${r.selector} sets a small min-height and the phone rule covers it`);
});

test('phone: every field is 16 px, so iOS does not zoom; the editor text follows the typography setting but never goes below 16 px', () => {
  const field = phoneRules.find((r) => /font-size:\s*16px\s*!important/.test(r.body) && r.selector.includes('input') && r.selector.includes('textarea') && r.selector.includes('select'));
  assert.ok(field, 'input, select and textarea at 16px');
  const editor = phoneRules.find((r) => r.selector.includes('.cm-content'));
  assert.match(editor.body, /font-size:\s*max\(16px,\s*var\(--fs-prose\)\)/);
});

test('phone: the page margins shrink and the paper uses the space', () => {
  assert.match(decl(PHONE('.paper'), '--paper-pad') ?? '', /^16px$/);
  assert.match(decl(PHONE('.topbar'), 'padding-left') ?? '', /var\(--s3\)/);
});

// ---------------------------------------------------------------- no horizontal overflow at 360 px

/**
 * THE RULE (documented in docs/accessibility.md): a rule must not force the page wider than a 360 px window. A declaration is a risk when, outside any phone media query, it
 *   - sets `width`, `min-width` or `flex-basis` to a fixed length wider than 360 px (anything inside min(), max(), clamp() or calc(100vw ...) can shrink, so it is fine), or
 *   - sets `grid-template-columns` to fixed tracks (px lengths, or the minimum of minmax(), outside auto-fill / auto-fit) that add up to more than 360 px,
 * unless the same selector has a rule inside a max-width media query of 767 px or more that replaces that property, or the rule scrolls inside its own box (overflow auto / scroll),
 * or the element is a fixed overlay sized by the window. Things that cannot be seen here (long unbroken words, images with a width attribute) are the browser check's job.
 */
function overflowRisks(list) {
  const risks = [];
  const px = (v) => [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  const replaced = (r, prop) => list.some((o) => o !== r && selectorsOf(o).some((s) => selectorsOf(r).includes(s)) && o.media !== null && maxWidth(o) >= 767 && maxWidth(o) < Infinity && new RegExp(`(?:^|;|\\s)${prop}\\s*:`).test(o.body));
  for (const r of list) {
    if (r.media !== null && maxWidth(r) <= 767) continue;
    if (/overflow(-x)?:\s*(auto|scroll)/.test(r.body)) continue;
    for (const [, prop, value] of r.body.matchAll(/(?:^|;|\s)(width|min-width|flex-basis)\s*:\s*([^;]+)/g)) {
      const v = value.trim();
      if (/\b(min|max|clamp|calc)\(/.test(v)) continue;
      if (px(v).some((n) => n > 360) && !replaced(r, prop)) risks.push(`${r.media ?? ''} ${r.selector} { ${prop}: ${v} }`);
    }
    for (const [, value] of r.body.matchAll(/(?:^|;|\s)grid-template-columns\s*:\s*([^;]+)/g)) {
      const v = value.trim();
      if (/auto-fill|auto-fit/.test(v)) continue;
      // the smallest each track can be: a px length, the first argument of minmax(), or 0 for fr / auto / minmax(0, ...)
      const tracks = [...v.matchAll(/minmax\(\s*([^,]+),[^)]*\)|(\d+(?:\.\d+)?px)/g)].map((t) => (t[1] ?? t[2]).trim()).map((t) => (/px$/.test(t) ? parseFloat(t) : 0));
      const gaps = 0;
      if (tracks.reduce((a, b) => a + b, 0) + gaps > 360 && !replaced(r, 'grid-template-columns')) risks.push(`${r.media ?? ''} ${r.selector} { grid-template-columns: ${v} }`);
    }
  }
  return risks;
}

test('overflow at 360 px: no rule forces a width wider than the window without a smaller-screen override', () => {
  assert.deepEqual(overflowRisks(ALL), []);
});

test('overflow at 360 px: the rule test catches what it is for', () => {
  const bad = rules('.a { width: 480px; } .b { min-width: 400px; } .c { grid-template-columns: 200px 200px; } .d { width: min(480px, 100%); } .e { width: 480px; overflow-x: auto; }');
  assert.equal(overflowRisks(bad).length, 3);
  const fixed = rules('.a { width: 480px; } @media (max-width: 899px) { .a { width: 100%; } } .c { grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); }');
  assert.deepEqual(overflowRisks(fixed), []);
  const overridden = rules('.a { grid-template-columns: minmax(200px, 260px) minmax(260px, 380px) minmax(0, 1fr); }');
  assert.equal(overflowRisks(overridden).length, 1, 'two minimums of 200 and 260 are wider than 360');
});

test('overflow at 360 px: wide content scrolls inside its own box instead of widening the page (tables, code, the matrix)', () => {
  for (const sel of ['.matrix-wrap', '.board-columns']) assert.ok(ALL.some((r) => selectorsOf(r).includes(sel) && /overflow(-x)?:\s*(auto|scroll)/.test(r.body)), `${sel} scrolls inside itself`);
  assert.ok(phoneRules.some((r) => r.selector.includes('.pref-table') && /overflow-x:\s*auto/.test(r.body)));
  // the dialogs are at most the window wide (a11y-styles.test.mjs checks the min() form); on phones the cap is the viewport itself
  assert.ok(phoneRules.some((r) => r.selector.includes('.dialog') && /max-width:\s*100vw/.test(r.body)));
});
