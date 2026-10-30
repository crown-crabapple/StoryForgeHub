<?php
/** continuity_pages.php — web views for the continuity ledgers (continuity.php)
 *  and checks (continuity_check.php): the Continuity page (findings, promises &
 *  questions, state events, knowledge) and the cast block on a chapter page.
 *  Every write goes through the same continuity.php functions the API uses,
 *  so the web and the MCP obey identical rules. POST actions are named cont_*
 *  and are role-gated in index.php's book_gate (edit; cont_settings = manage). */
require_once __DIR__ . '/layout.php';

const CONT_TABS = ['check' => 'Findings', 'ledger' => 'Promises & questions', 'events' => 'State events', 'knowledge' => 'Knowledge'];

/** Lookup helpers shared by the views: entry links by slug, chapter links by ref. */
function cont_entry_map($bid) {
    $m = [];
    foreach (all("SELECT db_key, slug, name FROM entries WHERE book_id=?", [$bid]) as $e) $m[$e['slug']] = $e;
    return $m;
}
function cont_chapter_map($bid) {
    $m = [];
    foreach (get_chapters($bid) as $c) if ($ref = ch_ref($c['num'])) $m[$ref] = $c;
    return $m;
}
function cont_slug_link($bid, $slug, $entries) {
    if ($slug === '') return '';
    if (!isset($entries[$slug])) return '<span class="mono" title="No bible entry">'.e($slug).'</span>';
    $en = $entries[$slug];
    return '<a href="'.url(['p'=>'entry','book'=>$bid,'db'=>$en['db_key'],'slug'=>$slug]).'">'.e($en['name']).'</a>';
}
function cont_ch_link($bid, $ref, $chapters) {
    if ($ref === '' || $ref === null) return '<span class="muted">—</span>';
    if (!isset($chapters[$ref])) return '<span class="mono muted" title="No such chapter yet">'.e($ref).'</span>';
    return '<a href="'.url(['p'=>'chapter','book'=>$bid,'id'=>$chapters[$ref]['id']]).'">'.e($ref).'</a>';
}
function cont_hidden($a, $bid, $extra = []) {
    $h = '<input type="hidden" name="action" value="'.e($a).'"><input type="hidden" name="book" value="'.e($bid).'">';
    foreach ($extra as $k => $v) $h .= '<input type="hidden" name="'.e($k).'" value="'.e($v).'">';
    return $h;
}
function cont_datalist($entries) {
    $h = '<datalist id="cont-slugs">';
    foreach ($entries as $slug => $en) $h .= '<option value="'.e($slug).'">'.e($en['name']).'</option>';
    return $h . '</datalist>';
}
function cont_status_pill($status) {
    $cls = ['planted' => 'doing', 'open' => 'open', 'paid-off' => 'done', 'resolved' => 'done'][$status] ?? 'todo';
    return '<span class="pill '.$cls.'">'.e($status).'</span>';
}
/** Comma/space separated slugs from a form field. */
function cont_slug_list($s) { return csv_slugs(preg_split('/[\s,]+/', (string)$s)); }

