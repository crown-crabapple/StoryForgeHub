// M06-J02 acceptance (docs/contracts/M06-J02-import-rehearsal.md section 6): import into a new folder, reconcile against the dump, compare two
// imports, refusals, tampering, index rebuild, untouched sources, and a report without book text. Fixtures only (seed-dump and edge-dump).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { validate } from '@storyforge/format';
import {
  EDGE_DUMP, LEGACY_REPO, MAIN, SEED_DUMP, copyTree, frontMatterSplit, loadImporter, snapshot, tmpDir,
} from './helpers.mjs';

const {
  CHECK_NAMES, compareLibraries, executePlan, planImport, reconcile, renderReconciliation, reconciliationToJson,
} = await loadImporter();

const FIXTURES = [['seed-dump', SEED_DUMP], ['edge-dump', EDGE_DUMP]];

function cli(args) {
  const r = spawnSync(process.execPath, [MAIN, 'import-legacy', ...args], { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Import a dump through the API into <fresh tmp>/lib and return the library folder. */
async function importInto(dump) {
  const lib = path.join(tmpDir('sf-j02-'), 'lib');
  const r = await executePlan(planImport(dump), lib);
  assert.equal(r.ok, true);
  return lib;
}

const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]));
const failing = (rec) => rec.books.flatMap((b) => b.checks.filter((c) => !c.ok).map((c) => c.name));
const sceneFiles = (lib) => walk(lib).filter((p) => p.endsWith('.md') && /\/manuscript\/.+\/ch-[^/]+\/\d{4}-[^/]+\.md$/.test(`/${p}`));
const read = (lib, rel) => fs.readFileSync(path.join(lib, rel), 'utf8');
const put = (lib, rel, text) => fs.writeFileSync(path.join(lib, rel), text);

describe('1. import into a temp folder', () => {
  for (const [label, dump] of FIXTURES) {
    test(`${label}: exit 0, every book validates, reconciliation has no unexplained difference`, async () => {
      const lib = path.join(tmpDir('sf-j02-cli-'), 'lib');
      const r = cli(['--dump', dump, '--into', lib]);
      assert.equal(r.code, 0, r.out + r.err);
      const plan = planImport(dump);
      for (const b of plan.books) {
        const v = await validate(path.join(lib, b.slug));
        assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), [], `${b.slug} validates`);
      }
      const rec = await reconcile(dump, lib);
      assert.equal(rec.unexplained, 0, renderReconciliation(rec));
      assert.equal(rec.books.length, plan.books.length);
      for (const b of rec.books) assert.deepEqual(b.checks.map((c) => c.name), CHECK_NAMES);
      // the folder holds only the imported books: no report, index, receipts or .storyforge/
      assert.deepEqual(fs.readdirSync(lib).sort(), plan.books.map((b) => b.slug).sort());
      assert.ok(!walk(lib).some((p) => p.includes('.storyforge')));
      assert.equal(walk(lib).length, plan.summary.files);
    });

    test(`${label}: --reconcile of the imported folder exits 0 and writes the report and JSON`, () => {
      const lib = path.join(tmpDir('sf-j02-cli-'), 'lib');
      assert.equal(cli(['--dump', dump, '--into', lib]).code, 0);
      const out = tmpDir('sf-j02-out-');
      const r = cli(['--dump', dump, '--reconcile', lib, '--report', path.join(out, 'r.md'), '--json', path.join(out, 'r.json')]);
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(fs.readFileSync(path.join(out, 'r.md'), 'utf8'), /Unexplained differences/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'r.json'), 'utf8')).unexplained, 0);
    });
  }
});

describe('2. two imports are equivalent', () => {
  for (const [label, dump] of FIXTURES) {
    test(`${label}: compareLibraries equivalent; one changed byte names the path`, async () => {
      const a = await importInto(dump);
      const b = await importInto(dump);
      assert.deepEqual(compareLibraries(a, b), { equivalent: true, differences: [] });
      assert.equal(cli(['--compare', a, b]).code, 0);
      const target = sceneFiles(b)[0];
      const buf = fs.readFileSync(path.join(b, target));
      buf[buf.length - 1] ^= 1;
      fs.writeFileSync(path.join(b, target), buf);
      const r = compareLibraries(a, b);
      assert.equal(r.equivalent, false);
      assert.deepEqual(r.differences.map((d) => d.path), [target]);
      const c = cli(['--compare', a, b]);
      assert.equal(c.code, 1);
      assert.ok(c.out.includes(target));
    });
  }

  test('.storyforge/ is ignored, an extra file is not', async () => {
    const a = await importInto(SEED_DUMP);
    const b = await importInto(SEED_DUMP);
    const book = fs.readdirSync(b)[0];
    fs.mkdirSync(path.join(b, book, '.storyforge'));
    fs.writeFileSync(path.join(b, book, '.storyforge', 'index.sqlite'), 'x');
    assert.equal(compareLibraries(a, b).equivalent, true);
    fs.writeFileSync(path.join(b, book, 'extra.md'), 'x');
    assert.deepEqual(compareLibraries(a, b).differences, [{ path: `${book}/extra.md`, why: 'only in the second library' }]);
  });
});

