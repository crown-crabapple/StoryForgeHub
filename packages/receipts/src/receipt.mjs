// Receipt documents (FORMAT-v1 9.4): build the file text, parse it back. A receipt is immutable once written; nothing here edits one.
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { lineDiff, parseDiff } from './diff.mjs';

export const RECEIPT_SCHEMA = 'storyforge.receipt/v1';
export const ACTORS = Object.freeze(['author', 'ai', 'external', 'system']);
export const OPERATIONS = Object.freeze([
  'baseline', 'author.edit', 'external.change', 'ai.proposal', 'ai.generation', 'suggestion.accept', 'suggestion.decline', 'undo', 'revision.restore', 'publish', 'check.report', 'ai.chat',
]);
export const WORKFLOWS = Object.freeze(['editor', 'ai-rewrite', 'ai-chat', 'suggestion', 'claude-book', 'watcher', 'revision', 'undo', 'export', 'check']);
const ACCEPTANCE = ['proposed', 'accepted', 'declined', 'partial'];

export const sha256Hex = (bytes) => createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest('hex');

const fail = (message) => Object.assign(new Error(message), { code: 'RCPT_MALFORMED' });

/** `provenance/<YYYY>/<MM>/<id>.md` from the receipt's `at` (UTC). */
export function receiptPath(at, id) {
  const d = new Date(at);
  return `provenance/${String(d.getUTCFullYear()).padStart(4, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}.md`;
}
/** `provenance/objects/<first 2 hex>/<sha256>` */
export const objectPath = (sha) => `provenance/objects/${sha.slice(0, 2)}/${sha}`;

/** "17–17" / "17–17, 19–20" (the after side; the before side for a pure removal). */
export function rangeText(ranges) {
  const parts = [];
  for (const r of ranges ?? []) {
    const a = r.after && r.after[1] >= r.after[0] ? r.after : r.before;
    parts.push(`${a[0]}–${a[1]}`);
  }
  return parts.join(', ');
}

