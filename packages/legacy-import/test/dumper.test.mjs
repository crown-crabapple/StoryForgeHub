// M06-J01 acceptance 6: tools/legacy-dump/dump.php on a SQLite database built here (synthetic rows, written with PDO through a scratch php.ini).
// Skipped with a message when PHP (or its pdo_sqlite extension) is unavailable. PHP 8.5 lives at C:\php; override with SF_PHP.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DUMP_PHP, listFilesRel, sha256, snapshot, tmpDir } from './helpers.mjs';

const PHP = process.env.SF_PHP || 'C:\\php\\php.exe';

// ---- PHP availability and a scratch php.ini (the stock ini has pdo_sqlite switched off) ---------------------------------------------
const iniDir = tmpDir('sf-li-phpini-');
fs.writeFileSync(
  path.join(iniDir, 'php.ini'),
  `extension_dir="${path.join(path.dirname(PHP), 'ext').replaceAll('\\', '/')}"\nextension=pdo_sqlite\nextension=sqlite3\nextension=mbstring\ndate.timezone=UTC\n`,
);
const php = (args, opts = {}) => spawnSync(PHP, args, { encoding: 'utf8', env: { ...process.env, PHPRC: iniDir }, timeout: 60_000, ...opts });

let skip = false;
{
  const probe = fs.existsSync(PHP) ? php(['-r', 'echo extension_loaded("pdo_sqlite") ? "ok" : "no";']) : null;
  if (!probe || probe.stdout !== 'ok') skip = `PHP with pdo_sqlite is not available (${PHP}); dumper tests skipped`;
}
if (skip) console.log(`# ${skip}`);

const SECRETS = {
  password: 'SECRETHASH-pw-1a2b3c',
  token: 'SECRETTOKEN-api-4d5e6f',
  invite: 'SECRETINVITE-7a8b9c',
  reset: 'SECRETRESET-0d1e2f',
  oauthSecret: 'SECRETOAUTH-3a4b5c',
  oauthCode: 'SECRETCODE-6d7e8f',
};

const BUILD_DB = `<?php
$db = new PDO('sqlite:' . $argv[1]);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec("CREATE TABLE books (id VARCHAR(40) PRIMARY KEY, folder TEXT, title TEXT, sort_order INT)");
$db->exec("CREATE TABLE chapters (id INTEGER PRIMARY KEY, book_id TEXT, num TEXT, title TEXT, body TEXT, sort_order INT)");
$db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, display_name TEXT, password_hash TEXT)");
$db->exec("CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, user_id INT, token_hash TEXT, label TEXT)");
$db->exec("CREATE TABLE invites (id INTEGER PRIMARY KEY, email TEXT, token TEXT)");
$db->exec("CREATE TABLE password_resets (id INTEGER PRIMARY KEY, user_id INT, token TEXT)");
$db->exec("CREATE TABLE oauth_clients (id INTEGER PRIMARY KEY, name TEXT, secret TEXT)");
$db->exec("CREATE TABLE oauth_codes (id INTEGER PRIMARY KEY, user_id INT, code TEXT)");
$db->exec("CREATE TABLE empty_thing (id INTEGER PRIMARY KEY, note TEXT)");
$ins = fn($sql, $rows) => array_map(fn($r) => $db->prepare($sql)->execute($r), $rows);
$ins("INSERT INTO books VALUES (?,?,?,?)", [['bk1', 'salt-test', 'Salt Test', 0], ['bk2', 'other', 'Other', 1]]);
$ins("INSERT INTO chapters VALUES (?,?,?,?,?,?)", [
  [1, 'bk1', '1', 'Arrival', "One.\\r\\n\\r\\n---\\r\\n\\r\\nTwo \\u{e9}\\u{4e2d}.\\n", 1],
  [2, 'bk1', '3.5', 'Interlude', "Bad bytes: \\xff\\xfe\\x80 end", 2],
  [3, 'bk2', '1', 'Elsewhere', '', 1],
]);
$ins("INSERT INTO users VALUES (?,?,?,?)", [[1, 'a@example.test', 'Test Author', '${SECRETS.password}'], [2, 'b@example.test', 'Second Author', '${SECRETS.password}-2']]);
$ins("INSERT INTO api_tokens VALUES (?,?,?,?)", [[1, 1, '${SECRETS.token}', 'laptop'], [2, 1, '${SECRETS.token}-2', 'phone'], [3, 2, '${SECRETS.token}-3', 'tablet']]);
$ins("INSERT INTO invites VALUES (?,?,?)", [[1, '', '${SECRETS.invite}']]);
$ins("INSERT INTO password_resets VALUES (?,?,?)", [[1, 1, '${SECRETS.reset}']]);
$ins("INSERT INTO oauth_clients VALUES (?,?,?)", [[1, 'client', '${SECRETS.oauthSecret}']]);
$ins("INSERT INTO oauth_codes VALUES (?,?,?)", [[1, 1, '${SECRETS.oauthCode}']]);
`;

function buildDb() {
  const dir = tmpDir('sf-li-db-');
  const script = path.join(tmpDir('sf-li-dbscript-'), 'build.php');
  fs.writeFileSync(script, BUILD_DB);
  const dbFile = path.join(dir, 'legacy.sqlite');
  const r = php([script, dbFile]);
  assert.equal(r.status, 0, `building the test database failed: ${r.stderr}${r.stdout}`);
  return { dir, dbFile };
}

function dump(dbFile, out, extra = []) {
  return php([DUMP_PHP, '--dsn', `sqlite:${dbFile}`, '--out', out, ...extra]);
}

const jsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const ctx = {};
function dumped() {
  if (!ctx.done) {
    const { dir, dbFile } = buildDb();
    const dbSnap = snapshot(dir);
    const out = tmpDir('sf-li-out-');
    const r = dump(dbFile, out);
    Object.assign(ctx, { done: true, dir, dbFile, dbSnap, out, r, dbAfter: snapshot(dir) });
  }
  return ctx;
}

test('dump.php succeeds and writes manifest.json plus tables/*.jsonl', { skip }, () => {
  const { r, out } = dumped();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(mf.dumper_version, 1);
  assert.match(String(mf.driver), /sqlite/i);
  assert.ok(typeof mf.dumped_at === 'string' && mf.dumped_at.length > 0);
  for (const t of ['books', 'chapters', 'users', 'empty_thing']) assert.ok(mf.tables[t], `table ${t} discovered from the live database`);
});

test('manifest row counts, columns and sha256 match the jsonl files', { skip }, () => {
  const { out } = dumped();
  const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const expectedRows = { books: 2, chapters: 3, empty_thing: 0 };
  for (const [t, n] of Object.entries(expectedRows)) {
    const file = path.join(out, 'tables', `${t}.jsonl`);
    assert.ok(fs.existsSync(file), `${t}.jsonl exists`);
    assert.equal(mf.tables[t].rows, n, `${t} manifest rows`);
    assert.equal(jsonl(file).length, n, `${t} jsonl rows`);
    assert.equal(mf.tables[t].sha256, sha256(fs.readFileSync(file)), `${t} sha256`);
  }
  assert.deepEqual([...mf.tables.chapters.columns].sort(), ['body', 'book_id', 'id', 'num', 'sort_order', 'title']);
  assert.deepEqual(Object.keys(jsonl(path.join(out, 'tables', 'chapters.jsonl'))[0]).sort(), [...mf.tables.chapters.columns].sort());
});

test('text round-trips as UTF-8 (CRLF and non-ASCII kept) and invalid UTF-8 becomes {"$b64": ...}', { skip }, () => {
  const { out } = dumped();
  const rows = jsonl(path.join(out, 'tables', 'chapters.jsonl'));
  const one = rows.find((r) => String(r.id) === '1');
  assert.equal(one.body, 'One.\r\n\r\n---\r\n\r\nTwo \u00e9\u4e2d.\n');
  const bad = rows.find((r) => String(r.id) === '2');
  assert.equal(typeof bad.body, 'object');
  assert.deepEqual(Buffer.from(bad.body.$b64, 'base64'), Buffer.from('Bad bytes: \xff\xfe\x80 end', 'latin1'));
  assert.equal(rows.find((r) => String(r.id) === '3').body, '');
});

test('users keep only id and display name; no password or email is dumped', { skip }, () => {
  const { out } = dumped();
  const rows = jsonl(path.join(out, 'tables', 'users.jsonl'));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['display_name', 'id']);
  assert.deepEqual(rows.map((r) => r.display_name), ['Test Author', 'Second Author']);
});

test('server-only tables are listed with their row count and skipped: server-only, and have no data file', { skip }, () => {
  const { out } = dumped();
  const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const expected = { api_tokens: 3, invites: 1, password_resets: 1, oauth_clients: 1, oauth_codes: 1 };
  for (const [t, n] of Object.entries(expected)) {
    assert.equal(mf.tables[t]?.skipped, 'server-only', t);
    assert.equal(mf.tables[t].rows, n, `${t} rows`);
    assert.ok(!fs.existsSync(path.join(out, 'tables', `${t}.jsonl`)), `${t}.jsonl must not exist`);
  }
});

test('no secret value appears anywhere in the dump output', { skip }, () => {
  const { out } = dumped();
  const all = listFilesRel(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!all.includes(value), `${name} secret leaked into the dump`);
  assert.ok(!all.includes('example.test'), 'emails are not part of the dump');
});

test('the database file is read-only to the dumper: bytes, mtime and its folder are unchanged', { skip }, () => {
  const { dbSnap, dbAfter } = dumped();
  assert.deepEqual(dbAfter, dbSnap);
});

test('dump output is deterministic apart from dumped_at', { skip }, () => {
  const { dbFile, out } = dumped();
  const out2 = tmpDir('sf-li-out2-');
  assert.equal(dump(dbFile, out2).status, 0);
  const strip = (dir) => {
    const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    delete mf.dumped_at;
    return JSON.stringify(mf);
  };
  assert.equal(strip(out2), strip(out));
  assert.deepEqual(listFilesRel(out2), listFilesRel(out));
  for (const f of listFilesRel(out).filter((x) => x.startsWith('tables/'))) assert.deepEqual(fs.readFileSync(path.join(out2, f)), fs.readFileSync(path.join(out, f)), f);
});

test('refuses an output directory that already has content, and leaves it alone', { skip }, () => {
  const { dbFile } = dumped();
  const out = tmpDir('sf-li-busy-');
  fs.writeFileSync(path.join(out, 'keep.txt'), 'KEEP');
  const r = dump(dbFile, out);
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(out), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'KEEP');
});

test('an unreadable DSN fails with a non-zero exit and writes no manifest', { skip }, () => {
  const out = tmpDir('sf-li-bad-');
  const r = php([DUMP_PHP, '--dsn', `sqlite:${path.join(tmpDir('sf-li-nodb-'), 'does-not-exist', 'x.sqlite')}`, '--out', out]);
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(out, 'manifest.json')));
});
