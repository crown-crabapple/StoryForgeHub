// npm start -- --library <path>: build the web app if it is missing, then run the server.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url));

if (!existsSync(indexHtml)) {
  const build = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../apps/server/src/main.mjs', import.meta.url)), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
process.exit(server.status ?? 1);
