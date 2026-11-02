import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrast, lightness, over, parseTokens, rgb } from './color.mjs';

const { root, accents } = parseTokens();
const hex = (name, vars = root) => {
  const v = vars[name] ?? root[name];
  assert.match(v ?? '', /^#[0-9A-Fa-f]{6}$/, `${name} must be a #RRGGBB colour (got ${v})`);
  return rgb(v);
};

const ACCENTS = ['#E0A64B', '#E8743B', '#6FA8DC', '#7FB685'];
const SURFACES = ['--bg', '--surface', '--surface-2'];

test('tokens: the reference values are present', () => {
  const expected = {
    '--bg': '#0E0E10',
    '--surface': '#16161A',
    '--surface-2': '#1C1C21',
    '--divider': '#26262C',
    '--border': '#2A2A31',
    '--text': '#ECECEF',
    '--text-2': '#D4D4D8',
    '--text-3': '#A1A1AA',
    '--muted': '#8B8B95',
    '--accent': '#E0A64B',
    '--accent-ink': '#141414',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(root[k]?.toUpperCase(), v, k);
  assert.match(root['--accent-soft'], /16%/, 'accent-soft is the accent at 16%');
  assert.equal(root['--rail'], '260px');
  assert.equal(root['--inspector'], '340px');
  assert.equal(root['--topbar'], '56px');
  assert.equal(root['--r-control'], '8px');
  assert.equal(root['--r-input'], '10px');
  assert.equal(root['--r-card'], '12px');
  assert.equal(root['--s1'], '4px');
  assert.equal(root['--s8'], '32px');
  assert.equal(root['--font-ui'], "'Inter Variable', Inter, system-ui, sans-serif");
  assert.equal(root['--font-prose'], "'Literata Variable', Literata, Georgia, serif");
});

test('tokens: all four reference accents exist as [data-accent] overrides', () => {
  assert.deepEqual(Object.keys(accents).sort(), [...ACCENTS].sort());
  for (const a of ACCENTS) assert.equal(accents[a]['--accent'].toUpperCase(), a);
  assert.equal(root['--accent'].toUpperCase(), '#E0A64B', 'gold is the default');
});

test('contrast: text tokens on every surface they are allowed on are at least 4.5:1', () => {
  for (const t of ['--text', '--text-2', '--text-3']) {
    for (const s of SURFACES) assert.ok(contrast(hex(t), hex(s)) >= 4.5, `${t} on ${s}: ${contrast(hex(t), hex(s)).toFixed(2)}`);
  }
  // --muted is a label colour: allowed on --bg and --surface only.
  for (const s of ['--bg', '--surface']) assert.ok(contrast(hex('--muted'), hex(s)) >= 4.5, `--muted on ${s}`);
});

test('contrast: --muted is not allowed on --border fills (it measures under 4.5:1 there)', () => {
  assert.ok(contrast(hex('--muted'), hex('--border')) < 4.5);
});

test('contrast: no stylesheet rule puts --muted text on a --border or --surface-2 fill', () => {
  for (const file of ['../src/styles.css', '../src/theme/base.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const muted = /(^|[;\s])color:\s*var\(--muted\)/.test(body);
      const fill = /background(-color)?:\s*var\(--(border|surface-2)\)/.test(body);
      assert.ok(!(muted && fill), `${selector.trim()} uses --muted on a --border/--surface-2 fill`);
    }
  }
});

for (const accentHex of ACCENTS) {
  const vars = { ...root, ...accents[accentHex] };
  const get = (name) => hex(name, vars);

  test(`contrast ${accentHex}: accent-ink on accent is at least 4.5:1`, () => {
    assert.ok(contrast(get('--accent-ink'), get('--accent')) >= 4.5, contrast(get('--accent-ink'), get('--accent')).toFixed(2));
  });

  test(`contrast ${accentHex}: accent text on surfaces and on the selected-row fill is at least 4.5:1`, () => {
    for (const s of SURFACES) assert.ok(contrast(get('--accent'), get(s)) >= 4.5, `accent on ${s}`);
    for (const s of ['--bg', '--surface']) {
      const fill = over(get('--accent'), 0.16, get(s)); // --accent-soft over the surface
      assert.ok(contrast(get('--accent'), fill) >= 4.5, `accent on accent-soft over ${s}`);
      assert.ok(contrast(get('--text-3'), fill) >= 4.5, `text-3 on accent-soft over ${s}`);
    }
  });

  test(`contrast ${accentHex}: state colours are at least 4.5:1 on every surface`, () => {
    for (const state of ['--danger', '--warning', '--ok']) {
      for (const s of SURFACES) assert.ok(contrast(get(state), get(s)) >= 4.5, `${state} on ${s}: ${contrast(get(state), get(s)).toFixed(2)}`);
    }
  });

  test(`contrast ${accentHex}: danger differs from the accent by at least 10 L* (not hue alone)`, () => {
    const diff = Math.abs(lightness(get('--danger')) - lightness(get('--accent')));
    assert.ok(diff >= 10, `L* difference ${diff.toFixed(1)}`);
  });
}

// ---- M06-J03: every colour pair the stylesheet actually uses (the M02 pairs above are the token reference; these are the rules) ----------------------------------------
// A pair is a rule that sets `color` and a background from tokens (var(--x)); a text colour on its own is checked on the two surfaces pages are drawn on.
// Text needs 4.5:1; borders, rings, icons and fills need 3:1. Semi-transparent and color-mix() backgrounds are measured as the token over --bg.

const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every rule { selector, decls } of the stylesheet, nested @media blocks flattened. */
function rules(css) {
  const out = [];
  const stripped = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.trim().startsWith('@')) continue;
    const decls = {};
    for (const [, name, value] of body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)) decls[name] = value.trim();
    out.push({ selector: selector.trim().replace(/\s+/g, ' '), decls });
  }
  return out;
}
const RULES = rules(CSS);
const tokenOf = (value) => /^var\((--[\w-]+)\)$/.exec(value ?? '')?.[1] ?? null;
const resolve = (name, vars = root) => {
  const v = vars[name] ?? root[name];
  return /^#[0-9A-Fa-f]{6}$/.test(v ?? '') ? rgb(v) : null;
};
/** A background colour of a declaration value as rgb, over --bg for translucent ones; null when it cannot be read. */
function fillOf(value, vars) {
  const t = tokenOf(value);
  if (t) return resolve(t, vars);
  const soft = /^var\((--[\w-]+-soft)\)$/.exec(value ?? '');
  if (soft) return null;
  const mix = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+)%,\s*var\((--[\w-]+)\)\)$/.exec(value ?? '');
  if (mix) {
    const a = resolve(mix[1], vars);
    const b = resolve(mix[3], vars);
    return a && b ? over(a, Number(mix[2]) / 100, b) : null;
  }
  return null;
}
const TEXT_TOKENS = ['--text', '--text-2', '--text-3', '--muted', '--accent', '--danger', '--warning', '--ok'];

