<?php
/**
 * dump.php - read-only dumper for a legacy StoryForgeHub database (M06-J01).
 *
 *   php dump.php --dsn <PDO DSN> [--user U] [--password-env VAR] --out <new empty dir> [--now <ISO time>]
 *
 *   --dsn            e.g. "sqlite:/path/to/codex.sqlite" or "mysql:host=127.0.0.1;dbname=codex;charset=utf8mb4"
 *   --user           database user (MySQL/MariaDB)
 *   --password-env   NAME of an environment variable holding the password (never pass a password on the command line)
 *   --out            a folder that does not exist yet (or is empty); everything is written below it
 *   --now            fixed value for manifest.dumped_at (reproducible fixtures); default: the current UTC time
 *
 * Read-only: only SELECT / PRAGMA table_info / information_schema reads, inside a read-only transaction where the driver
 * supports it (MySQL/MariaDB: START TRANSACTION READ ONLY; SQLite: opened read-only, PRAGMA query_only). It discovers the
 * LIVE tables (never schema.sql, which is stale) and writes
 *
 *   <out>/tables/<table>.jsonl   one JSON object per row, columns as named; text/blob as UTF-8 strings, a value that is not
 *                                valid UTF-8 becomes {"$b64": "<base64>"}
 *   <out>/manifest.json          { dumper_version, driver, dumped_at, tables: { name: { rows, columns, sha256 } } }
 *
 * Secrets are never read: the tables api_tokens, password_resets, invites and oauth_* are listed in the manifest with their
 * row count and "skipped": "server-only" and nothing else. The users table keeps only id and display_name (attribution).
 * Other columns named password_hash, token, secret or code are dropped wherever they appear.
 */
const DUMPER_VERSION = 1;
const SERVER_ONLY_TABLES = ['api_tokens', 'password_resets', 'invites'];       // plus every oauth_* table
const USERS_KEEP = ['id', 'display_name'];
const SECRET_COLUMNS = ['password_hash', 'token', 'secret', 'code'];

function fail($msg, $code = 2) { fwrite(STDERR, "dump.php: $msg\n"); exit($code); }

$opt = getopt('', ['dsn:', 'user:', 'password-env:', 'out:', 'now:']);
if (empty($opt['dsn']) || empty($opt['out'])) fail("usage: php dump.php --dsn <PDO DSN> [--user U --password-env VAR] --out <new empty dir> [--now <ISO time>]");
$out = rtrim($opt['out'], '/\\');
if (is_dir($out)) {
    $entries = array_diff(scandir($out), ['.', '..']);
    if ($entries) fail("output folder is not empty: $out");
} elseif (file_exists($out)) {
    fail("output path exists and is not a folder: $out");
}
$password = null;
if (!empty($opt['password-env'])) {
    $password = getenv($opt['password-env']);
    if ($password === false) fail("environment variable {$opt['password-env']} is not set");
}

$dsn = $opt['dsn'];
$isSqlite = stripos($dsn, 'sqlite:') === 0;
$options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC];
if ($isSqlite) {
    // open the database file read-only at the driver level where this PHP supports it
    if (defined('Pdo\\Sqlite::ATTR_OPEN_FLAGS') && defined('Pdo\\Sqlite::OPEN_READONLY')) $options[constant('Pdo\\Sqlite::ATTR_OPEN_FLAGS')] = constant('Pdo\\Sqlite::OPEN_READONLY');
    elseif (defined('PDO::SQLITE_ATTR_OPEN_FLAGS') && defined('PDO::SQLITE_OPEN_READONLY')) $options[constant('PDO::SQLITE_ATTR_OPEN_FLAGS')] = constant('PDO::SQLITE_OPEN_READONLY');
    $path = substr($dsn, strlen('sqlite:'));
    if ($path !== ':memory:' && !is_file($path)) fail("SQLite file not found: $path");   // PDO would otherwise create an empty database
}
try {
    $pdo = new PDO($dsn, $opt['user'] ?? null, $password, $options);
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite') { $pdo->exec('PRAGMA query_only = 1'); $pdo->exec('BEGIN'); }
    else { $pdo->exec('SET SESSION TRANSACTION READ ONLY'); $pdo->exec('START TRANSACTION READ ONLY'); }
} catch (Throwable $e) { fail('cannot open the database: ' . $e->getMessage()); }

