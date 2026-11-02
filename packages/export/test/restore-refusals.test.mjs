// M05-J03 acceptance 7: restoreBackup refuses hostile or damaged archives as a whole and writes NOTHING: the target
// stays absent (or empty) and no temp sibling is left behind. The malicious zips are built here, from a real backup of
// salt-orchard, by helpers.mjs (an independent zip writer that can lie in headers).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from '../src/index.mjs';
import { cleanup, copyBook, readAll, readZip, rewriteZip, tmpDir, writeZip } from './helpers.mjs';

after(cleanup);

let good; // a valid backup
before(async () => {
  good = (await createBackup(copyBook(), { now: new Date('2026-03-04T12:00:00Z') })).bytes;
});

/** A fresh parent holding nothing; `target` inside it is absent. */
function arena({ existingEmptyTarget = false } = {}) {
  const parent = tmpDir();
  const target = path.join(parent, 'restored');
  if (existingEmptyTarget) fs.mkdirSync(target);
  return { parent, target };
}

/** Restore must reject, and leave the arena exactly as it found it. */
async function refused(bytes, { opts, expectCode, existingEmptyTarget = false, also = [] } = {}) {
  const { parent, target } = arena({ existingEmptyTarget });
  const before = fs.readdirSync(parent).sort();
  let err;
  try {
    await (opts === undefined ? restoreBackup(bytes, target) : restoreBackup(bytes, target, opts));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'restoreBackup must reject this archive');
  assert.ok(err instanceof Error && err.message, 'a readable error');
  if (expectCode) assert.equal(err.code, expectCode);
  assert.deepEqual(fs.readdirSync(parent).sort(), before, 'nothing written next to or instead of the target (no temp sibling)');
  if (existingEmptyTarget) assert.deepEqual(fs.readdirSync(target), [], 'the empty target is still empty');
  else assert.ok(!fs.existsSync(target), 'the target was not created');
  for (const p of also) assert.ok(!fs.existsSync(p), `${p} must not exist`);
  return err;
}

const withExtra = (extra, { comment } = {}) =>
  rewriteZip(good, (entries, c) => ({ entries: [...entries, ...[].concat(extra)], comment: comment ?? c }));

test('sanity: the unmodified backup restores (so the refusals below are caused by the mutation)', async () => {
  const { target } = arena();
  const r = await restoreBackup(good, target);
  assert.deepEqual(r.diagnostics, []);
  // and a zip rebuilt by the test writer without any change is accepted too
  const rebuilt = rewriteZip(good, () => undefined);
  const { target: t2 } = arena();
  await restoreBackup(rebuilt, t2);
  assert.equal(readAll(t2, { skip: [] }).size, readAll(target, { skip: [] }).size);
});

// ---------------------------------------------------------------- zip-slip and unsafe names

const PID = process.pid;
const slipNames = [
  ['dot-dot segment', `../sf-slip-up-${PID}.txt`],
  ['nested dot-dot out of the target', `salt-orchard/../../sf-slip-nested-${PID}.txt`],
  ['deep dot-dot', `../../../sf-slip-deep-${PID}.txt`],
  ['absolute path', `/sf-slip-abs-${PID}.txt`],
  ['Windows drive path with backslash', `C:\\sf-slip-drive-${PID}.txt`],
  ['Windows drive path with slash', `C:/sf-slip-drive2-${PID}.txt`],
  ['backslash traversal', `a\\..\\b-${PID}.txt`],
  ['backslash in an otherwise innocent name', `salt-orchard\\book-${PID}.md`],
  ['UNC path', `//server/share/sf-slip-${PID}.txt`],
  ['NUL byte', `salt-orchard/ok-${PID}.md\0.txt`],
  ['dot-dot in the middle', `salt-orchard/research/../../x-${PID}.md`],
];
for (const [label, name] of slipNames) {
  test(`zip-slip: ${label} (${JSON.stringify(name)}) rejects the whole archive and writes nothing`, async () => {
    const { parent } = arena();
    const escapes = [
      path.resolve(parent, '..', `sf-slip-up-${PID}.txt`),
      path.resolve(parent, '..', `sf-slip-nested-${PID}.txt`),
      path.resolve(parent, '..', '..', `sf-slip-deep-${PID}.txt`),
      path.resolve(os.tmpdir(), '..', `sf-slip-deep-${PID}.txt`),
      path.resolve('/', `sf-slip-abs-${PID}.txt`),
      path.resolve('C:\\', `sf-slip-drive-${PID}.txt`),
      path.resolve('C:\\', `sf-slip-drive2-${PID}.txt`),
    ];
    const evil = writeZip(
      [...readZip(good).entries.map((e) => ({ name: e.name, data: e.data })), { name, data: Buffer.from('pwned') }],
      { comment: readZip(good).comment },
    );
    await refused(evil, { also: escapes });
    for (const p of escapes) assert.ok(!fs.existsSync(p), p);
  });
}

