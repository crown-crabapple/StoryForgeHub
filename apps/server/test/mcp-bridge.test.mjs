// The stdio MCP bridge (`storyforge mcp`): the loopback transport, the send function, the port flag and a full stdio round trip through main.mjs as a child process.
// A real server in this process over a copy of the fixture library; the bridge runs as its own process, the way Claude Code would start it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, test } from 'node:test';
import { postLoopback } from '../../../packages/mcp/src/index.mjs';
import { bridgePort, makeSend } from '../src/mcp-cli.mjs';
import { MAIN } from './proc-helpers.mjs';
import { REPO_ROOT } from './helpers.mjs';
import { SCENE, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

/** A port nothing listens on (bound and released). */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

/** Run `main.mjs mcp ...` with `env` over process.env, feed `lines` to stdin, close it, and collect everything (30 s cap). */
function runBridge(args, env, lines = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, 'mcp', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
    child.stdin.end(lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''));
  });
}

// ---------------------------------------------------------------- postLoopback

test('postLoopback: tools/list works against the running server', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const r = await postLoopback({ port: t.port, token, message: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 7);
  assert.equal(r.body.result.tools.length, 33);
  const note = await postLoopback({ port: t.port, token, message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.deepEqual({ ok: note.ok, status: note.status, body: note.body }, { ok: true, status: 202, body: null });
});

test('postLoopback: nothing listening is NOT_RUNNING, an impossible port is BAD_PORT, and the token never appears in the message', async () => {
  const port = await freePort();
  const token = 'tok_secret_value_123';
  const down = await postLoopback({ port, token, message: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'NOT_RUNNING');
  assert.equal(JSON.stringify(down).includes(token), false);
  for (const bad of [0, 70000, -1, 1.5, NaN]) {
    const r = await postLoopback({ port: bad, token, message: {} });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.code, 'BAD_PORT', String(bad));
  }
});

// ---------------------------------------------------------------- makeSend

test('makeSend: a request gets the JSON-RPC reply, a notification gets null, a bad token gets a -32001 error with the same id', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const send = makeSend(postLoopback, t.port, token);
  const reply = await send({ jsonrpc: '2.0', id: 'abc', method: 'ping' });
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 'abc', result: {} });
  assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

  const bad = makeSend(postLoopback, t.port, 'A'.repeat(43));
  const denied = await bad({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
  assert.equal(denied.jsonrpc, '2.0');
  assert.equal(denied.id, 42);
  assert.equal(denied.error.code, -32001);
  assert.match(denied.error.message, /401/);
  assert.equal(await bad({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a failed notification is still silent');

  const down = makeSend(postLoopback, await freePort(), token);
  const gone = await down({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal(gone.id, 3);
  assert.equal(gone.error.code, -32000);
});

// ---------------------------------------------------------------- bridgePort

test('bridgePort: --port is taken as given when it is a whole number from 1 to 65535, else null', async () => {
  assert.equal(await bridgePort(['--port', '5123']), 5123);
  assert.equal(await bridgePort(['--port', '1']), 1);
  assert.equal(await bridgePort(['--port', '65535']), 65535);
  for (const bad of ['x', '0', '65536', '-1', '1.5', '']) assert.equal(await bridgePort(['--port', bad]), null, JSON.stringify(bad));
});

// ---------------------------------------------------------------- the stdio command

test('stdio round trip: initialize, tools/list and a codex_get_scene call each get one reply with the same id, nothing else is on stdout, exit 0', async () => {
  const t = await bootPersonal();
  const { token } = await t.grant({ permissions: ['read'] });
  const r = await runBridge(['--port', String(t.port)], { STORYFORGE_TOKEN: token }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 'three', method: 'tools/call', params: { name: 'codex_get_scene', arguments: { book: SLUG, scene: SCENE } } },
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 3, `stdout was: ${r.stdout}`);
  const replies = lines.map((l) => JSON.parse(l));
  assert.deepEqual(replies.map((x) => x.id), [1, 2, 'three']);
  assert.ok(replies.every((x) => x.jsonrpc === '2.0' && x.error === undefined));
  assert.equal(replies[0].result.serverInfo.name, 'storyforge');
  assert.equal(replies[1].result.tools.length, 33);
  assert.notEqual(replies[2].result.isError, true);
  assert.match(replies[2].result.content.map((c) => c.text).join('\n'), /The ferry nudged the jetty/);
  assert.equal(r.stdout.includes(token), false);
  assert.equal(r.stderr.includes(token), false);
});

test('stdio: a bad token yields JSON-RPC errors on stdout (never a crash) and the token is not echoed', async () => {
  const t = await bootPersonal();
  const bad = 'A'.repeat(43);
  const r = await runBridge(['--port', String(t.port)], { STORYFORGE_TOKEN: bad }, [{ jsonrpc: '2.0', id: 9, method: 'tools/list' }]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  const reply = JSON.parse(lines[0]);
  assert.equal(reply.id, 9);
  assert.equal(reply.error.code, -32001);
  assert.equal(r.stdout.includes(bad), false);
});

test('stdio: without STORYFORGE_TOKEN the command exits 2 and writes nothing to stdout', async () => {
  const env = { STORYFORGE_TOKEN: '' };
  const r = await runBridge(['--port', '5123'], env, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /STORYFORGE_TOKEN/);
  // a token that does not look like one is refused the same way, and an unusable --port too
  const odd = await runBridge(['--port', '5123'], { STORYFORGE_TOKEN: 'has space' }, []);
  assert.equal(odd.code, 2);
  assert.equal(odd.stdout, '');
  const badPort = await runBridge(['--port', 'x'], { STORYFORGE_TOKEN: 'A'.repeat(43) }, []);
  assert.equal(badPort.code, 2);
  assert.equal(badPort.stdout, '');
});
