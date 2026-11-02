// Receipts inspector model (M05-J07 section 4): request URLs, tolerant readers for the server answers, and the words the panel uses.
// Pure: no React, no network.

const enc = encodeURIComponent;

/** The fixed note that goes with every receipts view. */
export const RECEIPTS_NOTE = 'Receipts are a record of what happened in this project. They are not legal advice and do not decide who owns or can copyright any text.';

/** @param {string} bookId @param {string} sceneId */
export const receiptsUrl = (bookId, sceneId) => `/api/books/${enc(bookId)}/receipts?scene=${enc(sceneId)}`;

/** @param {string} bookId @param {string} sceneId @param {number} from 1-based first line @param {number} to 1-based last line */
export const blameUrl = (bookId, sceneId, from, to) => `/api/books/${enc(bookId)}/receipts/blame?scene=${enc(sceneId)}&from=${from}&to=${to}`;

/** @param {string} bookId */
export const verifyUrl = (bookId) => `/api/books/${enc(bookId)}/receipts/verify`;

/** @param {string} bookId @param {string} sceneId */
export const flushRequest = (bookId, sceneId) => ({ method: 'POST', url: `/api/books/${enc(bookId)}/receipts/flush`, body: { sceneId } });

const ACTORS = { author: 'Author', ai: 'AI', external: 'Outside StoryForge', system: 'StoryForge' };

/** @param {string | undefined} actor */
export const actorLabel = (actor) => ACTORS[actor ?? ''] ?? (actor || 'Unknown');

/** Plain words for the blame labels the server may send; unknown labels are shown as they are. */
const BLAME_WORDS = {
  author: 'Author-written',
  'author-written': 'Author-written',
  ai: 'AI-generated proposal',
  'ai-proposal': 'AI-generated proposal',
  'ai-assisted': 'Author text edited with AI',
  'author-ai': 'Author text edited with AI',
  external: 'Changed outside StoryForge',
};

/** @param {{ label?: string, actor?: string } | null | undefined} entry */
export function blameLabel(entry) {
  const l = entry?.label ?? '';
  return BLAME_WORDS[l] ?? (l || BLAME_WORDS[entry?.actor ?? ''] || 'Unknown');
}

const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);

/** One receipt as the panel shows it. Reads either the flat shape or one with the front matter under `fm` / `frontMatter`. @param {any} r */
export function readReceipt(r) {
  const f = { ...(r?.fm ?? r?.frontMatter ?? {}), ...(r ?? {}) };
  return {
    id: str(f.id),
    at: str(f.at),
    actor: str(f.actor),
    operation: str(f.operation),
    workflow: str(f.workflow),
    path: str(f.path ?? f.file ?? f.rel),
    target: f.target ?? null,
    before: str(f.before_sha256 ?? f.before),
    after: str(f.after_sha256 ?? f.after),
    ranges: list(f.ranges),
    parents: list(f.parents),
    ai: f.ai && typeof f.ai === 'object' ? f.ai : null,
    summary: str(f.summary),
    diff: str(f.diff),
    body: str(f.body),
  };
}

/** "lines 17–19" style text of a range list, from the `after` side. @param {any[]} ranges */
export function rangesText(ranges) {
  const parts = list(ranges)
    .map((r) => {
      const a = r?.after ?? r?.before;
      return Array.isArray(a) ? (a[0] === a[1] ? `${a[0]}` : `${a[0]}–${a[1]}`) : '';
    })
    .filter(Boolean);
  return parts.length === 0 ? '' : `${parts.length === 1 && !parts[0].includes('–') ? 'line' : 'lines'} ${parts.join(', ')}`;
}

/**
 * The lineage steps of an answer: each `{ key, text, receipts }`. A step may be a string or an object with `text` / `label` / `summary` and the receipt ids
 * (`receiptIds` / `receipts` / `ids` / `id`); `receipts` are the full receipts of the answer those ids name.
 * @param {{ lineage?: any, receipts?: any[] } | null | undefined} data
 */
export function readSteps(data) {
  const all = list(data?.receipts).map(readReceipt);
  const byId = new Map(all.map((r) => [r.id, r]));
  const raw = Array.isArray(data?.lineage) ? data.lineage : list(data?.lineage?.steps);
  return raw.map((s, i) => {
    if (typeof s === 'string') return { key: `s${i}`, text: s, receipts: [] };
    // the step carries its receipts in full (`receipts`: detail objects) or by id (`receiptIds`, looked up in the answer's receipts)
    const full = list(s.receipts).filter((x) => x && typeof x === 'object').map(readReceipt);
    const ids = list(s.receiptIds ?? s.ids ?? (s.id ? [s.id] : [])).map((x) => (typeof x === 'string' ? x : x?.id));
    const receipts = full.length > 0 ? full : ids.map((id) => byId.get(id)).filter(Boolean);
    return { key: `s${i}`, text: str(s.text ?? s.label ?? s.summary), receipts };
  });
}

