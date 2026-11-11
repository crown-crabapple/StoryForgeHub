// The two repoint tools: codex_update_event (an event's scenes) and codex_set_first_appearance (an entry's first appearance). Both need 'workspace'.
// Against a fake `call`: each maps onto the right /api/v1 path and body, bad input is refused before any request.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, TOOLS } from '../src/index.mjs';

const SHA = 'a'.repeat(64);
const BOOK = '/api/v1/books/salt-orchard';
const NAMES = ['codex_update_event', 'codex_set_first_appearance'];

function setup(permissions) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    return { status: 200, body: { ok: true, opId: 'op_1' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

test('both tools exist, need workspace, are hidden without it and carry the plan annotations', async () => {
  for (const n of NAMES) assert.equal(TOOLS.find((t) => t.name === n)?.need, 'workspace', n);
  const ro = (await setup(['read']).rpc('tools/list')).result.tools;
  for (const n of NAMES) assert.equal(ro.some((t) => t.name === n), false, `${n} hidden without workspace`);
  const rw = (await setup(['read', 'workspace']).rpc('tools/list')).result.tools;
  for (const n of NAMES) {
    const t = rw.find((x) => x.name === n);
    assert.ok(t, n);
    assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, n);
  }
  assert.match(rw.find((x) => x.name === 'codex_update_event').description, /archived or unknown scene is refused/);
  assert.match(rw.find((x) => x.name === 'codex_set_first_appearance').description, /archived or unknown scene is refused/);
});

test('codex_update_event posts scenes, add and remove (as { scenes } lists) to the event path, by id or slug', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const cases = [
    [{ event: 'the-flood', scenes: ['scene_1', 'scene_2'], base_sha256: SHA }, '/timeline/events/the-flood', { scenes: ['scene_1', 'scene_2'], base_sha256: SHA }],
    [{ event: 'event_01', scenes: [] }, '/timeline/events/event_01', { scenes: [] }],
    [{ event: 'the-flood', add: ['scene_3'] }, '/timeline/events/the-flood', { add: { scenes: ['scene_3'] } }],
    [{ event: 'the flood', add: ['scene_3'], remove: ['scene_1'] }, '/timeline/events/the%20flood', { add: { scenes: ['scene_3'] }, remove: { scenes: ['scene_1'] } }],
  ];
  for (const [args, path, body] of cases) {
    calls.length = 0;
    const r = await tool('codex_update_event', args);
    assert.ok(!r.isError, JSON.stringify(r));
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', `${BOOK}${path}`, body]], JSON.stringify(args));
    assert.match(r.structuredContent.note, /Undo/);
  }
});

test('codex_update_event refuses a call with none of scenes, add, remove before any request', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const r = await tool('codex_update_event', { event: 'the-flood', base_sha256: SHA });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /at least one of scenes, add, remove/);
  assert.equal(calls.length, 0);
});

test('codex_set_first_appearance posts first_appearance (a scene id, or null to clear) to the entry path', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const cases = [
    [{ entry: 'maren-hollis', scene: 'scene_1' }, '/codex/entries/maren-hollis/first-appearance', { first_appearance: 'scene_1' }],
    [{ entry: 'entry_01', scene: 'scene_1', base_sha256: SHA }, '/codex/entries/entry_01/first-appearance', { first_appearance: 'scene_1', base_sha256: SHA }],
    [{ entry: 'maren-hollis', scene: null }, '/codex/entries/maren-hollis/first-appearance', { first_appearance: null }],
  ];
  for (const [args, path, body] of cases) {
    calls.length = 0;
    const r = await tool('codex_set_first_appearance', args);
    assert.ok(!r.isError, JSON.stringify(r));
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', `${BOOK}${path}`, body]], JSON.stringify(args));
  }
  calls.length = 0;
  const bad = await tool('codex_set_first_appearance', { entry: 'maren-hollis', scene: '' });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0);
});

test('a token without workspace is refused both tools, with no request', async () => {
  const { calls, tool } = setup(['read', 'propose', 'canvas', 'plan']);
  for (const [n, args] of [['codex_update_event', { event: 'x', scenes: [] }], ['codex_set_first_appearance', { entry: 'x', scene: null }]]) {
    const r = await tool(n, args);
    assert.equal(r.isError, true, n);
    assert.equal(r.content[0].text, 'this token lacks the "workspace" permission', n);
  }
  assert.equal(calls.length, 0);
});
