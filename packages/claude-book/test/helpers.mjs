// Shared helpers for the claude-book adapter tests. Contains no tests itself.
// The independent oracle: a minimal temp Claude-Book framework with a stdlib Python stand-in for
// scripts/style/style_checker.py, fixture copies, tree snapshots and a concatenated-JSON parser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '../bin/sf-claude-book.mjs');
export const SHAPES = path.resolve(HERE, '../shapes/kethra-context-shapes.json');
export const FIXTURES = path.resolve(HERE, '../../format/fixtures');
export const VALID = path.join(FIXTURES, 'valid');

export function tmp(prefix = 'sf-cb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy a fixture book into a fresh temp dir; returns the copy's path. */
export function copyFixture(name = 'salt-orchard') {
  const dest = path.join(tmp(), name);
  fs.cpSync(path.join(VALID, name), dest, { recursive: true });
  return dest;
}

export const abs = (root, rel) => path.join(root, ...rel.split('/'));
export const read = (root, rel) => fs.readFileSync(abs(root, rel), 'utf8');
export const exists = (root, rel) => fs.existsSync(abs(root, rel));
export function put(root, rel, text) {
  const f = abs(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// ---------------------------------------------------------------------------
// python

export function pythonAvailable(exe = 'python') {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

const STYLE_CHECKER = `#!/usr/bin/env python3
"""Test stand-in for Claude-Book scripts/style/style_checker.py (same I/O contract).
usage: style_checker.py [--min-words A] [--max-words B] <chapter-NN-....md>
Writes <framework>/.work/chapter-NN-tech-report-<8 hex>.md (NN from the FILE NAME); exit 0 pass, 1 fail."""
import os, re, sys, uuid
from pathlib import Path

args = sys.argv[1:]
lo, hi, path = 1, 10**9, None
i = 0
while i < len(args):
    if args[i] == "--min-words":
        lo = int(args[i + 1]); i += 2
    elif args[i] == "--max-words":
        hi = int(args[i + 1]); i += 2
    else:
        path = args[i]; i += 1
if path is None:
    print("no input", file=sys.stderr); sys.exit(2)
m = re.search(r"chapter-(\\d+)", os.path.basename(path))
if not m:
    print("cannot read chapter number from file name", file=sys.stderr); sys.exit(2)
nn = m.group(1)
text = Path(path).read_text(encoding="utf-8")
words = len(text.split())
ok = lo <= words <= hi
framework = Path(__file__).resolve().parents[2]
out = framework / ".work" / f"chapter-{nn}-tech-report-{uuid.uuid4().hex[:8]}.md"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(
    f"# Style tech report - chapter {nn}\\n\\n"
    f"- words: {words}\\n- min_words={lo} max_words={hi}\\n- cwd: {os.getcwd()}\\n\\n"
    f"## Verdict\\n\\n{'PASS' if ok else 'FAIL'}\\n",
    encoding="utf-8",
)
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
`;

/** Build a minimal Claude-Book framework in a fresh temp dir. */
export function makeFramework({ claudeMd = true, checker = true } = {}) {
  const root = path.join(tmp('sf-cb-fw-'), 'framework');
  if (claudeMd) put(root, 'CLAUDE.md', '# Claude-Book (test framework)\n');
  put(root, 'templates/state/characters.md', '# Characters\n\n## Alive\n\n## Dead\n\n## Locations\n');
  put(root, 'templates/state/inventory.md', '# Inventory\n\n## Holders\n');
  put(root, 'templates/state/knowledge.md', '# Knowledge\n\n## Known facts\n');
  put(root, 'templates/state/situation.md', '# Situation\n\n## Recent events\n');
  for (const a of ['style-linter', 'character-reviewer', 'continuity-reviewer']) {
    put(root, `analysis/.claude/agents/${a}.md`, `---\nname: ${a}\n---\nStub prompt for ${a}.\n`);
  }
  if (checker) put(root, 'scripts/style/style_checker.py', STYLE_CHECKER);
  // pre-existing sibling work that must never be touched
  put(root, '.work/other-book/keep.md', 'keep me\n');
  return root;
}

// ---------------------------------------------------------------------------
// CLI

export function cli(args, { env = {}, cwd } = {}) {
  const base = { ...process.env };
  delete base.CLAUDE_BOOK_ROOT;
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd,
    env: { ...base, ...env },
  });
}

export function run(command, { book, fw, chapter, workId, extra = [] }) {
  const args = [command, '--book', book, '--framework', fw];
  if (chapter != null) args.push('--chapter', String(chapter));
  if (workId) args.push('--work-id', workId);
  return cli([...args, ...extra]);
}

export const nn = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// snapshots

/** Map of relative path -> { type, sha, size, mtimeMs } for everything under root (incl. dirs). */
export function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      // M05-J07: provenance/ (receipts and objects) is the intended new effect of AI, suggestion and adapter actions; the receipts-*.test.mjs files check it directly.
      if (rel === 'provenance') continue;
      if (e.isDirectory()) {
        out.set(rel, { type: 'dir' });
        walk(full);
      } else {
        const buf = fs.readFileSync(full);
        out.set(rel, {
          type: 'file',
          sha: crypto.createHash('sha256').update(buf).digest('hex'),
          size: buf.length,
          mtimeMs: fs.statSync(full).mtimeMs,
        });
      }
    }
  };
  walk(root);
  return out;
}

