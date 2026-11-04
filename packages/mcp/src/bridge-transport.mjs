// THE ONLY network module of the MCP package, and the third outbound network file in the repo (eslint.config.mjs allows it next to packages/ai/src/transport.mjs
// and packages/integrations/src/webhook-transport.mjs). It serves `storyforge mcp` (the stdio bridge): one POST of one JSON-RPC message to the StoryForge server
// running on THIS computer. It cannot reach anything else: the address is always 127.0.0.1 and the path always /mcp; the caller supplies only the port.
// It never follows a redirect, reads at most 8 MB of the answer, stops after the timeout, and no error message contains the token or any part of the body.
import http from 'node:http';

export const LOOPBACK = '127.0.0.1';
export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {{ ok: true, status: number, body: unknown } | { ok: false, code: 'BAD_PORT' | 'NOT_RUNNING' | 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' | 'BAD_ANSWER', message: string, status?: number }} BridgeResult
 * `body` is the parsed JSON answer, or null for an empty one (202).
 */

/**
 * POST one JSON-RPC message to http://127.0.0.1:<port>/mcp.
 * @param {{ port: number, token: string, message: unknown, timeoutMs?: number }} p
 * @returns {Promise<BridgeResult>} never throws
 */
export function postLoopback({ port, token, message, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ ok: false, code: 'BAD_PORT', message: 'the port must be a whole number from 1 to 65535' });
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  return new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {BridgeResult} */ r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = http.request(
      {
        host: LOOPBACK, port, method: 'POST', path: '/mcp',
        headers: { Host: `${LOOPBACK}:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (/** @type {Buffer} */ c) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) {
            res.destroy();
            done({ ok: false, code: 'TOO_LARGE', message: 'the server answer was too large', status });
          } else chunks.push(c);
        });
        res.on('error', () => done({ ok: false, code: 'NETWORK', message: 'the connection to StoryForge broke', status }));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (text.trim() === '') return done({ ok: true, status, body: null });
          try {
            done({ ok: true, status, body: JSON.parse(text) });
          } catch {
            done({ ok: false, code: 'BAD_ANSWER', message: `StoryForge answered ${status} with something that is not JSON`, status });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, code: 'TIMEOUT', message: `StoryForge did not answer within ${Math.round(timeoutMs / 1000)} s` });
    });
    req.on('error', (/** @type {any} */ e) =>
      done(e?.code === 'ECONNREFUSED'
        ? { ok: false, code: 'NOT_RUNNING', message: `StoryForge is not running on port ${port}; start it, then try again` }
        : { ok: false, code: 'NETWORK', message: 'could not reach StoryForge on this computer' }));
    req.end(payload);
  });
}
