// `storyforge db migrate|import|export|status` against a PGlite folder database: a dry run prints the report and writes nothing, --write imports,
// status reports it, export writes the library back to a new folder. The fixture is copied to a temp folder first (the source is never written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN } from './proc-helpers.mjs';

const FIXTURE = fileURLToPath(new URL('../../../packages/format/fixtures/hosted-import/', import.meta.url));

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, 'db', ...args], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

test('db: migrate, dry-run import, import --write, status, export', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-db-cli-'));
  try {
    const source = path.join(tmp, 'source');
    await fs.cp(FIXTURE, source, { recursive: true });
    const shared = path.join(source, 'shared-data');
    const url = `pglite:${path.join(tmp, 'pgdata')}`;
    const db = ['--database', url];

    // usage errors
    assert.equal((await run(['import', source])).code, 2); // no --database
    assert.equal((await run(['frobnicate', ...db])).code, 2);
    assert.equal((await run(['status', ...db, '--write'])).code, 2);

    const m = await run(['migrate', ...db]);
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /applied 1: 001-document-store\.sql/);
    const m2 = await run(['migrate', ...db]);
    assert.equal(m2.code, 0, m2.stderr);
    assert.match(m2.stdout, /nothing to apply/);

    // dry run: a readable report, nothing written
    const d = await run(['import', source, '--shared-data', shared, ...db]);
    assert.equal(d.code, 0, d.stderr);
    for (const s of ['fingerprint', 'documents by kind', 'scene', 'books', 'saltmarsh/salt-orchard', 'E301', 'restore points: 6 found, 4 kept', 'audit.jsonl: 4 lines', 'Dry run only']) assert.ok(d.stdout.includes(s), `report mentions ${s}`);
    const s0 = await run(['status', ...db]);
    assert.equal(s0.code, 0, s0.stderr);
    assert.match(s0.stdout, /files\s+0 /);
    assert.match(s0.stdout, /last operations: none/);

    // --write imports; the same folder again is unchanged
    const w = await run(['import', source, '--shared-data', shared, '--write', ...db]);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /Imported \d+ files into library "main"/);
    const w2 = await run(['import', source, '--shared-data', shared, '--write', ...db]);
    assert.equal(w2.code, 0, w2.stderr);
    assert.match(w2.stdout, /already imported/);

    // a different folder is refused
    await fs.writeFile(path.join(source, 'library.md'), `${await fs.readFile(path.join(source, 'library.md'), 'utf8')}\nedited\n`);
    const refused = await run(['import', source, '--shared-data', shared, '--write', ...db]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /refused/);

    const s1 = await run(['status', ...db]);
    assert.equal(s1.code, 0, s1.stderr);
    assert.match(s1.stdout, /applied\s+001-document-store\.sql/);
    assert.match(s1.stdout, /files\s+[1-9]\d* /);
    assert.match(s1.stdout, /\simport\s+import-[0-9a-f]{16}/);

    // export to a new folder (and a second library id stays separate)
    const out = path.join(tmp, 'out');
    const sharedOut = path.join(tmp, 'shared-out');
    const e = await run(['export', out, '--shared-out', sharedOut, ...db]);
    assert.equal(e.code, 0, e.stderr);
    assert.match(e.stdout, /exported \d+ files, \d+ empty folders and 4 restore points/);
    assert.ok((await fs.stat(path.join(out, 'library.md'))).isFile());
    assert.ok((await fs.stat(path.join(sharedOut, 'audit.jsonl'))).isFile());
    const again = await run(['export', out, ...db]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /not empty/);
    const other = await run(['status', ...db, '--library-id', 'other']);
    assert.match(other.stdout, /files\s+0 /);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('db: a password in the database URL is never printed', async () => {
  const r = await run(['status', '--database', 'postgres://writer:s3cret-pw@127.0.0.1:1/none']);
  assert.equal(r.code, 1);
  assert.ok(!(r.stdout + r.stderr).includes('s3cret-pw'));
});
