// Bearer secrets for shared mode (sessions, invites, shares, the owner setup link): 32 random bytes, base64url. Only sha256(token) is ever stored.
import crypto from 'node:crypto';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** @returns {string} a new token (43 base64url characters) */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** @param {unknown} token @returns {boolean} it has the shape newToken() makes */
export function isTokenShape(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** @param {string} token @returns {string} what is stored and looked up: sha256 hex */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** @param {string} prefix e.g. 'usr' @returns {string} `<prefix>_` + 26 random Crockford base32 characters */
export function newId(prefix) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(26);
  let out = '';
  for (const b of bytes) out += alphabet[b & 31];
  return `${prefix}_${out}`;
}
