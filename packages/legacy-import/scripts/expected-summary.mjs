// Prints the expected-plan-summary.json for a dump folder (the committed fixtures' golden file):
//   node packages/legacy-import/scripts/expected-summary.mjs packages/legacy-import/fixtures/seed-dump > packages/legacy-import/fixtures/seed-dump/expected-plan-summary.json
// Review the diff before committing it: it is the golden record of what the importer plans for that dump.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { planImport, planToTree, treeHash } from '../src/index.mjs';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node expected-summary.mjs <dump folder>\n');
  process.exit(2);
}
const plan = planImport(dir, {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-li-expected-'));
try {
  for (const [rel, bytes] of planToTree(plan)) {
    const p = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  const { diagnostics } = await validate(tmp);
  const counts = {};
  for (const i of plan.issues) counts[i.code] = (counts[i.code] ?? 0) + 1;
  const out = {
    summary: plan.summary,
    issue_codes: Object.keys(counts).sort(),
    issue_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    validation_errors: diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
    validation_warnings: [...new Set(diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code))].sort(),
    tree_sha256: treeHash(plan),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
