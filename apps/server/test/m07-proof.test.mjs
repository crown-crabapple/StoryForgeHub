// M07-J05 proof suite (contract docs/contracts/M07-J05-privacy-conflict-proof.md): the shared-mode security, conflict, privacy and same-project-from-both-modes
// properties, proved through the real server (in-process for the HTTP rules, a spawned main.mjs where the process itself is the subject: sockets, logs, outbound
// traffic, the config folder). One describe/test per numbered contract item. Everything binds 127.0.0.1 on port 0; fixtures are always copies; no network, no
// real clock where an expiry is tested (the shared data takes an injected clock), no randomness the assertions depend on.
// A test that finds a product defect stays and is marked `todo: 'DEFECT: ...'`; nothing was weakened to get green.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { restoreBackup, unzip } from '../../../packages/export/src/index.mjs';
import { validate } from '../../../packages/format/src/index.mjs';
import { createAudit } from '../../../packages/shared/src/index.mjs';
import { WRITE_CLASSES, allowed, bookOfWrite, classifyRead } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { matchSharedRoute } from '../src/shared-routes.mjs';
import { defaultSharedDir } from '../src/shared-cli.mjs';
import { ARRIVAL_PATH, makeHome, profileBody, startApp, startMockProvider, stopAll as stopApps } from './ai-helpers.mjs';
import { REPO_ROOT, copyFixture, request, snapshot } from './helpers.mjs';
import { MAIN } from './proc-helpers.mjs';
import { BOOK, OTHER_BOOK, PW, SCENE, boot, call, closeAll, cookieOf, loadScene, sceneFile } from './shared-helpers.mjs';

after(async () => {
  await closeAll();
  await stopApps();
});

const DAY = 24 * 60 * 60 * 1000;
const b = `/api/books/${BOOK}`;
const S = `${b}/scenes/${SCENE}`;
const FERRY = 'The ferry nudged the jetty';
const DUNES = 'half under water';
const SECRET_PROSE = 'ZEBRA-PROSE-NEVER-IN-LOGS';
const COMMENT_TEXT = 'OKAPI-COMMENT-TEXT-NEVER-IN-LOGS';
const GATE_CODES = ['ROLE', 'UNCLASSIFIED', 'LOGIN_REQUIRED'];
const tokenOf = (link) => link.split('#token=')[1];
const libSnapshot = (t) => snapshot(t.root, { skipStoryforge: true });
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const range = (body, needle) => ({ from: body.indexOf(needle), to: body.indexOf(needle) + needle.length });
const newClock = () => ({ t: 1_800_000_000_000, now() { return this.t; } });
/** The shared-data files whose content an escalation attempt must not change (sessions.json and audit.jsonl legitimately move on every request). */
const ADMIN_FILES = ['members.json', 'users.json', 'invites.json', 'shares.json', 'settings.json'];
const adminState = async (t) => Object.fromEntries(await Promise.all(ADMIN_FILES.map(async (f) => [f, await fs.readFile(path.join(t.dir, f), 'utf8').catch(() => null)])));
const auditLines = async (t) => (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

/** Invite and accept one more member of `t`; returns { cookie, user }. */
async function addUser(t, key, role, display) {
  const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role } });
  assert.equal(inv.status, 201, inv.text);
  const acc = await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: `${key}-user`, display_name: display, password: PW } });
  assert.equal(acc.status, 200, acc.text);
  t.c[key] = cookieOf(acc, 'sf_session');
  t.users[key] = acc.json.user;
  return { cookie: t.c[key], user: acc.json.user };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the request samples behind the sweeps: one representative request per write route, one GET path set per class
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** route name -> [method, url]. Every key of WRITE_CLASSES must have one (checked), so a new route fails here until it is covered. */
const SAMPLES = {
  'act-create': ['POST', `${b}/acts`],
  'act-fields': ['POST', `${b}/acts/1/fields`],
  'activity-session': ['POST', `${b}/activity/session`],
  archive: ['POST', `${S}/archive`],
  'attachment-upload': ['POST', `${b}/attachments?name=x.txt`],
  body: ['PUT', `${S}/body`],
  'chapter-archive': ['POST', `${b}/chapters/1/archive`],
  'chapter-create': ['POST', `${b}/chapters`],
  'chapter-fields': ['POST', `${b}/chapters/1/fields`],
  'chapter-move': ['POST', `${b}/chapters/1/move`],
  'chapters-renumber': ['POST', `${b}/chapters/renumber`],
  'check-scene': ['POST', `${b}/check`],
  'codex-type-create': ['POST', `${b}/codex/types`],
  'continuity-exception-archive': ['DELETE', `${b}/continuity/exceptions/x`],
  'continuity-exception-create': ['POST', `${b}/continuity/exceptions`],
  create: ['POST', `${b}/scenes`],
  'entry-archive': ['POST', `${b}/entries/entry_X/archive`],
  'entry-body': ['PUT', `${b}/entries/entry_X/body`],
  'entry-create': ['POST', `${b}/entries`],
  'entry-fields': ['POST', `${b}/entries/entry_X/fields`],
  'entry-restore': ['POST', `${b}/entries/restore`],
  'entry-slug': ['POST', `${b}/entries/entry_X/slug`],
  'event-archive': ['POST', `${b}/events/event_X/archive`],
  'event-body': ['PUT', `${b}/events/event_X/body`],
  'event-create': ['POST', `${b}/events`],
  'event-fields': ['POST', `${b}/events/event_X/fields`],
  'event-restore': ['POST', `${b}/events/restore`],
  goal: ['POST', `${b}/goal`],
  'index-rebuild': ['POST', '/api/index/rebuild'],
  'note-archive': ['POST', `${b}/notes/note_X/archive`],
  'note-body': ['PUT', `${b}/notes/note_X/body`],
  'note-create': ['POST', `${b}/notes`],
  'note-fields': ['POST', `${b}/notes/note_X/fields`],
  'note-restore': ['POST', `${b}/notes/note_X/restore`],
  'op-restore': ['POST', `${b}/ops/op_X/restore`],
  'receipts-flush': ['POST', `${b}/receipts/flush`],
  restore: ['POST', `${b}/archive/restore`],
  'revision-restore': ['POST', `${S}/revisions/x.md/restore`],
  'revision-save': ['POST', `${S}/revisions`],
  'scene-fields': ['POST', `${S}/fields`],
  'scene-merge': ['POST', `${b}/scenes/merge`],
  'scene-move': ['POST', `${S}/move`],
  'scene-raw': ['PUT', `${S}/raw`],
  'scene-split': ['POST', `${S}/split`],
  'suggestion-decide': ['POST', `${b}/suggestions/sug_X`],
  'suggestion-hunk-decide': ['POST', `${b}/suggestions/sug_X/hunks/h1`],
  'thread-body': ['PUT', `${b}/threads/thread_X/body`],
  'thread-create': ['POST', `${b}/threads`],
  'thread-fields': ['POST', `${b}/threads/thread_X/fields`],
  'comment-create': ['POST', `${b}/comments`],
  'comment-reply': ['POST', `${b}/comments/note_X/replies`],
  'comment-resolve': ['POST', `${b}/comments/note_X`],
  'suggestion-create': ['POST', `${b}/suggestions`],
  presence: ['POST', `${b}/presence`],
  'ai-context': ['POST', `${b}/ai/context`],
  'ai-send': ['POST', `${b}/ai/send`],
  'ai-apply': ['POST', `${b}/ai/apply`],
  'ai-discard': ['POST', `${b}/ai/discard`],
  'library-open': ['POST', '/api/library/open'],
  'recent-remove': ['POST', '/api/library/recent/remove'],
  recover: ['POST', '/api/recover'],
  repair: ['POST', `${b}/repair`],
  'backup-restore': ['POST', '/api/library/restore?folder=proof-x'],
  'book-create': ['POST', '/api/books'],
  'ai-profile-create': ['POST', '/api/ai/profiles'],
  'ai-profile-update': ['PUT', '/api/ai/profiles/prof_X'],
  'ai-profile-delete': ['DELETE', '/api/ai/profiles/prof_X'],
  'ai-profile-test': ['POST', '/api/ai/profiles/prof_X/test'],
  'ai-book-profile': ['PUT', `${b}/ai/profile`],
  'ai-records': ['PUT', `${b}/ai/records`],
  // M08-J03: stop a streamed reply, cover drafts, key move and model discovery
  'ai-cancel': ['POST', `${b}/ai/cancel`],
  'ai-cover-generate': ['POST', `${b}/ai/cover-generate`],
  'ai-cover-use': ['POST', `${b}/ai/cover-use`],
  'ai-cover-delete': ['POST', `${b}/ai/cover-delete`],
  'ai-profile-secure': ['POST', '/api/ai/profiles/prof_X/secure'],
  'ai-profile-discover': ['POST', '/api/ai/profiles/prof_X/discover'],
  'entry-move-to-series': ['POST', `${b}/entries/entry_X/move-to-series`],
  'entry-copy-to-book': ['POST', `${b}/entries/entry_X/copy-to-book`],
  'labels-set': ['POST', `${b}/labels`],
  'template-save': ['POST', `${b}/save-as-template`],
  'canvas-create': ['POST', `${b}/canvases`],
  'canvas-save': ['PUT', `${b}/canvases/board`],
  'canvas-archive': ['POST', `${b}/canvases/board/archive`],
  'canvas-restore': ['POST', `${b}/canvases/board/restore`],
  'scene-cast': ['POST', `${b}/scenes/${SCENE}/cast`],
  'ledger-knowledge-record': ['POST', `${b}/knowledge`],
  'ledger-state-record': ['POST', `${b}/state-events`],
  'activity-ai-log': ['POST', `${b}/activity/ai-words`],
  'workspace-doc-save': ['POST', `${b}/workspace/docs`],
  'workspace-doc-append': ['POST', `${b}/workspace/docs/append`],
  'workspace-doc-lock': ['POST', `${b}/workspace/docs/lock`],
  'workspace-doc-archive': ['POST', `${b}/workspace/docs/archive`],
  'workspace-doc-restore': ['POST', `${b}/workspace/docs/restore`],
  'workspace-setup': ['POST', `${b}/workspace/setup`],
  'planner-link-create': ['POST', `${b}/links`],
  'planner-link-update': ['POST', `${b}/links/key-therefore-ferry`],
  'planner-link-archive': ['POST', `${b}/links/key-therefore-ferry/archive`],
  'planner-link-restore': ['POST', `${b}/links/key-therefore-ferry/restore`],
  'planner-scene-plan-save': ['POST', `${b}/scene-plans/${SCENE}`],
  'planner-story-plan-save': ['POST', `${b}/story-plan`],
  'planner-arc-create': ['POST', `${b}/arcs`],
  'planner-arc-update': ['POST', `${b}/arcs/maren-hollis`],
  'planner-arc-milestones': ['POST', `${b}/arcs/maren-hollis/milestones`],
  'planner-arc-archive': ['POST', `${b}/arcs/maren-hollis/archive`],
  'planner-arc-restore': ['POST', `${b}/arcs/maren-hollis/restore`],
  'planner-structure-create': ['POST', `${b}/structures`],
  'planner-structure-update': ['POST', `${b}/structures/main-three-act`],
  'planner-structure-beats': ['POST', `${b}/structures/main-three-act/beats`],
  'planner-structure-archive': ['POST', `${b}/structures/main-three-act/archive`],
  'planner-structure-restore': ['POST', `${b}/structures/main-three-act/restore`],
  'planner-relationship-create': ['POST', `${b}/relationships`],
  'planner-relationship-update': ['POST', `${b}/relationships/maren-hollis-and-pell`],
  'planner-relationship-developments': ['POST', `${b}/relationships/maren-hollis-and-pell/developments`],
  'planner-relationship-archive': ['POST', `${b}/relationships/maren-hollis-and-pell/archive`],
  'planner-relationship-restore': ['POST', `${b}/relationships/maren-hollis-and-pell/restore`],
  'planner-synopsis-create': ['POST', `${b}/synopses`],
  'planner-synopsis-update': ['POST', `${b}/synopses/one-page`],
  'planner-synopsis-archive': ['POST', `${b}/synopses/one-page/archive`],
  'planner-synopsis-restore': ['POST', `${b}/synopses/one-page/restore`],
  'planner-clue-create': ['POST', `${b}/clues`],
  'planner-clue-update': ['POST', `${b}/clues/sea-gate-key`],
  'planner-clue-knowers': ['POST', `${b}/clues/sea-gate-key/knowers`],
  'planner-clue-archive': ['POST', `${b}/clues/sea-gate-key/archive`],
  'planner-clue-restore': ['POST', `${b}/clues/sea-gate-key/restore`],
  'goal-set': ['POST', `${b}/goals`],
  'goal-remove': ['DELETE', `${b}/goals/goal_X`],
  'task-create': ['POST', `${b}/tasks`],
  'task-status': ['POST', `${b}/tasks/task_X/status`],
  'profile-save': ['PUT', '/api/profile'],
  'profile-switch': ['POST', '/api/profile/switch'],
  'profile-delete': ['DELETE', '/api/profiles/proof-x'],
  'shared-member-role': ['PUT', '/api/shared/members/usr_01S5000000000000000000000A'],
  'shared-member-remove': ['DELETE', '/api/shared/members/usr_01S5000000000000000000000A'],
  'shared-invite-create': ['POST', '/api/shared/invites'],
  'shared-invite-revoke': ['DELETE', '/api/shared/invites/inv_01S5000000000000000000000A'],
  'shared-share-create': ['POST', '/api/shared/shares'],
  'shared-share-revoke': ['DELETE', '/api/shared/shares/shr_01S5000000000000000000000A'],
  'shared-settings': ['PUT', '/api/shared/settings'],
  // M08-J02: plugin access tokens and webhook subscriptions (owner only)
  'plugin-grant': ['POST', '/api/plugins/grants'],
  'plugin-revoke': ['DELETE', '/api/plugins/grants/tok_X'],
  // M12: the book's AI level (owner only)
  'book-ai-level': ['POST', `${b}/ai-level`],
  'webhook-create': ['POST', '/api/webhooks'],
  'webhook-revoke': ['DELETE', '/api/webhooks/whk_X'],
};
const matchOf = (method, url) => {
  const p = url.split('?')[0];
  return matchSharedRoute(method, p) ?? matchWriteRoute(method, p);
};
const bodyFor = (route) => (route === 'body' || route === 'scene-raw' ? { body: `${SECRET_PROSE}\n`, base_sha256: 'a'.repeat(64) } : {});