/** Differences between two snapshots: { added, removed, changed } (relative paths). */
export function diffSnapshots(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...before.keys()]
    .filter((k) => after.has(k))
    .filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k)))
    .sort();
  return { added, removed, changed };
}

/** All files under dir as Map rel -> Buffer. */
export function readTree(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// concatenated pretty JSON objects

/**
 * Parse text that is a sequence of top-level JSON objects (pretty-printed, one after another).
 * Whitespace and HTML comments between objects are tolerated; anything else throws.
 */
export function parseConcatenatedJson(text) {
  const objs = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 3;
      continue;
    }
    if (c !== '{') throw new Error(`unexpected text at ${i}: ${JSON.stringify(text.slice(i, i + 30))}`);
    let depth = 0;
    let inStr = false;
    let j = i;
    for (; j < n; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error('unbalanced braces');
    objs.push(JSON.parse(text.slice(i, j + 1)));
    i = j + 1;
  }
  return objs;
}

export const jsType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ---------------------------------------------------------------------------
// key-schema (shapes file) access; tolerant about the exact layout of the descriptor


function findNode(node, names) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  for (const k of Object.keys(node)) if (names.includes(k)) return node[k];
  for (const k of Object.keys(node)) {
    const r = findNode(node[k], names);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * Returns { keys: Map key -> declared type, optional: Set } for a context file, or null if not described.
 * Layout of the shapes file: { files: { "<name>": { keys: { k: "string" | {array: ...} | {object: ...} }, optional: [k] } } }.
 */
export function shapeFor(shapes, file) {
  const base = file.replace(/\.md$/, '');
  const top = base.split('/')[0];
  const d = findNode(shapes, [file, base, top, `${top}.md`, `${top}/<slug>.md`]);
  if (!d || typeof d !== 'object') return null;
  const src = d.keys ?? d;
  const keys = new Map();
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') keys.set(k, v);
    else if (v && typeof v === 'object' && 'array' in v) keys.set(k, 'array');
    else if (v && typeof v === 'object') keys.set(k, 'object');
    else keys.set(k, undefined);
  }
  return { keys, optional: new Set(d.optional ?? []) };
}

export function typeMatches(actual, declared) {
  if (declared === undefined) return true;
  const norm = (t) => {
    t = String(t).trim().toLowerCase();
    return t === 'integer' || t === 'int' ? 'number' : t;
  };
  const opts = (Array.isArray(declared) ? declared : String(declared).split('|')).map(norm);
  return opts.includes(actual);
}
