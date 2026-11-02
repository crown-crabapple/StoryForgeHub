// Small helpers: hashing, ULIDs, operation ids, slugs.
import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** @param {Buffer} buf */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 26-char ULID: 48-bit time + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()) {
  let t = BigInt(now);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[Number(t % 32n)] + time;
    t /= 32n;
  }
  let r = 0n;
  for (const b of crypto.randomBytes(10)) r = (r << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(r % 32n)] + rand;
    r /= 32n;
  }
  return time + rand;
}

export const newSceneId = () => `scene_${ulid()}`;
export const SCENE_ID_RE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `YYYYMMDDTHHMMSSmmmZ-<6 random base32>` */
export function makeOpId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, '');
  let suffix = '';
  for (const b of crypto.randomBytes(6)) suffix += CROCKFORD[b % 32];
  return `${stamp}-${suffix}`;
}

/** Lower-case ASCII slug per spec 1.4 (max 60); '' if nothing usable remains. */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const pad = (n, width) => String(n).padStart(width, '0');