/* ============================================================ POST actions */
/** Handle a cont_* POST. Returns the redirect params; flashes the outcome. */
function continuity_post($a, $bid) {
    $P = $_POST;
    $back = ['p' => 'continuity', 'book' => $bid, 'tab' => $P['tab'] ?? 'check'];
    if (!empty($P['character'])) $back['character'] = $P['character'];
    if (isset($P['at']) && $P['at'] !== '') $back['at'] = $P['at'];
    $done = function ($r, $okMsg = null) {
        if (($r['status'] ?? '') === 'ok') {
            $msg = $okMsg ?? ($r['msg'] ?? 'Saved.');
            if (!empty($r['warnings'])) $msg .= ' — ' . implode('; ', $r['warnings']);
            flash($msg);
        } else flash($r['msg'] ?? 'That didn’t work.', 'err');
    };
    switch ($a) {
        case 'cont_ledger_save':
            $in = ['kind' => $P['kind'] ?? 'promise', 'title' => $P['title'] ?? '', 'status' => $P['status'] ?? '',
                   'planted_in' => $P['planted_in'] ?? '', 'payoff_in' => $P['payoff_in'] ?? '',
                   'characters' => cont_slug_list($P['characters'] ?? ''), 'notes' => $P['notes'] ?? ''];
            if (trim($P['slug'] ?? '') !== '') $in['slug'] = $P['slug'];
            $r = save_ledger_item($bid, $in);
            $done($r);
            if ($r['status'] !== 'ok' && !empty($in['slug'])) $back['edit'] = $in['slug'];
            log_activity($bid, 'ledger_save', $r['item']['slug'] ?? '');
            return $back;
        case 'cont_ledger_delete':
            flash(delete_ledger_item($bid, $P['slug'] ?? '') ? 'Deleted.' : 'Not found.', 'ok');
            log_activity($bid, 'ledger_delete', $P['slug'] ?? '');
            return $back;
        case 'cont_event_save':
            $r = save_state_events($bid, [['slug' => $P['slug'] ?? '', 'event' => $P['event'] ?? '', 'chapter' => $P['chapter'] ?? '',
                                          'value' => $P['value'] ?? '', 'note' => $P['note'] ?? '']]);
            $done($r);
            log_activity($bid, 'state_events_save', $r['msg'] ?? '');
            return $back;
        case 'cont_event_delete':
            flash(delete_state_event($bid, $P['slug'] ?? '', $P['event'] ?? '', $P['chapter'] ?? '') ? 'Deleted.' : 'Not found.');
            log_activity($bid, 'state_event_delete', ($P['slug'] ?? '') . ' ' . ($P['event'] ?? ''));
            return $back;
        case 'cont_fact_save':
            $r = save_knowledge($bid, [['character' => $P['character'] ?? '', 'knows' => $P['knows'] ?? '',
                                        'learned_in' => $P['learned_in'] ?? '', 'fact' => $P['fact'] ?? '']]);
            $done($r);
            log_activity($bid, 'knowledge_save', $r['msg'] ?? '');
            return $back;
        case 'cont_fact_delete':
            flash(delete_knowledge($bid, $P['character'] ?? '', $P['fact'] ?? '') ? 'Deleted.' : 'Not found.');
            log_activity($bid, 'knowledge_delete', ($P['character'] ?? '') . '/' . ($P['fact'] ?? ''));
            return $back;
        case 'cont_dismiss':
            $r = save_exemption($bid, $P['code'] ?? '', $P['slug'] ?? '', $P['chapter'] ?? '', $P['reason'] ?? '');
            $done($r);
            log_activity($bid, 'exemption_save', $P['code'] ?? '');
            return $back;
        case 'cont_restore':
            flash(delete_exemption($bid, $P['code'] ?? '', $P['slug'] ?? '', $P['chapter'] ?? '') ? 'Finding restored.' : 'Not found.');
            log_activity($bid, 'exemption_delete', $P['code'] ?? '');
            return $back;
        case 'cont_settings':
            $done(set_continuity_thresholds($bid, $P['promise_gap'] ?? null, $P['question_gap'] ?? null), 'Thresholds saved.');
            log_activity($bid, 'continuity_settings', '');
            return $back;
        case 'cont_cast_save':
            $ch = find_chapter_ref($bid, $P['file'] ?? '');
            if (!$ch) { flash('Chapter not found.', 'err'); return ['p' => 'manuscript', 'book' => $bid]; }
            $cast = [];
            foreach (cont_slug_list($P['pov'] ?? '') as $s) $cast[] = ['slug' => $s, 'role' => 'pov'];
            foreach (cont_slug_list($P['appears'] ?? '') as $s) $cast[] = ['slug' => $s, 'role' => 'appears'];
            foreach (cont_slug_list($P['mentioned'] ?? '') as $s) $cast[] = ['slug' => $s, 'role' => 'mentioned'];
            $done(set_chapter_cast($bid, $ch['file'], $cast), 'Cast saved.');
            log_activity($bid, 'cast_set', $ch['file']);
            return ['p' => 'chapter', 'book' => $bid, 'id' => $ch['id']];
    }
    return $back;
}

