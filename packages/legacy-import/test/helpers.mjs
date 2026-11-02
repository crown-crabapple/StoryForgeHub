// Shared helpers for the M06-J01 acceptance tests (not a test file). Contract: docs/contracts/M06-J01-legacy-dry-run.md.
// Written from the contract alone: hand-built legacy dumps are the oracles, nothing here shares code with the importer.
// Names the contract leaves open are collected in LI so a rename is a one-line change. NAMES TO ALIGN WITH THE IMPLEMENTATION.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(HERE, '..');
export const REPO = path.resolve(PKG, '..', '..');
export const FIXTURES = path.join(PKG, 'fixtures');
export const SEED_DUMP = path.join(FIXTURES, 'seed-dump');
export const EDGE_DUMP = path.join(FIXTURES, 'edge-dump');
export const MAIN = path.join(REPO, 'apps', 'server', 'src', 'main.mjs');
export const DUMP_PHP = path.join(REPO, 'tools', 'legacy-dump', 'dump.php');
export const LEGACY_REPO = 'E:\\StoryForgeHub\\legacy-StoryForgeHub';

export const LI = {
  entry: path.join(PKG, 'src', 'index.mjs'),
  /** The legacy table that holds the chapter bodies, and its id column. */
  chapterTable: 'chapters',
  expectedSummaryFile: 'expected-plan-summary.json',
};

