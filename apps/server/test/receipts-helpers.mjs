// Helpers for the M05-J07 acceptance tests (not a test file). Contract: docs/contracts/M05-J07-receipts.md.
// The chain checker here is written from the contract's sections 1 and 6 and shares no code with @storyforge/receipts or the core writer:
// it parses receipt front matter with `yaml`, hashes parent files and objects with node:crypto and replays the diffs itself.
// Route and field names the contract leaves open are collected in RCPT so a rename is a one-line change.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { BOOK, AI, ARRIVAL, ARRIVAL_PATH, freshLibrary, getScene, makeHome, setupProvider, startApp } from './ai-helpers.mjs';
import { A, NEW, SUG, fmOf, readBytes, readText, replaceLines } from './suggest-helpers.mjs';

export { BOOK, ARRIVAL, ARRIVAL_PATH };
export const sha = (b) => createHash('sha256').update(b).digest('hex');

export const RCPT = {
  receipts: (scene, b = BOOK) => `/api/books/${b}/receipts?scene=${scene}`,
  blame: (scene, from, to, b = BOOK) => `/api/books/${b}/receipts/blame?scene=${scene}&from=${from}&to=${to}`,
  flush: (b = BOOK) => `/api/books/${b}/receipts/flush`,
  verify: (b = BOOK) => `/api/books/${b}/receipts/verify`,
  exportUrl: (query, b = BOOK) => `/api/books/${b}/export?${query}`,
  body: (scene, b = BOOK) => `/api/books/${b}/scenes/${scene}/body`,
  /** The "Keep the full prompt in the receipt" switch on the AI send request (per action, default off). NAME TO ALIGN WITH THE IMPLEMENTATION. */
  keepPromptField: 'keepPrompt',
};

// ---- fixed texts used across the tests ----------------------------------------------------------------------------------------
export const SECRET = 'sk-test-J07-SECRET-0123456789';
export const PROVIDER = 'Zorblax Provider';
export const MODEL = 'zorblax-model-9';
export const PROMPT = 'Tighten this, ZORBLAXPROMPT-7731, keep the voice.';
export const AUTHOR_TAIL = 'She did not wait for the tide.';
export const HAND_19 = 'Beyond the dunes lay [[salt-orchard]], drowned to the knees.';
export const NOTE = 'Receipts are a record of what happened in this project. They are not legal advice and do not decide who owns or can copyright any text.';

// ---- files --------------------------------------------------------------------------------------------------------------------

