// The continuity review's projections (M05-J02). Pure: the views fetch GET /api/books/:b/continuity and these functions turn it into what is drawn.
// Findings are shown exactly as the engine reported them; the only narrowing is the filters the author chooses.
import { codexHref } from '../codex/model.js';
import { notesHref, sceneLineHref } from '../notes/model.js';
import { viewHref } from '../planning/model.js';
import { timelineHref } from '../timeline/model.js';

const enc = encodeURIComponent;

/** Plain names and descriptions of the rules (the engine's RULES table in words an author reads; the web bundle cannot import the engine). */
export const RULE_INFO = {
  CF1: { name: 'Fact conflict', description: 'A codex field (for example Eyes: Grey) and the text or a canon research note give different words for the same fact.' },
  TL1: { name: 'Timeline impossibility', description: 'Someone who is dead or destroyed takes part in a later event, one person is in two places at the same time, or a date runs backwards.' },
  KN1: { name: 'Character knowledge', description: 'A character is said to know something before any event teaches it to them.' },
  ST1: { name: 'Possession and location', description: 'A lost object is held or placed before it is found, or one object has two holders at the same time.' },
  TH1: { name: 'Thread lifecycle', description: 'A plot thread pays off before it is set up, or is planted and never resolved by the end of the book.' },
};
export const RULE_IDS = Object.keys(RULE_INFO);
/** @param {string} rule */
export const ruleName = (rule) => RULE_INFO[rule]?.name ?? rule;

export const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Info' };

/** The status filters of the queue's sidebar. */
export const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'error', label: 'Errors' },
  { key: 'warning', label: 'Warnings' },
  { key: 'info', label: 'Info' },
  { key: 'acknowledged', label: 'Acknowledged' },
];

/** /books/:id/continuity with the optional ?finding= (the fingerprint shown first) or ?suggestion= (a suggestion open for review, M05-J06). @param {string} bookId @param {{ finding?: string | null, suggestion?: string | null }} [q] */
export function continuityHref(bookId, { finding = null, suggestion = null } = {}) {
  const q = finding ? `?finding=${enc(finding)}` : suggestion ? `?suggestion=${enc(suggestion)}` : '';
  return `/books/${enc(bookId)}/continuity${q}`;
}

/** @param {string} search the query string of the URL @returns {{ finding: string | null, suggestion: string | null }} */
export function parseContinuitySearch(search = '') {
  const q = new URLSearchParams(search);
  return { finding: q.get('finding') || null, suggestion: q.get('suggestion') || null };
}

/** The findings that have a source in this scene (by scene ID), in the engine's order (errors first). @param {{ findings?: any[] } | null | undefined} result @param {string} sceneId */
export function findingsForScene(result, sceneId) {
  return (result?.findings ?? []).filter((f) => f.sources.some((s) => s.kind === 'scene' && s.id === sceneId));
}

/** "codex/characters/maren-hollis.md › Maren Hollis, line 13" @param {{ file: string, heading: string, line: number }} s */
export const sourceLabel = (s) => `${s.file} › ${s.heading}, line ${s.line}`;

/** Same subject, one key. @param {{ kind: string, id: string }} subject */
export const subjectKey = (subject) => `${subject.kind}:${subject.id}`;
/** @param {{ name?: string, slug?: string, id: string }} subject */
export const subjectLabel = (subject) => subject.name ?? subject.slug ?? subject.id;

/** Findings with their exception (acknowledged) in one list shape: { ...finding, exception } for the suppressed ones. @param {any} result */
export const acknowledgedRows = (result) => (result?.suppressed ?? []).map((s) => ({ ...s.finding, exception: s.exception }));

/**
 * What the queue shows for a filter: `status` ('all' | 'error' | 'warning' | 'info' | 'acknowledged'), `rule` (rule id or null) and `subject` (subjectKey or null).
 * `counts` are for the sidebar (before the rule and subject filters of their own group); `rules` / `subjects` list what exists in the shown set.
 * @param {any} result @param {{ status?: string, rule?: string | null, subject?: string | null }} [filter]
 */
