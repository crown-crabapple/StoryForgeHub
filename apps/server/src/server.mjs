// HTTP server: loopback guard, JSON API (reads, plus guarded writes), static web app.
import http from 'node:http';
import { createLibraryHost } from '@storyforge/core';
import { handleApi, handleUpload, handleWrite, isApiPath, matchWriteRoute } from './router.mjs';
import { hasUploadHeaders, hasWriteHeaders, isRequestAllowed } from './security.mjs';
import { serveStatic } from './static.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** The most one attachment upload may carry (M04-J04). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
 * Read an upload body, never holding more than `max` bytes: a declared length over the limit is refused before reading, and a body that grows past it
 * (a missing or false length) stops being kept at once; the rest is drained and discarded.
 * @param {import('node:http').IncomingMessage} req @param {number} max
 * @returns {Promise<{ tooLarge: true } | { tooLarge: false, buffer: Buffer }>}
 */
function readUpload(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let tooLarge = Number.isFinite(declared) && declared > max;
    /** @type {Buffer[]} */
    let chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      if (tooLarge) chunks = [];
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { tooLarge: false, buffer: Buffer.concat(chunks) }));
    req.on('error', reject);
  });
}

/**
 * @param {{ repository?: import('@storyforge/core').FileRepository, host?: ReturnType<typeof createLibraryHost>, webRoot?: string,
 *           recoverReport?: unknown, instance?: { pid: number, started_at: string, lock: string } }} options
 *   `host` owns the library being served and switches to another one (POST /api/library/open); without it the
 *   server makes one around `repository`, which holds no lock of its own. Every request uses the host's current repository.
 *   `recoverReport` is the result of the recover() run at startup; GET /api/recover/last serves it.
 *   `instance` is what GET /api/status reports about this process (the lock it holds); default: no lock.
 * @returns {import('node:http').Server} not yet listening; callers bind it to 127.0.0.1
 */
export function createServer({ repository, host, webRoot, recoverReport, instance }) {
  let libraryHost = host ?? null;
  if (!libraryHost && repository) {
    try {
      libraryHost = createLibraryHost({ repository });
    } catch {
      libraryHost = null; // a repository without a root cannot be switched away from
    }
  }
  const state = {
    lastRecover: recoverReport ?? { completed: [], rolledBack: [], needsAttention: [] },
    instance: instance ?? { pid: process.pid, started_at: new Date().toISOString(), lock: 'none' },
    host: libraryHost,
  };
  const current = () => /** @type {any} */ (libraryHost ? libraryHost.repository : repository);
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
        if (match.route === 'attachment-upload') {
          if (!hasUploadHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
          const up = await readUpload(req, MAX_UPLOAD_BYTES);
          if (up.tooLarge) return sendJson(res, 413, { error: 'too_large', code: 'TOO_LARGE', message: 'attachments can be at most 25 MB' });
          const query = new URLSearchParams(queryString);
          const { status, body } = await handleUpload(current(), match, { name: query.get('name'), note: query.get('note'), bytes: up.buffer });
          return sendJson(res, status, body);
        }
        if (!hasWriteHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
        const read = await readBody(req);
        if (read.tooLarge) return sendJson(res, 413, { error: 'too_large' });
        let parsed;
        try {
          const text = read.buffer.toString('utf8');
          parsed = req.method === 'DELETE' && text.trim() === '' ? {} : JSON.parse(text); // a DELETE may carry no body
        } catch {
          return sendJson(res, 400, { error: 'bad_request', message: 'body is not valid JSON' });
        }
        const { status, body } = await handleWrite(current(), match, parsed, state);
        return sendJson(res, status, body);
      }
      if (isApiPath(pathname)) {
        const { status, body, raw } = await handleApi(current(), pathname, state, new URLSearchParams(queryString));
        if (raw) {
          res.writeHead(status, { ...raw.headers, 'content-length': raw.bytes.length });
          return res.end(raw.bytes);
        }
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
  // libraries opened later put the real port into their lock files
  server.on('listening', () => {
    const address = server.address();
    if (libraryHost && address && typeof address === 'object') libraryHost.setPort(address.port);
  });
  return server;
}
