// What the server keeps for the extension boundary (M08-J02): the plugin access tokens and the webhook subscriptions, both opened lazily from one folder (the user
// config folder in personal mode, the shared-data folder in shared mode; never a library), and the webhook dispatcher. Nothing is opened, read or written until a
// plugin request, a Settings call or a webhook event needs it; with no subscription an event costs one lookup and no network traffic.
import { createDispatcher, openWebhooks } from '@storyforge/integrations';
import { openPluginTokens } from '@storyforge/shared';
import { userConfigDir } from '@storyforge/store';

/**
 * @param {{ shared?: { dir?: string } | null, enabled?: (bookId: string) => Promise<boolean> | boolean,
 *   dispatcher?: { deliver?: any, backoffMs?: readonly number[], timeoutMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> } }} p
 *   `dispatcher` is a test seam for the delivery function and the retry timing; production never sets it.
 */
export function createPluginService({ shared = null, enabled, dispatcher: seam = {} }) {
  /** The folder both stores live in; null when shared mode was started without one. */
  const dir = () => (shared ? shared.dir ?? null : userConfigDir());
  /** @type {Promise<Awaited<ReturnType<typeof openPluginTokens>>> | null} */
  let tokensP = null;
  /** @type {Promise<Awaited<ReturnType<typeof openWebhooks>>> | null} */
  let hooksP = null;
  /** @template T @param {() => Promise<T>} open @param {Promise<T> | null} cur @param {(p: Promise<T> | null) => void} set */
  const lazy = (open, cur, set) => {
    if (cur) return cur;
    const p = open();
    set(p);
    p.catch(() => set(null)); // a damaged file is reported each time; it is never cached as "empty"
    return p;
  };
  const service = {
    /** @returns {Promise<Awaited<ReturnType<typeof openPluginTokens>>>} throws when the folder is unknown or plugin-tokens.json is damaged */
    tokens() {
      const d = dir();
      if (d === null) return Promise.reject(new Error('no shared-data folder'));
      return lazy(() => openPluginTokens(d), tokensP, (p) => (tokensP = p));
    },
    /** @returns {Promise<Awaited<ReturnType<typeof openWebhooks>>>} */
    webhooks() {
      const d = dir();
      if (d === null) return Promise.reject(new Error('no shared-data folder'));
      return lazy(() => openWebhooks(d), hooksP, (p) => (hooksP = p));
    },
    dispatcher: createDispatcher({
      store: () => service.webhooks().catch(() => null),
      ...(enabled ? { enabled } : {}),
      ...seam,
    }),
  };
  return service;
}
