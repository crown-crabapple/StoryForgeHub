<?php
/**
 * import_knowledge_test.php — fixture checks for bin/import_knowledge.php: both
 * knowledge-doc shapes the state-updater has written (a cumulative "Known to
 * specific characters" list with chapter markers, and "New in chapter N"), name
 * aliases ("Emily" -> Emily Teague, "Bartleby" -> "Bartleby (the ship's
 * computer)", "Kroll" -> Vesna Kroll), multi-character lines, skipped beliefs
 * and restatements, unresolved groups, dry run vs --apply, and re-run safety.
 *
 *   php tests/php/import_knowledge_test.php                     # SQLite (needs pdo_sqlite)
 *   DB_DRIVER=mysql DB_NAME=<scratch db> ... php tests/php/import_knowledge_test.php
 *     (a throwaway, empty MariaDB database — the test creates tables in it)
 */
$useEnvDb = getenv('DB_DRIVER') === 'mysql';
$tmp = tempnam(sys_get_temp_dir(), 'codex_impk_') . '.sqlite';
if (!$useEnvDb) { putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp); $_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp; }
register_shutdown_function(function () use ($tmp) { @unlink($tmp); });

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }
function run_import($args) {   // the script runs in its own process, on the same DB env
    exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__DIR__ . '/../../bin/import_knowledge.php') . ' ' . $args . ' 2>&1', $out, $code);
    return [implode("\n", $out), $code];
}

migrate();
ensure_continuity();   // the dry run below never creates tables; the test counts rows in them
save_book(['id'=>'kt', 'folder'=>'kt', 'title'=>'Kethra Test', 'sort_order'=>1]);
foreach (['emily' => 'Emily Teague', 'ships-computer' => "Bartleby (the ship's computer)", 'vesna-kroll' => 'Vesna Kroll', 'odell' => 'Odell'] as $slug => $name)
    save_entry('kt', 'characters', ['slug'=>$slug, 'name'=>$name, 'status'=>'canon', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);

save_workspace_doc('kt', 'state/chapter-01/knowledge', "# Knowledge state - After chapter 1\n\n## Known to all\n- Nobody filed a flight plan\n\n"
    . "## Known to specific characters\n- Emily: has the bearing to the beacon (learned chapter 1)\n- Odell: knows Emily's name and bay (chapter 1)\n"
    . "- The unnamed man and the bar: know only that Emily does salvage\n\n## Unknown (dramatic irony)\n- What the suit is\n");
save_workspace_doc('kt', 'state/chapter-02/knowledge', "# Knowledge state - After chapter 2\n\n## Known to specific characters\n"
    . "- Emily: has the bearing to the beacon, reworded (chapter 1)\n- Emily and Bartleby: the city is not human (chapter 2)\n"
    . "- Emily (belief): somebody didn't want them to leave (chapter 2)\n- Bartleby (from approach scans): a structure to the east is powered\n");
save_workspace_doc('kt', 'state/chapter-03/knowledge', "# Knowledge state - After chapter 3\n\n## Carried forward\n- Everything in chapter 2 still holds\n\n"
    . "## New in chapter 3\n- Emily: the Harrow captain is Vesna Kroll\n- Kroll: \"You don't know what you're walking around in.\"\n"
    . "- Emily (observed, chapter 2): the raiders never touch the ground\n- The Harrow: someone killed the beacon\n\n## Clues found\n- The transmitter: chapter 3\n");

[$out, $code] = run_import('--book kt');
check('dry run exits clean and records nothing', $code === 0 && strpos($out, 'Dry run — 8 fact(s)') !== false && (int)val("SELECT COUNT(*) FROM knowledge_facts") === 0);
check('dry run reports skipped beliefs and restatements', strpos($out, 'Skipped 1 belief/inference line(s) and 1 restatement(s)') !== false);
check('dry run lists unresolved groups, not guesses', strpos($out, 'The unnamed man and the bar') !== false && strpos($out, 'The Harrow') !== false);
check('an unknown book is refused', run_import('--book nope')[1] === 2);

[$out, $code] = run_import('--book kt --apply');
check('--apply records the facts', $code === 0 && strpos($out, '8 fact(s) saved') !== false);
$k = function ($who, $at = '') { return array_column(knowledge_at('kt', $who, $at)['facts'], 'learned_in', 'knows'); };
check('cumulative list: first statement kept with its chapter', ($k('emily')['has the bearing to the beacon'] ?? null) === '1');
check('restatement in a later snapshot skipped', !isset($k('emily')['has the bearing to the beacon, reworded']));
check('"knows" prefix stripped', isset($k('odell')["Emily's name and bay"]));
check('"Emily and Bartleby" records both', isset($k('emily')['the city is not human']) && isset($k('ships-computer')['the city is not human']));
check('"Bartleby" resolves past the parenthetical', ($k('ships-computer')['a structure to the east is powered'] ?? null) === '2');
check('"Kroll" resolves by surname', isset($k('vesna-kroll')["\"You don't know what you're walking around in.\""]));
check('"New in chapter 3" uses the snapshot chapter', ($k('emily')['the Harrow captain is Vesna Kroll'] ?? null) === '3');
check('a qualifier chapter wins ("observed, chapter 2")', ($k('emily')['the raiders never touch the ground'] ?? null) === '2');
check('beliefs are not knowledge', !isset($k('emily')["somebody didn't want them to leave"]));
check('knowledge_at respects the imported chapters', array_keys($k('emily', '1')) === ['has the bearing to the beacon']);

[$out, $code] = run_import('--book kt --apply');
check('re-running imports nothing new', $code === 0 && strpos($out, '0 fact(s)') !== false && strpos($out, '8 already recorded') !== false
      && (int)val("SELECT COUNT(*) FROM knowledge_facts") === 8);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
