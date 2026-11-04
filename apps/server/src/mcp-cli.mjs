// `storyforge mcp`: the stdio MCP bridge for Claude Code and Claude Desktop. It reads JSON-RPC lines on stdin and forwards each one to POST /mcp of the
// StoryForge server already running on this computer (the library lock allows one process per library, so the bridge never opens the library itself).
// The token comes from the STORYFORGE_TOKEN environment variable (never a flag: flags show in the process list). The port is --port, else the port the
// running server wrote into the library's lock file, else STORYFORGE_PORT / 4317. stdout carries only protocol messages; problems go to stderr.
import path from 'node:path';
import { LOCK_FILE, resolveConfig } from '@storyforge/core';
import { postLoopback, runStdio } from '@storyforge/mcp';
import { lockHolder } from '@storyforge/store';

/** @param {string[]} argv @param {string} name */
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? '' : undefined; // a flag with no value is "", which is refused, never ignored
};

/** Which port the local server listens on. @param {string[]} argv @returns {Promise<number | null>} */
export async function bridgePort(argv, env = process.env) {
  const given = flag(argv, '--port');
  if (given !== undefined) return /^[0-9]{1,5}$/.test(given) && Number(given) >= 1 && Number(given) <= 65535 ? Number(given) : null;
  try {
    const config = await resolveConfig({ argv, env, fallback: 'none' });
    const held = await lockHolder(path.join(config.libraryRoot, LOCK_FILE));
    if (held && Number.isInteger(held.port) && /** @type {number} */ (held.port) > 0) return /** @type {number} */ (held.port);
    return config.port;
  } catch {
    const p = Number(env.STORYFORGE_PORT);
    return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 4317;
  }
}

/**
 * Forward one message and turn every transport failure into a JSON-RPC error for a request (a notification gets no answer).
 * @param {(p: { port: number, token: string, message: unknown }) => Promise<any>} post @param {number} port @param {string} token
 */
export function makeSend(post, port, token) {
  return async (/** @type {any} */ message) => {
    const id = message && typeof message === 'object' && !Array.isArray(message) && 'id' in message ? message.id : undefined;
    const fail = (/** @type {number} */ code, /** @type {string} */ text) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } });
    const r = await post({ port, token, message });
    if (!r.ok) return fail(-32000, r.message);
    const body = r.body;
    if (r.status === 202 || body === null) return null;
    if (body && typeof body === 'object' && body.jsonrpc === '2.0') return body;
    return fail(-32001, `StoryForge answered ${r.status}: ${body && typeof body.message === 'string' ? body.message : body?.error ?? 'error'}`);
  };
}

/** @param {string[]} argv @returns {Promise<number>} the exit code */
export async function runMcpCommand(argv) {
  const token = process.env.STORYFORGE_TOKEN ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
    process.stderr.write('storyforge mcp: set STORYFORGE_TOKEN to a plugin token (in StoryForge: Settings, Plugins, Grant access)\n');
    return 2;
  }
  const port = await bridgePort(argv);
  if (port === null) {
    process.stderr.write('storyforge mcp: --port must be a whole number from 1 to 65535\n');
    return 2;
  }
  await runStdio({ input: process.stdin, output: process.stdout, send: makeSend(postLoopback, port, token) });
  return 0;
}