/** The integrity result as the badge needs it. @param {any} status `{ ok, receipts, problems }` (or null while loading) */
export function readStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const problems = list(status.problems).map((p) => ({ code: str(p.code), file: str(p.file), receipt: str(p.receipt), detail: str(p.detail) }));
  const infoOnly = problems.length > 0 && problems.every((p) => p.code === 'RCPT_UNRECORDED');
  const state = problems.length === 0 ? 'ok' : infoOnly ? 'info' : 'problem';
  return { ok: Boolean(status.ok), receipts: Number.isInteger(status.receipts) ? status.receipts : null, problems, state };
}

const PROBLEM_WORDS = {
  RCPT_PARENT_MISSING: 'A receipt this one points back to is missing.',
  RCPT_PARENT_ALTERED: 'A receipt this one points back to was changed after it was written.',
  RCPT_OBJECT_MISSING: 'A saved state a receipt names is missing.',
  RCPT_OBJECT_ALTERED: 'A saved state does not match its recorded fingerprint.',
  RCPT_DIFF_MISMATCH: 'A receipt’s recorded change does not match its before and after states.',
  RCPT_CHAIN_GAP: 'A receipt does not start where the previous one ended.',
  RCPT_UNRECORDED: 'The scene has changes that are not in a receipt yet (unsaved edits or an edit made while StoryForge was closed).',
  RCPT_MALFORMED: 'A receipt file could not be read.',
};

/** @param {string} code */
export const problemWords = (code) => PROBLEM_WORDS[code] ?? 'The receipts need a look.';

/** The badge text for a status. @param {ReturnType<typeof readStatus>} s */
export function badgeText(s) {
  if (!s) return 'Checking…';
  if (s.state === 'ok') return 'Receipts verified';
  if (s.state === 'info') return 'Receipts verified, with unrecorded changes';
  return `${s.problems.length} ${s.problems.length === 1 ? 'problem' : 'problems'} found in the receipts`;
}

/**
 * The 1-based first and last line of a selection in the editor text (LF). A selection that ends at the very start of a line does not count that line.
 * @param {string} text @param {number} from @param {number} to
 * @returns {{ from: number, to: number }}
 */
export function selectionLines(text, from, to) {
  const lineOf = (pos) => {
    let n = 1;
    for (let i = 0; i < Math.min(pos, text.length); i++) if (text.charCodeAt(i) === 10) n += 1;
    return n;
  };
  const a = lineOf(from);
  const end = to > from && text[to - 1] === '\n' ? to - 1 : to;
  return { from: a, to: Math.max(a, lineOf(end)) };
}

/** Blame rows from an answer (`[{ line, receiptId, actor, label }]` or `{ lines: [...] }`), consecutive lines with the same receipt and label joined. @param {any} data */
export function readBlame(data) {
  const rows = Array.isArray(data) ? data : list(data?.lines ?? data?.blame);
  /** @type {{ from: number, to: number, receiptId: string, actor: string, label: string, unrecorded: boolean }[]} */
  const out = [];
  for (const r of rows) {
    const label = blameLabel(r);
    const last = out[out.length - 1];
    if (last && last.receiptId === str(r.receiptId) && last.label === label && last.to + 1 === r.line) last.to = r.line;
    else out.push({ from: r.line, to: r.line, receiptId: str(r.receiptId), actor: str(r.actor), label, unrecorded: Boolean(r.unrecorded) });
  }
  return out;
}

/**
 * Contract 2(c): the scene is being left (another scene opened, the editor closed, the page hidden): record the author's saved changes as a receipt.
 * Fire and forget: never throws, never waits. `keepalive` lets the request outlive a closing page.
 * @param {string} bookId @param {string} sceneId @param {{ keepalive?: boolean, fetchImpl?: typeof fetch }} [opts]
 */
export function flushOnLeave(bookId, sceneId, { keepalive = false, fetchImpl = typeof fetch === 'function' ? fetch : undefined } = {}) {
  const r = flushRequest(bookId, sceneId);
  try {
    const p = fetchImpl?.(r.url, {
      method: r.method,
      headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
      body: JSON.stringify(r.body),
      ...(keepalive ? { keepalive: true } : {}),
    });
    p?.catch?.(() => {});
  } catch {
    // a receipt never blocks navigation
  }
}