const PLAIN_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
const scalar = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return PLAIN_RE.test(s) && !RESERVED.has(s.toLowerCase()) ? s : JSON.stringify(s);
};
const flow = (v) => {
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`;
  if (v !== null && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${scalar(k)}: ${flow(x)}`).join(', ')} }`;
  return scalar(v);
};

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

function defaultSummary(f, ranges) {
  const lines = ranges.length > 0 ? ` (lines ${rangeText(ranges)})` : '';
  const n = f.ai?.hunks?.length ?? ranges.length;
  switch (f.operation) {
    case 'baseline': return 'First seen by StoryForge: the text as it was (baseline).';
    case 'author.edit': return `Author edited the scene${lines}.`;
    case 'external.change': return `Changed outside StoryForge${lines}.`;
    case 'ai.proposal': return `AI suggested ${plural(n, 'change', 'changes')}${f.ai?.provider ? ` (${f.ai.provider}, ${f.ai.model}, ${f.ai.locality})` : ''}.`;
    case 'ai.generation': return 'AI drafted text (co-write); the draft was recorded.';
    case 'suggestion.accept': return `Author accepted ${plural(n, 'change', 'changes')}${lines}.`;
    case 'suggestion.decline': return `Author declined ${plural(n, 'change', 'changes')}.`;
    case 'undo': return `Author undid a change${lines}.`;
    case 'revision.restore': return `Author restored a saved revision${lines}.`;
    case 'publish': return `Published through Claude-Book${lines}.`;
    case 'check.report': return 'A check was run on the scene.';
    case 'ai.chat': return 'An AI chat was sent.';
    default: return 'Recorded.';
  }
}

/**
 * Build a receipt file.
 * @param {{ id: string, at: string, actor: string, operation: string, workflow: string, target: { id: string, path: string },
 *   before_sha256: string, after_sha256: string, parents?: { id: string, sha256: string }[], ai?: Record<string, any>, by?: { id?: string, name: string },
 *   summary?: string, ranges?: object[], diff?: string, beforeBytes?: Buffer | string, afterBytes?: Buffer | string, prompt?: string }} fields
 *   `diff` / `ranges` are written as given (a proposed diff); otherwise, when `beforeBytes` and `afterBytes` are given, they are computed from them.
 * @returns {{ text: string, sha256: string, ranges: object[], diff: string }}
 */
export function buildReceipt(fields) {
  const f = fields;
  for (const [name, list] of [['actor', ACTORS], ['operation', OPERATIONS], ['workflow', WORKFLOWS]]) {
    if (!list.includes(f[name])) throw fail(`${name} must be one of ${list.join(', ')}`);
  }
  let diff = f.diff;
  let ranges = f.ranges;
  if (diff === undefined && f.beforeBytes !== undefined && f.afterBytes !== undefined) {
    const d = lineDiff(f.beforeBytes, f.afterBytes);
    diff = d.diff;
    ranges ??= d.ranges;
  }
  diff ??= '';
  ranges ??= [];
  const parents = f.parents ?? [];
  const fm = [
    '---',
    `schema: ${RECEIPT_SCHEMA}`,
    `id: ${f.id}`,
    `at: ${JSON.stringify(f.at)}`,
    `actor: ${f.actor}`,
    `operation: ${f.operation}`,
    `workflow: ${f.workflow}`,
    `target: { id: ${JSON.stringify(f.target?.id ?? '')}, path: ${JSON.stringify(f.target?.path ?? '')} }`,
    `before_sha256: ${JSON.stringify(f.before_sha256 ?? '')}`,
    `after_sha256: ${JSON.stringify(f.after_sha256 ?? '')}`,
  ];
  if (ranges.length === 0) fm.push('ranges: []');
  else fm.push('ranges:', ...ranges.map((r) => `  - { before: [${r.before[0]}, ${r.before[1]}], after: [${r.after[0]}, ${r.after[1]}] }`));
  if (parents.length === 0) fm.push('parents: []');
  else fm.push('parents:', ...parents.map((p) => `  - { id: ${p.id}, sha256: ${JSON.stringify(p.sha256)} }`));
  if (f.by && typeof f.by.name === 'string') fm.push(`by: ${flow(f.by.id ? { id: f.by.id, name: f.by.name } : { name: f.by.name })}`); // who did it (shared mode; FORMAT 9.4)
  if (f.ai) {
    fm.push('ai:');
    for (const key of ['provider', 'model', 'locality', 'settings_sha256', 'prompt_sha256', 'context_sha256', 'files_sha256', 'suggestion', 'hunks', 'acceptance']) {
      const v = f.ai[key];
      if (v === undefined || v === null) continue;
      const hash = (x) => JSON.stringify(String(x));
      fm.push(`  ${key}: ${/_sha256$/.test(key) ? (Array.isArray(v) ? `[${v.map(hash).join(', ')}]` : hash(v)) : flow(v)}`);
    }
  }
  fm.push('---');
  const summary = (f.summary ?? defaultSummary(f, ranges)).replace(/\s*\n\s*/g, ' ').trim();
  let body = `${summary}\n`;
  if (diff !== '') body += `\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  if (typeof f.prompt === 'string' && f.prompt !== '') body += `\n## Prompt\n\n${f.prompt}\n`;
  const text = `${fm.join('\n')}\n${body}`;
  return { text, sha256: sha256Hex(text), ranges, diff };
}

const HEX_RE = /^(?:[0-9a-f]{64})?$/;
const isRange = (r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n));

/**
 * Parse a receipt file. Throws an Error with code RCPT_MALFORMED when the front matter fails the schema.
 * @param {string | Uint8Array} input
 * @returns {{ schema: string, id: string, at: string, actor: string, operation: string, workflow: string, target: { id: string, path: string },
 *   before_sha256: string, after_sha256: string, ranges: { before: number[], after: number[] }[], parents: { id: string, sha256: string }[], ai: Record<string, any> | null, by: { id?: string, name: string } | null,
 *   summary: string, diff: string, hunks: object[], prompt: string | null }}
 */
