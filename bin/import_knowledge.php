<?php
/**
 * import_knowledge.php — one-time backfill of the knowledge_facts ledger from
 * the Workspace's existing state/chapter-NN/knowledge docs (the Claude-Book
 * state-updater's Markdown), so codex_knowledge_at works for chapters written
 * before the continuity ledgers existed.
 *
 *   php bin/import_knowledge.php --book kethra            # dry run: show what would be recorded
 *   php bin/import_knowledge.php --book kethra --apply    # record it
 *
 * Reads "- <who>: <fact>" lines under "Known to specific characters" and
 * "New in chapter N" headings (other sections — known to all, unknown,
 * clues — are skipped). <who> may name several characters ("Emily and
 * Bartleby"); each name must match one character entry by full name, slug,
 * or a word of the name that only one character has. The learned chapter is
 * the first "(chapter N)" / "(learned chapter N)" / "(Ch N)" marker on the
 * line, else the first snapshot the line appears in. Lines that don't resolve
 * are listed, never guessed. Facts already recorded are left alone, so the
 * script is safe to re-run.
 */
require_once __DIR__ . '/../src/repo.php';
$GLOBALS['__save_via'] = 'cli';

$opts = getopt('', ['book:', 'apply']);
$bid = (string)($opts['book'] ?? '');
if ($bid === '' || !get_book($bid)) { fwrite(STDERR, "usage: php bin/import_knowledge.php --book <id> [--apply]\n"); exit(2); }
$apply = isset($opts['apply']);

/* ---- character aliases: full name, slug, and unambiguous name words ---- */
$alias = []; $words = [];
foreach (all("SELECT slug, name FROM entries WHERE book_id=? AND db_key IN ('characters','people')", [$bid]) as $e) {
    $alias[strtolower($e['name'])] = $e['slug'];
    $alias[$e['slug']] = $e['slug'];
    $base = trim(preg_replace('/\(.*?\)/', ' ', $e['name']));   // "Bartleby (the ship's computer)" -> "Bartleby"
    $alias[strtolower($base)] = $e['slug'];
    foreach (preg_split('/\s+/', strtolower($e['name'] . ' ' . $base)) as $w) {
        $w = trim($w, "()'’.,");
        if (strlen($w) >= 3 && !in_array($w, ['the', 'and', 'ship', "ship's", 'computer'], true)) $words[$w][$e['slug']] = true;
    }
}
foreach ($words as $w => $slugs) if (count($slugs) === 1 && !isset($alias[$w])) $alias[$w] = array_key_first($slugs);
$resolve = function ($who) use ($alias) {
    $out = [];
    foreach (preg_split('/\s*(?:,|&|\band\b)\s*/i', trim($who, " *_[]")) as $name) {
        $k = strtolower(trim($name, " *_[]"));
        if ($k === '') continue;
        if (!isset($alias[$k])) return null;   // one unknown name -> the whole line is unresolved
        $out[] = $alias[$k];
    }
    return $out ? array_values(array_unique($out)) : null;
};

/* ---- walk the snapshots in chapter order ---- */
$docs = [];
ensure_workspace();
foreach (all("SELECT path FROM workspace_docs WHERE book_id=? AND path LIKE 'state/chapter-%'", [$bid]) as $d)
    if (preg_match('#^state/chapter-(\d+)/knowledge$#', $d['path'], $m)) $docs[(int)$m[1]] = $d['path'];
ksort($docs);
if (!$docs) { echo "No state/chapter-NN/knowledge docs in '$bid'.\n"; exit(0); }

