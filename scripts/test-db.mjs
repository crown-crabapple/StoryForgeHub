// npm run test:db: the whole test suite with a database attached (H0 §8a). Sets STORYFORGE_TEST_DB=pglite, which scripts/test-isolate-config.mjs
// (preloaded by every test script) turns into an in-memory PGlite document store under every store; then runs `npm test`.
//   node scripts/test-db.mjs                          every workspace
//   node scripts/test-db.mjs -w @storyforge/store     extra arguments go to `npm test` (here: one workspace)
import { spawn } from 'node:child_process';
import { REPO_ROOT } from './workspaces.mjs';

const args = process.argv.slice(2);
const child = spawn(`npm test ${args.join(' ')}`, { cwd: REPO_ROOT, env: { ...process.env, STORYFORGE_TEST_DB: 'pglite' }, stdio: 'inherit', shell: true, windowsHide: true });
child.on('error', (e) => {
  console.error(`test:db: cannot run npm: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