export async function listFiles(dir) {
  const out = [];
  async function walk(d, rel) {
    let es;
    try {
      es = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

export async function copyDir(src) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-rcpt-'));
  const dest = path.join(base, path.basename(src));
  await fs.cp(src, dest, { recursive: true });
  return dest;
}

/** Bytes of every file under `provenance/` (and `suggestions/` and the scene), keyed by relative path. For "nothing was repaired". */
export async function bytesUnder(root, prefixes) {
  const out = {};
  for (const p of prefixes) {
    for (const rel of await listFiles(path.join(root, p))) out[`${p}/${rel}`] = (await fs.readFile(path.join(root, p, ...rel.split('/')))).toString('base64');
  }
  return out;
}

// ---- receipts, read independently of the product ----------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Every receipt file under provenance/ (not objects/): [{ rel, bytes, sha, fm, body }]. A file that does not parse has fm null. */
export async function readReceipts(root) {
  const out = [];
  for (const rel of await listFiles(path.join(root, 'provenance'))) {
    if (rel.startsWith('objects/') || !/(^|\/)rcpt_[^/]+\.md$/.test(rel)) continue;
    const bytes = await fs.readFile(path.join(root, 'provenance', ...rel.split('/')));
    const text = bytes.toString('utf8');
    const m = FM_RE.exec(text);
    let fm;
    try {
      fm = m ? YAML.parse(m[1]) : null;
    } catch {
      fm = null;
    }
    out.push({ rel: `provenance/${rel}`, bytes, sha: sha(bytes), fm, body: m ? text.slice(m[0].length) : text });
  }
  return out;
}

export async function objectBytes(root, hash) {
  try {
    return await fs.readFile(path.join(root, 'provenance', 'objects', hash.slice(0, 2), hash));
  } catch {
    return null;
  }
}

/** The receipts of one target in chain order (follows parents[0] from the receipt that has none). Throws when it is not one straight line. */
export function chainOf(receipts, targetId) {
  const mine = receipts.filter((r) => r.fm?.target?.id === targetId);
  const byPrev = new Map();
  let head = null;
  for (const r of mine) {
    const first = r.fm.parents?.[0]?.id;
    if (!first) {
      if (head) throw new Error(`two chain heads for ${targetId}: ${head.fm.id}, ${r.fm.id}`);
      head = r;
    } else {
      if (byPrev.has(first)) throw new Error(`receipt ${first} has two children on the target chain`);
      byPrev.set(first, r);
    }
  }
  const out = [];
  for (let cur = head; cur; cur = byPrev.get(cur.fm.id)) out.push(cur);
  if (out.length !== mine.length) throw new Error(`the chain of ${targetId} is not one line (${out.length} of ${mine.length} reachable)`);
  return out;
}

export const splitLines = (buf) => {
  const parts = Buffer.from(buf).toString('utf8').split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
};

/** The first fenced diff block of a receipt body, as hunks: [{ oldStart, oldCount, newStart, newCount, minus: [], plus: [], ops: [{ t, s }] }]. */
export function diffHunks(body) {
  const m = /```diff\r?\n([\s\S]*?)\r?\n```/.exec(body);
  if (!m) return [];
  const hunks = [];
  let cur = null;
  for (const line of m[1].split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      cur = { oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), ops: [] };
      hunks.push(cur);
    } else if (cur && (line[0] === '-' || line[0] === '+' || line[0] === ' ')) {
      cur.ops.push({ t: line[0], s: line.slice(1) });
    }
  }
  return hunks;
}

/**
 * Replay a receipt diff over the `before` lines. Returns { lines, owners } where owners[i] is `tag` for lines the diff wrote and the old owner otherwise.
 * `mismatch` lists every '-' line that is not what the before text has at that place.
 */
export function replay(beforeLines, hunks, { owners = beforeLines.map(() => null), tag = null } = {}) {
  const out = [];
  const own = [];
  const mismatch = [];
  let p = 0;
  for (const h of hunks) {
    const target = h.oldCount > 0 ? h.oldStart - 1 : h.newStart - 1 - (out.length - p);
    while (p < target && p < beforeLines.length) {
      out.push(beforeLines[p]);
      own.push(owners[p]);
      p++;
    }
    for (const op of h.ops) {
      if (op.t === ' ') {
        if (beforeLines[p] !== op.s) mismatch.push(`context line ${p + 1}`);
        out.push(beforeLines[p]);
        own.push(owners[p]);
        p++;
      } else if (op.t === '-') {
        if (beforeLines[p] !== op.s) mismatch.push(`line ${p + 1}: wanted ${JSON.stringify(op.s)}, before has ${JSON.stringify(beforeLines[p])}`);
        p++;
      } else {
        out.push(op.s);
        own.push(tag);
      }
    }
  }
  while (p < beforeLines.length) {
    out.push(beforeLines[p]);
    own.push(owners[p]);
    p++;
  }
  return { lines: out, owners: own, mismatch };
}

/**
 * The chain checker, from the contract's section 6, run over the files only. Returns [{ code, receipt }] (RCPT_UNRECORDED is not checked here).
 * `sceneBytes` is { [targetId]: Buffer } when the caller wants the "current bytes = last after" comparison reported as RCPT_UNRECORDED.
 */
