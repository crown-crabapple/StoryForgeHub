// Password hashing for shared mode (contract M07-J03 section 2): scrypt, N=32768 r=8 p=1, 16-byte salt, 32-byte key, compared in constant time.
// Records read back from users.json are bounds-checked before use, so an edited file cannot make a login burn unbounded CPU or memory.
import crypto from 'node:crypto';

export const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEYLEN = 32;
const SALT_BYTES = 16;
/** Upper bounds accepted from a stored record (anything larger is treated as a broken record). */
const MAX = { N: 1 << 17, r: 16, p: 4 };
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** @param {string} password @param {Buffer} salt @param {{ N: number, r: number, p: number }} params @returns {Promise<Buffer>} */
function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; allow twice that
    crypto.scrypt(password.normalize('NFC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Why `password` may not be used for `username`, or null when it is acceptable.
 * @param {unknown} password @param {string} username
 * @returns {string | null}
 */
export function passwordProblem(password, username) {
  if (typeof password !== 'string') return 'password must be text';
  const length = [...password.normalize('NFC')].length;
  if (length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  if (typeof username === 'string' && password.normalize('NFC').toLowerCase() === username.toLowerCase()) return 'password must not be the user name';
  return null;
}

/**
 * @param {string} password (already checked with passwordProblem)
 * @returns {Promise<{ alg: 'scrypt', N: number, r: number, p: number, salt: string, hash: string }>}
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT);
  return { alg: 'scrypt', ...SCRYPT, salt: salt.toString('base64url'), hash: key.toString('base64url') };
}

/** @param {any} rec @returns {boolean} the stored record is one this code will run */
function usable(rec) {
  if (!rec || typeof rec !== 'object' || rec.alg !== 'scrypt') return false;
  for (const k of /** @type {const} */ (['N', 'r', 'p'])) {
    if (!Number.isInteger(rec[k]) || rec[k] < 1 || rec[k] > MAX[k]) return false;
  }
  // N must be a power of two above 1
  if (rec.N < 2 || (rec.N & (rec.N - 1)) !== 0) return false;
  if (typeof rec.salt !== 'string' || !B64URL_RE.test(rec.salt) || typeof rec.hash !== 'string' || !B64URL_RE.test(rec.hash)) return false;
  return Buffer.from(rec.hash, 'base64url').length === KEYLEN;
}

/** @type {Promise<any> | null} a record for no real user, used so an unknown name costs the same as a wrong password */
let dummy = null;

/**
 * True when `password` matches the stored record. A missing or unusable record still runs one scrypt (on a dummy record) and returns false,
 * so the time taken does not tell an unknown user from a wrong password.
 * @param {unknown} password @param {any} rec
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, rec) {
  const pw = typeof password === 'string' && password.length <= PASSWORD_MAX * 4 ? password : '';
  if (!usable(rec)) {
    dummy ??= hashPassword('storyforge-dummy-password');
    const d = await dummy;
    await derive(pw, Buffer.from(d.salt, 'base64url'), d);
    return false;
  }
  const key = await derive(pw, Buffer.from(rec.salt, 'base64url'), rec);
  const want = Buffer.from(rec.hash, 'base64url');
  return key.length === want.length && crypto.timingSafeEqual(key, want) && pw !== '';
}
