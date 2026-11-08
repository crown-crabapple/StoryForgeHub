import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, NOT_OFFERED, SUPPORTED_PROTOCOL_VERSIONS, TOOLS } from '../src/index.mjs';

const SHA = 'a'.repeat(64);
const scene = (id, title, order) => ({ id, title, order, act: 1, chapter: 1, sequence: order, status: 'draft', pov: 'Mara', words: 3, path: `scenes/${id}.md` });
const BOOKS = {
  'salt-orchard': {
    id: 'book_1', slug: 'salt-orchard', title: 'Salt Orchard', status: 'draft', series: null, series_number: null, language: 'en', scenes: 3, words: 9,
    acts: [
      { act: 1, label: 'Act One', chapters: [{ chapter: 1, label: 'Ch 1', title: 'Arrival', scenes: [scene('scene_1', 'Dock', 1), scene('scene_2', 'Road', 2)] }] },
      { act: 2, label: 'Act Two', chapters: [{ chapter: 1, label: 'Ch 1b', title: 'Return', scenes: [scene('scene_3', 'Orchard', 3)] }] },
    ],
  },
  'tin-sea': { id: 'book_2', slug: 'tin-sea', title: 'Tin Sea', status: 'draft', acts: [], scenes: 0, words: 0 },
};
const SCENES = { scene_1: 'Dock body', scene_2: 'Road body', scene_3: 'Orchard body' };
const ENTRIES = [{ id: 'entry_9', slug: 'mara', type: 'character', name: 'Mara' }, { id: 'entry_8', slug: 'harbor', type: 'place', name: 'Harbor' }];

function fake() {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const [, , a, b, c, d] = parts;
    if (a === undefined) return { status: 200, body: { api: { major: 1 }, server: { name: 'storyforge' } } };
    if (a === 'books' && b === undefined) return { status: 200, body: { books: Object.values(BOOKS).map((x) => ({ ...x, acts: undefined })) } };
    const book = BOOKS[b] ?? Object.values(BOOKS).find((x) => x.id === b);
    if (!book) return { status: 404, body: { error: 'not_found' } };
    if (c === undefined) return { status: 200, body: book };
    if (c === 'scenes') return SCENES[d] === undefined ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: { id: d, title: 'T', sha256: SHA, front_matter: {}, body: SCENES[d] } };
    if (c === 'entries' && d === undefined) return { status: 200, body: { entries: ENTRIES } };
    if (c === 'entries') {
      const e = ENTRIES.find((x) => x.id === d || x.slug === d);
      return e ? { status: 200, body: { ...e, status: 'ok', path: 'p', sha256: SHA, fields: {}, body: 'Entry body' } } : { status: 404, body: { error: 'not_found' } };
    }
    if (c === 'plan') return { status: 200, body: { what: d ?? 'plan' } };
    if (c === 'threads') return { status: 200, body: { threads: [{ id: 'thread_1' }] } };
    if (c === 'events') return { status: 200, body: { events: [{ id: 'event_1' }] } };
    if (c === 'diagnostics') return { status: 200, body: { diagnostics: [] } };
    if (c === 'search') {
      const hits = book.slug === 'salt-orchard' ? [{ id: 'scene_1', kind: 'scene', title: 'Dock', path: 'p', snippet: 's' }, { id: 'scene_2', kind: 'scene', title: 'Road', path: 'p', snippet: 's' }] : [{ id: 'scene_x', kind: 'scene', title: 'X', path: 'p', snippet: 's' }, ...(req.query.q === 'x' ? [{ id: 'doc_1', kind: 'doc', title: 'D', path: 'p', snippet: 's' }] : [])];
      return { status: 200, body: { query: req.query.q, hits } };
    }
    if (c === 'proposals') return req.body.target === 'scene_bad' ? { status: 400, body: { error: 'bad_request', code: 'BAD_ARGS', message: 'nope' } } : { status: 201, body: { suggestion: { id: 'sug_1', path: 'p', target: req.body.target, status: 'open' } } };
    return { status: 404, body: { error: 'not_found' } };
  };
  return { call, calls };
}

