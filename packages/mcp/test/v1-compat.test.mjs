// Golden pin of the MCP tool surface: every tool's name, title, needed permission, input schema and annotations, plus the NOT_OFFERED list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NOT_OFFERED, TOOLS } from '../src/index.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'mcp-tools.json');
const CMD = 'UPDATE_GOLDEN=1 npm test -w @storyforge/mcp  (or: UPDATE_GOLDEN=1 node --test packages/mcp/test/v1-compat.test.mjs)';

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function surface() {
  const tools = TOOLS.map(({ name, title, need, inputSchema, annotations }) => ({ name, title, need, inputSchema, annotations })).sort(byName);
  return JSON.parse(JSON.stringify({ tools, notOffered: [...NOT_OFFERED] }));
}

test('the MCP tool table and NOT_OFFERED list match the golden', () => {
  const actual = surface();
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const g = new Map(golden.tools.map((t) => [t.name, t]));
  const a = new Map(actual.tools.map((t) => [t.name, t]));
  const hints = [
    ...[...a.keys()].filter((n) => !g.has(n)).map((n) => `added tool ${n}`),
    ...[...g.keys()].filter((n) => !a.has(n)).map((n) => `removed tool ${n}`),
    ...[...a.keys()].filter((n) => g.has(n) && JSON.stringify(g.get(n)) !== JSON.stringify(a.get(n))).map((n) => `changed tool ${n}`),
  ];
  try {
    assert.deepEqual(actual, golden);
  } catch (e) {
    e.message = `The MCP surface changed: ${hints.slice(0, 8).join('; ') || 'notOffered list changed'}.\nIf intended, regenerate with: ${CMD}\n\n${e.message}`;
    throw e;
  }
});
