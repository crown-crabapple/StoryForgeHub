// M12 W4: codex_continuity_check (read), codex_dismiss_finding and codex_restore_finding (workspace). Against a fake `call`: each tool maps onto the right
// /api/v1 path and body, bad input is refused before any request, and the author-only thresholds stay out of the tool list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, NOT_OFFERED, TOOLS } from '../src/index.mjs';

const BOOK = '/api/v1/books/salt-orchard';
const FP = 'cf1-0123456789abcdef';

function setup(permissions) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    if (req.method === 'GET') return { status: 200, body: { findings: [], suppressed: [{ finding: { fingerprint: FP }, exception: { slug: 'green-eyes' } }], stale_exceptions: [] } };
    return { status: 200, body: { ok: true, opId: 'op_1' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

test('the check needs read, dismiss and restore need workspace; the thresholds stay author only', async () => {
  assert.equal(TOOLS.find((t) => t.name === 'codex_continuity_check')?.need, 'read');
  assert.equal(TOOLS.find((t) => t.name === 'codex_dismiss_finding')?.need, 'workspace');
  assert.equal(TOOLS.find((t) => t.name === 'codex_restore_finding')?.need, 'workspace');
  for (const n of ['codex_continuity_check', 'codex_dismiss_finding', 'codex_restore_finding']) assert.equal(NOT_OFFERED.includes(n), false, `${n} is offered`);
  assert.ok(NOT_OFFERED.includes('codex_set_continuity_thresholds'));
  assert.equal(TOOLS.some((t) => /threshold|settings/.test(t.name)), false);
  const ro = (await setup(['read']).rpc('tools/list')).result.tools.map((t) => t.name);
  assert.ok(ro.includes('codex_continuity_check'));
  assert.equal(ro.includes('codex_dismiss_finding') || ro.includes('codex_restore_finding'), false);
  const rw = (await setup(['read', 'workspace']).rpc('tools/list')).result.tools.map((t) => t.name);
  assert.ok(rw.includes('codex_dismiss_finding') && rw.includes('codex_restore_finding'));
});

test('codex_continuity_check passes chapter and the planned cast as the query', async () => {
  const { calls, tool } = setup(['read']);
  const plain = await tool('codex_continuity_check', {});
  assert.equal(plain.isError, undefined);
  assert.deepEqual([calls[0].method, calls[0].path, calls[0].query], ['GET', `${BOOK}/continuity`, {}]);
  await tool('codex_continuity_check', { chapter: 4, cast: [{ entry: 'pell', role: 'appears' }, { entry: 'maren-hollis', role: 'pov' }] });
  assert.deepEqual(calls[1].query, { chapter: '4', cast: 'pell:appears,maren-hollis:pov' });
  const noChapter = await tool('codex_continuity_check', { cast: [{ entry: 'pell', role: 'appears' }] });
  assert.equal(noChapter.isError, true);
  assert.match(noChapter.content[0].text, /cast needs a chapter/);
  const badRole = await tool('codex_continuity_check', { chapter: 1, cast: [{ entry: 'pell', role: 'king' }] });
  assert.equal(badRole.isError, true);
  assert.equal(calls.length, 2, 'refused calls make no request');
});

test('codex_dismiss_finding posts the fingerprint and the reason; both are required', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  const r = await tool('codex_dismiss_finding', { fingerprint: FP, reason: 'On purpose.' });
  assert.equal(r.isError, undefined);
  assert.deepEqual([calls[0].method, calls[0].path, calls[0].body], ['POST', `${BOOK}/continuity/exceptions`, { fingerprint: FP, reason: 'On purpose.' }]);
  assert.equal((await tool('codex_dismiss_finding', { fingerprint: FP })).isError, true);
  assert.equal((await tool('codex_dismiss_finding', { reason: 'x' })).isError, true);
  assert.equal(calls.length, 1);
  const none = setup(['read', 'plan']);
  const refused = await none.tool('codex_dismiss_finding', { fingerprint: FP, reason: 'x' });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, 'this token lacks the "workspace" permission');
  assert.equal(none.calls.length, 0);
});

test('codex_restore_finding takes the slug directly, or finds it from the fingerprint', async () => {
  const { calls, tool } = setup(['read', 'workspace']);
  await tool('codex_restore_finding', { finding: 'green-eyes' });
  assert.deepEqual([calls[0].method, calls[0].path], ['POST', `${BOOK}/continuity/exceptions/green-eyes/archive`]);
  await tool('codex_restore_finding', { finding: FP });
  assert.deepEqual(calls.slice(1).map((c) => [c.method, c.path]), [['GET', `${BOOK}/continuity`], ['POST', `${BOOK}/continuity/exceptions/green-eyes/archive`]]);
  const unknown = await tool('codex_restore_finding', { finding: 'kn1-0123456789abcdef' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no dismissed finding has that fingerprint/);
  assert.equal(calls.length, 4, 'no archive call for an unknown fingerprint');
});
