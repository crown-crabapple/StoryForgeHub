// sf-claude-book command line (contracts M05-J05 sections 1, 2 and 4; M05-J06 sections 3 and 4). `run` returns the exit code:
// 0 ok, 1 refused (check found errors; publish without --confirm or with a stale hash), 2 usage or I/O error.
// It writes under <framework>/.work/<work-id>/ (see WorkDir in io.mjs); the only book writes are `suggest` and
// `propose-state` (new files under <book>/suggestions/) and `publish` (one scene, only with --confirm and a matching hash).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadModel } from './model.mjs';
import { ADAPTER_VERSION, buildPack, joinScenes, pad2, wordRange } from './pack.mjs';
import { runStyleChecker } from './style.mjs';
import { renderReviewRequest } from './review.mjs';
import { buildCheckReport, renderCheckReport, styleFindings } from './check.mjs';
import { renderCoWriteDraft, renderPlanRequest } from './author.mjs';
import { proposeState, suggestForScene } from './propose.mjs';
import { eolOf, splitFrontMatter, withEol } from './text.mjs';
import { parseConcatenatedJson } from './json-stream.mjs';
import { RefusedError, UsageError, WorkDir, createSuggestionFiles, isDirSync, isFileSync, readBytes, readText, replaceBookFile, sha256File } from './io.mjs';

const USAGE = `usage: sf-claude-book <command> --book <book folder> --framework <Claude-Book root> [--work-id <name>]
commands:
  context --chapter <n>                  build <framework>/.work/<work-id>/context/ from the book
  style --chapter <n> | --scene <id|path> [--python <exe>]
                                         run Claude-Book's style checker on the candidate and copy its report
  review-request --chapter <n>           write the reviewer work order (reports/chapter-NN-review-request.md)
  check --chapter <n> | --scene <id|path> [--no-style] [--python <exe>]
                                         read-only report (reports/chapter-NN-check-report.md and .json): validator, continuity, style; exit 1 on any error
  plan --chapter <n>                     build the context pack and write reports/chapter-NN-plan-request.md
  co-write --chapter <n> --from <file>   copy a draft to drafts/chapter-NN-draft.md, marked as a proposal
  suggest --scene <id|path> --from <file>
                                         create one suggestion document under <book>/suggestions/ (nothing is applied)
  propose-state --chapter <n> --from <chapter-NN-ledgers.json>
                                         create suggestion documents (state, timeline, threads, seed entries) under <book>/suggestions/
  publish --scene <id|path> --from <file> --expect-sha256 <hash> --confirm
                                         replace the scene body (front matter kept); refused without --confirm or on a stale hash
--framework defaults to env CLAUDE_BOOK_ROOT (suggest, propose-state and publish do not need it); --work-id defaults to the book slug.`;

