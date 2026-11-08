// M12 W4: continuity over the plugin API v1 and the app's own routes.
//   GET  /api/v1/books/:b/continuity[?chapter=N&cast=<entry>:<role>,...]      need read, any AI level
//   POST /api/v1/books/:b/continuity/exceptions { fingerprint, reason }       need workspace, level planner (dismiss)
//   POST /api/v1/books/:b/continuity/exceptions/:slug/archive                 need workspace, level planner (restore)
//   GET|POST /api/books/:b/continuity/settings                                 the author only (there is no plugin route)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { decidePlugin } from '../src/plugin-policy.mjs';
import { setBookPreferences } from './custom-helpers.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const base = `/api/v1/books/${BOOK}`;
const FP = 'cf1-e85d78f4354c4ffc';

test('the policy: the check needs read at any level; dismiss and restore need workspace at planner; the settings have no plugin route', () => {
  const grant = (permissions) => ({ id: 'g1', plugin: 'p', permissions, books: 'all' });
  const slugOf = (x) => (x === BOOK || x === SLUG ? SLUG : null);
  const decide = (permissions, method, p) => decidePlugin(grant(permissions), method, `${base}${p}`, slugOf);
  const get = decide(['read'], 'GET', '/continuity');
  assert.deepEqual([get.ok, get.need, get.level], [true, 'read', 'off']);
  for (const p of ['/continuity/exceptions', '/continuity/exceptions/some-slug/archive']) {
    const ok = decide(['read', 'workspace'], 'POST', p);
    assert.deepEqual([ok.ok, ok.need, ok.level], [true, 'workspace', 'planner'], p);
    const refused = decide(['read', 'plan', 'canvas', 'propose'], 'POST', p);
    assert.equal(refused.ok, false, p);
    assert.match(refused.body.message, /"workspace"/, p);
  }
  for (const [method, p] of [['POST', '/continuity/settings'], ['GET', '/continuity/settings'], ['PUT', '/continuity/settings'], ['DELETE', '/continuity/exceptions/x'], ['POST', '/continuity']]) {
    const d = decide(['read', 'plan', 'canvas', 'propose', 'workspace', 'draft'], method, p);
    assert.equal(d.ok, false, `${method} ${p}`);
    assert.equal(d.body.code, 'PLUGIN_SCOPE');
  }
  assert.equal(v1RouteOf('GET', `${base}/continuity`), 'continuity');
  assert.equal(v1RouteOf('POST', `${base}/continuity/exceptions`), 'continuity-dismiss');
  assert.equal(v1RouteOf('POST', `${base}/continuity/exceptions/x/archive`), 'continuity-restore');
});

test('a plugin checks, dismisses and restores a finding at planner level; the check hides the dismissed finding and the app sees the exception', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'checker', permissions: ['read', 'workspace'] })).token;

  const first = await t.plugin(rw, 'GET', `${base}/continuity`);
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.findings.some((f) => f.fingerprint === FP));
  assert.ok(Array.isArray(first.json.suppressed) && Array.isArray(first.json.stale_exceptions));
  assert.equal(first.json.settings.overdue_chapters, 12);

  // a reason is required; a made-up fingerprint is refused
  assert.equal((await t.plugin(rw, 'POST', `${base}/continuity/exceptions`, { body: { fingerprint: FP } })).status, 400);
  assert.equal((await t.plugin(rw, 'POST', `${base}/continuity/exceptions`, { body: { fingerprint: 'cf1-0000000000000000', reason: 'x' } })).status, 404);

  const dismissed = await t.plugin(rw, 'POST', `${base}/continuity/exceptions`, { body: { fingerprint: FP, reason: 'The glass shows her eyes green; it is on purpose.' } });
  assert.equal(dismissed.status, 201, dismissed.text);
  const slug = dismissed.json.slug;
  const hidden = (await t.plugin(rw, 'GET', `${base}/continuity`)).json;
  assert.equal(hidden.findings.some((f) => f.fingerprint === FP), false);
  assert.deepEqual(hidden.suppressed.map((s) => [s.finding.fingerprint, s.exception.slug]), [[FP, slug]]);
  const file = await fs.readFile(path.join(t.root, 'planning', 'continuity', `${slug}.md`), 'utf8');
  assert.match(file, /The glass shows her eyes green/);
  assert.equal((await t.plugin(rw, 'POST', `${base}/continuity/exceptions`, { body: { fingerprint: FP, reason: 'again' } })).status, 409);

  const restored = await t.plugin(rw, 'POST', `${base}/continuity/exceptions/${slug}/archive`, { body: {} });
  assert.equal(restored.status, 200, restored.text);
  const back = (await t.plugin(rw, 'GET', `${base}/continuity`)).json;
  assert.ok(back.findings.some((f) => f.fingerprint === FP));
  assert.equal(back.suppressed.length, 0);
  assert.equal((await t.plugin(rw, 'POST', `${base}/continuity/exceptions/no-such-slug/archive`, { body: {} })).status, 404);
});

