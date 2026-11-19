// isolated-lines (M13-J03 §2, off by default, advisory): minRun or more one-line paragraphs in a row, each under 12 words. No replacement.
import { countWords, intOption, makeRule, paragraphsOf } from './util.mjs';

export const id = 'isolated-lines';
export const category = 'rhythm';
export const severity = 'info';
export const advisory = true;
export const defaults = { enabled: false, minRun: 6 };

const SHORT = 12;

export function detect(text, options) {
  const minRun = intOption(options.minRun, defaults.minRun, 3, 30);
  const hits = [];
  /** @type {{ from: number, to: number }[]} */
  let run = [];
  const flush = () => {
    if (run.length >= minRun) hits.push({ from: run[0].from, to: run[run.length - 1].to, message: `${run.length} one-line paragraphs in a row.` });
    run = [];
  };
  for (const p of paragraphsOf(text)) {
    const s = text.slice(p.from, p.to);
    if (!s.includes('\n') && countWords(s) < SHORT) run.push(p);
    else flush();
  }
  flush();
  return hits;
}

export const rule = makeRule(id, detect);
