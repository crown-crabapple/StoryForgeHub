<?php
/** workspace.php — the per-book Workspace: the Claude-Book planning layer that
 *  used to live in local books/<id>/ folders (book settings, style, structure,
 *  synopsis, the plan/outline, development proposals, per-chapter story state,
 *  and the chapter log). One Markdown doc per row, keyed by its Claude-Book
 *  relpath without ".md" (e.g. "plan", "development/world/region-cut",
 *  "state/chapter-05/situation", "timeline/history").
 *
 *  House rules, enforced here so every door (web, api/MCP, push) obeys them:
 *    • updates need the body hash you read (conflicts refused, never merged);
 *    • locked docs refuse writes (a finished chapter's state snapshot);
 *    • append-only docs (timeline/history) only ever grow;
 *    • state/current/<file> is VIRTUAL — it reads the newest state/chapter-NN/<file>
 *      and can't be written (no copies to drift);
 *    • every change records an attributed revision; a delete records a final one.
 *  Loaded by repo.php. Lazy-migrated (ensure_workspace) like the other P-tables. */

const WORKSPACE_REVISION_KEEP = 20;
/** Top-level planning docs, in display order (path => label). */
const WORKSPACE_PLANNING = ['book' => 'Book settings', 'synopsis' => 'Synopsis', 'plan' => 'Plan (outline)',
                            'structure' => 'Structure', 'style' => 'Style guide'];
/** Docs that may only grow (Claude-Book: "history is append-only"). */
const WORKSPACE_APPEND_ONLY = ['timeline/history'];