describe('3. refusals write nothing', () => {
  test('a non-empty --into folder', () => {
    const into = tmpDir('sf-j02-full-');
    fs.writeFileSync(path.join(into, 'keep.txt'), 'mine');
    const before = snapshot(into);
    const r = cli(['--dump', SEED_DUMP, '--into', into]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.deepEqual(snapshot(into), before);
  });

  test('--into that is a file', () => {
    const file = path.join(tmpDir('sf-j02-file-'), 'lib');
    fs.writeFileSync(file, 'x');
    assert.equal(cli(['--dump', SEED_DUMP, '--into', file]).code, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  });

  test('--into inside the dump folder', () => {
    const dump = copyTree(SEED_DUMP, path.join(tmpDir('sf-j02-dump-'), 'dump'));
    const before = snapshot(dump);
    const into = path.join(dump, 'lib');
    const r = cli(['--dump', dump, '--into', into]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok(!fs.existsSync(into));
    assert.deepEqual(snapshot(dump), before);
  });

  test('--into inside a folder named legacy-StoryForgeHub', () => {
    const parent = path.join(tmpDir('sf-j02-legacy-'), 'legacy-StoryForgeHub');
    fs.mkdirSync(parent);
    const into = path.join(parent, 'lib');
    const r = cli(['--dump', SEED_DUMP, '--into', into]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok(!fs.existsSync(into));
  });

  test('--report inside <into>, and --report that already exists', () => {
    const root = tmpDir('sf-j02-rep-');
    const into = path.join(root, 'lib');
    const r = cli(['--dump', SEED_DUMP, '--into', into, '--report', path.join(into, 'report.md')]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok(!fs.existsSync(into), 'nothing was written');
    const existing = path.join(root, 'r.md');
    fs.writeFileSync(existing, 'old');
    assert.equal(cli(['--dump', SEED_DUMP, '--into', into, '--report', existing]).code, 2);
    assert.ok(!fs.existsSync(into));
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old');
  });

  test('--report inside the reconciled library', async () => {
    const lib = await importInto(SEED_DUMP);
    const before = snapshot(lib);
    const r = cli(['--dump', SEED_DUMP, '--reconcile', lib, '--report', path.join(lib, 'r.md')]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.deepEqual(snapshot(lib), before);
  });

  test('a plan with an error issue is refused with exit 1', () => {
    const dump = copyTree(SEED_DUMP, path.join(tmpDir('sf-j02-bad-'), 'dump'));
    const mf = path.join(dump, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.tables.chapters.rows += 3; // the manifest claims rows the table does not hold
    fs.writeFileSync(mf, JSON.stringify(m));
    const into = path.join(tmpDir('sf-j02-bad-into-'), 'lib');
    const r = cli(['--dump', dump, '--into', into]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.ok(!fs.existsSync(into), 'nothing was written');
  });

  test('without a mode it exits 2; --dry-run still works and writes nothing', () => {
    assert.equal(cli(['--dump', SEED_DUMP]).code, 2);
    assert.equal(cli(['--dump', SEED_DUMP, '--dry-run']).code, 0);
    assert.equal(cli(['--dump', SEED_DUMP, '--dry-run', '--into', path.join(tmpDir('sf-j02-x-'), 'lib')]).code, 2);
  });

  test('executePlan reports TARGET_NOT_EMPTY and leaves the folder alone', async () => {
    const into = tmpDir('sf-j02-full-');
    fs.writeFileSync(path.join(into, 'keep.txt'), 'mine');
    const before = snapshot(into);
    const r = await executePlan(planImport(SEED_DUMP), into);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TARGET_NOT_EMPTY');
    assert.deepEqual(snapshot(into), before);
  });
});

describe('4. reconciliation catches tampering', () => {
  /** Run `tamper` on a fresh seed import and return the names of the failing checks. */
  async function tampered(tamper, dump = SEED_DUMP) {
    const lib = await importInto(dump);
    assert.equal((await reconcile(dump, lib)).unexplained, 0, 'clean before tampering');
    tamper(lib);
    const rec = await reconcile(dump, lib);
    assert.ok(rec.unexplained > 0, 'tampering is caught');
    return { names: failing(rec), rec };
  }
  const multiScene = (lib) => {
    const byDir = new Map();
    for (const p of sceneFiles(lib)) byDir.set(path.posix.dirname(p), [...(byDir.get(path.posix.dirname(p)) ?? []), p]);
    return [...byDir.values()].find((l) => l.length >= 2 && !l[0].includes('/archive/') && !l[0].startsWith('archive/'));
  };

  test('(a) a deleted scene file: counts and ids', async () => {
    const { names, rec } = await tampered((lib) => fs.unlinkSync(path.join(lib, sceneFiles(lib)[0])));
    assert.ok(names.includes('counts'), names.join());
    assert.ok(names.includes('ids'), names.join());
    assert.ok(names.includes('text-hashes'), names.join());
    assert.ok(failing(rec).length >= 3);
  });

  test('(b) one byte of a scene body: text-hashes only among counts/ids/order', async () => {
    const { names } = await tampered((lib) => {
      const p = sceneFiles(lib).find((f) => frontMatterSplit(Buffer.from(read(lib, f))).body.length > 3);
      const buf = fs.readFileSync(path.join(lib, p));
      buf[buf.length - 3] = buf[buf.length - 3] === 0x41 ? 0x42 : 0x41;
      fs.writeFileSync(path.join(lib, p), buf);
    });
    assert.ok(names.includes('text-hashes'), names.join());
    assert.ok(!names.includes('counts') && !names.includes('ids') && !names.includes('order'), names.join());
  });

  test('(c) two scenes swap their sequence: order', async () => {
    const { names } = await tampered((lib) => {
      const [a, b] = multiScene(lib);
      const sa = /^sequence: (\d+)$/m.exec(read(lib, a))[1];
      const sb = /^sequence: (\d+)$/m.exec(read(lib, b))[1];
      put(lib, a, read(lib, a).replace(/^sequence: \d+$/m, `sequence: ${sb}`));
      put(lib, b, read(lib, b).replace(/^sequence: \d+$/m, `sequence: ${sa}`));
    });
    assert.ok(names.includes('order'), names.join());
    assert.ok(!names.includes('ids'), names.join());
  });

  test('(d) a removed related item: codex-links', async () => {
    const { names } = await tampered((lib) => {
      const p = walk(lib).find((f) => /\/codex\//.test(`/${f}`) && /^ {2}- to: /m.test(read(lib, f)));
      assert.ok(p, 'the fixture has an entry with related items');
      put(lib, p, read(lib, p).replace(/^ {2}- to: .*\n/m, ''));
    });
    assert.ok(names.includes('codex-links'), names.join());
    assert.ok(!names.includes('counts'), names.join());
  });

  test('(e) a deleted revision file: archive-revisions', async () => {
    const { names } = await tampered((lib) => fs.unlinkSync(path.join(lib, walk(lib).find((f) => f.includes('/legacy/history/')))));
    assert.ok(names.includes('archive-revisions'), names.join());
    assert.ok(names.includes('coverage'), names.join());
  });

  test('(f) the same tampering is caught on the edge dump (a scene byte, a deleted comment file)', async () => {
    const byte = await tampered((lib) => {
      const p = sceneFiles(lib).find((f) => !f.startsWith('archive/') && !f.includes('/archive/') && read(lib, f).length > 200);
      const buf = fs.readFileSync(path.join(lib, p));
      buf[buf.length - 2] ^= 1;
      fs.writeFileSync(path.join(lib, p), buf);
    }, EDGE_DUMP);
    assert.ok(byte.names.includes('text-hashes'), byte.names.join());
    const comments = await tampered((lib) => {
      for (const f of walk(lib).filter((x) => x.includes('/planning/legacy/comments/'))) fs.unlinkSync(path.join(lib, f));
    }, EDGE_DUMP);
    assert.ok(comments.names.includes('notes-comments'), comments.names.join());
  });

  test('an id that maps to no legacy row is caught', async () => {
    const a = await tampered((lib) => {
      const p = walk(lib).find((f) => /\/codex\//.test(`/${f}`));
      const id = /^id: (\S+)$/m.exec(read(lib, p))[1];
      put(lib, p, read(lib, p).replace(id, 'entry_00000000000000000000000000'));
    });
    assert.ok(a.names.includes('ids'), a.names.join());
  });

  test('the report names ids and counts for the failures, and the JSON parses', async () => {
    const { rec } = await tampered((lib) => fs.unlinkSync(path.join(lib, sceneFiles(lib)[0])));
    const md = renderReconciliation(rec);
    assert.match(md, /FAILED/);
    assert.match(md, /Unexplained differences/);
    assert.equal(JSON.parse(reconciliationToJson(rec)).unexplained, rec.unexplained);
    for (const c of rec.books.flatMap((b) => b.checks)) assert.ok((c.details ?? []).length <= 21);
  });
});

describe('5. the imported library survives index delete and rebuild', () => {
  for (const [label, dump] of FIXTURES) {
    test(`${label}: delete .storyforge, rebuild, validate`, async () => {
      const lib = await importInto(dump);
      const fresh = await importInto(dump);
      const run = () => spawnSync(process.execPath, [MAIN, 'rebuild', '--library', lib], { encoding: 'utf8', timeout: 120_000 });
      const first = run();
      assert.equal(first.status, 0, first.stdout + first.stderr);
      for (const slug of fs.readdirSync(lib).filter((n) => !n.startsWith('.'))) fs.rmSync(path.join(lib, slug, '.storyforge'), { recursive: true, force: true });
      fs.rmSync(path.join(lib, '.storyforge'), { recursive: true, force: true });
      const second = run();
      assert.equal(second.status, 0, second.stdout + second.stderr);
      const v = await validate(lib);
      assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), []);
      assert.equal(compareLibraries(lib, fresh).equivalent, true, 'rebuilding the index changes no book file');
      assert.equal((await reconcile(dump, lib)).unexplained, 0);
    });
  }
});

describe('6. sources are left untouched', () => {
  test('the dump folder is unchanged by import, reconcile and compare', async () => {
    const dump = copyTree(SEED_DUMP, path.join(tmpDir('sf-j02-src-'), 'dump'));
    const before = snapshot(dump);
    const lib = path.join(tmpDir('sf-j02-src-lib-'), 'lib');
    assert.equal(cli(['--dump', dump, '--into', lib]).code, 0);
    assert.equal(cli(['--dump', dump, '--reconcile', lib]).code, 0);
    assert.deepEqual(snapshot(dump), before);
  });

  test('the legacy repository is clean before and after (skipped when it is not there)', (t) => {
    if (!fs.existsSync(path.join(LEGACY_REPO, '.git'))) {
      t.skip(`no legacy repository at ${LEGACY_REPO}`);
      return;
    }
    const status = () => spawnSync('git', ['status', '--porcelain'], { cwd: LEGACY_REPO, encoding: 'utf8' }).stdout;
    const before = status();
    const lib = path.join(tmpDir('sf-j02-legacy-lib-'), 'lib');
    assert.equal(cli(['--dump', SEED_DUMP, '--into', lib]).code, 0);
    assert.equal(status(), before);
  });
});

describe('7. the report holds no book text', () => {
  for (const [label, dump] of FIXTURES) {
    test(`${label}: no 20-character run of any scene body appears in the report, the JSON or the CLI output`, async () => {
      const plan = planImport(dump);
      const lib = path.join(tmpDir('sf-j02-rep-'), 'lib');
      const cliRun = cli(['--dump', dump, '--into', lib]);
      assert.equal(cliRun.code, 0);
      const rec = await reconcile(dump, lib);
      const haystack = [renderReconciliation(rec), reconciliationToJson(rec), cliRun.out].join('\n');
      let checked = 0;
      for (const ch of plan.chapters) {
        for (const sc of ch.scenes) {
          const body = sc.body.replace(/\s+/g, ' ');
          for (let i = 0; i + 20 <= body.length; i++) {
            const run = body.slice(i, i + 20);
            if (run.trim().length < 20) continue;
            checked += 1;
            assert.ok(!haystack.includes(run), `report must not contain scene text: ${JSON.stringify(run)}`);
          }
        }
      }
      assert.ok(checked > 50, `the fixture has enough scene text to scan (${checked} runs)`);
    });
  }
});
