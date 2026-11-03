// Themes (M07-J04 contract section 2). `dark` is the reference theme of theme/tokens.css and stays the default; `light` and `high-contrast` replace its colour tokens
// (nothing else: spacing, radii and type stay the same); a custom theme is a map from the same token names to #RRGGBB colours, kept in the profile.
// Every built-in theme passes the contrast pairs below (test/contrast.test.mjs runs them again with its own colour maths). Pure.

/** The colour tokens of theme/tokens.css a theme may set. Same list as @storyforge/format THEME_TOKENS (a test compares them). */
export const THEME_TOKENS = ['--bg', '--surface', '--surface-2', '--divider', '--border', '--text', '--text-2', '--text-3', '--muted', '--accent', '--accent-ink', '--danger', '--warning', '--ok'];

/** The reference dark theme: the values of theme/tokens.css (a test compares them). */
export const DARK = Object.freeze({
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
  '--danger': '#E8575C',
  '--warning': '#F0C27A',
  '--ok': '#6FCF8E',
});

export const LIGHT = Object.freeze({
  '--bg': '#F6F5F1',
  '--surface': '#FFFFFF',
  '--surface-2': '#ECEAE4',
  '--divider': '#DDDAD2',
  '--border': '#D9D5CB',
  '--text': '#17171A',
  '--text-2': '#2B2B31',
  '--text-3': '#46464F',
  '--muted': '#5A5A64',
  '--accent': '#805200',
  '--accent-ink': '#FFFFFF',
  '--danger': '#7A1212',
  '--warning': '#6B4E00',
  '--ok': '#1B6E3A',
});

export const HIGH_CONTRAST = Object.freeze({
  '--bg': '#000000',
  '--surface': '#0A0A0A',
  '--surface-2': '#161616',
  '--divider': '#7A7A7A',
  '--border': '#5C5C5C',
  '--text': '#FFFFFF',
  '--text-2': '#F5F5F5',
  '--text-3': '#E0E0E0',
  '--muted': '#CFCFCF',
  '--accent': '#FFD400',
  '--accent-ink': '#000000',
  '--danger': '#FF7A7A',
  '--warning': '#FFB454',
  '--ok': '#6EE7A0',
});

