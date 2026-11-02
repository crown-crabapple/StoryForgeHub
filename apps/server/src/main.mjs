// CLI entry: node apps/server/src/main.mjs --library <path> [--port <n>]
import { fileURLToPath } from 'node:url';
import { ConfigError, createFsRepository, loadConfig } from '@storyforge/core';
import { createServer } from './server.mjs';

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** @param {string} message @param {number} code */
function fail(message, code) {
  process.stderr.write(`storyforge: ${message}\n`);
  process.exit(code);
}

let config;
try {
  config = loadConfig({ argv: process.argv.slice(2), env: process.env });
} catch (e) {
  if (e instanceof ConfigError) fail(e.message, e.exitCode);
  throw e;
}

const repository = createFsRepository(config.libraryRoot);
try {
  await repository.libraryInfo();
} catch (e) {
  fail(`cannot open library ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
}

// Settle any operation a crash left half-done before serving; the UI shows what happened.
let recoverReport;
try {
  recoverReport = await repository.recover();
} catch (e) {
  fail(`recovery failed for ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
}

const server = createServer({ repository, webRoot, recoverReport });
server.on('error', (e) => fail(`cannot listen on ${config.host}:${config.port}: ${e.message}`, 1));
server.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  process.stdout.write(`StoryForge serving ${config.libraryRoot}\nhttp://${config.host}:${port}/\n`);
});
