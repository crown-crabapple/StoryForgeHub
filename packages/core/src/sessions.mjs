// activity/sessions/<YYYY>/<YYYY-MM>.md (FORMAT-v1 section 9.1b): parse the rows, append one row. Pure.
// Lines the app cannot parse are kept as they are and skipped; an append changes nothing but the new line.
import { ulid } from '@storyforge/manuscript';

export const SESSIONS_DIR = 'activity/sessions';
export const SESSIONS_HEADER = '| Start | End | Minutes | Added | Removed | Kind | Scenes |';
export const SESSIONS_SEPARATOR = '|---|---|---|---|---|---|---|';
export const SESSION_KINDS = ['session', 'sprint', 'timer'];

const ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*\|\s*(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(session|sprint|timer)\s*\|([^|]*)\|\s*$/;
const HEADER_RE = /^\|\s*Start\s*\|/i;

/** @typedef {{ start: string, end: string, minutes: number, added: number, removed: number, kind: 'session'|'sprint'|'timer', scenes: string[] }} SessionRow */

const p2 = (n) => String(n).padStart(2, '0');

/** The file of a session that started at `when` (the author's local year and month). @param {Date | number} when */
export function sessionsPath(when) {
  const d = new Date(when);
  return `${SESSIONS_DIR}/${d.getFullYear()}/${d.getFullYear()}-${p2(d.getMonth() + 1)}.md`;
}

/** ISO time without milliseconds, UTC. @param {Date | number} when */
export const isoSecond = (when) => new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The rows the app understands. @param {string} text @returns {SessionRow[]} */
export function parseSessions(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = ROW_RE.exec(line.replace(/\r$/, ''));
    if (m) {
      rows.push({
        start: m[1], end: m[2], minutes: Number(m[3]), added: Number(m[4]), removed: Number(m[5]), kind: /** @type {any} */ (m[6]),
        scenes: m[7].split(/\s+/).filter(Boolean),
      });
    }
  }
  return rows;
}

/** @param {SessionRow} r */
export const rowLine = (r) => `| ${r.start} | ${r.end} | ${r.minutes} | ${r.added} | ${r.removed} | ${r.kind} | ${r.scenes.join(' ')} |`;

/** A new sessions file with no rows. @param {string} month YYYY-MM @param {string} [id] */
export function newSessionsFile(month, id = `note_${ulid()}`) {
  return `---\nschema: storyforge.doc/v1\nid: ${id}\ntitle: Sessions ${month}\n---\n\n${SESSIONS_HEADER}\n${SESSIONS_SEPARATOR}\n`;
}

/**
 * Add one row after the table's last row (a new table at the end when there is none). Every other byte of `text` stays.
 * @param {string} text the current file @param {SessionRow} row @returns {string}
 */
export function appendSession(text, row) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fresh = rowLine(row);
  const parts = text.split('\n');
  let header = -1;
  for (let i = 0; i < parts.length; i++) {
    if (HEADER_RE.test(parts[i].replace(/\r$/, ''))) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    const base = text.endsWith('\n') || text === '' ? text : text + eol;
    return `${base}${text === '' ? '' : eol}${SESSIONS_HEADER}${eol}${SESSIONS_SEPARATOR}${eol}${fresh}${eol}`;
  }
  let end = header + 1;
  while (end + 1 < parts.length && parts[end + 1].trim().startsWith('|')) end++;
  if (end + 1 >= parts.length) {
    // the table is the last thing in a file with no final line break
    if (eol === '\r\n' && !parts[end].endsWith('\r')) parts[end] += '\r';
    parts.push(fresh);
  } else parts.splice(end + 1, 0, fresh + (eol === '\r\n' ? '\r' : ''));
  return parts.join('\n');
}