function setup(permissions = ['read', 'propose'], origin) {
  const f = fake();
  const server = createMcpServer({ call: f.call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' }, ...(origin === undefined ? {} : { origin }) });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { ...f, server, rpc, tool };
}

test('initialize echoes a supported version and falls back otherwise', async () => {
  const { rpc } = setup();
  const r = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, 'storyforge');
  assert.match(r.result.instructions, /suggestion/);
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
});

test('ping answers with an empty result', async () => {
  assert.deepEqual((await setup().rpc('ping')).result, {});
});

test('tools/list shows 37 tools with read+propose, 43 with canvas too, and 34 read-only tools without', async () => {
  const all = (await setup().rpc('tools/list')).result.tools;
  assert.equal(all.length, 37);
  assert.deepEqual(Object.keys(all[0]).sort(), ['annotations', 'description', 'inputSchema', 'name', 'title']);
  const ro = (await setup(['read']).rpc('tools/list')).result.tools;
  assert.equal(ro.length, 34);
  assert.equal((await setup(['read', 'propose', 'canvas']).rpc('tools/list')).result.tools.length, 43);
  assert.equal((await setup(['read', 'canvas']).rpc('tools/list')).result.tools.length, 40);
  assert.ok(ro.every((t) => t.annotations.readOnlyHint === true));
  assert.equal(TOOLS.filter((t) => t.need === 'propose').length, 3);
  assert.equal(TOOLS.filter((t) => t.need === 'canvas').length, 6);
});

const PLAN_TOOLS = ['codex_get_plan', 'codex_list_plan_links', 'codex_list_arcs', 'codex_list_structures', 'codex_list_relationships', 'codex_list_synopses', 'codex_list_clues'];

test('Story Planner M8: a read token is offered the seven planner tools, all read only; they need no write permission', async () => {
  const ro = (await setup(['read']).rpc('tools/list')).result.tools;
  for (const name of PLAN_TOOLS) {
    const t = ro.find((x) => x.name === name);
    assert.ok(t, `${name} is offered to a read token`);
    assert.equal(t.annotations.readOnlyHint, true, `${name} is read only`);
    assert.equal(TOOLS.find((x) => x.name === name).need, 'read', `${name} needs only read`);
  }
  const { calls, tool } = setup(['read']);
  for (const [name, what] of [['codex_get_plan', undefined], ['codex_list_plan_links', 'links'], ['codex_list_arcs', 'arcs'], ['codex_list_structures', 'structures'], ['codex_list_relationships', 'relationships'], ['codex_list_synopses', 'synopses'], ['codex_list_clues', 'clues']]) {
    calls.length = 0;
    const r = await tool(name, { book: 'salt-orchard' });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.structuredContent.what, what ?? 'plan', name);
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', `/api/v1/books/salt-orchard/plan${what ? `/${what}` : ''}`]], `${name} makes one read`);
  }
  assert.ok(TOOLS.filter((t) => /plan|_arcs?(_|$)|structure|beats|relationship|synops|clue|_link/.test(t.name) && t.need !== 'read').every((t) => t.need === 'plan' || t.name === 'codex_add_plan_cards'), 'a planner write tool needs the plan permission');
});

