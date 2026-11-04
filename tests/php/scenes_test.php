<?php
/**
 * scenes_test.php — UI plan Phase 2: scene identity across edits
 * (reconcile_scenes matches by content, not position), save_scene_meta
 * validation, and the Grid's per-scene chips/preview (scene_grid_data).
 *
 *   php tests/php/scenes_test.php
 */
$tmp = tempnam(sys_get_temp_dir(), 'codex_scenes_') . '.sqlite';
putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $tmp);
$_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $tmp;
register_shutdown_function(function () use ($tmp) { @unlink($tmp); });

require_once __DIR__ . '/../../src/repo.php';

$pass = 0; $fail = 0;
function check($label, $cond) { global $pass, $fail; if ($cond) { $pass++; echo "  ok  $label\n"; } else { $fail++; echo "FAIL  $label\n"; } }

migrate();
save_book(['id'=>'echo', 'folder'=>'echo', 'title'=>'Echo', 'sort_order'=>1]);
save_book(['id'=>'alien', 'folder'=>'alien', 'title'=>'Alien', 'sort_order'=>2]);
save_entry('echo', 'characters', ['slug'=>'aria', 'name'=>'Aria', 'status'=>'canon', 'type'=>'Character',
    'fields'=>[['label'=>'Aliases','value'=>'The Warden']], 'sections'=>[]]);
