// preferred-terms (M13-J03 §2): an `avoid` spelling from the author's list, whole word, replaced by the `use` spelling.
import { makeRule } from './util.mjs';

export const id = 'preferred-terms';
export const category = 'terminology';
export const severity = 'warning';
export const advisory = false;
export const defaults = { enabled: true, terms: [] };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLower = (ch) => ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
const isUpper = (ch) => ch.toUpperCase() === ch && ch.toLowerCase() !== ch;

/** The `use` spelling with the first letter's case copied from the matched text. */
export function withCaseOf(use, matched) {
  const first = Array.from(use)[0];
  const m = Array.from(matched)[0];
  const cased = isUpper(m) ? first.toUpperCase() : isLower(m) ? first.toLowerCase() : first;
  return cased + use.slice(first.length);
}

export function detect(text, options) {
  const hits = [];
  const terms = Array.isArray(options.terms) ? options.terms.slice(0, 500) : [];
  for (const term of terms) {
    if (term === null || typeof term !== 'object' || typeof term.use !== 'string' || term.use === '' || !Array.isArray(term.avoid)) continue;
    const avoid = term.avoid.filter((a) => typeof a === 'string' && a !== '' && a !== term.use).sort((a, b) => b.length - a.length);
    if (avoid.length === 0) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${avoid.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, term.caseSensitive === true ? 'gu' : 'giu');
    for (const m of text.matchAll(re)) {
      const replacement = withCaseOf(term.use, m[0]);
      if (replacement === m[0]) continue;
      hits.push({ from: m.index, to: m.index + m[0].length, message: `Use “${replacement}” instead of “${m[0]}”.`, replacement });
    }
  }
  hits.sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  let end = -1;
  for (const h of hits) {
    if (h.from < end) continue;
    out.push(h);
    end = h.to;
  }
  return out;
}

export const rule = makeRule(id, detect);
