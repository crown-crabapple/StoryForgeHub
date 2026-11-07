// checkContinuity: load the book through @storyforge/format, run every rule, apply exceptions, order the result.
// Read-only: no file is written and `.storyforge/` is never read.
import { loadModel } from './model.mjs';
import { factConflicts } from './facts.mjs';
import { timelineFindings } from './timeline.mjs';
import { threadFindings } from './threads.mjs';
import { plannerFindings } from './planner.mjs';

/**
 * @typedef {import('./model.mjs').Source} Source
 * @typedef {{ fingerprint: string, rule: string, rule_version: number, severity: 'error'|'warning'|'info', title: string, message: string,
 *   subject: { kind: 'entry'|'thread'|'event'|'scene'|'structure'|'clue', id: string, slug?: string, name?: string }, sources: Source[] }} Finding
 * @typedef {{ engine_version: 1, findings: Finding[], suppressed: { finding: Finding, exception: { file: string, slug: string, intentional: boolean } }[],
 *   stale_exceptions: { file: string, slug: string, fingerprint: string }[], skipped: string[] }} ContinuityResult
 */

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Severity, rule id, first source file, line, fingerprint (contract 2.2). @param {Finding} a @param {Finding} b */
const byOrder = (a, b) =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
  cmp(a.rule, b.rule) ||
  cmp(a.sources[0].file, b.sources[0].file) ||
  a.sources[0].line - b.sources[0].line ||
  cmp(a.fingerprint, b.fingerprint);

/**
 * @param {string} bookRoot a book folder (the one with book.md)
 * @param {object} [_opts] reserved
 * @returns {Promise<ContinuityResult>}
 */
export async function checkContinuity(bookRoot, _opts = {}) { // eslint-disable-line no-unused-vars
  const model = await loadModel(bookRoot);
  const all = [...(await factConflicts(model)), ...(await timelineFindings(model)), ...(await threadFindings(model)), ...(await plannerFindings(model))];
  const seen = new Set();
  const found = all.filter((f) => !seen.has(f.fingerprint) && seen.add(f.fingerprint)).sort(byOrder);

  /** @type {Map<string, { file: string, slug: string, intentional: boolean }>} first exception per fingerprint (files are sorted) */
  const exceptionFor = new Map();
  for (const x of model.exceptions) {
    if (!exceptionFor.has(x.fm.fingerprint)) exceptionFor.set(x.fm.fingerprint, { file: x.file, slug: String(x.fm.slug ?? ''), intentional: x.fm.intentional === true });
  }
  const findings = found.filter((f) => !exceptionFor.has(f.fingerprint));
  const suppressed = found.filter((f) => exceptionFor.has(f.fingerprint)).map((finding) => ({ finding, exception: exceptionFor.get(finding.fingerprint) }));
  const current = new Set(found.map((f) => f.fingerprint));
  const stale_exceptions = model.exceptions
    .filter((x) => !current.has(x.fm.fingerprint))
    .map((x) => ({ file: x.file, slug: String(x.fm.slug ?? ''), fingerprint: x.fm.fingerprint }));

  return { engine_version: 1, findings, suppressed, stale_exceptions, skipped: model.skipped };
}
