// Merging grammar and style findings (M13-J03 section 6). Pure: no I/O.
// Two findings with the same range and the same concern keep only the owner's finding: Harper's repeated-word, dash, quote and ellipsis rules are owned by the textlint
// rule of that concern. Everything else is kept. The result lists the grammar findings first, then the style findings, each in the order it came.

/**
 * Harper rule name -> the textlint rule id that owns that concern. The names are the keys of Harper's default lint config (harper.js getDefaultLintConfig).
 * RepeatedWords is the repeated word; Dashes is `--` for a dash; WrongApostrophe is a straight or wrong apostrophe (a quote character); UseEllipsisCharacter and
 * EllipsisLength are the ellipsis.
 */
export const OWNERS = Object.freeze({
  RepeatedWords: 'repeated-words',
  Dashes: 'punctuation',
  WrongApostrophe: 'punctuation',
  UseEllipsisCharacter: 'punctuation',
  EllipsisLength: 'punctuation',
});

const sameRange = (a, b) => a.range.from === b.range.from && a.range.to === b.range.to;

/**
 * Grammar (Harper) and style (textlint) findings as one list, with each duplicate concern shown once.
 * @param {any[]} grammar @param {any[]} style
 * @returns {any[]}
 */
export function mergeFindings(grammar, style) {
  const g = Array.isArray(grammar) ? grammar : [];
  const s = Array.isArray(style) ? style : [];
  const kept = g.filter((f) => {
    const owner = Object.hasOwn(OWNERS, f.ruleId) ? OWNERS[f.ruleId] : null;
    return owner === null || !s.some((o) => o.ruleId === owner && sameRange(o, f));
  });
  return [...kept, ...s];
}
