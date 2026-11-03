// Webhook address rules (contract M08-J02 section 4). Pure: no network and no filesystem, so Settings can refuse a bad address before it is stored.
//   - `http:` only to this computer (localhost, 127.0.0.0/8, ::1); everything else must be `https:`
//   - no user name or password in the address
//   - a private-network address (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7, fe80::/10, ...) is refused unless the author ticked "allow local network"
// The transport adds the name check (a host name that resolves to a private address) at delivery time.

/** 4 for a dotted IPv4 address, 6 for an IPv6 address (hex groups, colons, an optional dotted tail), 0 for anything else. (No node:net here: this file never touches the network.) @param {string} s @returns {0 | 4 | 6} */
function isIP(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) return m.slice(1).every((x) => Number(x) <= 255) ? 4 : 0;
  return s.includes(':') && /^[0-9a-fA-F:]+(\.\d{1,3}){0,3}$/.test(s) && !s.includes(':::') ? 6 : 0;
}

/** @param {string} host a URL hostname (IPv6 without brackets) @returns {number[] | null} */
function v4Parts(host) {
  if (isIP(host) !== 4) return null;
  return host.split('.').map(Number);
}

/** @param {string} host IPv6 text @returns {string} the dotted IPv4 inside an IPv4-mapped address (::ffff:a.b.c.d or ::ffff:aabb:ccdd), else '' */
function mappedV4(host) {
  const h = host.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!hex) return '';
  const a = parseInt(hex[1], 16);
  const b = parseInt(hex[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** Is this IP address text this computer? @param {string} ip */
export function isLoopbackIp(ip) {
  const bare = ip.replace(/^\[|\]$/g, '');
  const m = mappedV4(bare);
  const p = v4Parts(m || bare);
  if (p) return p[0] === 127;
  return isIP(bare) === 6 && (bare === '::1' || /^(0{1,4}:){7}0{0,3}1$/i.test(bare));
}

/** Is this IP address text on a private or otherwise non-public network (loopback excluded)? @param {string} ip */
export function isPrivateIp(ip) {
  const bare = ip.replace(/^\[|\]$/g, '');
  const m = mappedV4(bare);
  const p = v4Parts(m || bare);
  if (p) {
    const [a, b] = p;
    return a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && p[2] === 0) || a >= 224;
  }
  if (isIP(bare) !== 6) return false;
  const h = bare.toLowerCase();
  if (h === '::') return true;
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Does this host name mean this computer? @param {string} host a lower-case URL hostname */
export const isLocalName = (host) => host === 'localhost' || host.endsWith('.localhost');

/**
 * Check a webhook address.
 * @param {unknown} url
 * @param {{ allowLocal?: boolean }} [opts] `allowLocal`: the author allowed private-network addresses
 * @returns {{ ok: true, url: URL, loopback: boolean } | { ok: false, code: string, message: string }}
 */
export function checkWebhookUrl(url, { allowLocal = false } = {}) {
  if (typeof url !== 'string' || url.length > 2000) return { ok: false, code: 'BAD_URL', message: 'the address must be a URL of at most 2000 characters' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: 'BAD_URL', message: 'the address is not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'REFUSED_PROTOCOL', message: 'only http: and https: addresses are allowed' };
  if (u.username !== '' || u.password !== '') return { ok: false, code: 'REFUSED_CREDENTIALS', message: 'the address must not contain a user name or password' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = isLocalName(host) || isLoopbackIp(host);
  if (u.protocol === 'http:' && !loopback) return { ok: false, code: 'REFUSED_INSECURE', message: 'http: is only allowed to this computer (localhost or 127.0.0.1); use https: for anything else' };
  if (!loopback && !allowLocal && (isPrivateIp(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa'))) {
    return { ok: false, code: 'REFUSED_PRIVATE', message: 'that address is on a private network; tick "allow local network" to send there' };
  }
  return { ok: true, url: u, loopback };
}