/* ============================================================ the page */
function render_continuity_page($book) {
    $bid = $book['id'];
    $tab = $_GET['tab'] ?? 'check';
    if (!isset(CONT_TABS[$tab])) $tab = 'check';
    $canEdit = user_can($bid, 'edit');
    $entries = cont_entry_map($bid);
    $chapters = cont_chapter_map($bid);
    $report = continuity_check($bid);

    echo '<div class="pagehead"><div><h1>Continuity</h1><p class="desc">Structured story state — who is on the page, who knows what, what has been set up and paid off — and the checks that catch plain contradictions in it. Claude keeps these up to date through the <span class="kbd">codex_*</span> tools; the checks read the records, never the prose.</p></div></div>';
    $badge = $report['errors'] ? ' <span class="pill open">'.$report['errors'].'</span>' : ($report['warnings'] ? ' <span class="pill doing">'.$report['warnings'].'</span>' : '');
    echo '<div class="tabs">';
    foreach (CONT_TABS as $k => $label)
        echo '<a class="'.($k === $tab ? 'active' : '').'" href="'.url(['p'=>'continuity','book'=>$bid,'tab'=>$k]).'">'.e($label).($k === 'check' ? $badge : '').'</a>';
    echo '</div>';
    echo cont_datalist($entries);

    if ($tab === 'check') cont_tab_check($book, $report, $entries, $chapters, $canEdit);
    elseif ($tab === 'ledger') cont_tab_ledger($bid, $entries, $chapters, $canEdit);
    elseif ($tab === 'events') cont_tab_events($bid, $entries, $chapters, $canEdit);
    else cont_tab_knowledge($bid, $entries, $chapters, $canEdit);
}

function cont_tab_check($book, $r, $entries, $chapters, $canEdit) {
    $bid = $book['id'];
    $only = ch_ref($_GET['chapter'] ?? '');
    $findings = $only ? array_values(array_filter($r['findings'], function ($f) use ($only) { return $f['chapter'] === $only; })) : $r['findings'];
    $state = $r['errors'] ? '<span class="pill open">'.$r['errors'].' error'.($r['errors'] == 1 ? '' : 's').'</span>' : '<span class="pill done">no errors</span>';
    echo '<p class="desc" style="margin-top:14px">'.$state.' <span class="pill doing">'.$r['warnings'].' warning'.($r['warnings'] == 1 ? '' : 's').'</span>'
       . ($r['dismissed'] ? ' <span class="pill todo">'.$r['dismissed'].' dismissed</span>' : '')
       . ' &nbsp;Errors are contradictions in the record — fix the chapter or the record. Warnings are prompts.'
       . ($only ? ' Showing chapter '.e($only).' only — <a href="'.url(['p'=>'continuity','book'=>$bid]).'">show all</a>.' : '').'</p>';
    echo '<table class="grid"><tr><th></th><th>Chapter</th><th>About</th><th>Finding</th><th></th></tr>';
    foreach ($findings as $f) {
        echo '<tr><td><span class="pill '.($f['severity'] === 'error' ? 'open' : 'doing').'">'.e($f['severity']).'</span></td>'
           . '<td>'.cont_ch_link($bid, $f['chapter'], $chapters).'</td><td>'.cont_slug_link($bid, $f['slug'], $entries).'</td>'
           . '<td>'.e($f['message']).'<div class="muted mono" style="font-size:12px">'.e($f['code']).'</div></td><td>';
        if ($canEdit) {
            echo '<details><summary class="btn sm">Dismiss</summary><form method="post" style="margin-top:6px">'
               . cont_hidden('cont_dismiss', $bid, ['tab'=>'check', 'code'=>$f['code'], 'slug'=>$f['slug'], 'chapter'=>$f['chapter']])
               . '<input type="text" name="reason" required placeholder="Why this is deliberate"><button class="btn sm">Dismiss</button></form></details>';
        }
        echo '</td></tr>';
    }
    if (!$findings) echo '<tr><td colspan="5" class="empty">Nothing to report'.($only ? ' for this chapter' : '').'. Findings appear once chapters have casts, state events, knowledge or ledger items recorded.</td></tr>';
    echo '</table>';

    if ($r['dismissed_findings']) {
        $exs = $canEdit ? get_exemptions($bid) : [];
        echo '<h2 style="font-size:15px;margin-top:24px">Dismissed</h2><table class="grid"><tr><th>Chapter</th><th>About</th><th>Finding</th><th>Reason</th><th></th></tr>';
        foreach ($r['dismissed_findings'] as $f) {
            echo '<tr><td>'.cont_ch_link($bid, $f['chapter'], $chapters).'</td><td>'.cont_slug_link($bid, $f['slug'], $entries).'</td>'
               . '<td class="muted">'.e($f['message']).'<div class="mono" style="font-size:12px">'.e($f['code']).'</div></td><td>'.e($f['reason']).'</td><td>';
            if ($canEdit) {   // undo needs the exemption's own keys: find the one that matched
                foreach ($exs as $x)
                    if ($x['code'] === $f['code'] && ($x['slug'] === '' || $x['slug'] === $f['slug']) && ($x['chapter'] === '' || $x['chapter'] === $f['chapter'])) {
                        echo '<form method="post" style="margin:0">'.cont_hidden('cont_restore', $bid, ['tab'=>'check', 'code'=>$x['code'], 'slug'=>$x['slug'], 'chapter'=>$x['chapter']]).'<button class="btn sm">Restore</button></form>';
                        break;
                    }
            }
            echo '</td></tr>';
        }
        echo '</table>';
    }

    $th = $r['thresholds'];
    echo '<h2 style="font-size:15px;margin-top:24px">Thresholds</h2>';
    if (user_can($bid, 'manage')) {
        echo '<form method="post" class="notewrap" style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap">'.cont_hidden('cont_settings', $bid, ['tab'=>'check'])
           . '<div><label class="f">Warn when a promise is unpaid after</label><input type="number" name="promise_gap" min="0" max="200" value="'.(int)$th['promise_gap'].'" style="width:90px"> chapters</div>'
           . '<div><label class="f">…and a question is unanswered after</label><input type="number" name="question_gap" min="0" max="200" value="'.(int)$th['question_gap'].'" style="width:90px"> chapters</div>'
           . '<button class="btn sm">Save</button><span class="muted" style="font-size:12px">0 restores the defaults (3 and 12).</span></form>';
    } else {
        echo '<p class="desc">Promises warn after '.(int)$th['promise_gap'].' chapters unpaid; questions after '.(int)$th['question_gap'].' unanswered.</p>';
    }
}