$facts = [];        // "char|fact" => row (earliest chapter wins)
$unresolved = []; $beliefs = 0; $restated = 0;
foreach ($docs as $n => $path) {
    $body = (string)(get_workspace_doc($bid, $path)['body'] ?? '');
    $section = '';
    foreach (preg_split('/\R/', $body) as $ln) {
        if (preg_match('/^#{2,}\s*(.+?)\s*$/', $ln, $h)) { $section = strtolower($h[1]); continue; }
        if (!preg_match('/known to specific|^new in/', $section)) continue;
        if (!preg_match('/^\s*[-*]\s+(.+?):\s+(.+)$/', $ln, $m)) continue;
        $whoRaw = $m[1]; $qual = '';
        if (preg_match('/^(.*?)\s*\((.*)\)\s*$/', $whoRaw, $q)) { $whoRaw = $q[1]; $qual = strtolower($q[2]); }   // "Emily (observed, chapter 4)"
        if (preg_match('/belie|infer|suggest|guess|suspect|theor/', $qual)) { $beliefs++; continue; }   // CH-16: beliefs aren't knowledge
        $who = $resolve($whoRaw);
        if ($who === null) { $unresolved[] = "chapter $n: " . trim($ln); continue; }
        $text = trim($m[2]);
        $learned = (string)$n; $marked = false;
        if (preg_match('/(?:chapter|ch\.?)\s*(\d+)/', $qual, $c)
            || preg_match('/\((?:learned\s+)?(?:in\s+)?(?:chapter|ch\.?)\s*(\d+)\)/i', $text, $c)) { $learned = (string)(int)$c[1]; $marked = true; }
        // A cumulative "known to specific" list restates earlier facts (often reworded):
        // only take a line in the snapshot of the chapter it was learned in.
        if (strpos($section, 'known to specific') !== false && $marked && (int)$learned !== $n) { $restated++; continue; }
        $text = trim(preg_replace('/\s*\((?:learned\s+)?(?:in\s+)?(?:chapter|ch\.?)\s*\d+\)\s*$/i', '', $text));
        $text = preg_replace('/^knows\s+/i', '', $text);
        $fid = substr(ledger_slug($text), 0, 80);
        if ($fid === '') continue;
        foreach ($who as $slug) {
            $key = "$slug|$fid";
            if (!isset($facts[$key]) || ch_ord($learned) < ch_ord($facts[$key]['learned_in']))
                $facts[$key] = ['character' => $slug, 'fact' => $fid, 'knows' => $text, 'learned_in' => $learned];
        }
    }
}

if ($apply) ensure_continuity();   // a dry run never changes the schema
$existing = [];
try {
    foreach (all("SELECT character_slug, fact FROM knowledge_facts WHERE book_id=?", [$bid]) as $r) $existing[$r['character_slug'] . '|' . $r['fact']] = true;
} catch (Exception $e) { /* table not created yet: nothing recorded */ }
$new = array_values(array_filter($facts, function ($f) use ($existing) { return !isset($existing[$f['character'] . '|' . $f['fact']]); }));
usort($new, function ($a, $b) { return [ch_ord($a['learned_in']), $a['character']] <=> [ch_ord($b['learned_in']), $b['character']]; });

echo ($apply ? 'Recording' : 'Dry run —') . ' ' . count($new) . ' fact(s) from ' . count($docs) . " snapshot(s) in '$bid'"
   . (count($facts) - count($new) ? ' (' . (count($facts) - count($new)) . ' already recorded)' : '') . "\n";
$per = array_count_values(array_column($new, 'character'));
foreach ($per as $slug => $k) echo "  $slug: $k\n";
foreach (array_slice($new, 0, $apply ? 0 : 12) as $f) echo "  ch {$f['learned_in']}  {$f['character']}: " . mb_strimwidth($f['knows'], 0, 100, '…') . "\n";
if ($beliefs || $restated) echo "Skipped $beliefs belief/inference line(s) and $restated restatement(s) of facts from earlier chapters.\n";
if ($unresolved) {
    echo count($unresolved) . " line(s) name someone with no character entry — not imported:\n";
    foreach ($unresolved as $u) echo '  ' . mb_strimwidth($u, 0, 120, '…') . "\n";
}
if ($apply && $new) {
    $r = save_knowledge($bid, $new);
    echo $r['msg'] . "\n";
    if ($r['status'] !== 'ok') exit(1);
    log_activity($bid, 'knowledge_import', $r['msg']);
}
if (!$apply && $new) echo "Re-run with --apply to record them.\n";