test('read tools', async () => {
  const { tool } = setup();
  const status = await tool('codex_status', {});
  assert.deepEqual(status.structuredContent.books[0], { slug: 'salt-orchard', title: 'Salt Orchard', scenes: 3, words: 9, ai_level: null });
  assert.equal(status.structuredContent.api.major, 1);
  assert.equal(JSON.parse(status.content[0].text).books.length, 2);

  assert.equal((await tool('codex_list_books', {})).structuredContent.books.length, 2);

  const chapters = (await tool('codex_list_chapters', { book: 'salt-orchard' })).structuredContent;
  assert.deepEqual(chapters.book, { slug: 'salt-orchard', title: 'Salt Orchard' });
  assert.equal(chapters.acts.length, 2);

  const ch = await tool('codex_get_chapter', { book: 'salt-orchard', chapter: 'Arrival' });
  assert.equal(ch.structuredContent.scenes.length, 2);
  assert.equal(ch.structuredContent.scenes[0].body, 'Dock body');
  assert.equal(ch.structuredContent.act, 1);
  assert.equal(ch.content.length, 2);
  assert.ok(!ch.content[0].text.includes('Dock body'));
  assert.equal(ch.content[1].text, `<!-- scene scene_1 sha256 ${SHA} -->\nDock body\n\n<!-- scene scene_2 sha256 ${SHA} -->\nRoad body`);

  const sc = await tool('codex_get_scene', { book: 'salt-orchard', scene: 'scene_2' });
  assert.equal(sc.content[1].text, 'Road body');
  assert.ok(!('body' in JSON.parse(sc.content[0].text)));
  assert.equal(sc.structuredContent.sha256, SHA);

  assert.equal((await tool('codex_list_entries', { book: 'salt-orchard' })).structuredContent.entries.length, 2);
  assert.deepEqual((await tool('codex_list_entries', { book: 'salt-orchard', type: 'place' })).structuredContent.entries.map((e) => e.slug), ['harbor']);

  const en = await tool('codex_get_entry', { book: 'salt-orchard', entry: 'mara' });
  assert.equal(en.content[1].text, 'Entry body');
  assert.equal(en.structuredContent.id, 'entry_9');

  assert.deepEqual((await tool('codex_get_diagnostics', { book: 'salt-orchard' })).structuredContent, { diagnostics: [] });
  assert.equal((await tool('codex_list_threads', { book: 'salt-orchard' })).structuredContent.threads[0].id, 'thread_1');
  assert.equal((await tool('codex_get_timeline', { book: 'salt-orchard' })).structuredContent.events[0].id, 'event_1');
});

test('get_chapter: act disambiguates, ambiguity and misses are errors', async () => {
  const { tool } = setup();
  const amb = await tool('codex_get_chapter', { book: 'salt-orchard', chapter: '1' });
  assert.equal(amb.isError, true);
  assert.match(amb.content[0].text, /ambiguous.*act/);
  const ok = await tool('codex_get_chapter', { book: 'salt-orchard', chapter: '1', act: 2 });
  assert.equal(ok.structuredContent.title, 'Return');
  assert.equal((await tool('codex_get_chapter', { book: 'salt-orchard', chapter: 'Ch 1b' })).structuredContent.act, 2);
  const none = await tool('codex_get_chapter', { book: 'salt-orchard', chapter: '99' });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /^no chapter/);
});

test('search: one book, all books with tagging, and the limit', async () => {
  const { tool, calls } = setup();
  const one = await tool('codex_search', { query: 'dock', book: 'tin-sea' });
  assert.deepEqual(one.structuredContent.hits.map((h) => h.id), ['scene_x']);
  assert.equal(calls.at(-1).query.limit, '20');
  const all = await tool('codex_search', { query: 'dock' });
  assert.deepEqual(all.structuredContent.hits.map((h) => `${h.book}:${h.id}`), ['salt-orchard:scene_1', 'salt-orchard:scene_2', 'tin-sea:scene_x']);
  const limited = await tool('codex_search', { query: 'dock', limit: 2 });
  assert.equal(limited.structuredContent.hits.length, 2);
  assert.equal(limited.structuredContent.query, 'dock');
});