const VALUE_FLAGS = new Set(['book', 'framework', 'work-id', 'chapter', 'scene', 'python', 'from', 'expect-sha256']);
const BOOL_FLAGS = new Set(['confirm', 'no-style']);
const COMMANDS = ['context', 'style', 'review-request', 'check', 'plan', 'co-write', 'suggest', 'propose-state', 'publish'];
const BOOK_ONLY = new Set(['suggest', 'propose-state', 'publish']);

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
    if (BOOL_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} takes no value`);
      opts[key] = 'true';
      continue;
    }
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

/** The text of a --from file. @param {string} file */
function readFrom(file) {
  const abs = path.resolve(file);
  if (!isFileSync(abs)) throw new UsageError(`--from is not a file: ${file}`);
  return readText(abs);
}

/**
 * Write adapter-manifest.json (contract section 2). sources = every canonical file the book read pulled in.
 * @param {WorkDir} work @param {import('./model.mjs').Model} model @param {string} command @param {number|null} chapter
 */
async function writeManifest(work, model, command, chapter) {
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
  await work.write('adapter-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  work.written.pop(); // the manifest does not list itself
}

/**
 * @param {string[]} argv arguments after `node sf-claude-book.mjs`
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, env?: Record<string, string|undefined>,
 *   provenance?: (event: Record<string, unknown>) => void }} [io] `provenance` is the M05-J04 hook seam (check.report,
 *   suggestion.create and publish events). The adapter does not depend on @storyforge/core, so the caller wires it (M05-J07).
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;
  const provenance = io.provenance ?? (() => {});
  try {
    const { command, opts } = parse(argv);
    if (!COMMANDS.includes(command)) throw new UsageError(`unknown command: ${command}\n${USAGE}`);
    if (!opts.book) throw new UsageError('--book <book folder> is required');
    const bookOnly = BOOK_ONLY.has(command);
    const frameworkArg = opts.framework ?? env.CLAUDE_BOOK_ROOT;
    if (!frameworkArg && !bookOnly) throw new UsageError('--framework <Claude-Book root> is required (or set CLAUDE_BOOK_ROOT)');
    const framework = frameworkArg ? path.resolve(frameworkArg) : '';
    if (!bookOnly && (!isDirSync(framework) || !isFileSync(path.join(framework, 'CLAUDE.md')) || !isFileSync(path.join(framework, 'scripts', 'style', 'style_checker.py')))) {
      throw new UsageError(`not a Claude-Book root (needs CLAUDE.md and scripts/style/style_checker.py): ${framework}`);
    }
    const model = await loadModel(opts.book);
    const bookId = model.bookDoc.fm.id;

    if (bookOnly) return await runBookCommand(command, opts, model, { out, provenance });

    const workId = opts['work-id'] ?? String(model.bookDoc.fm.slug ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workId)) throw new UsageError(`invalid --work-id "${workId}" (letters, digits, . _ - only)`);
    const work = new WorkDir(path.join(framework, '.work', workId));

    if (command === 'context' || command === 'plan') {
      const n = chapterOf(opts.chapter);
      const { files } = await buildPack(model, n);
      const ctxFiles = new Map([...files].filter(([rel]) => rel.startsWith('context/')));
      await work.replaceContext(ctxFiles);
      for (const [rel, text] of files) if (!ctxFiles.has(rel)) await work.write(rel, text);
      if (command === 'plan') await work.write(`reports/chapter-${pad2(n)}-plan-request.md`, renderPlanRequest({ framework, workId, chapter: n }));
      await writeManifest(work, model, command, n);
      out(`context pack for chapter ${pad2(n)}: ${files.size} files under ${work.dir}\n`);
      for (const rel of work.written) out(`  ${rel}\n`);
      return 0;
    }

    if (command === 'co-write') {
      const n = chapterOf(opts.chapter);
      if (opts.from === undefined) throw new UsageError('--from <draft file> is required');
      const text = readFrom(opts.from);
      const rel = `drafts/chapter-${pad2(n)}-draft.md`;
      await work.write(rel, renderCoWriteDraft({ chapter: n, from: opts.from, sha256: createHash('sha256').update(text).digest('hex'), text }));
      await writeManifest(work, model, command, n);
      out(`draft proposal: ${work.abs(rel)}\n`);
      return 0;
    }

    if (command === 'check') {
      let n;
      let scenes;
      let sceneId = null;
      if (opts.scene !== undefined) {
        const hit = findScene(model, opts.scene);
        n = hit.chapter;
        scenes = [hit];
        sceneId = String(hit.doc.fm.id);
      } else {
        n = chapterOf(opts.chapter);
        scenes = model.chapterScenes(n);
        if (scenes.length === 0) throw new UsageError(`chapter ${n} has no scenes in this book`);
      }
      const nn = pad2(n);
      let style = [];
      if (opts['no-style'] !== 'true') {
        const stem = sceneId ? `chapter-${nn}-scene-${scenes[0].position}` : `chapter-${nn}`;
        const candidateRel = `candidate/${stem}-candidate.md`;
        await work.write(candidateRel, `${joinScenes(model, scenes)}\n`);
        const { min, max } = wordRange(model);
        const unit = { kind: 'style', file: candidateRel, line: null, range: null, evidence: '' };
        try {
          const r = runStyleChecker({ framework, python: opts.python ?? 'python', candidatePath: work.abs(candidateRel), chapter: n, min, max });
          style = styleFindings(readText(r.report), candidateRel);
          if (r.verdict === 'FAIL' && !style.some((f) => f.severity === 'error')) {
            style.push({ ...unit, severity: 'error', code: 'STYLE', message: r.verdictLine || 'style checker verdict: FAIL' });
          }
        } catch (e) {
          if (!(e instanceof UsageError)) throw e;
          style = [{ ...unit, severity: 'info', code: 'STYLE_UNAVAILABLE', message: `style checker not run: ${e.message}` }];
        }
      }
      const report = await buildCheckReport({ model, chapter: n, sceneId, files: scenes.map((s) => s.doc.file), style });
      const mdRel = `reports/chapter-${nn}-check-report.md`;
      const jsonRel = `reports/chapter-${nn}-check-report.json`;
      await work.write(mdRel, renderCheckReport(report));
      await work.write(jsonRel, `${JSON.stringify(report, null, 2)}\n`);
      await writeManifest(work, model, command, n);
      provenance({ kind: 'check.report', bookId, chapter: n, sceneId, report: jsonRel, summary: report.summary });
      out(`check: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.info} info\nreport: ${work.abs(mdRel)}\n`);
      return report.summary.errors > 0 ? 1 : 0;
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
      await work.write(candidateRel, `${joinScenes(model, scenes)}\n`);
      const { min, max } = wordRange(model);
      const r = runStyleChecker({ framework, python: opts.python ?? 'python', candidatePath: work.abs(candidateRel), chapter: n, min, max });
      const reportRel = `reports/${stem}-style-tech-report.md`;
      await work.copyIn(r.report, reportRel);
      await writeManifest(work, model, command, n);
      out(`${r.verdictLine || r.verdict}\nreport: ${work.abs(reportRel)}\n`);
      return 0;
    }

    // review-request
    const n = chapterOf(opts.chapter);
    if (model.chapterScenes(n).length === 0) throw new UsageError(`chapter ${n} has no scenes in this book`);
    const rel = `reports/chapter-${pad2(n)}-review-request.md`;
    await work.write(rel, renderReviewRequest({ framework, workId, chapter: n }));
    await writeManifest(work, model, command, n);
    out(`review request: ${work.abs(rel)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof RefusedError) {
      err(`sf-claude-book: ${e.message}\n`);
      return 1;
    }
    if (e instanceof UsageError) {
      err(`sf-claude-book: ${e.message}\n`);
      return 2;
    }
    err(`sf-claude-book: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

/**
 * suggest, propose-state and publish: the commands that write into the book (always through the store).
 * @param {string} command @param {Record<string, string>} opts @param {import('./model.mjs').Model} model
 * @param {{ out: (s: string) => void, provenance: (e: Record<string, unknown>) => void }} o
 */
async function runBookCommand(command, opts, model, { out, provenance }) {
  const bookId = model.bookDoc.fm.id;
  if (command === 'propose-state') {
    const n = chapterOf(opts.chapter);
    if (opts.from === undefined) throw new UsageError('--from <chapter-NN-ledgers.json> is required');
    const raw = readFrom(opts.from);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        data = parseConcatenatedJson(raw)[0];
      } catch (e) {
        throw new UsageError(`--from is not JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UsageError('--from must hold the state-updater JSON object');
    if (data.chapter !== undefined && Number(data.chapter) !== n) throw new UsageError(`--chapter ${n} does not match the file's chapter ${data.chapter}`);
    const { files, notes } = proposeState({ model, chapter: n, data });
    if (files.length > 0) await createSuggestionFiles(model.root, files);
    for (const f of files) {
      provenance({ kind: 'suggestion.create', bookId, suggestionId: f.id, target: f.target, path: f.rel, mode: f.mode, source: f.source });
      out(`suggestion (${f.mode}): ${path.join(model.root, ...f.rel.split('/'))}\n`);
    }
    for (const note of notes) out(`note: ${note}\n`);
    if (files.length === 0) out('no suggestions created\n');
    return 0;
  }

  if (opts.scene === undefined) throw new UsageError('--scene <id|path> is required');
  if (opts.from === undefined) throw new UsageError('--from <file> is required');
  const fromText = readFrom(opts.from);
  const hit = findScene(model, opts.scene);

  if (command === 'suggest') {
    const f = suggestForScene({ model, scene: hit, fromText });
    await createSuggestionFiles(model.root, [f]);
    provenance({ kind: 'suggestion.create', bookId, suggestionId: f.id, target: f.target, path: f.rel, mode: f.mode, source: f.source });
    out(`suggestion: ${path.join(model.root, ...f.rel.split('/'))}\n`);
    return 0;
  }

  // publish: nothing is written without --confirm and the hash the author last saw
  if (opts.confirm !== 'true') throw new RefusedError('publish needs --confirm; nothing written');
  const expect = opts['expect-sha256'];
  if (!expect) throw new RefusedError('publish needs --expect-sha256 <hash of the scene file as you last saw it>; nothing written');
  const before = readBytes(path.join(model.root, ...hit.doc.rel.split('/')));
  const beforeSha = createHash('sha256').update(before).digest('hex');
  if (beforeSha !== expect.toLowerCase()) throw new RefusedError(`stale: the scene is now ${beforeSha}, not ${expect}; nothing written`);
  const baseText = before.toString('utf8');
  const split = splitFrontMatter(baseText);
  if (!split) throw new UsageError(`${hit.doc.rel} has no front matter`);
  const fromSplit = splitFrontMatter(fromText);
  const after = Buffer.from(`${split.head}${withEol(fromSplit ? fromSplit.body : fromText, eolOf(baseText))}`, 'utf8');
  if (after.equals(before)) throw new RefusedError('the text in --from is identical to the scene; nothing written');
  const r = await replaceBookFile(model.root, hit.doc.rel, after, beforeSha);
  if (!r.ok) throw new RefusedError(`the store refused the write (${r.code}); nothing written`);
  provenance({ kind: 'publish', bookId, sceneId: hit.doc.fm.id, target: hit.doc.fm.id, path: hit.doc.rel, before_sha256: beforeSha, after_sha256: r.sha256 });
  out(`published ${hit.doc.rel}\nbefore sha256: ${beforeSha}\nafter sha256: ${r.sha256}\n`);
  return 0;
}

/** A scene by id, or by path (relative to the book root or absolute). @param {import('./model.mjs').Model} model @param {string} ref */
function findScene(model, ref) {
  const wanted = path.resolve(model.root, ref);
  const hit = model.scenes.find((s) => s.doc.fm.id === ref || path.resolve(model.root, ...s.doc.rel.split('/')) === wanted || s.doc.rel === ref);
  if (!hit) throw new UsageError(`no scene with that id or path in the book's order: ${ref}`);
  return hit;
}
