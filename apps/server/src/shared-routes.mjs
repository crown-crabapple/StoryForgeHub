// Shared-mode admin routes under /api/shared/ (contract M07-J03 sections 3 and 4): members, invites, shares and the owner's settings. All are class 'admin'
// (policy.mjs); server.mjs only reaches them in shared mode, after the gate said the caller is an owner. Personal mode has no /api/shared/ routes at all.
// Every change is audited here, with ids and roles only. Links are returned once and never stored: only the token hash is.
import { settingsProblem } from '@storyforge/shared';

const DAY = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const bad = (message) => ({ status: 400, body: { error: 'bad_request', code: 'BAD_ARGS', message } });

/**
 * Which /api/shared/ write route (if any) a method + path is.
 * @param {string} method @param {string} pathname
 * @returns {{ route: string, shared: true, id?: string } | null}
 */
export function matchSharedRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'shared') return null;
  const [, , what, id, ...rest] = parts;
  if (rest.length > 0) return null;
  if (id !== undefined && !ID_RE.test(id)) return null;
  if (what === 'members' && id !== undefined) {
    if (method === 'PUT') return { route: 'shared-member-role', shared: true, id };
    if (method === 'DELETE') return { route: 'shared-member-remove', shared: true, id };
  }
  if (what === 'invites') {
    if (method === 'POST' && id === undefined) return { route: 'shared-invite-create', shared: true };
    if (method === 'DELETE' && id !== undefined) return { route: 'shared-invite-revoke', shared: true, id };
  }
  if (what === 'shares') {
    if (method === 'POST' && id === undefined) return { route: 'shared-share-create', shared: true };
    if (method === 'DELETE' && id !== undefined) return { route: 'shared-share-revoke', shared: true, id };
  }
  if (what === 'settings' && id === undefined && method === 'PUT') return { route: 'shared-settings', shared: true };
  return null;
}

/** The write routes of this file; policy.mjs classifies each. */
export const SHARED_ROUTES = Object.freeze(['shared-member-role', 'shared-member-remove', 'shared-invite-create', 'shared-invite-revoke', 'shared-share-create', 'shared-share-revoke', 'shared-settings']);

/**
 * @typedef {{ data: any, settings: { get: () => { ai_for_members: boolean }, set: (p: unknown) => Promise<{ ok: boolean, message?: string }> },
 *   audit: (e: Record<string, unknown>) => Promise<void> | void, actor: string, base: string }} SharedCtx
 */

/** @param {{ ok: false, code: string, message: string }} r */
const refusal = (r) => {
  const status = r.code === 'NOT_FOUND' ? 404 : r.code === 'LAST_OWNER' ? 409 : 400;
  return { status, body: { error: status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'bad_request', code: r.code, message: r.message } };
};

/** @param {unknown} days @param {boolean} required @returns {{ ok: true, ms: number | undefined } | { ok: false, message: string }} */
function lifetime(days, required) {
  if (days === undefined && !required) return { ok: true, ms: undefined };
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) return { ok: false, message: 'expires_days must be a whole number of days, at least 1' };
  return { ok: true, ms: days * DAY };
}

/**
 * GET /api/shared/{members,invites,shares,settings}.
 * @param {string} pathname @param {SharedCtx} ctx
 */
export function handleSharedRead(pathname, ctx) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return NOT_FOUND;
  if (parts[2] === 'members') return { status: 200, body: { members: ctx.data.listMembers() } };
  if (parts[2] === 'invites') return { status: 200, body: { invites: ctx.data.listInvites() } };
  if (parts[2] === 'shares') return { status: 200, body: { shares: ctx.data.listShares() } };
  if (parts[2] === 'settings') return { status: 200, body: ctx.settings.get() };
  return NOT_FOUND;
}

/**
 * @param {{ route: string, id?: string }} match @param {unknown} body parsed JSON @param {SharedCtx} ctx
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export async function handleSharedWrite(match, body, ctx) {
  const b = isObject(body) ? /** @type {Record<string, any>} */ (body) : null;
  /** @param {string} event @param {string} target @param {{ status: number, body: unknown }} res */
  const done = async (event, target, res) => {
    await ctx.audit({ actor: ctx.actor, event, target, result: res.status });
    return res;
  };
  switch (match.route) {
    case 'shared-member-role': {
      if (!b) return bad('body must be a JSON object');
      const r = await ctx.data.setRole(match.id, b.role);
      return done('member.role', `${match.id}:${typeof b.role === 'string' ? b.role : '?'}`, r.ok ? { status: 200, body: { ok: true } } : refusal(r));
    }
    case 'shared-member-remove': {
      const r = await ctx.data.removeMember(match.id);
      return done('member.remove', /** @type {string} */ (match.id), r.ok ? { status: 200, body: { ok: true } } : refusal(r));
    }
    case 'shared-invite-create': {
      if (!b) return bad('body must be a JSON object');
      const life = lifetime(b.expires_days, false);
      if (!life.ok) return bad(life.message);
      const r = await ctx.data.createInvite({ role: b.role, expiresMs: life.ms, by: ctx.actor });
      if (!r.ok) return done('invite.create', '-', refusal(r));
      return done('invite.create', `${r.invite.id}:${r.invite.role}`, { status: 201, body: { invite: r.invite, link: `${ctx.base}/invite#token=${r.token}` } });
    }
    case 'shared-invite-revoke': {
      const r = await ctx.data.revokeInvite(match.id);
      return done('invite.revoke', /** @type {string} */ (match.id), r.ok ? { status: 200, body: { ok: true } } : refusal(r));
    }
    case 'shared-share-create': {
      if (!b) return bad('body must be a JSON object');
      const life = lifetime(b.expires_days, true);
      if (!life.ok) return bad(life.message);
      // scope: ['read'] or ['read','export'], or the words 'read' and 'export' (export means read + export)
      const scope = b.scope === 'read' ? ['read'] : b.scope === 'export' || b.scope === 'read+export' ? ['read', 'export'] : b.scope;
      const r = await ctx.data.createShare({ book: b.book, scope, expiresMs: life.ms, by: ctx.actor });
      if (!r.ok) return done('share.create', '-', refusal(r));
      return done('share.create', `${r.share.id}:${r.share.book}`, { status: 201, body: { share: r.share, link: `${ctx.base}/s#token=${r.token}` } });
    }
    case 'shared-share-revoke': {
      const r = await ctx.data.revokeShare(match.id);
      return done('share.revoke', /** @type {string} */ (match.id), r.ok ? { status: 200, body: { ok: true } } : refusal(r));
    }
    case 'shared-settings': {
      const problem = settingsProblem(body);
      if (problem) return bad(problem);
      const r = await ctx.settings.set(body);
      if (!r.ok) return bad(r.message ?? 'bad settings');
      return done('settings.update', `ai_for_members=${ctx.settings.get().ai_for_members}`, { status: 200, body: ctx.settings.get() });
    }
    default:
      return NOT_FOUND;
  }
}
