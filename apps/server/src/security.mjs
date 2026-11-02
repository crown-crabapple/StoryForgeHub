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