function cont_tab_ledger($bid, $entries, $chapters, $canEdit) {
    $items = get_ledger($bid);
    $edit = isset($_GET['edit']) ? get_ledger_item($bid, $_GET['edit']) : null;
    foreach (['promise' => 'Promises', 'question' => 'Questions'] as $kind => $heading) {
        $rows = array_values(array_filter($items, function ($i) use ($kind) { return $i['kind'] === $kind; }));
        echo '<h2 style="font-size:15px;margin-top:22px">'.$heading.' <span class="muted mono">'.count($rows).'</span></h2>';
        echo '<table class="grid"><tr><th>Title</th><th>Status</th><th>'.($kind === 'promise' ? 'Planted' : 'Introduced').'</th><th>'.($kind === 'promise' ? 'Payoff' : 'Resolved').'</th><th>Characters</th><th></th></tr>';
        foreach ($rows as $i) {
            $chars = array_map(function ($s) use ($bid, $entries) { return cont_slug_link($bid, $s, $entries); }, $i['characters']);
            echo '<tr><td>'.e($i['title']).'<div class="muted mono" style="font-size:12px">'.e($i['slug']).'</div>'.($i['notes'] !== '' ? '<div class="muted" style="font-size:13px">'.e($i['notes']).'</div>' : '').'</td>'
               . '<td>'.cont_status_pill($i['status']).'</td><td>'.cont_ch_link($bid, $i['planted_in'], $chapters).'</td><td>'.cont_ch_link($bid, $i['payoff_in'], $chapters).'</td>'
               . '<td>'.implode(', ', $chars).'</td><td style="white-space:nowrap">';
            if ($canEdit) echo '<a class="btn sm" href="'.url(['p'=>'continuity','book'=>$bid,'tab'=>'ledger','edit'=>$i['slug']]).'#ledgerform">Edit</a> '
               . '<form method="post" style="display:inline-block;margin:0" onsubmit="return confirm(\'Delete this item? To retire a real setup, set its status to dropped instead.\')">'
               . cont_hidden('cont_ledger_delete', $bid, ['tab'=>'ledger', 'slug'=>$i['slug']]).'<button class="btn sm">Delete</button></form>';
            echo '</td></tr>';
        }
        if (!$rows) echo '<tr><td colspan="6" class="empty">None recorded yet.</td></tr>';
        echo '</table>';
    }
    if (!$canEdit) return;
    $v = $edit ?: ['slug'=>'', 'kind'=>$_GET['kind'] ?? 'promise', 'title'=>'', 'status'=>'', 'planted_in'=>'', 'payoff_in'=>'', 'characters'=>[], 'notes'=>''];
    echo '<div class="notewrap" id="ledgerform" style="margin-top:24px"><form method="post">'.cont_hidden('cont_ledger_save', $bid, ['tab'=>'ledger']);
    echo '<h2 style="font-size:15px;margin:0 0 4px">'.($edit ? 'Edit “'.e($edit['title']).'”' : 'Add a promise or question').'</h2>';
    if ($edit) echo '<input type="hidden" name="slug" value="'.e($edit['slug']).'"><input type="hidden" name="kind" value="'.e($edit['kind']).'">';
    else echo '<label class="f">Kind</label><select name="kind"><option value="promise"'.($v['kind'] === 'promise' ? ' selected' : '').'>Promise — a setup the reader expects to pay off</option><option value="question"'.($v['kind'] === 'question' ? ' selected' : '').'>Question — something the reader is waiting to learn</option></select>';
    echo '<label class="f">Title</label><input type="text" name="title" required value="'.e($v['title']).'">';
    $opts = '<option value="">(from the chapters)</option>';
    foreach (LEDGER_STATUSES as $k => $sts) {
        if ($edit && $k !== $edit['kind']) continue;
        $opts .= '<optgroup label="'.e($k).'">';
        foreach ($sts as $s) $opts .= '<option value="'.e($s).'"'.($v['status'] === $s ? ' selected' : '').'>'.e($s).'</option>';
        $opts .= '</optgroup>';
    }
    echo '<label class="f">Status</label><select name="status">'.$opts.'</select>';
    echo '<div style="display:flex;gap:14px;flex-wrap:wrap"><div><label class="f">Planted / introduced in chapter</label><input type="text" name="planted_in" value="'.e($v['planted_in']).'" placeholder="3" style="width:140px"></div>'
       . '<div><label class="f">Payoff / resolved in chapter</label><input type="text" name="payoff_in" value="'.e($v['payoff_in']).'" placeholder="may be unwritten" style="width:160px"></div></div>';
    echo '<label class="f">Characters (slugs, comma-separated)</label><input type="text" name="characters" value="'.e(implode(', ', $v['characters'])).'">';
    echo '<label class="f">Notes</label><textarea name="notes" style="min-height:70px">'.e($v['notes']).'</textarea>';
    echo '<div class="toolbar"><button class="btn primary">'.($edit ? 'Save' : 'Add').'</button>'.($edit ? ' <a class="btn sm" href="'.url(['p'=>'continuity','book'=>$bid,'tab'=>'ledger']).'">Cancel</a>' : '').'</div></form></div>';
}

