// HTTP server: loopback guard, JSON API (reads, plus guarded writes), static web app.
import http from 'node:http';
import { handleApi, handleWrite, isApiPath, matchWriteRoute } from './router.mjs';
import { hasWriteHeaders, isRequestAllowed } from './security.mjs';
import { serveStatic } from './static.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Read a request body up to MAX_BODY_BYTES. Past the limit the rest is drained and discarded.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ tooLarge: true } | { tooLarge: false, buffer: Buffer }>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let tooLarge = Number.isFinite(declared) && declared > MAX_BODY_BYTES;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { tooLarge: false, buffer: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

/**
 * @param {{ repository: import('@storyforge/core').FileRepository, webRoot?: string, recoverReport?: unknown,
 *           instance?: { pid: number, started_at: string, lock: string } }} options
 *   `recoverReport` is the result of the recover() run at startup; GET /api/recover/last serves it.
 *   `instance` is what GET /api/status reports about this process (the lock it holds); default: no lock.
 * @returns {import('node:http').Server} not yet listening; callers bind it to 127.0.0.1
 */
export function createServer({ repository, webRoot, recoverReport, instance }) {
  const state = {
    lastRecover: recoverReport ?? { completed: [], rolledBack: [], needsAttention: [] },
    instance: instance ?? { pid: process.pid, started_at: new Date().toISOString(), lock: 'none' },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!isRequestAllowed(req, port)) return sendJson(res, 403, { error: 'forbidden' });

      const target = (req.url ?? '/').split('#')[0];
      const queryAt = target.indexOf('?');
      const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
      const queryString = queryAt < 0 ? '' : target.slice(queryAt + 1);
      if (req.method !== 'GET') {
        const match = matchWriteRoute(req.method ?? '', pathname);
        if (!match) return sendJson(res, 405, { error: 'read_only' });
        if (!hasWriteHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
        const read = await readBody(req);
        if (read.tooLarge) return sendJson(res, 413, { error: 'too_large' });
        let parsed;
        try {
          parsed = JSON.parse(read.buffer.toString('utf8'));
        } catch {
          return sendJson(res, 400, { error: 'bad_request', message: 'body is not valid JSON' });
        }
        const { status, body } = await handleWrite(repository, match, parsed, state);
        return sendJson(res, status, body);
      }
      if (isApiPath(pathname)) {
        const { status, body } = await handleApi(repository, pathname, state, new URLSearchParams(queryString));
        return sendJson(res, status, body);
      }
      const file = await serveStatic(webRoot, pathname);
      res.writeHead(file.status, { 'content-type': file.type, 'content-length': Buffer.byteLength(file.body) });
      return res.end(file.body);
    } catch {
      if (!res.headersSent) return sendJson(res, 500, { error: 'internal' });
      return res.end();
    }
  });
  return server;
}
