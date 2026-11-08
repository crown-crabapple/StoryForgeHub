// M12 W6: the co-writer tools (codex_create_chapter, codex_create_scene, codex_save_draft need 'draft'; codex_get_context needs only 'read'). Against a fake `call`: each tool maps onto
// the right /api/v1 path and body, hidden without the permission, and the descriptions say new scenes are AI drafts and author scenes change only through codex_propose_edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, NOT_OFFERED, TOOLS } from '../src/index.mjs';

const SHA = 'b'.repeat(64);
const BOOK = '/api/v1/books/salt-orchard';
const DRAFTS = ['codex_create_chapter', 'codex_create_scene', 'codex_save_draft'];

function setup(permissions) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    if (req.method === 'GET') return { status: 200, body: { chapter: 3, budget: 24000, truncated: [] } };
    if (req.method === 'PUT') return { status: 200, body: { sha256: SHA, words: { added: 4, removed: 1 } } };
    if (req.path.endsWith('/chapters')) return { status: 201, body: { ok: true, chapter: 4, act: 1, sceneId: 'scene_X', opId: 'op_1', changes: [{ to: 'x' }] } };
    return { status: 201, body: { id: 'scene_NEW', path: 'manuscript/x.md' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

test('draft tools need draft, the context tool only read; codex_create_chapter is no longer NOT_OFFERED', async () => {
  for (const n of DRAFTS) assert.equal(TOOLS.find((t) => t.name === n)?.need, 'draft', n);
  assert.equal(TOOLS.find((t) => t.name === 'codex_get_context')?.need, 'read');
  assert.equal(NOT_OFFERED.includes('codex_create_chapter'), false);
  const names = async (p) => (await setup(p).rpc('tools/list')).result.tools.map((t) => t.name);
  const ro = await names(['read']);
  assert.ok(ro.includes('codex_get_context'));
  for (const n of DRAFTS) assert.equal(ro.includes(n), false, `${n} hidden without draft`);
  const rd = await names(['read', 'draft']);
  for (const n of DRAFTS) assert.ok(rd.includes(n), n);
  assert.equal(rd.length, ro.length + 3);
  const tools = (await setup(['read', 'draft']).rpc('tools/list')).result.tools;
  for (const n of DRAFTS) assert.deepEqual(tools.find((t) => t.name === n).annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, n);
  assert.equal(tools.find((t) => t.name === 'codex_get_context').annotations.readOnlyHint, true);
  for (const n of DRAFTS.slice(0, 2)) assert.match(tools.find((t) => t.name === n).description, /drafts marked as AI/, n);
  for (const n of DRAFTS.slice(0, 2)) assert.match(tools.find((t) => t.name === n).description, /codex_propose_edit/, n);
  assert.match(tools.find((t) => t.name === 'codex_save_draft').description, /NOT_AI_DRAFT/);
  const refused = await setup(['read']).tool('codex_create_scene', { chapter: 1, title: 'T', body: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /draft/);
});

test('codex_get_context reads the context route with chapter and budget', async () => {
  const { calls, tool } = setup(['read']);
  const r = await tool('codex_get_context', { chapter: 3 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls[0], { method: 'GET', path: `${BOOK}/context`, query: { chapter: '3' } });
  await tool('codex_get_context', { chapter: 0, budget: 5000 });
  assert.deepEqual(calls[1].query, { chapter: '0', budget: '5000' });
  assert.equal((await tool('codex_get_context', {})).isError, true, 'chapter is required');
  assert.equal((await tool('codex_get_context', { chapter: 1, budget: 10 })).isError, true, 'budget has a minimum');
  assert.equal(calls.length, 2, 'bad input made no request');
});

test('the draft tools post and put to the right v1 paths with only the allowed fields', async () => {
  const { calls, tool } = setup(['read', 'draft']);
  const ch = await tool('codex_create_chapter', { title: 'The Ferry', after: 3 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `${BOOK}/chapters`);
  assert.deepEqual(calls[0].body, { title: 'The Ferry', after: 3 });
  assert.equal(ch.structuredContent.chapter, 4);
  assert.equal(ch.structuredContent.scene, 'scene_X');

  const sc = await tool('codex_create_scene', { chapter: 4, title: 'Crossing', body: 'The water was black.', summary: 'They cross.', after: null });
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].path, `${BOOK}/scenes`);
  assert.deepEqual(calls[1].body, { chapter: 4, title: 'Crossing', body: 'The water was black.', summary: 'They cross.', after: null });
  assert.equal(sc.structuredContent.id, 'scene_NEW');
  assert.match(sc.structuredContent.note, /drafts marked as AI/);

  await tool('codex_create_scene', { chapter: 4, title: 'Landing', body: 'Mud.' });
  assert.deepEqual(calls[2].body, { chapter: 4, title: 'Landing', body: 'Mud.' }, 'after left out stays out (the server appends)');

  const save = await tool('codex_save_draft', { scene: 'scene_NEW', body: 'Better prose.', base_sha256: SHA });
  assert.equal(calls[3].method, 'PUT');
  assert.equal(calls[3].path, `${BOOK}/scenes/scene_NEW/draft`);
  assert.deepEqual(calls[3].body, { body: 'Better prose.', base_sha256: SHA });
  assert.equal(save.structuredContent.sha256, SHA);
});

test('the draft tools refuse bad input before any request', async () => {
  const { calls, tool } = setup(['read', 'draft']);
  assert.equal((await tool('codex_create_scene', { chapter: 1, title: 'T' })).isError, true, 'body is required');
  assert.equal((await tool('codex_create_scene', { chapter: -1, title: 'T', body: 'x' })).isError, true);
  assert.equal((await tool('codex_save_draft', { scene: 'scene_1', body: 'x' })).isError, true, 'base_sha256 is required');
  assert.equal((await tool('codex_save_draft', { scene: 'scene_1', body: 'x', base_sha256: 'short' })).isError, true);
  assert.equal((await tool('codex_create_chapter', {})).isError, true, 'title is required');
  assert.equal(calls.length, 0);
});
