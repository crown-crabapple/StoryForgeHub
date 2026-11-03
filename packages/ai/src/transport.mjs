// THE ONLY outbound network module for AI in packages/* and apps/server (M05-J04 contract section 1).
// M08-J03 adds model discovery (GET), streaming and image generation here, so they share the refusals below.
// (The webhook sender, packages/integrations/src/webhook-transport.mjs, is the other allowed file.)
// ESLint (eslint.config.mjs) forbids fetch, node:https, node:net, node:tls, node:dgram, undici and node:http's
// request/get everywhere else; this file is the one allowed exception. Nothing here logs, and no error message
// ever contains a header value (the Authorization key travels only inside `headers`).

/** Largest response body read, in bytes. A larger one is refused. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** An image answer carries the picture itself (base64), so it may be larger than a text answer. */
export const MAX_IMAGE_RESPONSE_BYTES = 40 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
/** A streamed answer may take longer than a single one. */
export const STREAM_TIMEOUT_MS = 300_000;

/** Hosts that count as this computer. `http:` is allowed only to these. */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class TransportError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/** Parse and vet an address: the same refusals for every request this file makes. @param {string} url */
function vetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError('BAD_URL', 'the address is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TransportError('REFUSED_PROTOCOL', `only http: and https: addresses are allowed (not ${parsed.protocol})`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TransportError('REFUSED_CREDENTIALS', 'the address must not contain a user name or password');
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TransportError('REFUSED_INSECURE', 'http: is only allowed to this computer (localhost); a cloud provider must use https:');
  }
  return parsed;
}

/** @param {URL} parsed @param {RequestInit} init @param {AbortSignal | undefined} signal */
async function send(parsed, init, signal) {
  try {
    return await globalThis.fetch(parsed.href, { ...init, redirect: 'error' });
  } catch (e) {
    throw mapFetchError(e, signal);
  }
}

/** Read a whole body, at most `maxBytes`. @param {Response} res @param {number} maxBytes @param {AbortSignal | undefined} signal */
async function readText(res, maxBytes, signal) {
  const tooLarge = () => new TransportError('RESPONSE_TOO_LARGE', `the answer is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw mapFetchError(e, signal);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {string} text */
function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON; the caller decides what that means
  }
}

/** @param {number} timeoutMs @param {AbortSignal | undefined} signal */
const withTimeout = (timeoutMs, signal) => AbortSignal.any(signal ? [AbortSignal.timeout(timeoutMs), signal] : [AbortSignal.timeout(timeoutMs)]);

/**
 * POST `body` as JSON to `url` and read a JSON answer.
 * Refuses (TransportError, nothing is sent): a URL that does not parse (BAD_URL), a protocol other than http: / https: (REFUSED_PROTOCOL),
 * a URL with embedded credentials (REFUSED_CREDENTIALS), http: to a host that is not loopback (REFUSED_INSECURE), a redirect
 * (REDIRECT_REFUSED, `redirect: 'error'`), a response over 8 MB (RESPONSE_TOO_LARGE; `maxBytes` raises it for an image). Also TIMEOUT, ABORTED and NETWORK.
 * @param {string} url
 * @param {unknown} body JSON-serialisable
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number }} [options]
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>} `json` is null when the answer is not JSON
 */
export async function postJson(url, body, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const parsed = vetUrl(url);
  const payload = JSON.stringify(body);
  if (payload === undefined) throw new TransportError('BAD_BODY', 'the request body cannot be written as JSON');
  const res = await send(parsed, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: payload, signal: withTimeout(timeoutMs, signal) }, signal);
  const text = await readText(res, maxBytes, signal);
  return { status: res.status, ok: res.ok, json: jsonOrNull(text), text };
}

/**
 * GET `url` and read a JSON answer (model discovery: no request body, so no manuscript data can travel). Same refusals as postJson.
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>}
 */
export async function getJson(url, { headers = {}, timeoutMs = 30_000, signal } = {}) {
  const parsed = vetUrl(url);
  const res = await send(parsed, { method: 'GET', headers: { ...headers, accept: 'application/json' }, signal: withTimeout(timeoutMs, signal) }, signal);
  const text = await readText(res, MAX_RESPONSE_BYTES, signal);
  return { status: res.status, ok: res.ok, json: jsonOrNull(text), text };
}

/**
 * POST `body` as JSON and read the answer as lines (SSE `data:` lines or NDJSON), calling `onLine(line)` for each non-empty line as it arrives.
 * A failing status is read whole and returned (`ok: false`, `text`, `json`); nothing is passed to `onLine` for it. Same refusals as postJson; `signal` cancels.
 * @param {string} url @param {unknown} body
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal, onLine: (line: string) => void }} options
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string, contentType: string }>}
 */
export async function postStream(url, body, { headers = {}, timeoutMs = STREAM_TIMEOUT_MS, signal, onLine }) {
  const parsed = vetUrl(url);
  const payload = JSON.stringify(body);
  if (payload === undefined) throw new TransportError('BAD_BODY', 'the request body cannot be written as JSON');
  const res = await send(
    parsed,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream, application/x-ndjson, application/json' }, body: payload, signal: withTimeout(timeoutMs, signal) },
    signal,
  );
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const text = await readText(res, MAX_RESPONSE_BYTES, signal);
    return { status: res.status, ok: false, json: jsonOrNull(text), text, contentType };
  }
  const decoder = new TextDecoder();
  let pending = '';
  let size = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new TransportError('RESPONSE_TOO_LARGE', 'the answer is larger than 8 MB');
        }
        pending += decoder.decode(value, { stream: true });
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at).replace(/\r$/, '');
          pending = pending.slice(at + 1);
          if (line.trim() !== '') onLine(line);
        }
      }
    }
    pending += decoder.decode();
    if (pending.trim() !== '') onLine(pending.replace(/\r$/, ''));
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw mapFetchError(e, signal);
  }
  return { status: res.status, ok: true, json: null, text: '', contentType };
}

/** @param {any} e @param {AbortSignal | undefined} signal */
function mapFetchError(e, signal) {
  if (e instanceof TransportError) return e;
  if (e?.name === 'TimeoutError') return new TransportError('TIMEOUT', 'the provider did not answer in time');
  if (e?.name === 'AbortError') return new TransportError(signal?.aborted ? 'ABORTED' : 'TIMEOUT', signal?.aborted ? 'the request was cancelled' : 'the provider did not answer in time');
  if (/redirect/i.test(String(e?.cause?.message ?? e?.message ?? ''))) return new TransportError('REDIRECT_REFUSED', 'the provider answered with a redirect, which is not followed');
  return new TransportError('NETWORK', 'the provider could not be reached');
}
