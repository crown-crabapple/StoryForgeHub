// Webhook subscriptions (contract M08-J02 section 4): `webhooks.json` in the folder given (the user config folder in personal mode, the shared-data folder in
// shared mode; never a library). The signing secret has to be kept to sign, so it is stored here (the folder is owner-only where the OS has modes) and is
// never written to a library, a backup or a log, and never sent back after creation. M08-J03 moves it to the secure key store.
import crypto from 'node:crypto';
import { readSharedJson, writeSharedJson } from '@storyforge/store';
import { checkWebhookUrl } from './url-rules.mjs';

export const WEBHOOK_EVENTS = Object.freeze(['scene.saved', 'scene.created', 'scene.moved', 'entry.changed', 'suggestion.created', 'suggestion.decided', 'export.done', 'backup.done']);
/** After this many deliveries in a row that failed (each after its retries) a subscription is disabled. */
export const MAX_FAILURES = 20;
const FILE = 'webhooks.json';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_RE = /^whk_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_WEBHOOKS = 100;

export class WebhookDataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`${FILE}: ${message}`);
    this.name = 'WebhookDataError';
  }
}

/**
 * @typedef {{ id: string, url: string, events: string[], books: 'all' | string[], include_content: boolean, allow_local: boolean, plugin: string | null,
 *   secret_hash: string, created: number, revoked: boolean, disabled: boolean, failures: number, last_delivery: { at: number, ok: boolean, status: number | null, code: string | null } | null }} PublicWebhook
 */

const isTime = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;

/** @param {any} w */
function validRecord(w) {
  return w !== null && typeof w === 'object' && ID_RE.test(w.id) && typeof w.url === 'string' && HEX64.test(w.secret_hash) && typeof w.secret === 'string' && w.secret.length >= 32
    && Array.isArray(w.events) && w.events.length > 0 && w.events.every((/** @type {string} */ e) => WEBHOOK_EVENTS.includes(e))
    && (w.books === 'all' || (Array.isArray(w.books) && w.books.every((/** @type {unknown} */ b) => typeof b === 'string' && SLUG_RE.test(b))))
    && typeof w.include_content === 'boolean' && typeof w.allow_local === 'boolean' && (w.plugin === null || (typeof w.plugin === 'string' && SLUG_RE.test(w.plugin)))
    && isTime(w.created) && typeof w.revoked === 'boolean' && typeof w.disabled === 'boolean' && Number.isInteger(w.failures) && w.failures >= 0
    && (w.last_delivery === null || (typeof w.last_delivery === 'object' && isTime(w.last_delivery.at) && typeof w.last_delivery.ok === 'boolean'));
}

/** A copy without the secret. @param {any} w @returns {PublicWebhook} */
export function publicWebhook(w) {
  return {
    id: w.id, url: w.url, events: [...w.events], books: w.books === 'all' ? 'all' : [...w.books], include_content: w.include_content, allow_local: w.allow_local, plugin: w.plugin,
    secret_hash: w.secret_hash, created: w.created, revoked: w.revoked, disabled: w.disabled, failures: w.failures,
    last_delivery: w.last_delivery ? { at: w.last_delivery.at, ok: w.last_delivery.ok, status: w.last_delivery.status ?? null, code: w.last_delivery.code ?? null } : null,
  };
}

function newId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (const b of crypto.randomBytes(26)) out += alphabet[b & 31];
  return `whk_${out}`;
}

/**
 * Open the subscriptions kept in `dir`. A damaged file throws WebhookDataError (never reset).
 * @param {string} dir @param {{ now?: () => number }} [opts]
 */
