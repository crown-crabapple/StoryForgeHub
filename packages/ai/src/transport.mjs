// THE ONLY outbound network module in packages/* and apps/server (M05-J04 contract section 1).
// ESLint (eslint.config.mjs) forbids fetch, node:https, node:net, node:tls, node:dgram, undici and node:http's
// request/get everywhere else; this file is the one allowed exception. Nothing here logs, and no error message
// ever contains a header value (the Authorization key travels only inside `headers`).

/** Largest response body read, in bytes. A larger one is refused. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

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

/**
 * POST `body` as JSON to `url` and read a JSON answer.
 * Refuses (TransportError, nothing is sent): a URL that does not parse (BAD_URL), a protocol other than http: / https: (REFUSED_PROTOCOL),
 * a URL with embedded credentials (REFUSED_CREDENTIALS), http: to a host that is not loopback (REFUSED_INSECURE), a redirect
 * (REDIRECT_REFUSED, `redirect: 'error'`), a response over 8 MB (RESPONSE_TOO_LARGE). Also TIMEOUT, ABORTED and NETWORK.
 * @param {string} url
 * @param {unknown} body JSON-serialisable
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>} `json` is null when the answer is not JSON
 */
export async function postJson(url, body, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
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
  const payload = JSON.stringify(body);
  if (payload === undefined) throw new TransportError('BAD_BODY', 'the request body cannot be written as JSON');

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await globalThis.fetch(parsed.href, {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: payload,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw mapFetchError(e, signal);
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new TransportError('RESPONSE_TOO_LARGE', 'the answer is larger than 8 MB');
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
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new TransportError('RESPONSE_TOO_LARGE', 'the answer is larger than 8 MB');
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw mapFetchError(e, signal);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON; the caller decides what that means
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** @param {any} e @param {AbortSignal | undefined} signal */
function mapFetchError(e, signal) {
  if (e instanceof TransportError) return e;
  if (e?.name === 'TimeoutError') return new TransportError('TIMEOUT', 'the provider did not answer in time');
  if (e?.name === 'AbortError') return new TransportError(signal?.aborted ? 'ABORTED' : 'TIMEOUT', signal?.aborted ? 'the request was cancelled' : 'the provider did not answer in time');
  if (/redirect/i.test(String(e?.cause?.message ?? e?.message ?? ''))) return new TransportError('REDIRECT_REFUSED', 'the provider answered with a redirect, which is not followed');
  return new TransportError('NETWORK', 'the provider could not be reached');
}
