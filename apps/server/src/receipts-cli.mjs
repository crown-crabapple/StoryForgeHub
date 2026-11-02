// CLI: node apps/server/src/main.mjs receipts verify --library <path> --book <slug> [--json]   (M05-J07 section 6)
// Read-only: no library lock, no server, nothing is written or repaired. Exit codes: 0 every receipt checks out (RCPT_UNRECORDED is only information),
// 1 integrity problems found (or no such book), 2 usage.
import path from 'node:path';
import { createFsRepository } from '@storyforge/core';

export const RECEIPTS_COMMANDS = ['receipts'];

/**
 * @param {string[]} argv arguments after `receipts`
 * @returns {Promise<number>} the exit code
 */
export async function runReceiptsCommand(argv) {
  const say = (s) => process.stdout.write(`${s}\n`);
  const complain = (s) => process.stderr.write(`storyforge: ${s}\n`);
  const [sub, ...rest] = argv;
  if (sub !== 'verify') {
    complain('usage: receipts verify --library <path> --book <slug> [--json]');
    return 2;
  }
  /** @type {Record<string, string>} */
  const values = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (a === '--json') json = true;
    else if (name === '--library' || name === '--book') {
      if (eq > 0) values[name] = a.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) values[name] = rest[++i];
      else {
        complain(`${name} needs a value`);
        return 2;
      }
    } else {
      complain(`unknown argument: ${a}`);
      return 2;
    }
  }
  if (!values['--library'] || !values['--book']) {
    complain('receipts verify needs --library <path> and --book <slug>');
    return 2;
  }
  const library = path.resolve(values['--library']);
  const repository = createFsRepository(library, { watch: false, pollMs: 0 });
  try {
    const book = (await repository.listBooks()).find((b) => b.slug === values['--book']);
    if (!book) {
      complain(`no book with slug "${values['--book']}" in ${library}`);
      return 1;
    }
    const result = await repository.verifyReceipts(book.id);
    if (!result) {
      complain(`no book with slug "${values['--book']}" in ${library}`);
      return 1;
    }
    const errors = result.problems.filter((p) => p.code !== 'RCPT_UNRECORDED');
    if (json) say(JSON.stringify(result, null, 2));
    else {
      say(errors.length === 0 ? `receipts: ${result.receipts} checked, the chain is intact` : `receipts: ${result.receipts} checked, ${errors.length} problem${errors.length === 1 ? '' : 's'} found (nothing was changed)`);
      for (const p of result.problems) say(`${p.code}  ${p.file}${p.receipt ? `  ${p.receipt}` : ''}  ${p.detail}`);
    }
    return errors.length === 0 ? 0 : 1;
  } finally {
    await repository.close();
  }
}
