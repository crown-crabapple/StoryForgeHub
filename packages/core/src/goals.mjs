// activity/goals.md (FORMAT-v1 section 9.1a): read the goals, and change one goal at a time without touching any other byte. Pure.
// Items the app cannot make sense of (a bad shape) are kept exactly as written and skipped when reading.
import { parse } from 'yaml';
import { ulid } from '@storyforge/manuscript';

export const GOALS_PATH = 'activity/goals.md';
export const GOAL_KINDS = ['words', 'scenes', 'chapters', 'minutes'];
export const GOAL_PERIODS = ['day', 'week', 'month', 'total'];

/** @typedef {{ id: string, kind: 'words'|'scenes'|'chapters'|'minutes', target: number, period: 'day'|'week'|'month'|'total', due?: string, scope?: string }} Goal */

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {string} v */
function isDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** A goal when the value has the right shape, else null. @param {any} v @returns {Goal | null} */
export function asGoal(v) {
  if (!isMap(v)) return null;
  if (typeof v.id !== 'string' || v.id === '' || !GOAL_KINDS.includes(v.kind) || !GOAL_PERIODS.includes(v.period)) return null;
  if (!Number.isInteger(v.target) || v.target < 1) return null;
  if (v.due !== undefined && v.due !== null && !(v.period === 'total' && typeof v.due === 'string' && isDate(v.due))) return null;
  if (v.scope !== undefined && v.scope !== null && (typeof v.scope !== 'string' || v.scope === '')) return null;
  return { id: v.id, kind: v.kind, target: v.target, period: v.period, ...(typeof v.due === 'string' ? { due: v.due } : {}), ...(typeof v.scope === 'string' ? { scope: v.scope } : {}) };
}

/** The front matter of `text`: its line range (lines[from..to) are the lines between the fences). @returns {{ lines: string[], from: number, to: number } | null} */
function fmRange(text) {
  const lines = text.split('\n');
  const strip = (l) => l.replace(/\r$/, '');
  const first = lines[0]?.startsWith('﻿') ? lines[0].slice(1) : lines[0];
  if (first === undefined || strip(first) !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (strip(lines[i]) === '---') return { lines, from: 1, to: i };
  return null;
}

/**
 * Where the `goals:` key sits: its line, and the raw item chunks under it. A chunk is `{ from, to, text }` (lines[from..to)).
 * `goals: []` (flow) has no chunks. @returns {{ at: number, end: number, items: { from: number, to: number, value: any }[] } | null}
 */
function goalsBlock(text) {
  const r = fmRange(text);
  if (!r) return null;
  const { lines } = r;
  let at = -1;
  for (let i = r.from; i < r.to; i++) {
    if (/^goals:\s*(#.*)?$/.test(lines[i].replace(/\r$/, '')) || /^goals:\s*\[\s*\]\s*(#.*)?$/.test(lines[i].replace(/\r$/, ''))) {
      at = i;
      break;
    }
  }
  if (at < 0) return { at: -1, end: r.to, items: [] };
  const items = [];
  let i = at + 1;
  let end = at + 1;
  while (i < r.to) {
    const t = lines[i].replace(/\r$/, '');
    const dash = /^(\s*)-(\s|$)/.exec(t);
    if (!dash) {
      // a continuation of the previous item (more indented), a blank line or a comment: part of the block while an item is open
      if (items.length > 0 && (t.trim() === '' || /^\s+\S/.test(t))) {
        i++;
        continue;
      }
      break;
    }
    const indent = dash[1].length;
    let j = i + 1;
    while (j < r.to) {
      const u = lines[j].replace(/\r$/, '');
      if (u.trim() === '') break;
      const lead = /^(\s*)/.exec(u)[1].length;
      if (lead > indent) j++;
      else break;
    }
    let value;
    try {
      value = parse(lines.slice(i, j).map((l) => l.replace(/\r$/, '')).join('\n'), { version: '1.2', schema: 'core' })?.[0];
    } catch {
      value = undefined;
    }
    items.push({ from: i, to: j, value });
    i = j;
    end = j;
  }
  return { at, end, items };
}

/**
 * The goals in a goals file: the well-formed items, in file order, and how many items were skipped.
 * @param {string} text
 * @returns {{ goals: Goal[], skipped: number }}
 */
export function parseGoals(text) {
  const block = goalsBlock(String(text));
  const goals = [];
  let skipped = 0;
  const seen = new Set();
  for (const it of block?.items ?? []) {
    const g = asGoal(it.value);
    if (!g || seen.has(g.id)) {
      skipped++;
      continue;
    }
    seen.add(g.id);
    goals.push(g);
  }
  return { goals, skipped };
}

/** One goal as a flow-style YAML item. @param {Goal} g */
export function goalLine(g) {
  return `  - { id: ${g.id}, kind: ${g.kind}, target: ${g.target}, period: ${g.period}${g.due ? `, due: ${g.due}` : ''}${g.scope ? `, scope: ${g.scope}` : ''} }`;
}

/** A new goals file. @param {Goal[]} goals @param {string} [id] */
export function newGoalsFile(goals = [], id = `note_${ulid()}`) {
  return `---\nschema: storyforge.goals/v1\nid: ${id}\ngoals:\n${goals.map((g) => goalLine(g)).join('\n')}${goals.length ? '\n' : ''}---\n`;
}

/** A goal id that no goal of `goals` has: g1, g2, ... @param {{ id: string }[]} goals */
export function freeGoalId(goals) {
  const used = new Set(goals.map((g) => g.id));
  for (let n = 1; ; n++) if (!used.has(`g${n}`)) return `g${n}`;
}

/**
 * Add or replace one goal (by id), or remove one (`remove: id`). Every other byte of the file stays, including items the app cannot read.
 * Returns the new text, or `null` when there is no such goal to remove or the file has no front matter.
 * @param {string} text
 * @param {{ set: Goal } | { remove: string }} op
 * @returns {string | null}
 */
export function applyGoalOp(text, op) {
  const r = fmRange(text);
  if (!r) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const cr = eol === '\r\n' ? '\r' : '';
  const block = goalsBlock(text);
  if (!block) return null;
  const { lines } = r;
  const sameId = (it) => asGoal(it.value)?.id === ('set' in op ? op.set.id : op.remove);
  if ('remove' in op) {
    const hit = block.items.find(sameId);
    if (!hit) return null;
    return [...lines.slice(0, hit.from), ...lines.slice(hit.to)].join('\n');
  }
  const line = goalLine(op.set) + cr;
  if (block.at < 0) {
    // no goals key yet: add it before the closing fence
    return [...lines.slice(0, r.to), `goals:${cr}`, line, ...lines.slice(r.to)].join('\n');
  }
  const hit = block.items.find(sameId);
  if (hit) return [...lines.slice(0, hit.from), line, ...lines.slice(hit.to)].join('\n');
  if (block.items.length === 0) {
    // `goals: []` or an empty key: make it a block
    const keyLine = `goals:${cr}`;
    return [...lines.slice(0, block.at), keyLine, line, ...lines.slice(block.at + 1)].join('\n');
  }
  return [...lines.slice(0, block.end), line, ...lines.slice(block.end)].join('\n');
}