function ensure_workspace() {
    static $done = false; if ($done) return; $done = true;
    $pk = is_sqlite() ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    try { db()->exec("CREATE TABLE IF NOT EXISTS workspace_docs (
        id $pk, book_id VARCHAR(40) NOT NULL, path VARCHAR(255) NOT NULL, title VARCHAR(255) DEFAULT '',
        body MEDIUMTEXT, locked INT DEFAULT 0, updated_by INT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP )"); } catch (Exception $e) {}
    try { db()->exec("CREATE UNIQUE INDEX uniq_wsdoc ON workspace_docs (book_id, path)"); } catch (Exception $e) {}
    try { db()->exec("CREATE TABLE IF NOT EXISTS workspace_revisions (
        id $pk, book_id VARCHAR(40) NOT NULL, path VARCHAR(255) NOT NULL, body MEDIUMTEXT,
        body_hash VARCHAR(40) DEFAULT '', kind VARCHAR(10) DEFAULT 'save', saved_by INT DEFAULT NULL,
        saved_via VARCHAR(10) DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP )"); } catch (Exception $e) {}
    try { db()->exec("CREATE INDEX k_wsrev ON workspace_revisions (book_id, path)"); } catch (Exception $e) {}
}

/** Canonical doc path: lowercase, '/'-separated, no ".md", no leading "Workspace/"
 *  or "books/<id>/" wrapper, each segment [a-z0-9._-]. Returns '' when invalid. */
function ws_norm_path($p) {
    $p = strtolower(trim(str_replace('\\', '/', (string)$p)));
    $p = preg_replace('#\.md$#', '', $p);
    $p = preg_replace('#^workspace/#', '', trim($p, '/'));
    $segs = array_values(array_filter(explode('/', $p), 'strlen'));
    if (!$segs || count($segs) > 6) return '';
    foreach ($segs as $s) if ($s === '.' || $s === '..' || !preg_match('/^[a-z0-9][a-z0-9._-]{0,79}$/', $s)) return '';
    $p = implode('/', $segs);
    return strlen($p) <= 255 ? $p : '';
}
/** Which Workspace section a path belongs to: planning|development|state|timeline|other. */
function ws_section($path) {
    if (isset(WORKSPACE_PLANNING[$path])) return 'planning';
    $top = explode('/', $path)[0];
    return in_array($top, ['development', 'state', 'timeline'], true) ? $top : 'other';
}
function ws_is_append_only($path) { return in_array($path, WORKSPACE_APPEND_ONLY, true); }
function ws_is_virtual($path) { return strpos($path, 'state/current/') === 0 || $path === 'state/current'; }
function ws_title_for($path) {
    if (isset(WORKSPACE_PLANNING[$path])) return WORKSPACE_PLANNING[$path];
    return ucfirst(str_replace(['-', '_'], ' ', basename($path)));
}

/** Newest state/chapter-NN folder name ("chapter-05"), or null if none yet. */
function ws_latest_state_chapter($book_id) {
    ensure_workspace();
    $best = null; $bestN = -1;
    foreach (all("SELECT path FROM workspace_docs WHERE book_id=? AND path LIKE 'state/chapter-%'", [$book_id]) as $r) {
        if (preg_match('#^state/(chapter-(\d+))/#', $r['path'], $m) && (int)$m[2] > $bestN) { $bestN = (int)$m[2]; $best = $m[1]; }
    }
    return $best;
}
/** Resolve state/current/<file> to the newest chapter snapshot's path; other paths pass through. */
function ws_resolve($book_id, $path) {
    if (!ws_is_virtual($path)) return $path;
    $ch = ws_latest_state_chapter($book_id);
    $rest = substr($path, strlen('state/current/'));
    return ($ch && $rest !== false && $rest !== '') ? 'state/'.$ch.'/'.$rest : '';
}

/** All docs (no bodies) for a book, optionally under a path prefix. */
function get_workspace_docs($book_id, $prefix = '') {
    ensure_workspace();
    $rows = all("SELECT d.id, d.path, d.title, d.locked, d.updated_at, d.body, u.display_name AS updated_by_name
                   FROM workspace_docs d LEFT JOIN users u ON u.id = d.updated_by
                  WHERE d.book_id=? ORDER BY d.path", [$book_id]);
    $prefix = trim(strtolower((string)$prefix), '/');
    $out = [];
    foreach ($rows as $r) {
        if ($prefix !== '' && $r['path'] !== $prefix && strpos($r['path'], $prefix.'/') !== 0) continue;
        $r['words'] = md_word_count((string)$r['body']);
        $r['body_hash'] = md_body_hash($r['body']);
        unset($r['body']);
        $out[] = $r;
    }
    return $out;
}
/** One doc with its body. state/current/<file> resolves to the newest snapshot
 *  (the returned 'path' is the real one; 'requested' keeps what was asked). */
function get_workspace_doc($book_id, $path) {
    ensure_workspace();
    $path = ws_norm_path($path);
    if ($path === '') return null;
    $real = ws_resolve($book_id, $path);
    if ($real === '') return null;
    $d = one("SELECT * FROM workspace_docs WHERE book_id=? AND path=?", [$book_id, $real]);
    if (!$d) return null;
    $d['requested'] = $path;
    $d['body'] = md_body_norm($d['body']);
    $d['body_hash'] = md5($d['body']);
    return $d;
}

/** Create or update a doc. $base is the body hash the writer read ('' only for a
 *  NEW doc; $force skips it for bulk imports). Returns ['status'=>ok|conflict|
 *  locked|error, 'msg', 'path'?, 'created'?]. */
function save_workspace_doc($book_id, $path, $body, $title = null, $base = '', $force = false) {
    ensure_workspace();
    $path = ws_norm_path($path);
    if ($path === '') return ['status'=>'error', 'msg'=>'Invalid path — use lowercase segments like "development/world/region-cut".'];
    if (ws_is_virtual($path)) return ['status'=>'error', 'msg'=>'state/current is derived from the newest state/chapter-NN — write that chapter\'s files instead.'];
    $body = md_body_norm($body);
    $cur = one("SELECT * FROM workspace_docs WHERE book_id=? AND path=?", [$book_id, $path]);
    $uid = function_exists('current_user_id') ? current_user_id() : null;
    if (!$cur) {
        $t = trim((string)$title) !== '' ? trim((string)$title) : ws_title_for($path);
        q("INSERT INTO workspace_docs (book_id, path, title, body, updated_by) VALUES (?,?,?,?,?)", [$book_id, $path, $t, $body, $uid]);
        ws_record_revision($book_id, $path, $body, 'save');
        return ['status'=>'ok', 'msg'=>'Created.', 'path'=>$path, 'created'=>true];
    }
    $old = md_body_norm($cur['body']);
    if ((int)$cur['locked']) return ['status'=>'locked', 'msg'=>'This doc is locked (a finished chapter\'s record). An owner can unlock it.', 'path'=>$path];
    if (!$force) {
        if ($base === '') return ['status'=>'conflict', 'msg'=>'This doc already exists — read it first and pass its body_hash to update it.', 'path'=>$path];
        if ($base !== md5($old)) return ['status'=>'conflict', 'msg'=>'This doc changed since you opened it — another editor (or Claude) saved first. Re-open it and reapply your changes.', 'path'=>$path];
    }
    if (ws_is_append_only($path) && strpos($body, rtrim($old)) !== 0)
        return ['status'=>'error', 'msg'=>'This doc is append-only — new text may only be added after the existing text.', 'path'=>$path];
    $t = ($title !== null && trim((string)$title) !== '') ? trim((string)$title) : $cur['title'];
    if ($body === $old && $t === $cur['title']) return ['status'=>'ok', 'msg'=>'No changes.', 'path'=>$path];
    q("UPDATE workspace_docs SET body=?, title=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [$body, $t, $uid, (int)$cur['id']]);
    ws_record_revision($book_id, $path, $body, 'save');
    return ['status'=>'ok', 'msg'=>'Saved.', 'path'=>$path];
}
/** Append text to a doc (creating it if missing) — no hash needed, nothing is overwritten. */
function append_workspace_doc($book_id, $path, $text) {
    ensure_workspace();
    $path = ws_norm_path($path);
    $text = trim(md_body_norm($text), "\n");
    if ($text === '') return ['status'=>'error', 'msg'=>'Nothing to append.'];
    $d = $path !== '' ? one("SELECT body, locked FROM workspace_docs WHERE book_id=? AND path=?", [$book_id, $path]) : null;
    if (!$d) return save_workspace_doc($book_id, $path, $text."\n");
    $old = md_body_norm($d['body']);
    $new = ($old === '' ? '' : rtrim($old, "\n")."\n\n").$text."\n";
    return save_workspace_doc($book_id, $path, $new, null, md5($old));
}
/** Lock/unlock one doc or every doc under a prefix (e.g. "state/chapter-05"). Returns the count changed. */
function set_workspace_lock($book_id, $path_or_prefix, $locked) {
    ensure_workspace();
    $p = ws_norm_path($path_or_prefix);
    if ($p === '' || ws_is_virtual($p)) return 0;
    $like = str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $p) . '/%';
    return q("UPDATE workspace_docs SET locked=? WHERE book_id=? AND (path=? OR path LIKE ? ESCAPE '!')",
             [$locked ? 1 : 0, $book_id, $p, $like])->rowCount();
}
/** Delete a doc, recording its final body as a 'delete' revision first. */
function delete_workspace_doc($book_id, $path) {
    ensure_workspace();
    $d = one("SELECT * FROM workspace_docs WHERE book_id=? AND path=?", [$book_id, ws_norm_path($path)]);
    if (!$d) return ['status'=>'error', 'msg'=>'Doc not found.'];
    if ((int)$d['locked']) return ['status'=>'locked', 'msg'=>'This doc is locked. Unlock it first.'];
    ws_record_revision($book_id, $d['path'], (string)$d['body'], 'delete');
    q("DELETE FROM workspace_docs WHERE id=?", [(int)$d['id']]);
    return ['status'=>'ok', 'msg'=>'Deleted (its last version stays in history).'];
}

function ws_record_revision($book_id, $path, $body, $kind = 'save') {
    $body = md_body_norm($body);
    $hash = md5($body);
    $last = one("SELECT body_hash FROM workspace_revisions WHERE book_id=? AND path=? ORDER BY id DESC LIMIT 1", [$book_id, $path]);
    if ($kind === 'save' && $last && $last['body_hash'] === $hash) return;
    $uid = function_exists('current_user_id') ? current_user_id() : null;
    q("INSERT INTO workspace_revisions (book_id, path, body, body_hash, kind, saved_by, saved_via) VALUES (?,?,?,?,?,?,?)",
      [$book_id, $path, $body, $hash, $kind, $uid, save_via()]);
    $keepIds = array_map(function ($r) { return (int)$r['id']; },
        all("SELECT id FROM workspace_revisions WHERE book_id=? AND path=? ORDER BY id DESC LIMIT " . (int)WORKSPACE_REVISION_KEEP, [$book_id, $path]));
    if ($keepIds)
        q("DELETE FROM workspace_revisions WHERE book_id=? AND path=? AND id NOT IN (" . implode(',', $keepIds) . ")", [$book_id, $path]);
}
function get_workspace_revisions($book_id, $path, $limit = 25) {
    ensure_workspace();
    return all("SELECT r.id, r.body_hash, r.kind, r.saved_via, r.created_at, u.display_name AS saved_by_name
                  FROM workspace_revisions r LEFT JOIN users u ON u.id = r.saved_by
                 WHERE r.book_id=? AND r.path=? ORDER BY r.id DESC LIMIT " . (int)$limit, [$book_id, $path]);
}
function get_workspace_revision($book_id, $id) {
    ensure_workspace();
    return one("SELECT * FROM workspace_revisions WHERE book_id=? AND id=?", [$book_id, (int)$id]);
}
function count_workspace_docs($book_id) { ensure_workspace(); return (int) val("SELECT COUNT(*) FROM workspace_docs WHERE book_id=?", [$book_id]); }
