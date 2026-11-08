// M12 W2: workspace docs over HTTP. Member (app) routes: GET /api/books/:b/workspace/docs[?path=], POST .../workspace/docs[/append|/lock|/archive|/restore], POST .../workspace/setup.
// Plugin v1 routes: the same under /api/v1/books/:b/, reads need 'read', writes 'workspace' at book AI level planner; a plugin can lock but never unlock (403 AUTHOR_ONLY).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { WRITE_CLASSES } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const app = `/api/books/${BOOK}/workspace`;
const v1 = `/api/v1/books/${SLUG}/workspace`;
const isPlanning = (p) => p.startsWith('planning/') || p.startsWith('archive/planning/');
const outside = async (root) => new Map([...(await readAll(root))].filter(([p]) => !isPlanning(p)));

function assertSame(before, after2, label) {
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), `${label}: same file set`);
  for (const [p, b] of before) assert.ok(after2.get(p).equals(b), `${label}: ${p} is byte-identical`);
}

const one = async (t, addr, base = app) => (await t.member('GET', `${base}/docs?path=${encodeURIComponent(addr)}`)).json;

test('member routes: save, read, conflict, append, lock, archive and restore, with the right statuses', async () => {
  const t = await bootPersonal();
  const made = await t.member('POST', `${app}/docs`, { path: 'workspace/style', body: '# Style\n' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.created, true);
  assert.equal(made.json.path, 'workspace/style');
  assert.match(made.json.sha256, /^[0-9a-f]{64}$/);

  const list = await t.member('GET', `${app}/docs`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.docs.map((d) => [d.path, d.workspace, d.chapter, d.locked]), [['workspace/style', 'style', null, false]]);
  assert.equal(list.json.docs[0].sha256, made.json.sha256);
  const doc = await one(t, 'workspace/style');
  assert.deepEqual(Object.keys(doc).sort(), ['body', 'chapter', 'locked', 'path', 'sha256', 'title', 'workspace']);
  assert.equal(doc.body, '# Style\n');
  assert.equal((await t.member('GET', `${app}/docs?path=workspace%2Fnone`)).status, 404);
  assert.equal((await t.member('GET', `${app}/docs?path=..%2Fbook`)).status, 404);

  const upd = await t.member('POST', `${app}/docs`, { path: 'workspace/style', body: '# Style 2\n', base_sha256: doc.sha256 });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.json.created, false);
  assert.equal(typeof upd.json.opId, 'string');
  const stale = await t.member('POST', `${app}/docs`, { path: 'workspace/style', body: 'late', base_sha256: doc.sha256 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
  assert.equal(stale.json.current.sha256, upd.json.sha256);
  assert.equal(stale.json.current.body, '# Style 2\n');
  assert.equal((await t.member('POST', `${app}/docs`, { path: 'workspace/style', body: 'no base' })).status, 409);
  assert.equal((await t.member('POST', `${app}/docs`, { path: 'workspace/BAD', body: 'x' })).status, 400);
  assert.equal((await t.member('POST', `${app}/docs`, { path: 5, body: 'x' })).status, 400);
  assert.equal((await t.member('POST', `${app}/docs`, { body: 'x' })).status, 400);

  const ap = await t.member('POST', `${app}/docs/append`, { path: 'workspace/history', text: 'First.' });
  assert.equal(ap.status, 201, ap.text);
  assert.equal((await t.member('POST', `${app}/docs/append`, { path: 'workspace/history', text: 'Second.' })).status, 200);
  assert.equal((await one(t, 'workspace/history')).body, 'First.\n\nSecond.\n');
  assert.equal((await t.member('POST', `${app}/docs/append`, { path: 'workspace/history' })).status, 400);

  const lock = await t.member('POST', `${app}/docs/lock`, { path: 'workspace/style', locked: true });
  assert.equal(lock.status, 200, lock.text);
  assert.deepEqual(lock.json.changed, ['workspace/style']);
  const cur = await one(t, 'workspace/style');
  assert.equal(cur.locked, true);
  for (const [p, body] of [['docs', { path: 'workspace/style', body: 'x', base_sha256: cur.sha256 }], ['docs/append', { path: 'workspace/style', text: 'x' }], ['docs/archive', { path: 'workspace/style' }]]) {
    const r = await t.member('POST', `${app}/${p}`, body);
    assert.equal(r.status, 409, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'LOCKED', p);
  }
  assert.equal((await t.member('POST', `${app}/docs/lock`, { path: 'workspace/style' })).status, 400, 'locked is required');
  assert.equal((await t.member('POST', `${app}/docs/lock`, { path: 'workspace/style', prefix: 'state/chapter-01', locked: false })).status, 400);
  assert.equal((await t.member('POST', `${app}/docs/lock`, { path: 'workspace/style', locked: false })).status, 200, 'the author can unlock');
  assert.equal((await one(t, 'workspace/style')).locked, false);

  const arc = await t.member('POST', `${app}/docs/archive`, { path: 'workspace/history' });
  assert.equal(arc.status, 200, arc.text);
  assert.equal((await one(t, 'workspace/history')).error, 'not_found');
  assert.deepEqual((await t.member('GET', `${app}/docs`)).json.archived.map((d) => d.path), ['workspace/history']);
  assert.equal((await t.member('POST', `${app}/docs/archive`, { path: 'workspace/history' })).status, 404);
  assert.equal((await t.member('POST', `${app}/docs/restore`, { path: 'workspace/history' })).status, 200);
  assert.equal((await one(t, 'workspace/history')).body, 'First.\n\nSecond.\n');
});

test('member setup: creates the starters once; a second call writes nothing', async () => {
  const t = await bootPersonal();
  const r = await t.member('POST', `${app}/setup`, {});
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.created, ['workspace/book', 'workspace/style', 'state/chapter-00/situation', 'state/chapter-00/characters', 'state/chapter-00/knowledge', 'state/chapter-00/inventory']);
  const before = await readAll(t.root);
  const again = await t.member('POST', `${app}/setup`, {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.created, []);
  assert.equal(again.json.existing.length, 6);
  assertSame(before, await readAll(t.root), 'second setup');
  const dry = await t.member('POST', `${app}/docs`, { path: 'workspace/new', body: 'x', dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assertSame(before, await readAll(t.root), 'dry run');
});

test('module routing and policy: workspace-* routes belong to the workspace module and are write class', async () => {
  const names = ['workspace-doc-save', 'workspace-doc-append', 'workspace-doc-lock', 'workspace-doc-archive', 'workspace-doc-restore', 'workspace-setup'];
  for (const n of names) assert.equal(WRITE_CLASSES[n], 'write', n);
  const m = (verb, p) => matchWriteRoute(verb, `/api/books/${BOOK}/workspace/${p}`)?.route;
  assert.deepEqual(['docs', 'docs/append', 'docs/lock', 'docs/archive', 'docs/restore', 'setup'].map((p) => m('POST', p)), names);
  assert.equal(m('GET', 'docs'), undefined);
  assert.equal(m('PUT', 'docs'), undefined);
  const t = await bootPersonal();
  assert.equal((await t.member('PUT', '/api/profile', { modules: { workspace: false } })).status, 200);
  const before = await readAll(t.root);
  for (const [p, body] of [['docs', { path: 'workspace/book', body: 'x' }], ['docs/append', { path: 'workspace/book', text: 'x' }], ['docs/lock', { path: 'workspace/book', locked: true }], ['setup', {}]]) {
    const r = await t.member('POST', `${app}/${p}`, body);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(r.json.module, 'workspace');
  }
  assertSame(before, await readAll(t.root), 'module off');
});

test('plugin: a token without workspace is refused; read works with read only; the audit route names', async () => {
  const t = await bootPersonal();
  const ro = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const before = await readAll(t.root);
  for (const [p, body] of [['docs', { path: 'workspace/book', body: 'x' }], ['docs/append', { path: 'workspace/book', text: 'x' }], ['docs/lock', { path: 'workspace/book', locked: true }], ['docs/archive', { path: 'workspace/book' }], ['docs/restore', { path: 'workspace/book' }], ['setup', {}]]) {
    const r = await t.plugin(ro, 'POST', `${v1}/${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'PLUGIN_SCOPE');
    assert.match(r.json.message, /workspace/);
  }
  assertSame(before, await readAll(t.root), 'refused writes');
  await t.member('POST', `${app}/docs`, { path: 'workspace/book', body: 'Read me.\n' });
  const list = await t.plugin(ro, 'GET', `${v1}/docs`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.docs[0].path, 'workspace/book');
  const doc = await t.plugin(ro, 'GET', `${v1}/docs?path=workspace%2Fbook`);
  assert.equal(doc.json.body, 'Read me.\n');
  assert.match(doc.json.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await t.plugin(ro, 'GET', `${v1}/docs?path=workspace%2Fnone`)).status, 404);
  const b = `/api/v1/books/${SLUG}`;
  assert.equal(v1RouteOf('GET', `${b}/workspace/docs`), 'workspace-docs');
  assert.equal(v1RouteOf('POST', `${b}/workspace/docs`), 'workspace-doc-save');
  assert.equal(v1RouteOf('POST', `${b}/workspace/docs/lock`), 'workspace-doc-lock');
  assert.equal(v1RouteOf('POST', `${b}/workspace/docs/append`), 'workspace-doc-append');
  assert.equal(v1RouteOf('POST', `${b}/workspace/setup`), 'workspace-setup');
});

test('plugin with workspace: setup, save, append, lock; unlock is 403 AUTHOR_ONLY; only planning/ files change', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'writer', permissions: ['read', 'workspace'] })).token;
  const outsideBefore = await outside(t.root);
  const setup = await t.plugin(rw, 'POST', `${v1}/setup`, { body: {} });
  assert.equal(setup.status, 201, setup.text);
  assert.equal(setup.json.created.length, 6);
  const doc = (await t.plugin(rw, 'GET', `${v1}/docs?path=state%2Fchapter-00%2Fknowledge`)).json;
  assert.equal(doc.chapter, 0);
  const save = await t.plugin(rw, 'POST', `${v1}/docs`, { body: { path: 'state/chapter-00/knowledge', body: 'Mara knows nothing.\n', base_sha256: doc.sha256 } });
  assert.equal(save.status, 200, save.text);
  const stale = await t.plugin(rw, 'POST', `${v1}/docs`, { body: { path: 'state/chapter-00/knowledge', body: 'x', base_sha256: doc.sha256 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current.sha256, save.json.sha256);
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/append`, { body: { path: 'workspace/history', text: 'Entry.' } })).status, 201);
  const lock = await t.plugin(rw, 'POST', `${v1}/docs/lock`, { body: { prefix: 'state/chapter-00', locked: true } });
  assert.equal(lock.status, 200, lock.text);
  assert.equal(lock.json.changed.length, 4);

  const afterLock = await readAll(t.root);
  for (const body of [{ prefix: 'state/chapter-00', locked: false }, { path: 'state/chapter-00/knowledge', locked: false }]) {
    const r = await t.plugin(rw, 'POST', `${v1}/docs/lock`, { body });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'AUTHOR_ONLY');
  }
  assertSame(afterLock, await readAll(t.root), 'refused unlock');
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs`, { body: { path: 'state/chapter-00/knowledge', body: 'x', base_sha256: save.json.sha256 } })).json.code, 'LOCKED');
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/archive`, { body: { path: 'state/chapter-00/knowledge' } })).status, 409);
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/lock`, { body: { path: 'workspace/book' } })).status, 400, 'locked is required');

  assertSame(outsideBefore, await outside(t.root), 'nothing outside planning/ changed');
  // the author can unlock
  assert.equal((await t.member('POST', `${app}/docs/lock`, { prefix: 'state/chapter-00', locked: false })).status, 200);
  // a plugin may archive and restore an unlocked doc
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/archive`, { body: { path: 'workspace/history' } })).status, 200);
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/restore`, { body: { path: 'workspace/history' } })).status, 200);
  assertSame(outsideBefore, await outside(t.root), 'nothing outside planning/ changed');
});

test('plugin: book AI level advisor is 403 AI_LEVEL for workspace writes (reads still work); module off is MODULE_OFF', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'writer', permissions: ['read', 'workspace'] })).token;
  await t.member('POST', `${app}/docs`, { path: 'workspace/book', body: 'Hi.\n' });
  assert.equal((await t.member('PUT', '/api/profile', { ai: { level: 'advisor' } })).status, 200);
  const before = await readAll(t.root);
  for (const [p, body] of [['docs', { path: 'workspace/book', body: 'x' }], ['docs/append', { path: 'workspace/book', text: 'x' }], ['docs/lock', { path: 'workspace/book', locked: true }], ['setup', {}]]) {
    const r = await t.plugin(rw, 'POST', `${v1}/${p}`, { body });
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'AI_LEVEL', p);
  }
  assert.equal((await t.plugin(rw, 'GET', `${v1}/docs`)).status, 200, 'reads need no level');
  assertSame(before, await readAll(t.root), 'advisor');
  assert.equal((await t.member('PUT', '/api/profile', { ai: null, modules: { workspace: false } })).status, 200);
  for (const [method, p, body] of [['GET', 'docs'], ['GET', 'docs?path=workspace%2Fbook'], ['POST', 'docs', { path: 'workspace/book', body: 'x' }], ['POST', 'setup', {}]]) {
    const r = await t.plugin(rw, method, `${v1}/${p}`, { body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF');
    assert.equal(r.json.module, 'workspace');
  }
  assertSame(before, await readAll(t.root), 'module off');
  assert.equal((await t.member('PUT', '/api/profile', { modules: null })).status, 200);
  assert.equal((await t.plugin(rw, 'POST', `${v1}/docs/append`, { body: { path: 'workspace/book', text: 'Back on.' } })).status, 200);
});

let nextId = 1;
/** tools/call over POST /mcp as a plugin: the JSON-RPC result (isError tells a refusal). */
async function mcp(t, token, name, args) {
  const r = await t.plugin(token, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: { book: SLUG, ...args } } } });
  assert.equal(r.status, 200, r.text);
  return r.json.result;
}

test('MCP client with read + workspace at level planner sets up, reads, saves, appends and locks, cannot unlock; at advisor every write is refused', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ plugin: 'agent', permissions: ['read', 'workspace'] });
  const outsideBefore = await outside(t.root);
  const setup = await mcp(t, token, 'codex_setup_workspace', {});
  assert.ok(!setup.isError, JSON.stringify(setup));
  assert.equal(setup.structuredContent.created.length, 6);
  const list = await mcp(t, token, 'codex_list_docs', {});
  assert.equal(list.structuredContent.docs.length, 6);
  const got = await mcp(t, token, 'codex_get_doc', { path: 'workspace/style' });
  assert.match(got.structuredContent.body, /^# Style guide/);
  const saved = await mcp(t, token, 'codex_save_doc', { path: 'workspace/style', body: '# Style guide\n\nPlain words.\n', base_sha256: got.structuredContent.sha256 });
  assert.ok(!saved.isError, JSON.stringify(saved));
  const stale = await mcp(t, token, 'codex_save_doc', { path: 'workspace/style', body: 'x', base_sha256: got.structuredContent.sha256 });
  assert.equal(stale.isError, true, 'a stale sha is refused');
  assert.ok(!(await mcp(t, token, 'codex_append_doc', { path: 'workspace/history', text: 'Day 1.' })).isError);
  const locked = await mcp(t, token, 'codex_lock_docs', { prefix: 'state/chapter-00' });
  assert.ok(!locked.isError, JSON.stringify(locked));
  assert.equal(locked.structuredContent.changed.length, 4);
  const sit = await mcp(t, token, 'codex_get_doc', { path: 'state/chapter-00/situation' });
  assert.equal(sit.structuredContent.locked, true);
  const refused = await mcp(t, token, 'codex_save_doc', { path: 'state/chapter-00/situation', body: 'x', base_sha256: sit.structuredContent.sha256 });
  assert.equal(refused.isError, true);
  assert.match(refused.content.map((c) => c.text).join('\n'), /LOCKED/);
  assertSame(outsideBefore, await outside(t.root), 'nothing outside planning/ changed');

  assert.equal((await t.member('PUT', '/api/profile', { ai: { level: 'advisor' } })).status, 200);
  const before = await readAll(t.root);
  for (const [name, args] of [['codex_save_doc', { path: 'workspace/book', body: 'x' }], ['codex_append_doc', { path: 'workspace/book', text: 'x' }], ['codex_lock_docs', { path: 'workspace/book' }], ['codex_setup_workspace', {}]]) {
    const r = await mcp(t, token, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content.map((c) => c.text).join('\n'), /AI_LEVEL|AI level/, name);
  }
  assert.ok(!(await mcp(t, token, 'codex_list_docs', {})).isError, 'reads still work at advisor');
  assertSame(before, await readAll(t.root), 'advisor');
});
