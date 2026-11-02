// M03-J03 acceptance 3: in a temp copy that is a real git repo (committed before), moves done through the API
// change only act:/chapter:/sequence: front-matter lines and file paths. Every changed file is a pure rename or a
// rename/edit whose changed lines are position lines above the closing `---`; zero changed body lines.
// Runs the same checks on an LF book and on a CRLF book (git told not to convert line endings).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyFixture } from './helpers.mjs';
import { ARRIVAL, FERRY, KEY, LOWTIDE, WALL, closeAll, move, startApi } from './move-helpers.mjs';

after(closeAll);

const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
const HAVE_GIT = gitVersion.status === 0;
const SKIP = HAVE_GIT ? false : 'git is not on PATH, so the real git-diff check cannot run';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

const ACT1 = 'manuscript/act-01-low-water';

async function mdFiles(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await mdFiles(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Make chapter 2 hold FERRY at 10 and GRAFTING at 11 so a move there has to renumber a neighbour. */
async function closeGap(root) {
  const dir = path.join(root, ACT1, 'ch-002-the-grafting');
  const f = path.join(dir, '0020-the-grafting.md');
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/^sequence: 20(\r?)$/m, 'sequence: 11$1'));
  await fs.rename(f, path.join(dir, '0011-the-grafting.md'));
}

async function toCrlf(root) {
  for (const f of await mdFiles(root)) {
    const text = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, text.replace(/\r?\n/g, '\r\n'));
  }
}

async function repoWith(prep) {
  const root = await copyFixture('valid/salt-orchard');
  await closeGap(root);
  if (prep) await prep(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'StoryForge Test'); // local to this temp repo only
  git(root, 'config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.storyforge/\n.storyforge-lock\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'before');
  return root;
}

/** Parse `git diff --cached --unified=0` into [{ oldPath, newPath, hunks: [{ oldStart, oldCount, lines }] }]. */
function parsePatch(patch) {
  const files = [];
  let cur = null;
  let hunk = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { oldPath: null, newPath: null, hunks: [] };
      files.push(cur);
      hunk = null;
    } else if (!cur) continue;
    else if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length);
    else if (!hunk && line.startsWith('--- ')) cur.oldPath ??= line.slice(4).replace(/^a\//, '');
    else if (!hunk && line.startsWith('+++ ')) cur.newPath ??= line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk && (line.startsWith('+') || line.startsWith('-'))) hunk.lines.push(line);
  }
  return files;
}

/** 1-based line number of the closing `---` of the front matter. */
function closingLine(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  assert.equal(lines[0], '---');
  const i = lines.indexOf('---', 1);
  assert.ok(i > 0, 'closing --- found');
  return i + 1;
}

const POSITION_LINE = /^[-+](chapter|act|sequence):[ \t]*-?\d+[ \t]*\r?$/;

async function runMoves(root, moves) {
  const { port } = await startApi(root);
  for (const [scene, body] of moves) {
    const r = await move(port, scene, body);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.text);
  }
}

async function assertOnlyExpectedChanges(root, { crlf }) {
  git(root, 'add', '-A'); // stage so that git pairs deleted and added paths into renames
  const names = git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--name-status').trim().split('\n').filter(Boolean);
  assert.ok(names.length >= 3, `the moves changed files:\n${names.join('\n')}`);
  for (const line of names) {
    const [status, ...paths] = line.split('\t');
    assert.match(status, /^(R\d+|M)$/, `only renames or modifications (never add/delete/copy): ${line}`);
    for (const p of paths) assert.match(p, /^manuscript\/.+\/\d+-[^/]+\.md$/, `only scene files change: ${p}`);
  }
  assert.ok(names.some((l) => l.startsWith('R')), 'at least one rename');

  const patch = git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--unified=0', '--no-color');
  const files = parsePatch(patch);
  let positionEdits = 0;
  for (const f of files) {
    const oldText = git(root, 'show', `HEAD:${f.oldPath}`);
    const closing = closingLine(oldText);
    const newText = await fs.readFile(path.join(root, ...f.newPath.split('/')), 'utf8');
    for (const h of f.hunks) {
      for (const l of h.lines) {
        assert.match(l, POSITION_LINE, `${f.newPath}: only act/chapter/sequence lines may change, got ${JSON.stringify(l)}`);
        positionEdits += 1;
      }
      if (h.oldCount > 0) assert.ok(h.oldStart + h.oldCount - 1 < closing, `${f.oldPath}: changed lines ${h.oldStart}..${h.oldStart + h.oldCount - 1} lie above the closing --- (line ${closing})`);
    }
    // body byte-identical, from the closing --- on
    const oldBody = oldText.split('\n').slice(closing).join('\n');
    const newBody = newText.split('\n').slice(closingLine(newText)).join('\n');
    assert.equal(newBody, oldBody, `${f.newPath}: body identical`);
    // every file keeps its own line endings (the fixture's grafting scene is CRLF even in the "LF" book)
    const wasCrlf = oldText.includes('\r\n');
    if (crlf) assert.ok(wasCrlf, `${f.oldPath} was CRLF in the CRLF book`);
    if (wasCrlf) assert.equal((newText.match(/\n/g) ?? []).length, (newText.match(/\r\n/g) ?? []).length, `${f.newPath}: still CRLF throughout`);
    else assert.ok(!newText.includes('\r'), `${f.newPath}: still LF`);
  }
  assert.ok(positionEdits > 0, 'some position lines changed');
  // nothing outside manuscript/ scenes was touched (also catches stray files)
  assert.equal(git(root, 'diff', '--cached', '--name-only', '--', ':!manuscript').trim(), '');
}

const MOVES = [
  [KEY, { chapter: 3, after: LOWTIDE }], // other act
  [ARRIVAL, { chapter: 2, after: FERRY }], // needs a renumber (10, 11 gap closed)
  [WALL, { chapter: 1, after: null }], // back to act 1, first slot
];

test('3. git diff after moves (LF): only renames and act/chapter/sequence lines above the closing ---', { skip: SKIP }, async () => {
  const root = await repoWith();
  await runMoves(root, MOVES);
  await assertOnlyExpectedChanges(root, { crlf: false });
});

test('3. git diff after moves (CRLF files): same, and every line ending is preserved', { skip: SKIP }, async () => {
  const root = await repoWith(toCrlf);
  await runMoves(root, MOVES);
  await assertOnlyExpectedChanges(root, { crlf: true });
});

test('3. a single within-chapter move is exactly one rename with one or two position lines changed', { skip: SKIP }, async () => {
  const root = await repoWith();
  await runMoves(root, [[LOWTIDE, { chapter: 3, after: WALL }]]);
  git(root, 'add', '-A');
  const names = git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--name-status').trim().split('\n');
  assert.equal(names.length, 1, names.join('\n'));
  assert.match(names[0], /^R\d+\tmanuscript\/act-02-high-water\/ch-003-the-wall\/0010-low-tide\.md\tmanuscript\/act-02-high-water\/ch-003-the-wall\/0030-low-tide\.md$/);
  const files = parsePatch(git(root, 'diff', '--cached', '-M', '--find-renames=50%', '--unified=0', '--no-color'));
  const changed = files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
  assert.deepEqual(changed.sort(), ['+sequence: 30', '-sequence: 10']);
});
