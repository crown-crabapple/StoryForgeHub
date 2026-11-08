// M12 W3: the ledger / cast / knowledge / state / task / writing-log tools. Reads need 'read'; the eight writes need 'workspace'. Against a fake `call`:
// each tool maps onto the right /api/v1 path and body, bad input is refused before any request, and the delete tools stay out (retire instead).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, NOT_OFFERED, TOOLS } from '../src/index.mjs';

const SHA = 'a'.repeat(64);
const BOOK = '/api/v1/books/salt-orchard';
const READS = ['codex_get_ledger', 'codex_get_cast', 'codex_knowledge_at', 'codex_get_state_events', 'codex_get_tasks'];
const WRITES = ['codex_save_ledger_item', 'codex_set_chapter_cast', 'codex_record_knowledge', 'codex_record_state_events', 'codex_create_task', 'codex_update_task', 'codex_complete_task', 'codex_log_writing'];

function setup(permissions) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    if (req.method === 'GET' && req.path.endsWith('/tasks')) return { status: 200, body: { tasks: [{ id: 'note_1', slug: 'check-tides', status: 'doing', for: 'ai' }], counts: {} } };
    if (req.method === 'GET') return { status: 200, body: { path: req.path, query: req.query ?? null } };
    if (req.path.endsWith('/ledger/threads')) return { status: 201, body: { ok: true, slug: 'who-left-the-key', id: 'thread_9' } };
    return { status: 200, body: { ok: true, opId: 'op_1' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

test('the workspace tools: five read tools need only read, eight write tools need workspace; the delete tools stay in NOT_OFFERED', async () => {
  const ws = TOOLS.filter((t) => t.need === 'workspace').map((t) => t.name);
  for (const n of WRITES) assert.ok(ws.includes(n), `${n} needs workspace`); // the workspace doc tools (W2) need it too
  for (const n of READS) assert.equal(TOOLS.find((t) => t.name === n)?.need, 'read', n);
  const ro = (await setup(['read']).rpc('tools/list')).result.tools;
  for (const n of READS) assert.ok(ro.some((t) => t.name === n), `${n} listed with read`);
  for (const n of WRITES) assert.equal(ro.some((t) => t.name === n), false, `${n} hidden without workspace`);
  const rw = (await setup(['read', 'workspace']).rpc('tools/list')).result.tools;
  for (const n of [...READS, ...WRITES]) assert.ok(rw.some((t) => t.name === n), n);
  for (const n of WRITES) {
    const t = rw.find((x) => x.name === n);
    assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, n);
    assert.match(t.description, /the author can Undo it in StoryForge/, n);
  }
  for (const n of READS) assert.equal(rw.find((x) => x.name === n).annotations.readOnlyHint, true, n);
  for (const n of ['codex_delete_ledger_item', 'codex_delete_knowledge', 'codex_delete_state_event']) {
    assert.ok(NOT_OFFERED.includes(n), `${n} stays out`);
    assert.equal(rw.some((t) => t.name === n), false);
  }
  for (const n of [...READS, ...WRITES]) assert.equal(NOT_OFFERED.includes(n), false, `${n} is offered now`);
  assert.equal(TOOLS.length, 90);
});

test('a token without workspace is refused a write tool, with no request', async () => {
  const { calls, tool } = setup(['read', 'propose', 'canvas', 'plan']);
  for (const [n, args] of [['codex_record_knowledge', { character: 'mara', fact: 'x', chapter: 1 }], ['codex_log_writing', { words: 5 }], ['codex_create_task', { title: 'x' }]]) {
    const r = await tool(n, args);
    assert.equal(r.isError, true, n);
    assert.equal(r.content[0].text, 'this token lacks the "workspace" permission', n);
  }
  assert.equal(calls.length, 0);
});

test('the read tools call the v1 routes with their query', async () => {
  const { calls, tool } = setup(['read']);
  const cases = [
    ['codex_get_ledger', {}, '/ledger', undefined],
    ['codex_get_cast', {}, '/cast', {}],
    ['codex_get_cast', { chapter: 3 }, '/cast', { chapter: '3' }],
    ['codex_knowledge_at', { character: 'mara', at: 4 }, '/knowledge', { character: 'mara', at: '4' }],
    ['codex_knowledge_at', { character: 'mara' }, '/knowledge', { character: 'mara' }],
    ['codex_get_state_events', { chapter: 0 }, '/state-events', { chapter: '0' }],
    ['codex_get_state_events', {}, '/state-events', {}],
    ['codex_get_tasks', { status: 'open', for: 'ai' }, '/tasks', { status: 'open', for: 'ai' }],
    ['codex_get_tasks', {}, '/tasks', {}],
  ];
  for (const [name, args, path, query] of cases) {
    calls.length = 0;
    const r = await tool(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
    assert.equal(calls.length, 1, name);
    assert.deepEqual([calls[0].method, calls[0].path], ['GET', `${BOOK}${path}`], name);
    if (query !== undefined) assert.deepEqual(calls[0].query ?? {}, query, name);
  }
});

const WS_WRITES = [
  ['codex_save_ledger_item', { slug: 'brass-key', status: 'paid', payoff: ['scene_9'], base_sha256: SHA }, [['POST', '/ledger/threads/brass-key', { status: 'paid', payoff: ['scene_9'], base_sha256: SHA }]]],
  ['codex_save_ledger_item', { title: 'Who left the key?', kind: 'question' }, [['POST', '/ledger/threads', { title: 'Who left the key?', kind: 'question' }]]],
  ['codex_save_ledger_item', { title: 'Who left the key?', kind: 'question', status: 'planted', setup: ['scene_1'] }, [
    ['POST', '/ledger/threads', { title: 'Who left the key?', kind: 'question', status: 'planted' }],
    ['POST', '/ledger/threads/who-left-the-key', { setup: ['scene_1'] }],
  ]],
  ['codex_set_chapter_cast', { scene: 'scene_1', cast: [{ entry: 'mara', role: 'pov' }, { entry: 'harbor', role: 'mentioned' }], base_sha256: SHA }, [['POST', '/scenes/scene_1/cast', { cast: [{ entry: 'mara', role: 'pov' }, { entry: 'harbor', role: 'mentioned' }], base_sha256: SHA }]]],
  ['codex_set_chapter_cast', { scene: 'scene_1', cast: [] }, [['POST', '/scenes/scene_1/cast', { cast: [] }]]],
  ['codex_record_knowledge', { character: 'mara', fact: 'The key opens the sluice', chapter: 2 }, [['POST', '/knowledge', { character: 'mara', fact: 'The key opens the sluice', chapter: 2 }]]],
  ['codex_record_state_events', { chapter: 3, items: [{ subject: 'pell', kind: 'died' }, { subject: 'bell', kind: 'holder', value: 'mara' }] }, [['POST', '/state-events', { chapter: 3, items: [{ subject: 'pell', kind: 'died' }, { subject: 'bell', kind: 'holder', value: 'mara' }] }]]],
  ['codex_create_task', { title: 'Check the tide times', notes: 'Chapter 2', labels: ['facts'], for: 'ai' }, [['POST', '/tasks', { title: 'Check the tide times', notes: 'Chapter 2', labels: ['facts'], for: 'ai' }]]],
  ['codex_create_task', { title: 'Fix it' }, [['POST', '/tasks', { title: 'Fix it' }]]],
  ['codex_update_task', { task: 'check-tides', status: 'done', for: 'author' }, [['POST', '/tasks/check-tides/status', { status: 'done', for: 'author' }]]],
  ['codex_update_task', { task: 'check-tides', for: 'author' }, [['GET', '/tasks', undefined], ['POST', '/tasks/check-tides/status', { status: 'doing', for: 'author' }]]],
  ['codex_complete_task', { task: 'note_1' }, [['POST', '/tasks/note_1/status', { status: 'done' }]]],
  ['codex_log_writing', { words: 450, chapter: 2, note: 'Drafted the ferry scene' }, [['POST', '/activity/ai-words', { words: 450, chapter: 2, note: 'Drafted the ferry scene' }]]],
];

test('each workspace write tool posts to the right v1 path with the right body', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  for (const [name, args, expected] of WS_WRITES) {
    calls.length = 0;
    const r = await tool(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), expected.map(([m, p, b]) => [m, `${BOOK}${p}`, b]), `${name} ${JSON.stringify(args)}`);
    assert.match(r.structuredContent.note, /Undo/);
  }
  assert.deepEqual([...new Set(WS_WRITES.map((w) => w[0]))].sort(), [...WRITES].sort(), 'every workspace write tool is exercised');
});

