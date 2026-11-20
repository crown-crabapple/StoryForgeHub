// Golden pin of the shape of every GET /api/v1 response (status plus a recursive type skeleton), so a storage rewrite cannot change a read response.
// The server runs over a copy of the salt-orchard fixture; a canvas and a task are created through the plugin's own write routes first (the fixture has none).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { V1 } from '../src/plugin-policy.mjs';
import { bootPersonal, closeAll } from './plugin-helpers.mjs';
import { CONCRETE, SKIPPED, checkReadShapes, shapeOf } from './v1-shapes-helpers.mjs';

after(closeAll);

test('shapeOf: the skeleton rules', () => {
  assert.deepEqual(shapeOf({ b: 1, a: [], c: [{ x: 'y', z: null }, { x: 1 }], d: true }), { a: [], b: 'number', c: [{ x: 'string', z: 'null' }], d: 'boolean' });
  assert.deepEqual(shapeOf([]), []);
  assert.equal(shapeOf(null), 'null');
});

test('the concrete request list covers every GET route of the table, and each request matches its route', () => {
  const gets = V1.filter((r) => r.method === 'GET');
  assert.deepEqual(gets.map((r) => r.re.source).filter((s) => !CONCRETE[s] && !SKIPPED.some((k) => k.route === s)), [], 'a GET route has no concrete request: add it to CONCRETE (or SKIPPED with a reason)');
  for (const r of gets) for (const u of CONCRETE[r.re.source] ?? []) assert.ok(r.re.test(u.split('?')[0]), `${u} does not match ${r.re.source}`);
});

test('every GET /api/v1 route keeps its status and response shape', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard', profile: 'v1-compat-shapes' });
  await checkReadShapes(t);
});
