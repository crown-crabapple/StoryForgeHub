// activity/ai-usage.md (FORMAT-v1 section 9.1c): one row per day, profile and locality with the number of requests and the tokens used. Pure.
// Counts only: no prompt, reply or file name ever goes into this file. Lines the app cannot parse are kept as they are and skipped.
import { ulid } from '@storyforge/manuscript';

export const USAGE_PATH = 'activity/ai-usage.md';
export const USAGE_HEADER = '| Date | Profile | Locality | Requests | Prompt tokens | Completion tokens | Estimated |';
export const USAGE_SEPARATOR = '|---|---|---|---|---|---|---|';

const ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|\s*(local|cloud)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/;
const HEADER_RE = /^\|\s*Date\s*\|/i;

/** @typedef {{ date: string, profile: string, locality: 'local' | 'cloud', requests: number, promptTokens: number, completionTokens: number, estimated: number }} UsageRow */

/** A profile name as a table cell: no pipes or line breaks. @param {string} name */
export const cellName = (name) => String(name).replace(/[|\r\n]+/g, ' ').trim().slice(0, 80) || 'provider';

/** @param {string} text @returns {UsageRow[]} */
export function parseAiUsage(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = ROW_RE.exec(line.replace(/\r$/, ''));
    if (m) rows.push({ date: m[1], profile: m[2].trim(), locality: /** @type {any} */ (m[3]), requests: Number(m[4]), promptTokens: Number(m[5]), completionTokens: Number(m[6]), estimated: Number(m[7]) });
  }
  return rows;
}

const rowLine = (r) => `| ${r.date} | ${r.profile} | ${r.locality} | ${r.requests} | ${r.promptTokens} | ${r.completionTokens} | ${r.estimated} |`;

/** A new file with no rows. @param {string} [id] */
export function newAiUsage(id = `note_${ulid()}`) {
  return `---\nschema: storyforge.doc/v1\nid: ${id}\ntitle: AI usage\n---\n\nToken counts per day, profile and locality. "Estimated" is how many of the requests had no usage reported by the provider (their tokens are characters / 4). Counts only: nothing here is ever sent anywhere.\n\n${USAGE_HEADER}\n${USAGE_SEPARATOR}\n`;
}

/**
 * Add one request to the row of its day, profile and locality (the row is created when missing), changing only that line. Every other byte of `text` stays.
 * @param {string} text the current file @param {{ date: string, profile: string, locality: 'local' | 'cloud', promptTokens: number, completionTokens: number, estimated: boolean }} u
 */
export function applyAiUsage(text, u) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const profile = cellName(u.profile);
  const parts = text.split('\n');
  const strip = (i) => parts[i].replace(/\r$/, '');
  const tail = (i) => (parts[i].endsWith('\r') ? '\r' : '');
  for (let i = 0; i < parts.length; i++) {
    const m = ROW_RE.exec(strip(i));
    if (!m || m[1] !== u.date || m[2].trim() !== profile || m[3] !== u.locality) continue;
    const next = {
      date: u.date, profile, locality: u.locality,
      requests: Number(m[4]) + 1,
      promptTokens: Number(m[5]) + u.promptTokens,
      completionTokens: Number(m[6]) + u.completionTokens,
      estimated: Number(m[7]) + (u.estimated ? 1 : 0),
    };
    parts[i] = rowLine(next) + tail(i);
    return parts.join('\n');
  }
  const fresh = rowLine({ date: u.date, profile, locality: u.locality, requests: 1, promptTokens: u.promptTokens, completionTokens: u.completionTokens, estimated: u.estimated ? 1 : 0 });
  let header = -1;
  for (let i = 0; i < parts.length; i++) {
    if (HEADER_RE.test(strip(i))) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    const base = text.endsWith('\n') || text === '' ? text : text + eol;
    return `${base}${text === '' ? '' : eol}${USAGE_HEADER}${eol}${USAGE_SEPARATOR}${eol}${fresh}${eol}`;
  }
  let end = header + 1;
  while (end + 1 < parts.length && parts[end + 1].trim().startsWith('|')) end++;
  if (end + 1 >= parts.length) {
    if (eol === '\r\n' && !parts[end].endsWith('\r')) parts[end] += '\r';
    parts.push(fresh);
  } else parts.splice(end + 1, 0, fresh + (eol === '\r\n' ? '\r' : ''));
  return parts.join('\n');
}
