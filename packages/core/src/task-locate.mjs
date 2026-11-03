// Finding a task target's text in its scene (M07-J02 section 4): the line first, then the one place the quote occurs. Never guesses. Pure.
// This is the locating rule of suggestion hunks (applyHunk in @storyforge/suggestions): `line` first, else the single other place; none or several is "not found".
import { parseFrontMatter } from './fm.mjs';

/**
 * @typedef {{ found: boolean, reason: 'ok' | 'no_quote' | 'not_found' | 'several' | 'line_outside', selection: { line: number, file_line: number, from: number, to: number, text: string } | null }} Located
 */

/**
 * Where a target's text is in a scene file. `selection` positions are in the body with line breaks as `\n` (what the editor shows):
 * `line` is the 1-based body line, `file_line` the 1-based line of the whole file, `from` / `to` character offsets in the body.
 * - A target with a `quote`: found at `line` when that file line holds the quote; else found when the quote occurs exactly once in the body.
 * - A target with only a `line`: that whole line (without its line break) when it is in the body.
 * - A target with neither: found, no selection (the scene just opens).
 * @param {string} fileText the whole scene file
 * @param {{ line?: number, quote?: string }} target
 * @returns {Located}
 */
export function locateTarget(fileText, target) {
  const { body, bodyStartLine } = parseFrontMatter(fileText);
  const text = body.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const starts = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const quote = typeof target.quote === 'string' ? target.quote : '';
  const line = Number.isInteger(target.line) ? /** @type {number} */ (target.line) : null;
  const bodyLine = line === null ? null : line - bodyStartLine + 1;
  const inBody = bodyLine !== null && bodyLine >= 1 && bodyLine <= lines.length;
  const sel = (from, to, ln) => ({ line: ln, file_line: ln + bodyStartLine - 1, from, to, text: text.slice(from, to) });

  if (quote === '') {
    if (line === null) return { found: true, reason: 'no_quote', selection: null };
    if (!inBody) return { found: false, reason: 'line_outside', selection: null };
    const n = /** @type {number} */ (bodyLine);
    return { found: true, reason: 'ok', selection: sel(starts[n - 1], starts[n - 1] + lines[n - 1].length, n) };
  }
  if (inBody) {
    const n = /** @type {number} */ (bodyLine);
    const col = lines[n - 1].indexOf(quote);
    if (col >= 0) return { found: true, reason: 'ok', selection: sel(starts[n - 1] + col, starts[n - 1] + col + quote.length, n) };
  }
  const hits = [];
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) hits.push(i);
  if (hits.length !== 1) return { found: false, reason: hits.length === 0 ? 'not_found' : 'several', selection: null };
  let n = 1;
  while (n < lines.length && starts[n] <= hits[0]) n++;
  return { found: true, reason: 'ok', selection: sel(hits[0], hits[0] + quote.length, n) };
}

/** The sentence the Tasks page shows when a target is not found. @param {Located['reason']} reason */
export function notFoundMessage(reason) {
  if (reason === 'several') return 'The quote now occurs in more than one place, so StoryForge did not guess. The scene is open.';
  if (reason === 'line_outside') return 'That line is no longer in the scene. The scene is open.';
  return 'The quote can no longer be found in the scene. It was probably reworded. The scene is open.';
}
