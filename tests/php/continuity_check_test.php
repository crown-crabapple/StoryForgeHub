<?php
/**
 * continuity_check_test.php — fixture checks for the deterministic continuity
 * checks: a deliberately broken book (after story-skills' "unraveled thread")
 * must produce exactly the expected findings; mentions stay legal; outline
 * deaths don't fire; candidates overlay a draft; exemptions dismiss; thresholds
 * are per book; plus state events and exemption validation.
 *
 *   php tests/php/continuity_check_test.php                     # SQLite (needs pdo_sqlite)
 *   DB_DRIVER=mysql DB_NAME=<scratch db> ... php tests/php/continuity_check_test.php
 *     (a throwaway, empty MariaDB database — the test creates tables in it)
 */
$useEnvDb = getenv('DB_DRIVER') === 'mysql';
$tmp = tempnam(sys_get_temp_dir(), 'codex_cchk_') . '.sqlite';
if (!$useEnvDb) { putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp); $_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp; }
register_shutdown_function(function () use ($tmp) { @unlink($tmp); });

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }
/** "code slug@chapter" for each finding — compact and order-stable. */
function sig($r, $key = 'findings') { return array_map(function ($f) { return "{$f['code']} {$f['slug']}@{$f['chapter']}"; }, $r[$key]); }
function has($r, $s) { return in_array($s, sig($r), true); }