export async function openWebhooks(dir, { now = Date.now } = {}) {
  const r = await readSharedJson(dir, FILE);
  if (r.state === 'corrupt') throw new WebhookDataError(r.message);
  const data = r.state === 'missing' ? { version: 1, webhooks: [] } : r.value;
  if (!data || data.version !== 1 || !Array.isArray(data.webhooks) || !data.webhooks.every(validRecord)) throw new WebhookDataError('unexpected content');
  let queue = Promise.resolve();
  const save = () => {
    const value = structuredClone(data);
    const p = queue.then(() => writeSharedJson(dir, FILE, value));
    queue = p.catch(() => {});
    return p;
  };

  return {
    /**
     * Subscribe an address. The secret is returned once. `plugin` is set when a plugin subscribes for itself.
     * @param {{ url: unknown, events: unknown, books: unknown, include_content?: unknown, allow_local?: unknown, plugin?: string | null }} p
     * @returns {Promise<{ ok: true, secret: string, webhook: PublicWebhook } | { ok: false, code: string, message: string }>}
     */
    async create({ url, events, books, include_content = false, allow_local = false, plugin = null }) {
      if (typeof include_content !== 'boolean' || typeof allow_local !== 'boolean') return { ok: false, code: 'BAD_ARGS', message: 'include_content and allow_local must be true or false' };
      const checked = checkWebhookUrl(url, { allowLocal: allow_local });
      if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
      const evs = Array.isArray(events) ? [...new Set(events)] : [];
      if (evs.length === 0 || !evs.every((e) => WEBHOOK_EVENTS.includes(/** @type {string} */ (e)))) return { ok: false, code: 'BAD_ARGS', message: `events must be a non-empty list of ${WEBHOOK_EVENTS.join(', ')}` };
      const scope = books === 'all' ? 'all' : Array.isArray(books) && books.length > 0 && books.every((b) => typeof b === 'string' && SLUG_RE.test(b)) ? [...new Set(/** @type {string[]} */ (books))].sort() : null;
      if (scope === null) return { ok: false, code: 'BAD_ARGS', message: 'books must be "all" or a non-empty list of book slugs' };
      if (data.webhooks.filter((w) => !w.revoked).length >= MAX_WEBHOOKS) return { ok: false, code: 'TOO_MANY', message: `at most ${MAX_WEBHOOKS} webhooks; revoke one first` };
      const secret = crypto.randomBytes(32).toString('hex');
      const rec = {
        id: newId(), url: checked.url.href, events: /** @type {string[]} */ (evs).sort(), books: scope, include_content, allow_local, plugin,
        secret, secret_hash: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'), created: now(), revoked: false, disabled: false, failures: 0, last_delivery: null,
      };
      data.webhooks.push(rec);
      await save();
      return { ok: true, secret, webhook: publicWebhook(rec) };
    },

    /** @param {{ plugin?: string | null }} [filter] `plugin`: only that plugin's own @returns {PublicWebhook[]} */
    list({ plugin } = {}) {
      return data.webhooks.filter((w) => plugin === undefined || w.plugin === plugin).map(publicWebhook);
    },

    /** @param {string} id @param {{ plugin?: string | null }} [filter] @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>} */
    async revoke(id, { plugin } = {}) {
      const w = data.webhooks.find((x) => x.id === id && (plugin === undefined || x.plugin === plugin));
      if (!w) return { ok: false, code: 'NOT_FOUND', message: 'no such webhook' };
      w.revoked = true;
      await save();
      return { ok: true };
    },

    /** The live subscriptions an event goes to (never a revoked or disabled one). @param {string} event @param {string | null} bookSlug @returns {any[]} records, secret included: for the dispatcher only */
    matching(event, bookSlug) {
      return data.webhooks.filter((w) => !w.revoked && !w.disabled && w.events.includes(event) && (w.books === 'all' || (bookSlug !== null && w.books.includes(bookSlug))));
    },

    /** Record one finished delivery: a success clears the failure count, a failure adds one and disables the subscription at MAX_FAILURES. @param {string} id @param {{ ok: boolean, status?: number, code?: string }} result */
    async recordDelivery(id, result) {
      const w = data.webhooks.find((x) => x.id === id);
      if (!w) return;
      w.last_delivery = { at: now(), ok: result.ok, status: result.status ?? null, code: result.ok ? null : (result.code ?? null) };
      if (result.ok) w.failures = 0;
      else {
        w.failures += 1;
        if (w.failures >= MAX_FAILURES) w.disabled = true;
      }
      await save();
    },

    flush() {
      return queue;
    },
  };
}