test('zip-slip: a hostile entry alone in an otherwise empty archive is refused too', async () => {
  await refused(writeZip([{ name: '../only-evil.txt', data: Buffer.from('x') }], { comment: '{"storyforge_backup":1}' }));
});

test('zip-slip: the same refusal holds when the target is an existing empty directory (it stays empty)', async () => {
  await refused(withExtra({ name: '../x.txt', data: Buffer.from('x') }), { existingEmptyTarget: true });
});

// ---------------------------------------------------------------- symlinks, duplicates, methods

test('a symlink entry (Unix external attributes 0120777) is refused', async () => {
  const link = { name: 'salt-orchard/link-to-secret', data: Buffer.from('/etc/passwd'), method: 0, versionMadeBy: (3 << 8) | 20, extAttr: ((0o120777 << 16) | 0x20) >>> 0 };
  await refused(withExtra(link));
});

test('a symlink entry is refused even when it is the only suspicious thing and has a harmless target', async () => {
  const link = { name: 'salt-orchard/notes-link', data: Buffer.from('book.md'), method: 8, versionMadeBy: (3 << 8) | 20, extAttr: ((0o120755 << 16) | 0x20) >>> 0 };
  await refused(withExtra(link));
});

test('duplicate entry names are refused', async () => {
  const first = readZip(good).entries.find((e) => !e.name.endsWith('/'));
  await refused(withExtra({ name: first.name, data: Buffer.from('second copy') }));
});

test('names that differ only by case are duplicates (case-insensitive) and refused', async () => {
  const first = readZip(good).entries.find((e) => e.name === 'salt-orchard/book.md');
  await refused(withExtra({ name: 'salt-orchard/BOOK.md', data: first.data }));
  await refused(withExtra([{ name: 'salt-orchard/research/NEW.md', data: Buffer.from('a') }, { name: 'salt-orchard/Research/new.md', data: Buffer.from('b') }]));
});

for (const method of [12, 9, 14, 99]) {
  test(`compression method ${method} (not stored or deflate) is refused`, async () => {
    await refused(withExtra({ name: 'salt-orchard/odd.bin', data: Buffer.from('payload'), method }));
  });
}

// ---------------------------------------------------------------- limits

test('more than 20 000 entries is refused (real archive of 20 001 tiny files)', async () => {
  const entries = [];
  for (let i = 0; i < 20001; i++) entries.push({ name: `salt-orchard/bulk/f${i}.txt`, data: Buffer.alloc(0), method: 0 });
  await refused(writeZip(entries, { comment: '{"storyforge_backup":1}' }));
});

test('an injected small entry limit is honoured (maxEntries; contract names no option, aliases are all passed)', async () => {
  const n = readZip(good).entries.length;
  assert.ok(n > 5);
  const limit = n - 1;
  await refused(good, { opts: { maxEntries: limit, entryLimit: limit, limits: { maxEntries: limit, entries: limit }, maxFiles: limit } });
  // and exactly at the limit it is accepted
  const { target } = arena();
  const r = await restoreBackup(good, target, { maxEntries: n, entryLimit: n, limits: { maxEntries: n, entries: n }, maxFiles: n });
  assert.deepEqual(r.diagnostics, []);
});

test('a single entry larger than 200 MB uncompressed is refused (zip bomb: ~200 KB on the wire)', async () => {
  const big = Buffer.alloc(200 * 1024 * 1024 + 1);
  const bomb = writeZip([...readZip(good).entries.map((e) => ({ name: e.name, data: e.data })), { name: 'salt-orchard/bomb.bin', data: big }], { comment: readZip(good).comment });
  assert.ok(bomb.length < 5 * 1024 * 1024, 'the test archive is small');
  await refused(bomb);
});

