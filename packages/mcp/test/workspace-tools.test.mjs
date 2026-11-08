// M12 W2: the workspace doc tools (codex_list_docs, codex_get_doc need 'read'; codex_save_doc, codex_append_doc, codex_lock_docs, codex_setup_workspace need 'workspace'), against a fake `call`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, NOT_OFFERED, TOOLS } from '../src/index.mjs';

const SHA = 'a'.repeat(64);
const BOOK = '/api/v1/books/salt-orchard';
const DOCS = `${BOOK}/workspace/docs`;

function setup(permissions) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    if (req.method === 'GET' && req.path === DOCS && req.query?.path === undefined) return { status: 200, body: { docs: [{ path: 'workspace/book', title: 'Book', workspace: 'book', chapter: null, locked: false, sha256: SHA }], archived: [] } };
    if (req.method === 'GET') return { status: 200, body: { path: 'workspace/book', title: 'Book', workspace: 'book', chapter: null, locked: false, sha256: SHA, body: '# Book\n' } };
    return { status: 200, body: { ok: true, opId: 'op_1' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

const READS = ['codex_list_docs', 'codex_get_doc'];
const WRITES = ['codex_save_doc', 'codex_append_doc', 'codex_lock_docs', 'codex_setup_workspace'];

test('workspace tools: reads need read, writes need workspace; no unlock tool; the old names are no longer NOT_OFFERED', async () => {
  for (const n of READS) assert.equal(TOOLS.find((t) => t.name === n)?.need, 'read', n);
  for (const n of WRITES) assert.equal(TOOLS.find((t) => t.name === n)?.need, 'workspace', n);
  for (const n of [...READS, ...WRITES]) assert.equal(NOT_OFFERED.includes(n), false, `${n} is offered now`);
  assert.equal(TOOLS.some((t) => /unlock/.test(t.name)), false);
  const listed = async (p) => (await setup(p).rpc('tools/list')).result.tools.map((t) => t.name);
  const ro = await listed(['read']);
  for (const n of READS) assert.ok(ro.includes(n), n);
  for (const n of WRITES) assert.equal(ro.includes(n), false, `${n} hidden without workspace`);
  const both = await listed(['read', 'workspace']);
  for (const n of [...READS, ...WRITES]) assert.ok(both.includes(n), n);
  assert.equal(both.length, 27 + WRITES.length);
  const t = (await setup(['read', 'workspace']).rpc('tools/list')).result.tools.find((x) => x.name === 'codex_save_doc');
  assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.match(t.description, /sha256/);
  assert.match(t.description, /LOCKED/);
  assert.match(t.description, /not prose/);
  assert.match(t.description, /state\/chapter-NN/);
  const refused = await setup(['read']).tool('codex_save_doc', { path: 'workspace/book', body: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /workspace/);
});

test('workspace read tools call the v1 routes and split the body from the head', async () => {
  const { calls, tool } = setup(['read']);
  const list = await tool('codex_list_docs', {});
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', DOCS]]);
  assert.equal(list.structuredContent.docs[0].path, 'workspace/book');
  calls.length = 0;
  const doc = await tool('codex_get_doc', { path: 'state/chapter-04/knowledge' });
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.query]), [['GET', DOCS, { path: 'state/chapter-04/knowledge' }]]);
  assert.equal(doc.structuredContent.sha256, SHA);
  assert.equal(doc.content[1].text, '# Book\n');
  assert.ok(!doc.content[0].text.includes('# Book'), 'the head has no body');
});

test('workspace write tools post to the right v1 path with the right body', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const cases = [
    ['codex_save_doc', { path: 'workspace/style', body: 'B', title: 'T', base_sha256: SHA }, `${DOCS}`, { path: 'workspace/style', body: 'B', title: 'T', base_sha256: SHA }],
    ['codex_save_doc', { path: 'workspace/style', body: 'B' }, `${DOCS}`, { path: 'workspace/style', body: 'B' }],
    ['codex_append_doc', { path: 'workspace/history', text: 'More.' }, `${DOCS}/append`, { path: 'workspace/history', text: 'More.' }],
    ['codex_lock_docs', { path: 'workspace/book' }, `${DOCS}/lock`, { path: 'workspace/book', locked: true }],
    ['codex_lock_docs', { prefix: 'state/chapter-04' }, `${DOCS}/lock`, { prefix: 'state/chapter-04', locked: true }],
    ['codex_setup_workspace', {}, `${BOOK}/workspace/setup`, {}],
  ];
  for (const [name, args, path, body] of cases) {
    calls.length = 0;
    const r = await tool(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', path, body]], name);
    assert.equal(r.structuredContent.opId, 'op_1');
    assert.match(r.structuredContent.note, /Undo/);
  }
});

test('workspace tools reject bad input before any request; codex_lock_docs cannot unlock', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  assert.equal((await tool('codex_save_doc', { path: 'workspace/book' })).isError, true, 'body required');
  assert.equal((await tool('codex_save_doc', { path: 'workspace/book', body: 'x', base_sha256: 'short' })).isError, true, 'sha length');
  assert.equal((await tool('codex_append_doc', { path: 'workspace/book', text: '' })).isError, true, 'text not empty');
  assert.equal((await tool('codex_lock_docs', {})).isError, true, 'path or prefix');
  assert.equal((await tool('codex_lock_docs', { path: 'a', prefix: 'b' })).isError, true, 'not both');
  assert.equal((await tool('codex_lock_docs', { path: 'workspace/book', locked: false })).isError, true, 'no locked argument');
  assert.equal((await tool('codex_get_doc', {})).isError, true, 'path required');
  assert.equal(calls.length, 0);
});
