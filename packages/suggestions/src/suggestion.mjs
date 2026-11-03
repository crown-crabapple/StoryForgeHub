import { createHash } from 'node:crypto';
import { Scalar, isMap, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import { diffGroups } from './diff.mjs';

export const SUGGESTION_SCHEMA = 'storyforge.suggestion/v1';

const HEADER_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@ (\S+)$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

export const sha256Hex = (s) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

const toText = (bytes) => (typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));

/**
 * Split file text into lines. `eol` is the file's own line ending (CRLF if the first line ends with one), `trailing` whether it ends with one.
 * Empty text has no lines.
 * @param {string|Uint8Array} bytes
 * @returns {{ lines: string[], eol: string, trailing: boolean }}
 */
export function splitLines(bytes) {
  const text = toText(bytes);
  if (text === '') return { lines: [], eol: '\n', trailing: false };
  const first = text.indexOf('\n');
  const eol = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let trailing = false;
  if (lines[lines.length - 1] === '') {
    lines.pop();
    trailing = true;
  }
  return { lines, eol, trailing };
}

/** Line diff between two texts as the hunks a suggestion would carry. */
export function lineDiff(baseBytes, proposedBytes) {
  const base = splitLines(baseBytes);
  const prop = splitLines(proposedBytes);
  const a = base.lines;
  const b = prop.lines;
  const hunks = [];
  let delta = 0;
  for (const g of diffGroups(a, b)) {
    let { aStart, aEnd, bStart, bEnd } = g;
    if (aStart === aEnd && a.length > 0) {
      // a pure insertion has no original line to find again later: anchor it on a neighbouring unchanged line
      if (aStart < a.length) {
        aEnd++;
        bEnd++;
      } else {
        aStart--;
        bStart--;
      }
    }
    const originalLines = a.slice(aStart, aEnd);
    const newLines = b.slice(bStart, bEnd);
    const line = a.length === 0 ? 1 : aStart + 1;
    hunks.push({ id: `h${hunks.length + 1}`, line, lines: originalLines.length, newLine: line + delta, newCount: newLines.length, originalLines, newLines, original_sha256: sha256Hex(originalLines.join(base.eol)), status: 'pending' });
    delta += newLines.length - originalLines.length;
  }
  return { hunks, eol: base.eol };
}

const PLAIN_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
function flow(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return PLAIN_RE.test(v) && !RESERVED.has(v.toLowerCase()) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${flow(k)}: ${flow(x)}`).join(', ')} }`;
}

const hunkEntry = (h) => `  - { id: ${h.id}, line: ${h.line}, lines: ${h.lines}, original_sha256: ${JSON.stringify(h.original_sha256)}, status: ${h.status}${h.decided ? `, decided: ${JSON.stringify(h.decided)}` : ''} }`;

/** Status written for readers: derived from the hunks. */
export function deriveStatus(hunks) {
  const s = hunks.map((h) => h.status);
  if (s.length > 0 && s.every((x) => x === 'pending')) return 'pending';
  if (s.length > 0 && s.every((x) => x === 'accepted')) return 'accepted';
  if (s.length > 0 && s.every((x) => x === 'declined')) return 'declined';
  return 'partial';
}

/**
 * A suggestion document for `proposedBytes` replacing `baseBytes`. Throws code NO_CHANGE when the lines are identical.
 * @returns {{ text: string, hunks: object[] }} the file text and its parsed hunks
 */