function cont_tab_events($bid, $entries, $chapters, $canEdit) {
    $events = get_state_events($bid);
    echo '<p class="desc" style="margin-top:14px">Status changes, each as of the end of its chapter. Characters: <em>died</em>, <em>revived</em>. Objects: <em>destroyed</em>, <em>lost</em>, <em>found</em>, a new <em>holder</em> or <em>location</em>.</p>';
    echo '<table class="grid"><tr><th>Chapter</th><th>Who / what</th><th>Event</th><th>To</th><th>Note</th><th></th></tr>';
    foreach ($events as $ev) {
        echo '<tr><td>'.cont_ch_link($bid, $ev['chapter'], $chapters).'</td><td>'.cont_slug_link($bid, $ev['slug'], $entries).'</td><td>'.e($ev['event']).'</td>'
           . '<td>'.cont_slug_link($bid, $ev['value'], $entries).'</td><td class="muted">'.e($ev['note'] ?? '').'</td><td>';
        if ($canEdit) echo '<form method="post" style="margin:0">'.cont_hidden('cont_event_delete', $bid, ['tab'=>'events', 'slug'=>$ev['slug'], 'event'=>$ev['event'], 'chapter'=>$ev['chapter']]).'<button class="btn sm">Delete</button></form>';
        echo '</td></tr>';
    }
    if (!$events) echo '<tr><td colspan="6" class="empty">No state events yet.</td></tr>';
    echo '</table>';
    if (!$canEdit) return;
    $opts = '';
    foreach (STATE_EVENTS as $ev) $opts .= '<option value="'.$ev.'">'.$ev.'</option>';
    echo '<div class="notewrap" style="margin-top:24px"><form method="post">'.cont_hidden('cont_event_save', $bid, ['tab'=>'events']);
    echo '<h2 style="font-size:15px;margin:0 0 4px">Record an event</h2><div style="display:flex;gap:14px;flex-wrap:wrap">';
    echo '<div><label class="f">Who / what (slug)</label><input type="text" name="slug" list="cont-slugs" required></div>';
    echo '<div><label class="f">Event</label><select name="event">'.$opts.'</select></div>';
    echo '<div><label class="f">Chapter</label><input type="text" name="chapter" required style="width:90px"></div>';
    echo '<div><label class="f">To (holder / location slug)</label><input type="text" name="value" list="cont-slugs"></div></div>';
    echo '<label class="f">Note</label><input type="text" name="note">';
    echo '<div class="toolbar"><button class="btn primary">Record</button><span class="muted" style="font-size:12px">Recording the same event in the same chapter replaces it.</span></div></form></div>';
}

