// Golden pin of the /api/v1 route table (method, path pattern, permission, book flag, AI level). A change to any permission or route must be deliberate.
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { V1 } from '../src/plugin-policy.mjs';
import { checkGolden } from './golden-helpers.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'v1-routes.json');

test('the /api/v1 route table matches the golden (permissions, methods, paths, levels)', () => {
  const actual = V1.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof RegExp ? v.source : v])));
  checkGolden(GOLDEN, actual, 'UPDATE_GOLDEN=1 node --import ./scripts/test-isolate-config.mjs --test apps/server/test/v1-compat-routes.test.mjs');
});
