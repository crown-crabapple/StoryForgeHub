// CLI: node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --dry-run [--report <file.md>] [--json <file.json>]   (M06-J01)
//      node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --into <new library folder> [--report <file.md>] [--json <file.json>]   (M06-J02)
//      node apps/server/src/main.mjs import-legacy --dump <dir> --reconcile <library folder> [--report <file.md>] [--json <file.json>]
//      node apps/server/src/main.mjs import-legacy --compare <library A> <library B>
// A dry run reads a legacy dump (see tools/legacy-dump) and prints what an import WOULD create; nothing is written except the report/JSON files named
// here, and those only to a path that does not exist yet and is not inside the dump. --into writes the plan into a NEW library folder (only through
// @storyforge/store, all books in one call), validates every imported book and reconciles the result against the dump; --reconcile does the
// reconciliation for an existing library; --compare says whether two libraries are byte-identical (ignoring .storyforge/). The legacy app is never touched.
// Exit codes: 0 ok (plan complete / every book validates and nothing is unexplained / libraries equivalent), 1 errors in the dump, the plan, the
// imported books or the reconciliation (or the libraries differ), 2 usage or a refused path.
import path from 'node:path';
import { validate } from '@storyforge/format';
import {
  DumpError, compareLibraries, executePlan, insideLibrary, intoPathProblem, isFolder, outputPathProblem, planImport, planToJson, reconcile, reconciliationToJson, renderReconciliation, renderReport,
} from '@storyforge/legacy-import';
import { writeOutFile } from '@storyforge/store';

export const LEGACY_COMMANDS = ['import-legacy'];

