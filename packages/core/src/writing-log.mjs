// activity/writing-log.md (FORMAT-v1 section 9.1): parse, update one day's row in place, and the streak. Pure.
// M12 W3: an optional trailing column `AI words` (words an AI wrote that day). Old files without it parse as 0; the column is written only to a row that has AI words
// (and then added to the table's header and separator once).
import { ulid } from '@storyforge/manuscript';

export const LOG_PATH = 'activity/writing-log.md';
export const LOG_HEADER = '| Date | Words added | Words removed | Minutes | Sessions |';
export const LOG_SEPARATOR = '|---|---|---|---|---|';
export const AI_COLUMN = 'AI words';

const ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|(?:\s*(\d+)\s*\|)?\s*$/;
const HEADER_RE = /^\|\s*Date\s*\|/i;

/** The author's local date (ISO) for a time. @param {Date | number} when */
export function localDate(when) {
  const d = new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The ISO date `n` days after `date` (n may be negative). @param {string} date @param {number} n */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Rows the app understands. Lines it cannot parse are skipped (and never changed).
 * @param {string} text the whole file
 * @returns {{ date: string, added: number, removed: number, minutes: number, sessions: number, ai: number }[]}
 */
export function parseWritingLog(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = ROW_RE.exec(line.replace(/\r$/, ''));
    if (m) rows.push({ date: m[1], added: Number(m[2]), removed: Number(m[3]), minutes: Number(m[4]), sessions: Number(m[5]), ai: Number(m[6] ?? 0) });
  }
  return rows;
}

const rowLine = (r) => `| ${r.date} | ${r.added} | ${r.removed} | ${r.minutes} | ${r.sessions} |${r.ai > 0 ? ` ${r.ai} |` : ''}`;

/** A new writing-log file with no rows. @param {string} [id] a note_ id (default: a fresh one) */
export function newWritingLog(id = `note_${ulid()}`) {
  return `---\nschema: storyforge.doc/v1\nid: ${id}\ntitle: Writing log\n---\n\n${LOG_HEADER}\n${LOG_SEPARATOR}\n`;
}

/** The table's header and separator lines get the `AI words` column (once) when `needed`; a table that has it, or no table, is left as it is. @param {string[]} parts the lines @param {boolean} needed */
function withAiHeader(parts, needed) {
  if (!needed) return parts;
  const h = parts.findIndex((l) => HEADER_RE.test(l.replace(/\r$/, '')));
  if (h < 0 || parts[h].includes(AI_COLUMN)) return parts;
  const cr = (l) => (l.endsWith('\r') ? '\r' : '');
  parts[h] = `${parts[h].replace(/\s*\|?\s*\r?$/, '')} | ${AI_COLUMN} |${cr(parts[h])}`;
  if (h + 1 < parts.length && /^\|[\s|:-]+\|\s*$/.test(parts[h + 1].replace(/\r$/, ''))) parts[h + 1] = `${parts[h + 1].replace(/\s*\r?$/, '')}---|${cr(parts[h + 1])}`;
  return parts;
}

/**
 * Add `delta` to the row for `date` (created when missing), changing only that line. Every other byte of `text` stays.
 * @param {string} text the current file
 * @param {string} date ISO date
 * @param {{ added?: number, removed?: number, minutes?: number, sessions?: number, ai?: number }} delta
 * @returns {string}
 */
export function applyToWritingLog(text, date, delta) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split('\n');
  const isRow = (i) => ROW_RE.test(parts[i].replace(/\r$/, ''));
  const rowAt = (i) => {
    const m = ROW_RE.exec(parts[i].replace(/\r$/, ''));
    return { date: m[1], added: Number(m[2]), removed: Number(m[3]), minutes: Number(m[4]), sessions: Number(m[5]), ai: Number(m[6] ?? 0) };
  };
  const tail = (i) => (parts[i].endsWith('\r') ? '\r' : '');
  for (let i = 0; i < parts.length; i++) {
    if (!isRow(i) || rowAt(i).date !== date) continue;
    const r = rowAt(i);
    const next = {
      date,
      added: r.added + (delta.added ?? 0),
      removed: r.removed + (delta.removed ?? 0),
      minutes: r.minutes + (delta.minutes ?? 0),
      sessions: r.sessions + (delta.sessions ?? 0),
      ai: r.ai + (delta.ai ?? 0),
    };
    parts[i] = rowLine(next) + tail(i);
    return withAiHeader(parts, next.ai > 0).join('\n');
  }
  const fresh = rowLine({ date, added: delta.added ?? 0, removed: delta.removed ?? 0, minutes: delta.minutes ?? 0, sessions: delta.sessions ?? 0, ai: delta.ai ?? 0 });
  let header = -1;
  for (let i = 0; i < parts.length; i++) {
    if (HEADER_RE.test(parts[i].replace(/\r$/, ''))) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    // no table yet: add one at the end
    const base = text.endsWith('\n') || text === '' ? text : text + eol;
    return withAiHeader(`${base}${text === '' ? '' : eol}${LOG_HEADER}${eol}${LOG_SEPARATOR}${eol}${fresh}${eol}`.split('\n'), (delta.ai ?? 0) > 0).join('\n');
  }
  // the table block: header, separator, then consecutive lines that start with a pipe
  let end = header + 1;
  while (end + 1 < parts.length && parts[end + 1].trim().startsWith('|')) end++;
  // newest day last: go before the first row with a later date, else after the block
  let at = end + 1;
  for (let i = header + 2; i <= end; i++) {
    if (isRow(i) && rowAt(i).date > date) {
      at = i;
      break;
    }
  }
  if (at === parts.length) {
    // the table is the last thing in a file with no final line break
    if (eol === '\r\n' && !parts[at - 1].endsWith('\r')) parts[at - 1] += '\r';
    parts.push(fresh);
  } else parts.splice(at, 0, fresh + (eol === '\r\n' ? '\r' : ''));
  return withAiHeader(parts, (delta.ai ?? 0) > 0).join('\n');
}

/**
 * Consecutive days, ending today (or yesterday while today is still short of the goal), with net words (added - removed) >= goal.
 * @param {{ date: string, added: number, removed: number }[]} rows
 * @param {number | null | undefined} goal
 * @param {string} today ISO date
 */
export function computeStreak(rows, goal, today) {
  if (!Number.isInteger(goal) || /** @type {number} */ (goal) < 1) return 0;
  const net = new Map();
  for (const r of rows) net.set(r.date, (net.get(r.date) ?? 0) + r.added - r.removed);
  const met = (d) => (net.get(d) ?? 0) >= /** @type {number} */ (goal);
  let day = met(today) ? today : addDays(today, -1);
  let n = 0;
  while (met(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}