test('a read-only token checks but cannot dismiss or restore (403 PLUGIN_SCOPE); bad chapter and cast are 400', async () => {
  const t = await bootPersonal();
  const ro = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const before = await readAll(t.root);
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity`)).status, 200);
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity?chapter=1`)).status, 200);
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity?chapter=zz`)).status, 400);
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity?cast=pell:appears`)).status, 400, 'cast needs a chapter');
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity?chapter=1&cast=pell:king`)).status, 400);
  assert.equal((await t.plugin(ro, 'GET', `${base}/continuity?chapter=1&cast=pell:appears,maren-hollis:pov`)).status, 200);
  for (const [p, body] of [['/continuity/exceptions', { fingerprint: FP, reason: 'x' }], ['/continuity/exceptions/x/archive', {}]]) {
    const r = await t.plugin(ro, 'POST', `${base}${p}`, { body });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
  }
  assert.deepEqual(await readAll(t.root), before);
});

test('the book AI level: advisor may check but dismiss and restore are 403 AI_LEVEL; nothing is written', async () => {
  const t = await bootPersonal();
  await setBookPreferences(t.root, '  ai:\n    level: advisor\n');
  const rw = (await t.grant({ plugin: 'level-test', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);
  assert.equal((await t.plugin(rw, 'GET', `${base}/continuity`)).status, 200);
  for (const [p, body] of [['/continuity/exceptions', { fingerprint: FP, reason: 'x' }], ['/continuity/exceptions/x/archive', {}]]) {
    const r = await t.plugin(rw, 'POST', `${base}${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'AI_LEVEL', p);
    assert.equal(r.json.level, 'advisor');
    assert.equal(r.json.needs, 'planner');
  }
  assert.deepEqual(await readAll(t.root), before);
});

test('the continuity module off: the plugin check and dismiss are refused by the module gate', async () => {
  const t = await bootPersonal();
  await setBookPreferences(t.root, '  modules:\n    continuity: false\n');
  const rw = (await t.grant({ plugin: 'gate', permissions: ['read', 'workspace'] })).token;
  const before = await readAll(t.root);
  const get = await t.plugin(rw, 'GET', `${base}/continuity`);
  assert.equal(get.status, 403, get.text);
  assert.equal(get.json.code, 'MODULE_OFF');
  const post = await t.plugin(rw, 'POST', `${base}/continuity/exceptions`, { body: { fingerprint: FP, reason: 'x' } });
  assert.equal(post.status, 403, post.text);
  assert.deepEqual(await readAll(t.root), before);
});

