// H0 §2.0: database mode never deletes shared-mode data the database has not seen. A --shared-data folder that holds files while the database holds
// no shared documents (accounts that were never imported) is refused at start, for `serve --database` and for the shared-mode CLIs alike.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseStartError, openSharedDatabase, startDatabaseMode } from '../src/db-serve.mjs';
import { closeAll, freshDatabaseUrl, importInto, tempDir } from './db-helpers.mjs';

after(closeAll);

async function sharedDirWithAccounts() {
  const dir = await tempDir('sf-shared-');
  await fs.writeFile(path.join(dir, 'users.json'), '{"version":1,"users":[]}\n');
  return dir;
}

test('serve --database refuses a shared-data folder whose data was never imported, and leaves it untouched', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url); // the library only, no --shared-data
  const sharedDir = await sharedDirWithAccounts();
  const copy = await tempDir('sf-copy-');
  await assert.rejects(
    startDatabaseMode({ url, libraryRoot: copy, sharedDir, log: () => {} }),
    (e) => e instanceof DatabaseStartError && /users\.json/.test(e.message) && /import it first/.test(e.message),
  );
  assert.equal(await fs.readFile(path.join(sharedDir, 'users.json'), 'utf8'), '{"version":1,"users":[]}\n', 'the accounts file is still there');
});

test('the shared-mode CLIs refuse the same folder', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const sharedDir = await sharedDirWithAccounts();
  await assert.rejects(openSharedDatabase({ url, sharedDir }), (e) => e instanceof DatabaseStartError && /not in the database/.test(e.message));
  assert.ok(await fs.stat(path.join(sharedDir, 'users.json')));
});

test('an empty shared-data folder is fine (a fresh setup)', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const handle = await openSharedDatabase({ url, sharedDir: await tempDir('sf-shared-empty-') });
  await handle.close();
});
