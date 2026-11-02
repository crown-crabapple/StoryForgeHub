<?php
/**
 * make-fixture.php - builds the synthetic "Salt Orchard" legacy database used as the seed-dump fixture (M06-J01).
 *
 *   php make-fixture.php --legacy <legacy repo checkout> --db <new sqlite file>
 *
 * It loads the legacy src/repo.php (read-only use of that repository), creates the legacy tables with the legacy
 * migrate()/ensure_*() functions, then inserts invented content through the legacy save functions. Everything here is
 * made up: no real book, no real person. It does NOT use bin/seed.php or sync/seed.json (those can hold real content).
 * Passwords, tokens and codes are obvious fakes so the dumper's "never dumped" rule can be checked.
 *
 * PHP needs pdo_sqlite (the default C:\php\php.ini has it off; use a scratch php.ini via PHPRC).
 */
$opt = getopt('', ['legacy:', 'db:']);
if (empty($opt['legacy']) || empty($opt['db'])) { fwrite(STDERR, "usage: php make-fixture.php --legacy <dir> --db <new sqlite file>\n"); exit(2); }
$legacy = rtrim($opt['legacy'], '/\\');
$dbFile = $opt['db'];
if (file_exists($dbFile)) { fwrite(STDERR, "refusing to overwrite $dbFile\n"); exit(2); }
putenv('DB_DRIVER=sqlite'); putenv('DB_PATH=' . $dbFile);
$_ENV['DB_DRIVER'] = 'sqlite'; $_ENV['DB_PATH'] = $dbFile;

require_once $legacy . '/src/repo.php';
require_once $legacy . '/src/oauth.php';

migrate();
// every lazily created table, in the order the live app would create them
ensure_users(); ensure_api_tokens(); ensure_book_members(); ensure_book_activity(); ensure_oauth();
ensure_structure(); ensure_progress_cols(); ensure_note_pages(); ensure_captures(); ensure_spatial(); ensure_task_extras();
ensure_chapter_notes(); ensure_dictionary_terms(); ensure_chapter_revisions(); ensure_entry_revisions(); ensure_mentions();
ensure_prose_analysis(); ensure_sources(); ensure_exercises(); ensure_continuity(); ensure_workspace(); ensure_editing_locks();

/* ---------------------------------------------------------------- accounts (fake secrets in users; the secret tables exist but stay empty) */
q("INSERT INTO users (email, display_name, password_hash, status, is_admin) VALUES (?,?,?,?,?)", ['ada@example.invalid', 'Ada Fixture', 'FAKE-PASSWORD-HASH-ada', 'active', 1]);
q("INSERT INTO users (email, display_name, password_hash, status, is_admin) VALUES (?,?,?,?,?)", ['ben@example.invalid', 'Ben Fixture', 'FAKE-PASSWORD-HASH-ben', 'active', 0]);

// act as an administrator so revisions carry a saved_by (no session exists in a CLI run)
act_as_user(['id' => 1, 'email' => 'ada@example.invalid', 'display_name' => 'Ada Fixture', 'status' => 'active', 'is_admin' => 1]);

/* ---------------------------------------------------------------- book 1: the novel */
save_book(['id' => 'salt-orchard', 'folder' => 'salt-orchard', 'title' => 'The Salt Orchard', 'series' => 'The Tidewater Books', 'num' => '1',
    'status' => 'drafting', 'logline' => 'A cartographer returns to a flooded family orchard and finds a key that was left for her.',
    'genre' => 'literary, coastal gothic', 'word_target' => '90000', 'dot' => '#3A5F7D', 'sort_order' => 1, 'profile' => 'fiction']);
add_book_member('salt-orchard', 1, 'owner', 1);
add_book_member('salt-orchard', 2, 'editor', 1);
log_activity('salt-orchard', 'chapter_save', 'ch-01-the-drowned-rows.md');

$act1 = add_act('salt-orchard', 'Low Water', 'The orchard drains');
$act2 = add_act('salt-orchard', 'High Tide', '');

$ch = [];   // file => body
$ch['prologue.md'] = "## Prologue \xE2\x80\x94 The Tide Book\n\nThe tide book was kept by hand for ninety years, and every page of it was wrong in the same direction.\n";
$ch['ch-01-the-drowned-rows.md'] = "## Chapter 1 \xE2\x80\x94 The Drowned Rows\n\n"
  . "Maren came up the lane at slack water, when the ditches stood full and still.\n\n"
  . "The lower rows were under a hand's depth of brine. Pell was already there, hauling a net through the trees as if the orchard were a harbour.\n\n"
  . "---\n\n"
  . "<!-- note: check the tide times against chapter 3 -->\n\n"
  . "Ilse's house had kept its shutters closed. Maren stood on the porch a while before she tried the door, and it opened.\n\n"
  . "---\n\n"
  . "### The Kitchen\n\n"
  . "The kettle was warm. Somebody had been there that morning, and had left in a hurry, and had wanted her to know it.\n";