function quote_ident($driver, $name) {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) fail("unexpected table or column name: $name");
    return $driver === 'sqlite' ? "\"$name\"" : "`$name`";
}
function is_server_only($table) { return in_array($table, SERVER_ONLY_TABLES, true) || strpos($table, 'oauth_') === 0; }

/** A database value as JSON-ready: strings that are not valid UTF-8 become {"$b64": ...}; blobs may arrive as streams. */
function json_value($v) {
    if (is_resource($v)) $v = stream_get_contents($v);
    if (is_string($v) && !preg_match('//u', $v)) return ['$b64' => base64_encode($v)];
    return $v;
}

// ---- discover the live tables
if ($driver === 'sqlite') {
    $tables = array_column($pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")->fetchAll(), 'name');
} else {
    $tables = array_column($pdo->query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")->fetchAll(), 'name');
}
sort($tables, SORT_STRING);

if (!is_dir($out) && !mkdir($out . '/tables', 0777, true)) fail("cannot create $out");
if (!is_dir($out . '/tables') && !mkdir($out . '/tables', 0777, true)) fail("cannot create $out/tables");

$manifest = [
    'dumper_version' => DUMPER_VERSION,
    'driver' => $driver,
    'dumped_at' => !empty($opt['now']) ? $opt['now'] : gmdate('Y-m-d\TH:i:s\Z'),
    'tables' => [],
];

foreach ($tables as $table) {
    $q = quote_ident($driver, $table);
    $count = (int) $pdo->query("SELECT COUNT(*) FROM $q")->fetchColumn();
    if (is_server_only($table)) {
        $manifest['tables'][$table] = ['rows' => $count, 'skipped' => 'server-only'];
        continue;
    }
    if ($driver === 'sqlite') {
        $cols = array_column($pdo->query("PRAGMA table_info($q)")->fetchAll(), 'name');
    } else {
        $st = $pdo->prepare('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position');
        $st->execute([$table]);
        $cols = array_column($st->fetchAll(), 'name');
    }
    $keep = array_values(array_filter($cols, function ($c) use ($table) {
        if ($table === 'users') return in_array($c, USERS_KEEP, true);
        return !in_array(strtolower($c), SECRET_COLUMNS, true);
    }));
    $file = "$out/tables/$table.jsonl";
    $fh = fopen($file, 'wb');
    if (!$fh) fail("cannot write $file");
    $rows = 0;
    if ($keep) {
        $select = implode(', ', array_map(function ($c) use ($driver) { return quote_ident($driver, $c); }, $keep));
        $order = in_array('id', $keep, true) ? ' ORDER BY ' . quote_ident($driver, 'id') : '';
        $res = $pdo->query("SELECT $select FROM $q$order");
        while (($row = $res->fetch(PDO::FETCH_ASSOC)) !== false) {
            $obj = [];
            foreach ($keep as $c) $obj[$c] = json_value($row[$c]);
            $json = json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
            if ($json === false) fail("cannot encode a row of $table as JSON: " . json_last_error_msg(), 1);
            fwrite($fh, $json . "\n");
            $rows++;
        }
    }
    fclose($fh);
    $manifest['tables'][$table] = ['rows' => $rows, 'columns' => $keep, 'sha256' => hash_file('sha256', $file)];
}

if ($driver === 'sqlite') $pdo->exec('ROLLBACK'); else $pdo->exec('ROLLBACK');
$json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
file_put_contents("$out/manifest.json", $json . "\n");
fwrite(STDOUT, 'dumped ' . count($manifest['tables']) . " tables to $out\n");