/** GET paths per class (the class is what classifyRead says; the sample lists are what the sweep covers). */
const GET_SAMPLES = {
  read: [
    '/api/health', '/api/status', '/api/library', '/api/books', '/api/search?q=ferry', '/api/templates', '/api/preferences', '/api/prompts', '/api/index/status',
    b, `${b}/cover`, `${S}`, `${b}/diagnostics`, `${b}/continuity`, `${b}/threads`, `${b}/timeline`, `${b}/graph`, `${b}/codex/entries`, `${b}/mentions`,
    // private project data: members only, never a share (DECISIONS 12)
    `${b}/receipts`, `${b}/receipts/verify`, `${b}/suggestions`, `${b}/comments`, `${b}/notes`, `${b}/scene-notes`, `${S}/revisions`, `${b}/activity`,
    `${b}/raw?path=book.md`, `${b}/ai/status`, `${b}/presence`, `${b}/objects`,
    `${b}/links`, `${b}/links/key-therefore-ferry`, `${b}/flow`, `${b}/scene-plans/${SCENE}`, `${b}/story-plan`, `${b}/plan-overview`, `${b}/arcs`, `${b}/arcs/maren-hollis`, `${b}/structures`, `${b}/structures/main-three-act`, `${b}/structure-templates`, `${b}/relationships`, `${b}/relationships/maren-hollis-and-pell`, `${b}/plan-badges`, `${b}/synopses`, `${b}/synopses/one-page`, `${b}/synopses/one-page/extract`,
    `${b}/clues`, `${b}/clues/sea-gate-key`, `${b}/series-plan`, `${b}/export/planning`, `${b}/ai-activity`,
    `/api/books/${OTHER_BOOK}`, `/api/books/${OTHER_BOOK}/scenes/${SCENE}`,
  ],
  export: [`${b}/export?format=markdown`, `/api/books/${OTHER_BOOK}/export?format=markdown`],
  admin: ['/api/shared/members', '/api/shared/invites', '/api/shared/shares', '/api/shared/settings', '/api/plugins', '/api/webhooks', '/api/ai/profiles', '/api/recover/last', '/api/library/recent', `${b}/backup`, `${b}/repair/plan`],
  auth: ['/api/auth/me'],
};
const PRIVATE_READS = ['receipts', 'receipts/verify', 'suggestions', 'comments', 'notes', 'scene-notes', `scenes/${SCENE}/revisions`, 'activity', 'raw?path=book.md', 'presence', 'ai/status', 'links', 'flow', `scene-plans/${SCENE}`, 'story-plan', 'plan-overview', 'arcs', 'structures', 'relationships', 'plan-badges', 'synopses', 'synopses/one-page/extract', 'clues', 'series-plan', 'export/planning', 'ai-activity'].map((x) => `${b}/${x}`);

const PRINCIPALS = ['owner', 'editor', 'reviewer', 'viewer', 'share', 'exportShare', 'anonymous'];
/** The principal object allowed() takes for each caller kind of the sweep. */
const principalFor = (name) => {
  if (name === 'anonymous') return null;
  if (name === 'share') return { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read'] };
  if (name === 'exportShare') return { kind: 'share', id: 'shr_Y', book: BOOK, scope: ['read', 'export'] };
  return { kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role: name };
};
const cookieFor = (t, name) => (name === 'anonymous' ? undefined : t.c[name]);
const gatePassed = (r) => r.status !== 401 && !GATE_CODES.includes(r.json?.code);

// =========================================================================================================================================================
// 1. Security (shared mode)
// =========================================================================================================================================================

describe('§1.1 roles: every route and every caller gets exactly what allowed() predicts; refusals change nothing', () => {
  test('every WRITE_CLASSES route has a sample request, and the sample really is that route', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(WRITE_CLASSES).sort(), 'SAMPLES and WRITE_CLASSES list the same routes (add a sample for a new route)');
    for (const [route, [method, url]] of Object.entries(SAMPLES)) assert.equal(matchOf(method, url)?.route, route, `${method} ${url}`);
    for (const [cls, urls] of Object.entries(GET_SAMPLES)) {
      for (const u of urls) {
        const r = classifyRead(u.split('?')[0]);
        assert.ok(r, `GET ${u} classifies`);
        if (cls !== 'read') assert.equal(r.cls, cls, `GET ${u}`);
      }
    }
    for (const cls of new Set(Object.values(WRITE_CLASSES))) assert.ok(Object.keys(GET_SAMPLES).length > 0 && cls, cls);
  });

  test('write routes: a refused call is 401 (anonymous) or 403, and leaves every library file unchanged; AI follows the owner setting', async () => {
    const t = await boot();
    const before = await libSnapshot(t);
    let refused = 0;
    for (const aiForMembers of [false, true]) {
      assert.equal((await t.settings.set({ ai_for_members: aiForMembers })).ok, true);
      for (const [route, [method, url]] of Object.entries(SAMPLES)) {
        if (aiForMembers && WRITE_CLASSES[route] !== 'ai') continue;
        const match = matchOf(method, url);
        for (const who of PRINCIPALS) {
          const want = allowed(principalFor(who), WRITE_CLASSES[route], { book: bookOfWrite(match), aiForMembers });
          if (want) continue; // the allowed side runs on its own server below (those calls may legitimately write)
          const r = await t.call(method, url, { cookie: cookieFor(t, who), body: bodyFor(route) });
          assert.equal(r.status, who === 'anonymous' ? 401 : 403, `${who} ${method} ${url} (ai_for_members=${aiForMembers}): ${r.text.slice(0, 200)}`);
          assert.deepEqual(await libSnapshot(t), before, `${who} ${method} ${url} changed a library file`);
          refused++;
        }
      }
    }
    assert.ok(refused > 300, `the sweep really ran (${refused} refusals)`);
  });

  test('write routes: every call allowed() permits passes the gate (it is not refused for role, login or policy)', async () => {
    const t = await boot();
    let passed = 0;
    for (const aiForMembers of [false, true]) {
      assert.equal((await t.settings.set({ ai_for_members: aiForMembers })).ok, true);
      for (const [route, [method, url]] of Object.entries(SAMPLES)) {
        if (aiForMembers && WRITE_CLASSES[route] !== 'ai') continue;
        const match = matchOf(method, url);
        for (const who of ['viewer', 'reviewer', 'editor', 'owner']) {
          if (!allowed(principalFor(who), WRITE_CLASSES[route], { book: bookOfWrite(match), aiForMembers })) continue;
          const r = await t.call(method, url, { cookie: t.c[who], body: bodyFor(route) });
          assert.ok(gatePassed(r), `${who} ${method} ${url} (ai_for_members=${aiForMembers}) was refused by the gate: ${r.status} ${r.text.slice(0, 200)}`);
          passed++;
        }
      }
    }
    assert.ok(passed > 150, `the sweep really ran (${passed} allowed calls)`);
    // the owner's settings call above ended with ai_for_members=true; the table says an editor may now use AI, a reviewer never
    assert.equal(allowed(principalFor('editor'), 'ai', { aiForMembers: true }), true);
    assert.equal(allowed(principalFor('reviewer'), 'ai', { aiForMembers: true }), false);
  });

  test('GET routes by class: each caller gets what allowed() predicts; a refused read leaks no private data', async () => {
    const t = await boot();
    const before = await libSnapshot(t);
    let checked = 0;
    for (const urls of Object.values(GET_SAMPLES)) {
      for (const url of urls) {
        const r0 = classifyRead(url.split('?')[0]);
        for (const who of PRINCIPALS) {
          const want = allowed(principalFor(who), r0.cls, { book: r0.book, shareable: r0.shareable === true, aiForMembers: false, path: url.split('?')[0] });
          const r = await t.call('GET', url, { cookie: cookieFor(t, who) });
          if (want) assert.ok(gatePassed(r), `${who} GET ${url} should pass the gate: ${r.status} ${r.text.slice(0, 160)}`);
          else {
            assert.equal(r.status, who === 'anonymous' ? 401 : 403, `${who} GET ${url}: ${r.text.slice(0, 160)}`);
            assert.ok(!r.text.includes('Ilse') && !r.text.includes(FERRY), `${who} GET ${url} leaked project text`);
          }
          checked++;
        }
      }
    }
    assert.ok(checked > 250);
    assert.deepEqual(await libSnapshot(t), before, 'reads change no library file');
  });

  test('GET routes: independent of the table, a share reads its book and scene text, never the private reads, another book, or admin data', async () => {
    const t = await boot();
    for (const who of ['share', 'exportShare']) {
      assert.equal((await t.call('GET', b, { cookie: t.c[who] })).status, 200, `${who} reads the book`);
      assert.equal((await t.call('GET', S, { cookie: t.c[who] })).status, 200, `${who} reads a scene`);
      for (const u of PRIVATE_READS) assert.equal((await t.call('GET', u, { cookie: t.c[who] })).status, 403, `${who} GET ${u}`);
      assert.equal((await t.call('GET', `/api/books/${OTHER_BOOK}`, { cookie: t.c[who] })).status, 403);
      assert.equal((await t.call('GET', '/api/shared/members', { cookie: t.c[who] })).status, 403);
      assert.equal((await t.call('GET', '/api/books', { cookie: t.c[who] })).status, 403, 'a share cannot list the library');
    }
    assert.equal((await t.call('GET', `${b}/export?format=markdown`, { cookie: t.c.share })).status, 403, 'a read share cannot export');
    assert.equal((await t.call('GET', `${b}/export?format=markdown`, { cookie: t.c.exportShare })).status, 200, 'an export share can');
  });
});

