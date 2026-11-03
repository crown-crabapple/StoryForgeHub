// Which webhook events a finished request means (contract M08-J02 section 4). Called by server.mjs after a write route or an export / backup download answered
// with success. With no subscription for the event nothing is read and nothing is sent. The payload carries ids, the path and a hash, never text; the scene text
// is read only for a subscription the author created with include_content (the dispatcher asks for it lazily).
import { createHash } from 'node:crypto';

/** write route -> event */
const ROUTE_EVENT = {
  body: 'scene.saved', 'scene-raw': 'scene.saved', 'revision-restore': 'scene.saved',
  create: 'scene.created',
  'scene-move': 'scene.moved',
  'entry-body': 'entry.changed', 'entry-fields': 'entry.changed', 'entry-create': 'entry.changed', 'entry-archive': 'entry.changed', 'entry-restore': 'entry.changed',
  'entry-slug': 'entry.changed', 'entry-move-to-series': 'entry.changed', 'entry-copy-to-book': 'entry.changed',
  'suggestion-create': 'suggestion.created',
  'suggestion-decide': 'suggestion.decided', 'suggestion-hunk-decide': 'suggestion.decided',
};

/**
 * @param {{ service: ReturnType<typeof import('./plugin-service.mjs').createPluginService> }} p
 */
export function createWebhookEvents({ service }) {
  /** @param {any} repository @param {string} bookId */
  async function slugOf(repository, bookId) {
    return (await repository.listBooks()).find((/** @type {any} */ b) => b.id === bookId)?.slug ?? null;
  }
  /** Does anyone listen for `event` on this book? @param {any} repository @param {string} event @param {string} bookId @returns {Promise<string | null | false>} the slug, or false when nobody does */
  async function listened(repository, event, bookId) {
    let store;
    try {
      store = await service.webhooks();
    } catch {
      return false;
    }
    const slug = await slugOf(repository, bookId);
    return store.matching(event, slug).length > 0 ? slug : false;
  }

  return {
    /**
     * A write route answered. @param {any} repository @param {{ route: string, bookId?: string, sceneId?: string, entryId?: string, suggestionId?: string }} match
     * @param {number} status @param {any} result the response body @param {any} request the request body @param {{ name: string } | null} by
     */
    async afterWrite(repository, match, status, result, request, by) {
      const event = /** @type {Record<string, string>} */ (ROUTE_EVENT)[match.route];
      if (!event || status >= 300 || !match.bookId || request?.dryRun === true || result?.dryRun === true) return;
      const bookId = match.bookId;
      const slug = await listened(repository, event, bookId);
      if (slug === false) return;
      /** @type {{ target_id: string | null, path: string | null, sha256: string | null, content?: () => Promise<string | null> }} */
      let d = { target_id: null, path: null, sha256: null };
      if (event.startsWith('scene.')) {
        const id = match.sceneId ?? result?.id;
        const scene = typeof id === 'string' ? await repository.getScene(bookId, id) : null;
        d = { target_id: id ?? null, path: scene?.path ?? result?.path ?? null, sha256: scene?.sha256 ?? result?.sha256 ?? null, ...(scene ? { content: async () => scene.body ?? null } : {}) };
      } else if (event === 'entry.changed') {
        const entry = match.entryId ? await repository.getEntry(bookId, match.entryId) : null;
        const change = Array.isArray(result?.changes) ? result.changes[0] : null;
        d = { target_id: match.entryId ?? null, path: entry?.path ?? change?.to ?? null, sha256: entry?.sha256 ?? change?.after_sha256 ?? null };
      } else if (event === 'suggestion.created') {
        d = { target_id: result?.id ?? null, path: result?.path ?? null, sha256: null };
      } else if (event === 'suggestion.decided') {
        d = { target_id: match.suggestionId ?? null, path: result?.suggestion?.path ?? null, sha256: null };
      }
      await service.dispatcher.emit({ event, book_id: bookId, book: slug, ...d, ...(by ? { by } : {}) });
    },

    /** A plugin's proposal became a suggestion. @param {any} repository @param {any} book @param {{ id: string, path: string }} proposal @param {{ name: string }} by */
    async afterProposal(repository, book, proposal, by) {
      if (!(await listened(repository, 'suggestion.created', book.id))) return;
      await service.dispatcher.emit({ event: 'suggestion.created', book_id: book.id, book: book.slug, target_id: proposal.id, path: proposal.path, sha256: null, by });
    },

    /** An export or a backup finished (the download answered 200). @param {any} repository @param {'export' | 'backup'} kind @param {string} bookId @param {{ bytes: Buffer, headers: Record<string, string> }} raw */
    async afterDownload(repository, kind, bookId, raw) {
      const event = `${kind}.done`;
      const slug = await listened(repository, event, bookId);
      if (slug === false) return;
      const name = /filename="([^"]+)"/.exec(raw.headers['content-disposition'] ?? '')?.[1] ?? null;
      await service.dispatcher.emit({ event, book_id: bookId, book: slug, target_id: null, path: name, sha256: createHash('sha256').update(raw.bytes).digest('hex') });
    },
  };
}
