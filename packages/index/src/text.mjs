// Text helpers: what counts as searchable prose, FTS query escaping, and whole-word mention counting.
import { proseLines } from '@storyforge/format';

/**
 * Body text as it is searched and matched: HTML comments, fenced code and inline code removed.
 * @param {string} body
 * @returns {string}
 */
export function stripForSearch(body) {
  const noComments = body.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const lines = [];
  for (const [, line] of proseLines(noComments.replace(/\r\n?/g, '\n'), 1)) lines.push(line);
  return lines.join('\n');
}

const MAX_TERMS = 12;

/**
 * Turn what the author typed into an FTS5 query. Only letters, digits and combining marks survive,
 * so none of the user's text is ever FTS syntax; every term is a quoted prefix term, ANDed.
 * @param {string} text
 * @returns {string} '' when there is nothing searchable
 */
export function ftsQuery(text) {
  const terms = String(text).normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  return terms.slice(0, MAX_TERMS).map((t) => `"${t}"*`).join(' ');
}

/** Lower-case, no diacritics, single spaces. @param {string} s */
export function foldText(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const NO_WORD_BOUNDARY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for one entry: counts whole-word, case- and diacritic-insensitive occurrences of its name
 * and aliases in already-folded text. Overlapping names (a name and an alias that contains it) count once.
 * Scripts written without spaces (Han, kana) match without word boundaries.
 * @param {unknown[]} names name followed by aliases
 * @returns {((foldedText: string) => number) | null} null when there is nothing to match
 */
export function mentionCounter(names) {
  const folded = [...new Set(names.filter((n) => typeof n === 'string').map(foldText).filter((n) => n !== ''))];
  if (folded.length === 0) return null;
  folded.sort((a, b) => b.length - a.length);
  const alts = folded.map((n) => {
    const first = [...n][0];
    const last = [...n].at(-1);
    const lead = NO_WORD_BOUNDARY.test(first) ? '' : '(?<![\\p{L}\\p{N}])';
    const trail = NO_WORD_BOUNDARY.test(last) ? '' : '(?![\\p{L}\\p{N}])';
    return `${lead}${escapeRe(n)}${trail}`;
  });
  const re = new RegExp(alts.join('|'), 'gu');
  return (text) => {
    let n = 0;
    for (const _m of text.matchAll(re)) n++; // eslint-disable-line no-unused-vars
    return n;
  };
}
