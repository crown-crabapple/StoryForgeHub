// The GET /api/v1 read shapes on a database-backed server (H0 section 8a): the salt-orchard fixture is imported into a PGlite database, the server starts
// the way `serve --database` does (rebuilds its on-disk copy from the database), and every route must answer with the same status and shape as the golden
// apps/server/test/golden/v1-read-shapes.json that the file-backed run (v1-compat-shapes.test.mjs) is held to.
import { after, test } from 'node:test';
import path from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { bootDb, closeAll, freshDatabaseUrl, importInto } from './db-helpers.mjs';
import { checkReadShapes } from './v1-shapes-helpers.mjs';

after(closeAll);

test('every GET /api/v1 route keeps its status and response shape on a database-backed server', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url, { source: path.join(FIXTURES, 'valid', 'salt-orchard') });
  const t = await bootDb({ url, profile: 'v1-compat-db' });
  await checkReadShapes(t);
});