test('argument validation names the bad argument', async () => {
  const { tool } = setup();
  const text = async (name, args) => {
    const r = await tool(name, args);
    assert.equal(r.isError, true);
    return r.content[0].text;
  };
  assert.match(await text('codex_get_scene', { book: 'salt-orchard' }), /missing required argument "scene"/);
  assert.match(await text('codex_get_scene', { book: 3, scene: 'x' }), /"book" must be a string/);
  assert.match(await text('codex_get_scene', { book: 'b', scene: 'x', extra: 1 }), /unknown argument "extra"/);
  assert.match(await text('codex_search', { query: '' }), /"query" must be at least 1/);
  assert.match(await text('codex_search', { query: 'x'.repeat(201) }), /"query" must be at most 200/);
  assert.match(await text('codex_search', { query: 'x', limit: 101 }), /"limit" must be at most 100/);
  assert.match(await text('codex_search', { query: 'x', limit: 0 }), /"limit" must be at least 1/);
  assert.match(await text('codex_search', { query: 'x', limit: 1.5 }), /"limit" must be an integer/);
  assert.match(await text('codex_propose_edit', { book: 'b', target: 'scene_1', hunks: 'no' }), /"hunks" must be an array/);
  assert.match(await text('codex_propose_edit', { book: 'b', target: 'scene_1', hunks: [1] }), /"hunks"\[0\] must be an object/);
});

test('NOT_OFFERED tools get an explanation, unknown tools a JSON-RPC error', async () => {
  const { tool, rpc } = setup();
  assert.equal(NOT_OFFERED.length, 5);
  const r = await tool('codex_delete_ledger_item', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /codex_delete_ledger_item is not available in StoryForge v2's MCP service/);
  const u = await rpc('tools/call', { name: 'codex_nope', arguments: {} });
  assert.deepEqual(u.error, { code: -32602, message: 'unknown tool' });
  assert.equal((await rpc('tools/call', {})).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'codex_status', arguments: 'nope' })).error.code, -32602);
});

test('a tool needing a missing permission is refused', async () => {
  const { tool, calls } = setup(['read']);
  const r = await tool('codex_save_chapter', { book: 'b', scene: 'scene_1', markdown: 'x' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'this token lacks the "propose" permission');
  assert.equal(calls.length, 0);
});

test('protocol errors', async () => {
  const { server, rpc } = setup();
  assert.deepEqual(await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batching is not supported' } });
  assert.equal((await server.handle('x')).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 4, method: 'ping' })).id, 4);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).id, null);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 5, method: 7 })).error.code, -32600);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'whatever' }), null);
  const m = await rpc('resources/list');
  assert.deepEqual(m.error, { code: -32601, message: 'method not found' });
  assert.equal(m.jsonrpc, '2.0');
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: 'x' })).error.code, -32602);
});

test('a v1 error becomes an isError result, an unexpected throw hides details', async () => {
  const { tool } = setup();
  const r = await tool('codex_get_scene', { book: 'nope', scene: 'scene_1' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'StoryForge said 404: not_found');
  const bad = await tool('codex_propose_edit', { book: 'salt-orchard', target: 'scene_bad', text: 'x' });
  assert.equal(bad.content[0].text, 'StoryForge said 400 BAD_ARGS: nope');

  const boom = createMcpServer({ call: async () => { throw new Error('secret stack detail'); }, permissions: ['read'], serverInfo: { name: 'n', version: '1' } });
  const res = (await boom.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codex_list_books' } })).result;
  assert.deepEqual(res, { isError: true, content: [{ type: 'text', text: 'internal error' }] });
});

test('propose tools post the right bodies', async () => {
  const { tool, calls } = setup();
  const note = 'Nothing was changed. The author reviews this suggestion in StoryForge and accepts or rejects it.';

  const a = await tool('codex_save_chapter', { book: 'book_1', scene: 'scene_1', markdown: 'New', rationale: 'why', base_sha256: SHA });
  assert.equal(a.structuredContent.note, note);
  assert.equal(a.structuredContent.suggestion.id, 'sug_1');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/v1/books/book_1/proposals', body: { target: 'scene_1', text: 'New', rationale: 'why', base_sha256: SHA } });

  await tool('codex_save_entry', { book: 'salt-orchard', entry: 'mara', markdown: 'Bio' });
  assert.equal(calls.at(-2).path, '/api/v1/books/salt-orchard/entries/mara');
  assert.deepEqual(calls.at(-1).body, { target: 'entry_9', text: 'Bio' });

  const before = calls.length;
  await tool('codex_save_entry', { book: 'salt-orchard', entry: 'entry_8', markdown: 'Bio' });
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).body.target, 'entry_8');

  await tool('codex_propose_edit', { book: 'salt-orchard', target: 'thread_1', text: 'T' });
  assert.deepEqual(calls.at(-1).body, { target: 'thread_1', text: 'T' });
  const hunks = [{ from: 0, to: 1, replacement: 'z' }];
  await tool('codex_propose_edit', { book: 'salt-orchard', target: 'scene_1', hunks });
  assert.deepEqual(calls.at(-1).body, { target: 'scene_1', hunks });

  const both = await tool('codex_propose_edit', { book: 'salt-orchard', target: 'scene_1', text: 'a', hunks });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /exactly one/);
  const neither = await tool('codex_propose_edit', { book: 'salt-orchard', target: 'scene_1' });
  assert.equal(neither.isError, true);
});

