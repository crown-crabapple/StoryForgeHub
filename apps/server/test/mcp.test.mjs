// The MCP service over HTTP (POST /mcp), personal mode: protocol, tools against the fixture library, the permission rules and the proposal-only write policy.
// A real server in this process over a copy of the fixture library; tokens are granted through the same Settings route the plugin tests use.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { BOOK, SCENE, SLUG, bootPersonal, closeAll, raw, sceneBytes } from './plugin-helpers.mjs';

after(closeAll);

let nextId = 1;
/** One JSON-RPC request to POST /mcp as a plugin; resolves to the raw HTTP result. */
const rpc = (t, token, method, params) => t.plugin(token, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) } });
/** tools/call; the JSON-RPC result of the reply (HTTP 200 and no JSON-RPC error asserted). */
async function call(t, token, name, args = {}) {
  const r = await rpc(t, token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.error, undefined, r.text);
  return r.json.result;
}
const textOf = (result) => result.content.map((c) => c.text).join('\n');

const READ_TOOLS = ['codex_status', 'codex_list_books', 'codex_list_chapters', 'codex_get_chapter', 'codex_get_scene', 'codex_list_entries', 'codex_get_entry', 'codex_search', 'codex_get_diagnostics', 'codex_list_threads', 'codex_get_timeline', 'codex_list_canvases', 'codex_get_canvas',
  // Story Planner M8: read-only planner tools
  'codex_get_plan', 'codex_get_scene_plan', 'codex_get_plan_check', 'codex_list_structure_templates', 'codex_list_plan_links', 'codex_list_arcs', 'codex_list_structures', 'codex_list_relationships', 'codex_list_synopses', 'codex_list_clues',
  // M12 W2: workspace docs
  'codex_list_docs', 'codex_get_doc',
  // M12 W3: ledger, cast, knowledge, state events and tasks (reads)
  'codex_get_ledger', 'codex_get_cast', 'codex_knowledge_at', 'codex_get_state_events', 'codex_get_tasks',
  // the ChatGPT connector pair
  'search', 'fetch'];
const CANVAS_TOOLS = ['codex_create_canvas', 'codex_save_canvas', 'codex_edit_canvas', 'codex_archive_canvas', 'codex_restore_canvas', 'codex_add_plan_cards'];
const PROPOSE_TOOLS = ['codex_save_chapter', 'codex_save_entry', 'codex_propose_edit'];

/** Search is indexed in the background: retry a bounded number of times until the query has hits. */
async function searchUntilHits(t, token, args) {
  let result;
  for (let i = 0; i < 100; i++) {
    result = await call(t, token, 'codex_search', args);
    if (result.structuredContent.hits.length > 0) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  return result;
}

// ---------------------------------------------------------------- protocol

test('initialize names the server "storyforge" and answers with a supported protocol version', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const r = await rpc(t, token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.jsonrpc, '2.0');
  assert.equal(r.json.result.serverInfo.name, 'storyforge');
  assert.equal(r.json.result.protocolVersion, '2025-03-26');
  assert.ok(r.json.result.capabilities.tools);
  // an unknown version gets one the server supports
  const other = await rpc(t, token, 'initialize', { protocolVersion: '1999-01-01' });
  assert.match(other.json.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(other.json.result.protocolVersion, '1999-01-01');
});

test('tools/list: a read+propose token sees 35 tools, read+propose+canvas all 41, a read-only token the 32 read tools and no codex_save_*', async () => {
  const t = await bootPersonal();
  const both = (await t.grant({ plugin: 'both', permissions: ['read', 'propose'] })).token;
  const ro = (await t.grant({ plugin: 'ro', permissions: ['read'] })).token;
  const all = (await rpc(t, both, 'tools/list')).json.result.tools.map((x) => x.name);
  assert.equal(all.length, 35);
  assert.deepEqual([...all].sort(), [...READ_TOOLS, ...PROPOSE_TOOLS].sort());
  const some = (await rpc(t, ro, 'tools/list')).json.result.tools.map((x) => x.name);
  assert.equal(some.length, 32);
  assert.deepEqual([...some].sort(), [...READ_TOOLS].sort());
  assert.equal(some.some((n) => n.startsWith('codex_save_')), false);
});

test('an unknown method is -32601 and an unknown tool name is -32602', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  assert.equal((await rpc(t, token, 'no/such')).json.error.code, -32601);
  assert.equal((await rpc(t, token, 'tools/call', { name: 'not_a_tool', arguments: {} })).json.error.code, -32602);
});

