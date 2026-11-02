// sf-claude-book command line (contract M05-J05 sections 1, 2 and 4). `run` returns the exit code:
// 0 ok, 2 usage or I/O error. It writes only under <framework>/.work/<work-id>/ (see WorkDir in io.mjs).
import path from 'node:path';
import { loadModel } from './model.mjs';
import { ADAPTER_VERSION, buildPack, joinScenes, pad2, wordRange } from './pack.mjs';
import { runStyleChecker } from './style.mjs';
import { renderReviewRequest } from './review.mjs';
import { UsageError, WorkDir, isDirSync, isFileSync, sha256File } from './io.mjs';

const USAGE = `usage: sf-claude-book <command> --book <book folder> --framework <Claude-Book root> [--work-id <name>]
commands:
  context --chapter <n>                  build <framework>/.work/<work-id>/context/ from the book
  style --chapter <n> | --scene <id|path> [--python <exe>]
                                         run Claude-Book's style checker on the candidate and copy its report
  review-request --chapter <n>           write the reviewer work order (reports/chapter-NN-review-request.md)
--framework defaults to env CLAUDE_BOOK_ROOT; --work-id defaults to the book slug.`;

const VALUE_FLAGS = new Set(['book', 'framework', 'work-id', 'chapter', 'scene', 'python']);

/** @param {string[]} argv @returns {{ command: string, opts: Record<string, string> }} */
function parse(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') throw new UsageError(USAGE);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}\n${USAGE}`);
    const eq = a.indexOf('=');
    const key = (eq < 0 ? a.slice(2) : a.slice(2, eq));
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`unknown option: --${key}\n${USAGE}`);
    const value = eq < 0 ? rest[++i] : a.slice(eq + 1);
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${key} needs a value`);
    opts[key] = value;
  }
  return { command, opts };
}

/** @param {string|undefined} v */
function chapterOf(v) {
  if (v === undefined) throw new UsageError('--chapter <n> is required');
  if (!/^\d+$/.test(v)) throw new UsageError(`--chapter must be a whole number, got "${v}"`);
  return Number(v);
}

/**
 * Write adapter-manifest.json (contract section 2). sources = every canonical file the book read pulled in.
 * @param {WorkDir} work @param {import('./model.mjs').Model} model @param {string} command @param {number|null} chapter
 */
function writeManifest(work, model, command, chapter) {
  const sources = [...model.docs]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((d) => ({ path: d.file, sha256: sha256File(path.join(model.root, ...d.rel.split('/'))) }));
  const manifest = {
    adapter_version: ADAPTER_VERSION,
    command,
    book_root: model.root,
    book_id: model.bookDoc.fm.id,
    chapter,
    generated: [...work.written],
    sources,
  };
  work.ensure();
  work.write('adapter-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  work.written.pop(); // the manifest does not list itself
}

/**
 * @param {string[]} argv arguments after `node sf-claude-book.mjs`
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, env?: Record<string, string|undefined> }} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;
  try {
    const { command, opts } = parse(argv);
    if (!['context', 'style', 'review-request'].includes(command)) throw new UsageError(`unknown command: ${command}\n${USAGE}`);
    if (!opts.book) throw new UsageError('--book <book folder> is required');
    const frameworkArg = opts.framework ?? env.CLAUDE_BOOK_ROOT;
    if (!frameworkArg) throw new UsageError('--framework <Claude-Book root> is required (or set CLAUDE_BOOK_ROOT)');
    const framework = path.resolve(frameworkArg);
    if (!isDirSync(framework) || !isFileSync(path.join(framework, 'CLAUDE.md')) || !isFileSync(path.join(framework, 'scripts', 'style', 'style_checker.py'))) {
      throw new UsageError(`not a Claude-Book root (needs CLAUDE.md and scripts/style/style_checker.py): ${framework}`);
    }
    const model = await loadModel(opts.book);
    const workId = opts['work-id'] ?? String(model.bookDoc.fm.slug ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workId)) throw new UsageError(`invalid --work-id "${workId}" (letters, digits, . _ - only)`);
    const work = new WorkDir(path.join(framework, '.work', workId));
    work.ensure();

    if (command === 'context') {
      const n = chapterOf(opts.chapter);
      const { files } = await buildPack(model, n);
      work.resetContext();
      for (const [rel, text] of files) work.write(rel, text);
      writeManifest(work, model, command, n);
      out(`context pack for chapter ${pad2(n)}: ${files.size} files under ${work.dir}\n`);
      for (const rel of work.written) out(`  ${rel}\n`);
      return 0;
    }

    if (command === 'style') {
      let n;
      let scenes;
      let stem;
      if (opts.scene !== undefined) {
        const hit = findScene(model, opts.scene);
        n = hit.chapter;
        scenes = [hit];
        stem = `chapter-${pad2(n)}-scene-${hit.position}`;
      } else {
        n = chapterOf(opts.chapter);
        scenes = model.chapterScenes(n);
        if (scenes.length === 0) throw new UsageError(`chapter ${n} has no scenes in this book`);
        stem = `chapter-${pad2(n)}`;
      }
      const candidateRel = `candidate/${stem}-candidate.md`;
      work.write(candidateRel, `${joinScenes(model, scenes)}\n`);
      const { min, max } = wordRange(model);
      const r = runStyleChecker({ framework, python: opts.python ?? 'python', candidatePath: work.abs(candidateRel), chapter: n, min, max });
      const reportRel = `reports/${stem}-style-tech-report.md`;
      work.copyIn(r.report, reportRel);
      writeManifest(work, model, command, n);
      out(`${r.verdictLine || r.verdict}\nreport: ${work.abs(reportRel)}\n`);
      return 0;
    }

    // review-request
    const n = chapterOf(opts.chapter);
    if (model.chapterScenes(n).length === 0) throw new UsageError(`chapter ${n} has no scenes in this book`);
    const rel = `reports/chapter-${pad2(n)}-review-request.md`;
    work.write(rel, renderReviewRequest({ framework, workId, chapter: n }));
    writeManifest(work, model, command, n);
    out(`review request: ${work.abs(rel)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`sf-claude-book: ${e.message}\n`);
      return 2;
    }
    err(`sf-claude-book: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

/** A scene by id, or by path (relative to the book root or absolute). @param {import('./model.mjs').Model} model @param {string} ref */
function findScene(model, ref) {
  const wanted = path.resolve(model.root, ref);
  const hit = model.scenes.find((s) => s.doc.fm.id === ref || path.resolve(model.root, ...s.doc.rel.split('/')) === wanted || s.doc.rel === ref);
  if (!hit) throw new UsageError(`no scene with that id or path in the book's order: ${ref}`);
  return hit;
}