$ch['ch-02-the-key.md'] = "## Chapter 2 \xE2\x80\x94 The Key\n\n"
  . "The key was colder than the morning. She turned it over twice before she understood it was hers.\n\n"
  . "***\n\n"
  . "Tobin Reyes was waiting at the port with the look of a man who had rehearsed an apology. [[tobin-reyes|Tobin]] had not changed his coat in a decade.\n\n"
  . "He said the harbour office still had her father's survey, and that the survey disagreed with the water.\n";
$ch['ch-03-low-water.md'] = "## Chapter 3 \xE2\x80\x94 Low Water\n\n"
  . "By evening the water had gone out of the lower rows and left a white crust on the bark.\n\n"
  . "Maren walked the rows with the brass key in her pocket and counted the trees that still bore fruit [^cite:harbour-survey].\n";
$ch['ch-04-the-tidewardens.md'] = "## Chapter 4 \xE2\x80\x94 The Tidewardens\n\n"
  . "The Tidewardens met in the net loft, under a ceiling of drying cork floats.\n\n"
  . "___\n\n"
  . "Afterwards Ilse's letter was read aloud, twice, and nobody looked at Maren while it was.\n";
$ch['ch-05-the-cut-scene.md'] = "## Chapter 5 \xE2\x80\x94 The Cut Scene\n\nA draft that did not survive the second pass.\n";
foreach ($ch as $file => $body) upsert_chapter_from_md('salt-orchard', $file, $body);
// save_chapter_snapshot is what the web editor does on every save
foreach ($ch as $file => $body) {
    $row = one("SELECT id FROM chapters WHERE book_id=? AND file=?", ['salt-orchard', $file]);
    save_chapter_snapshot('salt-orchard', (int)$row['id'], $file, $body, 'save');
}
// a later edit of chapter 1 (second revision), through the legacy save path
$c1 = one("SELECT id, body FROM chapters WHERE book_id=? AND file=?", ['salt-orchard', 'ch-01-the-drowned-rows.md']);
write_chapter_file('salt-orchard', (int)$c1['id'], $c1['body'] . "\nShe could hear the pumps from here.\n", md5(md_body_norm($c1['body'])));

$idOf = function ($file) { return (int) val("SELECT id FROM chapters WHERE book_id='salt-orchard' AND file=?", [$file]); };
set_chapter_act($idOf('prologue.md'), 'salt-orchard', $act1);
set_chapter_act($idOf('ch-01-the-drowned-rows.md'), 'salt-orchard', $act1);
set_chapter_act($idOf('ch-02-the-key.md'), 'salt-orchard', $act1);
set_chapter_act($idOf('ch-03-low-water.md'), 'salt-orchard', $act2);
set_chapter_act($idOf('ch-04-the-tidewardens.md'), 'salt-orchard', $act2);
set_chapter_status($idOf('ch-01-the-drowned-rows.md'), 'revised');
set_chapter_status($idOf('ch-05-the-cut-scene.md'), 'archived');
q("UPDATE chapters SET pov='maren-hollis', summary='Maren arrives and finds the orchard flooded.' WHERE book_id='salt-orchard' AND file='ch-01-the-drowned-rows.md'");
// the legacy scenes cache: ordinal-matched labels and summaries (chapter 1 matches its segments; chapter 4 is edited behind the cache below)
q("UPDATE scenes SET label='Final', summary='Maren and Pell at the flooded rows.' WHERE chapter_id=? AND ordinal=1", [$idOf('ch-01-the-drowned-rows.md')]);
q("UPDATE scenes SET label='Needs revision' WHERE chapter_id=? AND ordinal=2", [$idOf('ch-01-the-drowned-rows.md')]);
q("UPDATE scenes SET label='Alt version', summary='A shorter kitchen.' WHERE chapter_id=? AND ordinal=3", [$idOf('ch-01-the-drowned-rows.md')]);

