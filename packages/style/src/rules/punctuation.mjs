// punctuation (M13-J03 §2): a quote, dash or ellipsis that differs from the chosen style. Every style is null until the author picks one.
import { makeRule } from './util.mjs';

export const id = 'punctuation';
export const category = 'punctuation';
export const severity = 'warning';
export const advisory = false;
export const defaults = { enabled: true, quotes: null, dashes: null, ellipsis: null };

const OPENERS = '([{—–';
const LETTER = /\p{L}/u;

/** Curly form of the straight quote at `i`: an apostrophe between two letters, opening after a line start, whitespace or `([{—–`, else closing. */
function curlyOf(text, i) {
  const ch = text[i];
  const prev = i > 0 ? text[i - 1] : '';
  const next = i + 1 < text.length ? text[i + 1] : '';
  if (ch === "'" && LETTER.test(prev) && LETTER.test(next)) return '’';
  const opening = prev === '' || /\s/.test(prev) || OPENERS.includes(prev);
  if (ch === '"') return opening ? '“' : '”';
  return opening ? '‘' : '’';
}

const STRAIGHT_OF = { '“': '"', '”': '"', '‘': "'", '’': "'" };
const DASH = /(?<=[^\s-])(?:[ \t]+(?:---|--|-|–|—)[ \t]+|[ \t]*(?:—|---|--|–)[ \t]*)(?=[^\s-])/gu;
const DASH_FORMS = { em: '—', 'em-spaced': ' — ', 'en-spaced': ' – ' };
const DASH_NAMES = { em: 'an em dash (—) with no spaces', 'em-spaced': 'an em dash with a space on each side', 'en-spaced': 'an en dash with a space on each side' };

export function detect(text, options) {
  const hits = [];
  const { quotes, dashes, ellipsis } = options;
  if (quotes === 'curly') {
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '"' && text[i] !== "'") continue;
      const replacement = curlyOf(text, i);
      hits.push({ from: i, to: i + 1, message: `Use the curly quote ${replacement}.`, replacement });
    }
  } else if (quotes === 'straight') {
    for (let i = 0; i < text.length; i += 1) {
      const replacement = STRAIGHT_OF[text[i]];
      if (replacement) hits.push({ from: i, to: i + 1, message: `Use the straight quote ${replacement}.`, replacement });
    }
  }
  if (typeof dashes === 'string' && Object.prototype.hasOwnProperty.call(DASH_FORMS, dashes)) {
    const want = DASH_FORMS[dashes];
    for (const m of text.matchAll(DASH)) {
      const token = m[0];
      if (token === want) continue;
      const before = text[m.index - 1];
      const after = text[m.index + token.length];
      if (token === '–' && /\d/.test(before) && /\d/.test(after)) continue; // a numeric range (1990–1995) is not a dash
      hits.push({ from: m.index, to: m.index + token.length, message: `Use ${DASH_NAMES[dashes]}.`, replacement: want });
    }
  }
  if (ellipsis === 'character') {
    for (const m of text.matchAll(/(?<!\.)\.{3}(?!\.)/g)) hits.push({ from: m.index, to: m.index + 3, message: 'Use the ellipsis character (…).', replacement: '…' });
  } else if (ellipsis === 'dots') {
    for (const m of text.matchAll(/…/g)) hits.push({ from: m.index, to: m.index + 1, message: 'Use three dots (...).', replacement: '...' });
  }
  return hits;
}

export const rule = makeRule(id, detect);
