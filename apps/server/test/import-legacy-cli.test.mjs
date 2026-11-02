// M06-J01 acceptance 2 (dry run changes nothing) and the CLI contract of section 3: `import-legacy --dump <dir> --dry-run [--report f] [--json f]`.
// Black-box: spawns apps/server/src/main.mjs against hand-built dumps from the legacy-import test helpers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  LEGACY_REPO, MAIN, SEED_DUMP, EDGE_DUMP, bookRow, chapterRow, copyTree, snapshot, tmpDir, writeDump,
} from '../../../packages/legacy-import/test/helpers.mjs';

const SECRET = 'SECRETTOKEN-cli-9f8e7d';

function run(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [MAIN, 'import-legacy', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function makeDump() {
  const dir = tmpDir('sf-cli-dump-');
  writeDump(dir, {
    books: [bookRow()],
    chapters: [
      chapterRow({ id: 1, num: '1', sort_order: 1, body: 'One.\n\n---\n\nTwo.\n' }),
      chapterRow({ id: 2, num: '2', sort_order: 2, body: 'Three.\n' }),
    ],
    users: [{ id: 1, display_name: 'Test Author' }],
    api_tokens: [{ id: 1, user_id: 1, token_hash: SECRET, label: 'laptop' }],
  });
  return dir;
}

/** A library directory with a few files, to prove the dry run does not touch it. */
function makeLibrary() {
  const lib = tmpDir('sf-cli-lib-');
  fs.mkdirSync(path.join(lib, 'some-book', 'manuscript'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'some-book', 'book.md'), '---\nid: book_x\n---\nhello\n');
  return lib;
}

const gitStatus = () => spawnSync('git', ['-C', LEGACY_REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;

test('dry run prints the report, exits 0 and leaves the dump, a library and the legacy repo untouched', () => {
  const dump = makeDump();
  const lib = makeLibrary();
  const [dumpBefore, libBefore, gitBefore] = [snapshot(dump), snapshot(lib), gitStatus()];
  const r = run(['--dump', dump, '--dry-run'], { cwd: lib, env: { STORYFORGE_LIBRARY: lib } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Nothing was written\./);
  assert.deepEqual(snapshot(dump), dumpBefore, 'dump dir bytes and mtimes');
  assert.deepEqual(snapshot(lib), libBefore, 'library bytes and mtimes');
  assert.equal(gitStatus(), gitBefore, 'legacy repo git status');
  assert.equal(gitBefore, '', 'legacy repo is clean');
});

test('--report and --json write exactly the two requested files and nothing else', () => {
  const dump = makeDump();
  const out = tmpDir('sf-cli-out-');
  const report = path.join(out, 'report.md');
  const json = path.join(out, 'plan.json');
  const before = snapshot(dump);
  const r = run(['--dump', dump, '--dry-run', '--report', report, '--json', json]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readdirSync(out).sort(), ['plan.json', 'report.md']);
  assert.deepEqual(snapshot(dump), before);
  assert.match(fs.readFileSync(report, 'utf8'), /Nothing was written\./);
  const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.equal(parsed.summary.coverage, 1);
  assert.equal(parsed.books[0].slug, 'salt-test');
});

test('--report and --json refuse a path that already exists and leave it intact', () => {
  const dump = makeDump();
  const out = tmpDir('sf-cli-out-');
  for (const flag of ['--report', '--json']) {
    const fresh = path.join(out, `fresh${flag}`);
    assert.equal(run(['--dump', dump, '--dry-run', flag, fresh]).code, 0, 'control: the same flag works on a new path');
    const target = path.join(out, `existing${flag}`);
    fs.writeFileSync(target, 'PRECIOUS');
    const r = run(['--dump', dump, '--dry-run', flag, target]);
    assert.notEqual(r.code, 0, `${flag} onto an existing file must be refused`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'PRECIOUS');
  }
});

test('--report and --json refuse a path inside the dump directory', () => {
  const dump = makeDump();
  const before = snapshot(dump);
  for (const [flag, rel] of [['--report', 'report.md'], ['--json', path.join('tables', 'plan.json')]]) {
    const target = path.join(dump, rel);
    assert.equal(run(['--dump', dump, '--dry-run', flag, path.join(tmpDir('sf-cli-out-'), 'ok')]).code, 0, 'control: the same flag works outside the dump');
    const r = run(['--dump', dump, '--dry-run', flag, target]);
    assert.notEqual(r.code, 0, `${flag} into the dump must be refused`);
    assert.ok(!fs.existsSync(target), `${target} must not be created`);
  }
  assert.deepEqual(snapshot(dump), before);
});

test('without --dry-run it exits 2, says the import is M06-J02, and writes nothing', () => {
  const dump = makeDump();
  const out = tmpDir('sf-cli-out-');
  const report = path.join(out, 'r.md');
  const before = snapshot(dump);
  const r = run(['--dump', dump, '--report', report]);
  assert.equal(r.code, 2);
  assert.match(r.out + r.err, /M06-J02/);
  assert.deepEqual(snapshot(dump), before);
  assert.ok(!fs.existsSync(report));
});

test('exits 1 when the dump cannot be fully accounted for (manifest says more rows than the table holds)', () => {
  const dump = makeDump();
  const mfPath = path.join(dump, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.tables.chapters.rows += 3;
  fs.writeFileSync(mfPath, JSON.stringify(mf));
  const r = run(['--dump', dump, '--dry-run']);
  assert.equal(r.code, 1, r.out + r.err);
});

test('exits 1 on an unusable dump directory (no manifest) and does not create it', () => {
  const missing = path.join(tmpDir('sf-cli-none-'), 'nope');
  const r = run(['--dump', missing, '--dry-run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(!fs.existsSync(missing));
});

test('the report is identical for the same dump, for a copy of it, and never contains a server-only secret', () => {
  const dump = makeDump();
  const copy = copyTree(dump, path.join(tmpDir('sf-cli-copy-'), 'elsewhere'));
  const a = run(['--dump', dump, '--dry-run']);
  const b = run(['--dump', dump, '--dry-run']);
  const c = run(['--dump', copy, '--dry-run']);
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, b.out);
  assert.equal(a.out, c.out, 'report must not mention the dump location');
  assert.ok(!(a.out + a.err).includes(SECRET));
  assert.ok(a.out.includes('salt-test') || a.out.includes('Salt Test'));
});

test('--json output is identical across runs and has no secret', () => {
  const dump = makeDump();
  const jsons = [0, 1].map(() => {
    const f = path.join(tmpDir('sf-cli-out-'), 'p.json');
    assert.equal(run(['--dump', dump, '--dry-run', '--json', f]).code, 0);
    return fs.readFileSync(f);
  });
  assert.equal(createHash('sha256').update(jsons[0]).digest('hex'), createHash('sha256').update(jsons[1]).digest('hex'));
  assert.ok(!jsons[0].toString('utf8').includes(SECRET));
});

test('--book restricts the plan to the named legacy book', () => {
  const dump = tmpDir('sf-cli-dump-');
  writeDump(dump, {
    books: [bookRow(), bookRow({ id: 'bk-two', folder: 'second-book', title: 'Second' })],
    chapters: [chapterRow({ id: 1 }), chapterRow({ id: 2, book_id: 'bk-two' })],
  });
  const f = path.join(tmpDir('sf-cli-out-'), 'p.json');
  const r = run(['--dump', dump, '--dry-run', '--book', 'second-book', '--json', f]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).books.map((b) => b.slug), ['second-book']);
});

test('committed fixtures: dry run exits 0 (or 1 only for documented error issues) and changes nothing in them', () => {
  for (const dir of [SEED_DUMP, EDGE_DUMP]) {
    const before = snapshot(dir);
    const f = path.join(tmpDir('sf-cli-out-'), 'p.json');
    const r = run(['--dump', dir, '--dry-run', '--json', f]);
    const plan = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(plan.summary.coverage, 1, dir);
    assert.equal(r.code, plan.issues.some((i) => i.severity === 'error') ? 1 : 0, r.err);
    assert.deepEqual(snapshot(dir), before, dir);
  }
});
