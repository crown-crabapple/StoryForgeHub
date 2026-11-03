// Shared-mode request gate (contract M07-J03 sections 1-3): Host and Origin checks, session and share cookies, the /api/auth/* routes, and the
// route policy. server.mjs calls it only when it was started with `--shared`; personal mode keeps its loopback-only guard and has no accounts.
import { allowed, bookOfWrite, classifyRead, WRITE_CLASSES } from './policy.mjs';

const SESSION_COOKIE = 'sf_session';
const SHARE_COOKIE = 'sf_share';
const COOKIE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {string | undefined} header @returns {Map<string, string>} */
export function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (COOKIE_RE.test(name) && !out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * @param {{ data: Awaited<ReturnType<typeof import('@storyforge/shared').openSharedData>>, publicUrl?: string | null, bindHost: string,
 *   aiForMembers?: () => boolean, audit?: (event: Record<string, unknown>) => Promise<void> | void }} opts
 */
export function createSharedGate({ data, publicUrl = null, bindHost, aiForMembers = () => false, audit = () => {} }) {
  const pub = publicUrl ? new URL(publicUrl) : null;
  const secure = pub?.protocol === 'https:';

  /** @param {string} name @param {string} value @param {number | null} maxAgeSeconds null → delete */
  function cookie(name, value, maxAgeSeconds) {
    const parts = [`${name}=${maxAgeSeconds === null ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (secure) parts.push('Secure');
    parts.push(maxAgeSeconds === null ? 'Max-Age=0' : `Max-Age=${maxAgeSeconds}`);
    return parts.join('; ');
  }
  const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

  /** The Host header must name this server: the public URL's host, or the address it is bound to (plus localhost names on loopback). */
  function hostOk(req, port) {
    const h = String(req.headers.host ?? '').toLowerCase();
    if (h === '') return false;
    if (pub) return h === pub.host.toLowerCase();
    const allowedHosts = new Set([`${bindHost}:${port}`.toLowerCase(), `[${bindHost}]:${port}`.toLowerCase()]);
    if (bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost') {
      allowedHosts.add(`127.0.0.1:${port}`);
      allowedHosts.add(`localhost:${port}`);
      allowedHosts.add(`[::1]:${port}`);
    }
    return allowedHosts.has(h);
  }

  /** Every non-GET request must come from this server's own pages: Origin equal to the public origin, or to http(s)://<Host>. */
  function originOk(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === 'null') return false;
    if (pub) return origin === pub.origin;
    return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  }

  /** @returns {Promise<import('@storyforge/shared/src/shared-data.mjs').Principal | null>} */
  async function principalOf(req) {
    const jar = parseCookies(req.headers.cookie);
    const s = jar.get(SESSION_COOKIE);
    if (s) {
      const who = await data.resolveSession(s);
      if (who) return who;
    }
    const sh = jar.get(SHARE_COOKIE);
    return sh ? data.resolveShare(sh) : null;
  }

  /** The address used for rate limiting (the socket address: a reverse proxy should be the only client in that setup). */
  const addressOf = (req) => String(req.socket?.remoteAddress ?? 'unknown');

  const publicUser = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role });

  /**
   * The /api/auth/* routes. Returns null for any other path.
   * @param {import('node:http').IncomingMessage} req @param {string} method @param {string} pathname @param {any} body (parsed JSON for POST)
   * @param {URLSearchParams} query
   * @returns {Promise<{ status: number, body: unknown, setCookie?: string[] } | null>}
   */
  async function handleAuth(req, method, pathname, body, query) {
    if (!pathname.startsWith('/api/auth/')) return null;
    const route = pathname.slice('/api/auth/'.length);
    const b = body && typeof body === 'object' ? body : {};

    if (method === 'GET' && route === 'me') {
      const who = await principalOf(req);
      if (!who) return { status: 200, body: { mode: 'shared', user: null, share: null, needs_owner: data.needsOwner } };
      if (who.kind === 'share') return { status: 200, body: { mode: 'shared', user: null, share: { book: who.book, scope: who.scope } } };
      return { status: 200, body: { mode: 'shared', user: publicUser(who), share: null } };
    }
    if (method === 'GET' && route === 'invite') {
      const peek = data.peekInvite(query.get('token'));
      return peek ? { status: 200, body: peek } : { status: 410, body: { error: 'gone', code: 'GONE', message: 'this invite is not valid any more' } };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };

    if (route === 'login') {
      const r = await data.login(b.username, b.password, addressOf(req));
      await audit({ actor: r.ok ? r.user.id : 'anonymous', event: r.ok ? 'login.ok' : `login.${r.code === 'RATE_LIMITED' ? 'limited' : 'fail'}`, target: typeof b.username === 'string' ? b.username.slice(0, 64) : null, ip: addressOf(req) });
      if (!r.ok) {
        if (r.code === 'RATE_LIMITED') return { status: 429, body: { error: 'rate_limited', code: 'RATE_LIMITED', message: 'too many failed logins; try again in 15 minutes' } };
        return { status: 401, body: { error: 'bad_login', code: 'BAD_LOGIN', message: 'wrong user name or password' } };
      }
      return { status: 200, body: { user: publicUser(r.user) }, setCookie: [cookie(SESSION_COOKIE, r.token, SESSION_MAX_AGE), cookie(SHARE_COOKIE, '', null)] };
    }
    if (route === 'logout') {
      const jar = parseCookies(req.headers.cookie);
      const who = await principalOf(req);
      await data.logout(jar.get(SESSION_COOKIE));
      if (who) await audit({ actor: who.id, event: 'logout' });
      return { status: 200, body: { ok: true }, setCookie: [cookie(SESSION_COOKIE, '', null), cookie(SHARE_COOKIE, '', null)] };
    }
    if (route === 'setup') {
      const r = await data.completeSetup(b.token, b.password);
      if (!r.ok) return { status: r.code === 'GONE' ? 410 : 400, body: { error: r.code.toLowerCase(), code: r.code, message: r.message } };
      await audit({ actor: r.user.id, event: 'setup.complete' });
      const login = await data.login(r.user.username, b.password, addressOf(req));
      return login.ok
        ? { status: 200, body: { user: publicUser(login.user) }, setCookie: [cookie(SESSION_COOKIE, login.token, SESSION_MAX_AGE)] }
        : { status: 200, body: { user: publicUser(r.user) } };
    }
    if (route === 'invite/accept') {
      const r = await data.acceptInvite(b.token, { username: b.username, display_name: b.display_name, password: b.password });
      if (!r.ok) return { status: r.code === 'GONE' ? 410 : 400, body: { error: r.code.toLowerCase(), code: r.code, message: r.message } };
      await audit({ actor: r.user.id, event: 'invite.accept', target: r.user.role });
      const login = await data.login(r.user.username, b.password, addressOf(req));
      return login.ok
        ? { status: 200, body: { user: publicUser(login.user) }, setCookie: [cookie(SESSION_COOKIE, login.token, SESSION_MAX_AGE)] }
        : { status: 200, body: { user: publicUser(r.user) } };
    }
    if (route === 'share') {
      const who = data.resolveShare(b.token);
      if (!who) return { status: 410, body: { error: 'gone', code: 'GONE', message: 'this link is not valid any more' } };
      await audit({ actor: who.id, event: 'share.used', target: who.book, ip: addressOf(req) });
      // a share cookie lasts until the share expires; the server re-checks it on every request
      return { status: 200, body: { share: { book: who.book, scope: who.scope } }, setCookie: [cookie(SHARE_COOKIE, String(b.token), SESSION_MAX_AGE)] };
    }
    if (route === 'password') {
      const who = await principalOf(req);
      if (!who || who.kind !== 'user') return { status: 401, body: { error: 'unauthorized' } };
      const r = await data.changePassword(who.id, b.current, b.next);
      if (!r.ok) return { status: r.code === 'BAD_LOGIN' ? 401 : 400, body: { error: r.code.toLowerCase(), code: r.code, message: r.message } };
      await audit({ actor: who.id, event: 'password.change' });
      const login = await data.login(who.username, b.next, addressOf(req));
      return login.ok ? { status: 200, body: { ok: true }, setCookie: [cookie(SESSION_COOKIE, login.token, SESSION_MAX_AGE)] } : { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  /**
   * Decide a request against the policy. `writeMatch` is matchWriteRoute's result for non-GET requests.
   * @param {import('@storyforge/shared/src/shared-data.mjs').Principal | null} who
   * @param {string} method @param {string} pathname @param {{ route: string, bookId?: string } | null} writeMatch
   * @returns {{ ok: true, cls: string } | { ok: false, status: number, body: unknown, cls: string | null }}
   */
  function decide(who, method, pathname, writeMatch) {
    let cls;
    let book;
    let shareable = false;
    if (method === 'GET') {
      const r = classifyRead(pathname);
      if (!r) return { ok: false, status: 403, body: { error: 'forbidden', code: 'UNCLASSIFIED' }, cls: null };
      cls = r.cls;
      book = r.book;
      shareable = r.shareable === true;
    } else {
      if (!writeMatch) return { ok: false, status: 405, body: { error: 'read_only' }, cls: null };
      cls = WRITE_CLASSES[/** @type {keyof typeof WRITE_CLASSES} */ (writeMatch.route)];
      if (!cls) return { ok: false, status: 403, body: { error: 'forbidden', code: 'UNCLASSIFIED' }, cls: null };
      book = bookOfWrite(writeMatch);
    }
    if (allowed(who, cls, { book, shareable, aiForMembers: aiForMembers(), path: pathname })) return { ok: true, cls };
    if (!who) return { ok: false, status: 401, body: { error: 'unauthorized', code: 'LOGIN_REQUIRED' }, cls };
    return { ok: false, status: 403, body: { error: 'forbidden', code: 'ROLE', message: `your role cannot do this (${cls})` }, cls };
  }

  return { hostOk, originOk, principalOf, handleAuth, decide, cookieNames: { session: SESSION_COOKIE, share: SHARE_COOKIE } };
}