test('search and fetch: the ChatGPT connector shape, over every book, with links when the origin is known', async () => {
  const { tool } = setup(['read'], 'https://sf.example');
  const s = await tool('search', { query: 'dock' });
  assert.equal(s.isError, undefined);
  const parsed = JSON.parse(s.content[0].text);
  assert.deepEqual(parsed, s.structuredContent);
  const ids = parsed.results.map((r) => r.id);
  assert.ok(ids.includes('salt-orchard/scene_1') && ids.includes('salt-orchard/scene_2'), ids.join());
  const first = parsed.results.find((r) => r.id === 'salt-orchard/scene_1');
  assert.deepEqual(Object.keys(first).sort(), ['id', 'text', 'title', 'url']);
  assert.equal(first.url, 'https://sf.example/books/book_1?scene=scene_1');
  assert.match(first.title, /Dock \(scene, Salt Orchard\)/);

  const f = await tool('fetch', { id: 'salt-orchard/scene_1' });
  const doc = JSON.parse(f.content[0].text);
  assert.equal(doc.id, 'salt-orchard/scene_1');
  assert.equal(doc.text, 'Dock body');
  assert.equal(doc.url, 'https://sf.example/books/book_1?scene=scene_1');
  assert.equal(doc.metadata.kind, 'scene');
  assert.equal(doc.metadata.sha256, undefined, 'no file internals');
  const e = JSON.parse((await tool('fetch', { id: 'salt-orchard/entry_9' })).content[0].text);
  assert.equal(e.text, 'Entry body');
  assert.equal(e.url, 'https://sf.example/books/book_1/codex?entry=entry_9');
  const th = JSON.parse((await tool('fetch', { id: 'salt-orchard/thread_1' })).content[0].text);
  assert.equal(th.metadata.kind, 'thread');
  assert.equal(th.url, 'https://sf.example/books/book_1/plan');
});

test('search leaves out kinds fetch cannot open; fetch refuses a bad id or an unknown book; no links without an origin', async () => {
  const { tool } = setup(['read']);
  const parsed = JSON.parse((await tool('search', { query: 'x' })).content[0].text);
  assert.ok(parsed.results.every((r) => r.url === undefined), 'no url without an origin');
  assert.deepEqual(parsed.results.map((r) => r.id), ['salt-orchard/scene_1', 'salt-orchard/scene_2', 'tin-sea/scene_x'], 'the doc hit is left out');
  for (const id of ['scene_1', 'salt-orchard/', 'salt-orchard/note_1', '/scene_1']) {
    const r = await tool('fetch', { id });
    assert.equal(r.isError, true, id);
  }
  const nb = await tool('fetch', { id: 'no-such-book/scene_1' });
  assert.equal(nb.isError, true);
  assert.match(nb.content[0].text, /no book "no-such-book"/);
  const missing = await tool('fetch', { id: 'salt-orchard/thread_404' });
  assert.equal(missing.isError, true);
});