export async function loadImporter() {
  return import(pathToFileURL(LI.entry).href);
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function tmpDir(prefix = 'sf-li-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- hand-built dumps -------------------------------------------------------------------------------------------------------

export const BOOK_ID = 'bk-test';

export function bookRow(over = {}) {
  return {
    id: BOOK_ID, folder: 'salt-test', title: 'Salt Test', series: '', num: '', status: 'drafting', profile: 'fiction',
    logline: 'A synthetic book.', genre: '', word_target: '', dot: '#4A4391', sort_order: 0, updated_at: '2026-01-01 00:00:00', ...over,
  };
}

let nextChapterId = 100;
export function chapterRow(over = {}) {
  const id = over.id ?? nextChapterId++;
  return {
    id, book_id: BOOK_ID, num: String(id), title: `Chapter ${id}`, pov: '', status: 'drafted', words: '', word_count: 0, summary: '',
    body: 'Some text.\n', file: `ch-${id}.md`, sort_order: id, updated_at: '2026-01-01 00:00:00', ...over,
  };
}

/**
 * Write a dump directory: tables/<name>.jsonl plus manifest.json. `tables` maps name -> rows.
 * `extraManifest` maps name -> manifest fields merged over the computed ones (e.g. { skipped: 'server-only' }).
 */
export function writeDump(dir, tables, { extraManifest = {}, dumpedAt = '2026-01-01T00:00:00Z', writeFiles = true } = {}) {
  fs.mkdirSync(path.join(dir, 'tables'), { recursive: true });
  const manifest = { dumper_version: 1, driver: 'sqlite', dumped_at: dumpedAt, tables: {} };
  for (const [name, rows] of Object.entries(tables)) {
    const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    manifest.tables[name] = { rows: rows.length, columns, sha256: sha256(Buffer.from(text, 'utf8')), ...(extraManifest[name] ?? {}) };
    if (writeFiles) fs.writeFileSync(path.join(dir, 'tables', `${name}.jsonl`), text);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** A dump with one book and the given chapter rows (plus any extra tables). */
export function chapterDump(chapters, extraTables = {}, opts = {}) {
  const dir = tmpDir('sf-li-dump-');
  writeDump(dir, { books: [bookRow()], chapters, ...extraTables }, opts);
  return dir;
}

export function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

// ---- plan inspection -----------------------------------------------------------------------------------------------------------

/** A plan as text, Buffers as hex, for byte-for-byte comparison and for secret scans. */
export function serializePlan(plan) {
  return JSON.stringify(plan, function (k, v) {
    const raw = this[k];
    if (raw instanceof Uint8Array) return `hex:${Buffer.from(raw).toString('hex')}`;
    return v;
  });
}

/** Plan text with file bytes decoded as UTF-8 (for scanning for strings that must not appear). */
export function planText(plan) {
  return JSON.stringify(plan, function (k, v) {
    const raw = this[k];
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8');
    return v;
  });
}

export const allFiles = (plan) => plan.books.flatMap((b) => b.files);

export const fromChapter = (f, id) => f.sources?.some((s) => s.table === LI.chapterTable && String(s.id) === String(id));

export function frontMatterSplit(buf) {
  const text = Buffer.from(buf).toString('utf8');
  if (!text.startsWith('---\n')) return { fm: null, body: text };
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return { fm: null, body: text };
  return { fm: YAML.parse(text.slice(4, end + 1)) ?? {}, body: text.slice(end + 5) };
}

export const isChapterFile = (p) => /(^|\/)manuscript\/.+\/ch-[^/]+\/chapter\.md$/.test(p);
export const isSceneFile = (p) => /(^|\/)manuscript\/.+\/ch-[^/]+\/(?!chapter\.md$)[^/]+\.md$/.test(p);

/** chapter.md files of a plan for one legacy chapter row. */
export function chapterFileOf(plan, id) {
  return allFiles(plan).find((f) => isChapterFile(f.path) && fromChapter(f, id));
}

/** Scene files for one legacy chapter row, in `sequence` order (path order breaks ties), with their parsed front matter and body. */
export function scenesOf(plan, id) {
  return allFiles(plan)
    .filter((f) => isSceneFile(f.path) && fromChapter(f, id))
    .map((f) => ({ file: f, ...frontMatterSplit(f.bytes) }))
    .sort((a, b) => (a.fm?.sequence ?? 0) - (b.fm?.sequence ?? 0) || (a.file.path < b.file.path ? -1 : 1));
}

const SEPS = ['---', '***', '___'];
/** Every way a separator line can sit in the original text: up to one blank line either side, LF or CRLF. */
function gapCandidates() {
  const out = [];
  for (const eol of ['\n', '\r\n'])
    for (const lead of [0, 1, 2])
      for (const trail of [0, 1, 2])
        for (const sep of SEPS) for (const eolSep of ['', '\r']) out.push(eol.repeat(lead) + sep + eolSep + eol.repeat(trail));
  return [...new Set(out)].sort((a, b) => a.length - b.length);
}
const GAPS = gapCandidates();

/**
 * Oracle for the byte-preserving invariant: the scene bodies must appear in the original body in order, nothing between them
 * except a separator line (with at most one blank line either side), and nothing before/after except an optional separator.
 * Returns null when the scenes re-join to the original, else a description of the first mismatch.
 */
export function rejoinProblem(original, bodies) {
  let furthest = { i: 0, pos: 0 };
  const walk = (i, pos) => {
    if (i > furthest.i || (i === furthest.i && pos > furthest.pos)) furthest = { i, pos };
    if (i === bodies.length) {
      const tail = original.slice(pos);
      return tail === '' || GAPS.includes(tail);
    }
    const s = bodies[i];
    if (i === 0 && original.startsWith(s, pos) && walk(1, pos + s.length)) return true;
    return GAPS.some((g) => original.startsWith(g + s, pos) && walk(i + 1, pos + g.length + s.length));
  };
  if (walk(0, 0)) return null;
  const rest = original.slice(furthest.pos);
  return `scenes do not re-join to the original: matched ${furthest.i} of ${bodies.length} scenes, stuck at offset ${furthest.pos} (original continues ${JSON.stringify(rest.slice(0, 40))}, next scene starts ${JSON.stringify((bodies[furthest.i] ?? '').slice(0, 40))})`;
}

// ---- snapshots ------------------------------------------------------------------------------------------------------------------

/** path -> { sha, mtimeMs, size } for every file and directory below dir. */
export function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(d, e.name);
      const st = fs.statSync(p);
      if (e.isDirectory()) {
        out[`${r}/`] = { mtimeMs: st.mtimeMs };
        walk(p, r);
      } else out[r] = { sha: sha256(fs.readFileSync(p)), mtimeMs: st.mtimeMs, size: st.size };
    }
  };
  walk(dir, '');
  return out;
}

export function listFilesRel(dir) {
  return Object.keys(snapshot(dir)).filter((k) => !k.endsWith('/')).sort();
}

/** Write a plan's files (as planToTree gives them) below a fresh temp dir; returns the dir. */
export function writeTree(tree) {
  const dir = tmpDir('sf-li-tree-');
  for (const [rel, bytes] of tree) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  return dir;
}