function cont_tab_knowledge($bid, $entries, $chapters, $canEdit) {
    $chars = [];
    foreach ($entries as $slug => $en) if ($en['db_key'] === 'characters' || $en['db_key'] === 'people') $chars[$slug] = $en['name'];
    foreach (all("SELECT DISTINCT character_slug FROM knowledge_facts WHERE book_id=?", [$bid]) as $r) $chars += [$r['character_slug'] => $r['character_slug']];
    asort($chars);
    $who = ledger_slug($_GET['character'] ?? '') ?: (string)array_key_first($chars);
    $at = trim((string)($_GET['at'] ?? ''));
    echo '<form method="get" class="toolbar" style="margin-top:14px"><input type="hidden" name="p" value="continuity"><input type="hidden" name="book" value="'.e($bid).'"><input type="hidden" name="tab" value="knowledge">';
    echo '<label>Character <select name="character" onchange="this.form.submit()">';
    foreach ($chars as $slug => $name) echo '<option value="'.e($slug).'"'.($slug === $who ? ' selected' : '').'>'.e($name).'</option>';
    echo '</select></label> <label>at chapter <input type="text" name="at" value="'.e($at).'" placeholder="all" style="width:70px"></label> <button class="btn sm">Show</button></form>';
    if ($who === '') { echo '<p class="empty">No characters yet.</p>'; return; }
    $k = knowledge_at($bid, $who, $at);
    if ($k === null) { echo '<p class="flash err">“'.e($at).'” isn’t a chapter number.</p>'; $k = knowledge_at($bid, $who); $at = ''; }
    echo '<h2 style="font-size:15px;margin-top:18px">What '.cont_slug_link($bid, $who, $entries).' knows'.($at !== '' ? ' by chapter '.e($k['at']) : '').'</h2>';
    echo '<table class="grid"><tr><th>Knows</th><th>Learned</th><th></th></tr>';
    foreach ($k['facts'] as $f) {
        echo '<tr><td>'.e($f['knows']).'<div class="muted mono" style="font-size:12px">'.e($f['fact']).'</div></td><td>'
           . ($f['learned_in'] === 'before the story' ? '<span class="muted">before the story</span>' : cont_ch_link($bid, $f['learned_in'], $chapters)).'</td><td>';
        if ($canEdit) echo '<form method="post" style="margin:0">'.cont_hidden('cont_fact_delete', $bid, ['tab'=>'knowledge', 'character'=>$who, 'at'=>$at, 'fact'=>$f['fact']]).'<button class="btn sm">Delete</button></form>';
        echo '</td></tr>';
    }
    if (!$k['facts']) echo '<tr><td colspan="3" class="empty">Nothing recorded'.($at !== '' ? ' by this chapter' : '').'.</td></tr>';
    echo '</table>';
    if ($k['arc']) {
        echo '<h2 style="font-size:15px;margin-top:20px">Arc so far</h2><ul class="entrybody">';
        foreach ($k['arc'] as $b) echo '<li><span class="muted mono">'.e($b['chapter']).'</span> · '.e($b['type']).' — '.inline_md($b['what']).'</li>';
        echo '</ul>';
    }
    if (!$canEdit) return;
    echo '<div class="notewrap" style="margin-top:24px"><form method="post">'.cont_hidden('cont_fact_save', $bid, ['tab'=>'knowledge', 'character'=>$who, 'at'=>$at]);
    echo '<h2 style="font-size:15px;margin:0 0 4px">Record something '.e($chars[$who] ?? $who).' learns</h2>';
    echo '<label class="f">What they know</label><input type="text" name="knows" required>';
    echo '<div style="display:flex;gap:14px;flex-wrap:wrap"><div><label class="f">Learned in chapter</label><input type="text" name="learned_in" placeholder="blank = before the story" style="width:190px"></div>';
    echo '<div><label class="f">Fact id (optional)</label><input type="text" name="fact" placeholder="from the text"></div></div>';
    echo '<div class="toolbar"><button class="btn primary">Record</button><span class="muted" style="font-size:12px">Saving an existing fact id updates it.</span></div></form></div>';
}

