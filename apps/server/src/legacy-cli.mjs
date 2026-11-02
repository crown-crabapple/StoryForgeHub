// CLI: node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --dry-run [--report <file.md>] [--json <file.json>]   (M06-J01)
// A dry run reads a legacy dump (see tools/legacy-dump) and prints what an import WOULD create; nothing is imported and nothing is written except the
// report/JSON files named here, and those only to a path that does not exist yet and is not inside the dump. The import itself is M06-J02.
// Exit codes: 0 plan complete (every legacy row has a disposition, no error issues), 1 errors in the dump or the plan, 2 usage.
import path from 'node:path';
import { DumpError, outputPathProblem, planImport, planToJson, renderReport } from '@storyforge/legacy-import';
import { writeOutFile } from '@storyforge/store';

export const LEGACY_COMMANDS = ['import-legacy'];

const VALUE_FLAGS = ['--dump', '--book', '--report', '--json'];

/** @param {string[]} argv arguments after `import-legacy` @returns {Promise<number>} the exit code */
export async function runLegacyCommand(argv) {
  const say = (s) => process.stdout.write(s);
  const complain = (s) => process.stderr.write(`storyforge: ${s}\n`);
  /** @type {Record<string, string>} */
  const values = {};
  const books = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (a === '--dry-run') dryRun = true;
    else if (VALUE_FLAGS.includes(name)) {
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
  if (!values['--dump']) {
    complain('import-legacy needs --dump <folder> (a dump made by tools/legacy-dump/dump.php)');
    return 2;
  }
  if (!dryRun) {
    complain('the import itself is M06-J02; run again with --dry-run to see what it would do (nothing is written)');
    return 2;
  }
  for (const flag of ['--report', '--json']) {
    if (values[flag] === undefined) continue;
    const problem = outputPathProblem(values['--dump'], values[flag]);
    if (problem) {
      complain(`${flag}: ${problem}`);
      return 2;
    }
  }
  let plan;
  try {
    plan = planImport(path.resolve(values['--dump']), { books });
  } catch (e) {
    complain(e instanceof DumpError ? `cannot read the dump: ${e.message}` : `planning failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const report = renderReport(plan);
  try {
    if (values['--report'] !== undefined) {
      const r = await writeOutFile(path.resolve(values['--report']), Buffer.from(report, 'utf8'));
      if (!r.ok) throw new Error(`${values['--report']} already exists`);
    } else say(report);
    if (values['--json'] !== undefined) {
      const r = await writeOutFile(path.resolve(values['--json']), Buffer.from(planToJson(plan), 'utf8'));
      if (!r.ok) throw new Error(`${values['--json']} already exists`);
    }
  } catch (e) {
    complain(`cannot write the report: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const errors = plan.issues.filter((i) => i.severity === 'error');
  for (const i of errors) complain(`error ${i.code}: ${i.message}`);
  return plan.summary.coverage === 1 && errors.length === 0 ? 0 : 1;
}
