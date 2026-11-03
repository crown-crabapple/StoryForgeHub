// Front matter of a document's text, parsed leniently (a broken file gives {}), for the goals, tasks and insights readers. Reads nothing itself.
import { parse } from 'yaml';

/**
 * @param {string} text
 * @returns {{ fm: Record<string, any>, body: string, bodyStartLine: number }} `bodyStartLine` is the 1-based file line of the body's first line
 */
export function parseFrontMatter(text) {
  const t = text.startsWith('﻿') ? text.slice(1) : text;
  const firstEnd = t.indexOf('\n');
  if (firstEnd < 0 || t.slice(0, firstEnd).replace(/\r$/, '') !== '---') return { fm: {}, body: t, bodyStartLine: 1 };
  let pos = firstEnd + 1;
  let line = 2;
  while (pos <= t.length) {
    const e = t.indexOf('\n', pos);
    const lineEnd = e < 0 ? t.length : e;
    if (t.slice(pos, lineEnd).replace(/\r$/, '') === '---') {
      let fm = {};
      try {
        const v = parse(t.slice(firstEnd + 1, pos), { version: '1.2', schema: 'core' });
        if (v && typeof v === 'object' && !Array.isArray(v)) fm = v;
      } catch {
        fm = {};
      }
      return { fm, body: e < 0 ? '' : t.slice(e + 1), bodyStartLine: line + 1 };
    }
    if (e < 0) break;
    pos = e + 1;
    line++;
  }
  return { fm: {}, body: t, bodyStartLine: 1 };
}
