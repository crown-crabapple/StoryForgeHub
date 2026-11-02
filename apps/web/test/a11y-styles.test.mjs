// M06-J03 section 2, the parts of accessibility that live in the stylesheet: focus rings, reduced motion, the narrow layouts and dialogs that fit 768 px.
// (Colour pairs are in contrast.test.mjs; names, labels and landmarks are in a11y-audit.test.mjs.) Read from the CSS files; no browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const read = (f) => readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = `${read('theme/tokens.css')}\n${read('theme/base.css')}\n${read('styles.css')}`;

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
const RULES = rules(CSS);
const REDUCE = /^@media \(prefers-reduced-motion: reduce\)$/;
const NO_PREF = /^@media \(prefers-reduced-motion: no-preference\)$/;
const selectorsOf = (r) => r.selector.split(',').map((s) => s.trim());

// ---------------------------------------------------------------- focus

test('focus: a visible ring on :focus-visible for everything, drawn with the --focus token', () => {
  const ring = RULES.find((r) => r.selector === ':focus-visible');
  assert.ok(ring, 'a global :focus-visible rule');
  assert.match(ring.body, /outline:\s*var\(--focus\)/);
  assert.match(ring.body, /outline-offset:\s*var\(--focus-offset\)/);
});

test('focus: the ring is never removed: every outline: none / 0 is a :focus reset paired with :focus-visible, or has its own replacement indicator', () => {
  const removed = RULES.filter((r) => /(^|;|\s)outline(-style)?:\s*(none|0)\b/.test(r.body));
  assert.ok(removed.length >= 2, 'the test finds the resets');
  const replaced = { ':focus': ':focus-visible', '.tl-dot': '.tl-dot:focus-visible circle' };
  for (const r of removed) {
    const partner = replaced[r.selector];
    assert.ok(partner, `${r.selector} removes the outline and has no known replacement`);
    assert.ok(RULES.some((x) => selectorsOf(x).includes(partner)), `${r.selector}: replacement ${partner} exists`);
  }
  // and the components never switch it off inline
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.jsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  // the one exception: the CodeMirror theme drops the editor's own outline, and the surface around it draws the ring when anything inside has focus
  const cmTheme = join(src, 'editor', 'extensions.js');
  for (const file of walk(src).filter((f) => f !== cmTheme)) assert.doesNotMatch(readFileSync(file, 'utf8'), /outline\s*:\s*['"]?(none|0)/, `${file} switches an outline off inline`);
  for (const sel of ['.editor-surface:focus-within', '.raw-surface:focus-within']) assert.match(RULES.find((r) => r.selector === sel)?.body ?? '', /outline:\s*var\(--focus\)/, `${sel} draws the ring for the editor inside`);
});

test('focus: the dot of the timeline chart gets a visible change on focus (stroke), because its outline is replaced', () => {
  const r = RULES.find((x) => selectorsOf(x).includes('.tl-dot:focus-visible circle'));
  assert.ok(r && /stroke:\s*var\(--text\)/.test(r.body));
});

test('focus: the skip link is hidden off-screen until it is focused, then shown', () => {
  assert.match(RULES.find((r) => r.selector === '.skip-link').body, /transform:\s*translateY\(-200%\)/);
  assert.match(RULES.find((r) => r.selector === '.skip-link:focus').body, /transform:\s*none/);
});

// ---------------------------------------------------------------- reduced motion

test('reduced motion: one block that stops transitions and animations, universally and for every selector that animates', () => {
  const block = RULES.filter((r) => r.media && REDUCE.test(r.media));
  assert.ok(block.length >= 2, 'a prefers-reduced-motion: reduce block exists');
  const universal = block.find((r) => selectorsOf(r).includes('*'));
  assert.ok(universal, 'a universal rule');
  assert.match(universal.body, /animation:\s*none\s*!important/);
  assert.match(universal.body, /transition:\s*none\s*!important/);
  assert.match(universal.body, /scroll-behavior:\s*auto\s*!important/);
  // every selector that declares a transition or an animation outside the reduced-motion and no-preference blocks is named in the block as well
  const named = new Set(block.flatMap(selectorsOf));
  const animated = RULES.filter((r) => !(r.media && (REDUCE.test(r.media) || NO_PREF.test(r.media))) && /(^|;|\s)(transition|animation)(-[a-z]+)?:/.test(r.body));
  assert.ok(animated.length >= 2, 'the test finds the animated selectors');
  for (const r of animated) for (const sel of selectorsOf(r)) assert.ok(named.has(sel), `${sel} animates and is not named in the reduced-motion block`);
  // what only animates for people who have not asked for less motion stays behind no-preference
  for (const r of RULES.filter((x) => /(^|;|\s)animation:/.test(x.body) && !(x.media && REDUCE.test(x.media)))) assert.ok(r.media && NO_PREF.test(r.media), `${r.selector}: an animation outside no-preference`);
});

// ---------------------------------------------------------------- responsive

const maxWidth = (r) => Number(/\(max-width:\s*(\d+)px\)/.exec(r.media ?? '')?.[1] ?? Infinity);

test('responsive: below 900 px the rail folds behind the Chapters button and the workspace is one column', () => {
  const grid = RULES.find((r) => r.selector === '.workspace' && maxWidth(r) === 899);
  assert.ok(grid, 'a .workspace rule at max-width 899px');
  assert.match(grid.body, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(RULES.find((r) => r.selector === '.rail-toggle' && maxWidth(r) === 899).body, /display:\s*inline-flex/);
  assert.match(RULES.find((r) => r.selector === ".rail[data-open='false']" && maxWidth(r) === 899).body, /display:\s*none/);
});

test('responsive: the sidebars of the Codex, Timeline, Notes and Continuity pages are one column at 899 px and below', () => {
  assert.ok(RULES.find((r) => r.selector === '.codex' && maxWidth(r) === 899 && /minmax\(0,\s*1fr\)/.test(r.body)), 'codex single column');
  const tlnt = RULES.find((r) => r.selector === '.tl, .nt' && r.media && maxWidth(r) >= 899);
  assert.ok(tlnt && /minmax\(0,\s*1fr\)/.test(tlnt.body), 'timeline, notes and continuity single column');
});

test('responsive: medium widths keep rail + main with the inspector below, and wide tables scroll inside their own box', () => {
  const medium = RULES.find((r) => r.selector === '.workspace' && maxWidth(r) === 1199);
  assert.match(medium.body, /grid-template-columns:\s*var\(--rail\)\s+minmax\(0,\s*1fr\)/);
  const tokens = Object.fromEntries([...CSS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  assert.ok(parseInt(tokens['--rail'], 10) + 300 <= 1024, 'rail plus a usable main column fit 1024 px');
  assert.ok(RULES.some((r) => /overflow-x:\s*auto/.test(r.body)), 'tables scroll in their own container');
});

test('responsive: every dialog is at most the window wide, so it fits 768 px', () => {
  const dialogs = RULES.filter((r) => selectorsOf(r).some((s) => /^\.dialog(\.[\w-]+)*$/.test(s)) && /(^|;|\s)width:/.test(r.body));
  assert.ok(dialogs.length >= 2);
  for (const r of dialogs) for (const [, w] of r.body.matchAll(/(?:^|;|\s)width:\s*([^;]+)/g)) assert.match(w.trim(), /^min\(\d+px,\s*100%\)$/, `${r.selector}: width ${w}`);
  const box = RULES.find((r) => r.selector === '.dialog');
  assert.match(box.body, /max-height:\s*85vh/);
  assert.match(box.body, /overflow:\s*auto/);
  assert.match(RULES.find((r) => r.selector === '.dialog-backdrop').body, /padding:\s*var\(--s4\)/);
});

// ---------------------------------------------------------------- toasts

test('toasts: they live in one fixed stack so several never sit on top of each other', () => {
  const stack = RULES.find((r) => r.selector === '.toast-stack');
  assert.match(stack.body, /position:\s*fixed/);
  assert.match(stack.body, /flex-direction:\s*column/);
  assert.match(RULES.find((r) => r.selector === '.toast-stack .toast').body, /position:\s*static/);
});
