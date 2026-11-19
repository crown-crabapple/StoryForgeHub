// Shared helpers for the style rules (M13-J03). Pure: no I/O.
// Every rule is a pure function `detect(text, options) -> Hit[]` over the projected text, wrapped by makeRule() into a textlint rule.
// A Hit is `{ from, to, message, replacement?, related? }` with UTF-16 offsets into the text the rule was given.
// `replacement` travels as the message's textlint `fix`. `related` ([{ from, to }], same offsets) travels through the per-run side channel
// (`run.related`, keyed by rule id and range) because textlint drops custom data from its messages.

export const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** @param {unknown} v @param {number} def @param {number} min @param {number} max */
export function intOption(v, def, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
}

/** Paragraphs of a text: runs of non-blank lines separated by blank lines, trimmed. @param {string} text @returns {{ from: number, to: number }[]} */
export function paragraphsOf(text) {
  const out = [];
  const re = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g;
  for (const m of text.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const trimmed = m[0].trim();
    out.push({ from: m.index + lead, to: m.index + lead + trimmed.length });
  }
  return out;
}

/** Number of words in a string. @param {string} s */
export function countWords(s) {
  return Array.from(s.matchAll(WORD)).length;
}

/** @param {string} ruleId @param {number} from @param {number} to */
export const relatedKey = (ruleId, from, to) => `${ruleId}:${from}:${to}`;

/**
 * Wrap a detector as a textlint rule. The whole projected text is read from the Document node, so offsets are document offsets.
 * @param {string} ruleId
 * @param {(text: string, options: any) => { from: number, to: number, message: string, replacement?: string, related?: { from: number, to: number }[] }[]} detect
 */
export function makeRule(ruleId, detect) {
  return (context, options, run) => ({
    [context.Syntax.Document](node) {
      const text = context.getSource(node);
      for (const hit of detect(text, options ?? {})) {
        const range = [hit.from, hit.to];
        const details = { padding: context.locator.range(range) };
        if (hit.replacement !== undefined) details.fix = context.fixer.replaceTextRange(range, hit.replacement);
        if (hit.related && run) run.related.set(relatedKey(ruleId, hit.from, hit.to), hit.related);
        context.report(node, new context.RuleError(hit.message, details));
      }
    },
  });
}