export function buildSuggestion({ id, targetId, targetPath, baseBytes, proposedBytes, source, mode, rationale, ai, created, by, plugin }) {
  const { hunks } = lineDiff(baseBytes, proposedBytes);
  if (hunks.length === 0) throw fail('NO_CHANGE', 'the proposed text is identical to the target');
  const isNew = !targetId;
  const baseSha = isNew ? '' : sha256Hex(typeof baseBytes === 'string' ? baseBytes : Buffer.from(baseBytes));
  const fm = [
    '---',
    `schema: ${SUGGESTION_SCHEMA}`,
    `id: ${id}`,
    `target: ${targetId ? flow(String(targetId)) : '""'}`,
    `target_path: ${JSON.stringify(targetPath ?? '')}`,
    `base_sha256: ${JSON.stringify(baseSha)}`,
    `source: ${source}`,
    `mode: ${mode}`,
    `created: ${JSON.stringify(created)}`,
  ];
  if (by && typeof by.name === 'string') fm.push(`by: ${flow(by.id ? { id: by.id, name: by.name } : { name: by.name })}`); // who made it (shared mode; FORMAT 9.3)
  if (source === 'plugin' && typeof plugin === 'string') fm.push(`plugin: ${plugin}`); // which plugin proposed it (M08-J02)
  fm.push('status: pending');
  if (source === 'ai' && ai) fm.push(`ai: ${flow(ai)}`);
  fm.push('hunks:', ...hunks.map(hunkEntry), '---');
  const diff = ['```diff'];
  for (const h of hunks) {
    diff.push(`@@ -${h.line},${h.lines} +${h.newLine},${h.newCount} @@ ${h.id}`);
    for (const l of h.originalLines) diff.push(`-${l}`);
    for (const l of h.newLines) diff.push(`+${l}`);
  }
  diff.push('```');
  const note = typeof rationale === 'string' && rationale.trim() ? `${rationale.trim()}\n\n` : '';
  const text = `${fm.join('\n')}\n${note}${diff.join('\n')}\n`;
  return { text, hunks: parseSuggestion(text).hunks };
}

function splitFrontMatter(text) {
  const lines = text.replace(/^\u{FEFF}/u, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') throw fail('SUGGESTION_MALFORMED', 'no front matter');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw fail('SUGGESTION_MALFORMED', 'front matter never closed');
  return { fmLines: lines.slice(1, close), body: lines.slice(close + 1) };
}

/**
 * @param {string} text suggestion file text
 * @returns {{ fm: object, hunks: { id: string, line: number, lines: number, originalLines: string[], newLines: string[], original_sha256: string, status: string, decided?: string }[], rationale: string }}
 */
export function parseSuggestion(text) {
  const { fmLines, body } = splitFrontMatter(text);
  let fm;
  try {
    fm = parseYaml(fmLines.join('\n'), { version: '1.2', schema: 'core' });
  } catch (e) {
    throw fail('SUGGESTION_MALFORMED', `front matter: ${String(e.message).split('\n')[0]}`);
  }
  if (!fm || typeof fm !== 'object' || !Array.isArray(fm.hunks)) throw fail('SUGGESTION_MALFORMED', 'hunks missing');
  let open = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i] === '```diff') {
      open = i;
      break;
    }
  }
  if (open < 0) throw fail('SUGGESTION_MALFORMED', 'diff block missing');
  let close = body.indexOf('```', open + 1);
  if (close < 0) close = body.length;
  const rationale = body.slice(0, open).join('\n').trim();
  const diffHunks = new Map();
  let cur = null;
  for (const l of body.slice(open + 1, close)) {
    const m = HEADER_RE.exec(l);
    if (m) {
      cur = { lines: Number(m[2]), count: Number(m[4]), originalLines: [], newLines: [] };
      diffHunks.set(m[5], cur);
    } else if (cur && l.startsWith('-')) cur.originalLines.push(l.slice(1));
    else if (cur && l.startsWith('+')) cur.newLines.push(l.slice(1));
    else if (l !== '') throw fail('SUGGESTION_MALFORMED', `unexpected diff line: ${l.slice(0, 40)}`);
  }
  const hunks = [];
  for (const e of fm.hunks) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !Number.isInteger(e.line) || !Number.isInteger(e.lines)) throw fail('SUGGESTION_MALFORMED', 'bad hunk entry');
    const d = diffHunks.get(e.id);
    if (!d) throw fail('SUGGESTION_MALFORMED', `hunk ${e.id} has no diff`);
    if (d.originalLines.length !== e.lines || d.lines !== e.lines || d.newLines.length !== d.count) throw fail('SUGGESTION_MALFORMED', `hunk ${e.id} line counts disagree with its diff`);
    hunks.push({ id: e.id, line: e.line, lines: e.lines, originalLines: d.originalLines, newLines: d.newLines, original_sha256: String(e.original_sha256 ?? ''), status: String(e.status ?? 'pending'), ...(e.decided ? { decided: String(e.decided) } : {}) });
  }
  return { fm, hunks, rationale };
}