test('headers that claim more than 2 GB in total are refused before anything is inflated', async () => {
  const entries = [];
  for (let i = 0; i < 11; i++) entries.push({ name: `salt-orchard/claim${i}.bin`, data: Buffer.from('tiny'), fake: { usize: 199 * 1024 * 1024 } });
  await refused(writeZip(entries, { comment: '{"storyforge_backup":1}' }));
});

test('a header that claims an entry over 200 MB is refused', async () => {
  await refused(withExtra({ name: 'salt-orchard/claim.bin', data: Buffer.from('tiny'), fake: { usize: 300 * 1024 * 1024 } }));
});

// ---------------------------------------------------------------- manifest and damage

test('a wrong manifest hash is BACKUP_CORRUPT and nothing is written', async () => {
  const bad = rewriteZip(good, (entries, comment) => {
    const m = JSON.parse(comment);
    m.sha256 = (m.sha256[0] === '0' ? '1' : '0') + m.sha256.slice(1);
    return { entries, comment: JSON.stringify(m) };
  });
  await refused(bad, { expectCode: 'BACKUP_CORRUPT' });
});

test('a file changed after the backup was made (valid CRC, manifest unchanged) is BACKUP_CORRUPT', async () => {
  const bad = rewriteZip(good, (entries) => {
    const e = entries.find((x) => x.name === 'salt-orchard/book.md');
    e.data = Buffer.concat([e.data, Buffer.from('\nInjected after the fact.\n')]);
  });
  await refused(bad, { expectCode: 'BACKUP_CORRUPT' });
});

test('a file missing from the archive (manifest still counts it) is BACKUP_CORRUPT', async () => {
  const bad = rewriteZip(good, (entries) => ({ entries: entries.filter((e) => e.name !== 'salt-orchard/research/tidal-ranges.md') }));
  await refused(bad, { expectCode: 'BACKUP_CORRUPT' });
});

test('an extra file added to the archive (manifest does not list it) is BACKUP_CORRUPT', async () => {
  await refused(withExtra({ name: 'salt-orchard/planted.md', data: Buffer.from('planted') }), { expectCode: 'BACKUP_CORRUPT' });
});

test('a zip with no manifest comment is refused', async () => {
  await refused(rewriteZip(good, () => ({ comment: '' })));
});

test('a manifest comment that is not JSON, or has the wrong format version, is refused', async () => {
  await refused(rewriteZip(good, () => ({ comment: 'this is not json' })));
  await refused(rewriteZip(good, (entries, comment) => ({ comment: JSON.stringify({ ...JSON.parse(comment), storyforge_backup: 2 }) })));
});

test('a truncated zip (half of it) is refused', async () => {
  await refused(good.subarray(0, Math.floor(good.length / 2)));
});

test('a truncated zip (end-of-central-directory and manifest chopped off) is refused', async () => {
  await refused(good.subarray(0, good.length - 40));
  await refused(good.subarray(0, good.length - 1));
});

test('not a zip at all: empty buffer, random text and a PDF header are refused', async () => {
  await refused(Buffer.alloc(0));
  await refused(Buffer.from('hello, this is not a zip file at all'));
  await refused(Buffer.from('%PDF-1.4\n%%EOF\n'));
});

test('a corrupt deflate stream or CRC mismatch inside an entry is refused', async () => {
  const z = readZip(good);
  const target = z.entries.find((e) => e.method === 8 && e.csize > 20);
  assert.ok(target, 'the backup has a deflated entry');
  const corrupt = Buffer.from(good);
  corrupt[target.dataOffset + 5] ^= 0xff;
  corrupt[target.dataOffset + 6] ^= 0xff;
  await refused(corrupt);
});

test('an entry whose name is the book folder prefix itself with an empty file name is refused or harmless but never writes outside', async () => {
  const { parent, target } = arena();
  const evil = withExtra({ name: 'salt-orchard//../../sf-slip-empty-' + PID, data: Buffer.from('x') });
  await assert.rejects(async () => restoreBackup(evil, target));
  assert.ok(!fs.existsSync(path.resolve(parent, '..', 'sf-slip-empty-' + PID)));
});