test('contrast (rules): the stylesheet is readable by this test (it finds the colour pairs it is meant to check)', () => {
  const pairs = RULES.filter((r) => tokenOf(r.decls.color) && (r.decls.background || r.decls['background-color']));
  assert.ok(RULES.length > 600, `rules found: ${RULES.length}`);
  assert.ok(pairs.length >= 20, `rules with a text token on a background: ${pairs.length}`);
});

for (const accentHex of ACCENTS) {
  const vars = { ...root, ...accents[accentHex] };
  test(`contrast (rules) ${accentHex}: every rule that sets a text token on a background token is at least 4.5:1`, () => {
    const bad = [];
    let checked = 0;
    for (const r of RULES) {
      const fg = tokenOf(r.decls.color);
      const bg = r.decls['background-color'] ?? r.decls.background;
      if (!fg || !bg) continue;
      const f = resolve(fg, vars);
      const b = fillOf(bg, vars);
      if (!f || !b) continue;
      checked++;
      const c = contrast(f, b);
      if (c < 4.5) bad.push(`${r.selector}: ${fg} on ${bg} = ${c.toFixed(2)}`);
    }
    assert.ok(checked >= 15, `pairs checked: ${checked}`);
    assert.deepEqual(bad, []);
  });

  test(`contrast (rules) ${accentHex}: every text token used on its own is at least 4.5:1 on --bg and --surface`, () => {
    const used = new Set();
    for (const r of RULES) {
      const fg = tokenOf(r.decls.color);
      if (fg && TEXT_TOKENS.includes(fg)) used.add(fg);
    }
    assert.ok(used.size >= 6, `text tokens in use: ${[...used]}`);
    for (const t of used) for (const s of ['--bg', '--surface']) assert.ok(contrast(resolve(t, vars), resolve(s, vars)) >= 4.5, `${t} on ${s}`);
  });
}

test('contrast (rules): borders that carry meaning (focus ring, input borders) are at least 3:1 on the surfaces', () => {
  for (const accentHex of ACCENTS) {
    const vars = { ...root, ...accents[accentHex] };
    assert.equal(root['--focus'], '2px solid var(--accent)', 'the focus ring is the accent, 2px');
    for (const s of SURFACES) assert.ok(contrast(resolve('--accent', vars), resolve(s, vars)) >= 3, `focus ring ${accentHex} on ${s}`);
  }
  // an input's edge: the border token against the surface it sits on is a 1px decoration (the text inside is what must be readable); the focus ring replaces it while typing
  for (const r of RULES.filter((x) => /(^|,| )(input|select|textarea)\b/.test(x.selector) && x.decls['border-color'])) {
    const t = tokenOf(r.decls['border-color']);
    if (t === '--danger') for (const s of SURFACES) assert.ok(contrast(resolve(t), resolve(s)) >= 3, `${r.selector}: ${t} on ${s}`);
  }
});