export function parseReceipt(input) {
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  if (lines[0] !== '---') throw fail('no front matter');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw fail('front matter never closed');
  let fm;
  try {
    fm = parseYaml(lines.slice(1, close).join('\n'), { version: '1.2', schema: 'core' });
  } catch (e) {
    throw fail(`front matter: ${String(e.message).split('\n')[0]}`);
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw fail('front matter is not a map');
  if (fm.schema !== RECEIPT_SCHEMA) throw fail(`schema must be ${RECEIPT_SCHEMA}`);
  if (typeof fm.id !== 'string' || !/^rcpt_\S+$/.test(fm.id)) throw fail('id must be rcpt_…');
  if (typeof fm.at !== 'string' || Number.isNaN(Date.parse(fm.at))) throw fail('at must be a timestamp');
  for (const [name, list] of [['actor', ACTORS], ['operation', OPERATIONS], ['workflow', WORKFLOWS]]) {
    if (!list.includes(fm[name])) throw fail(`${name} must be one of ${list.join(', ')}`);
  }
  if (!fm.target || typeof fm.target !== 'object' || typeof fm.target.id !== 'string' || typeof fm.target.path !== 'string') throw fail('target must be { id, path }');
  for (const k of ['before_sha256', 'after_sha256']) if (typeof fm[k] !== 'string' || !HEX_RE.test(fm[k])) throw fail(`${k} must be a sha256 hex string or ""`);
  if (!Array.isArray(fm.ranges) || !fm.ranges.every((r) => r && isRange(r.before) && isRange(r.after))) throw fail('ranges must be a list of { before: [a, b], after: [a, b] }');
  if (!Array.isArray(fm.parents) || !fm.parents.every((p) => p && typeof p.id === 'string' && typeof p.sha256 === 'string' && HEX_RE.test(p.sha256))) throw fail('parents must be a list of { id, sha256 }');
  let by = null;
  if (fm.by !== undefined && fm.by !== null) {
    if (typeof fm.by !== 'object' || Array.isArray(fm.by) || typeof fm.by.name !== 'string') throw fail('by must be { id?, name }');
    by = { ...(typeof fm.by.id === 'string' ? { id: fm.by.id } : {}), name: fm.by.name };
  }
  let ai = null;
  if (fm.ai !== undefined && fm.ai !== null) {
    if (typeof fm.ai !== 'object' || Array.isArray(fm.ai)) throw fail('ai must be a map');
    if (fm.ai.acceptance !== undefined && !ACCEPTANCE.includes(fm.ai.acceptance)) throw fail(`ai.acceptance must be one of ${ACCEPTANCE.join(', ')}`);
    ai = fm.ai;
  }

  const body = lines.slice(close + 1);
  const open = body.indexOf('```diff');
  let diff = '';
  let rest = body;
  let summaryLines = body;
  if (open >= 0) {
    let end = body.indexOf('```', open + 1);
    if (end < 0) end = body.length;
    diff = body.slice(open + 1, end).join('\n');
    summaryLines = body.slice(0, open);
    rest = body.slice(end + 1);
  }
  let hunks;
  try {
    hunks = parseDiff(diff).hunks;
  } catch (e) {
    throw fail(`diff: ${e.message}`);
  }
  let prompt = null;
  const p = rest.indexOf('## Prompt');
  if (p >= 0) {
    prompt = rest.slice(p + 1).join('\n').replace(/^\n/, '').replace(/\n$/, '');
    if (open < 0) summaryLines = rest.slice(0, p);
  }
  const summary = summaryLines.join('\n').trim();
  return {
    schema: fm.schema,
    id: fm.id,
    at: fm.at,
    actor: fm.actor,
    operation: fm.operation,
    workflow: fm.workflow,
    target: { id: fm.target.id, path: fm.target.path },
    before_sha256: fm.before_sha256,
    after_sha256: fm.after_sha256,
    ranges: fm.ranges,
    parents: fm.parents,
    ai,
    by,
    summary,
    diff,
    hunks,
    prompt,
  };
}