migrate();
save_book(['id'=>'mill', 'folder'=>'mill', 'title'=>'The Unraveled Thread', 'sort_order'=>1]);
foreach (['edran-vale' => 'Edran Vale', 'nessa-thorn' => 'Nessa Thorn', 'jonas-reed' => 'Jonas Reed'] as $slug => $name)
    save_entry('mill', 'characters', ['slug'=>$slug, 'name'=>$name, 'status'=>'canon', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);
foreach (['vales-compass' => 'Vale\'s Compass', 'mill-key' => 'Mill key'] as $slug => $name)
    save_entry('mill', 'objects', ['slug'=>$slug, 'name'=>$name, 'status'=>'canon', 'type'=>'Object', 'fields'=>[], 'sections'=>[]]);
foreach ([1 => ['drafted', ''], 2 => ['drafted', ''], 3 => ['drafted', 'Jonas Reed'], 4 => ['drafted', ''], 5 => ['drafted', ''], 6 => ['outline', '']] as $n => [$st, $pov])
    q("INSERT INTO chapters (book_id,num,title,file,status,pov,words,body) VALUES ('mill',?,?,?,?,?,'1','x')", [sprintf('%02d', $n), "Ch $n", "ch0$n.md", $st, $pov]);

/* ---- a clean book passes ---- */
$r = continuity_check('mill');
check('an empty ledger passes with no findings', $r['pass'] && $r['findings'] === [] && $r['thresholds'] === ['promise_gap' => 3, 'question_gap' => 12]);

/* ---- the broken book ---- */
save_state_events('mill', [['slug' => 'edran-vale', 'event' => 'died', 'chapter' => '2'],
                           ['slug' => 'vales-compass', 'event' => 'destroyed', 'chapter' => '3'],
                           ['slug' => 'mill-key', 'event' => 'holder', 'chapter' => '1', 'value' => 'jonas-reed'],
                           ['slug' => 'jonas-reed', 'event' => 'died', 'chapter' => '6']]);   // outline death: must not fire
set_chapter_cast('mill', 'ch02.md', [['slug' => 'edran-vale', 'role' => 'appears']]);
set_chapter_cast('mill', 'ch03.md', [['slug' => 'nessa-thorn', 'role' => 'appears'], ['slug' => 'edran-vale', 'role' => 'mentioned']]);
set_chapter_cast('mill', 'ch04.md', [['slug' => 'edran-vale', 'role' => 'appears'], ['slug' => 'vales-compass', 'role' => 'appears'],
                                     ['slug' => 'mill-key', 'role' => 'appears'], ['slug' => 'nessa-thorn', 'role' => 'pov']]);
set_chapter_cast('mill', 'ch05.md', [['slug' => 'jonas-reed', 'role' => 'appears'], ['slug' => 'mill-key', 'role' => 'appears']]);
save_ledger_item('mill', ['title' => 'The broken compass', 'planted_in' => '3', 'payoff_in' => '2', 'status' => 'paid-off']);
save_ledger_item('mill', ['title' => 'The sealed letter', 'planted_in' => '1']);
save_ledger_item('mill', ['title' => 'The well', 'status' => 'planned', 'planted_in' => '2']);
save_ledger_item('mill', ['title' => 'The bell', 'planted_in' => '1', 'payoff_in' => '4', 'status' => 'planted']);
save_ledger_item('mill', ['kind' => 'question', 'title' => 'Who burned the mill', 'planted_in' => '3', 'payoff_in' => '2', 'status' => 'resolved']);
save_ledger_item('mill', ['kind' => 'question', 'title' => 'Where is Edran', 'planted_in' => '1', 'payoff_in' => '4', 'status' => 'open']);
save_ledger_item('mill', ['title' => 'Old oath', 'status' => 'abandoned', 'planted_in' => '4', 'payoff_in' => '1']);
save_knowledge('mill', [['character' => 'edran-vale', 'knows' => 'The mill is ash', 'learned_in' => '4'],
                        ['character' => 'nessa-thorn', 'knows' => 'Edran is gone', 'learned_in' => '9']]);

$r = continuity_check('mill');
$want = [
    'posthumous-appearance edran-vale@4', 'posthumous-learning edran-vale@4', 'gone-object-used vales-compass@4',
    'promise-payoff-before-plant the-broken-compass@2', 'question-resolved-before-introduced who-burned-the-mill@2',
    'question-open-but-resolved where-is-edran@4',
    'promise-unpaid the-sealed-letter@1', 'promise-stale-planned the-well@2', 'pov-not-in-cast jonas-reed@3',
    'promise-payoff-passed the-bell@4', 'object-away-from-holder mill-key@4', 'missing-chapter nessa-thorn@9',
];
sort($want); $got = sig($r); sort($got);
check('the broken book reports exactly the expected findings', $got === $want);
if ($got !== $want) { echo "    got:  " . implode(' | ', $got) . "\n    want: " . implode(' | ', $want) . "\n"; }
check('errors come first and the run fails', !$r['pass'] && $r['errors'] === 6 && $r['warnings'] === 6 && $r['findings'][0]['severity'] === 'error');
check('a mention of the dead is legal (chapter 3)', !has($r, 'posthumous-appearance edran-vale@3'));
check('appearing in the death chapter itself is legal', !has($r, 'posthumous-appearance edran-vale@2'));
check('an outline-chapter death does not fire', !has($r, 'posthumous-appearance jonas-reed@5'));
check('the holder on the page means no warning (chapter 5)', !has($r, 'object-away-from-holder mill-key@5'));
check('abandoned items are skipped', !in_array('old-oath', array_column($r['findings'], 'slug'), true));
check('findings carry a readable message', strpos($r['findings'][0]['message'], 'chapter') !== false);

/* ---- revival, deceased holder, lost/found, destroyed then moved ---- */
save_state_events('mill', [['slug' => 'edran-vale', 'event' => 'revived', 'chapter' => '4'],
                           ['slug' => 'nessa-thorn', 'event' => 'revived', 'chapter' => '3'],
                           ['slug' => 'vales-compass', 'event' => 'holder', 'chapter' => '5', 'value' => 'nessa-thorn']]);
$r = continuity_check('mill');
check('revived in chapter 4 may appear in chapter 4', !has($r, 'posthumous-appearance edran-vale@4') && !has($r, 'posthumous-learning edran-vale@4'));
check('revival without a death is an error', has($r, 'revived-without-death nessa-thorn@3'));
check('a destroyed object changing hands is an error', has($r, 'gone-object-used vales-compass@5'));
delete_state_event('mill', 'nessa-thorn', 'revived', '3');
delete_state_event('mill', 'vales-compass', 'holder', '5');
save_state_events('mill', [['slug' => 'mill-key', 'event' => 'lost', 'chapter' => '2'], ['slug' => 'mill-key', 'event' => 'found', 'chapter' => '5'],
                           ['slug' => 'vales-compass', 'event' => 'holder', 'chapter' => '2', 'value' => 'edran-vale'],
                           ['slug' => 'edran-vale', 'event' => 'died', 'chapter' => '1']]);
$r = continuity_check('mill');
check('a lost object on the page before it is found is an error', has($r, 'gone-object-used mill-key@4'));
check('once found it is fine', !has($r, 'gone-object-used mill-key@5'));
check('passing an object to the dead is flagged', has($r, 'deceased-holder vales-compass@2'));
delete_state_event('mill', 'edran-vale', 'died', '1');
delete_state_event('mill', 'vales-compass', 'holder', '2');
delete_state_event('mill', 'mill-key', 'lost', '2');
delete_state_event('mill', 'mill-key', 'found', '5');
delete_state_event('mill', 'edran-vale', 'revived', '4');

/* ---- candidates ---- */
$r = continuity_check('mill', ['chapter' => 'chapter-07', 'cast' => [['slug' => 'edran-vale', 'role' => 'pov'], ['slug' => 'ghost-of-mill', 'role' => 'mentioned']]]);
$c = array_values(array_filter($r['findings'], function ($f) { return !empty($f['candidate']); }));
check('a new-chapter candidate is checked and flagged as candidate', $r['candidate'] === '7' && array_map(function ($f) { return "{$f['code']} {$f['slug']}"; }, $c) === ['posthumous-appearance edran-vale']);
check('a candidate\'s unknown slugs are reported', has($r, 'unknown-entry ghost-of-mill@'));
$r = continuity_check('mill', ['chapter' => '4', 'cast' => [['slug' => 'edran-vale', 'role' => 'mentioned'], ['slug' => 'nessa-thorn', 'role' => 'pov']]]);
check('a candidate cast replaces the saved one', !has($r, 'posthumous-appearance edran-vale@4') && !has($r, 'gone-object-used vales-compass@4'));
check('nothing was saved by a candidate run', has(continuity_check('mill'), 'posthumous-appearance edran-vale@4'));
check('a bad candidate is refused', isset(continuity_check('mill', ['chapter' => 'soon'])['error'])
      && isset(continuity_check('mill', ['chapter' => '4', 'cast' => [['slug' => 'x', 'role' => 'ghost']]])['error']));

/* ---- exemptions ---- */
check('an exemption needs a slug or chapter', save_exemption('mill', 'promise-unpaid', '', '', 'later')['status'] === 'error');
check('an exemption needs a reason', save_exemption('mill', 'promise-unpaid', 'the-sealed-letter', '', ' ')['status'] === 'error');
check('an exemption saves', save_exemption('mill', 'promise-unpaid', 'the-sealed-letter', '', 'Pays off in book two')['status'] === 'ok');
save_exemption('mill', 'posthumous-appearance', '', '4', 'Chapter 4 is a seance');
$r = continuity_check('mill');
check('exempted findings move to dismissed with the reason', !has($r, 'promise-unpaid the-sealed-letter@1') && !has($r, 'posthumous-appearance edran-vale@4')
      && $r['dismissed'] === 2 && in_array('Pays off in book two', array_column($r['dismissed_findings'], 'reason'), true));
check('an exemption only matches its own keys', has($r, 'posthumous-learning edran-vale@4'));
check('exemptions list and delete', count(get_exemptions('mill')) === 2 && delete_exemption('mill', 'posthumous-appearance', '', '4')
      && has(continuity_check('mill'), 'posthumous-appearance edran-vale@4'));

/* ---- thresholds ---- */
check('a threshold out of range is refused', set_continuity_thresholds('mill', 500)['status'] === 'error');
set_continuity_thresholds('mill', 9, 2);
check('thresholds save per book', continuity_thresholds('mill') === ['promise_gap' => 9, 'question_gap' => 2]
      && continuity_check('mill')['thresholds'] === ['promise_gap' => 9, 'question_gap' => 2]);
save_ledger_item('mill', ['kind' => 'question', 'title' => 'Who rang the bell', 'planted_in' => '2']);
check('a lower question gap raises question-unanswered', has(continuity_check('mill'), 'question-unanswered who-rang-the-bell@2'));
set_continuity_thresholds('mill', 0, 0);
check('0 restores the defaults', continuity_thresholds('mill') === ['promise_gap' => 3, 'question_gap' => 12]);

/* ---- state event validation ---- */
check('state events reject an unknown event', save_state_events('mill', [['slug' => 'x', 'event' => 'vanished', 'chapter' => '1']])['status'] === 'error');
check('holder needs a value', save_state_events('mill', [['slug' => 'mill-key', 'event' => 'holder', 'chapter' => '1']])['status'] === 'error');
check('state events need a chapter', save_state_events('mill', [['slug' => 'x', 'event' => 'died', 'chapter' => '']])['status'] === 'error');
save_state_events('mill', [['slug' => 'mill-key', 'event' => 'holder', 'chapter' => '1', 'value' => 'nessa-thorn']]);
$ev = get_state_events('mill', 'mill-key');
check('re-saving an event in the same chapter replaces it', count($ev) === 1 && $ev[0]['value'] === 'nessa-thorn');

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
