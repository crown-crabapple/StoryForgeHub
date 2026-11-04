// HTTP server: loopback guard, JSON API (reads, plus guarded writes), static web app.
import http from 'node:http';
import { createKeystore } from '@storyforge/ai';
import { createLibraryHost, runAs } from '@storyforge/core';
import { userConfigDir } from '@storyforge/store';
import { handlePluginRequest } from './api-v1.mjs';
import { createAiService } from './ai-routes.mjs';
import { bearerOf } from './plugin-policy.mjs';
import { handleMcpRequest } from './mcp-route.mjs';
import { createPluginService } from './plugin-service.mjs';
import { createPresence } from './presence.mjs';
import { checkModule, moduleOn, receiptsGate } from './preferences.mjs';
import { RESTORE_FOLDER_RE, handleApi, handleRestore, handleUpload, handleWrite, isApiPath, matchWriteRoute } from './router.mjs';
import { handleSharedRead, handleSharedWrite, matchSharedRoute } from './shared-routes.mjs';
import { hasRestoreHeaders, hasUploadHeaders, hasWriteHeaders, isRequestAllowed } from './security.mjs';
import { serveStatic } from './static.mjs';
import { createWebhookEvents } from './webhook-events.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** The most one attachment upload may carry (M04-J04). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The most one backup restore upload may carry (M05-J03). */
export const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body, setCookie) {
  const text = JSON.stringify(body);
  /** @type {Record<string, string | number | string[]>} */
  const headers = {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  };
  if (setCookie && setCookie.length > 0) headers['set-cookie'] = setCookie;
  res.writeHead(status, headers);
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
 *           recoverReport?: unknown, instance?: { pid: number, started_at: string, lock: string }, maxRestoreBytes?: number }} options
 *   `host` owns the library being served and switches to another one (POST /api/library/open); without it the
 *   server makes one around `repository`, which holds no lock of its own. Every request uses the host's current repository.
 *   `recoverReport` is the result of the recover() run at startup; GET /api/recover/last serves it.
 *   `instance` is what GET /api/status reports about this process (the lock it holds); default: no lock.
 *   `maxRestoreBytes` is the size cap of the backup restore upload (default 512 MB; tests lower it).
 *   `shared` (M07-J03) turns on shared mode: `gate` is createSharedGate(...) from shared-gate.mjs; `data` is the open shared data, `settings` the owner's settings,
 *   `audit` appends one audit event, `publicUrl` is the address links are built on (else the request's own Host). Without it the server is in personal mode:
 *   loopback clients only, no accounts, no policy.
 *   `profile` is the name of the profile this run uses (M07-J04; the CLI takes it from --profile or STORYFORGE_PROFILE); the switcher in Settings changes it for the run.
 *   `shared.dir` (M08-J02) is the shared-data folder: shared mode keeps plugin tokens and webhook subscriptions there (personal mode keeps them in the user config folder).
 *   `integrations` (M08-J02) is a test seam for webhook delivery ({ deliver, backoffMs, timeoutMs, now, sleep }); production never sets it.
 * @returns {import('node:http').Server} not yet listening; callers bind it to 127.0.0.1 (personal mode) or the shared-mode host
 */
export function createServer({ repository, host, webRoot, recoverReport, instance, maxRestoreBytes = MAX_RESTORE_BYTES, shared = null, profile = 'default', integrations }) {
  const gate = shared ? shared.gate : null;
  /** Classes whose calls are audited (contract M07-J03 section 4). */
  const AUDITED = new Set(['write', 'suggest', 'comment', 'admin', 'ai']);
  /** The ids a write route is about: book, then the most specific object. @param {Record<string, any>} m */
  const targetOf = (m) => [m.bookId, m.sceneId ?? m.entryId ?? m.threadId ?? m.eventId ?? m.noteId ?? m.suggestionId ?? m.commentId ?? m.opId ?? m.profileId ?? m.tokenId ?? m.webhookId ?? m.n ?? m.slug].filter((x) => x !== undefined).join('/') || undefined;
  let libraryHost = host ?? null;
  if (!libraryHost && repository) {
    try {
      libraryHost = createLibraryHost({ repository });
    } catch {
      libraryHost = null; // a repository without a root cannot be switched away from
    }
  }
  // M08-J03: ONE key store for every secret of this process (AI keys, webhook signing secrets): in the user config folder, or the shared-data folder in shared mode
  const keystore = createKeystore({ dir: shared?.dir ?? userConfigDir() });
  const state = {
    lastRecover: recoverReport ?? { completed: [], rolledBack: [], needsAttention: [] },
    instance: instance ?? { pid: process.pid, started_at: new Date().toISOString(), lock: 'none' },
    host: libraryHost,
    ai: createAiService({ settings: { keystore } }), // optional AI workshop (M05-J04): profiles, session keys and stored previews live in this process only
    presence: createPresence(), // advisory "also in this scene" (M07-J03b): in memory only, expires after 60 s, never blocks a save
    profile,
    moduleOn: (/** @type {any} */ repo, /** @type {string} */ id, /** @type {any} */ which) => moduleOn(repo, state, id, which),
    // plugin tokens, webhook subscriptions and delivery (M08-J02): opened lazily; delivery is gated by the integrations module
    integrations: createPluginService({ shared, keystore, enabled: (/** @type {string} */ bookId) => moduleOn(current(), state, 'integrations', { bookId }), dispatcher: integrations }),
  };
  const hookEvents = createWebhookEvents({ service: state.integrations });
  /** @type {WeakSet<object>} repositories that already know which modules are on (M07-J04: receipts are asked per book) */
  const gated = new WeakSet();
  const current = () => {
    const repo = /** @type {any} */ (libraryHost ? libraryHost.repository : repository);
    if (repo && typeof repo.setModuleGate === 'function' && !gated.has(repo)) {
      gated.add(repo);
      repo.setModuleGate(receiptsGate(repo, state));
    }
    return repo;
  };
  current();
  const server = http.createServer(async (req, res) => {
    try {
      // HEAD is a GET without the body (uptime monitors, curl -I): it passes every check a GET passes. Node already decided at this point to send no body for it.
      if (req.method === 'HEAD') req.method = 'GET';
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!gate && !isRequestAllowed(req, port)) return sendJson(res, 403, { error: 'forbidden' });

      const target = (req.url ?? '/').split('#')[0];
      const queryAt = target.indexOf('?');
      const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
      const queryString = queryAt < 0 ? '' : target.slice(queryAt + 1);

      // M08-J02: a request with an Authorization header is a plugin request. It is decided by its own policy BEFORE the shared-mode gate and the member routes
      // (a bearer request carries no cookies, so the Origin and write-header checks do not apply and cookies are never read), and /api/v1 is reached only this way.
      const bearer = bearerOf(req);
      // MCP over Streamable HTTP (mcp-route.mjs): the same bearer token and the same /api/v1 policy, one JSON-RPC message per POST. MCP clients are not
      // web pages, so a request that carries an Origin header is refused (no browser page can drive the tools with a token it was given).
      if (pathname === '/mcp') {
        if (gate && !gate.hostOk(req, port)) return sendJson(res, 403, { error: 'forbidden' });
        if (req.method !== 'POST' || req.headers.origin !== undefined) {
          req.resume();
          return req.method !== 'POST' ? sendJson(res, 405, { error: 'method_not_allowed', message: 'MCP here is POST only (no SSE stream, no session)' }) : sendJson(res, 403, { error: 'forbidden', code: 'ORIGIN' });
        }
        if (!bearer) {
          req.resume();
          return sendJson(res, 401, { error: 'unauthorized', code: 'TOKEN', message: 'MCP needs an Authorization: Bearer plugin token (a session cookie is never accepted here)' });
        }
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') {
          req.resume();
          return sendJson(res, 415, { error: 'unsupported_media_type', message: 'send content-type: application/json' });
        }
        const read = await readBody(req);
        if (read.tooLarge) return sendJson(res, 413, { error: 'too_large' });
        let message;
        try {
          message = JSON.parse(read.buffer.toString('utf8'));
        } catch {
          return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        const r = await handleMcpRequest({
          bearer, message, repository: current(), state, service: state.integrations,
          audit: gate && shared?.audit ? shared.audit : null, ip: req.socket?.remoteAddress,
          afterProposal: (book, proposal, by) => void hookEvents.afterProposal(current(), book, proposal, by).catch(() => {}),
        });
        if (r.status === 202) {
          res.writeHead(202, { 'cache-control': 'no-store', 'content-length': 0 });
          return res.end();
        }
        return sendJson(res, r.status, r.body);
      }
      if (bearer !== null || pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
        if (gate && !gate.hostOk(req, port)) return sendJson(res, 403, { error: 'forbidden' }); // personal mode already passed its loopback and Host check above
        if (bearer === null) {
          if (req.method !== 'GET') req.resume();
          return sendJson(res, 401, { error: 'unauthorized', code: 'TOKEN', message: 'API v1 needs an Authorization: Bearer token (a session cookie is never accepted here)' });
        }
        const readJson = async () => {
          const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (type !== 'application/json') return { ok: /** @type {const} */ (false), status: 415, body: { error: 'unsupported_media_type', message: 'send content-type: application/json' } };
          const read = await readBody(req);
          if (read.tooLarge) return { ok: /** @type {const} */ (false), status: 413, body: { error: 'too_large' } };
          try {
            return { ok: /** @type {const} */ (true), value: JSON.parse(read.buffer.toString('utf8') || '{}') };
          } catch {
            return { ok: /** @type {const} */ (false), status: 400, body: { error: 'bad_request', message: 'body is not valid JSON' } };
          }
        };
        const r = await handlePluginRequest({ method: req.method ?? 'GET', pathname, params: new URLSearchParams(queryString), bearer, repository: current(), state, service: state.integrations, readJson });
        if (req.method !== 'GET') req.resume(); // a refused request's body is never read
        if (gate && shared?.audit) {
          await shared.audit({ ...r.event, result: r.status, ...(r.grant ? {} : { ip: req.socket?.remoteAddress }) }).catch((e) => process.stderr.write(`storyforge: audit write failed: ${e?.message ?? e}\n`));
        }
        if (r.status === 201 && r.proposal && r.by) void hookEvents.afterProposal(current(), r.book, r.proposal, r.by).catch(() => {});
        return sendJson(res, r.status, r.body);
      }

      /** @type {{ actor: string, event: string, target?: string } | null} */
      let auditCall = null;
      /** Audit the call that was just answered (shared mode, state-changing classes only). @param {number} status */
      const record = async (status) => {
        if (auditCall && shared?.audit) await shared.audit({ ...auditCall, result: status }).catch((e) => process.stderr.write(`storyforge: audit write failed: ${e?.message ?? e}
`));
      };
      let sharedMatch = null;
      /** Shared mode: who is asking (a signed-in user or a share link); null in personal mode. */
      let principal = null;
      if (gate) {
        // shared mode (M07-J03): any client address, but the Host must be ours, writes must come from our own pages, and every API route is
        // checked against the caller's role. The web app itself (static files) is public so the login page can load.
        if (!gate.hostOk(req, port)) return sendJson(res, 403, { error: 'forbidden' });
        if (req.method !== 'GET' && !gate.originOk(req)) return sendJson(res, 403, { error: 'forbidden', code: 'ORIGIN' });
        if (pathname.startsWith('/api/auth/')) {
          let authBody = {};
          if (req.method !== 'GET') {
            if (!hasWriteHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
            const read = await readBody(req);
            if (read.tooLarge) return sendJson(res, 413, { error: 'too_large' });
            try {
              authBody = JSON.parse(read.buffer.toString('utf8') || '{}');
            } catch {
              return sendJson(res, 400, { error: 'bad_request', message: 'body is not valid JSON' });
            }
          }
          const r = await gate.handleAuth(req, req.method ?? 'GET', pathname, authBody, new URLSearchParams(queryString));
          if (r) return sendJson(res, r.status, r.body, r.setCookie);
        }
        // a liveness probe (container HEALTHCHECK, uptime monitors) needs no login; signed-out callers learn only that the server is up
        if (req.method === 'GET' && pathname === '/api/health' && !(await gate.principalOf(req))) return sendJson(res, 200, { ok: true });
        if (req.method !== 'GET' || isApiPath(pathname)) {
          const who = await gate.principalOf(req);
          principal = who;
          sharedMatch = req.method !== 'GET' ? matchSharedRoute(req.method ?? '', pathname) : null;
          const writeMatch = req.method !== 'GET' ? (sharedMatch ?? matchWriteRoute(req.method ?? '', pathname)) : null;
          const verdict = gate.decide(who, req.method ?? 'GET', pathname, writeMatch);
          const audited = req.method !== 'GET' && writeMatch !== null && verdict.cls !== null && AUDITED.has(verdict.cls);
          if (audited && who && !writeMatch.shared) auditCall = { actor: who.id, event: `${verdict.cls}.${writeMatch.route}`, target: targetOf(writeMatch) };
          if (!verdict.ok) {
            if (audited) await shared?.audit?.({ actor: who ? who.id : "anonymous", event: `${verdict.cls}.${writeMatch.route}.refused`, target: targetOf(writeMatch), ...(who ? {} : { ip: req.socket?.remoteAddress }), result: verdict.status }).catch((e) => process.stderr.write(`storyforge: audit write failed: ${e?.message ?? e}
`));
            auditCall = null;
            if (req.method !== 'GET') req.resume();
            return sendJson(res, verdict.status, verdict.body);
          }
          // comments and who-is-here are for the people working on the book: a read-only share link (a reader) is not shown them (M07-J03b; FORMAT 9.5 "never exported to readers")
          if (who?.kind === 'share' && /^\/api\/books\/[^/]+\/(comments|presence)(\/|$)/.test(pathname)) {
            if (req.method !== 'GET') req.resume();
            return sendJson(res, 403, { error: 'forbidden', code: 'ROLE', message: 'comments are not shown to readers' });
          }
        }
      }

      if (gate && shared?.data && req.method === 'GET' && pathname.startsWith('/api/shared/')) {
        const { status, body } = handleSharedRead(pathname, { data: shared.data, settings: shared.settings, audit: shared.audit, actor: 'system', base: '' });
        return sendJson(res, status, body);
      }
      if (req.method !== 'GET') {
        if (gate && shared?.data && sharedMatch) {
          // the owner's admin routes (members, invites, shares, settings): audited by the handler itself
          if (!hasWriteHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
          const read = await readBody(req);
          if (read.tooLarge) return sendJson(res, 413, { error: 'too_large' });
          let parsed;
          try {
            const text = read.buffer.toString('utf8');
            parsed = req.method === 'DELETE' && text.trim() === '' ? {} : JSON.parse(text);
          } catch {
            return sendJson(res, 400, { error: 'bad_request', message: 'body is not valid JSON' });
          }
          const who = await gate.principalOf(req);
          const base = shared.publicUrl ? new URL(shared.publicUrl).origin : `http://${req.headers.host}`;
          const { status, body } = await handleSharedWrite(sharedMatch, parsed, { data: shared.data, settings: shared.settings, audit: shared.audit, actor: who?.id ?? 'system', base });
          return sendJson(res, status, body);
        }
        const match = matchWriteRoute(req.method ?? '', pathname);
        if (!match) return sendJson(res, 405, { error: 'read_only' });
        if (match.route === 'attachment-upload') {
          if (!hasUploadHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
          const off = await checkModule(current(), state, match);
          if (off) {
            req.resume();
            return sendJson(res, off.status, off.body);
          }
          const up = await readUpload(req, MAX_UPLOAD_BYTES);
          if (up.tooLarge) return sendJson(res, 413, { error: 'too_large', code: 'TOO_LARGE', message: 'attachments can be at most 25 MB' });
          const query = new URLSearchParams(queryString);
          const { status, body } = await handleUpload(current(), match, { name: query.get('name'), note: query.get('note'), bytes: up.buffer });
          await record(status);
          return sendJson(res, status, body);
        }
        if (match.route === 'backup-restore') {
          if (!hasRestoreHeaders(req)) return sendJson(res, 403, { error: 'forbidden' });
          const folder = new URLSearchParams(queryString).get('folder');
          if (folder === null || !RESTORE_FOLDER_RE.test(folder)) {
            req.resume();
            return sendJson(res, 400, { error: 'bad_request', message: 'folder must be a single folder name of 1 to 60 characters: a-z, 0-9 and hyphen' });
          }
          const up = await readUpload(req, maxRestoreBytes);
          if (up.tooLarge) return sendJson(res, 413, { error: 'too_large', code: 'TOO_LARGE', message: `backups can be at most ${Math.round(maxRestoreBytes / (1024 * 1024))} MB` });
          const { status, body } = await handleRestore(current(), folder, up.buffer);
          await record(status);
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
        // shared mode: the request runs as its user, so receipts, suggestions and comments say who made them (`by`); personal mode runs as nobody
        const by = principal?.kind === 'user' ? { id: principal.id, name: principal.display_name } : null;
        const { status, body } = await runAs(by, () => handleWrite(current(), match, parsed, state, principal ? { principal } : {}));
        await record(status);
        void hookEvents.afterWrite(current(), match, status, body, parsed, principal?.kind === 'user' ? { name: String(principal.display_name ?? principal.id) } : null).catch(() => {});
        return sendJson(res, status, body);
      }
      if (isApiPath(pathname)) {
        const { status, body, raw } = await handleApi(current(), pathname, state, new URLSearchParams(queryString));
        if (raw) {
          const dl = status === 200 ? /^\/api\/books\/([^/]+)\/(export|backup)$/.exec(pathname) : null;
          if (dl) void hookEvents.afterDownload(current(), /** @type {'export' | 'backup'} */ (dl[2]), decodeURIComponent(dl[1]), raw).catch(() => {});
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