// ---------------------------------------------------------------- read tools on the fixture

test('read tools return the fixture book, chapters, scene, entries and search hits', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });

  const books = await call(t, token, 'codex_list_books');
  assert.notEqual(books.isError, true);
  assert.deepEqual(books.structuredContent.books.map((b) => b.slug), [SLUG]);
  assert.equal(books.structuredContent.books[0].id, BOOK);

  const status = await call(t, token, 'codex_status');
  assert.equal(status.structuredContent.api, 1);
  assert.deepEqual(status.structuredContent.books.map((b) => b.slug), [SLUG]);

  const chapters = await call(t, token, 'codex_list_chapters', { book: SLUG });
  assert.equal(chapters.structuredContent.book.slug, SLUG);
  const titles = chapters.structuredContent.acts.flatMap((a) => a.chapters.map((c) => c.title));
  assert.ok(titles.includes('The Drowned Rows'));
  // the book can also be named by its id
  assert.equal((await call(t, token, 'codex_list_chapters', { book: BOOK })).structuredContent.book.slug, SLUG);

  const scene = await call(t, token, 'codex_get_scene', { book: SLUG, scene: SCENE });
  assert.notEqual(scene.isError, true);
  assert.equal(scene.structuredContent.id, SCENE);
  assert.match(scene.structuredContent.sha256, /^[0-9a-f]{64}$/);
  assert.match(scene.structuredContent.body, /The ferry nudged the jetty/);
  assert.match(textOf(scene), /The ferry nudged the jetty/, 'the prose is in the text content');

  const chapter = await call(t, token, 'codex_get_chapter', { book: SLUG, chapter: 'The Drowned Rows' });
  assert.notEqual(chapter.isError, true);
  assert.equal(chapter.structuredContent.title, 'The Drowned Rows');
  assert.equal(chapter.structuredContent.chapter, 1);
  assert.equal(chapter.structuredContent.scenes.length, 2);
  assert.ok(chapter.structuredContent.scenes.some((s) => s.id === SCENE && /The ferry nudged the jetty/.test(s.body)));
  assert.equal((await call(t, token, 'codex_get_chapter', { book: SLUG, chapter: '1' })).structuredContent.title, 'The Drowned Rows', 'by number');
  const none = await call(t, token, 'codex_get_chapter', { book: SLUG, chapter: 'No such chapter' });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /no chapter matches/);

  const entries = await call(t, token, 'codex_list_entries', { book: SLUG });
  assert.ok(entries.structuredContent.entries.length > 3);
  const bell = entries.structuredContent.entries.find((e) => e.slug === 'ferry-bell');
  assert.ok(bell);
  const bySlug = await call(t, token, 'codex_get_entry', { book: SLUG, entry: 'ferry-bell' });
  assert.equal(bySlug.structuredContent.id, bell.id);
  assert.equal(typeof bySlug.structuredContent.body, 'string');
  const byId = await call(t, token, 'codex_get_entry', { book: SLUG, entry: bell.id });
  assert.equal(byId.structuredContent.slug, 'ferry-bell');
  const typed = await call(t, token, 'codex_list_entries', { book: SLUG, type: 'object' });
  assert.ok(typed.structuredContent.entries.length >= 1 && typed.structuredContent.entries.every((e) => e.type === 'object'));
  assert.equal((await call(t, token, 'codex_get_entry', { book: SLUG, entry: 'no-such-entry' })).isError, true);

  assert.ok((await call(t, token, 'codex_list_threads', { book: SLUG })).structuredContent.threads.length >= 1);
  assert.ok((await call(t, token, 'codex_get_timeline', { book: SLUG })).structuredContent.events.length >= 1);
  assert.deepEqual((await call(t, token, 'codex_get_diagnostics', { book: SLUG })).structuredContent.diagnostics, []);

  const inBook = await searchUntilHits(t, token, { query: 'Ferry', book: SLUG });
  assert.ok(inBook.structuredContent.hits.some((h) => h.title === 'Ferry Bell'));
  const everywhere = await searchUntilHits(t, token, { query: 'Ferry' });
  const hit = everywhere.structuredContent.hits.find((h) => h.title === 'Ferry Bell');
  assert.ok(hit);
  assert.equal(hit.book, SLUG, 'a search without a book names the book of each hit');
  const limited = await call(t, token, 'codex_search', { query: 'salt', limit: 1 });
  assert.ok(limited.structuredContent.hits.length <= 1);
});

