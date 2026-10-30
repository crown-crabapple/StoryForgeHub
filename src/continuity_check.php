<?php
/** continuity_check.php — deterministic continuity checks over the ledgers in
 *  continuity.php (the story-skills "continuity compiler" idea): plain
 *  contradictions in the recorded data, reported with a stable code so the AI
 *  reviewers can spend their attention on judgement calls instead.
 *
 *  Reads only structured data — never prose — and gives the same answer every
 *  time. Story time is chapter order; a state event holds as of the END of its
 *  chapter, so a character revived in chapter 9 may appear in chapter 9.
 *  A death or loss only counts once its chapter is drafted (planned deaths in
 *  outline chapters don't fire). "Drafted" = a live chapter whose status is
 *  drafted or revised. Gaps count chapters, not chapter numbers.
 *
 *  Codes (E = error, W = warning):
 *    E posthumous-appearance    dead character is pov/appears (mentioned is fine)
 *    E posthumous-learning      dead character learns a fact
 *    E revived-without-death    revived with no earlier death
 *    W deceased-holder          an object passes to a dead character
 *    E gone-object-used         destroyed / lost object appears, or changes hands after destruction
 *    W object-away-from-holder  object appears but whoever held it isn't on the page and nobody took it
 *    E promise-payoff-before-plant / question-resolved-before-introduced
 *    E promise-plant-missing / promise-payoff-missing / question-resolution-missing / question-open-but-resolved
 *    W promise-stale-planned    planned, but its planting chapter is drafted
 *    W promise-payoff-passed    payoff chapter drafted, status still planted
 *    W promise-unpaid           planted, no payoff, >= promise_gap chapters since
 *    W question-unanswered      open, unresolved, >= question_gap chapters since
 *    W pov-not-in-cast          the chapter's POV isn't in its recorded cast
 *    W missing-chapter          knowledge / state event names a chapter that doesn't exist
 *    W unknown-entry            a slug with no bible entry
 *
 *  A candidate ({chapter, cast?}) overlays a draft chapter's cast before it is
 *  saved — the pipeline's pre-review gate. Loaded by continuity.php. */

const CONTINUITY_CODES = [
    'posthumous-appearance' => 'error', 'posthumous-learning' => 'error', 'revived-without-death' => 'error',
    'deceased-holder' => 'warning', 'gone-object-used' => 'error', 'object-away-from-holder' => 'warning',
    'promise-payoff-before-plant' => 'error', 'question-resolved-before-introduced' => 'error',
    'promise-plant-missing' => 'error', 'promise-payoff-missing' => 'error',
    'question-resolution-missing' => 'error', 'question-open-but-resolved' => 'error',
    'promise-stale-planned' => 'warning', 'promise-payoff-passed' => 'warning', 'promise-unpaid' => 'warning',
    'question-unanswered' => 'warning', 'pov-not-in-cast' => 'warning', 'missing-chapter' => 'warning',
    'unknown-entry' => 'warning',
];

/** Run every check. $candidate: null, or {chapter, cast?:[{slug, role}]} — a draft
 *  chapter (existing or not yet created) treated as drafted with that cast.
 *  Returns {pass, errors, warnings, dismissed, thresholds, findings[], dismissed_findings[]}
 *  or {error} for a bad candidate. Each finding: {code, severity, chapter, slug, message[, candidate]}. */
