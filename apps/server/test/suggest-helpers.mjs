// Helpers for the M05-J06 acceptance tests (not a test file). Contract: docs/contracts/M05-J06-author-check-suggest.md.
// The suggestion documents these tests start from are written HERE, from the contract's section 1 layout, so the decide routes are checked
// against the format and not against the product's own writer. Names the contract leaves open (list/get routes) are collected in SUG.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const BOOK = 'book_01S5000000000000000000000A';
export const ARRIVAL = 'scene_01S50000000000000000000002';
export const KEY = 'scene_01S50000000000000000000003';
export const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const KEY_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md';
export const CF1 = 'cf1-e85d78f4354c4ffc';
export const SUG_ID = 'note_01S50000000000000000000J06';
export const SUG_PATH = 'suggestions/2026/20261102-140322-arrival-three-edits.md';
export const CREATED = '2026-11-02T14:03:22Z';
export const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Routes the contract does not fix. The decide routes are fixed by section 1.2. */
export const SUG = {
  check: (b = BOOK) => `/api/books/${b}/check`,
  list: (b = BOOK) => `/api/books/${b}/suggestions`,
  one: (id, b = BOOK) => `/api/books/${b}/suggestions/${id}`,
  decide: (id, b = BOOK) => `/api/books/${b}/suggestions/${id}`,
  decideHunk: (id, h, b = BOOK) => `/api/books/${b}/suggestions/${id}/hunks/${h}`,
  restore: (op, b = BOOK) => `/api/books/${b}/ops/${encodeURIComponent(op)}/restore`,
};

// ---- the oracle: line arithmetic over the ORIGINAL bytes -------------------------------------------------------------

export const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
export function linesOf(text) {
  const parts = text.split(eolOf(text));
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
/** Replace single lines (1-based) with new text, everything else byte-identical (line endings and trailing newline kept). */
export function replaceLines(text, edits) {
  const eol = eolOf(text);
  const trailing = text.endsWith(eol);
  const ls = linesOf(text);
  for (const [line, t] of Object.entries(edits)) ls[Number(line) - 1] = t;
  return ls.join(eol) + (trailing ? eol : '');
}
/** Insert `newLines` before 1-based `line`. */
export function insertBefore(text, line, newLines) {
  const eol = eolOf(text);
  const trailing = text.endsWith(eol);
  const ls = linesOf(text);
  ls.splice(line - 1, 0, ...newLines);
  return ls.join(eol) + (trailing ? eol : '');
}

/** Arrival: the three prose lines of the fixture (verified by the tests against the file itself). */
export const A = { L1: 15, L2: 17, L3: 19 };
export const NEW = {
  15: 'The ferry bumped the jetty and [[tobin-reyes|the ferryman]] flung her bag ashore.',
  17: 'In the glass of the ticket hut she caught her own face, grey eyes ringed with salt, and looked away.',
  19: 'Past the dunes lay [[salt-orchard]], half drowned.',
};

/**
 * A suggestion document (contract section 1) over `baseText` replacing the given single lines: { 15: 'new text', ... } -> one hunk per line, ids h1..hn.
 * `extra` overrides front matter fields (source, ai, ...).
 */
export function suggestionText(baseText, edits, { id = SUG_ID, target = ARRIVAL, targetPath = ARRIVAL_PATH, extra = {} } = {}) {
  const ls = linesOf(baseText);
  const lineNos = Object.keys(edits).map(Number).sort((a, b) => a - b);
  const hunks = lineNos.map((line, i) => ({ id: `h${i + 1}`, line, lines: 1, original_sha256: sha(ls[line - 1]), status: 'pending' }));
  const fm = { schema: 'storyforge.suggestion/v1', id, target, target_path: targetPath, base_sha256: sha(baseText), source: 'claude-book', mode: 'suggest', created: CREATED, status: 'pending', ...extra, hunks };
  const diff = lineNos
    .map((line, i) => `@@ -${line},1 +${line},1 @@ h${i + 1}\n-${ls[line - 1]}\n+${edits[line]}`)
    .join('\n');
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\nThree small edits.\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
}

/** Parse the front matter of any suggestion/scene file. */
export const fmOf = (raw) => YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)[1]);

/** prep(root) that writes the standard three-hunk suggestion (against the pristine Arrival) and optionally changes Arrival first. */
export function withSuggestion({ edits = NEW, mutateScene, id = SUG_ID, extra } = {}) {
  return async (root) => {
    const file = path.join(root, ...ARRIVAL_PATH.split('/'));
    const pristine = await fs.readFile(file, 'utf8');
    const sug = suggestionText(pristine, edits, { id, extra });
    const sugFile = path.join(root, ...SUG_PATH.split('/'));
    await fs.mkdir(path.dirname(sugFile), { recursive: true });
    await fs.writeFile(sugFile, sug);
    if (mutateScene) await fs.writeFile(file, mutateScene(pristine));
  };
}

/** Every file under root (rel path -> { sha, size, mtimeMs }) plus directories, skipping .storyforge unless asked. */
export async function tree(root, { skip = ['.storyforge'] } = {}) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (skip.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[`${rel}/`] = { dir: true };
        await walk(full);
      } else {
        const st = await fs.stat(full);
        out[rel] = { sha: sha(await fs.readFile(full)), size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  }
  await walk(root);
  return out;
}
/** Paths whose entry differs (added, removed or changed content) between two `tree` results. */
export const changedPaths = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
/** Same, content only (ignores mtimes). */
export const changedContent = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k]?.sha !== b[k]?.sha).sort();

export const readText = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
export const readBytes = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')));

/** The op id out of a decide response (shape not fixed by the contract: `undo.op`, `opId` or `op`). */
export function opIdOf(r) {
  const j = r.json ?? {};
  const op = j.undo?.op ?? j.opId ?? j.op ?? j.undo?.opId;
  const id = typeof op === 'string' ? op : op?.opId ?? op?.id;
  return id;
}
