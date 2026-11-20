// The shared-mode CLIs and library switching with `--database` (H0 section 2.0): `shared init` writes the owner into the database (not only a folder that the
// next `serve --database` would wipe), `audit verify` checks the database's lines, and a database server refuses to open another library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { createDocumentStore, openDatabase } from '../../../packages/db/src/index.mjs';
import { openSharedData } from '../../../packages/shared/src/index.mjs';
import { startDatabaseMode } from '../src/db-serve.mjs';
import { asMember } from './plugin-helpers.mjs';
import { bootDb, closeAll, freshDatabaseUrl, importInto, tempDir } from './db-helpers.mjs';
import { runCli } from './proc-helpers.mjs';

after(closeAll);

test('shared init --database puts the owner in the database; serve --database then sees it; audit verify reads the database', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url); // a library and NO shared data
  const sharedDir = await tempDir('sf-dbshared-sd-');
  const copy = await tempDir('sf-dbshared-copy-');

  const init = await runCli(['shared', 'init', '--owner', 'ilse', '--library', copy, '--shared-data', sharedDir, '--database', url]);
  assert.equal(init.code, 0, init.output);
  assert.match(init.stdout, /Owner "ilse" created/);
  assert.match(init.stdout, /\/setup#token=/);

  const verify = await runCli(['audit', 'verify', '--shared-data', sharedDir, '--database', url]);
  assert.equal(verify.code, 0, verify.output);
  assert.match(verify.stdout, /audit: 1 line, the chain is intact/);

  // the database holds the documents, and the next startup (which rebuilds the shared folder from the database) keeps the owner
  const mode = await startDatabaseMode({ url, libraryRoot: copy, sharedDir, log: () => {} });
  try {
    const members = await mode.store.readShared('members.json');
    assert.ok(members, 'the shared_doc row exists');
    assert.ok((await mode.store.readShared('users.json')) ?? members);
    assert.equal((await mode.store.readSharedLines('audit.jsonl')).length, 1);
    await fs.rm(path.join(sharedDir, 'members.json'), { force: true }); // wiped on disk: startup restores it from the database
  } finally {
    await mode.close();
  }
  const again = await startDatabaseMode({ url, libraryRoot: copy, sharedDir, log: () => {} });
  try {
    const data = await openSharedData(sharedDir);
    assert.ok(data.listMembers().some((m) => m.role === 'owner'), 'the owner survives the rebuild');
  } finally {
    await again.close();
  }

  // reset-owner works on the database too (the library lock is free again)
  const reset = await runCli(['shared', 'reset-owner', '--owner', 'ilse', '--library', copy, '--shared-data', sharedDir, '--database', url]);
  assert.equal(reset.code, 0, reset.output);
  const db = await openDatabase(url);
  try {
    assert.equal((await createDocumentStore(db, 'main').readSharedLines('audit.jsonl')).length, 2);
  } finally {
    await db.close();
  }

  assert.equal((await runCli(['shared', 'init', '--owner', 'x', '--shared-data', sharedDir, '--library-id', 'other'])).code, 2);
});

test('a database server refuses to open another library (409 DATABASE_MODE)', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const t = await bootDb({ url });
  try {
    const other = await tempDir('sf-dbshared-other-');
    const r = await asMember(t.port, 'POST', '/api/library/open', { path: other });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(r.json, { ok: false, code: 'DATABASE_MODE', message: 'This server serves one library from its database.' });
  } finally {
    await t.stop();
  }
});
