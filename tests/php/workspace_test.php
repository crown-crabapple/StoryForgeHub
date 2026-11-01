<?php
/**
 * workspace_test.php — fixture checks for the per-book Workspace (the
 * Claude-Book planning layer): path rules, create vs. hash-guarded update,
 * locks, append-only history, the virtual state/current, attributed
 * revisions, push import, search, and the Workspace/ export.
 *
 *   php tests/php/workspace_test.php                     # SQLite (needs pdo_sqlite)
 *   DB_DRIVER=mysql DB_NAME=<scratch db> ... php tests/php/workspace_test.php
 *     (a throwaway MariaDB database — the test creates tables in it)
 */
$useEnvDb = getenv('DB_DRIVER') === 'mysql';
$tmp = tempnam(sys_get_temp_dir(), 'codex_ws_') . '.sqlite';
if (!$useEnvDb) { putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp); $_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp; }
$work = sys_get_temp_dir() . '/codex_ws_' . getmypid();
register_shutdown_function(function () use ($tmp, $work) {
    @unlink($tmp);
    if (is_dir($work)) { exec('rm -rf ' . escapeshellarg($work)); }
});

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }

migrate();
$alice = create_user('ws-alice-' . getmypid() . '@x.com', 'Alice', 'password1', 0);
$_SESSION['uid'] = $alice; $GLOBALS['__current_user'] = null; $GLOBALS['__acting_user'] = null;
$rb = create_book(['title' => 'Kethra Test ' . getmypid(), 'profile' => 'fiction']);
$bid = $rb['id'];

/* ---- paths ---- */
check('path normalizes case, .md and Workspace/ prefix', ws_norm_path('Workspace/Development/World/Region-Cut.md') === 'development/world/region-cut');
check('path rejects traversal', ws_norm_path('state/../../etc') === '');
check('path rejects junk characters', ws_norm_path('plan; drop') === '');
check('sections classify', ws_section('plan') === 'planning' && ws_section('development/x') === 'development'
      && ws_section('state/chapter-01/knowledge') === 'state' && ws_section('timeline/history') === 'timeline' && ws_section('misc') === 'other');

/* ---- create + hash-guarded update ---- */
$r = save_workspace_doc($bid, 'plan', "# Chapter plan\n\n## Chapter 01\n");
check('create a doc without a hash', $r['status'] === 'ok' && !empty($r['created']));
check('planning doc gets its label as title', get_workspace_doc($bid, 'plan')['title'] === 'Plan (outline)');
$r = save_workspace_doc($bid, 'plan', "# Clobber\n");
check('update without a hash is refused', $r['status'] === 'conflict');
$h = get_workspace_doc($bid, 'plan')['body_hash'];
$r = save_workspace_doc($bid, 'plan', "# Chapter plan\n\n## Chapter 01\n## Chapter 02\n", null, $h);
check('update with the fresh hash lands', $r['status'] === 'ok' && strpos(get_workspace_doc($bid, 'plan')['body'], 'Chapter 02') !== false);
$r = save_workspace_doc($bid, 'plan', "# Stale\n", null, $h);
check('update with a stale hash is refused', $r['status'] === 'conflict' && strpos(get_workspace_doc($bid, 'plan')['body'], 'Stale') === false);
$h = get_workspace_doc($bid, 'plan')['body_hash'];
check('no-op save reports no changes', save_workspace_doc($bid, 'plan', get_workspace_doc($bid, 'plan')['body'], null, $h)['msg'] === 'No changes.');

/* ---- revisions ---- */
$revs = get_workspace_revisions($bid, 'plan');
check('saves recorded deduped revisions', count($revs) === 2);
check('revision attributes the user and door', $revs[0]['saved_by_name'] === 'Alice' && $revs[0]['saved_via'] === 'web');
check('older revision holds the first body', strpos((string)get_workspace_revision($bid, (int)$revs[1]['id'])['body'], 'Chapter 02') === false);