export async function checkChain(root, sceneBytes = {}) {
  const problems = [];
  const receipts = await readReceipts(root);
  const byId = new Map(receipts.filter((r) => r.fm?.id).map((r) => [r.fm.id, r]));
  for (const r of receipts) {
    if (!r.fm || r.fm.schema !== 'storyforge.receipt/v1' || !r.fm.id) {
      problems.push({ code: 'RCPT_MALFORMED', receipt: r.fm?.id ?? r.rel });
      continue;
    }
    for (const p of r.fm.parents ?? []) {
      const parent = byId.get(p.id);
      if (!parent) problems.push({ code: 'RCPT_PARENT_MISSING', receipt: r.fm.id });
      else if (parent.sha !== p.sha256) problems.push({ code: 'RCPT_PARENT_ALTERED', receipt: r.fm.id });
    }
    let before = r.fm.before_sha256 === '' ? Buffer.alloc(0) : null;
    let after = null;
    for (const [which, h] of [['before', r.fm.before_sha256], ['after', r.fm.after_sha256]]) {
      if (h === '' || h === undefined) {
        if (which === 'after') after = Buffer.alloc(0);
        continue;
      }
      const b = await objectBytes(root, h);
      if (!b) problems.push({ code: 'RCPT_OBJECT_MISSING', receipt: r.fm.id });
      else if (sha(b) !== h) problems.push({ code: 'RCPT_OBJECT_ALTERED', receipt: r.fm.id });
      if (which === 'before') before = b;
      else after = b;
    }
    if (before && after && r.fm.before_sha256 !== r.fm.after_sha256) {
      const rp = replay(splitLines(before), diffHunks(r.body));
      if (rp.mismatch.length > 0 || JSON.stringify(rp.lines) !== JSON.stringify(splitLines(after))) problems.push({ code: 'RCPT_DIFF_MISMATCH', receipt: r.fm.id });
    }
  }
  const targets = new Set(receipts.map((r) => r.fm?.target?.id).filter(Boolean));
  for (const t of targets) {
    let chain;
    try {
      chain = chainOf(receipts, t);
    } catch {
      continue; // broken parent links are already reported above
    }
    for (let i = 1; i < chain.length; i++) if (chain[i].fm.before_sha256 !== chain[i - 1].fm.after_sha256) problems.push({ code: 'RCPT_CHAIN_GAP', receipt: chain[i].fm.id });
    if (sceneBytes[t] && chain.length > 0 && sha(sceneBytes[t]) !== chain[chain.length - 1].fm.after_sha256) problems.push({ code: 'RCPT_UNRECORDED', receipt: chain[chain.length - 1].fm.id });
  }
  return problems;
}

/** Line owners over a scene's chain: the receipt (fm) that last wrote each line of the current text. */
export function blameOracle(chain, objectOf) {
  let lines = [];
  let owners = [];
  for (const r of chain) {
    if (r.fm.before_sha256 === r.fm.after_sha256) continue;
    if (r.fm.before_sha256 === '') {
      lines = splitLines(objectOf(r.fm.after_sha256));
      owners = lines.map(() => r);
      continue;
    }
    const rp = replay(lines, diffHunks(r.body), { owners, tag: r });
    lines = rp.lines;
    owners = rp.owners;
  }
  return { lines, owners };
}

export const codesOf = (problems) => [...new Set(problems.map((p) => p.code))].sort();

// ---- HTTP: binary GET ----------------------------------------------------------------------------------------------------------

