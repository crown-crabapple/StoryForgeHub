// The fixed table of rules (M13-J03 §1). Only entries of this table are ever handed to textlint: rule ids, options and book settings are
// data, and nothing can name a module, a path or a package. Each module exports id, category, severity, advisory, defaults, detect and rule.
import * as preferredTerms from './preferred-terms.mjs';
import * as repeatedWords from './repeated-words.mjs';
import * as punctuation from './punctuation.mjs';
import * as repeatedPhrases from './repeated-phrases.mjs';
import * as longParagraphs from './long-paragraphs.mjs';
import * as isolatedLines from './isolated-lines.mjs';

export const RULES = Object.freeze({
  'preferred-terms': preferredTerms,
  'repeated-words': repeatedWords,
  punctuation,
  'repeated-phrases': repeatedPhrases,
  'long-paragraphs': longParagraphs,
  'isolated-lines': isolatedLines,
});
