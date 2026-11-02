// CLI commands that work on one book's files and need no running server and no library lock (M05-J03):
//   export  --library <p> --book <slug> --format markdown|docx|epub|pdf --out <file> [--include manuscript|summary|evidence] [--force]
//   backup  --library <p> --book <slug> --out <file.zip> [--provenance] [--force]
//   restore --from <file.zip> --to <new or empty folder>
// Exit codes: 0 ok, 1 failed, 2 usage. Export and backup only read the book; `--out` never overwrites without `--force` and never points into the book folder.
import path from 'node:path';
import { createFsRepository } from '@storyforge/core';
import { ExportError, ExportVerificationError, FORMATS, INCLUDE_MODES, RestoreError, createBackup, exportBook, restoreBackupFile, writeOutput } from '@storyforge/export';

export const FILE_COMMANDS = ['export', 'backup', 'restore'];

const VALUE_FLAGS = ['--library', '--book', '--format', '--include', '--out', '--from', '--to'];
const BOOL_FLAGS = ['--provenance', '--force'];

/** @param {string[]} argv @returns {{ values: Record<string, string>, flags: Set<string> }} */
function parse(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.includes(name)) {
      if (eq > 0) values[name] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values[name] = argv[++i];
      else throw new Error(`${name} needs a value`);
    } else if (BOOL_FLAGS.includes(a)) {
      flags.add(a);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { values, flags };
}

/** @param {string} message */
const usage = (message) => ({ code: 2, message });

/**
 * @param {string} command export | backup | restore
 * @param {string[]} argv arguments after the command
 * @returns {Promise<number>} the exit code
 */
export async function runFileCommand(command, argv) {
  const say = (s) => process.stdout.write(`${s}\n`);
  const complain = (s) => process.stderr.write(`storyforge: ${s}\n`);
  let args;
  try {
    args = parse(argv);
  } catch (e) {
    complain(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { values, flags } = args;
  try {
    if (command === 'restore') {
      if (!values['--from'] || !values['--to']) throw usage('restore needs --from <file.zip> and --to <folder>');
      const r = await restoreBackupFile(path.resolve(values['--from']), path.resolve(values['--to']));
      say(`restored ${r.files} files into ${r.bookRoot}`);
      for (const d of r.diagnostics) say(`${d.severity ?? ''} ${d.code} ${d.file} ${d.message ?? ''}`.trim());
      return 0;
    }
    if (!values['--library'] || !values['--book'] || !values['--out']) throw usage(`${command} needs --library <path>, --book <slug> and --out <file>`);
    if (command === 'export' && !values['--format']) throw usage('export needs --format markdown|docx|epub|pdf');
    if (command === 'export' && !Object.hasOwn(FORMATS, values['--format'])) throw usage(`unknown format: ${values['--format']} (use ${Object.keys(FORMATS).join(', ')})`);

    const include = values['--include'] ?? 'manuscript';
    if (command === 'export' && !INCLUDE_MODES.includes(include)) throw usage(`unknown --include: ${include} (use ${INCLUDE_MODES.join(', ')})`);
    if (command !== 'export' && values['--include'] !== undefined) throw usage('--include only applies to export');

    const repository = createFsRepository(path.resolve(values['--library']), { watch: false, pollMs: 0 });
    let bookRoot;
    let verify;
    try {
      const book = (await repository.listBooks()).find((b) => b.slug === values['--book']);
      bookRoot = book ? await repository.bookRoot(book.id) : null;
      if (book && command === 'export' && include === 'evidence' && typeof repository.verifyReceipts === 'function') verify = await repository.verifyReceipts(book.id);
    } finally {
      await repository.close();
    }
    if (!bookRoot) {
      complain(`no book with slug "${values['--book']}" in ${path.resolve(values['--library'])}`);
      return 1;
    }
    const force = flags.has('--force');
    if (command === 'export') {
      const r = await exportBook(bookRoot, /** @type {any} */ (values['--format']), { include: /** @type {any} */ (include), verify });
      for (const w of r.warnings) complain(`warning: ${w}`);
      const out = await writeOutput(values['--out'], r.bytes, { bookRoot, force });
      say(`wrote ${out} (${r.bytes.length} bytes)`);
    } else {
      const r = await createBackup(bookRoot, { includeProvenance: flags.has('--provenance') });
      const out = await writeOutput(values['--out'], r.bytes, { bookRoot, force });
      say(`wrote ${out} (${r.files} files, ${r.bytes.length} bytes)`);
    }
    return 0;
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 2 && 'message' in e && !(e instanceof Error)) {
      complain(/** @type {any} */ (e).message);
      return 2;
    }
    if (e instanceof ExportVerificationError) {
      complain(`${command} failed verification: ${e.problems.join('; ')}`);
      return 1;
    }
    if (e instanceof ExportError || e instanceof RestoreError) {
      complain(`${e.code}: ${e.message}`);
      return 1;
    }
    complain(`${command} failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}
