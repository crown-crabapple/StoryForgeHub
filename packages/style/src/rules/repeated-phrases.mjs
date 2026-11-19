// repeated-phrases (M13-J03 §2, off by default, advisory): a phrase of minWords to 8 words that appears again within `window` words.
// The later occurrence is reported; `related` lists the earlier ones. No replacement. Phrases made only of common words are ignored.
import { extension, gramKey, isCommonPhrase, MAX_CANDIDATES, record, tokenize } from './phrases.mjs';
import { intOption, makeRule } from './util.mjs';

export const id = 'repeated-phrases';
export const category = 'repetition';
export const severity = 'info';
export const advisory = true;
export const defaults = { enabled: false, minWords: 4, window: 300 };

export function detect(text, options) {
  const minWords = intOption(options.minWords, defaults.minWords, 3, 8);
  const window = intOption(options.window, defaults.window, 50, 2000);
  const t = tokenize(text);
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  const hits = [];
  let i = 0;
  while (i < t.words.length) {
    const key = gramKey(t, i, minWords);
    if (key === null) { i += 1; continue; }
    const earlier = seen.get(key);
    let best = 0;
    let found = [];
    if (earlier) {
      let examined = 0;
      for (let k = earlier.length - 1; k >= 0 && i - earlier[k] <= window && examined < MAX_CANDIDATES; k -= 1, examined += 1) {
        const j = earlier[k];
        const n = Math.min(extension(t, j, t, i, minWords), i - j);
        if (n < minWords) continue;
        if (n > best) { best = n; found = [j]; } else if (n === best) found.push(j);
      }
    }
    if (best > 0 && !isCommonPhrase(t, i, best)) {
      const from = t.starts[i];
      const to = t.ends[i + best - 1];
      const related = found.slice(0, 20).reverse().map((j) => ({ from: t.starts[j], to: t.ends[j + best - 1] }));
      hits.push({ from, to, message: `This phrase of ${best} words appears again nearby.`, related });
      for (let k = 0; k < best; k += 1) record(seen, gramKey(t, i + k, minWords), i + k);
      i += best;
      continue;
    }
    record(seen, key, i);
    i += 1;
  }
  return hits;
}

export const rule = makeRule(id, detect);
