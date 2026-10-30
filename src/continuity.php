<?php
/** continuity.php — structured story state for continuity work (adapted from the
 *  story-skills continuity model). Three ledgers, one table each:
 *
 *    • story_ledger    — promises (setup → payoff) and open questions
 *                        (introduced → resolved), with the chapters that do each;
 *    • chapter_cast    — who is on the page in a chapter (pov | appears) versus
 *                        only referred to (mentioned: memories, letters, flashbacks);
 *    • knowledge_facts — what a character knows and the chapter they learned it,
 *                        so "what did X know at chapter N" is a query, not a reread.
 *
 *  Chapter references in the ledgers are chapter NUMBERS (normalised by ch_ref,
 *  so "chapter-04", "Ch. 4" and "04" are all "4"), because a payoff may name a
 *  chapter that isn't written yet. The cast is keyed by chapters.file (stable
 *  across renumbering), like chapter_notes. The Workspace state docs stay the
 *  human-readable view; these tables are the checkable data.
 *  Loaded by repo.php. Lazy-migrated (ensure_continuity) like the other P-tables. */

const LEDGER_KINDS = ['promise', 'question'];
const LEDGER_STATUSES = [
    'promise'  => ['planned', 'planted', 'paid-off', 'dropped', 'abandoned'],
    'question' => ['open', 'resolved', 'dropped', 'abandoned'],
];
const CAST_ROLES = ['pov', 'appears', 'mentioned'];