export function getBinary(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- the scenario -------------------------------------------------------------------------------------------------------------

/** Names of response fields the contract only half-fixes: tolerate the plausible spellings. */
export const receiptsOf = (j) => j?.receipts ?? (Array.isArray(j) ? j : []);
export const linesOfBlame = (j) => j?.lines ?? j?.blame ?? (Array.isArray(j) ? j : []);
export const opOf = (r) => r.operation ?? r.fm?.operation;
export const stepText = (s) => (typeof s === 'string' ? s : [s.text, s.label, s.summary, s.title].filter((x) => typeof x === 'string').join(' ') || JSON.stringify(s));

export async function suggestionFiles(library) {
  return (await listFiles(path.join(library, 'suggestions'))).filter((f) => f.endsWith('.md')).map((f) => `suggestions/${f}`);
}

/** Run an AI rewrite of the whole Arrival body (mock replies with `proposedBody`), returns the created suggestion. */
export async function rewriteWhole(app, library, mock, { instruction = PROMPT, edits = { 15: NEW[15], 17: NEW[17], 19: NEW[19] }, extra = {} } = {}) {
  const scene = await getScene(app, ARRIVAL);
  const file = (await readBytes(library, ARRIVAL_PATH)).toString('utf8');
  const proposedFile = replaceLines(file, edits);
  const proposedBody = proposedFile.slice(file.length - scene.body.length);
  const known = new Set(await suggestionFiles(library));
  const ctx = await app.post(AI.context(), { task: 'rewrite', files: [], selection: { sceneId: ARRIVAL, from: 0, to: scene.body.length }, instruction, ...extra });
  if (ctx.status !== 200) throw new Error(`context ${ctx.status}: ${ctx.text}`);
  mock.setReply(proposedBody);
  const sent = await app.post(AI.send(), { contextId: ctx.json.contextId, ...extra });
  if (sent.status !== 200) throw new Error(`send ${sent.status}: ${sent.text}`);
  const fresh = (await suggestionFiles(library)).filter((f) => !known.has(f));
  if (fresh.length !== 1) throw new Error(`expected one new suggestion file, saw ${fresh}`);
  const rel = fresh[0];
  const text = await readText(library, rel);
  return { rel, fm: fmOf(text), contextId: ctx.json.contextId, scene };
}

/**
 * Section 8.1 end to end over HTTP on a copy of Salt Orchard (a real server process with its own user config):
 * open Arrival -> author appends a line + flush -> AI rewrite changes lines 15, 17, 19 -> accept h1, decline h2, hand-edit line 19 + flush.
 * Returns the library path and the ids the tests need. The app is left running; `app.stop()` it when done.
 */
export async function runScenario({ mock, keep = {} } = {}) {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home, net: true });
  await setupProvider(app, { baseUrl: mock.baseUrl, name: PROVIDER, model: MODEL, keyStorage: 'session', [AI.keyField]: SECRET });
  const log = {};

  const opened = await getScene(app, ARRIVAL);
  log.original = await readBytes(library, ARRIVAL_PATH);
  log.openedReceipts = await app.get(RCPT.receipts(ARRIVAL));

  // the author's own edit (append a line), then Record now
  const put1 = await app.put(RCPT.body(ARRIVAL), { body: `${opened.body}\n\n${AUTHOR_TAIL}`, base_sha256: opened.sha256 });
  if (put1.status !== 200) throw new Error(`author save ${put1.status}: ${put1.text}`);
  log.flush1 = await app.post(RCPT.flush(), { sceneId: ARRIVAL });

  // AI rewrite of three separate lines
  const sug = await rewriteWhole(app, library, mock, { extra: keep });
  log.suggestion = sug;
  log.afterProposal = await readBytes(library, ARRIVAL_PATH);

  const h = sug.fm.hunks.map((x) => x.id);
  log.accept = await app.post(SUG.decideHunk(sug.fm.id, h[0]), { decision: 'accept' });
  log.decline = await app.post(SUG.decideHunk(sug.fm.id, h[1]), { decision: 'decline' });
  log.afterDecisions = await readBytes(library, ARRIVAL_PATH);

  // the author hand-edits the third range
  const now = await getScene(app, ARRIVAL);
  const file = log.afterDecisions.toString('utf8');
  const handFile = replaceLines(file, { [A.L3]: HAND_19 });
  const handBody = handFile.slice(file.length - now.body.length);
  const put2 = await app.put(RCPT.body(ARRIVAL), { body: handBody, base_sha256: now.sha256 });
  if (put2.status !== 200) throw new Error(`hand edit ${put2.status}: ${put2.text}`);
  log.flush2 = await app.post(RCPT.flush(), { sceneId: ARRIVAL });
  log.final = await readBytes(library, ARRIVAL_PATH);
  return { library, home, app, log, hunkIds: h };
}
