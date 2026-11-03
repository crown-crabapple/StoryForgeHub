// The author's side of the extension boundary (M08-J02), on the member API that Settings uses:
//   GET    /api/plugins                the manifests found in the library (what plugins will ask for) and the grants (never a token)
//   POST   /api/plugins/grants         { plugin, permissions, books } -> 201 { token, grant }: the token is shown ONCE and only its sha256 is stored
//   DELETE /api/plugins/grants/:id     revoke a token
//   GET    /api/webhooks               the subscriptions (never a secret)
//   POST   /api/webhooks               { url, events, books, include_content, allow_local } -> 201 { webhook, secret }: the secret is shown ONCE
//   DELETE /api/webhooks/:id           revoke a subscription
// In personal mode these use the loopback and write-header guards like every member route; in shared mode they are owner only (policy.mjs).
import { PLUGIN_API_MAJOR, loadPlugins } from '@storyforge/format';
import { WEBHOOK_EVENTS } from '@storyforge/integrations';

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const badRequest = (/** @type {string} */ message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });

/** @param {any} state */
const serviceOf = (state) => state?.integrations ?? null;
const unavailable = (/** @type {string} */ what) => ({ status: 503, body: { error: 'unavailable', code: 'UNAVAILABLE', message: `${what} cannot be used here (its file is damaged, or this server has no folder for it)` } });

/**
 * GET /api/plugins and GET /api/webhooks.
 * @param {any} repository @param {any} state @param {'plugins' | 'webhooks'} which
 */
export async function handleIntegrationsRead(repository, state, which) {
  const service = serviceOf(state);
  if (!service) return NOT_FOUND;
  const books = (await repository.listBooks()).map((/** @type {any} */ b) => ({ id: b.id, slug: b.slug, title: b.title }));
  if (which === 'plugins') {
    let grants;
    try {
      grants = (await service.tokens()).list();
    } catch {
      return unavailable('plugin access');
    }
    const info = await repository.libraryInfo();
    const found = await loadPlugins(info.root);
    return {
      status: 200,
      body: {
        api: PLUGIN_API_MAJOR,
        manifests: found.plugins.map((/** @type {any} */ p) => ({
          plugin: p.plugin, name: p.name, version: p.version, api: p.api, permissions: p.permissions, books: p.books, homepage: p.homepage, description: p.description, path: p.path,
          problems: p.problems.map((/** @type {any} */ x) => ({ code: x.code, location: x.location, message: x.message })),
        })),
        grants,
        books,
      },
    };
  }
  let hooks;
  try {
    hooks = (await service.webhooks()).list();
  } catch {
    return unavailable('webhooks');
  }
  return { status: 200, body: { webhooks: hooks, events: WEBHOOK_EVENTS, books } };
}

/**
 * The write routes: plugin-grant, plugin-revoke, webhook-create, webhook-revoke.
 * @param {any} repository @param {{ route: string, tokenId?: string, webhookId?: string }} match @param {Record<string, any>} body @param {any} state
 */
export async function handleIntegrationsWrite(repository, match, body, state) {
  const service = serviceOf(state);
  if (!service) return NOT_FOUND;
  try {
    switch (match.route) {
      case 'plugin-grant': {
        if (body.books !== 'all') {
          // a book slug that does not exist is a typo, not a grant
          const known = new Set((await repository.listBooks()).map((/** @type {any} */ b) => b.slug));
          if (Array.isArray(body.books) && body.books.some((/** @type {unknown} */ s) => !known.has(s))) return badRequest('books names a book that is not in this library', 'UNKNOWN_BOOK');
        }
        const r = await (await service.tokens()).grant({ plugin: body.plugin, permissions: body.permissions, books: body.books });
        return r.ok ? { status: 201, body: { token: r.token, grant: r.grant } } : badRequest(r.message, r.code);
      }
      case 'plugin-revoke': {
        const r = await (await service.tokens()).revoke(/** @type {string} */ (match.tokenId));
        return r.ok ? { status: 200, body: { ok: true } } : NOT_FOUND;
      }
      case 'webhook-create': {
        if (body.books !== 'all' && Array.isArray(body.books)) {
          const known = new Set((await repository.listBooks()).map((/** @type {any} */ b) => b.slug));
          if (body.books.some((/** @type {unknown} */ s) => !known.has(s))) return badRequest('books names a book that is not in this library', 'UNKNOWN_BOOK');
        }
        const r = await (await service.webhooks()).create({ url: body.url, events: body.events, books: body.books, include_content: body.include_content ?? false, allow_local: body.allow_local ?? false });
        return r.ok ? { status: 201, body: { webhook: r.webhook, secret: r.secret } } : badRequest(r.message, r.code);
      }
      case 'webhook-revoke': {
        const r = await (await service.webhooks()).revoke(/** @type {string} */ (match.webhookId));
        return r.ok ? { status: 200, body: { ok: true } } : NOT_FOUND;
      }
      default:
        return NOT_FOUND;
    }
  } catch {
    return unavailable(match.route.startsWith('plugin') ? 'plugin access' : 'webhooks');
  }
}
