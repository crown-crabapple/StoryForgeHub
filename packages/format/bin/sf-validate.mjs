#!/usr/bin/env node
// sf-validate <path> [--json]
// Exit codes: 0 no errors, 1 at least one error diagnostic, 2 usage error.
import { stat } from 'node:fs/promises';
import { validate } from '../src/index.mjs';

const USAGE = 'usage: sf-validate <path> [--json]';

const args = process.argv.slice(2);
const json = args.includes('--json');
const rest = args.filter((a) => a !== '--json');
if (rest.length !== 1 || rest[0].startsWith('-')) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

let isDir = false;
try {
  isDir = (await stat(rest[0])).isDirectory();
} catch {
  isDir = false;
}
if (!isDir) {
  process.stderr.write(`sf-validate: not a directory: ${rest[0]}\n${USAGE}\n`);
  process.exit(2);
}

const result = await validate(rest[0]);
if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const d of result.diagnostics) {
    process.stdout.write(`${d.code} ${d.severity} ${d.file} ${d.location} ${d.message}\n`);
  }
}
process.exitCode = result.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
