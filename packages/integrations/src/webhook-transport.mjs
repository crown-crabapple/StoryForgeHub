// THE ONLY webhook network module (M08-J02 contract section 4). ESLint (eslint.config.mjs) forbids every other outbound network API in packages/* and
// apps/server except this file and packages/ai/src/transport.mjs. Nothing here logs; no error message contains a header value (the signature travels
// only inside `headers`) or any part of the body.
//
// One call sends one POST of a JSON text. It never follows a redirect, reads at most 64 KB of the answer (and keeps none of it), stops after the
// timeout, and refuses an address the rules in url-rules.mjs refuse. A host NAME is looked up here and every address it has must pass the same private
// network rule (unless the author allowed the local network); the request then connects to the address that was checked, so a name cannot change
// its answer between the check and the connection.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { checkWebhookUrl, isLoopbackIp, isLocalName, isPrivateIp } from './url-rules.mjs';

export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * @typedef {{ ok: true, status: number } | { ok: false, code: string, message: string, status?: number }} DeliveryResult
 * Codes: BAD_URL, REFUSED_PROTOCOL, REFUSED_CREDENTIALS, REFUSED_INSECURE, REFUSED_PRIVATE (nothing was sent), TIMEOUT, NETWORK, REDIRECT_REFUSED, HTTP_<status>.
 */

/** Codes where nothing was sent and trying again cannot help. @param {string} code */
export const isRefusal = (code) => code.startsWith('REFUSED_') || code === 'BAD_URL';

/**
 * POST `body` (a JSON text) to `url`.
 * @param {{ url: string, body: string, headers?: Record<string, string>, allowLocal?: boolean, timeoutMs?: number }} p
 * @returns {Promise<DeliveryResult>} never throws
 */
export async function postWebhook({ url, body, headers = {}, allowLocal = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const checked = checkWebhookUrl(url, { allowLocal });
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  const u = checked.url;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const byName = !isLocalName(host) && !/^[0-9.]+$/.test(host) && !host.includes(':');
  const lib = u.protocol === 'https:' ? https : http;
  const payload = Buffer.from(body, 'utf8');

  /** Vet what a host name resolves to, then hand the checked addresses to the connection. */
  const lookup = (/** @type {string} */ name, /** @type {any} */ options, /** @type {any} */ cb) => {
    const done = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'function' ? {} : options;
    dns.lookup(name, { all: true, family: opts?.family ?? 0 }, (err, addresses) => {
      if (err) return done(err);
      const bad = addresses.find((a) => !allowLocal && (isPrivateIp(a.address) || isLoopbackIp(a.address)));
      if (bad) return done(Object.assign(new Error('REFUSED_PRIVATE'), { code: 'REFUSED_PRIVATE' }));
      return opts?.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
    });
  };

  return new Promise((resolve) => {
    let settled = false;
    /** @param {DeliveryResult} r */
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let req;
    try {
      req = lib.request(
        u,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'content-length': String(payload.length), 'user-agent': 'StoryForge-Webhook/1', accept: '*/*' },
          timeout: timeoutMs,
          ...(byName ? { lookup } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let seen = 0;
          res.on('data', (/** @type {Buffer} */ chunk) => {
            seen += chunk.length;
            if (seen > MAX_ANSWER_BYTES) res.destroy(); // the answer is not kept; only the status matters
          });
          const end = () => {
            if (status >= 200 && status < 300) finish({ ok: true, status });
            else if (status >= 300 && status < 400) finish({ ok: false, code: 'REDIRECT_REFUSED', status, message: 'the receiver answered with a redirect; redirects are never followed' });
            else finish({ ok: false, code: `HTTP_${status}`, status, message: `the receiver answered ${status}` });
          };
          res.on('end', end);
          res.on('close', end);
          res.on('error', end);
        },
      );
    } catch {
      return finish({ ok: false, code: 'NETWORK', message: 'the request could not be made' });
    }
    req.on('timeout', () => {
      finish({ ok: false, code: 'TIMEOUT', message: `no answer within ${Math.round(timeoutMs / 1000)} seconds` });
      req.destroy();
    });
    req.on('error', (/** @type {any} */ e) => {
      if (e?.code === 'REFUSED_PRIVATE') finish({ ok: false, code: 'REFUSED_PRIVATE', message: 'that host name resolves to a private network address; tick "allow local network" to send there' });
      else finish({ ok: false, code: 'NETWORK', message: 'the receiver could not be reached' });
    });
    req.end(payload);
  });
}
