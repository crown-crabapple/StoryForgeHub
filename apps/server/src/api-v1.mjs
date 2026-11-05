// API v1 (contract M08-J02 section 3): the versioned read and proposal API a plugin reaches with `Authorization: Bearer <token>`. Nothing here runs plugin code
// and plugins write nothing EXCEPT canvases (planning/canvases/*.canvas), and only with the `canvas` permission, through the repository's canvas methods (same sha
// check as the app, never a dry run): a proposal becomes a suggestion (source: plugin) that changes nothing until the author accepts a hunk in the normal
// review. Reads are projections with stable field names (within API major 1 fields are only added). Who may call what is decided by plugin-policy.mjs first.
import { checkWebhookUrl } from '@storyforge/integrations';
import { loadPlugins } from '@storyforge/format';
import pkg from '../package.json' with { type: 'json' };
import { decidePlugin } from './plugin-policy.mjs';
import { moduleOff, moduleOn } from './preferences.mjs';

export const API_MAJOR = 1;
const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const badRequest = (/** @type {string} */ message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_HUNKS = 200;
const MAX_TEXT = 4 * 1024 * 1024;

/** @param {string} s @returns {string | null} */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The route's name, for the audit log (`plugin.<route>`). @param {string} method @param {string} pathname */
export function v1RouteOf(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v1') return 'other';
  const [, , a, , c, d] = parts;
  if (a === undefined) return 'root';
  if (a === 'webhooks') return method === 'GET' ? 'webhooks' : method === 'POST' ? 'webhook-create' : method === 'DELETE' ? 'webhook-revoke' : 'other';
  if (a !== 'books') return 'other';
  if (parts.length === 3) return 'books';
  if (c === undefined) return 'book';
  if (c === 'scenes' && d !== undefined) return 'scene';
  if (c === 'entries') return d === undefined ? 'entries' : 'entry';
  if (['threads', 'events', 'search', 'graph', 'diagnostics'].includes(c)) return c;
  if (c === 'proposals') return 'proposals';
  if (c === 'canvases') {
    if (d === undefined) return method === 'GET' ? 'canvases' : method === 'POST' ? 'canvas-create' : 'other';
    if (parts[6] === undefined) return method === 'GET' ? 'canvas' : method === 'PUT' ? 'canvas-save' : 'other';
    if (method === 'POST' && parts[6] === 'archive') return 'canvas-archive';
    if (method === 'POST' && parts[6] === 'restore') return 'canvas-restore';
  }
  return 'other';
}

/** @param {any} b a book summary */
const bookOut = (b) => ({ id: b.id, slug: b.slug, title: b.title, status: b.status, series: b.series ?? null, series_number: b.series_number ?? null, language: b.language ?? null, scenes: b.scene_count ?? 0, words: b.word_count ?? 0 });
/** @param {any} s a scene summary */
const sceneRow = (s) => ({ id: s.id, title: s.title, order: s.position, act: s.act, chapter: s.chapter, sequence: s.sequence, status: s.status, pov: s.pov ?? null, words: s.word_count ?? 0, path: s.path });
const lf = (/** @type {string} */ s) => s.replace(/\r\n/g, '\n');

/**
 * Handle one plugin request.
 * @param {{ method: string, pathname: string, params: URLSearchParams, bearer: string, repository: any, state: any, service: ReturnType<typeof import('./plugin-service.mjs').createPluginService>,
 *   readJson: () => Promise<{ ok: true, value: unknown } | { ok: false, status: number, body: unknown }> }} p
 * @returns {Promise<{ status: number, body: unknown, event: { actor: string, event: string, target?: string }, grant: any, book: any, by?: { name: string } }>}
 *   `event` is what the audit log records (shared mode); `book`, `by` and `proposal` are what the webhook layer needs.
 */
export async function handlePluginRequest({ method, pathname, params, bearer, repository, state, service, readJson }) {
  const route = v1RouteOf(method, pathname);
  /** @param {number} status @param {unknown} body @param {any} [grant] @param {string} [target] @param {Record<string, unknown>} [more] */
  const out = (status, body, grant = null, target = undefined, more = {}) => ({ status, body, grant, book: null, event: { actor: grant ? grant.id : 'plugin:unknown', event: `plugin.${route}`, ...(target ? { target } : {}) }, ...more });

  /** @type {Awaited<ReturnType<typeof service.tokens>>} */
  let tokens;
  try {
    tokens = await service.tokens();
  } catch {
    return out(503, { error: 'unavailable', code: 'PLUGINS_UNAVAILABLE', message: 'the plugin tokens cannot be read on this server' });
  }
  let grant;
  try {
    grant = await tokens.resolve(bearer);
  } catch {
    return out(500, { error: 'internal' });
  }
  const books = /** @type {any[]} */ (grant ? await repository.listBooks() : []); // an unknown or revoked token is refused before anything is read
  const slugOf = (/** @type {string} */ x) => books.find((b) => b.slug === x || b.id === x)?.slug ?? null;
  const d = decidePlugin(grant, method, pathname, slugOf);
  if (!d.ok) return out(d.status, d.body, grant);
  const book = d.book ? books.find((b) => b.slug === d.book) : null;
  const target = book ? book.slug : undefined;
  if (!(await moduleOn(repository, state, 'integrations', book ? { bookId: book.id } : {}))) {
    const off = moduleOff('integrations');
    return out(off.status, off.body, grant, target);
  }
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((x) => x === null)) return out(404, NOT_FOUND.body, grant, target);
  const [, , a, , c, d2] = /** @type {string[]} */ (parts);

  try {
    if (a === undefined) return out(200, { api: API_MAJOR, server: pkg.version }, grant);
    if (a === 'webhooks') return await webhooksRoute();
    if (c === undefined && !book) {
      // GET /books: the granted books whose integrations module is on
      const listed = [];
      for (const b of books) if ((grant.books === 'all' || grant.books.includes(b.slug)) && (await moduleOn(repository, state, 'integrations', { bookId: b.id }))) listed.push(bookOut(b));
      return out(200, { books: listed }, grant);
    }
    const bk = /** @type {any} */ (book);
    const done = (/** @type {{ status: number, body: unknown }} */ r, /** @type {string | undefined} */ t = target, more = {}) => out(r.status, r.body, grant, t, { book: bk, ...more });
    if (c === undefined) {
      const full = await repository.getBook(bk.id);
      if (!full) return done(NOT_FOUND);
      return done({
        status: 200,
        body: {
          ...bookOut(full),
          acts: full.acts.map((/** @type {any} */ act) => ({
            act: act.act, label: act.label,
            chapters: act.chapters.map((/** @type {any} */ ch) => ({ chapter: ch.chapter, label: ch.label, title: ch.title, scenes: ch.scenes.map(sceneRow) })),
          })),
        },
      });
    }
    if (c === 'scenes') {
      const s = await repository.getScene(bk.id, d2);
      if (!s) return done(NOT_FOUND);
      return done({ status: 200, body: { ...sceneRow(s), sha256: s.sha256, front_matter: s.front_matter, body: lf(s.body ?? '') } }, `${target}/${d2}`);
    }
    if (c === 'entries' && d2 === undefined) {
      const list = await repository.listCodexEntries(bk.id);
      if (!list) return done(NOT_FOUND);
      return done({ status: 200, body: { entries: list.entries.map((/** @type {any} */ e) => ({ id: e.id, slug: e.slug, type: e.type, name: e.name, status: e.status, role: e.role ?? null, aliases: e.aliases ?? [], archived: Boolean(e.archived), path: e.path })) } });
    }
    if (c === 'entries') {
      const e = await repository.getEntry(bk.id, d2);
      if (!e) return done(NOT_FOUND);
      return done({ status: 200, body: { id: e.id, slug: e.slug, type: e.type, name: e.name, status: e.status, path: e.path, sha256: e.sha256, fields: e.fields ?? {}, body: lf(e.body ?? '') } }, `${target}/${d2}`);
    }
    if (c === 'threads') {
      const t = await repository.listThreads(bk.id);
      if (!t) return done(NOT_FOUND);
      return done({ status: 200, body: { threads: t.threads.map((/** @type {any} */ x) => ({ id: x.id, slug: x.slug, title: x.title, kind: x.kind, status: x.status, setup: x.setup ?? [], develop: x.develop ?? [], payoff: x.payoff ?? [], characters: x.characters ?? [], path: x.path })) } });
    }
    if (c === 'events') {
      const t = await repository.getTimeline(bk.id);
      if (!t) return done(NOT_FOUND);
      return done({ status: 200, body: { events: t.events.map((/** @type {any} */ x) => ({ id: x.id, slug: x.slug, title: x.title, order: x.order, when: x.when ?? '', date: x.date ?? '', scenes: (x.scenes ?? []).map((/** @type {any} */ s) => s.id), characters: x.characters ?? [], locations: x.locations ?? [], path: x.path })) } });
    }
    if (c === 'search') {
      const q = params.get('q');
      if (q === null || q.trim() === '' || q.length > 200) return done(badRequest('q is required and must be 1 to 200 characters'));
      const limitParam = params.get('limit');
      if (limitParam !== null && (!/^[0-9]+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > 100)) return done(badRequest('limit must be an integer from 1 to 100'));
      const hits = await repository.search(q, { bookId: bk.id, limit: limitParam === null ? 20 : Number(limitParam) });
      return done({ status: 200, body: { query: q, hits: hits.map((/** @type {any} */ h) => ({ id: h.id, kind: h.kind, title: h.title, path: h.path, snippet: h.snippet })) } });
    }
    if (c === 'graph') {
      const g = await repository.getGraph(bk.id, {});
      if (!g) return done(NOT_FOUND);
      return done({ status: 200, body: { nodes: g.nodes, edges: g.edges.map((/** @type {any} */ x) => ({ from: x.from, to: x.to, kind: x.kind, rel: x.rel })) } });
    }
    if (c === 'diagnostics') {
      const list = await repository.getDiagnostics(bk.id);
      return done({ status: 200, body: { diagnostics: list.map((/** @type {any} */ x) => ({ code: x.code, severity: x.severity, file: x.file, location: x.location, message: x.message })) } });
    }
    if (c === 'canvases') {
      if (!(await moduleOn(repository, state, 'board', { bookId: bk.id }))) return done(moduleOff('board'));
      const r = await canvasRoute(bk, d2, parts[6] ?? undefined);
      return done(r.res, r.target ?? target);
    }
    if (c === 'proposals') {
      const r = await propose(bk);
      return done(r.res, r.target ? `${target}/${r.target}` : target, r.res.status === 201 ? { by: r.by, proposal: r.proposal } : {});
    }
    return out(404, NOT_FOUND.body, grant, target);
  } catch {
    return out(500, { error: 'internal' }, grant, target);
  }

  /**
   * Canvases: GET list, GET one, POST create, PUT save, POST archive | restore. Only repository canvas methods write, never with dryRun.
   * @param {any} bk @param {string | undefined} slug @param {string | undefined} action
   */
  async function canvasRoute(/** @type {any} */ bk, /** @type {string | undefined} */ slug, /** @type {string | undefined} */ action) {
    const sub = slug === undefined ? undefined : `${bk.slug}/${slug}`;
    /** @param {{ status: number, body: unknown }} res @param {string | undefined} [t] */
    const reply = (res, t = sub) => ({ res, target: t });
    /** @param {any} r a failed repository result */
    const refused = (r) => {
      if (r.code === 'NOT_FOUND') return reply(NOT_FOUND);
      if (r.code === 'CONFLICT') {
        let current = null;
        if (r.current) {
          let canvas = null;
          if (r.current.canvas !== undefined) canvas = r.current.canvas ?? null;
          else if (typeof r.current.text === 'string') {
            try {
              canvas = JSON.parse(r.current.text);
            } catch {
              canvas = null;
            }
          }
          current = { sha256: r.current.sha256, canvas };
        }
        return reply({ status: 409, body: { error: 'conflict', code: 'CONFLICT', current } });
      }
      if (['REFUSED_PATH_TAKEN', 'EXISTS', 'ROLLED_BACK', 'SLUG_TAKEN'].includes(r.code)) return reply({ status: 409, body: { error: 'conflict', code: r.code, ...(r.message ? { message: r.message } : {}) } });
      return reply(badRequest(r.message ?? 'the canvas was refused', r.code ?? 'BAD_ARGS'));
    };
    if (method === 'GET' && slug === undefined) {
      const list = await repository.listCanvases(bk.id);
      return list ? reply({ status: 200, body: { canvases: list.canvases, archived: list.archived } }) : reply(NOT_FOUND);
    }
    if (method === 'GET') {
      const got = await repository.getCanvas(bk.id, slug);
      if (!got) return reply(NOT_FOUND);
      return reply({ status: 200, body: { slug: got.slug, title: got.title, path: got.path, sha256: got.sha256, canvas: got.canvas, problem: got.problem, refs: got.refs, targets: got.targets } });
    }
    const optional = action !== undefined;
    let b = /** @type {Record<string, any>} */ ({});
    const read = await readJson();
    if (!read.ok) {
      if (!optional) return reply({ status: read.status, body: read.body });
    } else if (isObject(read.value)) b = /** @type {Record<string, any>} */ (read.value);
    else if (!optional || read.value !== undefined) return reply(badRequest('body must be a JSON object'));
    if (method === 'POST' && slug === undefined) {
      if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > 200) return reply(badRequest('title must be text of 1 to 200 characters'));
      if (b.slug !== undefined && typeof b.slug !== 'string') return reply(badRequest('slug must be a string'));
      const r = await repository.createCanvas(bk.id, { title: b.title, ...(b.slug !== undefined ? { slug: b.slug } : {}) });
      if (!r.ok) return refused(r);
      const made = await repository.getCanvas(bk.id, r.slug);
      return reply({ status: 201, body: { slug: r.slug, path: r.path, sha256: made ? made.sha256 : null } }, `${bk.slug}/${r.slug}`);
    }
    if (method === 'PUT') {
      if (!isObject(b.canvas) || typeof b.base_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.base_sha256)) return reply(badRequest('expected { canvas: object, base_sha256: the 64-character sha256 you read }'));
      const r = await repository.saveCanvas(bk.id, slug, { canvas: b.canvas, baseSha256: b.base_sha256 });
      if (!r.ok) return refused(r);
      return reply({ status: 200, body: { slug, path: r.path, sha256: r.sha256 } });
    }
    if (method === 'POST' && (action === 'archive' || action === 'restore')) {
      if (b.base_sha256 !== undefined && (typeof b.base_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.base_sha256))) return reply(badRequest('base_sha256 must be the 64-character sha256 you read'));
      const call = action === 'archive' ? repository.archiveCanvas : repository.restoreCanvas;
      const r = await call.call(repository, bk.id, slug, { ...(b.base_sha256 !== undefined ? { baseSha256: b.base_sha256 } : {}) });
      if (!r.ok) return refused(r);
      return reply({ status: 200, body: { ok: true, slug, path: r.path ?? r.to ?? null } });
    }
    return reply(NOT_FOUND);
  }

  /** POST /api/v1/books/:b/proposals { target, text | hunks, rationale } -> 201 { suggestion } */
  async function propose(/** @type {any} */ bk) {
    const none = { target: undefined, by: undefined, proposal: undefined };
    const read = await readJson();
    if (!read.ok) return { ...none, res: { status: read.status, body: read.body } };
    const body = read.value;
    if (!isObject(body)) return { ...none, res: badRequest('body must be a JSON object') };
    const b = /** @type {Record<string, any>} */ (body);
    if (typeof b.target !== 'string' || b.target === '') return { ...none, res: badRequest('target must be the id of a scene, entry, thread or event') };
    if ((b.text === undefined) === (b.hunks === undefined)) return { ...none, res: badRequest('give exactly one of text (the whole new body) and hunks ([{ from, to, replacement }])') };
    if (b.rationale !== undefined && (typeof b.rationale !== 'string' || b.rationale.length > 20_000)) return { ...none, res: badRequest('rationale must be text (up to 20000 characters)') };
    if (b.base_sha256 !== undefined && (typeof b.base_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.base_sha256))) return { ...none, res: badRequest('base_sha256 must be the sha256 the scene had when you read it') };
    if (!(await moduleOn(repository, state, 'suggestions', { bookId: bk.id }))) return { ...none, res: moduleOff('suggestions') };
    const current = await bodyOf(bk.id, b.target);
    if (current === null) return { ...none, res: NOT_FOUND };
    const text = lf(current);
    let next;
    if (b.text !== undefined) {
      if (typeof b.text !== 'string' || b.text.length > MAX_TEXT) return { ...none, res: badRequest('text must be a string') };
      next = lf(b.text);
    } else {
      if (!Array.isArray(b.hunks) || b.hunks.length === 0 || b.hunks.length > MAX_HUNKS) return { ...none, res: badRequest(`hunks must be a list of 1 to ${MAX_HUNKS} { from, to, replacement }`) };
      const hs = [];
      for (const h of b.hunks) {
        if (!isObject(h) || !Number.isInteger(h.from) || !Number.isInteger(h.to) || h.from < 0 || h.to < h.from || h.to > text.length || typeof h.replacement !== 'string') {
          return { ...none, res: badRequest('every hunk is { from, to, replacement }: whole numbers into the body (line breaks count as one character), from <= to, replacement a string') };
        }
        hs.push({ from: h.from, to: h.to, replacement: lf(h.replacement) });
      }
      hs.sort((x, y) => x.from - y.from || x.to - y.to);
      for (let i = 1; i < hs.length; i++) if (hs[i].from < hs[i - 1].to) return { ...none, res: badRequest('hunks must not overlap') };
      next = text;
      for (const h of [...hs].reverse()) next = next.slice(0, h.from) + h.replacement + next.slice(h.to);
    }
    if (text.length === 0) return { ...none, res: badRequest('the target has no body text to change', 'EMPTY_TARGET') };
    const name = await pluginName(grant.plugin);
    const by = { name };
    const r = await repository.createSuggestion(bk.id, {
      target: b.target,
      proposedRange: { from: 0, to: text.length, replacement: next },
      source: 'plugin',
      plugin: grant.plugin,
      mode: 'suggest',
      ...(b.rationale !== undefined ? { rationale: b.rationale } : {}),
      ...(b.base_sha256 !== undefined ? { expectSha256: b.base_sha256 } : {}),
      by,
    });
    if (!r.ok) {
      const status = r.code === 'NOT_FOUND' ? 404 : ['NO_CHANGE', 'SCENE_CHANGED', 'ROLLED_BACK'].includes(r.code) ? 409 : 400;
      return { ...none, res: { status, body: { error: r.code === 'NOT_FOUND' ? 'not_found' : status === 409 ? 'conflict' : 'bad_request', code: r.code, ...(r.message ? { message: r.message } : {}) } } };
    }
    const got = await repository.getSuggestion(bk.id, r.id);
    const suggestion = got.ok ? got.suggestion : { id: r.id, path: r.path, status: r.status, hunks: r.hunks };
    return { target: r.id, by, proposal: { id: r.id, path: r.path }, res: { status: 201, body: { suggestion: suggestionOut(suggestion) } } };
  }

  /** The text a proposal is made against, by the kind the id's prefix names; null when there is no such document. @param {string} bookId @param {string} id @returns {Promise<string | null>} */
  async function bodyOf(bookId, id) {
    const doc = id.startsWith('scene_') ? await repository.getScene(bookId, id)
      : id.startsWith('entry_') ? await repository.getEntry(bookId, id)
        : id.startsWith('thread_') ? await repository.getThread(bookId, id)
          : id.startsWith('event_') ? await repository.getEvent(bookId, id) : null;
    return doc && typeof doc.body === 'string' ? doc.body : null;
  }

  /** The display name of a plugin: its manifest's, else its slug. @param {string} slug */
  async function pluginName(slug) {
    try {
      const info = await repository.libraryInfo();
      const found = (await loadPlugins(info.root)).plugins.find((/** @type {any} */ p) => p.plugin === slug && typeof p.name === 'string' && p.name.trim() !== '');
      if (found) return found.name.trim().slice(0, 80);
    } catch {
      // a manifest problem never blocks a proposal
    }
    return slug;
  }

  /** The plugin's own webhook subscriptions (contract section 4): list, subscribe, revoke. The signing secret is shown once, at creation. */
  async function webhooksRoute() {
    let store;
    try {
      store = await service.webhooks();
    } catch {
      return out(503, { error: 'unavailable', code: 'WEBHOOKS_UNAVAILABLE', message: 'the webhook subscriptions cannot be read on this server' }, grant);
    }
    if (method === 'GET') return out(200, { webhooks: store.list({ plugin: grant.plugin }) }, grant);
    if (method === 'DELETE') {
      const r = await store.revoke(/** @type {string} */ (parts[3]), { plugin: grant.plugin });
      return r.ok ? out(200, { ok: true }, grant, parts[3] ?? undefined) : out(404, NOT_FOUND.body, grant, parts[3] ?? undefined);
    }
    const read = await readJson();
    if (!read.ok) return out(read.status, read.body, grant);
    if (!isObject(read.value)) return out(400, badRequest('body must be a JSON object').body, grant);
    const b = /** @type {Record<string, any>} */ (read.value);
    // the author alone decides to send text, and to send to the local network (Settings); a plugin cannot ask for either
    if (b.include_content !== undefined && b.include_content !== false) return out(400, badRequest('only the author can turn on include_content, in Settings', 'CONTENT_NOT_ALLOWED').body, grant);
    if (b.allow_local !== undefined && b.allow_local !== false) return out(400, badRequest('only the author can allow the local network, in Settings', 'LOCAL_NOT_ALLOWED').body, grant);
    const wanted = b.books === undefined ? grant.books : b.books;
    if (grant.books !== 'all') {
      const ok = Array.isArray(wanted) && wanted.every((/** @type {unknown} */ x) => typeof x === 'string' && grant.books.includes(x));
      if (!ok) return out(403, { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'a plugin can subscribe only to the books its token was granted' }, grant);
    }
    // a plugin may send only to public https addresses: a loopback target would let it make signed blind POSTs to any port on this computer
    const target = checkWebhookUrl(b.url);
    if (target.ok && target.loopback) return out(400, badRequest('a plugin cannot subscribe this computer (localhost); only the author can, in Settings', 'LOCAL_NOT_ALLOWED').body, grant);
    const r = await store.create({ url: b.url, events: b.events, books: wanted, plugin: grant.plugin });
    if (!r.ok) return out(400, { error: 'bad_request', code: r.code, message: r.message }, grant);
    return out(201, { webhook: r.webhook, secret: r.secret }, grant, r.webhook.id);
  }
}

/** The stable shape of a suggestion in API v1. @param {any} s */
function suggestionOut(s) {
  return {
    id: s.id, path: s.path, target: s.target ?? null, status: s.status, source: s.source ?? 'plugin', plugin: s.plugin ?? null, by: s.by ?? null,
    created: s.created ?? null, rationale: s.rationale ?? '', hunks: (s.hunks ?? []).map((/** @type {any} */ h) => ({ id: h.id, line: h.line, lines: h.lines, status: h.status })),
  };
}