export function queueModel(result, { status = 'all', rule = null, subject = null } = {}) {
  const live = result?.findings ?? [];
  const acknowledged = acknowledgedRows(result);
  const stale = result?.stale_exceptions ?? [];
  const base = status === 'acknowledged' ? acknowledged : status === 'all' ? live : live.filter((f) => f.severity === status);
  const rows = base.filter((f) => (rule === null || f.rule === rule) && (subject === null || subjectKey(f.subject) === subject));
  const subjects = new Map();
  for (const f of base) {
    const key = subjectKey(f.subject);
    const hit = subjects.get(key) ?? { key, label: subjectLabel(f.subject), count: 0 };
    hit.count += 1;
    subjects.set(key, hit);
  }
  const rules = RULE_IDS.map((id) => ({ id, name: ruleName(id), count: base.filter((f) => f.rule === id).length }));
  return {
    rows,
    stale: status === 'acknowledged' ? stale : [],
    counts: {
      all: live.length,
      error: live.filter((f) => f.severity === 'error').length,
      warning: live.filter((f) => f.severity === 'warning').length,
      info: live.filter((f) => f.severity === 'info').length,
      acknowledged: acknowledged.length + stale.length,
    },
    rules,
    subjects: [...subjects.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/** Find a finding (live or acknowledged) by fingerprint. @param {any} result @param {string | null} fingerprint */
export function findByFingerprint(result, fingerprint) {
  if (!fingerprint) return null;
  return (result?.findings ?? []).find((f) => f.fingerprint === fingerprint) ?? acknowledgedRows(result).find((f) => f.fingerprint === fingerprint) ?? null;
}

/** The row to focus after ArrowUp / ArrowDown / Home / End; null for any other key. @param {number} index @param {string} key @param {number} total */
export function nextRowIndex(index, key, total) {
  if (total === 0) return null;
  if (key === 'ArrowDown') return Math.min(total - 1, index + 1);
  if (key === 'ArrowUp') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return null;
}

/**
 * How many lines of a whole file come before its body (the front matter with both `---` lines), so a file line can be turned into a line of the editor text.
 * 0 when the file has no front matter. @param {string} fileText
 */
export function frontMatterLines(fileText) {
  const lines = fileText.replace(/^\uFEFF/, '').split('\n');
  if (lines[0]?.trimEnd() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return i + 1;
  return 0;
}

/** The 1-based line of the editor text for a 1-based file line; null when that line is in the front matter. @param {number} fileLine @param {number} frontLines */
export const bodyLineOf = (fileLine, frontLines) => (fileLine - frontLines >= 1 ? fileLine - frontLines : null);

/**
 * Where a source lives in the app. A scene opens in the editor at the body line when it is known (`bodyLine`), entries in the Codex, events in the Timeline,
 * threads in Threads, research notes in Notes.
 * @param {string} bookId @param {{ kind: string, id: string }} source @param {number | null} [bodyLine]
 */
export function sourceHref(bookId, source, bodyLine = null) {
  switch (source.kind) {
    case 'scene':
      return bodyLine ? sceneLineHref(bookId, source.id, bodyLine) : `/books/${enc(bookId)}?scene=${enc(source.id)}`;
    case 'entry':
      return codexHref(bookId, { entry: source.id });
    case 'event':
      return timelineHref(bookId, { event: source.id });
    case 'thread':
      return viewHref(bookId, 'threads', { thread: source.id });
    case 'research':
      return notesHref(bookId, { section: 'research', note: source.id });
    default:
      return `/books/${enc(bookId)}`;
  }
}

/** The text of an exception file after its front matter, trimmed: the author's rationale. @param {string} fileText */
export function rationaleOf(fileText) {
  const front = frontMatterLines(fileText);
  return fileText.replace(/^\uFEFF/, '').split('\n').slice(front).join('\n').trim();
}

/** The line is split around the evidence range: { before, mark, after }. A range outside the line is clipped; no range marks nothing. @param {string} text @param {{ from: number, to: number } | null} range */
export function splitEvidence(text, range) {
  if (!range) return { before: text, mark: '', after: '' };
  const from = Math.max(0, Math.min(text.length, range.from));
  const to = Math.max(from, Math.min(text.length, range.to));
  return { before: text.slice(0, from), mark: text.slice(from, to), after: text.slice(to) };
}

/**
 * The underline marks for the open scene's editor: one per scene source with an evidence range, as { line (of the editor text), from, to, title, fingerprint }.
 * `frontLines` is the number of front-matter lines of the file (the editor text starts after them).
 * @param {any[]} findings @param {string} sceneId @param {number} frontLines
 */
export function editorMarks(findings, sceneId, frontLines) {
  const out = [];
  for (const f of findings) {
    for (const s of f.sources) {
      if (s.kind !== 'scene' || s.id !== sceneId || !s.range) continue;
      const line = bodyLineOf(s.line, frontLines);
      if (line !== null) out.push({ line, from: s.range.from, to: s.range.to, title: f.title, fingerprint: f.fingerprint });
    }
  }
  return out;
}