save_entry('echo', 'characters', ['slug'=>'bram', 'name'=>'Bram', 'status'=>'seed', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);
save_entry('echo', 'locations', ['slug'=>'wall', 'name'=>'The Wall', 'status'=>'seed', 'type'=>'Location', 'fields'=>[], 'sections'=>[]]);
save_entry('alien', 'characters', ['slug'=>'zeta', 'name'=>'Zeta', 'status'=>'seed', 'type'=>'Character', 'fields'=>[], 'sections'=>[]]);

// Four scenes with distinct openings and endings, long enough for real anchors.
function para($tag) {
    return "The $tag scene opens on a grey morning above the river, where the ferry waits and the gulls argue over scraps. "
         . str_repeat("Nothing much happens in the $tag middle, which is the point of a middle. ", 4)
         . "It ends, as $tag scenes do, with a door closing somewhere down the hall.";
}
$A = para('alpha'); $B = para('bravo'); $C = para('charlie'); $D = para('delta');
function body(...$s) { return implode("\n\n***\n\n", $s); }

q("INSERT INTO chapters (book_id,num,title,file,status,words,body) VALUES ('echo','01','One','ch01.md','drafted','0',?)", [body($A, $B, $C)]);
$cid = (int)last_id();
function rows($cid) { return all("SELECT * FROM scenes WHERE chapter_id=? ORDER BY ordinal", [$cid]); }
function by_summary($cid) { $o = []; foreach (rows($cid) as $r) $o[(int)$r['ordinal']] = $r['summary']; return $o; }
function ids($cid) { $o = []; foreach (rows($cid) as $r) $o[$r['summary']] = (int)$r['id']; return $o; }
function save($cid, $md) {
    $c = get_chapter($cid);
    return write_chapter_file('echo', $cid, $md, md5(md_body_norm($c['body'])));
}

check('lazy backfill creates 3 scenes', count(get_scenes($cid)) === 3);
foreach (rows($cid) as $r) save_scene_meta((int)$r['id'], 'echo', ['summary' => 'S'.$r['ordinal'], 'pov_slug' => $r['ordinal'] == 2 ? 'bram' : '']);
$ids0 = ids($cid);
check('anchors stored', rows($cid)[0]['anchor_head'] !== '' && rows($cid)[0]['anchor_tail'] !== '');

// ---- insert a new scene before all of them
save($cid, body($D, $A, $B, $C));
check('insert before: summaries follow their scenes', by_summary($cid) === [1 => '', 2 => 'S1', 3 => 'S2', 4 => 'S3']);
check('insert before: row ids are stable', array_intersect_key(ids($cid), $ids0) === $ids0);
check('insert before: POV follows the scene', rows($cid)[2]['pov_slug'] === 'bram');

// ---- delete the middle scene (S2)
save($cid, body($D, $A, $C));
check('delete: remaining summaries intact', by_summary($cid) === [1 => '', 2 => 'S1', 3 => 'S3']);
check('delete: deleted scene row is gone', !in_array($ids0['S2'], array_values(ids($cid)), true));

// ---- reorder
save($cid, body($C, $D, $A));
check('reorder: summaries follow', by_summary($cid) === [1 => 'S3', 2 => '', 3 => 'S1']);

// ---- edit inside a scene (append a sentence to A, tweak a word in C)
$A2 = $A . ' Then the bell rang twice.';
$C2 = str_replace('grey morning', 'cold morning', $C);
save($cid, body($C2, $D, $A2));
check('edits: summaries follow edited scenes', by_summary($cid) === [1 => 'S3', 2 => '', 3 => 'S1']);

// ---- edit + move together: A edited AND moved to the front
save($cid, body($A2 . ' And again.', $C2, $D));
check('edit + move: matched by similarity', by_summary($cid) === [1 => 'S1', 2 => 'S3', 3 => '']);

// ---- wholesale rewrite of one scene falls back to its ordinal
save($cid, body($A2 . ' And again.', 'Entirely new words. Nothing in common with what stood here before, at all.', $D));
check('rewrite: ordinal fallback keeps the summary', by_summary($cid) === [1 => 'S1', 2 => 'S3', 3 => '']);

// ---- a brand-new scene is not handed someone else's summary
save($cid, body($A2 . ' And again.', 'Entirely new words. Nothing in common with what stood here before, at all.', $D, $B));
check('appended new scene starts bare', by_summary($cid)[4] === '');

// ---- duplicate identical scenes: nearest ordinal wins, both kept
q("INSERT INTO chapters (book_id,num,title,file,status,words,body) VALUES ('echo','02','Two','ch02.md','drafted','0',?)", [body($A, $A)]);
$cid2 = (int)last_id(); get_scenes($cid2);
$r2 = rows($cid2); save_scene_meta((int)$r2[0]['id'], 'echo', ['summary'=>'first']); save_scene_meta((int)$r2[1]['id'], 'echo', ['summary'=>'second']);
save($cid2, body($B, $A, $A));
check('duplicates: each copy keeps its own summary', by_summary($cid2) === [1 => '', 2 => 'first', 3 => 'second']);

// ---- planning order (seq) follows the scene
$rs = rows($cid2); reorder_scenes('echo', $cid2, [(int)$rs[2]['id'], (int)$rs[1]['id'], (int)$rs[0]['id']]);
save($cid2, body($C, $B, $A, $A));
$seqs = []; foreach (rows($cid2) as $r) $seqs[$r['summary']] = $r['seq'];
check('seq follows the scene', (string)$seqs['second'] === '0' && (string)$seqs['first'] === '1');

/* ---- save_scene_meta validation ---- */
$sid = (int)rows($cid)[0]['id'];
$r = save_scene_meta($sid, 'echo', ['summary'=>"  Aria at the ferry.\r\n", 'label'=>'Final', 'subtitle'=>"  Dawn   watch ", 'pov_slug'=>'aria']);
check('meta: saves all four fields', $r['ok'] && $r['scene']['summary'] === 'Aria at the ferry.' && $r['scene']['label'] === 'Final'
      && $r['scene']['subtitle'] === 'Dawn watch' && $r['scene']['pov_slug'] === 'aria');
check('meta: partial update leaves other fields', save_scene_meta($sid, 'echo', ['subtitle'=>''])['ok'] && rows($cid)[0]['summary'] === 'Aria at the ferry.');
check('meta: unknown label refused', !save_scene_meta($sid, 'echo', ['label'=>'Bogus'])['ok'] && rows($cid)[0]['label'] === 'Final');
check('meta: POV must be a character (not a location)', !save_scene_meta($sid, 'echo', ['pov_slug'=>'wall'])['ok']);
check('meta: POV from another book refused', !save_scene_meta($sid, 'echo', ['pov_slug'=>'zeta'])['ok']);
check('meta: empty POV clears', save_scene_meta($sid, 'echo', ['pov_slug'=>''])['ok'] && rows($cid)[0]['pov_slug'] === '');
check('meta: another book cannot touch this scene', !save_scene_meta($sid, 'alien', ['summary'=>'x'])['ok'] && rows($cid)[0]['summary'] === 'Aria at the ferry.');
check('meta: summary length capped', !save_scene_meta($sid, 'echo', ['summary'=>str_repeat('x', 4001)])['ok']);
check('meta: prose untouched by metadata saves', get_chapter($cid)['body'] === md_body_norm(body($A2 . ' And again.', 'Entirely new words. Nothing in common with what stood here before, at all.', $D, $B)));

/* ---- Grid chips + preview ---- */
$targets = build_mention_targets('echo');
$md = "## Night watch\n\nAria walked The Wall. <!-- Bram is offstage here -->The Warden looked down.\n\n***\n\nBram slept. Aria did not.";
$g = scene_grid_data($md, $targets);
check('chips: per-scene counts (aliases count, comments ignored)', $g[1]['chips'] === ['aria'=>2, 'wall'=>1] && $g[2]['chips'] === ['aria'=>1, 'bram'=>1]);
$sum = []; foreach ($g as $x) foreach ($x['chips'] as $k => $n) $sum[$k] = ($sum[$k] ?? 0) + $n;
$whole = scan_mentions("Aria walked The Wall. The Warden looked down.\n\nBram slept. Aria did not.", $targets);
ksort($sum); ksort($whole);
check('chips: per-scene totals add up to the chapter prose total (the rail)', $sum === $whole);
check('preview: plain text, no heading, no comment', $g[1]['preview'] === 'Aria walked The Wall. The Warden looked down.');
$long = scene_grid_data(str_repeat('word ', 80), $targets);
check('preview: clipped with an ellipsis', mb_strlen($long[1]['preview']) <= 161 && mb_substr($long[1]['preview'], -1) === '…');

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