function continuity_check($book_id, $candidate = null) {
    ensure_continuity();
    $th = continuity_thresholds($book_id);

    /* ---- chapters in story order, with their casts ---- */
    $chs = []; $byFile = [];
    foreach (get_chapters($book_id) as $c) {
        $ref = ch_ref($c['num']);
        if (!$ref) continue;   // unnumbered chapters can't be placed in story time
        $chs[$ref] = ['ref' => $ref, 'ord' => ch_ord($ref), 'file' => $c['file'], 'pov' => trim((string)$c['pov']),
                      'drafted' => in_array($c['status'], ['drafted', 'revised'], true), 'cast' => [], 'has_cast' => false];
        $byFile[$c['file']] = $ref;
    }
    foreach (get_chapter_cast($book_id) as $r) {
        if (!isset($byFile[$r['chapter_file']])) continue;
        $chs[$byFile[$r['chapter_file']]]['cast'][$r['slug']] = $r['role'];
        $chs[$byFile[$r['chapter_file']]]['has_cast'] = true;
    }
    $candRef = null;
    if ($candidate !== null) {
        $candRef = ch_ref($candidate['chapter'] ?? '');
        if (!$candRef) return ['error' => 'candidate.chapter must be a chapter number'];
        if (!isset($chs[$candRef])) $chs[$candRef] = ['ref' => $candRef, 'ord' => ch_ord($candRef), 'file' => '', 'pov' => '', 'cast' => [], 'has_cast' => false];
        $chs[$candRef]['drafted'] = true;
        if (isset($candidate['cast'])) {
            if (!is_array($candidate['cast'])) return ['error' => 'candidate.cast must be a list of {slug, role}'];
            $cast = [];
            foreach ($candidate['cast'] as $c) {
                $slug = ledger_slug(is_array($c) ? ($c['slug'] ?? '') : $c);
                $role = is_array($c) ? (string)($c['role'] ?? 'appears') : 'appears';
                if ($slug === '' || !in_array($role, CAST_ROLES, true)) return ['error' => 'candidate.cast rows need a slug and role pov|appears|mentioned'];
                $cast[$slug] = $role;
            }
            $chs[$candRef]['cast'] = $cast; $chs[$candRef]['has_cast'] = true;
        }
    }
    uasort($chs, function ($a, $b) { return $a['ord'] <=> $b['ord']; });
    $drafted = function ($ref) use (&$chs) { return $ref !== '' && !empty($chs[$ref]['drafted']); };
    $latestDrafted = -INF;
    foreach ($chs as $c) if ($c['drafted']) $latestDrafted = max($latestDrafted, $c['ord']);
    $gapAfter = function ($ref) use (&$chs, $latestDrafted) {   // chapters after $ref, up to the latest drafted one
        $o = ch_ord($ref); $n = 0;
        foreach ($chs as $c) if ($c['ord'] > $o && $c['ord'] <= $latestDrafted) $n++;
        return $n;
    };
    $onPage = function ($ref, $slug) use (&$chs) { $r = $chs[$ref]['cast'][$slug] ?? ''; return $r === 'pov' || $r === 'appears'; };

    $F = [];
    $add = function ($code, $chapter, $slug, $msg) use (&$F) {
        $F[] = ['code' => $code, 'severity' => CONTINUITY_CODES[$code], 'chapter' => (string)$chapter, 'slug' => (string)$slug, 'message' => $msg];
    };

    $entries = [];
    foreach (all("SELECT db_key, slug, name FROM entries WHERE book_id=?", [$book_id]) as $e) $entries[$e['slug']] = $e;
    $events = [];
    foreach (get_state_events($book_id) as $ev) $events[$ev['slug']][] = $ev + ['ord' => ch_ord($ev['chapter'])];
    $facts = all("SELECT character_slug, fact, learned_in FROM knowledge_facts WHERE book_id=?", [$book_id]);
    $ledger = get_ledger($book_id);

    /* ---- deaths: windows (death, revival) in which a character can't be on the page ---- */
    $dead = [];   // slug => [[deathOrd, reviveOrd, deathRef]]
    foreach ($events as $slug => $evs) {
        $open = null;
        foreach ($evs as $ev) {
            if ($ev['event'] === 'died') {
                if ($open === null && $drafted($ev['chapter'])) $open = $ev;
            } elseif ($ev['event'] === 'revived') {
                if ($open === null) {
                    $hadDeath = false;
                    foreach ($evs as $d) if ($d['event'] === 'died' && $d['ord'] <= $ev['ord']) $hadDeath = true;
                    if (!$hadDeath) $add('revived-without-death', $ev['chapter'], $slug, "$slug is revived in chapter {$ev['chapter']} but never died before it");
                    continue;
                }
                $dead[$slug][] = [$open['ord'], $ev['ord'], $open['chapter']]; $open = null;
            }
        }
        if ($open !== null) $dead[$slug][] = [$open['ord'], INF, $open['chapter']];
    }
    $deadAt = function ($slug, $ord) use (&$dead) {
        foreach ($dead[$slug] ?? [] as [$d, $r, $ref]) if ($ord > $d && $ord < $r) return $ref;
        return null;
    };
    foreach ($chs as $ref => $c) foreach ($c['cast'] as $slug => $role) {
        if ($role === 'mentioned') continue;
        if (($d = $deadAt($slug, $c['ord'])) !== null)
            $add('posthumous-appearance', $ref, $slug, "$slug is $role in chapter $ref but died in chapter $d; record them as mentioned if this is a memory or flashback");
    }
    foreach ($facts as $f) {
        if ($f['learned_in'] === '') continue;
        if (($d = $deadAt($f['character_slug'], ch_ord($f['learned_in']))) !== null)
            $add('posthumous-learning', $f['learned_in'], $f['character_slug'], "{$f['character_slug']} learns '{$f['fact']}' in chapter {$f['learned_in']} but died in chapter $d");
    }

    /* ---- objects: gone windows, holders ---- */
    foreach ($events as $slug => $evs) {
        $gone = [];   // [fromOrd, untilOrd, kind, ref]
        foreach ($evs as $i => $ev) {
            if (!in_array($ev['event'], ['destroyed', 'lost'], true) || !$drafted($ev['chapter'])) continue;
            $until = INF;
            if ($ev['event'] === 'lost')   // any later found / holder / location event ends a loss
                foreach ($evs as $later) if ($later['ord'] > $ev['ord'] && in_array($later['event'], ['found', 'holder', 'location'], true)) { $until = min($until, $later['ord']); }
            $gone[] = [$ev['ord'], $until, $ev['event'], $ev['chapter']];
        }
        foreach ($gone as [$from, $until, $kind, $gref]) {
            foreach ($chs as $ref => $c)
                if ($c['ord'] > $from && $c['ord'] < $until && $onPage($ref, $slug))
                    $add('gone-object-used', $ref, $slug, "$slug is on the page in chapter $ref but was $kind in chapter $gref" . ($kind === 'lost' ? ' and not found since' : ''));
            if ($kind === 'destroyed')
                foreach ($evs as $ev)
                    if ($ev['ord'] > $from && in_array($ev['event'], ['found', 'holder', 'location'], true))
                        $add('gone-object-used', $ev['chapter'], $slug, "$slug gets a new {$ev['event']} in chapter {$ev['chapter']} but was destroyed in chapter $gref");
        }
        foreach ($evs as $ev) {
            if ($ev['event'] !== 'holder') continue;
            if (($d = $deadAt($ev['value'], $ev['ord'])) !== null)
                $add('deceased-holder', $ev['chapter'], $slug, "$slug passes to {$ev['value']} in chapter {$ev['chapter']}, who died in chapter $d");
        }
        // On the page without whoever last held it, and nobody took it in that chapter.
        foreach ($chs as $ref => $c) {
            if (($c['cast'][$slug] ?? '') !== 'appears') continue;
            $holder = null; $since = null; $changedHere = false;
            foreach ($evs as $ev) {
                if ($ev['event'] !== 'holder') continue;
                if ($ev['ord'] < $c['ord']) { $holder = $ev['value']; $since = $ev['chapter']; }
                elseif ($ev['ord'] == $c['ord']) $changedHere = true;
            }
            if ($holder !== null && !$changedHere && !$onPage($ref, $holder) && $deadAt($holder, $c['ord']) === null)
                $add('object-away-from-holder', $ref, $slug, "$slug appears in chapter $ref, but $holder has held it since chapter $since and isn't on the page; record a holder change if it moved");
        }
    }

    /* ---- promises & questions ---- */
    foreach ($ledger as $it) {
        if ($it['status'] === 'abandoned') continue;
        $s = $it['slug']; $p = $it['planted_in']; $y = $it['payoff_in'];
        $q = $it['kind'] === 'question';
        if ($p !== '' && $y !== '' && ch_ord($y) < ch_ord($p))
            $add($q ? 'question-resolved-before-introduced' : 'promise-payoff-before-plant', $y, $s,
                 $q ? "question '$s' is resolved in chapter $y before it is introduced in chapter $p"
                    : "promise '$s' pays off in chapter $y before it is planted in chapter $p");
        if ($q) {
            if ($it['status'] === 'resolved' && $y === '') $add('question-resolution-missing', '', $s, "question '$s' is resolved but has no resolving chapter");
            if ($it['status'] === 'open' && $y !== '') $add('question-open-but-resolved', $y, $s, "question '$s' is open but records a resolution in chapter $y");
            if ($it['status'] === 'open' && $y === '' && $drafted($p) && ($n = $gapAfter($p)) >= $th['question_gap'])
                $add('question-unanswered', $p, $s, "question '$s' was introduced in chapter $p, $n chapters ago, and is still open");
            continue;
        }
        if ($it['status'] === 'planted' && $p === '') $add('promise-plant-missing', '', $s, "promise '$s' is planted but has no planting chapter");
        if ($it['status'] === 'paid-off' && $y === '') $add('promise-payoff-missing', '', $s, "promise '$s' is paid off but has no payoff chapter");
        if ($it['status'] === 'planned' && $drafted($p)) $add('promise-stale-planned', $p, $s, "promise '$s' is still planned but chapter $p, where it is planted, is drafted");
        if ($it['status'] === 'planted' && $y !== '' && $drafted($y)) $add('promise-payoff-passed', $y, $s, "promise '$s' should pay off in chapter $y, which is drafted, but is still planted");
        if ($it['status'] === 'planted' && $p !== '' && $y === '' && ($n = $gapAfter($p)) >= $th['promise_gap'])
            $add('promise-unpaid', $p, $s, "promise '$s' was planted in chapter $p, $n chapters ago, and has no payoff yet");
    }

    /* ---- cast vs POV ---- */
    $byName = [];
    foreach ($entries as $e) if ($e['db_key'] === 'characters') { $byName[strtolower($e['name'])] = $e['slug']; $byName[$e['slug']] = $e['slug']; }
    foreach ($chs as $ref => $c) {
        if (!$c['has_cast'] || $c['pov'] === '') continue;
        $pov = $byName[strtolower($c['pov'])] ?? $byName[ledger_slug($c['pov'])] ?? null;
        if ($pov !== null && !isset($c['cast'][$pov]))
            $add('pov-not-in-cast', $ref, $pov, "chapter $ref is told from {$c['pov']}'s point of view, but $pov isn't in its cast");
    }

    /* ---- references ---- */
    foreach ($facts as $f)
        if ($f['learned_in'] !== '' && !isset($chs[$f['learned_in']]))
            $add('missing-chapter', $f['learned_in'], $f['character_slug'], "{$f['character_slug']} learns '{$f['fact']}' in chapter {$f['learned_in']}, which doesn't exist");
    foreach ($events as $slug => $evs) foreach ($evs as $ev)
        if (!isset($chs[$ev['chapter']]))
            $add('missing-chapter', $ev['chapter'], $slug, "$slug: '{$ev['event']}' is recorded in chapter {$ev['chapter']}, which doesn't exist");
    $used = [];
    foreach ($chs as $ref => $c) foreach ($c['cast'] as $slug => $_) $used[$slug][] = "cast of chapter $ref";
    foreach ($events as $slug => $evs) { $used[$slug][] = 'state events'; foreach ($evs as $ev) if ($ev['value'] !== '') $used[$ev['value']][] = "$slug's {$ev['event']}"; }
    foreach ($facts as $f) $used[$f['character_slug']][] = 'knowledge';
    foreach ($ledger as $it) foreach ($it['characters'] as $slug) $used[$slug][] = "ledger '{$it['slug']}'";
    foreach ($used as $slug => $where)
        if (!isset($entries[$slug]))
            $add('unknown-entry', '', $slug, "'$slug' has no bible entry (used in " . implode(', ', array_slice(array_unique($where), 0, 3)) . ')');

    /* ---- exemptions, ordering, summary ---- */
    $ex = get_exemptions($book_id);
    $keep = []; $dismissed = [];
    foreach ($F as $f) {
        if ($candRef !== null && $f['chapter'] === $candRef) $f['candidate'] = true;
        $hit = null;
        foreach ($ex as $x)
            if ($x['code'] === $f['code'] && ($x['slug'] === '' || $x['slug'] === $f['slug']) && ($x['chapter'] === '' || $x['chapter'] === $f['chapter'])) { $hit = $x; break; }
        if ($hit) $dismissed[] = $f + ['reason' => $hit['reason']]; else $keep[] = $f;
    }
    $order = function ($a, $b) {
        return [$a['severity'] === 'error' ? 0 : 1, ch_ord($a['chapter']), $a['code'], $a['slug']]
           <=> [$b['severity'] === 'error' ? 0 : 1, ch_ord($b['chapter']), $b['code'], $b['slug']];
    };
    usort($keep, $order); usort($dismissed, $order);
    $sev = array_count_values(array_column($keep, 'severity'));
    return ['pass' => empty($sev['error']), 'errors' => (int)($sev['error'] ?? 0), 'warnings' => (int)($sev['warning'] ?? 0),
            'dismissed' => count($dismissed), 'thresholds' => $th, 'candidate' => $candRef,
            'findings' => $keep, 'dismissed_findings' => $dismissed];
}
