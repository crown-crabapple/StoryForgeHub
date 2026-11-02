// Request guards: loopback-only clients and a Host check (DNS-rebinding guard).

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** @param {string | undefined} address */
export function isLoopback(address) {
  return address !== undefined && LOOPBACK.has(address);
}

/**
 * @param {string | undefined} hostHeader
 * @param {number} port the port the server is actually listening on
 */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const h = hostHeader.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port
 * @returns {boolean} true when the request may proceed
 */
export function isRequestAllowed(req, port) {
  return isLoopback(req.socket.remoteAddress) && isAllowedHost(req.headers.host, port);
}

/**
 * Extra guard for writes: a JSON content type and the custom `x-storyforge: 1` header. The custom
 * header forces a CORS preflight in browsers, and no CORS headers are ever sent, so other web
 * pages cannot make the browser send a write.
 * @param {import('node:http').IncomingMessage} req
 */
export function hasWriteHeaders(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' && req.headers['x-storyforge'] === '1';
}

/**
 * Guard for the attachment upload (a raw file body, so no JSON content type): the custom `x-storyforge: 1` header, which forces a CORS preflight in browsers
 * (no CORS headers are ever sent), and a declared content type.
 * @param {import('node:http').IncomingMessage} req
 */
export function hasUploadHeaders(req) {
  return req.headers['x-storyforge'] === '1' && typeof req.headers['content-type'] === 'string' && req.headers['content-type'].trim() !== '';
}