test('the author reads and saves the settings; a plugin cannot; the check follows them (severity, off, overdue)', async () => {
  const t = await bootPersonal();
  const rich = (await t.grant({ plugin: 'rich', permissions: ['read', 'propose', 'canvas', 'plan', 'workspace', 'draft'] })).token;
  const got = await t.member('GET', `/api/books/${BOOK}/continuity/settings`);
  assert.equal(got.status, 200, got.text);
  assert.deepEqual([got.json.exists, got.json.overdue_chapters, got.json.severity], [false, 12, {}]);

  for (const method of ['GET', 'POST', 'PUT']) {
    const r = await t.plugin(rich, method, `${base}/continuity/settings`, method === 'GET' ? {} : { body: { overdue_chapters: 3 } });
    assert.equal(r.status, 403, method);
  }
  assert.equal((await t.member('GET', `/api/books/${BOOK}/continuity/settings`)).json.exists, false);

  // bad input is refused and writes nothing
  const before = await readAll(t.root);
  for (const body of [{ overdue_chapters: 0 }, { overdue_chapters: 1.5 }, { severity: { CS1: 'loud' } }, { severity: { nonsense: 'off' } }, { severity: [] }]) {
    const r = await t.member('POST', `/api/books/${BOOK}/continuity/settings`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await readAll(t.root), before);

  const dry = await t.member('POST', `/api/books/${BOOK}/continuity/settings`, { overdue_chapters: 5, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(await readAll(t.root), before);

  const saved = await t.member('POST', `/api/books/${BOOK}/continuity/settings`, { overdue_chapters: 5, severity: { CF1: 'info' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.file, 'planning/continuity/settings.md');
  const text = await fs.readFile(path.join(t.root, 'planning', 'continuity', 'settings.md'), 'utf8');
  assert.match(text, /^---\nschema: storyforge\.continuity-settings\/v1\nid: note_[0-9A-Z]{26}\noverdue_chapters: 5\nseverity:\n {2}CF1: info\n---\n/);
  const again = (await t.member('GET', `/api/books/${BOOK}/continuity/settings`)).json;
  assert.deepEqual([again.exists, again.overdue_chapters, again.severity], [true, 5, { CF1: 'info' }]);
  const check = (await t.plugin(rich, 'GET', `${base}/continuity`)).json;
  assert.equal(check.findings.find((f) => f.fingerprint === FP).severity, 'info');
  assert.equal(check.settings.overdue_chapters, 5);

  // saving again keeps the id; 'off' removes the rule from the check without making its exceptions stale
  const id = /^id: (.+)$/m.exec(text)[1];
  const off = await t.member('POST', `/api/books/${BOOK}/continuity/settings`, { severity: { CF1: 'off' } });
  assert.equal(off.status, 200, off.text);
  const text2 = await fs.readFile(path.join(t.root, 'planning', 'continuity', 'settings.md'), 'utf8');
  assert.equal(/^id: (.+)$/m.exec(text2)[1], id);
  assert.equal((await t.plugin(rich, 'GET', `${base}/continuity`)).json.findings.some((f) => f.rule === 'CF1'), false);
  // the settings file is a valid book file (no new validation errors)
  const diag = (await t.member('GET', `/api/books/${BOOK}/diagnostics`)).json;
  assert.equal([...(Array.isArray(diag) ? diag : diag.diagnostics ?? [])].filter((d) => d.severity === 'error' && String(d.file).includes('settings.md')).length, 0);
});

test('the app check route takes ?chapter and ?cast, and refuses a bad one', async () => {
  const t = await bootPersonal();
  const ok = await t.member('GET', `/api/books/${BOOK}/continuity?chapter=1`);
  assert.equal(ok.status, 200, ok.text);
  const none = await t.member('GET', `/api/books/${BOOK}/continuity?chapter=99`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.json.findings, []);
  assert.equal((await t.member('GET', `/api/books/${BOOK}/continuity?chapter=1&cast=pell:appears`)).status, 200);
  assert.equal((await t.member('GET', `/api/books/${BOOK}/continuity?cast=pell:appears`)).status, 400);
  assert.equal((await t.member('GET', `/api/books/${BOOK}/continuity?chapter=-1`)).status, 400);
});