q("UPDATE scenes SET label='Final', summary='The Tidewardens meet.' WHERE chapter_id=? AND ordinal=1", [$idOf('ch-04-the-tidewardens.md')]);
q("UPDATE chapters SET body = body || ? WHERE id=?", ["
A line added behind the cache.
", $idOf('ch-04-the-tidewardens.md')]);   // scenes cache is now stale

/* ---- codex entries */
$E = function ($db, $slug, $name, $status, $fields, $sections, $related) {
    $f = []; foreach ($fields as $k => $v) $f[] = ['label' => $k, 'value' => $v];
    $s = []; foreach ($sections as $h => $b) $s[] = ['h' => $h, 'body' => $b];
    $raw = $related ? implode(', ', array_map(function ($r) { return "[[$r]]"; }, $related)) : null;
    save_entry('salt-orchard', $db, ['slug' => $slug, 'name' => $name, 'status' => $status, 'fields' => $f, 'sections' => $s, 'related' => $related, 'relatedRaw' => $raw]);
};
$E('characters', 'maren-hollis', 'Maren Hollis', 'canon',
   ['Species' => 'Human', 'Age' => '34', 'Eyes' => 'Grey', 'Home' => '[[port-aldine]]', 'First Appearance' => 'Chapter 1'],
   ['Overview' => 'Cartographer who maps coastlines for a living and avoids her own.', 'Arc' => "Comes back to sell the estate.\nEnds choosing to stay.", 'Open threads' => "- Why did Ilse leave the key?\n- Who kept the shutters closed?"],
   ['ilse-hollis', 'tobin-reyes', 'brass-key']);
$E('characters', 'ilse-hollis', 'Ilse Hollis', 'sketch', ['Species' => 'Human', 'Age' => '71'], ['Overview' => 'Maren\'s aunt, who kept the orchard through three floods.'], ['maren-hollis']);
$E('characters', 'tobin-reyes', 'Tobin Reyes', 'sketch', ['Species' => 'Human', 'Occupation' => 'Harbour clerk'], ['Overview' => 'Childhood friend. Still owes Maren an apology.'], ['maren-hollis']);
$E('characters', 'pell', 'Pell', 'seed', ['Species' => 'Human'], ['Overview' => 'Hired hand. Talks to the trees.'], []);
$E('locations', 'salt-orchard', 'The Salt Orchard', 'canon', ['Scale' => 'Estate'], ['Overview' => 'A pear orchard on reclaimed marsh, below the sea wall.', 'History' => 'Planted ninety years ago. See also [[tide-law]] and [[ghost-pier]].'], ['port-aldine']);
$E('locations', 'port-aldine', 'Port Aldine', 'sketch', ['Scale' => 'Town'], ['Overview' => 'The nearest harbour, three miles by lane.'], []);
$E('factions', 'tidewardens', 'The Tidewardens', 'sketch', ['Kind' => 'Guild'], ['Overview' => 'Keepers of the tide book.'], ['tobin-reyes']);
$E('objects', 'brass-key', 'The Brass Key', 'canon', ['Class' => 'Artifact', 'Material' => 'Brass'], ['Overview' => 'Opens something in Ilse\'s house. Nobody agrees what.'], ['ilse-hollis']);
$E('lore', 'tide-law', 'Tide Law', 'seed', ['Domain' => 'Custom'], ['Overview' => 'Anything the sea returns belongs to the shore it lands on.'], []);
// the same slug in another database (a legacy slug collision once both are imported into one namespace)
$E('lore', 'pell', 'Pell (the saying)', 'seed', ['Domain' => 'Proverb'], ['Overview' => '"Ask Pell" means: do not ask.'], []);
// a later edit of an entry (second entry revision)
save_entry('salt-orchard', 'characters', ['slug' => 'pell', 'name' => 'Pell', 'status' => 'sketch', 'fields' => [['label' => 'Species', 'value' => 'Human'], ['label' => 'Age', 'value' => '50']], 'sections' => [['h' => 'Overview', 'body' => 'Hired hand. Talks to the trees.']], 'related' => [], 'relatedRaw' => null]);

/* ---- planning, continuity */
save_ledger_item('salt-orchard', ['kind' => 'promise', 'slug' => 'brass-key', 'title' => 'What the brass key opens', 'planted_in' => '2', 'payoff_in' => '4', 'status' => 'paid-off', 'characters' => ['maren-hollis', 'ilse-hollis'], 'notes' => 'Opens the net loft chest.']);
save_ledger_item('salt-orchard', ['kind' => 'question', 'slug' => 'why-ilse-left', 'title' => 'Why did Ilse leave?', 'planted_in' => '1', 'status' => 'open', 'characters' => ['ilse-hollis'], 'notes' => 'Answer lands late.']);
save_ledger_item('salt-orchard', ['kind' => 'promise', 'slug' => 'the-second-flood', 'title' => 'The second flood', 'planted_in' => '3', 'status' => 'planted', 'characters' => ['pell']]);
set_chapter_cast('salt-orchard', 'ch-01-the-drowned-rows.md', [['slug' => 'maren-hollis', 'role' => 'pov'], ['slug' => 'pell', 'role' => 'appears'], ['slug' => 'ilse-hollis', 'role' => 'mentioned']]);
set_chapter_cast('salt-orchard', 'ch-02-the-key.md', [['slug' => 'maren-hollis', 'role' => 'pov'], ['slug' => 'tobin-reyes', 'role' => 'appears']]);
save_knowledge('salt-orchard', [
    ['character' => 'maren-hollis', 'knows' => 'The key was left for her on purpose', 'learned_in' => '2', 'fact' => 'key-left-on-purpose'],
    ['character' => 'tobin-reyes', 'knows' => 'The survey disagrees with the water', 'learned_in' => '', 'fact' => 'survey-disagrees'],
]);
save_state_events('salt-orchard', [
    ['slug' => 'brass-key', 'event' => 'holder', 'chapter' => '2', 'value' => 'maren-hollis', 'note' => 'Found under the porch step.'],
    ['slug' => 'brass-key', 'event' => 'found', 'chapter' => '2'],
    ['slug' => 'ilse-hollis', 'event' => 'lost', 'chapter' => '3', 'note' => ''],
    ['slug' => 'pell', 'event' => 'location', 'chapter' => '3', 'value' => 'salt-orchard'],
]);
save_exemption('salt-orchard', 'timeline-order', 'brass-key', '3', 'The key is found twice on purpose.');
q("INSERT INTO progressions (book_id,chapter,type,what,related_csv,sort_order,when_label,when_order) VALUES (?,?,?,?,?,?,?,?)", ['salt-orchard', 'Prologue', 'turn', 'The tide book is closed for the last time', 'tidewardens', 1, 'Ninety years ago', 10]);
q("INSERT INTO progressions (book_id,chapter,type,what,related_csv,sort_order) VALUES (?,?,?,?,?,?)", ['salt-orchard', 'Ch. 1', 'intro', 'Maren returns to the flooded orchard', 'maren-hollis,salt-orchard', 2]);
q("INSERT INTO progressions (book_id,chapter,type,what,related_csv,sort_order) VALUES (?,?,?,?,?,?)", ['salt-orchard', 'Ch. 2', 'turn', 'Maren finds the key under the porch step', 'maren-hollis,brass-key', 3]);
q("INSERT INTO progressions (book_id,chapter,type,what,related_csv,sort_order) VALUES (?,?,?,?,?,?)", ['salt-orchard', 'Ch. 4', 'turn', 'The Tidewardens read Ilse\'s letter', 'tidewardens,ilse-hollis', 4]);
rebuild_threads('salt-orchard');

/* ---- sources, notes, meta, workspace */
save_source('salt-orchard', ['cite_key' => 'harbour-survey', 'type' => 'book', 'author' => 'Reyes, A.', 'title' => 'Survey of the Port Aldine Marsh', 'year' => '1998', 'publisher' => 'Aldine Press', 'url' => 'https://example.invalid/survey', 'note' => 'Fictional source for the fixture.']);
reconcile_citations('salt-orchard');
save_note_page('salt-orchard', 'tide-notes', 'Tide notes', "# Tide notes\n\nSlack water at the lane is ninety minutes after the harbour.\n");
save_meta_page('salt-orchard', 'reading-list', 'Reading list', "# Reading list\n\n- Pear culture on reclaimed land\n- A short history of sea walls\n");
$ws = function ($path, $body, $title = null) { return save_workspace_doc('salt-orchard', $path, $body, $title, '', true); };
$ws('plan', "# Plan\n\n1. Arrival\n2. The key\n3. Low water\n4. The Tidewardens\n", 'Plan (outline)');
$ws('style', "# Style guide\n\nShort sentences near the water. Longer ones indoors.\n", 'Style guide');
$ws('state/chapter-01/situation', "# Situation after chapter 1\n\nMaren is at the house. See [[ilse-hollis]].\n", 'Chapter 1 situation');
$ws('timeline/history', "# History\n\n- Ninety years ago: the orchard is planted.\n", 'History');
$ws('plan', "# Plan\n\n1. Arrival\n2. The key\n3. Low water\n4. The Tidewardens\n5. (cut)\n", 'Plan (outline)');   // second plan revision
set_workspace_lock('salt-orchard', 'state/chapter-01', true);

/* ---- tasks, writing log, comments, board, mood board, captures, dictionary */
$t1 = save_task(['book_id' => 'salt-orchard', 'title' => 'Fix the tide times in chapter 1', 'body' => 'Check against the harbour table.', 'status' => 'doing', 'priority' => 'high', 'due' => 'week', 'target_db' => 'locations', 'target_slug' => 'port-aldine']);
add_task_step($t1, 'Find the harbour table'); add_task_step($t1, 'Compare slack water');
toggle_task_step((int) val("SELECT id FROM task_steps WHERE task_id=? ORDER BY id LIMIT 1", [$t1]));
save_task(['book_id' => 'salt-orchard', 'title' => 'Name the second flood', 'body' => '', 'status' => 'todo', 'for_claude' => 1, 'priority' => 'med', 'due' => 'someday']);
add_writing_log(['book_id' => 'salt-orchard', 'log_date' => '2026-01-03', 'words_added' => 640, 'total_words' => 640, 'chapters' => '1', 'minutes' => 55, 'mood' => 'steady', 'note' => 'Good first morning.', 'source' => 'manual']);
add_writing_log(['book_id' => 'salt-orchard', 'log_date' => '2026-01-03', 'words_added' => 210, 'total_words' => 850, 'chapters' => '1', 'minutes' => 20, 'source' => 'manual']);
add_writing_log(['book_id' => 'salt-orchard', 'log_date' => '2026-01-04', 'words_added' => -80, 'total_words' => 770, 'chapters' => '2', 'minutes' => 35, 'source' => 'claude']);
add_chapter_note('salt-orchard', 'ch-01-the-drowned-rows.md', 'a hand\'s depth of brine', 'Is a hand a unit of depth? Check.');
add_chapter_note('salt-orchard', 'ch-02-the-key.md', '', 'Tobin\'s coat joke lands too soon.');
$a = add_canvas_card('salt-orchard', 40, 40, 'Maren arrives', '#7c8cff');
$b = add_canvas_card('salt-orchard', 240, 60, 'The key', '#4F7A52', 'entry', 'brass-key');
add_canvas_link('salt-orchard', $a, $b);
add_vision('salt-orchard', 'Pear blossom over salt water', 'https://example.invalid/images/blossom.jpg');
add_vision('salt-orchard', 'The net loft', '');
add_capture('salt-orchard', 'What if the orchard is the key?');
add_capture('', 'A thought with no book yet.');
add_dictionary_term('salt-orchard', 'Aldine');
add_dictionary_term('salt-orchard', 'Tidewardens');

/* ---------------------------------------------------------------- book 2: a small nonfiction book */
save_book(['id' => 'tidewater-notes', 'folder' => 'tidewater-notes', 'title' => 'Notes on Tidewater Orchards', 'series' => '', 'num' => '', 'status' => 'planning',
    'logline' => 'A short field guide.', 'genre' => 'nonfiction', 'word_target' => '20000', 'sort_order' => 2, 'profile' => 'nonfiction']);
add_book_member('tidewater-notes', 1, 'owner', 1);
upsert_chapter_from_md('tidewater-notes', 'ch-01-why-salt.md', "## Chapter 1 \xE2\x80\x94 Why Salt\n\nSalt changes what a pear tree is willing to do.\n\n## Key takeaways\n\n- Salt stress is selective.\n");
save_entry('tidewater-notes', 'concepts', ['slug' => 'salt-stress', 'name' => 'Salt stress', 'status' => 'sketch', 'fields' => [['label' => 'Domain', 'value' => 'Botany']], 'sections' => [['h' => 'Overview', 'body' => 'How trees respond to saline soil.']], 'related' => [], 'relatedRaw' => null]);
save_source('tidewater-notes', ['cite_key' => 'marsh-pears-2004', 'type' => 'study', 'author' => 'Okafor, N.', 'title' => 'Pear cultivars on reclaimed marsh', 'year' => '2004', 'publisher' => 'Journal of Invented Horticulture']);

/* ---------------------------------------------------------------- stable timestamps (the dump is committed; make it reproducible) */
$tables = array_column(all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"), 'name');
foreach ($tables as $t) {
    $cols = array_column(all("PRAGMA table_info(\"$t\")"), 'name');
    foreach (['created_at', 'updated_at', 'saved_at', 'heartbeat_at', 'acquired_at'] as $c) {
        if (!in_array($c, $cols, true)) continue;
        // 2026-01-05 09:00:00 plus the row id in minutes: every revision gets its own second
        db()->exec("UPDATE \"$t\" SET $c = datetime('2026-01-05 09:00:00', '+' || id || ' minutes') WHERE $c IS NOT NULL");
    }
}
echo "fixture database written: $dbFile\n";
