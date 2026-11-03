// Webhook delivery (contract M08-J02 section 4). `emit(event)` finds the subscriptions an event goes to; with none there is no work and no network traffic at all.
// Each delivery is one signed POST (x-storyforge-signature: sha256=<hmac of the exact body bytes>), retried up to 3 times with backoff on a failure that could
// pass later; after MAX_FAILURES deliveries in a row that failed, the store disables the subscription. The body holds ids and hashes only; the scene text is
// added only for a subscription the author created with include_content.
import crypto from 'node:crypto';
import { isRefusal, postWebhook } from './webhook-transport.mjs';

/** Waits before retry 1, 2 and 3. */
export const DEFAULT_BACKOFF_MS = Object.freeze([1000, 4000, 16000]);

/**
 * @typedef {{ event: string, book_id: string, book: string | null, target_id?: string | null, path?: string | null, sha256?: string | null, by?: { name: string } | null,
 *   content?: () => Promise<string | null> }} WebhookEvent  `book`: the book's slug (for the books filter; never sent); `content`: the scene text, read only when a subscriber asked for it
 */

/**
 * @param {{ store: () => Promise<Awaited<ReturnType<typeof import('./webhooks.mjs').openWebhooks>> | null>, enabled?: (bookId: string) => Promise<boolean> | boolean,
 *   deliver?: typeof postWebhook, now?: () => number, sleep?: (ms: number) => Promise<void>, backoffMs?: readonly number[], timeoutMs?: number }} p
 *   `store` gives the subscriptions (null: none, nothing to do); `enabled` is the integrations module gate for a book.
 */
export function createDispatcher({ store, enabled = () => true, deliver = postWebhook, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), backoffMs = DEFAULT_BACKOFF_MS, timeoutMs }) {
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @type {Map<string, Promise<void>>} one delivery at a time per subscription, so events arrive in order */
  const chains = new Map();

  /** @param {any} sub @param {string} body @param {{ event: string, delivery: string }} id */
  async function send(sub, body, id) {
    const s = await store();
    /** @type {string | null} */
    let secret;
    try {
      secret = typeof s?.secretOf === 'function' ? await s.secretOf(sub.id) : (sub.secret ?? null);
    } catch {
      secret = null;
    }
    if (secret === null) {
      // the signing secret cannot be unlocked: nothing is sent (an unsigned delivery is worse than none)
      await s?.recordDelivery(sub.id, { ok: false, code: 'SECRET_LOCKED' });
      return;
    }
    const headers = {
      'x-storyforge-signature': `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`,
      'x-storyforge-event': id.event,
      'x-storyforge-delivery': id.delivery,
    };
    /** @type {Awaited<ReturnType<typeof postWebhook>>} */
    let result = { ok: false, code: 'NETWORK', message: '' };
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      if (attempt > 0) await sleep(backoffMs[attempt - 1]);
      result = await deliver({ url: sub.url, body, headers, allowLocal: sub.allow_local, ...(timeoutMs ? { timeoutMs } : {}) });
      if (result.ok) break;
      const clientError = result.status !== undefined && result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;
      if (isRefusal(result.code) || clientError || result.code === 'REDIRECT_REFUSED') break; // trying again cannot help
    }
    await s?.recordDelivery(sub.id, result.ok ? { ok: true, status: result.status } : { ok: false, code: result.code, ...(result.status !== undefined ? { status: result.status } : {}) });
  }

  /** @param {WebhookEvent} ev */
  async function run(ev) {
    const s = await store();
    if (!s) return;
    const subs = s.matching(ev.event, ev.book);
    if (subs.length === 0) return;
    if (!(await enabled(ev.book_id))) return;
    const at = new Date(now()).toISOString();
    /** @type {{ text: string | null } | null} */
    let content = null;
    for (const sub of subs) {
      /** @type {Record<string, unknown>} */
      const payload = { event: ev.event, at, book_id: ev.book_id, target_id: ev.target_id ?? null, path: ev.path ?? null, sha256: ev.sha256 ?? null };
      if (ev.by) payload.by = { name: ev.by.name };
      if (sub.include_content && ev.content) {
        content ??= { text: await ev.content() };
        if (content.text !== null) payload.content = content.text;
      }
      const body = JSON.stringify(payload);
      const meta = { event: ev.event, delivery: `dlv_${crypto.randomBytes(12).toString('hex')}` };
      const prev = chains.get(sub.id) ?? Promise.resolve();
      const next = prev.then(() => send(sub, body, meta)).catch(() => {});
      chains.set(sub.id, next);
      next.finally(() => {
        if (chains.get(sub.id) === next) chains.delete(sub.id);
      });
      track(next);
    }
  }

  /** @param {Promise<void>} p */
  function track(p) {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  return {
    /** Announce an event. Never throws and never waits for the receivers. @param {WebhookEvent} ev @returns {Promise<void>} resolves once the subscriptions are looked at */
    emit(ev) {
      const p = run(ev).catch(() => {});
      track(p);
      return p;
    },
    /** Wait until every delivery started so far has finished (tests and shutdown). */
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