function ensure_continuity() {
    static $done = false; if ($done) return; $done = true;
    $pk = is_sqlite() ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    try { db()->exec("CREATE TABLE IF NOT EXISTS story_ledger (
        id $pk, book_id VARCHAR(40) NOT NULL, kind VARCHAR(10) NOT NULL, slug VARCHAR(80) NOT NULL,
        title VARCHAR(255) DEFAULT '', status VARCHAR(20) DEFAULT '', planted_in VARCHAR(20) DEFAULT '',
        payoff_in VARCHAR(20) DEFAULT '', characters_csv TEXT, notes TEXT, updated_by INT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )"); } catch (Exception $e) {}
    try { db()->exec("CREATE UNIQUE INDEX uniq_ledger ON story_ledger (book_id, slug)"); } catch (Exception $e) {}
    try { db()->exec("CREATE TABLE IF NOT EXISTS chapter_cast (
        id $pk, book_id VARCHAR(40) NOT NULL, chapter_file VARCHAR(255) NOT NULL, slug VARCHAR(80) NOT NULL,
        role VARCHAR(12) NOT NULL DEFAULT 'appears', sort_order INT DEFAULT 0 )"); } catch (Exception $e) {}
    try { db()->exec("CREATE UNIQUE INDEX uniq_cast ON chapter_cast (book_id, chapter_file, slug)"); } catch (Exception $e) {}
    try { db()->exec("CREATE TABLE IF NOT EXISTS knowledge_facts (
        id $pk, book_id VARCHAR(40) NOT NULL, character_slug VARCHAR(80) NOT NULL, fact VARCHAR(80) NOT NULL,
        knows TEXT, learned_in VARCHAR(20) DEFAULT '', updated_by INT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )"); } catch (Exception $e) {}
    try { db()->exec("CREATE UNIQUE INDEX uniq_fact ON knowledge_facts (book_id, character_slug, fact)"); } catch (Exception $e) {}
}

/** Canonical chapter reference: "chapter-04" / "Ch. 4" / "04" -> "4", "3.5" stays,
 *  prologue/epilogue keep their names. '' for blank; null when unparseable. */
function ch_ref($s) {
    $c = strtolower(trim((string)$s));
    if ($c === '') return '';
    if (strpos($c, 'prologue') !== false) return 'prologue';
    if (strpos($c, 'epilogue') !== false) return 'epilogue';
    if (!preg_match('/^(?:ch(?:apter)?[\s._-]*)?0*(\d+(?:\.\d+)?)\b/', $c, $m)) return null;
    return $m[1];
}
/** Sort key for a canonical chapter reference (prologue first, epilogue last). */
function ch_ord($ref) { return $ref === '' ? 1e9 : prog_chapter_num($ref); }

/** A kebab id: lowercase letters, digits and hyphens. */
function ledger_slug($s) {
    $s = strtolower(trim((string)$s));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    return substr(trim($s, '-'), 0, 80);
}
function csv_slugs($v) {
    $list = is_array($v) ? $v : explode(',', (string)$v);
    return array_values(array_unique(array_filter(array_map('ledger_slug', $list), 'strlen')));
}
/** Entry slugs a book knows, for soft "unknown slug" warnings. */
function known_entry_slugs($book_id) {
    return array_flip(array_column(all("SELECT slug FROM entries WHERE book_id=?", [$book_id]), 'slug'));
}

/* ------------------------------------------------------- promises & questions */
function ledger_row_out($r) {
    return ['slug' => $r['slug'], 'kind' => $r['kind'], 'title' => $r['title'], 'status' => $r['status'],
            'planted_in' => $r['planted_in'], 'payoff_in' => $r['payoff_in'],
            'characters' => csv_slugs($r['characters_csv'] ?? ''), 'notes' => (string)($r['notes'] ?? ''),
            'updated_at' => $r['updated_at']];
}
/** Ledger items, ordered by the chapter that sets them up. Filters: kind, status. */
function get_ledger($book_id, $kind = null, $status = null) {
    ensure_continuity();
    $w = ['book_id=?']; $p = [$book_id];
    if ($kind)   { $w[] = 'kind=?';   $p[] = $kind; }
    if ($status) { $w[] = 'status=?'; $p[] = $status; }
    $rows = array_map('ledger_row_out', all("SELECT * FROM story_ledger WHERE " . implode(' AND ', $w), $p));
    usort($rows, function ($a, $b) {
        return [ch_ord($a['planted_in']), $a['slug']] <=> [ch_ord($b['planted_in']), $b['slug']];
    });
    return $rows;
}
function get_ledger_item($book_id, $slug) {
    ensure_continuity();
    $r = one("SELECT * FROM story_ledger WHERE book_id=? AND slug=?", [$book_id, ledger_slug($slug)]);
    return $r ? ledger_row_out($r) : null;
}

/** Create or update (merge) one ledger item, keyed by slug (derived from the
 *  title when absent). For questions, planted_in = introduced and payoff_in =
 *  resolved. Returns {status: ok|error, msg, item?, created?, warnings?}. */
function save_ledger_item($book_id, $in) {
    ensure_continuity();
    $slug = ledger_slug($in['slug'] ?? '') ?: ledger_slug($in['title'] ?? '');
    if ($slug === '') return ['status' => 'error', 'msg' => 'a slug or title is required'];
    $cur = one("SELECT * FROM story_ledger WHERE book_id=? AND slug=?", [$book_id, $slug]);
    $kind = (string)($in['kind'] ?? ($cur['kind'] ?? 'promise'));
    if (!in_array($kind, LEDGER_KINDS, true)) return ['status' => 'error', 'msg' => 'kind must be promise|question'];
    if ($cur && $cur['kind'] !== $kind) return ['status' => 'error', 'msg' => "'$slug' is already a {$cur['kind']}"];
    $row = $cur ?: ['title' => '', 'status' => '', 'planted_in' => '', 'payoff_in' => '', 'characters_csv' => '', 'notes' => ''];
    foreach (['planted_in', 'payoff_in'] as $k) {
        if (!array_key_exists($k, $in)) continue;
        $ref = ch_ref($in[$k]);
        if ($ref === null) return ['status' => 'error', 'msg' => "$k must be a chapter number (got '{$in[$k]}')"];
        $row[$k] = $ref;
    }
    if (array_key_exists('title', $in)) $row['title'] = trim((string)$in['title']);
    if (array_key_exists('notes', $in)) $row['notes'] = (string)$in['notes'];
    if (array_key_exists('characters', $in)) $row['characters_csv'] = implode(',', csv_slugs($in['characters']));
    if (array_key_exists('status', $in)) $row['status'] = (string)$in['status'];
    if ($row['status'] === '')   // default: what the chapter refs already say
        $row['status'] = $kind === 'question' ? ($row['payoff_in'] !== '' ? 'resolved' : 'open')
                                              : ($row['payoff_in'] !== '' ? 'paid-off' : ($row['planted_in'] !== '' ? 'planted' : 'planned'));
    if (!in_array($row['status'], LEDGER_STATUSES[$kind], true))
        return ['status' => 'error', 'msg' => "status for a $kind must be " . implode('|', LEDGER_STATUSES[$kind])];
    if ($row['title'] === '') $row['title'] = $slug;

    $uid = function_exists('current_user_id') ? current_user_id() : null;
    if ($cur) {
        q("UPDATE story_ledger SET title=?, status=?, planted_in=?, payoff_in=?, characters_csv=?, notes=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
          [$row['title'], $row['status'], $row['planted_in'], $row['payoff_in'], $row['characters_csv'], $row['notes'], $uid, $cur['id']]);
    } else {
        q("INSERT INTO story_ledger (book_id, kind, slug, title, status, planted_in, payoff_in, characters_csv, notes, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [$book_id, $kind, $slug, $row['title'], $row['status'], $row['planted_in'], $row['payoff_in'], $row['characters_csv'], $row['notes'], $uid]);
    }
    $known = known_entry_slugs($book_id);
    $unknown = array_values(array_filter(csv_slugs($row['characters_csv']), function ($s) use ($known) { return !isset($known[$s]); }));
    $out = ['status' => 'ok', 'msg' => ($cur ? 'updated ' : 'created ') . $slug, 'created' => !$cur, 'item' => get_ledger_item($book_id, $slug)];
    if ($unknown) $out['warnings'] = ['unknown character slugs: ' . implode(', ', $unknown)];
    return $out;
}
function delete_ledger_item($book_id, $slug) {
    ensure_continuity();
    return q("DELETE FROM story_ledger WHERE book_id=? AND slug=?", [$book_id, ledger_slug($slug)])->rowCount() > 0;
}

/* --------------------------------------------------- appearances vs mentions */
/** Resolve a chapter by number ("4", "chapter-04") or by its file. Live chapters only. */
function find_chapter_ref($book_id, $chapter) {
    $chapter = trim((string)$chapter);
    if ($chapter === '') return null;
    $chs = get_chapters($book_id);
    foreach ($chs as $c) if ($c['file'] === $chapter) return $c;
    $ref = ch_ref($chapter);
    if ($ref) foreach ($chs as $c) if (ch_ref($c['num']) === $ref) return $c;
    return null;
}
/** The cast of one chapter (role order: pov, appears, mentioned), or of every
 *  chapter when $chapter_file is null. Each row: chapter_file, slug, role. */
function get_chapter_cast($book_id, $chapter_file = null) {
    ensure_continuity();
    $w = 'book_id=?'; $p = [$book_id];
    if ($chapter_file !== null) { $w .= ' AND chapter_file=?'; $p[] = $chapter_file; }
    return all("SELECT chapter_file, slug, role FROM chapter_cast WHERE $w ORDER BY chapter_file,
                CASE role WHEN 'pov' THEN 0 WHEN 'appears' THEN 1 ELSE 2 END, sort_order, slug", $p);
}
/** Replace a chapter's whole cast. $cast: [{slug, role}] (role default 'appears').
 *  A slug listed twice keeps its strongest role (pov > appears > mentioned).
 *  Returns {status, msg, cast?, warnings?}. */
function set_chapter_cast($book_id, $chapter_file, $cast) {
    ensure_continuity();
    if (!is_array($cast)) return ['status' => 'error', 'msg' => 'cast must be a list of {slug, role}'];
    $rank = array_flip(CAST_ROLES);
    $keep = [];
    foreach ($cast as $c) {
        $slug = ledger_slug(is_array($c) ? ($c['slug'] ?? '') : $c);
        $role = is_array($c) ? (string)($c['role'] ?? 'appears') : 'appears';
        if ($slug === '') return ['status' => 'error', 'msg' => 'every cast row needs a slug'];
        if (!isset($rank[$role])) return ['status' => 'error', 'msg' => "role for '$slug' must be pov|appears|mentioned"];
        if (!isset($keep[$slug]) || $rank[$role] < $rank[$keep[$slug]]) $keep[$slug] = $role;
    }
    if (count(array_keys($keep, 'pov', true)) > 1) return ['status' => 'error', 'msg' => 'a chapter has at most one pov'];
    db()->beginTransaction();
    try {
        q("DELETE FROM chapter_cast WHERE book_id=? AND chapter_file=?", [$book_id, $chapter_file]);
        $i = 0;
        foreach ($keep as $slug => $role)
            q("INSERT INTO chapter_cast (book_id, chapter_file, slug, role, sort_order) VALUES (?,?,?,?,?)", [$book_id, $chapter_file, $slug, $role, $i++]);
        db()->commit();
    } catch (Exception $e) { db()->rollBack(); throw $e; }
    $known = known_entry_slugs($book_id);
    $unknown = array_values(array_filter(array_keys($keep), function ($s) use ($known) { return !isset($known[$s]); }));
    $out = ['status' => 'ok', 'msg' => count($keep) . ' in cast', 'cast' => get_chapter_cast($book_id, $chapter_file)];
    if ($unknown) $out['warnings'] = ['unknown slugs (no bible entry): ' . implode(', ', $unknown)];
    return $out;
}
/** Every chapter a slug is in, in chapter order: [{chapter_file, num, title, role}]. */
function get_slug_appearances($book_id, $slug) {
    ensure_continuity();
    $roles = [];
    foreach (all("SELECT chapter_file, role FROM chapter_cast WHERE book_id=? AND slug=?", [$book_id, ledger_slug($slug)]) as $r)
        $roles[$r['chapter_file']] = $r['role'];
    $out = [];
    foreach (get_chapters($book_id) as $c)
        if (isset($roles[$c['file']])) $out[] = ['chapter_file' => $c['file'], 'num' => $c['num'], 'title' => $c['title'], 'role' => $roles[$c['file']]];
    return $out;
}

/* ------------------------------------------------------------- knowledge */
/** Record facts a character knows. $facts: [{character, knows, learned_in?, fact?}].
 *  learned_in blank = known before the story starts. fact is a kebab id unique per
 *  character (derived from `knows` when absent); saving the same id updates it.
 *  All-or-nothing: one bad row refuses the batch. Returns {status, msg, saved?, warnings?}. */
function save_knowledge($book_id, $facts) {
    ensure_continuity();
    if (!is_array($facts) || !$facts) return ['status' => 'error', 'msg' => 'facts must be a non-empty list'];
    $rows = [];
    foreach ($facts as $i => $f) {
        $char = ledger_slug($f['character'] ?? '');
        $knows = trim((string)($f['knows'] ?? ''));
        $ref = ch_ref($f['learned_in'] ?? '');
        if ($char === '' || $knows === '') return ['status' => 'error', 'msg' => "fact $i needs character and knows"];
        if ($ref === null) return ['status' => 'error', 'msg' => "fact $i: learned_in must be a chapter number"];
        $rows[] = [$char, ledger_slug($f['fact'] ?? '') ?: ledger_slug($knows), $knows, $ref];
    }
    $uid = function_exists('current_user_id') ? current_user_id() : null;
    db()->beginTransaction();
    try {
        foreach ($rows as [$char, $fact, $knows, $ref]) {
            $id = val("SELECT id FROM knowledge_facts WHERE book_id=? AND character_slug=? AND fact=?", [$book_id, $char, $fact]);
            if ($id) q("UPDATE knowledge_facts SET knows=?, learned_in=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [$knows, $ref, $uid, $id]);
            else q("INSERT INTO knowledge_facts (book_id, character_slug, fact, knows, learned_in, updated_by) VALUES (?,?,?,?,?,?)", [$book_id, $char, $fact, $knows, $ref, $uid]);
        }
        db()->commit();
    } catch (Exception $e) { db()->rollBack(); throw $e; }
    $known = known_entry_slugs($book_id);
    $unknown = array_values(array_unique(array_filter(array_column($rows, 0), function ($s) use ($known) { return !isset($known[$s]); })));
    $out = ['status' => 'ok', 'msg' => count($rows) . ' fact(s) saved', 'saved' => array_map(function ($r) {
        return ['character' => $r[0], 'fact' => $r[1]]; }, $rows)];
    if ($unknown) $out['warnings'] = ['unknown character slugs: ' . implode(', ', $unknown)];
    return $out;
}
function delete_knowledge($book_id, $character, $fact) {
    ensure_continuity();
    return q("DELETE FROM knowledge_facts WHERE book_id=? AND character_slug=? AND fact=?",
             [$book_id, ledger_slug($character), ledger_slug($fact)])->rowCount() > 0;
}
/** What a character knows — every fact, or only those learned by chapter $at
 *  (pre-story facts included). Also returns the character's arc beats
 *  (progressions) up to that chapter, so status changes come with the facts.
 *  Returns null when $at is given but isn't a chapter number. */
function knowledge_at($book_id, $character, $at = '') {
    ensure_continuity();
    $char = ledger_slug($character);
    $atRef = ch_ref($at);
    if ($atRef === null) return null;
    $limit = $atRef === '' ? INF : ch_ord($atRef);
    $facts = [];
    foreach (all("SELECT fact, knows, learned_in FROM knowledge_facts WHERE book_id=? AND character_slug=?", [$book_id, $char]) as $r) {
        if ($r['learned_in'] !== '' && ch_ord($r['learned_in']) > $limit) continue;
        $facts[] = ['fact' => $r['fact'], 'knows' => $r['knows'], 'learned_in' => $r['learned_in'] === '' ? 'before the story' : $r['learned_in']];
    }
    usort($facts, function ($a, $b) {
        $oa = $a['learned_in'] === 'before the story' ? -1 : ch_ord($a['learned_in']);
        $ob = $b['learned_in'] === 'before the story' ? -1 : ch_ord($b['learned_in']);
        return [$oa, $a['fact']] <=> [$ob, $b['fact']];
    });
    $beats = [];
    foreach (get_entity_arc($book_id, $char) as $p) {
        if ($p['_ord'] > $limit) continue;   // unplaced beats sort at 1e9, so an --at view leaves them out
        $beats[] = ['chapter' => $p['_bucket'], 'type' => $p['type'] ?? '', 'what' => $p['what'] ?? ''];
    }
    return ['character' => $char, 'at' => $atRef === '' ? 'all' : $atRef, 'facts' => $facts, 'arc' => $beats];
}
