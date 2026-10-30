<?php
/**
 * continuity_test.php — fixture checks for the continuity ledgers: chapter
 * reference parsing, the promise/question ledger (merge-by-slug, status
 * defaults and validation), chapter cast (appears vs mentioned, replace,
 * strongest role wins, a slug's chapters), and knowledge-at-chapter queries.
 *
 *   php tests/php/continuity_test.php                     # SQLite (needs pdo_sqlite)
 *   DB_DRIVER=mysql DB_NAME=<scratch db> ... php tests/php/continuity_test.php
 *     (a throwaway, empty MariaDB database — the test creates tables in it)
 */
$useEnvDb = getenv('DB_DRIVER') === 'mysql';
$tmp = tempnam(sys_get_temp_dir(), 'codex_cont_') . '.sqlite';
if (!$useEnvDb) { putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp); $_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp; }
register_shutdown_function(function () use ($tmp) { @unlink($tmp); });

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }

migrate();
save_book(['id'=>'echo', 'folder'=>'echo', 'title'=>'Echo', 'sort_order'=>1]);
save_book(['id'=>'alien', 'folder'=>'alien', 'title'=>'Alien', 'sort_order'=>2]);
foreach (['aria' => 'Aria', 'bram' => 'Bram'] as $slug => $name)
    save_entry('echo', 'characters', ['slug'=>$slug, 'name'=>$name, 'status'=>'canon', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);
foreach (['01' => 'ch01.md', '02' => 'ch02.md', '10' => 'ch10.md'] as $num => $file)
    q("INSERT INTO chapters (book_id,num,title,file,status,words,body) VALUES ('echo',?,?,?,'drafted','1','x')", [$num, "Chapter $num", $file]);
q("INSERT INTO progressions (book_id,chapter,type,what,related_csv,sort_order) VALUES
   ('echo','Ch. 2','turn','Aria loses the key','aria',1), ('echo','Ch. 10','death','Aria falls','aria',2)");

/* ---- chapter references ---- */
check('ch_ref normalises the usual spellings', ch_ref('chapter-04') === '4' && ch_ref('Ch. 4') === '4' && ch_ref('04') === '4' && ch_ref(4) === '4');
check('ch_ref keeps half chapters and named ends', ch_ref('3.5') === '3.5' && ch_ref('Prologue') === 'prologue' && ch_ref('epilogue') === 'epilogue');
check('ch_ref: blank is blank, junk is null', ch_ref('') === '' && ch_ref('soon') === null);
check('ch_ord sorts prologue < 2 < 10 < epilogue', ch_ord('prologue') < ch_ord('2') && ch_ord('2') < ch_ord('10') && ch_ord('10') < ch_ord('epilogue'));

/* ---- ledger ---- */
$r = save_ledger_item('echo', ['title' => 'The Sealed Letter', 'planted_in' => 'chapter-01', 'characters' => ['Aria', 'ghost']]);
check('ledger create derives slug from title', $r['status'] === 'ok' && $r['created'] && $r['item']['slug'] === 'the-sealed-letter');
check('ledger defaults a planted promise', $r['item']['kind'] === 'promise' && $r['item']['status'] === 'planted' && $r['item']['planted_in'] === '1');
check('ledger warns about unknown character slugs', strpos($r['warnings'][0] ?? '', 'ghost') !== false);
$r = save_ledger_item('echo', ['slug' => 'the-sealed-letter', 'payoff_in' => 'Ch. 9', 'status' => 'paid-off']);
check('ledger update merges by slug', !$r['created'] && $r['item']['payoff_in'] === '9' && $r['item']['title'] === 'The Sealed Letter'
      && $r['item']['characters'] === ['aria', 'ghost']);
check('ledger rejects a bad status', save_ledger_item('echo', ['slug' => 'the-sealed-letter', 'status' => 'open'])['status'] === 'error');
check('ledger rejects an unparseable chapter', save_ledger_item('echo', ['title' => 'x', 'planted_in' => 'later'])['status'] === 'error');
check('ledger refuses to change a kind', save_ledger_item('echo', ['slug' => 'the-sealed-letter', 'kind' => 'question'])['status'] === 'error');
$r = save_ledger_item('echo', ['kind' => 'question', 'title' => 'Who burned the mill?', 'planted_in' => '2']);
check('question defaults to open', $r['item']['status'] === 'open' && $r['item']['slug'] === 'who-burned-the-mill');
save_ledger_item('echo', ['title' => 'Prologue omen', 'planted_in' => 'prologue']);
$all = get_ledger('echo');
check('ledger orders by setup chapter', array_column($all, 'slug') === ['prologue-omen', 'the-sealed-letter', 'who-burned-the-mill']);
check('ledger filters by kind and status', array_column(get_ledger('echo', 'question'), 'slug') === ['who-burned-the-mill']
      && array_column(get_ledger('echo', null, 'paid-off'), 'slug') === ['the-sealed-letter']);
check('ledger is per book', get_ledger('alien') === []);
check('ledger delete', delete_ledger_item('echo', 'prologue-omen') && !get_ledger_item('echo', 'prologue-omen') && !delete_ledger_item('echo', 'prologue-omen'));

/* ---- cast ---- */
check('find_chapter_ref by number and by file', find_chapter_ref('echo', 'chapter-02')['file'] === 'ch02.md'
      && find_chapter_ref('echo', 'ch10.md')['num'] === '10' && find_chapter_ref('echo', '7') === null);
$r = set_chapter_cast('echo', 'ch02.md', [['slug' => 'aria', 'role' => 'pov'], ['slug' => 'bram', 'role' => 'mentioned'],
                                          ['slug' => 'bram', 'role' => 'appears'], 'mill-keeper']);
check('cast saves and strongest role wins', $r['status'] === 'ok'
      && array_column($r['cast'], 'role', 'slug') === ['aria' => 'pov', 'bram' => 'appears', 'mill-keeper' => 'appears']);
check('cast warns about slugs with no entry', strpos($r['warnings'][0] ?? '', 'mill-keeper') !== false);
check('cast rejects a bad role', set_chapter_cast('echo', 'ch02.md', [['slug' => 'aria', 'role' => 'ghost']])['status'] === 'error');
check('cast rejects two povs', set_chapter_cast('echo', 'ch02.md', [['slug' => 'aria', 'role' => 'pov'], ['slug' => 'bram', 'role' => 'pov']])['status'] === 'error');
check('a refused cast leaves the old one', count(get_chapter_cast('echo', 'ch02.md')) === 3);
set_chapter_cast('echo', 'ch02.md', [['slug' => 'aria', 'role' => 'pov'], ['slug' => 'bram', 'role' => 'mentioned']]);
check('cast replaces the whole chapter', array_column(get_chapter_cast('echo', 'ch02.md'), 'role', 'slug') === ['aria' => 'pov', 'bram' => 'mentioned']);
set_chapter_cast('echo', 'ch01.md', [['slug' => 'bram', 'role' => 'appears']]);
$apps = get_slug_appearances('echo', 'Bram');
check('a slug lists its chapters in order with role', array_column($apps, 'role', 'chapter_file') === ['ch01.md' => 'appears', 'ch02.md' => 'mentioned']);

/* ---- knowledge ---- */
$r = save_knowledge('echo', [['character' => 'aria', 'knows' => 'The mill had two keys', 'fact' => 'two-keys'],
                             ['character' => 'aria', 'knows' => 'Bram lit the fire', 'learned_in' => 'chapter-10'],
                             ['character' => 'aria', 'knows' => 'The letter is forged', 'learned_in' => '2']]);
check('knowledge saves a batch with derived fact ids', $r['status'] === 'ok' && $r['saved'][1]['fact'] === 'bram-lit-the-fire');
check('knowledge refuses a bad batch whole', save_knowledge('echo', [['character' => 'bram', 'knows' => 'ok'], ['character' => 'bram']])['status'] === 'error'
      && knowledge_at('echo', 'bram')['facts'] === []);
$k = knowledge_at('echo', 'aria', 'chapter-02');
check('knowledge at ch2: pre-story + ch2, not ch10', array_column($k['facts'], 'fact') === ['two-keys', 'the-letter-is-forged']
      && $k['facts'][0]['learned_in'] === 'before the story' && $k['at'] === '2');
check('knowledge at ch2 carries arc beats up to ch2 only', array_column($k['arc'], 'what') === ['Aria loses the key']);
$k = knowledge_at('echo', 'Aria');
check('knowledge with no chapter returns everything', count($k['facts']) === 3 && count($k['arc']) === 2 && $k['at'] === 'all');
save_knowledge('echo', [['character' => 'aria', 'fact' => 'two-keys', 'knows' => 'The mill had three keys', 'learned_in' => '10']]);
check('knowledge re-save by fact id updates it', array_column(knowledge_at('echo', 'aria', '2')['facts'], 'fact') === ['the-letter-is-forged']);
check('knowledge_at rejects a junk chapter', knowledge_at('echo', 'aria', 'soon') === null);
check('knowledge delete', delete_knowledge('echo', 'aria', 'two-keys') && count(knowledge_at('echo', 'aria')['facts']) === 2);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
