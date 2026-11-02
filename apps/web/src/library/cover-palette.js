// Colours of a generated cover (M02-J02). Pure, so the contrast promise is unit-tested.

/** Cover text colours: pure white and pure black are the only pair that gives 4.5:1 on every possible background. */
export const COVER_TEXT_LIGHT = '#FFFFFF';
export const COVER_TEXT_DARK = '#000000';

/** Eight dark tones; each has at least 4.5:1 with the light cover text. */
export const COVER_PALETTE = ['#2F4A3A', '#33496B', '#5B2A3C', '#1F4F5A', '#4E3B2A', '#403A66', '#2E3E4E', '#4A2F5C'];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** @param {string} hex #RRGGBB @returns {number} WCAG relative luminance */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Text colour for a background: light by default, dark when the background is light enough that dark reads better. @param {string} background #RRGGBB */
export function coverTextColor(background) {
  return contrastRatio(background, COVER_TEXT_LIGHT) >= contrastRatio(background, COVER_TEXT_DARK) ? COVER_TEXT_LIGHT : COVER_TEXT_DARK;
}

/** Palette colour for a book id: the same id always gets the same colour (FNV-1a hash). @param {string} id */
export function coverColorFor(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return COVER_PALETTE[h % COVER_PALETTE.length];
}

/**
 * Background and text colour of a book's generated cover: its own `cover_color` if it is a valid #RRGGBB,
 * else a palette colour picked from its id.
 * @param {{ id: string, cover_color?: string | null }} book
 */
export function coverColors(book) {
  const background = typeof book.cover_color === 'string' && HEX.test(book.cover_color) ? book.cover_color : coverColorFor(book.id);
  return { background, color: coverTextColor(background) };
}