test('bad tool arguments are a tool error, not a protocol error', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  for (const [name, args] of [['codex_get_scene', { book: SLUG }], ['codex_get_scene', { book: SLUG, scene: SCENE, extra: 1 }], ['codex_search', { query: '' }], ['codex_search', { query: 'x', limit: 0 }], ['codex_list_books', { book: 5 }]]) {
    const r = await call(t, token, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(textOf(r), /invalid arguments/);
  }
  const missing = await call(t, token, 'codex_get_scene', { book: SLUG, scene: 'scene_01S5000000000000000000ZZZZ' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /404/);
});

// ---------------------------------------------------------------- the proposal-only write policy

test('codex_save_chapter with a propose token returns a suggestion and leaves the scene file byte-identical', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'], books: [SLUG] });
  const scene = (await call(t, token, 'codex_get_scene', { book: SLUG, scene: SCENE })).structuredContent;
  const original = await sceneBytes(t.root);
  const next = scene.body.replace('green eyes ringed with salt', 'grey eyes ringed with salt');
  assert.notEqual(next, scene.body);

  const r = await call(t, token, 'codex_save_chapter', { book: SLUG, scene: SCENE, markdown: next, rationale: 'Her eyes are grey elsewhere.', base_sha256: scene.sha256 });
  assert.notEqual(r.isError, true, textOf(r));
  const s = r.structuredContent.suggestion;
  assert.match(s.id, /^\S+$/);
  assert.equal(s.source, 'plugin');
  assert.equal(s.target, SCENE);
  assert.equal(s.rationale, 'Her eyes are grey elsewhere.');
  assert.match(r.structuredContent.note, /Nothing was changed/);
  assert.equal(Buffer.compare(await sceneBytes(t.root), original), 0, 'the scene file is byte-identical after the proposal');

  // the suggestion is in the author's normal review
  const listed = await t.member('GET', `/api/books/${BOOK}/suggestions?state=open`);
  assert.deepEqual(listed.json.suggestions.map((x) => x.id), [s.id]);

  // codex_propose_edit by hunks also only suggests
  const at = scene.body.indexOf('ferry');
  const hunk = await call(t, token, 'codex_propose_edit', { book: SLUG, target: SCENE, hunks: [{ from: at, to: at + 5, replacement: 'boat' }] });
  assert.notEqual(hunk.isError, true, textOf(hunk));
  assert.equal((await call(t, token, 'codex_propose_edit', { book: SLUG, target: SCENE })).isError, true, 'text or hunks is required');
  assert.equal(Buffer.compare(await sceneBytes(t.root), original), 0, 'still byte-identical');
  assert.equal((await t.member('GET', `/api/books/${BOOK}/suggestions?state=open`)).json.suggestions.length, 2);
});

test('codex_save_entry resolves a slug and only proposes', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'] });
  const entry = (await call(t, token, 'codex_get_entry', { book: SLUG, entry: 'ferry-bell' })).structuredContent;
  const r = await call(t, token, 'codex_save_entry', { book: SLUG, entry: 'ferry-bell', markdown: `${entry.body}\nIt rings twice at dusk.\n` });
  assert.notEqual(r.isError, true, textOf(r));
  assert.equal(r.structuredContent.suggestion.target, entry.id);
  const again = (await call(t, token, 'codex_get_entry', { book: SLUG, entry: 'ferry-bell' })).structuredContent;
  assert.equal(again.body, entry.body, 'the entry is unchanged');
  assert.equal(again.sha256, entry.sha256);
});

test('a read-only token: the save tool is not listed, calling it is a tool error naming the propose permission, and the file is unchanged', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const original = await sceneBytes(t.root);
  const listed = (await rpc(t, token, 'tools/list')).json.result.tools.map((x) => x.name);
  assert.equal(listed.includes('codex_save_chapter'), false);
  for (const [name, args] of [['codex_save_chapter', { book: SLUG, scene: SCENE, markdown: 'hijacked' }], ['codex_save_entry', { book: SLUG, entry: 'ferry-bell', markdown: 'x' }], ['codex_propose_edit', { book: SLUG, target: SCENE, text: 'x' }]]) {
    const r = await call(t, token, name, args);
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /propose/, name);
  }
  assert.equal(Buffer.compare(await sceneBytes(t.root), original), 0);
  assert.deepEqual((await t.member('GET', `/api/books/${BOOK}/suggestions?state=open`)).json.suggestions, []);
});

