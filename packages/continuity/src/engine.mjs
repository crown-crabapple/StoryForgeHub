// checkContinuity: load the book through @storyforge/format, run every rule, apply exceptions, order the result.
// Read-only: no file is written and `.storyforge/` is never read.
import { loadModel } from './model.mjs';
import { factConflicts } from './facts.mjs';
import { timelineFindings } from './timeline.mjs';
import { threadFindings } from './threads.mjs';
import { plannerFindings } from './planner.mjs';
import { castFindings, chapterOfEvent } from './cast.mjs';

/**
 * @typedef {import('./model.mjs').Source} Source
 * @typedef {{ fingerprint: string, rule: string, rule_version: number, severity: 'error'|'warning'|'info', title: string, message: string,
 *   planned?: true, subject: { kind: 'entry'|'thread'|'event'|'scene'|'structure'|'clue', id: string, slug?: string, name?: string }, sources: Source[], related: string[] }} Finding
 * @typedef {{ engine_version: 1, findings: Finding[], suppressed: { finding: Finding, exception: { file: string, slug: string, intentional: boolean } }[],
 *   stale_exceptions: { file: string, slug: string, fingerprint: string }[], skipped: string[], settings: { overdue_chapters: number, severity: Record<string, string> } }} ContinuityResult
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
 * Does a finding touch chapter `chapter`: a related or source scene in it, an event that belongs to it, or a planned-cast finding for it.
 * @param {Finding} f @param {number} chapter @param {import('./model.mjs').Model} model
 */
function touchesChapter(f, chapter, model) {
  if (f.planned) return true;
  const sceneChapter = new Map(model.scenes.map((s) => [s.doc.fm.id, s.doc.fm.chapter]));
  const eventChapters = (/** @type {string} */ id) => {
    const e = model.events.find((x) => x.fm.id === id);
    if (!e) return [];
    return [...(model.eventScenes.get(e) ?? []).map((s) => s.doc.fm.chapter), chapterOfEvent(model, e)];
  };
  const ids = [...f.related, ...f.sources.map((s) => s.id), f.subject.id];
  return ids.some((id) => sceneChapter.get(id) === chapter || eventChapters(id).includes(chapter));
}

/**
 * @param {string} bookRoot a book folder (the one with book.md)
 * @param {{ chapter?: number, cast?: { entry: string, role: string }[] }} [opts] `chapter`: only findings that touch that chapter; `cast` (with `chapter`): also check that
 *   planned cast for CS1 and CS2, as if it were a scene of that chapter (a pre-flight check for a chapter not written yet)
 * @returns {Promise<ContinuityResult>}
 */
export async function checkContinuity(bookRoot, opts = {}) {
  const model = await loadModel(bookRoot);
  const { settings } = model;
  const chapter = Number.isInteger(opts?.chapter) ? /** @type {number} */ (opts.chapter) : undefined;
  // `related`: extra ids (scenes, beats) a canvas can mark; [] for rules that do not set it. Not part of the fingerprint.
  const all = [...(await factConflicts(model)), ...(await timelineFindings(model)), ...(await threadFindings(model, { overdueChapters: settings.overdue_chapters })), ...(await plannerFindings(model)), ...(await castFindings(model, { chapter, cast: opts?.cast }))].map((f) => ({ ...f, related: f.related ?? [] }));
  const seen = new Set();
  const deduped = all.filter((f) => !seen.has(f.fingerprint) && seen.add(f.fingerprint));
  // settings: a rule set to 'off' is skipped, another word replaces the rule's severity; fingerprints do not depend on severity
  const found = deduped
    .filter((f) => settings.severity[f.rule] !== 'off')
    .map((f) => (settings.severity[f.rule] && settings.severity[f.rule] !== 'off' ? { ...f, severity: /** @type {'error'|'warning'|'info'} */ (settings.severity[f.rule]) } : f))
    .filter((f) => chapter === undefined || touchesChapter(f, chapter, model))
    .sort(byOrder);

  /** @type {Map<string, { file: string, slug: string, intentional: boolean }>} first exception per fingerprint (files are sorted) */
  const exceptionFor = new Map();
  for (const x of model.exceptions) {
    if (!exceptionFor.has(x.fm.fingerprint)) exceptionFor.set(x.fm.fingerprint, { file: x.file, slug: String(x.fm.slug ?? ''), intentional: x.fm.intentional === true });
  }
  const findings = found.filter((f) => !exceptionFor.has(f.fingerprint));
  const suppressed = found.filter((f) => exceptionFor.has(f.fingerprint)).map((finding) => ({ finding, exception: exceptionFor.get(finding.fingerprint) }));
  const current = new Set(deduped.map((f) => f.fingerprint));
  const stale_exceptions = model.exceptions
    .filter((x) => !current.has(x.fm.fingerprint))
    .map((x) => ({ file: x.file, slug: String(x.fm.slug ?? ''), fingerprint: x.fm.fingerprint }));

  return { engine_version: 1, findings, suppressed, stale_exceptions, skipped: model.skipped, settings };
}
