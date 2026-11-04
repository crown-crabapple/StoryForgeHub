// The stdio transport of `storyforge mcp`: newline-delimited JSON in, newline-delimited JSON out, one line at a time and in order. stdout is the protocol channel, so
// nothing but protocol replies is ever written to `output`. readline over a stream is not network.
import { createInterface } from 'node:readline';

/**
 * Serve MCP over a pair of streams until `input` ends.
 * @param {{ input: import('node:stream').Readable, output: import('node:stream').Writable, send: (message: unknown) => Promise<unknown> }} streams
 * @returns {Promise<void>}
 */
export async function runStdio({ input, output, send }) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      continue;
    }
    const reply = await send(parsed);
    if (reply !== null && reply !== undefined) output.write(JSON.stringify(reply) + '\n');
  }
}