test('a stale base_sha256 on codex_save_chapter is a tool error mentioning 409 SCENE_CHANGED, and nothing is suggested', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'] });
  const original = await sceneBytes(t.root);
  const r = await call(t, token, 'codex_save_chapter', { book: SLUG, scene: SCENE, markdown: 'A different scene.', base_sha256: '0'.repeat(64) });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /409/);
  assert.match(textOf(r), /SCENE_CHANGED/);
  assert.equal(Buffer.compare(await sceneBytes(t.root), original), 0);
  assert.deepEqual((await t.member('GET', `/api/books/${BOOK}/suggestions?state=open`)).json.suggestions, []);
});

test('a token granted another book only cannot read or propose to this one (403 PLUGIN_SCOPE in the tool error)', async () => {
  const t = await bootPersonal({ fixture: 'valid/tidewater' });
  const [a, b] = (await t.member('GET', '/api/books')).json;
  assert.ok(a && b, 'tidewater has several books');
  const { token } = await t.grant({ permissions: ['read', 'propose'], books: [a.slug] });
  const list = await call(t, token, 'codex_list_books');
  assert.deepEqual(list.structuredContent.books.map((x) => x.slug), [a.slug]);
  for (const [name, args] of [['codex_get_scene', { book: b.slug, scene: SCENE }], ['codex_list_chapters', { book: b.slug }], ['codex_list_entries', { book: b.slug }], ['codex_search', { query: 'a', book: b.slug }], ['codex_save_chapter', { book: b.slug, scene: SCENE, markdown: 'x' }]]) {
    const r = await call(t, token, name, args);
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /403/, name);
    assert.match(textOf(r), /PLUGIN_SCOPE/, name);
  }
});

test('a legacy Codex tool name is a tool error saying it is not available', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'propose'] });
  const r = await call(t, token, 'codex_delete_ledger_item', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not available/);
});

// ---------------------------------------------------------------- canvases

const canvasFile = (root, slug) => fs.readFile(path.join(root, 'planning', 'canvases', `${slug}.canvas`));

test('tools/list: the canvas write tools are listed only with the canvas permission', async () => {
  const t = await bootPersonal();
  const withCanvas = (await t.grant({ plugin: 'cv', permissions: ['read', 'canvas'] })).token;
  const readOnly = (await t.grant({ plugin: 'ro', permissions: ['read'] })).token;
  const listed = (await rpc(t, withCanvas, 'tools/list')).json.result.tools.map((x) => x.name);
  assert.deepEqual([...listed].sort(), [...READ_TOOLS, ...CANVAS_TOOLS].sort());
  const some = (await rpc(t, readOnly, 'tools/list')).json.result.tools.map((x) => x.name);
  for (const n of CANVAS_TOOLS) assert.equal(some.includes(n), false, n);
  assert.ok(some.includes('codex_list_canvases') && some.includes('codex_get_canvas'));
});

