import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runStdio } from '../src/index.mjs';

/** @param {string} text @param {(m: unknown) => Promise<unknown>} send */
async function run(text, send) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  const done = runStdio({ input, output, send });
  input.end(text);
  await done;
  return out;
}

test('replies line by line, in order, skipping blanks and notifications', async () => {
  const seen = [];
  const out = await run('{"id":1}\n\n   \n{"note":true}\n{"id":2}\r\n', async (m) => {
    seen.push(m);
    await new Promise((r) => setTimeout(r, m.id === 1 ? 20 : 0));
    return m.note ? null : { jsonrpc: '2.0', id: m.id, result: {} };
  });
  assert.equal(seen.length, 3);
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
});

test('a line that is not JSON gets a parse error and the loop carries on', async () => {
  const out = await run('{oops\n{"id":3}\n', async (m) => ({ jsonrpc: '2.0', id: m.id, result: 1 }));
  assert.equal(out, '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}\n{"jsonrpc":"2.0","id":3,"result":1}\n');
});

test('empty input resolves with no output', async () => {
  assert.equal(await run('', async () => ({})), '');
});
