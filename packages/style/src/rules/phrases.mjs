// Word n-gram matching shared by the repeated-phrases rule and crossSceneRepeats (M13-J03 §2). Pure: no I/O.
// Simple word n-grams, not meaning. A phrase never runs across a blank line (a paragraph break).
import { WORD } from './util.mjs';

export const MAX_PHRASE_WORDS = 8;
/** Most candidates examined for one start (bounds the cost of very repetitive text). */
export const MAX_CANDIDATES = 2000;

const COMMON = new Set((
  'a about after all also am an and any are as at be because been before but by can could did do does for from had has have he her here him his how i if in into is it its just like '
  + 'me more my no not of on one only or our out over she so some than that the their them then there these they this to too up us was we were what when which who will with would you your'
).split(' '));

/**
 * @typedef {{ words: string[], starts: number[], ends: number[], brk: boolean[] }} Tokens
 * `brk[w]` is true when a blank line separates word w-1 from word w.
 */

/** @param {string} text @returns {Tokens} */
export function tokenize(text) {
  const words = [];
  const starts = [];
  const ends = [];
  const brk = [];
  let prevEnd = 0;
  for (const m of text.matchAll(WORD)) {
    words.push(m[0].toLowerCase().replace(/’/g, "'"));
    starts.push(m.index);
    ends.push(m.index + m[0].length);
    brk.push(words.length > 1 && /\n[ \t]*\n/.test(text.slice(prevEnd, m.index)));
    prevEnd = m.index + m[0].length;
  }
  return { words, starts, ends, brk };
}

const commonOnly = (words, i, n) => {
  for (let k = 0; k < n; k += 1) if (!COMMON.has(words[i + k])) return false;
  return true;
};

/** Key of the minWords-gram at word i, or null when a paragraph break falls inside it or it runs past the end. */
export function gramKey(t, i, minWords) {
  if (i + minWords > t.words.length) return null;
  for (let k = 1; k < minWords; k += 1) if (t.brk[i + k]) return null;
  return t.words.slice(i, i + minWords).join(' ');
}

/** How many words (up to MAX_PHRASE_WORDS) the phrases at a (in ta) and b (in tb) share, never across a paragraph break. */
export function extension(ta, a, tb, b, minWords) {
  let n = 0;
  while (n < MAX_PHRASE_WORDS && a + n < ta.words.length && b + n < tb.words.length && ta.words[a + n] === tb.words[b + n]) {
    if (n >= 1 && (ta.brk[a + n] || tb.brk[b + n])) break;
    n += 1;
  }
  return n >= minWords ? n : 0;
}

/** Is a phrase of n words at i made only of common words? */
export const isCommonPhrase = (t, i, n) => commonOnly(t.words, i, n);

/** Remember that the gram "key" starts at word i. @param {Map<string, number[]>} map @param {string | null} key @param {number} i */
export function record(map, key, i) {
  if (key === null) return;
  const list = map.get(key);
  if (list) list.push(i); else map.set(key, [i]);
}