test('codex_edit_canvas adds a node, then removes a node with its edges, end to end on disk', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read', 'canvas'] });
  const made = await call(t, token, 'codex_create_canvas', { book: SLUG, title: 'Plot Board' });
  assert.notEqual(made.isError, true, textOf(made));
  assert.equal(made.structuredContent.slug, 'plot-board');
  assert.match(made.structuredContent.note, /planning material, not prose/);

  const text = (id, x) => ({ id, type: 'text', text: id, x, y: 0, width: 100, height: 60 });
  const added = await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board', add_nodes: [text('a', 0), text('b', 200)], add_edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }] });
  assert.notEqual(added.isError, true, textOf(added));
  let doc = JSON.parse((await canvasFile(t.root, 'plot-board')).toString('utf8'));
  assert.deepEqual(doc.nodes.map((n) => n.id), ['a', 'b']);
  assert.deepEqual(doc.edges.map((e) => e.id), ['e1']);

  const got = (await call(t, token, 'codex_get_canvas', { book: SLUG, canvas: 'plot-board' })).structuredContent;
  assert.match(got.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(got.targets));

  assert.equal((await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board', add_nodes: [text('a', 0)] })).isError, true, 'duplicate id');
  assert.equal((await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board', remove_nodes: ['nope'] })).isError, true, 'unknown id');
  assert.equal((await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board' })).isError, true, 'no operation');
  const stale = await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board', base_sha256: '0'.repeat(64), remove_nodes: ['a'] });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /read it again/);

  const removed = await call(t, token, 'codex_edit_canvas', { book: SLUG, canvas: 'plot-board', base_sha256: got.sha256, remove_nodes: ['a'], update_nodes: [{ id: 'b', text: 'renamed' }] });
  assert.notEqual(removed.isError, true, textOf(removed));
  doc = JSON.parse((await canvasFile(t.root, 'plot-board')).toString('utf8'));
  assert.deepEqual(doc.nodes.map((n) => [n.id, n.text]), [['b', 'renamed']]);
  assert.deepEqual(doc.edges, [], 'the edge touching the removed node is gone');

  const saved = await call(t, token, 'codex_save_canvas', { book: SLUG, canvas: 'plot-board', content: { nodes: [], edges: [] }, base_sha256: '0'.repeat(64) });
  assert.equal(saved.isError, true);
  assert.match(textOf(saved), /409/);

  assert.notEqual((await call(t, token, 'codex_archive_canvas', { book: SLUG, canvas: 'plot-board' })).isError, true);
  assert.equal((await call(t, token, 'codex_list_canvases', { book: SLUG })).structuredContent.archived.length, 1);
  assert.notEqual((await call(t, token, 'codex_restore_canvas', { book: SLUG, canvas: 'plot-board' })).isError, true);
  assert.equal((await call(t, token, 'codex_list_canvases', { book: SLUG })).structuredContent.canvases.length, 1);
});

test('a read-only token calling the canvas write tools gets a tool error naming canvas and writes nothing', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  for (const [name, args] of [['codex_create_canvas', { book: SLUG, title: 'X' }], ['codex_save_canvas', { book: SLUG, canvas: 'x', content: { nodes: [], edges: [] }, base_sha256: '0'.repeat(64) }], ['codex_edit_canvas', { book: SLUG, canvas: 'x', remove_nodes: ['a'] }], ['codex_archive_canvas', { book: SLUG, canvas: 'x' }]]) {
    const r = await call(t, token, name, args);
    assert.equal(r.isError, true, name);
    assert.match(textOf(r), /canvas/, name);
  }
  assert.deepEqual((await t.member('GET', `/api/books/${BOOK}/canvases`)).json.canvases, []);
});

// ---------------------------------------------------------------- transport rules

test('transport: revoked, missing and unknown tokens are 401; GET is 405; an Origin is 403 except ChatGPT origins; wrong content type 415; bad JSON 400; a notification 202 and empty', async () => {
  const t = await bootPersonal();
  const { token, grant } = await t.grant({ permissions: ['read'] });
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await rpc(t, token, 'ping')).status, 200);

  assert.equal((await raw(t.port, 'POST', '/mcp', { body, headers: { 'content-type': 'application/json' } })).status, 401, 'no Authorization');
  const unknown = await raw(t.port, 'POST', '/mcp', { body, headers: { 'content-type': 'application/json', authorization: `Bearer ${'A'.repeat(43)}` } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.code, 'TOKEN');

  const get = await t.plugin(token, 'GET', '/mcp');
  assert.equal(get.status, 405);
  const origin = await t.plugin(token, 'POST', '/mcp', { body, headers: { origin: 'http://evil.example' } });
  assert.equal(origin.status, 403);
  assert.equal(origin.json.code, 'ORIGIN');
  for (const o of ['https://chatgpt.com', 'https://chat.openai.com']) {
    assert.equal((await t.plugin(token, 'POST', '/mcp', { body, headers: { origin: o } })).status, 200, `ChatGPT's origin ${o} is allowed`);
    assert.equal((await raw(t.port, 'POST', '/mcp', { body, headers: { 'content-type': 'application/json', origin: o } })).status, 401, `${o} still needs the key`);
  }
  for (const o of ['https://chatgpt.com.evil.example', 'http://chatgpt.com', 'https://evil.chatgpt.com', 'null']) {
    assert.equal((await t.plugin(token, 'POST', '/mcp', { body, headers: { origin: o } })).status, 403, `${o} is refused`);
  }
  const plain = await raw(t.port, 'POST', '/mcp', { body: JSON.stringify(body), headers: { 'content-type': 'text/plain', authorization: `Bearer ${token}` } });
  assert.equal(plain.status, 415);
  const bad = await raw(t.port, 'POST', '/mcp', { body: '{nope', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  const note = await t.plugin(token, 'POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');

  const revoked = await t.member('DELETE', `/api/plugins/grants/${grant.id}`);
  assert.equal(revoked.status, 200);
  const after = await rpc(t, token, 'tools/list');
  assert.equal(after.status, 401, 'a revoked token is refused at once');
  assert.equal(after.json.code, 'TOKEN');
});