describe('§1.2 escalation attempts are refused and change nothing', () => {
  test('an editor cannot raise their own role (members/<self> -> owner), nor reach any /api/shared route', async () => {
    const t = await boot();
    const before = await adminState(t);
    const lib = await libSnapshot(t);
    const me = t.users.editor.id;
    for (const [method, url, body] of [
      ['PUT', `/api/shared/members/${me}`, { role: 'owner' }],
      ['PUT', `/api/shared/members/${t.users.viewer.id}`, { role: 'owner' }],
      ['DELETE', `/api/shared/members/${t.users.owner.id}`, {}],
      ['POST', '/api/shared/invites', { role: 'owner' }],
      ['POST', '/api/shared/invites', { role: 'viewer' }],
      ['DELETE', '/api/shared/invites/inv_01S5000000000000000000000A', {}],
      ['POST', '/api/shared/shares', { book: BOOK, scope: 'export', expires_days: 5 }],
      ['DELETE', '/api/shared/shares/shr_01S5000000000000000000000A', {}],
      ['PUT', '/api/shared/settings', { ai_for_members: true }],
    ]) {
      const r = await t.call(method, url, { cookie: t.c.editor, body });
      assert.equal(r.status, 403, `${method} ${url}: ${r.text}`);
    }
    for (const u of ['/api/shared/members', '/api/shared/invites', '/api/shared/shares', '/api/shared/settings']) assert.equal((await t.call('GET', u, { cookie: t.c.editor })).status, 403, u);
    assert.deepEqual(await adminState(t), before, 'no member, invite, share or setting changed');
    assert.deepEqual(await libSnapshot(t), lib);
    assert.equal((await t.call('GET', '/api/auth/me', { cookie: t.c.editor })).json.user.role, 'editor');
    assert.equal((await t.call('GET', '/api/auth/me', { cookie: t.c.owner })).json.user.role, 'owner');
  });

  test('a reviewer cannot choose source or by: the server sets both, on suggestions and on comments', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'reviewer');
    const sug = await t.call('POST', `${b}/suggestions`, {
      cookie: t.c.reviewer,
      body: { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' }, source: 'author', mode: 'canon', by: { id: t.users.owner.id, name: 'Ilse' }, status: 'accepted' },
    });
    assert.equal(sug.status, 201, sug.text);
    const got = (await t.call('GET', `${b}/suggestions/${sug.json.id}`, { cookie: t.c.owner })).json;
    assert.equal(got.source, 'reviewer');
    assert.equal(got.mode, 'suggest');
    assert.equal(got.status, 'pending');
    assert.deepEqual(got.by, { id: t.users.reviewer.id, name: 'The reviewer' });
    const com = await t.call('POST', `${b}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 19, text: 'Forged?', by: { id: t.users.owner.id, name: 'Ilse' } } });
    assert.equal(com.status, 201, com.text);
    assert.deepEqual(com.json.comment.by, { id: t.users.reviewer.id, name: 'The reviewer' });
    // an editor's save that claims another author still records the editor
    const cur = await loadScene(t, 'editor');
    const saved = await t.call('PUT', `${S}/body`, { cookie: t.c.editor, body: { body: cur.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: cur.sha256, by: { id: t.users.owner.id, name: 'Ilse' } } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await t.call('POST', `${b}/receipts/flush`, { cookie: t.c.owner, body: { sceneId: SCENE } })).status, 200);
    const rc = (await t.call('GET', `${b}/receipts?scene=${SCENE}`, { cookie: t.c.owner })).json.receipts;
    assert.deepEqual(rc.find((r) => r.operation === 'author.edit')?.by, { id: t.users.editor.id, name: 'The editor' });
  });

  test('a viewer cannot comment (or suggest, reply, resolve); no comments/ folder appears', async () => {
    const t = await boot();
    const before = await libSnapshot(t);
    for (const [url, body] of [[`${b}/comments`, { target: SCENE, line: 19, text: 'hello' }], [`${b}/comments/note_X/replies`, { text: 'hi' }], [`${b}/comments/note_X`, { status: 'resolved' }], [`${b}/suggestions`, { target: SCENE }]]) {
      assert.equal((await t.call('POST', url, { cookie: t.c.viewer, body })).status, 403, url);
    }
    assert.deepEqual(await libSnapshot(t), before);
    await assert.rejects(fs.access(path.join(t.root, 'comments')));
    await assert.rejects(fs.access(path.join(t.root, 'suggestions')));
  });

  test('a share cannot call any write, reach another book or a private read; no file changes', async () => {
    const t = await boot();
    const before = await libSnapshot(t);
    const admin = await adminState(t);
    for (const who of ['share', 'exportShare']) {
      for (const [route, [method, url]] of Object.entries(SAMPLES)) {
        const r = await t.call(method, url, { cookie: t.c[who], body: bodyFor(route) });
        assert.equal(r.status, 403, `${who} ${method} ${url}: ${r.text.slice(0, 160)}`);
      }
      for (const u of [...PRIVATE_READS, `/api/books/${OTHER_BOOK}`, `/api/books/${OTHER_BOOK}/scenes/${SCENE}`]) assert.equal((await t.call('GET', u, { cookie: t.c[who] })).status, 403, `${who} GET ${u}`);
      assert.equal((await t.call('POST', `${b}/comments`, { cookie: t.c[who], body: { target: SCENE, line: 1, text: 'x' } })).status, 403);
    }
    assert.deepEqual(await libSnapshot(t), before);
    assert.deepEqual(await adminState(t), admin);
  });
});

describe('§1.3 sessions', () => {
  const me = (t, cookie) => t.call('GET', '/api/auth/me', { cookie });
  const login = async (t, username = 'editor-user', password = PW) => cookieOf(await t.call('POST', '/api/auth/login', { body: { username, password } }), 'sf_session');

  test('login always issues a new token; a cookie value sent before login is never adopted', async () => {
    const t = await boot();
    const planted = `sf_session=${'A'.repeat(43)}`;
    const r = await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW }, cookie: planted });
    assert.equal(r.status, 200, r.text);
    const issued = cookieOf(r, 'sf_session');
    assert.notEqual(issued, planted, 'the planted value was not adopted');
    assert.equal((await me(t, planted)).json.user, null, 'the planted value authenticates nobody, before or after the login');
    assert.equal((await me(t, issued)).json.user.username, 'editor-user');
    const again = await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW }, cookie: issued });
    assert.notEqual(cookieOf(again, 'sf_session'), issued, 'a second login (even carrying a live cookie) gets a fresh token');
    const tokens = new Set([issued, cookieOf(again, 'sf_session'), await login(t), await login(t)]);
    assert.equal(tokens.size, 4, 'every login is a new token');
  });

  test('a role change applies on the very next request, in both directions, with the same cookie', async () => {
    const t = await boot();
    const body = async () => {
      const s = await loadScene(t, 'editor');
      return { body: `${s.body}\nline\n`, base_sha256: s.sha256 };
    };
    assert.equal((await t.call('PUT', `${S}/body`, { cookie: t.c.editor, body: await body() })).status, 200);
    assert.equal((await t.call('PUT', `/api/shared/members/${t.users.editor.id}`, { cookie: t.c.owner, body: { role: 'viewer' } })).status, 200);
    const refused = await t.call('PUT', `${S}/body`, { cookie: t.c.editor, body: await body() });
    assert.equal(refused.status, 403, 'demoted: refused on the next request');
    assert.equal((await me(t, t.c.editor)).json.user.role, 'viewer');
    assert.equal((await t.call('GET', `${S}`, { cookie: t.c.editor })).status, 200, 'but still reads');
    assert.equal((await t.call('PUT', `/api/shared/members/${t.users.editor.id}`, { cookie: t.c.owner, body: { role: 'editor' } })).status, 200);
    assert.equal((await t.call('PUT', `${S}/body`, { cookie: t.c.editor, body: await body() })).status, 200, 'promoted: allowed on the next request');
  });

  test('removing a member kills their live sessions (every one of them); they cannot sign in again', async () => {
    const t = await boot();
    const second = await login(t);
    assert.equal((await me(t, t.c.editor)).json.user.username, 'editor-user');
    assert.equal((await t.call('DELETE', `/api/shared/members/${t.users.editor.id}`, { cookie: t.c.owner })).status, 200);
    for (const c of [t.c.editor, second]) {
      assert.equal((await me(t, c)).json.user, null);
      assert.equal((await t.call('GET', S, { cookie: c })).status, 401);
    }
    assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'editor-user', password: PW } })).status, 401);
  });

  test('a password change kills every other session of that user, and only theirs', async () => {
    const t = await boot();
    const other = await login(t, 'reviewer-user');
    const a = await login(t);
    const c = await login(t);
    const r = await t.call('POST', '/api/auth/password', { cookie: a, body: { current: PW, next: 'a different long password' } });
    assert.equal(r.status, 200, r.text);
    for (const dead of [a, c, t.c.editor]) assert.equal((await me(t, dead)).json.user, null);
    assert.equal((await me(t, cookieOf(r, 'sf_session'))).json.user.username, 'editor-user');
    assert.equal((await me(t, other)).json.user.username, 'reviewer-user', 'somebody else is untouched');
  });

  test('the idle (14 days) and absolute (30 days) expiries hold on a controlled clock', async () => {
    const clock = newClock();
    const t = await boot({ clock });
    const idle = await login(t);
    clock.t += 14 * DAY - 1000;
    assert.equal((await me(t, idle)).json.user.username, 'editor-user', 'just inside the idle limit');
    clock.t += 14 * DAY + 1000;
    assert.equal((await me(t, idle)).json.user, null, 'idle past 14 days');
    assert.equal((await t.call('PUT', `${S}/body`, { cookie: idle, body: { body: 'x\n', base_sha256: 'a'.repeat(64) } })).status, 401);
    const busy = await login(t);
    for (let i = 0; i < 3; i++) {
      clock.t += 9 * DAY;
      assert.equal((await me(t, busy)).json.user.username, 'editor-user', `in use at day ${(i + 1) * 9}`);
    }
    clock.t += 4 * DAY;
    assert.equal((await me(t, busy)).json.user, null, 'past 30 days in all, however busy');
  });

  test('logout clears the cookie and ends the session', async () => {
    const t = await boot();
    const c = await login(t);
    const out = await t.call('POST', '/api/auth/logout', { cookie: c, body: {} });
    assert.equal(out.status, 200);
    const line = out.setCookie.find((x) => x.startsWith('sf_session='));
    assert.ok(line, 'the cookie is cleared by the response');
    assert.match(line, /^sf_session=;/);
    assert.match(line, /Max-Age=0/);
    assert.equal((await me(t, c)).json.user, null);
    assert.equal((await t.call('PUT', `${S}/body`, { cookie: c, body: { body: 'x\n', base_sha256: 'a'.repeat(64) } })).status, 401);
  });

  test('a tampered token (one character changed, anywhere) is anonymous', async () => {
    const t = await boot();
    const c = await login(t);
    const token = c.split('=')[1];
    assert.equal(token.length, 43);
    for (const at of [0, 1, 21, 41, 42]) {
      const flipped = token[at] === 'A' ? 'B' : 'A';
      const bad = `sf_session=${token.slice(0, at)}${flipped}${token.slice(at + 1)}`;
      assert.equal((await me(t, bad)).json.user, null, `position ${at}`);
      assert.equal((await t.call('GET', S, { cookie: bad })).status, 401, `position ${at}`);
    }
    for (const bad of [`sf_session=${token.slice(0, -1)}`, `sf_session=${token}x`, `sf_session=${token.toLowerCase()}`, 'sf_session=']) {
      assert.equal((await me(t, bad)).json.user, null, bad);
    }
    assert.equal((await me(t, c)).json.user.username, 'editor-user', 'the real one still works');
  });
});

describe('§1.4 invites and shares', () => {
  test('expired, revoked and reused invites are refused (410) and add nobody', async () => {
    const clock = newClock();
    const t = await boot({ clock });
    const members = () => t.data.listMembers().length;
    const n0 = members();
    const mk = async (body) => (await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body })).json;
    const accept = (token, name) => t.call('POST', '/api/auth/invite/accept', { body: { token, username: name, display_name: 'New', password: PW } });
    const good = await mk({ role: 'reviewer', expires_days: 3 });
    assert.equal((await accept(tokenOf(good.link), 'newcomer-one')).status, 200);
    assert.equal(members(), n0 + 1);
    assert.equal((await accept(tokenOf(good.link), 'newcomer-two')).status, 410, 'reused');
    const revoked = await mk({ role: 'viewer' });
    assert.equal((await t.call('DELETE', `/api/shared/invites/${revoked.invite.id}`, { cookie: t.c.owner })).status, 200);
    assert.equal((await accept(tokenOf(revoked.link), 'newcomer-three')).status, 410, 'revoked');
    const old = await mk({ role: 'viewer', expires_days: 1 });
    clock.t += 1 * DAY + 1000;
    assert.equal((await accept(tokenOf(old.link), 'newcomer-four')).status, 410, 'expired');
    assert.equal((await t.call('GET', `/api/auth/invite?token=${tokenOf(old.link)}`)).status, 410);
    assert.equal(members(), n0 + 1, 'none of the refused invites added a member');
    assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'newcomer-two', password: PW } })).status, 401);
  });

  test('a revoked or expired share stops working on the next request, even for a browser that already holds its cookie', async () => {
    const clock = newClock();
    const t = await boot({ clock });
    const mkShare = async (days) => {
      const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope: 'export', expires_days: days } });
      assert.equal(sh.status, 201, sh.text);
      const used = await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } });
      assert.equal(used.status, 200, used.text);
      return { id: sh.json.share.id, token: tokenOf(sh.json.link), cookie: cookieOf(used, 'sf_share') };
    };
    const reads = async (cookie) => [(await t.call('GET', S, { cookie })).status, (await t.call('GET', `${b}/export?format=markdown`, { cookie })).status];
    const a = await mkShare(30);
    assert.deepEqual(await reads(a.cookie), [200, 200]);
    assert.equal((await t.call('DELETE', `/api/shared/shares/${a.id}`, { cookie: t.c.owner })).status, 200);
    assert.deepEqual(await reads(a.cookie), [401, 401], 'revoked: the very next request');
    assert.equal((await t.call('POST', '/api/auth/share', { body: { token: a.token } })).status, 410, 'and the link is dead');
    assert.equal((await t.call('GET', '/api/auth/me', { cookie: a.cookie })).json.share, null);

    const e = await mkShare(2);
    assert.deepEqual(await reads(e.cookie), [200, 200]);
    clock.t += 2 * DAY + 1000;
    assert.deepEqual(await reads(e.cookie), [401, 401], 'expired: the very next request');
    assert.equal((await t.call('POST', '/api/auth/share', { body: { token: e.token } })).status, 410);
    assert.deepEqual(await reads(t.c.exportShare), [200, 200], 'another, unexpired (30 day) share is unaffected');
  });
});

describe('§1.5 request forgery makes no change', () => {
  const targets = (t, sha) => [
    ['PUT', `${S}/body`, { body: `${SECRET_PROSE}\n`, base_sha256: sha }],
    ['POST', `${b}/comments`, { target: SCENE, line: 19, text: 'forged' }],
    ['POST', '/api/shared/invites', { role: 'owner' }],
    ['PUT', `/api/shared/members/${t.users.viewer.id}`, { role: 'owner' }],
  ];

  test('no x-storyforge header, a simple-form content type, a missing, wrong or null Origin, and a wrong Host are all refused', async () => {
    const t = await boot();
    const sha = (await loadScene(t)).sha256;
    const lib = await libSnapshot(t);
    const admin = await adminState(t);
    const attempts = [
      ['no x-storyforge header', { guard: false, headers: { 'content-type': 'application/json' } }],
      ['x-storyforge but text/plain', { headers: { 'content-type': 'text/plain' } }],
      ['text/plain without the header (the simple form shape)', { guard: false, headers: { 'content-type': 'text/plain' } }],
      ['urlencoded form', { guard: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
      ['multipart form', { guard: false, headers: { 'content-type': 'multipart/form-data; boundary=x' } }],
      ['wrong x-storyforge value', { headers: { 'x-storyforge': '0' } }],
      ['another origin', { origin: 'http://evil.example' }],
      ['same host, other port', { origin: `http://127.0.0.1:${t.port + 1}` }],
      ['no Origin', { origin: null }],
      ['Origin null', { origin: 'null' }],
      ['Origin with a path-like suffix', { origin: `http://127.0.0.1:${t.port}.evil.example` }],
      ['wrong Host (DNS rebinding)', { headers: { Host: 'evil.example' } }],
      ['wrong Host with our port', { headers: { Host: `evil.example:${t.port}` } }],
    ];
    for (const [what, o] of attempts) {
      for (const [method, url, body] of targets(t, sha)) {
        const r = await t.call(method, url, { cookie: t.c.owner, body, ...o });
        assert.equal(r.status, 403, `${what} ${method} ${url}: ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW }, origin: 'http://evil.example' })).status, 403, 'login needs the Origin too');
    assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: PW }, headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await t.call('GET', '/api/health', { headers: { Host: 'evil.example' } })).status, 403, 'a read with a wrong Host is refused too');
    assert.deepEqual(await libSnapshot(t), lib);
    assert.deepEqual(await adminState(t), admin);
    const ok = await t.call('PUT', `${S}/body`, { cookie: t.c.owner, body: { body: `${SECRET_PROSE}\n`, base_sha256: sha } });
    assert.equal(ok.status, 200, 'the same request done right works');
    assert.ok(!('access-control-allow-origin' in ok.headers), 'no CORS header is ever sent');
    const pre = await t.call('OPTIONS', S, { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' }, cookie: t.c.owner });
    assert.ok(!('access-control-allow-origin' in pre.headers) && pre.status !== 200, `a preflight is not approved (${pre.status})`);
  });

  test('raw?path=../.. and encoded traversal read nothing outside the book (for a member, and for a share)', async () => {
    const t = await boot();
    const canary = 'CANARY-OUTSIDE-THE-BOOK';
    await fs.writeFile(path.join(path.dirname(t.root), 'canary-outside.md'), `${canary}\n`);
    const enc = (x) => x.split(String.fromCharCode(92)).join('%5C').split(String.fromCharCode(0)).join('%00').split(' ').join('%20');
    const sharedFile = path.relative(t.root, path.join(t.dir, 'users.json')).split(path.sep).join('/');
    const probes = [
      '../..', '..', '../canary-outside.md', '..%2fcanary-outside.md', '%2e%2e/canary-outside.md', '%2e%2e%2fcanary-outside.md', '%252e%252e%252fcanary-outside.md',
      '..\\canary-outside.md', '..%5ccanary-outside.md', 'manuscript/../../canary-outside.md', './../canary-outside.md', '....//canary-outside.md', '..;/canary-outside.md',
      path.join(path.dirname(t.root), 'canary-outside.md'), `/${path.join(path.dirname(t.root), 'canary-outside.md').split(path.sep).join('/')}`, 'C:\\Windows\\win.ini', '/etc/passwd',
      sharedFile, `..%2f${sharedFile.replace(/\//g, '%2f')}`, 'canary-outside.md\u0000.md', '.storyforge/index.sqlite',
    ];
    for (const who of ['owner', 'viewer', 'share']) {
      for (const p of probes) {
        const r = await t.call('GET', `${b}/raw?path=${enc(p)}`, { cookie: t.c[who] });
        assert.ok(!r.text.includes(canary) && !r.text.includes('"pw"') && !r.text.includes('scrypt'), `${who} raw?path=${p} leaked: ${r.text.slice(0, 120)}`);
        if (who === 'share') assert.equal(r.status, 403, `a share never reads raw (${p})`);
        else assert.ok(r.status >= 400, `${who} raw?path=${p} -> ${r.status}`);
      }
    }
    // the same in the URL path and the static file route (verbatim paths: global fetch would normalise dot segments)
    for (const p of [`/api/books/..%2f..%2fcanary-outside.md`, `/api/books/${BOOK}/scenes/..%2f..%2fcanary-outside.md`, '/..%2f..%2fcanary-outside.md', '/%2e%2e/%2e%2e/canary-outside.md', '/../../canary-outside.md', '/..\\..\\canary-outside.md']) {
      const r = await request(t.port, 'GET', p);
      assert.ok(!r.text.includes(canary), `GET ${p} leaked`);
    }
  });
});

describe('§1.6 audit integrity', () => {
  /** Run the scripted calls on `t`; returns the events they must produce, in order. */
  async function script(t) {
    const scene = await loadScene(t, 'editor');
    const sid = t.users;
    const shareId = (await t.call('GET', '/api/shared/shares', { cookie: t.c.owner })).json.shares[0].id;
    const steps = [
      ['editor saves', 'PUT', `${S}/body`, 'editor', { body: scene.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: scene.sha256 }, [sid.editor.id, 'write.body', `${BOOK}/${SCENE}`, 200]],
      ['viewer tries to save', 'PUT', `${S}/body`, 'viewer', { body: 'no\n', base_sha256: scene.sha256 }, [sid.viewer.id, 'write.body.refused', `${BOOK}/${SCENE}`, 403]],
      ['reviewer comments', 'POST', `${b}/comments`, 'reviewer', { target: SCENE, line: 19, text: COMMENT_TEXT }, [sid.reviewer.id, 'comment.comment-create', BOOK, 201]],
      ['viewer tries to comment', 'POST', `${b}/comments`, 'viewer', { target: SCENE, line: 19, text: 'no' }, [sid.viewer.id, 'comment.comment-create.refused', BOOK, 403]],
      ['reviewer suggests', 'POST', `${b}/suggestions`, 'reviewer', { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' } }, [sid.reviewer.id, 'suggest.suggestion-create', BOOK, 201]],
      ['editor tries an admin route', 'POST', '/api/shared/invites', 'editor', { role: 'viewer' }, [sid.editor.id, 'admin.shared-invite-create.refused', undefined, 403]],
      ['reviewer tries to accept', 'POST', `${b}/suggestions/sug_X`, 'reviewer', { decision: 'accept' }, [sid.reviewer.id, 'write.suggestion-decide.refused', `${BOOK}/sug_X`, 403]],
      ['a share tries to save', 'PUT', `${S}/body`, 'share', { body: 'no\n', base_sha256: scene.sha256 }, [shareId, 'write.body.refused', `${BOOK}/${SCENE}`, 403]],
      ['editor saves from a stale base', 'PUT', `${S}/body`, 'editor', { body: `${scene.body}\nstale\n`, base_sha256: scene.sha256 }, [sid.editor.id, 'write.body', `${BOOK}/${SCENE}`, 409]],
      ['owner invites', 'POST', '/api/shared/invites', 'owner', { role: 'viewer' }, [sid.owner.id, 'invite.create', undefined, 201]],
    ];
    const expected = [];
    for (const [what, method, url, who, body, ev] of steps) {
      const r = await t.call(method, url, { cookie: t.c[who], body });
      assert.equal(r.status, ev[3], `${what}: ${r.text.slice(0, 150)}`);
      expected.push(ev);
    }
    return expected;
  }

  test('every refused and accepted state-changing call by a signed-in caller appears exactly once, in order, with actor, route class, target and result', async () => {
    const t = await boot();
    const n0 = (await auditLines(t)).length;
    const expected = await script(t);
    const got = (await auditLines(t)).slice(n0);
    assert.deepEqual(
      got.map((l) => [l.actor, l.event, l.target === undefined || l.event === 'invite.create' ? undefined : l.target, l.result]),
      expected.map(([actor, event, target, result]) => [actor, event, target, result]),
    );
    assert.ok(got.every((l, i) => l.seq === n0 + i + 1));
    assert.deepEqual(await t.audit.verify(), { ok: true, lines: n0 + expected.length });
  });

  test('a refused write by an anonymous caller is audited too', async () => {
    const t = await boot();
    const n0 = (await auditLines(t)).length;
    assert.equal((await t.call('PUT', `${S}/body`, { body: { body: 'x\n', base_sha256: 'a'.repeat(64) } })).status, 401);
    const got = (await auditLines(t)).slice(n0);
    assert.equal(got.length, 1, 'one audit line for the refused anonymous call');
    assert.match(got[0].event, /write\.body\.refused/);
  });

  test('audit verify passes (API and CLI); editing, deleting or reordering any line breaks the chain', async () => {
    const t = await boot();
    await script(t);
    const file = path.join(t.dir, 'audit.jsonl');
    const text = await fs.readFile(file, 'utf8');
    const raw = text.split('\n');
    assert.equal(raw[raw.length - 1], '');
    const lines = raw.slice(0, -1);
    assert.ok(lines.length >= 15, `${lines.length} audit lines`);
    assert.deepEqual(await t.audit.verify(), { ok: true, lines: lines.length });
    const cli = spawnSync(process.execPath, [MAIN, 'audit', 'verify', '--shared-data', t.dir], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /chain is intact/);

    const probe = async (variant, label) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-audit-tamper-'));
      await fs.writeFile(path.join(dir, 'audit.jsonl'), variant);
      const v = await createAudit(dir).verify();
      assert.equal(v.ok, false, `${label}: tampering is detected`);
      return v;
    };
    // every line but the last (nothing follows the last, see the todo test below): edited, deleted, swapped with the next
    for (let i = 0; i < lines.length - 1; i++) {
      const edited = [...lines];
      edited[i] = edited[i].replace(/"actor":"([^"]*)"/, '"actor":"usr_FORGED"');
      assert.notEqual(edited[i], lines[i]);
      const v = await probe(`${edited.join('\n')}\n`, `edit line ${i + 1}`);
      assert.equal(v.code, 'AUDIT_CHAIN_BROKEN');
      assert.ok(v.line === i + 1 || v.line === i + 2, `edit line ${i + 1}: reported at ${v.line}`);
      const deleted = lines.filter((_, k) => k !== i);
      assert.equal((await probe(`${deleted.join('\n')}\n`, `delete line ${i + 1}`)).code, 'AUDIT_CHAIN_BROKEN');
      const swapped = [...lines];
      [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
      assert.equal((await probe(`${swapped.join('\n')}\n`, `swap lines ${i + 1} and ${i + 2}`)).code, 'AUDIT_CHAIN_BROKEN');
    }
    // a line cut off mid-write is reported as truncated
    assert.equal((await probe(text.slice(0, -15), 'cut-off last line')).code, 'AUDIT_TAIL_TRUNCATED');
    assert.equal((await probe(text.slice(0, -1), 'last line without its newline')).code, 'AUDIT_TAIL_TRUNCATED');
  });

  test('removing whole lines from the tail is detected', async () => {
    const t = await boot();
    await script(t);
    const lines = (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-audit-tail-'));
    await fs.writeFile(path.join(dir, 'audit.jsonl'), `${lines.slice(0, -3).join('\n')}\n`);
    assert.equal((await createAudit(dir).verify()).ok, false, 'three events were cut from the end');
  });

  test('editing the last line is detected', async () => {
    const t = await boot();
    await script(t);
    const lines = (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-audit-last-'));
    lines[lines.length - 1] = lines[lines.length - 1].replace(/"result":\d+/, '"result":403');
    await fs.writeFile(path.join(dir, 'audit.jsonl'), `${lines.join('\n')}\n`);
    assert.equal((await createAudit(dir).verify()).ok, false);
  });

  test('the audit log and every shared-data file hold no password, no token and no scene text', async () => {
    const t = await boot();
    const secrets = [PW, 'a second password 99', 'a wrong password'];
    const tokens = Object.values(t.c).map((c) => c.split('=')[1]);
    // fresh invites and shares, a password change, a failed login, a prose save, a comment and a suggestion: everything that could leak
    const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'viewer' } });
    tokens.push(tokenOf(inv.json.link));
    const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope: 'read', expires_days: 3 } });
    tokens.push(tokenOf(sh.json.link));
    await t.call('POST', '/api/auth/login', { body: { username: 'ilse', password: 'a wrong password' } });
    const ch = await t.call('POST', '/api/auth/password', { cookie: t.c.viewer, body: { current: PW, next: 'a second password 99' } });
    assert.equal(ch.status, 200);
    tokens.push(cookieOf(ch, 'sf_session').split('=')[1]);
    const scene = await loadScene(t, 'editor');
    await t.call('PUT', `${S}/body`, { cookie: t.c.editor, body: { body: `${scene.body}\n${SECRET_PROSE}\n`, base_sha256: scene.sha256 } });
    await t.call('POST', `${b}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 19, text: COMMENT_TEXT } });
    await t.call('POST', `${b}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' }, rationale: COMMENT_TEXT } });
    await t.call('PUT', '/api/shared/settings', { cookie: t.c.owner, body: { ai_for_members: true } });
    const needles = [...secrets, ...tokens, SECRET_PROSE, COMMENT_TEXT, FERRY, 'waist-deep', 'Past the dunes'];
    assert.ok(tokens.every((x) => x.length >= 40));
    const files = await fs.readdir(t.dir);
    assert.ok(files.includes('audit.jsonl') && files.includes('users.json') && files.includes('sessions.json'));
    for (const f of files) {
      const text = await fs.readFile(path.join(t.dir, f), 'utf8').catch(() => '');
      for (const n of needles) assert.ok(!text.includes(n), `${f} holds a secret or scene text (${n.slice(0, 12)}...)`);
    }
  });
});

// =========================================================================================================================================================
// 2. Conflicts and attribution
// =========================================================================================================================================================

const suggestionOf = async (t, id) => (await t.call('GET', `${b}/suggestions/${id}`, { cookie: t.c.owner })).json;
const suggestionFile = async (t, sug) => fs.readFile(path.join(t.root, ...sug.path.split('/')), 'utf8');
const save = (t, who, body, base) => t.call('PUT', `${S}/body`, { cookie: t.c[who], body: { body, base_sha256: base } });

describe('§2.1 conflicts lose no text', () => {
  test('simultaneous edit: the first save wins the file, the other becomes a suggestion by its author, and merging keeps both', async () => {
    const t = await boot();
    const a0 = await loadScene(t, 'editor');
    const b0 = await loadScene(t, 'editor2');
    assert.equal(a0.sha256, b0.sha256);
    const bodyA = a0.body.replace(FERRY, 'The ferry bumped the jetty');
    const bodyB = b0.body.replace(DUNES, 'waist-deep in water');
    const [ra, rb] = await Promise.all([save(t, 'editor', bodyA, a0.sha256), save(t, 'editor2', bodyB, b0.sha256)]);
    const [winner, loser] = ra.status === 200 ? [ra, rb] : [rb, ra];
    assert.equal(winner.status, 200, 'exactly one save wins');
    assert.equal(loser.status, 409, loser.text);
    assert.equal(loser.json.code, 'STALE');
    const winnerIsA = ra.status === 200;
    const sug = await suggestionOf(t, loser.json.suggestion.id);
    assert.deepEqual(sug.by, winnerIsA ? { id: t.users.editor2.id, name: 'Second editor' } : { id: t.users.editor.id, name: 'The editor' }, 'the loser owns the suggestion');
    const disk = await sceneFile(t);
    assert.ok(disk.includes(winnerIsA ? 'The ferry bumped the jetty' : 'waist-deep in water'), "the winner's text is on disk");
    assert.ok((await suggestionFile(t, sug)).includes(winnerIsA ? 'waist-deep in water' : 'The ferry bumped the jetty'), "the loser's text is in the suggestion file");
    // merge: accept the loser's own hunk, decline the one that would undo the winner
    const mine = winnerIsA ? 'waist-deep' : 'bumped';
    const loserKey = winnerIsA ? 'editor2' : 'editor';
    for (const h of sug.hunks) {
      const decision = h.newLines.join('\n').includes(mine) ? 'accept' : 'decline';
      assert.equal((await t.call('POST', `${b}/suggestions/${sug.id}/hunks/${h.id}`, { cookie: t.c[loserKey], body: { decision } })).status, 200);
    }
    const merged = await sceneFile(t);
    assert.ok(merged.includes('The ferry bumped the jetty') && merged.includes('waist-deep in water'), 'both edits survive');
    assert.deepEqual(await errorsOf(t.root), []);
  });

  test('three editors from one base: the first wins, the other two are kept as suggestions with the right `by`, and every text survives', async () => {
    const t = await boot();
    await addUser(t, 'editor3', 'editor', 'Third editor');
    const base = await Promise.all(['editor', 'editor2', 'editor3'].map((w) => loadScene(t, w)));
    assert.equal(new Set(base.map((x) => x.sha256)).size, 1, 'one shared base');
    const A = 'The ferry bumped the jetty';
    const B = 'waist-deep in water';
    const C = 'ZEBRA-C third editor line';
    const bodies = [base[0].body.replace(FERRY, A), base[1].body.replace(DUNES, B), `${base[2].body}\n${C}\n`];
    const ra = await save(t, 'editor', bodies[0], base[0].sha256);
    assert.equal(ra.status, 200, ra.text);
    const afterA = await sceneFile(t);
    const rb = await save(t, 'editor2', bodies[1], base[1].sha256);
    const rc = await save(t, 'editor3', bodies[2], base[2].sha256);
    for (const r of [rb, rc]) {
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.code, 'STALE');
      assert.equal(r.json.kept, true);
      assert.ok(r.json.suggestion?.id);
    }
    assert.equal(await sceneFile(t), afterA, 'the losing saves never touched the file');
    const sb = await suggestionOf(t, rb.json.suggestion.id);
    const sc = await suggestionOf(t, rc.json.suggestion.id);
    assert.deepEqual(sb.by, { id: t.users.editor2.id, name: 'Second editor' });
    assert.deepEqual(sc.by, { id: t.users.editor3.id, name: 'Third editor' });
    for (const s of [sb, sc]) {
      assert.equal(s.source, 'author');
      assert.equal(s.mode, 'suggest');
      assert.equal(s.status, 'pending');
    }
    assert.ok((await suggestionFile(t, sb)).includes(B), "B's text is kept");
    assert.ok((await suggestionFile(t, sc)).includes(C), "C's text is kept");
    assert.ok(afterA.includes(A), "A's text is on disk");
    // B merges its own change (a second suggestion made against the older file is stale once the file moved: its text stays in the suggestion, nothing is lost)
    const fresh = await suggestionOf(t, sb.id);
    for (const h of fresh.hunks) {
      const decision = h.newLines.join(String.fromCharCode(10)).includes('waist-deep') ? 'accept' : 'decline';
      const r = await t.call('POST', `${b}/suggestions/${sb.id}/hunks/${h.id}`, { cookie: t.c.editor2, body: { decision } });
      assert.equal(r.status, 200, `editor2 ${decision} hunk: ${r.text}`);
    }
    const merged = await sceneFile(t);
    assert.ok(merged.includes(A) && merged.includes(B), 'A and B are both in the scene');
    assert.ok((await suggestionFile(t, await suggestionOf(t, sc.id))).includes(C), "C's text is still kept for C to merge");
    assert.deepEqual(await errorsOf(t.root), []);
  });

  test('offline reconnect: a buffer written long ago (before other saves and a fresh sign-in) is kept as a suggestion by its author, even when retried', async () => {
    const t = await boot();
    const old = await loadScene(t, 'editor2');
    const OFFLINE = 'An extra paragraph typed on the train, ZEBRA-OFFLINE.';
    const offlineBody = `${old.body}\n${OFFLINE}\n`;
    // the browser loses its connection and its session expires; meanwhile the other editor saves twice
    assert.equal((await t.call('POST', '/api/auth/logout', { cookie: t.c.editor2, body: {} })).status, 200);
    let cur = old;
    for (const text of ['The ferry bumped the jetty', 'The ferry rammed the jetty']) {
      const body = cur.body.replace(/The ferry \w+ the jetty/, text);
      const r = await save(t, 'editor', body, cur.sha256);
      assert.equal(r.status, 200, r.text);
      cur = { body, sha256: r.json.sha256 };
    }
    const disk = await sceneFile(t);
    const fresh = cookieOf(await t.call('POST', '/api/auth/login', { body: { username: 'editor2-user', password: PW } }), 'sf_session');
    const first = await t.call('PUT', `${S}/body`, { cookie: fresh, body: { body: offlineBody, base_sha256: old.sha256 } });
    assert.equal(first.status, 409, first.text);
    assert.equal(first.json.code, 'STALE');
    assert.equal(await sceneFile(t), disk, 'the file is untouched');
    const sug = await suggestionOf(t, first.json.suggestion.id);
    assert.deepEqual(sug.by, { id: t.users.editor2.id, name: 'Second editor' });
    assert.ok((await suggestionFile(t, sug)).includes(OFFLINE), 'the offline text is kept');
    // the client retries the same buffer after a timeout: still refused, still not lost, still never written over the newer file
    const retry = await t.call('PUT', `${S}/body`, { cookie: fresh, body: { body: offlineBody, base_sha256: old.sha256 } });
    assert.equal(retry.status, 409);
    assert.equal(await sceneFile(t), disk);
    const all = (await t.call('GET', `${b}/suggestions?target=${SCENE}`, { cookie: t.c.owner })).json.suggestions;
    assert.ok(all.length >= 1 && all.every((s) => s.by.id === t.users.editor2.id));
    assert.deepEqual(await errorsOf(t.root), []);
  });
});