/** The built-in themes by name, with their label and the `color-scheme` the browser should assume. */
export const BUILTIN_THEMES = [
  { name: 'dark', label: 'Dark (reference)', scheme: 'dark', tokens: DARK },
  { name: 'light', label: 'Light', scheme: 'light', tokens: LIGHT },
  { name: 'high-contrast', label: 'High contrast', scheme: 'dark', tokens: HIGH_CONTRAST },
];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** @param {string} hex @returns {[number, number, number]} */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast ratio between two #RRGGBB colours. @param {string} a @param {string} b */
export function contrastRatio(a, b) {
  const x = luminance(rgb(a));
  const y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const lightness = (hex) => {
  const y = luminance(rgb(hex));
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
};
/** `fg` at `alpha` over `bg`, as a hex colour. */
const overHex = (fg, alpha, bg) => {
  const f = rgb(fg);
  const b = rgb(bg);
  return `#${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
};

const SURFACES = ['--bg', '--surface', '--surface-2'];

/**
 * The colour pairs a theme must satisfy (the M02-J01 token reference and the M06-J03 rules): text 4.5:1 on every surface, --muted 4.5:1 on --bg and --surface,
 * the accent as text 4.5:1 (also on its own 16% tint), ink on the accent 4.5:1, state colours 4.5:1, and danger at least 10 L* away from the accent (never hue alone).
 * @param {Record<string, string>} tokens a full token map
 * @returns {{ pair: string, ratio: number, min: number }[]} the pairs that fail, with the ratio they reach (empty = the theme passes)
 */
export function checkTheme(tokens) {
  /** @type {{ pair: string, ratio: number, min: number }[]} */
  const fails = [];
  const need = (fg, bgName, bg, min) => {
    const ratio = contrastRatio(fg.value, bg);
    if (ratio < min) fails.push({ pair: `${fg.name} on ${bgName}`, ratio: Math.round(ratio * 100) / 100, min });
  };
  const t = (name) => ({ name, value: tokens[name] });
  for (const name of ['--text', '--text-2', '--text-3']) for (const s of SURFACES) need(t(name), s, tokens[s], 4.5);
  for (const s of ['--bg', '--surface']) need(t('--muted'), s, tokens[s], 4.5);
  need(t('--accent-ink'), '--accent', tokens['--accent'], 4.5);
  for (const s of SURFACES) need(t('--accent'), s, tokens[s], 4.5);
  for (const s of ['--bg', '--surface']) {
    const tint = overHex(tokens['--accent'], 0.16, tokens[s]);
    need(t('--accent'), `the accent tint over ${s}`, tint, 4.5);
    need(t('--text-3'), `the accent tint over ${s}`, tint, 4.5);
  }
  for (const name of ['--danger', '--warning', '--ok']) for (const s of SURFACES) need(t(name), s, tokens[s], 4.5);
  const diff = Math.abs(lightness(tokens['--danger']) - lightness(tokens['--accent']));
  if (diff < 10) fails.push({ pair: '--danger differs from --accent by lightness', ratio: Math.round(diff * 10) / 10, min: 10 });
  return fails;
}

/**
 * A full token map for a theme name: a built-in, or `custom:<name>` looked up in the profile's custom themes (laid over the dark reference, so a theme may set only some tokens).
 * An unknown name gives the dark reference.
 * @param {string} name @param {Record<string, Record<string, string>>} [custom]
 * @returns {{ name: string, scheme: 'dark' | 'light', tokens: Record<string, string> }}
 */
export function resolveTheme(name, custom = {}) {
  const builtin = BUILTIN_THEMES.find((t) => t.name === name);
  if (builtin) return { name: builtin.name, scheme: /** @type {'dark' | 'light'} */ (builtin.scheme), tokens: { ...builtin.tokens } };
  if (typeof name === 'string' && name.startsWith('custom:')) {
    const own = custom[name.slice('custom:'.length)];
    if (own && typeof own === 'object') {
      const tokens = { ...DARK };
      for (const [k, v] of Object.entries(own)) if (THEME_TOKENS.includes(k) && HEX.test(v)) tokens[k] = v;
      // a custom theme draws as light when its page colour is
      return { name, scheme: lightness(tokens['--bg']) > 50 ? 'light' : 'dark', tokens };
    }
  }
  return { name: 'dark', scheme: 'dark', tokens: { ...DARK } };
}

/**
 * Check a custom theme before it can be applied: bad token names or colours, and every failing contrast pair with its ratio.
 * @param {Record<string, unknown>} map token name -> colour
 * @returns {{ problems: string[], fails: { pair: string, ratio: number, min: number }[], tokens: Record<string, string> }}
 */
export function checkCustomTheme(map) {
  const problems = [];
  const tokens = { ...DARK };
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!THEME_TOKENS.includes(k)) problems.push(`${k} is not a theme token`);
    else if (typeof v !== 'string' || !HEX.test(v)) problems.push(`${k} must be a colour like #1A2B3C`);
    else tokens[k] = v.toUpperCase();
  }
  return { problems, fails: problems.length > 0 ? [] : checkTheme(tokens), tokens };
}

/** The text of an exported custom theme (a `.json` file the author can share). @param {string} name @param {Record<string, string>} tokens */
export function exportTheme(name, tokens) {
  const own = Object.fromEntries(THEME_TOKENS.filter((k) => tokens[k] !== undefined).map((k) => [k, tokens[k]]));
  return `${JSON.stringify({ schema: 'storyforge.theme/v1', name, tokens: own }, null, 2)}\n`;
}

/**
 * Read an exported theme. Nothing is applied here: the caller runs checkCustomTheme on `tokens` and shows any failing pair first.
 * @param {string} text @returns {{ ok: true, name: string, tokens: Record<string, string> } | { ok: false, message: string }}
 */
export function importTheme(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, message: 'That file is not valid JSON.' };
  }
  if (v === null || typeof v !== 'object' || v.schema !== 'storyforge.theme/v1') return { ok: false, message: 'That file is not a StoryForge theme (schema storyforge.theme/v1).' };
  if (typeof v.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(v.name)) return { ok: false, message: 'The theme needs a name of 1 to 40 letters, digits, spaces, hyphens or underscores.' };
  if (v.tokens === null || typeof v.tokens !== 'object' || Array.isArray(v.tokens)) return { ok: false, message: 'The theme needs a "tokens" object.' };
  const checked = checkCustomTheme(v.tokens);
  if (checked.problems.length > 0) return { ok: false, message: checked.problems[0] };
  return { ok: true, name: v.name, tokens: Object.fromEntries(Object.entries(v.tokens).map(([k, c]) => [k, String(c).toUpperCase()])) };
}
