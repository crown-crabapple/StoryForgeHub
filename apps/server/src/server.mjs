// HTTP server: loopback guard, read-only API, static web app.
import http from 'node:http';
import { handleApi, isApiPath } from './router.mjs';
import { isRequestAllowed } from './security.mjs';
import { serveStatic } from './static.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';

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
 * @param {{ repository: import('@storyforge/core').FileRepository, webRoot: string }} options
 * @returns {import('node:http').Server} not yet listening; callers bind it to 127.0.0.1
 */
export function createServer({ repository, webRoot }) {
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!isRequestAllowed(req, port)) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'read_only' });

      const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
      if (isApiPath(pathname)) {
        const { status, body } = await handleApi(repository, pathname);
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
