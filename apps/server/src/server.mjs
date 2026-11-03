// HTTP server: loopback guard, JSON API (reads, plus guarded writes), static web app.
import http from 'node:http';
import { createLibraryHost, runAs } from '@storyforge/core';
import { createAiService } from './ai-routes.mjs';
import { createPresence } from './presence.mjs';
import { checkModule, moduleOn, receiptsGate } from './preferences.mjs';
import { RESTORE_FOLDER_RE, handleApi, handleRestore, handleUpload, handleWrite, isApiPath, matchWriteRoute } from './router.mjs';
import { handleSharedRead, handleSharedWrite, matchSharedRoute } from './shared-routes.mjs';
import { hasRestoreHeaders, hasUploadHeaders, hasWriteHeaders, isRequestAllowed } from './security.mjs';
import { serveStatic } from './static.mjs';

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
 * @returns {import('node:http').Server} not yet listening; callers bind it to 127.0.0.1 (personal mode) or the shared-mode host
 */
export function createServer({ repository, host, webRoot, recoverReport, instance, maxRestoreBytes = MAX_RESTORE_BYTES, shared = null, profile = 'default' }) {
  const gate = shared ? shared.gate : null;
  /** Classes whose calls are audited (contract M07-J03 section 4). */
  const AUDITED = new Set(['write', 'suggest', 'comment', 'admin', 'ai']);
  /** The ids a write route is about: book, then the most specific object. @param {Record<string, any>} m */
  const targetOf = (m) => [m.bookId, m.sceneId ?? m.entryId ?? m.threadId ?? m.eventId ?? m.noteId ?? m.suggestionId ?? m.commentId ?? m.opId ?? m.profileId ?? m.n ?? m.slug].filter((x) => x !== undefined).join('/') || undefined;
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
    ai: createAiService(), // optional AI workshop (M05-J04): profiles, session keys and stored previews live in this process only
    presence: createPresence(), // advisory "also in this scene" (M07-J03b): in memory only, expires after 60 s, never blocks a save
    profile,
    moduleOn: (/** @type {any} */ repo, /** @type {string} */ id, /** @type {any} */ which) => moduleOn(repo, state, id, which),
  };
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
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (!gate && !isRequestAllowed(req, port)) return sendJson(res, 403, { error: 'forbidden' });

      const target = (req.url ?? '/').split('#')[0];
      const queryAt = target.indexOf('?');
      const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
      const queryString = queryAt < 0 ? '' : target.slice(queryAt + 1);

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
