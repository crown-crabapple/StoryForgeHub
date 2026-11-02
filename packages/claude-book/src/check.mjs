// check (contract M05-J06 section 3): validator diagnostics, continuity findings and style-checker signals for one
// chapter or scene, as a report. Read-only on the book; no model, no humanizer, no network.
import path from 'node:path';
import { validate, extractLinks } from '@storyforge/format';
import { checkContinuity } from '@storyforge/continuity';
import { readText } from './io.mjs';
import { pad2 } from './pack.mjs';

/** @typedef {import('./model.mjs').Model} Model */
/**
 * @typedef {{ severity: 'error'|'warning'|'info', kind: 'diagnostic'|'continuity'|'style', code: string, file: string, line: number|null,
 *   range: {from:number,to:number}|null, evidence: string, message: string, fingerprint?: string }} CheckFinding
 */

const RANK = { error: 0, warning: 1, info: 2 };
const clip = (s) => (s.length <= 200 ? s : `${s.slice(0, 199)}…`);

/** Text of a book file split into lines, or null. @param {string} root @param {string} file */
function linesOf(root, file) {
  try {
    return readText(path.join(root, ...file.split('/'))).split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Line (1-based) of a diagnostic: "line N", or the front matter key a field path starts with. */
function lineOfLocation(lines, location) {
  const m = /^line (\d+)/.exec(location);
  if (m) return Number(m[1]);
  const key = /^[A-Za-z0-9_-]+/.exec(location)?.[0];
  if (lines && key) {
    const at = lines.findIndex((l, i) => i > 0 && new RegExp(`^${key}:`).test(l));
    if (at >= 0) return at + 1;
  }
  return 1;
}

/**
 * Validator diagnostics for the target files and the files they link to.
 * @param {Model} model @param {string[]} targetFiles
 * @returns {Promise<CheckFinding[]>}
 */
async function diagnosticFindings(model, targetFiles) {
  const result = await validate(model.root);
  const targets = new Set(targetFiles);
  const byId = new Map(model.docs.filter((d) => typeof d.fm.id === 'string').map((d) => [d.fm.id, d.file]));
  for (const l of extractLinks(result, '')) {
    if (!targetFiles.includes(l.src_path)) continue;
    const f = l.target_id ? byId.get(l.target_id) : null;
    if (f) targets.add(f);
  }
  const out = [];
  for (const d of result.diagnostics) {
    if (!targets.has(d.file)) continue;
    const lines = linesOf(model.root, d.file);
    const line = lineOfLocation(lines, d.location);
    out.push({
      severity: d.severity,
      kind: 'diagnostic',
      code: d.code,
      file: d.file,
      line,
      range: null,
      evidence: clip((lines?.[line - 1] ?? d.location ?? '').trim()),
      message: d.message,
    });
  }
  return out;
}

/**
 * Continuity findings with at least one source in a target file.
 * @param {Model} model @param {string[]} targetFiles
 * @returns {Promise<CheckFinding[]>}
 */
async function continuityFindings(model, targetFiles) {
  const targets = new Set(targetFiles);
  const result = await checkContinuity(model.root);
  const out = [];
  for (const f of result.findings) {
    const inTarget = f.sources.filter((s) => targets.has(s.file));
    if (inTarget.length === 0) continue;
    const s = inTarget.find((x) => x.role === 'text') ?? inTarget[0];
    out.push({
      severity: f.severity,
      kind: 'continuity',
      code: f.rule,
      file: s.file,
      line: s.line,
      range: s.range ?? null,
      evidence: clip(s.excerpt ?? ''),
      message: f.message,
      fingerprint: f.fingerprint,
    });
  }
  return out;
}

/**
 * Signals from Claude-Book's style checker report ("## Blocking Errors (automated)" and "## Warnings (automated)").
 * The lines refer to the candidate text the checker was given, so `file` names that candidate (relative to the work folder).
 * @param {string} reportText @param {string} candidateRel
 * @returns {CheckFinding[]}
 */
export function styleFindings(reportText, candidateRel) {
  const out = [];
  const section = (title, severity) => {
    const at = reportText.indexOf(`## ${title}`);
    if (at < 0) return;
    const rest = reportText.slice(at + title.length + 3);
    const end = rest.search(/\n## /);
    const body = end < 0 ? rest : rest.slice(0, end);
    const items = body.split(/\n(?=- \[)/).filter((b) => b.startsWith('- ['));
    for (const it of items) {
      const head = /^- \[(line (\d+)|CHAPTER)\]: (.*)/.exec(it);
      if (!head) continue;
      const detail = /\n\s+- (?:Text|Detail): (.*)/.exec(it)?.[1]?.replace(/^"|"$/g, '') ?? '';
      const suggestion = /\n\s+- Suggestion: (.*)/.exec(it)?.[1];
      out.push({
        severity,
        kind: 'style',
        code: 'STYLE',
        file: candidateRel,
        line: head[2] ? Number(head[2]) : null,
        range: null,
        evidence: clip(detail),
        message: suggestion ? `${head[3]} (${suggestion})` : head[3],
      });
    }
  };
  section('Blocking Errors (automated)', 'error');
  section('Warnings (automated)', 'warning');
  return out;
}

/**
 * @param {{ model: Model, chapter: number, sceneId: string|null, files: string[], style: CheckFinding[], at?: string }} o
 * `files` = the target scene files (book-relative); `style` = findings already collected from the style checker (may be empty).
 */
export async function buildCheckReport({ model, chapter, sceneId, files, style, at = new Date().toISOString() }) {
  const findings = [...(await diagnosticFindings(model, files)), ...(await continuityFindings(model, files)), ...style];
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  const summary = {
    errors: count('error'),
    warnings: count('warning'),
    info: count('info'),
    total: findings.length,
    by_kind: {
      diagnostic: findings.filter((f) => f.kind === 'diagnostic').length,
      continuity: findings.filter((f) => f.kind === 'continuity').length,
      style: findings.filter((f) => f.kind === 'style').length,
    },
  };
  return { chapter, scene: sceneId, files, at, findings, summary };
}

/** @param {Awaited<ReturnType<typeof buildCheckReport>>} report */
export function renderCheckReport(report) {
  const { summary: s } = report;
  const lines = [
    `# Check report - chapter ${pad2(report.chapter)}${report.scene ? ` (scene ${report.scene})` : ''}`,
    '',
    `Generated ${report.at} by sf-claude-book check. Read-only: no model, no humanizer, no network; nothing in the book was changed.`,
    '',
    `Files checked: ${report.files.join(', ')}`,
    '',
    `- errors: ${s.errors}`,
    `- warnings: ${s.warnings}`,
    `- info: ${s.info}`,
    `- by kind: ${s.by_kind.diagnostic} validator, ${s.by_kind.continuity} continuity, ${s.by_kind.style} style`,
    '',
  ];
  if (report.findings.length === 0) lines.push('No findings.', '');
  for (const f of report.findings) {
    lines.push(
      `## [${f.severity}] ${f.code} - ${f.file}${f.line === null ? '' : `:${f.line}`}`,
      '',
      f.message,
      '',
      `- kind: ${f.kind}`,
      ...(f.range ? [`- range: ${f.range.from}-${f.range.to}`] : []),
      ...(f.fingerprint ? [`- fingerprint: ${f.fingerprint}`] : []),
      ...(f.evidence ? [`- evidence: ${f.evidence}`] : []),
      '',
    );
  }
  return lines.join('\n');
}