/**
 * Replace one hunk's original lines in the target's bytes by its new lines. The lines are looked for at the hunk's `line` first, else at the
 * one place anywhere that hashes the same; none or several is SUGGESTION_STALE. The file's own line ending and final newline are kept.
 * @returns {{ ok: true, bytes: Buffer, at: number } | { ok: false, code: 'SUGGESTION_STALE' }}
 */
export function applyHunk(targetBytes, parsed, hunkId) {
  const h = parsed.hunks.find((x) => x.id === hunkId);
  if (!h) throw fail('NO_SUCH_HUNK', `no hunk ${hunkId}`);
  const { lines, eol, trailing } = splitLines(targetBytes);
  const stale = { ok: false, code: 'SUGGESTION_STALE' };
  const matches = (i) => i >= 0 && i + h.lines <= lines.length && sha256Hex(lines.slice(i, i + h.lines).join(eol)) === h.original_sha256;
  let at;
  if (h.lines === 0) {
    if (lines.length !== 0) return stale; // an insertion into an empty (new) file only
    at = 0;
  } else if (matches(h.line - 1)) at = h.line - 1;
  else {
    const found = [];
    for (let i = 0; i + h.lines <= lines.length; i++) if (matches(i)) found.push(i);
    if (found.length !== 1) return stale;
    at = found[0];
  }
  const out = [...lines.slice(0, at), ...h.newLines, ...lines.slice(at + h.lines)];
  const text = out.join(eol) + (trailing || lines.length === 0 ? eol : '');
  return { ok: true, bytes: Buffer.from(text, 'utf8'), at: at + 1 };
}

/**
 * Record a decision on hunks in the suggestion's text (front matter only; the diff block is untouched) and refresh the derived `status:`.
 * The front matter is edited as a YAML document, so its style (block or flow hunk entries, quoting, comments) is kept.
 * @param {string} text
 * @param {string[]} hunkIds
 * @param {'pending'|'accepted'|'declined'} status
 * @param {string} [decided] ISO time
 */
export function setHunkStatus(text, hunkIds, status, decided) {
  const ids = new Set(hunkIds);
  const lines = text.split('\n');
  const cr = lines[0].endsWith('\r') ? '\r' : '';
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      close = i;
      break;
    }
  }
  if (lines[0].replace(/\r$/, '') !== '---' || close < 0) throw fail('SUGGESTION_MALFORMED', 'no front matter');
  const doc = parseDocument(lines.slice(1, close).map((l) => l.replace(/\r$/, '')).join('\n'), { version: '1.2', schema: 'core' });
  const seq = doc.get('hunks', true);
  if (doc.errors.length > 0 || !isSeq(seq)) throw fail('SUGGESTION_MALFORMED', 'hunks missing');
  const seen = new Set();
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (!ids.has(id)) continue;
    seen.add(id);
    item.set('status', status);
    if (status === 'pending' || !decided) item.delete('decided');
    else item.set('decided', new Scalar(decided, { type: 'QUOTE_DOUBLE' }));
  }
  for (const id of ids) if (!seen.has(id)) throw fail('NO_SUCH_HUNK', `no hunk ${id}`);
  doc.set('status', deriveStatus(doc.toJS().hunks));
  const fm = doc.toString({ lineWidth: 0 }).replace(/\n$/, '').split('\n').map((l) => l + cr);
  return [lines[0], ...fm, ...lines.slice(close)].join('\n');
}

/**
 * Where a suggestion file lives: suggestions/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md (UTC time of `created`).
 * @param {string|Date} created
 * @param {string} slug
 */
export function suggestionPath(created, slug) {
  const d = created instanceof Date ? created : new Date(created);
  if (Number.isNaN(d.getTime())) throw fail('BAD_ARGS', 'created must be a date');
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const clean = String(slug ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'suggestion';
  return `suggestions/${p(d.getUTCFullYear(), 4)}/${stamp}-${clean}.md`;
}
