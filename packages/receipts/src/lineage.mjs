// The plain-language lineage of a scene (contract section 4) and line-level blame by replaying the chain. Records only: nothing here says who owns text.
import { splitLines } from '@storyforge/suggestions';
import { applyDiff, lineDiff } from './diff.mjs';
import { rangeText } from './receipt.mjs';
import { compareReceipts } from './verify.mjs';

export const NOT_LEGAL_ADVICE = 'Receipts are a record of what happened in this project. They are not legal advice and do not decide who owns or can copyright any text.';

export const BLAME_LABELS = Object.freeze({
  author: 'Author-written',
  proposal: 'AI-generated proposal',
  aiEdited: 'Author text edited with AI',
  external: 'Changed outside StoryForge',
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isAiAccept = (r) => r.operation === 'suggestion.accept' && (r.actor === 'ai' || r.ai !== null || r.workflow === 'claude-book' || r.workflow === 'ai-rewrite');

/** The blame label of lines a receipt introduced. */
function introducedLabel(r) {
  if (r.operation === 'external.change') return BLAME_LABELS.external;
  if (isAiAccept(r) || r.operation === 'publish') return BLAME_LABELS.aiEdited;
  return BLAME_LABELS.author;
}
const introducedActor = (r) => (r.operation === 'external.change' ? 'external' : isAiAccept(r) || r.operation === 'publish' ? 'ai' : 'author');

const detailOf = (r) => ({
  id: r.id,
  path: r.path ?? null,
  at: r.at,
  actor: r.actor,
  operation: r.operation,
  workflow: r.workflow,
  target: r.target,
  before_sha256: r.before_sha256,
  after_sha256: r.after_sha256,
  ranges: r.ranges,
  parents: r.parents,
  ai: r.ai,
  summary: r.summary,
  diff: r.diff,
  prompt: r.prompt ?? null,
});

/**
 * The scene's lineage, oldest first. Runs of author saves right after the first state collapse into "Author edited (N sessions)";
 * later author saves are "Author revised lines a–b".
 * @param {object[]} receipts parsed receipts of one scene (parseReceipt output, optionally with `path`)
 * @returns {{ index: number, kind: string, label: string, actor: string, at: string, count: number, receiptIds: string[], receipts: object[] }[]}
 */
export function lineage(receipts) {
  const sorted = [...receipts].sort(compareReceipts);
  const steps = [];
  let sawAi = false;
  let run = null;
  const push = (kind, label, actor, rs) => {
    steps.push({ index: steps.length, kind, label, actor, at: rs[0].at, count: rs.length, receiptIds: rs.map((r) => r.id), receipts: rs.map(detailOf) });
  };
  const closeRun = () => {
    if (!run) return;
    const n = run.length;
    push('edited', `Author edited (${plural(n, 'session', 'sessions')})`, 'author', run);
    run = null;
  };
  for (const r of sorted) {
    if (r.operation === 'author.edit' && !sawAi) {
      (run ??= []).push(r);
      continue;
    }
    closeRun();
    const lines = rangeText(r.ranges);
    const n = r.ai?.hunks?.length ?? r.ranges.length;
    switch (r.operation) {
      case 'baseline': push('baseline', 'Author wrote (baseline)', 'system', [r]); break;
      case 'author.edit': push('revised', `Author revised lines ${lines || '(whole file)'}`, 'author', [r]); break;
      case 'external.change': push('external', `Changed outside StoryForge${lines ? ` (lines ${lines})` : ''}`, 'external', [r]); break;
      case 'ai.proposal':
        sawAi = true;
        push('ai-suggested', `AI suggested ${plural(n, 'change', 'changes')}${r.ai?.provider ? ` (${r.ai.provider}, ${r.ai.model}, ${r.ai.locality})` : ''}`, 'ai', [r]);
        break;
      case 'ai.generation': sawAi = true; push('ai-generated', 'AI drafted text (co-write)', 'ai', [r]); break;
      case 'ai.chat': push('ai-chat', 'AI chat sent', 'ai', [r]); break;
      case 'suggestion.accept': sawAi = true; push('accepted', `Author accepted lines ${lines || '(none)'}`, r.actor === 'system' ? 'system' : 'author', [r]); break;
      case 'suggestion.decline': sawAi = true; push('declined', `Author declined ${plural(n, 'change', 'changes')}`, r.actor === 'system' ? 'system' : 'author', [r]); break;
      case 'undo': push('undo', `Author undid a change${lines ? ` (lines ${lines})` : ''}`, 'author', [r]); break;
      case 'revision.restore': push('revision-restore', 'Author restored a saved revision', 'author', [r]); break;
      case 'publish': push('publish', 'Published through Claude-Book', r.actor, [r]); break;
      case 'check.report': push('check', 'A check was run on the scene', 'system', [r]); break;
      default: push('other', r.summary || r.operation, r.actor, [r]);
    }
  }
  closeRun();
  return steps;
}

/** The text after applying a diff, or null when it does not apply. */
function replay(text, diff) {
  try {
    return applyDiff(text, diff);
  } catch {
    return null;
  }
}

/** Lines with owners: the text of `bytes`, every line owned by `owner`. */
const owned = (bytes, owner) => splitLines(bytes).lines.map((text) => ({ text, owner }));

/** Replace the lines of `state` the way `bytes` differ from `fromBytes`; new lines get `owner`. Returns the new state. */
function advance(state, fromBytes, toBytes, owner) {
  const { hunks } = lineDiff(fromBytes, toBytes);
  const out = [];
  let pos = 0;
  for (const h of hunks) {
    const start = h.beforeStart - 1;
    out.push(...state.slice(pos, start), ...h.added.map((text) => ({ text, owner })));
    pos = start + h.beforeCount;
  }
  out.push(...state.slice(pos));
  return out;
}

/**
 * Line-level blame of the scene as it is now: for each line from `fromLine` to `toLine` (1-based file lines, inclusive) the receipt that last introduced it.
 * The chain is replayed receipt by receipt (the saved objects, or the diffs when an object is gone); lines changed since the last receipt are `unrecorded`.
 * @param {{ receipts: object[], objectBytes: (sha256: string) => Buffer | Uint8Array | null | undefined, currentBytes: Buffer | string, fromLine?: number, toLine?: number }} input
 * @returns {{ line: number, receiptId: string | null, actor: string, label: string, unrecorded?: boolean }[]}
 */
export function blame({ receipts, objectBytes, currentBytes, fromLine = 1, toLine = Infinity }) {
  const sorted = [...receipts].filter((r) => r.target.id !== '').sort(compareReceipts);
  let text = Buffer.alloc(0);
  let state = [];
  let started = false;
  for (const r of sorted) {
    if (!started) {
      started = true;
      if (r.before_sha256 !== '') {
        const first = objectBytes(r.before_sha256);
        if (first) {
          text = Buffer.from(first);
          state = owned(text, { receiptId: r.id, actor: 'author', label: BLAME_LABELS.author });
        }
      }
    }
    if (r.before_sha256 === r.after_sha256) continue;
    const stored = r.after_sha256 === '' ? Buffer.alloc(0) : objectBytes(r.after_sha256);
    const next = stored ? Buffer.from(stored) : replay(text, r.diff);
    if (!next) continue;
    state = advance(state, text, next, { receiptId: r.id, actor: introducedActor(r), label: introducedLabel(r) });
    text = next;
  }
  const now = Buffer.isBuffer(currentBytes) ? currentBytes : Buffer.from(currentBytes ?? '', 'utf8');
  if (!now.equals(text)) state = advance(state, text, now, { receiptId: null, actor: 'author', label: BLAME_LABELS.author, unrecorded: true });
  const out = [];
  const last = Math.min(toLine, state.length);
  for (let line = Math.max(1, fromLine); line <= last; line++) {
    const o = state[line - 1].owner;
    out.push({ line, receiptId: o.receiptId, actor: o.actor, label: o.label, ...(o.unrecorded ? { unrecorded: true } : {}) });
  }
  return out;
}