/* ---- story state: virtual current + locks ---- */
save_workspace_doc($bid, 'state/chapter-00/situation', "# Before chapter 1\n");
save_workspace_doc($bid, 'state/chapter-01/situation', "# After chapter 1\n");
save_workspace_doc($bid, 'state/chapter-01/knowledge', "# Knowledge\n");
save_workspace_doc($bid, 'state/chapter-10/situation', "# After chapter 10\n");
check('latest state chapter sorts numerically', ws_latest_state_chapter($bid) === 'chapter-10');
$cur = get_workspace_doc($bid, 'state/current/situation');
check('state/current resolves to the newest snapshot', $cur && $cur['path'] === 'state/chapter-10/situation' && $cur['requested'] === 'state/current/situation');
check('state/current cannot be written', save_workspace_doc($bid, 'state/current/situation', 'x')['status'] === 'error');
check('lock a chapter folder', set_workspace_lock($bid, 'state/chapter-01', true) === 2);
$h = get_workspace_doc($bid, 'state/chapter-01/situation')['body_hash'];
check('locked doc refuses an update', save_workspace_doc($bid, 'state/chapter-01/situation', 'edit', null, $h)['status'] === 'locked');
check('locked doc refuses delete', delete_workspace_doc($bid, 'state/chapter-01/knowledge')['status'] === 'locked');
check('lock prefix does not spill into siblings', !(int)get_workspace_doc($bid, 'state/chapter-10/situation')['locked']);
set_workspace_lock($bid, 'state/chapter-01', false);
check('unlocked doc accepts the update', save_workspace_doc($bid, 'state/chapter-01/situation', "# Fixed\n", null, $h)['status'] === 'ok');

/* ---- append-only history ---- */
check('append creates a missing doc', append_workspace_doc($bid, 'timeline/history', "## Chapter 01\n- Emily lands")['status'] === 'ok');
check('append adds to the end', append_workspace_doc($bid, 'timeline/history', "## Chapter 02\n- The wall")['status'] === 'ok'
      && preg_match('/Emily lands\n\n## Chapter 02/', get_workspace_doc($bid, 'timeline/history')['body']));
$hh = get_workspace_doc($bid, 'timeline/history')['body_hash'];
check('rewriting append-only history is refused', save_workspace_doc($bid, 'timeline/history', "# Rewritten\n", null, $hh)['status'] === 'error');
$grow = get_workspace_doc($bid, 'timeline/history')['body'] . "\n## Chapter 03\n";
check('a save that only appends is allowed', save_workspace_doc($bid, 'timeline/history', $grow, null, $hh)['status'] === 'ok');

/* ---- delete keeps a final revision ---- */
save_workspace_doc($bid, 'development/world/region-cut', "# Region cut\n");
check('delete works', delete_workspace_doc($bid, 'development/world/region-cut')['status'] === 'ok' && !get_workspace_doc($bid, 'development/world/region-cut'));
check('delete records a final delete-kind revision', get_workspace_revisions($bid, 'development/world/region-cut')[0]['kind'] === 'delete');

/* ---- listing, push import, search ---- */
check('list with a prefix', count(get_workspace_docs($bid, 'state/chapter-01')) === 2 && count(get_workspace_docs($bid, 'state')) === 4);
$folder = get_book($bid)['folder'];
$rep = push_files(['books' => [['folder' => $folder, 'files' => [
    'Workspace/style.md' => "# Style Guide\n\nClose third, past tense.\n",
    'Workspace/development/characters/emily.md' => "# Emily\n\nProposal.\n",
    'Workspace/state/current/situation.md' => "virtual — must be skipped\n",
]]]]);
check('push imports Workspace/ docs', $rep['workspace'] === 2 && get_workspace_doc($bid, 'style') && get_workspace_doc($bid, 'development/characters/emily'));
check('push skips the virtual state/current', $rep['skipped'] === 1);
$hits = search_codex([$bid], 'past tense');
check('search finds workspace docs', (bool)array_filter($hits, function ($h) { return $h['kind'] === 'doc' && $h['path'] === 'style'; }));

/* ---- export ---- */
$exp = $work . '/export';
$env = $useEnvDb ? '' : 'DB_DRIVER=sqlite DB_PATH=' . escapeshellarg($tmp) . ' ';
exec($env . 'php ' . escapeshellarg(__DIR__ . '/../../bin/export.php') . ' --dir ' . escapeshellarg($exp)
     . ' --book ' . escapeshellarg($bid) . ' 2>&1', $out, $code);
check('bin/export.php exits clean', $code === 0);
check('export writes Workspace/<path>.md', is_file("$exp/$folder/Workspace/plan.md") && is_file("$exp/$folder/Workspace/state/chapter-10/situation.md")
      && strpos((string)file_get_contents("$exp/$folder/Workspace/timeline/history.md"), 'Chapter 03') !== false);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