/* ============================================================ chapter cast */
/** The cast block on a chapter page: who is on the page vs only mentioned, the
 *  chapter's open findings, and (for editors) a small cast editor. */
function render_chapter_cast($book, $c) {
    $bid = $book['id'];
    if (!profile_has_continuity($book['profile'] ?? 'fiction')) return;
    $cast = get_chapter_cast($bid, $c['file']);
    $canEdit = user_can($bid, 'edit');
    $ref = ch_ref($c['num']);
    $n = 0;
    if ($ref) foreach (continuity_check($bid)['findings'] as $f) if ($f['chapter'] === $ref) $n++;
    if (!$cast && !$canEdit && !$n) return;
    $entries = cont_entry_map($bid);
    $by = ['pov' => [], 'appears' => [], 'mentioned' => []];
    foreach ($cast as $r) $by[$r['role']][] = $r['slug'];
    $chips = function ($slugs) use ($bid, $entries) {
        return implode('', array_map(function ($s) use ($bid, $entries) { return '<span class="relchip">'.cont_slug_link($bid, $s, $entries).'</span>'; }, $slugs));
    };
    echo '<div class="castbar">';
    if ($cast) {
        if ($by['pov']) echo '<span class="castlbl">POV</span>'.$chips($by['pov']);
        if ($by['appears']) echo '<span class="castlbl">On the page</span>'.$chips($by['appears']);
        if ($by['mentioned']) echo '<span class="castlbl">Mentioned</span>'.$chips($by['mentioned']);
    } else echo '<span class="muted">No cast recorded.</span>';
    if ($n) echo ' <a class="pill open" href="'.url(['p'=>'continuity','book'=>$bid,'chapter'=>$ref]).'">'.$n.' continuity finding'.($n == 1 ? '' : 's').'</a>';
    if ($canEdit) {
        echo '<details class="castedit"><summary class="btn sm">Edit cast</summary><form method="post">'.cont_hidden('cont_cast_save', $bid, ['file'=>$c['file']]);
        foreach (['pov' => 'POV (one slug)', 'appears' => 'On the page — physically present', 'mentioned' => 'Mentioned — memory, letter, flashback, talk'] as $role => $label)
            echo '<label class="f">'.e($label).'</label><input type="text" name="'.$role.'" value="'.e(implode(', ', $by[$role])).'"'.($role === 'pov' ? ' list="cont-slugs"' : '').'>';
        echo cont_datalist($entries).'<div class="toolbar"><button class="btn primary sm">Save cast</button><span class="muted" style="font-size:12px">Bible entry slugs, comma-separated.</span></div></form></details>';
    }
    echo '</div>';
}
