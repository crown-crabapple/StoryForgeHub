<?php
/**
 * codex_card_test.php — build_codex_card_meta() (UI plan Phase 1): the data
 * behind the Codex hover/pin card on the reader page and in the editors.
 *
 *   php tests/php/codex_card_test.php
 */
$tmp = tempnam(sys_get_temp_dir(), 'codex_card_') . '.sqlite';
putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp);
$_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp;
register_shutdown_function(function () use ($tmp) { @unlink($tmp); });

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }

migrate();
save_book(['id'=>'echo', 'folder'=>'echo', 'title'=>'Echo', 'sort_order'=>1]);
save_book(['id'=>'alien', 'folder'=>'alien', 'title'=>'Alien', 'sort_order'=>2]);

$long = str_repeat('Aria keeps the northern watch and trusts nobody on the council. ', 8);
save_entry('echo', 'characters', ['slug'=>'aria', 'name'=>'Aria Vell', 'status'=>'canon', 'type'=>'Character',
    'fields'=>[['label'=>'Aliases','value'=>'The Warden; Vell'], ['label'=>'Role','value'=>'Captain'],
               ['label'=>'Age','value'=>'34'], ['label'=>'Mention scan','value'=>'on'], ['label'=>'Empty','value'=>''],
               ['label'=>'Eyes','value'=>'Grey'], ['label'=>'Home','value'=>'[[wall]]'], ['label'=>'Sixth','value'=>'x']],
    'related'=>['wall', 'ghost', 'aria', 'bram', 'zeta', 'cara'],
    'sections'=>[['h'=>'Overview','body'=>"- **Bold** start with [[wall|the Wall]] <!-- hidden note -->\n\n".$long],
                 ['h'=>'History','body'=>'Second section text.']]]);
save_entry('echo', 'locations', ['slug'=>'wall', 'name'=>'The Wall', 'status'=>'seed', 'type'=>'Location',
    'fields'=>[], 'sections'=>[['h'=>'Overview','body'=>'Cold <b>granite</b> & ice.']]]);
save_entry('echo', 'characters', ['slug'=>'bram', 'name'=>'Bram', 'status'=>'seed', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);
save_entry('echo', 'characters', ['slug'=>'cara', 'name'=>'Cara', 'status'=>'seed', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);
save_entry('alien', 'characters', ['slug'=>'zeta', 'name'=>'Zeta', 'status'=>'seed', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);

q("INSERT INTO chapters (book_id,num,title,file,status,words,body) VALUES
   ('echo','01','One','ch01.md','drafted','20','Aria Vell climbed the Wall. The Warden looked down.\n\n***\n\nVell slept. Bram did not.')");
q("INSERT INTO chapters (book_id,num,title,file,status,words,body) VALUES
   ('echo','02','Cut','ch02.md','archived','3','Aria Vell burns.')");
index_mentions('echo');

$m = build_codex_card_meta('echo');
$a = $m['aria'] ?? null;
check('every entry of the book is present, none from other books', isset($m['aria'], $m['wall'], $m['bram'], $m['cara']) && !isset($m['zeta']));
check('name / db / type carried', $a && $a['name'] === 'Aria Vell' && $a['db'] === 'characters' && $a['type'] === 'Character');
check('aliases split on , and ;', $a && $a['aliases'] === ['The Warden', 'Vell']);
$labels = $a ? array_column($a['fields'], 0) : [];
check('key fields skip aliases / mention-scan / empty values', !in_array('Aliases', $labels, true) && !in_array('Mention scan', $labels, true) && !in_array('Empty', $labels, true));
check('key fields capped at 4, in order', $labels === ['Role', 'Age', 'Eyes', 'Home']);
check('field values kept raw (client escapes)', $a && $a['fields'][3][1] === '[[wall]]');
check('excerpt is plain text (no markdown, links, comments)', $a && strpos($a['body'], '**') === false && strpos($a['body'], '[[') === false
      && strpos($a['body'], 'hidden note') === false && strpos($a['body'], 'the Wall') !== false && $a['body'][0] !== '-');
check('excerpt clipped to ~200 chars with an ellipsis', $a && mb_strlen($a['body']) <= 201 && mb_substr($a['body'], -1) === '…');
check('short excerpt not clipped', $m['wall']['body'] === 'Cold <b>granite</b> & ice.');
check('no prose -> empty excerpt', $m['bram']['body'] === '');
check('related: known in-book slugs only, no self, max 3', $a && $a['related'] === ['wall', 'bram', 'cara']);
check('mention total counts live chapters (name + aliases), not archived', $a && $a['n'] === 3);
check('entry with no mentions -> 0', $m['cara']['n'] === 0);
check('unknown book -> empty', build_codex_card_meta('nope') === []);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
