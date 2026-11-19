// long-paragraphs (M13-J03 §2, off by default, advisory): a paragraph over maxWords words. No replacement.
import { countWords, intOption, makeRule, paragraphsOf } from './util.mjs';

export const id = 'long-paragraphs';
export const category = 'rhythm';
export const severity = 'info';
export const advisory = true;
export const defaults = { enabled: false, maxWords: 220 };

export function detect(text, options) {
  const maxWords = intOption(options.maxWords, defaults.maxWords, 50, 2000);
  const hits = [];
  for (const p of paragraphsOf(text)) {
    const words = countWords(text.slice(p.from, p.to));
    if (words > maxWords) hits.push({ from: p.from, to: p.to, message: `This paragraph has ${words} words (more than ${maxWords}).` });
  }
  return hits;
}

export const rule = makeRule(id, detect);
