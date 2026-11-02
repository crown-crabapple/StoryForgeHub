// Colour maths and token parsing shared by the contrast tests.
import { readFileSync } from 'node:fs';

export const TOKENS_PATH = new URL('../src/theme/tokens.css', import.meta.url);

const lin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** @param {string} hex #RRGGBB @returns {[number, number, number]} */
export function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG). @param {number[]} c */
export function luminance(c) {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio between two [r,g,b] colours. */
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** CIE L* (0-100) of an [r,g,b] colour. */
export function lightness(c) {
  const y = luminance(c);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
}

/** `fg` at `alpha` over `bg`. */
export function over(fg, alpha, bg) {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
}

/**
 * Read tokens.css into the :root tokens and the [data-accent] overrides.
 * @returns {{ root: Record<string, string>, accents: Record<string, Record<string, string>> }}
 */
export function parseTokens() {
  const css = readFileSync(TOKENS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = {};
  const accents = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
    const sel = selector.trim();
    const accent = /^\[data-accent=['"](#[0-9A-Fa-f]{6})['"]\]$/.exec(sel);
    if (sel === ':root') Object.assign(root, decls);
    else if (accent) accents[accent[1].toUpperCase()] = decls;
  }
  return { root, accents };
}