const VALUE_FLAGS = ['--dump', '--book', '--report', '--json', '--into', '--reconcile'];
/** @param {string[]} argv arguments after `import-legacy` @returns {Promise<number>} the exit code */
export async function runLegacyCommand(argv) {
  const say = (s) => process.stdout.write(s);
  const complain = (s) => process.stderr.write(`storyforge: ${s}\n`);
  /** @type {Record<string, string>} */
  const values = {};
  const books = [];
  let dryRun = false;
  let compare = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--compare') {
      if (i + 2 >= argv.length || argv[i + 1].startsWith('--') || argv[i + 2].startsWith('--')) {
        complain('--compare needs two library folders: --compare <library A> <library B>');
        return 2;
      }
      compare = [argv[i + 1], argv[i + 2]];
      i += 2;
    } else if (VALUE_FLAGS.includes(name)) {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) v = argv[++i];
      else {
        complain(`${name} needs a value`);
        return 2;
      }
      if (name === '--book') books.push(v);
      else values[name] = v;
    } else {
      complain(`unknown argument: ${a}`);
      return 2;
    }
  }
  const into = values['--into'];
  const against = values['--reconcile'];
  const modes = [dryRun, into !== undefined, against !== undefined, compare !== null].filter(Boolean).length;
  if (modes === 0) {
    if (!values['--dump']) {
      complain('import-legacy needs --dump <folder> (a dump made by tools/legacy-dump/dump.php)');
      return 2;
    }
    complain('import-legacy needs one of --dry-run, --into <new folder>, --reconcile <library folder> or --compare <library A> <library B> (the import itself is M06-J02)');
    return 2;
  }
  if (modes > 1) {
    complain('use only one of --dry-run, --into, --reconcile and --compare');
    return 2;
  }

  // ---- --compare: read-only ----
  if (compare) {
    if (Object.keys(values).length > 0 || books.length > 0) {
      complain('--compare takes only the two library folders');
      return 2;
    }
    for (const lib of compare) {
      if (!isFolder(lib)) {
        complain(`${lib} is not a folder`);
        return 2;
      }
    }
    const r = compareLibraries(compare[0], compare[1]);
    if (r.equivalent) say('The two libraries are equivalent (every file is byte-identical; .storyforge/ ignored).\n');
    else {
      say(`The libraries differ in ${r.differences.length} file(s):\n`);
      for (const d of r.differences.slice(0, 50)) say(`  ${d.path}: ${d.why}\n`);
      if (r.differences.length > 50) say(`  and ${r.differences.length - 50} more\n`);
    }
    return r.equivalent ? 0 : 1;
  }

  if (!values['--dump']) {
    complain('import-legacy needs --dump <folder> (a dump made by tools/legacy-dump/dump.php)');
    return 2;
  }
  const dumpDir = values['--dump'];
  if (against !== undefined && !isFolder(against)) {
    complain(`--reconcile: ${against} is not a folder`);
    return 2;
  }
  if (into !== undefined) {
    const problem = intoPathProblem(dumpDir, into);
    if (problem) {
      complain(`--into: ${problem}`);
      return 2;
    }
  }
  const libraryDir = into ?? against ?? null;
  for (const flag of ['--report', '--json']) {
    if (values[flag] === undefined) continue;
    const problem = outputPathProblem(dumpDir, values[flag]);
    if (problem) {
      complain(`${flag}: ${problem}`);
      return 2;
    }
    if (libraryDir !== null && insideLibrary(values[flag], libraryDir)) {
      complain(`${flag}: ${path.resolve(values[flag])} is inside the library folder; the library holds only the imported books`);
      return 2;
    }
  }

  const writeOutputs = async (reportText, jsonText) => {
    try {
      if (values['--report'] !== undefined) {
        const r = await writeOutFile(path.resolve(values['--report']), Buffer.from(reportText, 'utf8'));
        if (!r.ok) throw new Error(`${values['--report']} already exists`);
      } else say(reportText);
      if (values['--json'] !== undefined) {
        const r = await writeOutFile(path.resolve(values['--json']), Buffer.from(jsonText, 'utf8'));
        if (!r.ok) throw new Error(`${values['--json']} already exists`);
      }
    } catch (e) {
      complain(`cannot write the report: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    return true;
  };

  // ---- --reconcile: read-only check of an existing library ----
  if (against !== undefined) {
    let rec;
    try {
      rec = await reconcile(path.resolve(dumpDir), path.resolve(against), { books });
    } catch (e) {
      complain(e instanceof DumpError ? `cannot read the dump: ${e.message}` : `reconciliation failed: ${e instanceof Error ? e.message : e}`);
      return 1;
    }
    if (!(await writeOutputs(renderReconciliation(rec), reconciliationToJson(rec)))) return 1;
    return rec.unexplained === 0 && rec.books.length > 0 ? 0 : 1;
  }

  let plan;
  try {
    plan = planImport(path.resolve(dumpDir), { books });
  } catch (e) {
    complain(e instanceof DumpError ? `cannot read the dump: ${e.message}` : `planning failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const errors = plan.issues.filter((i) => i.severity === 'error');
  if (dryRun) {
    if (!(await writeOutputs(renderReport(plan), planToJson(plan)))) return 1;
    for (const i of errors) complain(`error ${i.code}: ${i.message}`);
    return plan.summary.coverage === 1 && errors.length === 0 ? 0 : 1;
  }

  // ---- --into: execute the plan into a new folder ----
  if (errors.length > 0 || plan.summary.coverage !== 1) {
    for (const i of errors) complain(`error ${i.code}: ${i.message}`);
    complain('the plan is not complete (errors in the dump or the plan, or a legacy row without a disposition); nothing was written');
    return 1;
  }
  let written;
  try {
    written = await executePlan(plan, path.resolve(into));
  } catch (e) {
    complain(`the import failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  if (!written.ok) {
    complain(`--into: ${into} already exists and is not empty; nothing was written`);
    return 2;
  }
  let validationErrors = 0;
  const summary = [`Imported ${plan.books.length} book(s), ${written.files} file(s), into ${path.resolve(into)}.`];
  for (const b of plan.books) {
    const v = await validate(path.join(path.resolve(into), b.slug));
    const errs = v.diagnostics.filter((d) => d.severity === 'error');
    validationErrors += errs.length;
    summary.push(`Validation of ${b.slug}: ${errs.length} error(s), ${v.diagnostics.length - errs.length} warning(s) or notice(s).`);
    for (const d of errs.slice(0, 20)) summary.push(`  ${d.code} ${d.file}${d.location ? ` ${d.location}` : ''}`);
  }
  let rec;
  try {
    rec = await reconcile(path.resolve(dumpDir), path.resolve(into), { books });
  } catch (e) {
    complain(`reconciliation failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  summary.push(`Reconciliation: ${rec.unexplained === 0 ? 'no unexplained difference' : `${rec.unexplained} failing check(s)`}.`);
  if (values['--report'] === undefined) say(`${summary.join('\n')}\n\n`);
  else for (const line of summary) say(`${line}\n`);
  if (!(await writeOutputs(renderReconciliation(rec), reconciliationToJson(rec)))) return 1;
  return validationErrors === 0 && rec.unexplained === 0 ? 0 : 1;
}
