// repeated-words (M13-J03 §2): the same word twice in a row, separated only by spaces or one line break (case-insensitive).
// Punctuation between the words (`very, very`) is allowed.
import { makeRule } from './util.mjs';

export const id = 'repeated-words';
export const category = 'repetition';
export const severity = 'warning';
export const advisory = false;
export const defaults = { enabled: true };

const REPEAT = /(?<![\p{L}\p{N}'’])([\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)(?:[ \t]+|[ \t]*\n[ \t]*)\1(?![\p{L}\p{N}'’])/giu;

export function detect(text) {
  const hits = [];
  for (const m of text.matchAll(REPEAT)) {
    hits.push({ from: m.index, to: m.index + m[0].length, message: `The word “${m[1]}” is repeated.`, replacement: m[1] });
  }
  return hits;
}

export const rule = makeRule(id, detect);
