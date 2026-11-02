// Pure helpers for the AI workshop (M05-J04): addressing a selection inside a scene body, splicing a replacement into the file bytes,
// and rendering an optional AI record. No filesystem access; the write methods in fs-writes.mjs do the reading and writing through the store.
import YAML from 'yaml';

/**
 * Offsets the browser sends count characters of the body as the editor sees it: UTF-16 code units, every line break (LF or CRLF) counting 1.
 * This maps such an offset to the offset in the real text.
 * @param {string} body @param {number} lfOffset @returns {number}
 */
export function rawOffset(body, lfOffset) {
  if (!body.includes('\r\n')) return lfOffset;
  let raw = 0;
  let lf = 0;
  while (lf < lfOffset && raw < body.length) {
    if (body.charCodeAt(raw) === 13 && body.charCodeAt(raw + 1) === 10) raw += 2;
    else raw += 1;
    lf += 1;
  }
  return raw;
}

/** The body's line ending: CRLF when it is the larger count. @param {string} body @returns {'\n' | '\r\n'} */
export function bodyLineEnding(body) {
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * The selected text (line breaks as LF, as the editor and the model see it) and where it sits in the real body.
 * @param {Buffer} bytes the whole scene file @param {number} bodyStart byte offset where the body begins (after the front matter)
 * @param {number} from @param {number} to editor offsets into the body, 0 <= from < to
 * @returns {{ ok: true, text: string, body: string, rawFrom: number, rawTo: number, byteFrom: number, byteTo: number }
 *   | { ok: false, code: 'BAD_SELECTION' | 'NOT_UTF8', message: string }}
 */
export function selectRange(bytes, bodyStart, from, to) {
  const bodyBytes = bytes.subarray(bodyStart);
  const body = bodyBytes.toString('utf8');
  if (!Buffer.from(body, 'utf8').equals(bodyBytes)) return { ok: false, code: 'NOT_UTF8', message: 'the scene is not valid UTF-8 text' };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) return { ok: false, code: 'BAD_SELECTION', message: 'the selection must be a range with from < to' };
  const rawFrom = rawOffset(body, from);
  const rawTo = rawOffset(body, to);
  const lfLength = body.replace(/\r\n/g, '\n').length;
  if (to > lfLength) return { ok: false, code: 'BAD_SELECTION', message: 'the selection is past the end of the scene' };
  const text = body.slice(rawFrom, rawTo).replace(/\r\n/g, '\n');
  return {
    ok: true,
    text,
    body,
    rawFrom,
    rawTo,
    byteFrom: bodyStart + Buffer.byteLength(body.slice(0, rawFrom), 'utf8'),
    byteTo: bodyStart + Buffer.byteLength(body.slice(0, rawTo), 'utf8'),
  };
}

/**
 * The new file bytes: everything outside the selected range is copied byte for byte. Line breaks in the replacement follow the scene's own ending.
 * @param {Buffer} bytes @param {{ byteFrom: number, byteTo: number, body: string }} range from selectRange() @param {string} replacement
 * @returns {Buffer}
 */
export function spliceReplacement(bytes, range, replacement) {
  const ending = bodyLineEnding(range.body);
  const text = replacement.replace(/\r\n|\r/g, '\n').replace(/\n/g, ending);
  return Buffer.concat([bytes.subarray(0, range.byteFrom), Buffer.from(text, 'utf8'), bytes.subarray(range.byteTo)]);
}

/** A Markdown fence long enough to hold `text`, with `text` inside; nothing in it is ever read as a link or heading. @param {string} text */
function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${text.replace(/\n$/, '')}\n${ticks}\n`;
}

/**
 * The text of an AI record file (schema storyforge.ai-record/v1): front matter, then the instruction and the reply (and for a rewrite the selected
 * text) each in a fence; the full context only when `contextMessages` is given. No key is ever part of a record.
 * @param {{ id: string, created: string, task: string, provider: string, model: string, locality: string, contextSha256: string,
 *   files: { path: string, sha256: string }[], applied: boolean, instruction: string, reply: string, selectedText?: string,
 *   contextMessages?: { role: string, content: string }[] }} r
 * @returns {string}
 */
export function renderAiRecord(r) {
  const fm = {
    schema: 'storyforge.ai-record/v1',
    id: r.id,
    created: r.created,
    task: r.task,
    provider: r.provider,
    model: r.model,
    locality: r.locality,
    contextSha256: r.contextSha256,
    files: r.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    applied: r.applied,
    ...(r.contextMessages ? { fullContext: true } : {}),
  };
  let body = `## Instruction\n\n${fenced(r.instruction)}\n`;
  if (r.selectedText !== undefined) body += `## Selected text\n\n${fenced(r.selectedText)}\n`;
  body += `## Reply\n\n${fenced(r.reply)}\n`;
  if (r.contextMessages) body += `## Context\n\n${r.contextMessages.map((m) => `### ${m.role}\n\n${fenced(m.content)}`).join('\n')}`;
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body.replace(/\n+$/, '')}\n`;
}

/** Folder and file name of a new record, from the local time: ai/<YYYY>/<YYYYMMDD-HHMMSS>-<task>.md. @param {Date} at @param {string} task */
export function recordPath(at, task) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `ai/${p(at.getFullYear(), 4)}/${stamp}-${task}.md`;
}