test('workspace tools refuse bad input before any request', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const bad = [
    ['codex_save_ledger_item', { title: 'x', kind: 'mystery' }, 'kind enum'],
    ['codex_save_ledger_item', { title: 'x' }, 'kind is needed to create'],
    ['codex_save_ledger_item', { kind: 'promise' }, 'title is needed to create'],
    ['codex_save_ledger_item', { slug: 'brass-key' }, 'nothing to change'],
    ['codex_save_ledger_item', { slug: 'brass-key', status: 'open' }, 'status enum'],
    ['codex_set_chapter_cast', { scene: 's', cast: [{ entry: 'mara', role: 'star' }] }, 'role enum'],
    ['codex_set_chapter_cast', { scene: 's', cast: [{ entry: 'mara' }] }, 'role required'],
    ['codex_set_chapter_cast', { scene: 's', cast: [{ entry: 'mara', role: 'pov', extra: 1 }] }, 'unknown cast key'],
    ['codex_set_chapter_cast', { cast: [] }, 'scene required'],
    ['codex_record_knowledge', { character: 'mara', fact: 'x' }, 'chapter required'],
    ['codex_record_knowledge', { character: 'mara', fact: 'x', chapter: -1 }, 'chapter >= 0'],
    ['codex_record_state_events', { chapter: 1, items: [{ subject: 'p', kind: 'learns' }] }, 'kind enum'],
    ['codex_record_state_events', { chapter: 1, items: [{ kind: 'died' }] }, 'subject required'],
    ['codex_create_task', { title: 'x', for: 'robot' }, 'for enum'],
    ['codex_create_task', {}, 'title required'],
    ['codex_update_task', { task: 't' }, 'status or for'],
    ['codex_update_task', { task: 't', status: 'finished' }, 'status enum'],
    ['codex_log_writing', { words: 0 }, 'words >= 1'],
    ['codex_log_writing', { words: 2.5 }, 'words integer'],
    ['codex_log_writing', {}, 'words required'],
  ];
  for (const [name, args, why] of bad) assert.equal((await tool(name, args)).isError, true, `${name}: ${why}`);
  assert.equal(calls.length, 0);
  // an update that names no known task is a tool error after one read
  const { calls: c2, tool: t2 } = setup(['read', 'workspace']);
  const r = await t2('codex_update_task', { task: 'no-such-task', for: 'ai' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no task "no-such-task"/);
  assert.deepEqual(c2.map((c) => c.method), ['GET']);
});

test('a v1 refusal (AI level too low) becomes an isError result with the server\'s message', async () => {
  const call = async () => ({ status: 403, body: { error: 'forbidden', code: 'AI_LEVEL', message: 'the AI level of this book is "advisor"; this needs "planner" or higher' } });
  const server = createMcpServer({ call, permissions: ['read', 'workspace'], serverInfo: { name: 'storyforge', version: '0.1.0' } });
  const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codex_record_knowledge', arguments: { book: 'b', character: 'mara', fact: 'x', chapter: 1 } } })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /AI level/);
});