/** The shared session used by §2.2, §2.3 and §4: edits, comments and suggestions from several users. `api(method, url, who, body)` answers like t.call. */
async function runSession(api, users) {
  const get = (url, who = 'owner') => api('GET', url, who);
  const scene = (await get(S, 'editor')).json;
  const out = {};
  const com = await api('POST', `${b}/comments`, 'reviewer', { target: SCENE, line: 19, quote: 'Past the dunes', text: COMMENT_TEXT });
  assert.equal(com.status, 201, com.text);
  out.comment = com.json.comment;
  const rep = await api('POST', `${b}/comments/${com.json.comment.id}/replies`, 'editor', { text: 'Reply from the editor.' });
  assert.equal(rep.status, 200, rep.text);
  const ownerCom = await api('POST', `${b}/comments`, 'owner', { target: SCENE, line: 15, text: 'Owner note.' });
  assert.equal(ownerCom.status, 201, ownerCom.text);
  const rs = await api('POST', `${b}/suggestions`, 'reviewer', { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' }, rationale: 'More vivid.' });
  assert.equal(rs.status, 201, rs.text);
  out.reviewerSuggestion = rs.json.id;
  const es = await api('POST', `${b}/suggestions`, 'editor2', { target: SCENE, proposedRange: { ...range(scene.body, FERRY), replacement: 'The ferry bumped the jetty' } });
  assert.equal(es.status, 201, es.text);
  out.editorSuggestion = es.json.id;
  const saved = await api('PUT', `${S}/body`, 'editor', { body: scene.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: scene.sha256 });
  assert.equal(saved.status, 200, saved.text);
  const stale = await api('PUT', `${S}/body`, 'editor2', { body: `${scene.body}\nAn offline line.\n`, base_sha256: scene.sha256 });
  assert.equal(stale.status, 409, stale.text);
  out.staleSuggestion = stale.json.suggestion.id;
  assert.equal((await api('POST', `${b}/receipts/flush`, 'owner', { sceneId: SCENE })).status, 200);
  // an editor (not the owner) accepts the reviewer's suggestion
  const acc = await api('POST', `${b}/suggestions/${rs.json.id}`, 'editor2', { decision: 'accept' });
  assert.equal(acc.status, 200, acc.text);
  assert.equal((await api('POST', `${b}/comments/${com.json.comment.id}`, 'owner', { status: 'resolved' })).status, 200);
  assert.equal((await api('POST', `${b}/receipts/flush`, 'owner', { sceneId: SCENE })).status, 200);
  out.users = users;
  return out;
}

describe('§2.2 attribution: comments, suggestions and receipts carry the right `by` for each role', () => {
  test('each role is recorded as itself; the viewer cannot make anything; accepting a reviewer suggestion gives a receipt naming the accepting editor, linked to the suggestion', async () => {
    const t = await boot();
    const who = (w) => ({ id: t.users[w].id, name: t.users[w].display_name });
    const s = await runSession((m, u, w, body) => t.call(m, u, { cookie: t.c[w], body }), t.users);

    const comments = (await t.call('GET', `${b}/comments`, { cookie: t.c.viewer })).json.comments;
    const bySubject = (needle) => comments.find((c) => c.text?.includes(needle) || c.body?.includes?.(needle) || JSON.stringify(c).includes(needle));
    assert.deepEqual(bySubject(COMMENT_TEXT).by, who('reviewer'));
    assert.deepEqual(bySubject('Owner note.').by, who('owner'));
    assert.equal(bySubject(COMMENT_TEXT).replies[0].name, 'The editor');

    const rs = await suggestionOf(t, s.reviewerSuggestion);
    assert.equal(rs.source, 'reviewer');
    assert.deepEqual(rs.by, who('reviewer'));
    const es = await suggestionOf(t, s.editorSuggestion);
    assert.equal(es.source, 'author');
    assert.deepEqual(es.by, who('editor2'));
    const ss = await suggestionOf(t, s.staleSuggestion);
    assert.deepEqual(ss.by, who('editor2'));
    assert.equal(ss.rationale, 'Saved over a newer version');

    assert.equal((await t.call('POST', `${b}/comments`, { cookie: t.c.viewer, body: { target: SCENE, line: 1, text: 'x' } })).status, 403);

    const rc = (await t.call('GET', `${b}/receipts?scene=${SCENE}`, { cookie: t.c.owner })).json.receipts;
    const accept = rc.find((r) => r.operation === 'suggestion.accept');
    assert.ok(accept, `receipts: ${rc.map((r) => r.operation).join(', ')}`);
    assert.deepEqual(accept.by, who('editor2'), 'the receipt names the editor who accepted, not the reviewer who suggested or the owner');
    assert.deepEqual(rc.find((r) => r.operation === 'author.edit')?.by, who('editor'));
    assert.equal(rc.find((r) => r.operation === 'baseline')?.by, null, 'the system baseline names nobody');
    assert.equal((await t.call('GET', `${b}/receipts/verify`, { cookie: t.c.owner })).json.ok, true);
    assert.deepEqual(await errorsOf(t.root), []);
  });
});

describe('§2.2 (link) the receipt of an accepted suggestion links it', () => {
  test('accepting a suggestion from a reviewer gives a receipt that names the suggestion it came from', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const sug = await t.call('POST', `${b}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' } } });
    assert.equal(sug.status, 201, sug.text);
    assert.equal((await t.call('POST', `${b}/suggestions/${sug.json.id}`, { cookie: t.c.editor2, body: { decision: 'accept' } })).status, 200);
    const rc = (await t.call('GET', `${b}/receipts?scene=${SCENE}`, { cookie: t.c.owner })).json.receipts;
    const accept = rc.find((r) => r.operation === 'suggestion.accept');
    assert.deepEqual(accept.by, { id: t.users.editor2.id, name: 'Second editor' });
    assert.ok(JSON.stringify(accept).includes(sug.json.id), `the receipt names ${sug.json.id}`);
  });
});

/** Every file below `dir` (relative path -> Buffer), provenance/ included (snapshot() leaves it out). */
async function readTree(dir) {
  const out = new Map();
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join('/'), await fs.readFile(full));
    }
  };
  await walk(dir);
  return out;
}
const receiptsVerify = (library, env = {}) => spawnSync(process.execPath, [MAIN, 'receipts', 'verify', '--library', library, '--book', 'salt-orchard'], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

describe('§2.3 backup and restore while shared', () => {
  test('a backup of a book with comments, suggestions and receipts from several users restores to a valid book with a verifying chain and every `by`', async () => {
    const t = await boot();
    await runSession((m, u, w, body) => t.call(m, u, { cookie: t.c[w], body }), t.users);
    const live = await readTree(t.root);
    const liveText = [...live].filter(([k]) => /^(comments|suggestions|provenance)\//.test(k)).map(([, v]) => v.toString('utf8')).join('\n');
    const actors = ['reviewer', 'editor', 'editor2', 'owner'].map((w) => t.users[w].id);
    for (const id of actors) assert.ok(liveText.includes(id), `the live project records ${id}`);
    assert.equal(receiptsVerify(t.root).status, 0, 'the live chain verifies');

    const bk = await t.call('GET', `${b}/backup?provenance=1`, { cookie: t.c.owner });
    assert.equal(bk.status, 200);
    const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-proof-restore-')), 'restored');
    const restored = await restoreBackup(bk.bytes, target);
    assert.deepEqual(await errorsOf(restored.bookRoot), [], 'validate(): 0 errors');
    const verify = receiptsVerify(restored.bookRoot);
    assert.equal(verify.status, 0, `receipts verify on the restore: ${verify.stdout}${verify.stderr}`);
    assert.match(verify.stdout, /chain is intact/);

    const back = await readTree(restored.bookRoot);
    for (const [k, v] of live) {
      if (k.startsWith('.storyforge/')) continue;
      assert.ok(back.has(k), `${k} is in the restore`);
      assert.ok(back.get(k).equals(v), `${k} is byte-identical after the restore`);
    }
    const backText = [...back].filter(([k]) => /^(comments|suggestions|provenance)\//.test(k)).map(([, v]) => v.toString('utf8')).join('\n');
    for (const id of actors) assert.equal(backText.split(id).length, liveText.split(id).length, `every mention of ${id} (by) survives`);
    for (const name of ['The reviewer', 'The editor', 'Second editor', 'Ilse']) assert.ok(backText.includes(name), `${name} survives`);
    assert.ok([...back.keys()].some((k) => k.startsWith('comments/')) && [...back.keys()].some((k) => k.startsWith('suggestions/')) && [...back.keys()].some((k) => k.startsWith('provenance/') && k.endsWith('.md')));
  });
});

// =========================================================================================================================================================
// processes: a real main.mjs, for the properties of the process (socket, config folder, logs, outbound traffic)
// =========================================================================================================================================================

const cliRun = (args, env, timeout = 60000) => spawnSync(process.execPath, [MAIN, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout });

/** A shared-mode server process on a fresh library copy with the owner, an editor, a reviewer, a viewer and a read share; `net` records its outbound calls. */
async function sharedProc({ net = false } = {}) {
  const library = await copyFixture('valid/salt-orchard');
  const home = await makeHome();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-proof-shared-'));
  const init = cliRun(['shared', 'init', '--owner', 'ilse', '--library', library, '--shared-data', dir, '--port', '4999'], home.env);
  assert.equal(init.status, 0, init.stderr);
  const setupToken = /setup#token=([A-Za-z0-9_-]{43})/.exec(init.stdout)[1];
  const app = await startApp({ library, home, net, extraArgs: ['--shared', '--shared-data', dir] });
  const api = (m, u, o) => call(app.port, m, u, o);
  const secrets = [PW, setupToken];
  const c = {};
  const users = {};
  const setup = await api('POST', '/api/auth/setup', { body: { token: setupToken, password: PW } });
  assert.equal(setup.status, 200, setup.text);
  c.owner = cookieOf(setup, 'sf_session');
  users.owner = setup.json.user;
  for (const [key, role, display] of [['editor', 'editor', 'The editor'], ['editor2', 'editor', 'Second editor'], ['reviewer', 'reviewer', 'The reviewer'], ['viewer', 'viewer', 'The viewer']]) {
    const inv = await api('POST', '/api/shared/invites', { cookie: c.owner, body: { role } });
    assert.equal(inv.status, 201, inv.text);
    secrets.push(tokenOf(inv.json.link));
    const acc = await api('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: `${key}-user`, display_name: display, password: PW } });
    assert.equal(acc.status, 200, acc.text);
    c[key] = cookieOf(acc, 'sf_session');
    users[key] = acc.json.user;
  }
  const sh = await api('POST', '/api/shared/shares', { cookie: c.owner, body: { book: BOOK, scope: 'read', expires_days: 30 } });
  secrets.push(tokenOf(sh.json.link));
  c.share = cookieOf(await api('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } }), 'sf_share');
  for (const v of Object.values(c)) secrets.push(v.split('=')[1]);
  return { library, home, dir, app, api, c, users, secrets, call: (m, u, w, body) => api(m, u, { cookie: c[w], body }) };
}

describe('§3.1 personal mode', () => {
  test('listens on loopback only, has no auth or shared routes, asks nobody for an account, and never creates or reads a shared-data folder', async () => {
    const library = await copyFixture('valid/salt-orchard');
    const home = await makeHome();
    // a damaged shared-data folder where shared mode would look for it: personal mode must neither read it (it would exit 2) nor change it
    const poisonDir = path.join(home.configDir, 'shared', path.basename(defaultSharedDir(library)));
    await fs.mkdir(poisonDir, { recursive: true });
    const poison = { 'users.json': '{ this is not json', 'audit.jsonl': 'garbage that is not a chain\n' };
    for (const [f, text] of Object.entries(poison)) await fs.writeFile(path.join(poisonDir, f), text);
    const before = await snapshot(library);
    const app = await startApp({ library, home });
    assert.match(app.output(), /http:\/\/127\.0\.0\.1:\d+\//, 'the ready line names the loopback address');
    assert.ok(!/Shared mode/.test(app.output()));

    // 1. the socket: the listening address is 127.0.0.1, and no other address of this machine answers on that port
    const listening = listeningAddresses(app.child.pid);
    if (listening !== null) {
      const mine = listening.filter((a) => a.endsWith(`:${app.port}`));
      assert.ok(mine.length >= 1, `found the listening socket (${listening.join(' ')})`);
      assert.deepEqual(mine, [`127.0.0.1:${app.port}`], 'bound to loopback only');
    }
    const externals = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
    for (const host of [...externals.slice(0, 4), '::1']) assert.equal(await canConnect(host, app.port), false, `${host}:${app.port} does not answer`);
    assert.equal(await canConnect('127.0.0.1', app.port), true);
    assert.deepEqual((await request(app.port, 'GET', '/api/health', { host: 'evil.example' })).status, 403, 'the loopback Host guard');

    // 2. no auth or shared routes
    for (const p of ['/api/auth/me', '/api/auth/invite?token=x', '/api/shared/members', '/api/shared/settings', '/api/shared/audit']) assert.equal((await call(app.port, 'GET', p)).status, 404, `GET ${p}`);
    for (const [m, p] of [['POST', '/api/auth/login'], ['POST', '/api/auth/setup'], ['POST', '/api/auth/share'], ['POST', '/api/shared/invites'], ['PUT', '/api/shared/settings'], ['DELETE', '/api/shared/members/usr_X']]) {
      assert.equal((await call(app.port, m, p, { body: {} })).status, 405, `${m} ${p}`);
    }

    // 3. nobody is asked for an account: every read and every write route answers without a login, and no cookie is ever set
    const scene = (await call(app.port, 'GET', S)).json;
    assert.equal((await call(app.port, 'PUT', `${S}/body`, { origin: null, body: { body: `${scene.body}\nalone\n`, base_sha256: scene.sha256 } })).status, 200, 'saving needs no login and no Origin');
    for (const urls of Object.values(GET_SAMPLES)) {
      for (const url of urls.filter((u) => !u.startsWith('/api/shared') && !u.startsWith('/api/auth'))) {
        const r = await call(app.port, 'GET', url);
        assert.ok(r.status !== 401 && r.status !== 403, `GET ${url} -> ${r.status}`);
        assert.deepEqual(r.setCookie, []);
      }
    }
    for (const [route, [method, url]] of Object.entries(SAMPLES)) {
      if (route.startsWith('shared-') || route === 'library-open') continue;
      const r = await call(app.port, method, url, { origin: null, body: bodyFor(route) });
      assert.ok(r.status !== 401 && !GATE_CODES.includes(r.json?.code), `${method} ${url} -> ${r.status} ${r.text.slice(0, 100)}`);
      assert.deepEqual(r.setCookie, []);
    }
    await app.stop();

    // 4. the config folder and the library: no shared-data folder was created, the planted one was never read or touched
    const walk = async (d) => (await fs.readdir(d, { withFileTypes: true }).catch(() => [])).flatMap((e) => (e.isDirectory() ? [e.name, ...[]] : [e.name]));
    const top = await walk(home.configDir);
    assert.ok(!top.some((n) => /^(accounts|audit)/.test(n)));
    assert.deepEqual((await fs.readdir(path.join(home.configDir, 'shared'))).sort(), [path.basename(poisonDir)], 'no new shared-data folder');
    assert.deepEqual((await fs.readdir(poisonDir)).sort(), Object.keys(poison).sort(), 'nothing was added to it');
    for (const [f, text] of Object.entries(poison)) assert.equal(await fs.readFile(path.join(poisonDir, f), 'utf8'), text, `${f} untouched`);
    const after = await snapshot(library);
    const added = Object.keys(after).filter((k) => !(k in before) && !k.startsWith('.storyforge'));
    assert.ok(!added.some((k) => /users\.json|sessions\.json|members\.json|invites\.json|shares\.json|audit\.jsonl|accounts/.test(k)), `no accounts or audit files in the library: ${added.join(', ')}`);
  });
});

/** The local addresses a process listens on (`host:port`), or null when this machine has no tool to ask. */
function listeningAddresses(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 20000 });
      if (r.status !== 0) return null;
      return r.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p[0] === 'TCP' && p[3] === 'LISTENING' && Number(p[4]) === pid).map((p) => p[1]);
    }
    const r = spawnSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) return null;
    return r.stdout.split('\n').filter((l) => l.includes(`pid=${pid},`)).map((l) => l.trim().split(/\s+/)[3]);
  } catch {
    return null;
  }
}

/** Does anything accept a TCP connection at host:port? */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(3000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

describe('§3.2 AI in shared mode', () => {
  const ctx = { task: 'chat', files: [ARRIVAL_PATH], instruction: 'Summarise this scene.' };
  const callsOf = async (p, mock) => ({ mock: mock.calls.length, net: (await p.app.netCalls()).length });

  /** A shared server with the net recorder, a loopback mock provider, and the book's active profile set by the owner. */
  async function withProvider(mock) {
    const p = await sharedProc({ net: true });
    const prof = await p.call('POST', '/api/ai/profiles', 'owner', profileBody({ baseUrl: mock.baseUrl }));
    assert.equal(prof.status, 201, prof.text);
    assert.equal((await p.call('PUT', `${b}/ai/profile`, 'owner', { profileId: prof.json.profile.id })).status, 200);
    return p;
  }

  test('with no provider configured a whole shared session (every role, AI routes included) makes zero outbound calls', async () => {
    const p = await sharedProc({ net: true });
    const scene = (await p.call('GET', S, 'editor')).json;
    await p.call('PUT', `${S}/body`, 'editor', { body: `${scene.body}\nmore\n`, base_sha256: scene.sha256 });
    await p.call('POST', `${b}/comments`, 'reviewer', { target: SCENE, line: 19, text: 'hm' });
    for (const u of ['/api/books', b, S, `${b}/receipts`, `${b}/continuity`, '/api/ai/profiles', `${b}/export?format=markdown`, `${b}/backup`]) await p.call('GET', u, 'owner');
    for (const who of ['viewer', 'reviewer', 'editor']) for (const act of ['context', 'send', 'apply', 'discard']) await p.call('POST', `${b}/ai/${act}`, who, ctx);
    assert.equal((await p.api('GET', S, { cookie: p.c.share })).status, 200);
    assert.equal((await p.call('PUT', '/api/shared/settings', 'owner', { ai_for_members: true })).status, 200);
    for (const act of ['context', 'send', 'apply', 'discard']) {
      const r = await p.call('POST', `${b}/ai/${act}`, 'owner', ctx);
      assert.equal(r.status, 409, `owner ${act}: ${r.text}`);
      assert.equal(r.json.code, 'AI_NOT_CONFIGURED');
      const e = await p.call('POST', `${b}/ai/${act}`, 'editor', ctx);
      assert.equal(e.status, 409, `editor ${act} (allowed, but nothing is configured): ${e.text}`);
    }
    assert.deepEqual(await p.app.netCalls(), [], 'zero outbound calls');
  });

  test('with "Allow AI for members" off an editor\'s ai-context and ai-send are refused and nothing is sent', async () => {
    const mock = await startMockProvider({ reply: 'A reply.' });
    try {
      const p = await withProvider(mock);
      assert.equal((await p.call('GET', '/api/shared/settings', 'owner')).json.ai_for_members, false, 'off by default');
      for (const [act, body] of [['context', ctx], ['send', { contextId: 'ctx_nope' }]]) {
        const r = await p.call('POST', `${b}/ai/${act}`, 'editor', body);
        assert.equal(r.status, 403, `${act}: ${r.text}`);
        assert.equal(r.json.code, 'ROLE');
      }
      // the owner previews a real context; the editor still cannot send it
      const prev = await p.call('POST', `${b}/ai/context`, 'owner', ctx);
      assert.equal(prev.status, 200, prev.text);
      assert.equal((await p.call('POST', `${b}/ai/send`, 'editor', { contextId: prev.json.contextId })).status, 403);
      assert.deepEqual(await callsOf(p, mock), { mock: 0, net: 0 }, 'nothing was sent, not even by the owner\'s preview');
    } finally {
      await mock.close();
    }
  });

  test('with it on, nothing is sent before an explicit ai-send for a previewed context, and then exactly the previewed messages are', async () => {
    const mock = await startMockProvider({ reply: 'A reply.' });
    try {
      const p = await withProvider(mock);
      assert.equal((await p.call('PUT', '/api/shared/settings', 'owner', { ai_for_members: true })).status, 200);
      const prev = await p.call('POST', `${b}/ai/context`, 'editor', ctx);
      assert.equal(prev.status, 200, prev.text);
      assert.deepEqual(await callsOf(p, mock), { mock: 0, net: 0 }, 'a preview sends nothing');
      assert.ok(prev.json.messages.length >= 1 && typeof prev.json.contextId === 'string');
      for (const bad of [{}, { contextId: 'ctx_never_previewed' }, { contextId: 12 }, { contextId: prev.json.contextId, messages: [{ role: 'user', content: 'smuggled' }] }].slice(0, 3)) {
        const r = await p.call('POST', `${b}/ai/send`, 'editor', bad);
        assert.ok(r.status >= 400, `send without a previewed context: ${r.status} ${r.text}`);
      }
      assert.deepEqual(await callsOf(p, mock), { mock: 0, net: 0 }, 'a send without a previewed context sends nothing');
      const sent = await p.call('POST', `${b}/ai/send`, 'editor', { contextId: prev.json.contextId });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(mock.calls.length, 1, 'one explicit send, one call');
      assert.deepEqual(mock.calls[0].body.messages, prev.json.messages, 'exactly the previewed messages');
      assert.ok((await p.app.netCalls()).length >= 1, 'the recorder sees the real send (so "zero" elsewhere is meaningful)');
    } finally {
      await mock.close();
    }
  });

  test('with the ai module off nothing is sent, even for the owner or an allowed editor (403 MODULE_OFF)', async () => {
    const mock = await startMockProvider({ reply: 'A reply.' });
    try {
      const p = await withProvider(mock);
      assert.equal((await p.call('PUT', '/api/shared/settings', 'owner', { ai_for_members: true })).status, 200);
      const prev = await p.call('POST', `${b}/ai/context`, 'owner', ctx);
      assert.equal(prev.status, 200, prev.text);
      assert.equal((await p.call('PUT', '/api/profile', 'owner', { modules: { ai: false } })).status, 200);
      for (const who of ['owner', 'editor']) {
        for (const [act, body] of [['context', ctx], ['send', { contextId: prev.json.contextId }]]) {
          const r = await p.call('POST', `${b}/ai/${act}`, who, body);
          assert.equal(r.status, 403, `${who} ${act}: ${r.text}`);
          assert.equal(r.json.code, 'MODULE_OFF');
        }
      }
      assert.deepEqual(await callsOf(p, mock), { mock: 0, net: 0 });
    } finally {
      await mock.close();
    }
  });

  test('a share, a reviewer, a viewer or an anonymous caller can never reach AI, even with AI allowed for members and a valid preview', async () => {
    const mock = await startMockProvider({ reply: 'A reply.' });
    try {
      const p = await withProvider(mock);
      assert.equal((await p.call('PUT', '/api/shared/settings', 'owner', { ai_for_members: true })).status, 200);
      const prev = await p.call('POST', `${b}/ai/context`, 'owner', ctx);
      assert.equal(prev.status, 200, prev.text);
      for (const who of ['reviewer', 'viewer', 'share', 'anonymous']) {
        for (const [act, body] of [['context', ctx], ['send', { contextId: prev.json.contextId }], ['apply', { contextId: prev.json.contextId }], ['discard', { contextId: prev.json.contextId }]]) {
          const r = await p.api('POST', `${b}/ai/${act}`, { cookie: p.c[who], body });
          assert.equal(r.status, who === 'anonymous' ? 401 : 403, `${who} ${act}: ${r.text}`);
        }
        if (who === 'share' || who === 'anonymous') for (const u of [`${b}/ai/status`, '/api/ai/profiles']) assert.ok([401, 403].includes((await p.api('GET', u, { cookie: p.c[who] })).status), `${who} GET ${u}`);
      }
      assert.deepEqual(await callsOf(p, mock), { mock: 0, net: 0 });
    } finally {
      await mock.close();
    }
  });
});

describe('§3.3 nothing leaves in logs', () => {
  test('server stdout and stderr during a shared session hold no password, token or scene text', async () => {
    const p = await sharedProc();
    const scene = (await p.call('GET', S, 'editor')).json;
    const prose = `${scene.body}\n${SECRET_PROSE}\n`;
    await p.call('PUT', `${S}/body`, 'editor', { body: prose, base_sha256: scene.sha256 });
    await p.call('PUT', `${S}/body`, 'editor2', { body: `${scene.body}\nstale ${SECRET_PROSE}\n`, base_sha256: scene.sha256 }); // a 409 and a kept suggestion
    await p.call('POST', `${b}/comments`, 'reviewer', { target: SCENE, line: 19, text: COMMENT_TEXT });
    await p.call('POST', `${b}/suggestions`, 'reviewer', { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' }, rationale: COMMENT_TEXT });
    // failures and refusals, which are what a careless server logs
    await p.api('POST', '/api/auth/login', { body: { username: 'ilse', password: 'a wrong password 123' } });
    await p.api('POST', '/api/auth/login', { body: { username: 'nobody-here', password: 'a wrong password 123' } });
    await p.api('POST', '/api/auth/invite/accept', { body: { token: 'x'.repeat(43), username: 'late-user', display_name: 'L', password: 'a wrong password 123' } });
    await p.call('PUT', `${S}/body`, 'viewer', { body: SECRET_PROSE, base_sha256: scene.sha256 });
    await p.api('PUT', `${S}/body`, { cookie: p.c.share, body: { body: SECRET_PROSE, base_sha256: scene.sha256 } });
    await p.api('PUT', `${S}/body`, { body: { body: SECRET_PROSE, base_sha256: scene.sha256 }, origin: 'http://evil.example', cookie: p.c.owner });
    await p.api('POST', `${b}/comments`, { cookie: p.c.owner, body: '{ not json ' + SECRET_PROSE });
    await p.call('POST', '/api/auth/password', 'viewer', { current: PW, next: 'a second password 99' });
    for (const u of [S, `${b}/export?format=markdown`, `${b}/backup`, `${b}/raw?path=../../${SECRET_PROSE}`]) await p.call('GET', u, 'owner');
    await p.call('POST', `${b}/receipts/flush`, 'owner', { sceneId: SCENE });
    const out = p.app.output();
    assert.match(out, /Shared mode/, 'this is the shared server\'s own output');
    for (const needle of [...p.secrets, 'a wrong password 123', 'a second password 99', SECRET_PROSE, COMMENT_TEXT, FERRY, 'waist-deep', 'Past the dunes']) {
      assert.ok(!out.includes(needle), `the server output holds ${needle.slice(0, 14)}...`);
    }
  });
});

// =========================================================================================================================================================
// 4. The same project from both modes (acceptance)
// =========================================================================================================================================================

describe('§4 the same project from both modes', () => {
  const docxParts = (bytes) => {
    const m = unzip(bytes);
    return new Map([...m].map(([k, v]) => [k, Buffer.from(v)]));
  };
  const sameMaps = (x, y, label) => {
    assert.deepEqual([...x.keys()].sort(), [...y.keys()].sort(), `${label}: same file names`);
    for (const [k, v] of x) assert.ok(Buffer.from(v).equals(Buffer.from(y.get(k))), `${label}: ${k} has the same bytes`);
  };

  test('shared session -> stop -> personal mode: identical Markdown exports, DOCX parts and backups; each restore validates and the canon resolver agrees', async () => {
    const p = await sharedProc();
    await runSession((m, u, w, body) => p.call(m, u, w, body), p.users);

    // -- 3a. from shared mode, as the owner
    const sMd = await p.call('GET', `${b}/export?format=markdown`, 'owner');
    const sDocx = await p.call('GET', `${b}/export?format=docx`, 'owner');
    const sBackup = await p.call('GET', `${b}/backup`, 'owner');
    const sBackupProv = await p.call('GET', `${b}/backup?provenance=1`, 'owner');
    for (const r of [sMd, sDocx, sBackup, sBackupProv]) assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(sMd.text.includes('The ferry bumped the jetty'), 'the export has the edited prose');
    assert.ok(!sMd.text.includes(COMMENT_TEXT), 'and no comment text');
    await p.app.stop();

    // -- 2. personal mode on the same library (HTTP, and the CLI)
    const personalApp = await startApp({ library: p.library, home: p.home });
    const get = (u) => call(personalApp.port, 'GET', u);
    const pMd = await get(`${b}/export?format=markdown`);
    const pDocx = await get(`${b}/export?format=docx`);
    const pBackup = await get(`${b}/backup`);
    const pBackupProv = await get(`${b}/backup?provenance=1`);
    for (const r of [pMd, pDocx, pBackup, pBackupProv]) assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal((await get('/api/auth/me')).status, 404, 'really personal mode');
    await personalApp.stop();

    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-proof-out-'));
    const cli = (args) => {
      const r = cliRun(args, p.home.env);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    };
    cli(['export', '--library', p.library, '--book', 'salt-orchard', '--format', 'markdown', '--out', path.join(out, 'cli.md')]);
    cli(['export', '--library', p.library, '--book', 'salt-orchard', '--format', 'docx', '--out', path.join(out, 'cli.docx')]);
    cli(['backup', '--library', p.library, '--book', 'salt-orchard', '--out', path.join(out, 'cli.zip')]);
    cli(['backup', '--library', p.library, '--book', 'salt-orchard', '--provenance', '--out', path.join(out, 'cli-prov.zip')]);
    const cMd = await fs.readFile(path.join(out, 'cli.md'));
    const cDocx = await fs.readFile(path.join(out, 'cli.docx'));
    const cBackup = await fs.readFile(path.join(out, 'cli.zip'));
    const cBackupProv = await fs.readFile(path.join(out, 'cli-prov.zip'));

    // -- 4. identical outputs
    assert.ok(sMd.bytes.equals(pMd.bytes), 'Markdown: shared (owner) and personal (HTTP) are byte-identical');
    assert.ok(sMd.bytes.equals(cMd), 'Markdown: shared and personal (CLI) are byte-identical');
    sameMaps(docxParts(sDocx.bytes), docxParts(pDocx.bytes), 'DOCX shared vs personal HTTP');
    sameMaps(docxParts(sDocx.bytes), docxParts(cDocx), 'DOCX shared vs personal CLI');
    sameMaps(unzip(sBackup.bytes), unzip(pBackup.bytes), 'backup shared vs personal HTTP');
    sameMaps(unzip(sBackup.bytes), unzip(cBackup), 'backup shared vs personal CLI');
    sameMaps(unzip(sBackupProv.bytes), unzip(pBackupProv.bytes), 'backup with provenance, shared vs personal HTTP');
    sameMaps(unzip(sBackupProv.bytes), unzip(cBackupProv), 'backup with provenance, shared vs personal CLI');
    assert.ok([...unzip(sBackup.bytes).keys()].some((k) => k.includes('/comments/')), 'the backup holds the comments');
    assert.ok([...unzip(sBackupProv.bytes).keys()].some((k) => k.includes('/provenance/')), 'and, when asked, the receipts');

    // -- 5. each restore, validated and resolved independently
    const resolved = [];
    for (const [label, bytes] of [['shared', sBackupProv.bytes], ['personal', cBackupProv]]) {
      const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), `sf-proof-${label}-`)); // the resolver reads a library folder: the restored book sits in it
      const dir = path.join(libraryDir, 'salt-orchard');
      const restored = await restoreBackup(bytes, dir);
      assert.deepEqual(await errorsOf(restored.bookRoot), [], `${label} restore: validate() gives 0 errors`);
      assert.equal(receiptsVerify(restored.bookRoot).status, 0, `${label} restore: receipts verify`);
      const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'canon-check', 'resolve.mjs'), libraryDir], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 });
      assert.equal(run.status, 0, run.stderr);
      const seen = JSON.parse(run.stdout);
      assert.ok(Object.keys(seen.owners).length > 0 && seen.links.length > 0, 'the resolver saw objects and links');
      resolved.push(run.stdout);
    }
    assert.equal(resolved[0], resolved[1], 'canon-check output is identical for both restores');
  });
});
