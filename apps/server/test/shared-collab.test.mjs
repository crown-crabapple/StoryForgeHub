// M07-J03b acceptance (contract sections 5-7, section 8 items 3 and 4) through the real shared server: comments, reviewer mode, attribution (`by`), advisory presence,
// and a save on an out-of-date base that keeps both versions. The server is the authority: every refusal is checked on the routes themselves, and each refused call
// leaves every library file unchanged. Servers listen on 127.0.0.1 only; nothing here uses a fixed port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { restoreBackup } from '../../../packages/export/src/index.mjs';
import { WRITE_CLASSES, allowed, classifyRead } from '../src/policy.mjs';
import { createPresence, EXPIRE_MS, HEARTBEAT_MS } from '../src/presence.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { createServer } from '../src/server.mjs';
import { close, listen, snapshot } from './helpers.mjs';
import { BOOK, OTHER_BOOK, SCENE, boot, call, closeAll, loadScene, sceneFile } from './shared-helpers.mjs';

const personal = [];
after(async () => {
  await closeAll();
  for (const s of personal) await close(s);
});

const libSnapshot = (t) => snapshot(t.root, { skipStoryforge: true });
const scenePath = (t) => path.join(t.root, 'manuscript', 'act-01-low-water', 'ch-001-the-drowned-rows', '0010-arrival.md');
const commentFiles = async (t) => {
  const out = [];
  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else out.push(path.join(dir, e.name));
    }
  };
  await walk(path.join(t.root, 'comments'));
  return out;
};
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

/** The editor offsets of `needle` in the body. */
const range = (body, needle) => ({ from: body.indexOf(needle), to: body.indexOf(needle) + needle.length });

const FERRY = 'The ferry nudged the jetty';
const DUNES = 'half under water';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the route policy (contract section 3) for the new routes
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('policy: comment routes are comment, reviewer suggestion is suggest, presence is read; GET comments and presence classify as read', async () => {
  const rows = [
    ['POST', `/api/books/${BOOK}/comments`, 'comment-create', 'comment'],
    ['POST', `/api/books/${BOOK}/comments/note_X`, 'comment-resolve', 'comment'],
    ['POST', `/api/books/${BOOK}/comments/note_X/replies`, 'comment-reply', 'comment'],
    ['POST', `/api/books/${BOOK}/suggestions`, 'suggestion-create', 'suggest'],
    ['POST', `/api/books/${BOOK}/presence`, 'presence', 'read'],
  ];
  for (const [method, url, route, cls] of rows) {
    assert.equal(matchWriteRoute(method, url)?.route, route, url);
    assert.equal(WRITE_CLASSES[route], cls, route);
  }
  assert.equal(matchWriteRoute('PUT', `/api/books/${BOOK}/comments`), null);
  assert.equal(matchWriteRoute('DELETE', `/api/books/${BOOK}/comments/note_X`), null, 'a comment is never deleted');
  for (const p of [`/api/books/${BOOK}/comments?target=x`, `/api/books/${BOOK}/presence?scene=x`]) assert.equal(classifyRead(p)?.cls, 'read', p);

  // a POST of class `read` is allowed by the role rules exactly as a GET would be: viewer and up, a share only for its own book
  const user = (role) => ({ kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role });
  for (const role of ['viewer', 'reviewer', 'editor', 'owner']) assert.equal(allowed(user(role), 'read', { book: BOOK }), true, role);
  const share = { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read'] };
  assert.equal(allowed(share, 'read', { book: BOOK }), true);
  assert.equal(allowed(share, 'read', { book: OTHER_BOOK }), false);
  assert.equal(allowed(null, 'read', { book: BOOK }), false);
  // and the classes the new routes use keep their ranks
  assert.equal(allowed(user('viewer'), 'comment', { book: BOOK }), false);
  assert.equal(allowed(user('viewer'), 'suggest', { book: BOOK }), false);
  assert.equal(allowed(user('reviewer'), 'comment', { book: BOOK }), true);
  assert.equal(allowed(user('reviewer'), 'suggest', { book: BOOK }), true);
  assert.equal(allowed(user('reviewer'), 'write', { book: BOOK }), false);
  assert.equal(allowed(share, 'comment', { book: BOOK }), false);
  assert.equal(allowed(share, 'suggest', { book: BOOK }), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// reviewer mode: the reviewer can comment and suggest; cannot save a scene or accept
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('reviewer: comments (create, reply, resolve) with by; the comment file is valid and the scene is untouched', async () => {
  const t = await boot();
  const scene = await loadScene(t, 'reviewer');
  const before = await sceneFile(t);
  const made = await t.call('POST', `/api/books/${BOOK}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 19, quote: 'Past the dunes', text: 'Is the orchard really half under water?' } });
  assert.equal(made.status, 201, made.text);
  const c = made.json.comment;
  assert.deepEqual(c.by, { id: t.users.reviewer.id, name: 'The reviewer' });
  assert.equal(c.status, 'open');
  assert.equal(c.anchored, true);
  assert.equal(c.line, 19);
  assert.match(made.json.path, /^comments\/\d{4}\/\d{8}-\d{6}-[a-z0-9-]+\.md$/);

  const file = await fs.readFile(path.join(t.root, ...made.json.path.split('/')), 'utf8');
  assert.match(file, /^schema: storyforge\.comment\/v1$/m);
  assert.match(file, new RegExp(`^by: \\{ id: ${t.users.reviewer.id}, name: "The reviewer" \\}$`, 'm'));
  assert.match(file, /^anchor: \{ line: 19, lines: 1, quote: "Past the dunes", sha256: "[0-9a-f]{64}" \}$/m);

  const reply = await t.call('POST', `/api/books/${BOOK}/comments/${c.id}/replies`, { cookie: t.c.editor, body: { text: 'It is, at high tide.' } });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.comment.replies.length, 1);
  assert.equal(reply.json.comment.replies[0].name, 'The editor');
  const resolved = await t.call('POST', `/api/books/${BOOK}/comments/${c.id}`, { cookie: t.c.reviewer, body: { status: 'resolved' } });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.comment.status, 'resolved');
  const after1 = await fs.readFile(path.join(t.root, ...made.json.path.split('/')), 'utf8');
  assert.equal(after1.replace(/^status: resolved$/m, 'status: open'), file.replace(/\s+$/, '') + `\n\n## Reply — The editor — ${reply.json.comment.replies[0].at}\nIt is, at high tide.\n`, 'resolve changed only the status line; the reply is an appended section');

  const list = await t.call('GET', `/api/books/${BOOK}/comments?target=${SCENE}`, { cookie: t.c.viewer });
  assert.equal(list.status, 200, 'a viewer can read comments');
  assert.equal(list.json.comments.length, 1);
  assert.equal((await t.call('GET', `/api/books/${BOOK}/comments?status=open`, { cookie: t.c.viewer })).json.comments.length, 0);
  assert.equal(await sceneFile(t), before, 'a comment never changes the scene');
  assert.equal((await loadScene(t)).sha256, scene.sha256);
  assert.deepEqual(await errorsOf(t.root), []);
  assert.deepEqual((await validate(t.root)).diagnostics, [], 'the comment file adds no diagnostic at all');
});

test('reviewer: Suggest change makes a suggestion with source reviewer and by (the client cannot choose the source); the scene is untouched', async () => {
  const t = await boot();
  const scene = await loadScene(t, 'reviewer');
  const before = await sceneFile(t);
  const r = range(scene.body, DUNES);
  const made = await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...r, replacement: 'waist-deep in water' }, rationale: 'More vivid.', source: 'author', mode: 'canon', by: { name: 'Forged' } } });
  assert.equal(made.status, 201, made.text);
  const got = await t.call('GET', `/api/books/${BOOK}/suggestions/${made.json.id}`, { cookie: t.c.reviewer });
  assert.equal(got.json.source, 'reviewer');
  assert.equal(got.json.mode, 'suggest');
  assert.deepEqual(got.json.by, { id: t.users.reviewer.id, name: 'The reviewer' });
  assert.equal(got.json.rationale, 'More vivid.');
  assert.equal(got.json.hunks.length, 1);
  assert.equal(await sceneFile(t), before, 'creating a suggestion never writes the scene');
  assert.deepEqual((await validate(t.root)).diagnostics, []);

  // an editor's suggestion is source author, by the editor
  const ed = await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.editor, body: { target: SCENE, proposedRange: { ...range(scene.body, FERRY), replacement: 'The ferry bumped the jetty' } } });
  assert.equal(ed.status, 201, ed.text);
  const edGot = (await t.call('GET', `/api/books/${BOOK}/suggestions/${ed.json.id}`, { cookie: t.c.owner })).json;
  assert.equal(edGot.source, 'author');
  assert.deepEqual(edGot.by, { id: t.users.editor.id, name: 'The editor' });
  assert.equal((await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE } })).status, 400);
});

test('reviewer: cannot save a scene, edit raw, accept or decline; every refusal leaves the files unchanged', async () => {
  const t = await boot();
  const scene = await loadScene(t);
  const made = await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' } } });
  assert.equal(made.status, 201);
  const snap = await libSnapshot(t);
  const tries = [
    ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'nope\n', base_sha256: scene.sha256 }],
    ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/raw`, { content: 'nope', base_sha256: scene.sha256 }],
    ['POST', `/api/books/${BOOK}/suggestions/${made.json.id}`, { decision: 'accept' }],
    ['POST', `/api/books/${BOOK}/suggestions/${made.json.id}`, { decision: 'decline' }],
    ['POST', `/api/books/${BOOK}/suggestions/${made.json.id}/hunks/h1`, { decision: 'accept' }],
    ['POST', `/api/books/${BOOK}/scenes/${SCENE}/fields`, { title: 'x' }],
    ['POST', `/api/books/${BOOK}/receipts/flush`, { sceneId: SCENE }],
  ];
  for (const [method, url, body] of tries) {
    const r = await t.call(method, url, { cookie: t.c.reviewer, body });
    assert.equal(r.status, 403, `${method} ${url}: ${r.text}`);
    assert.equal(r.json.code, 'ROLE');
  }
  assert.deepEqual(await libSnapshot(t), snap, 'no library file changed');
  assert.equal((await t.call('GET', `/api/books/${BOOK}/suggestions/${made.json.id}`, { cookie: t.c.reviewer })).json.status, 'pending');
  // the editor can accept it
  const acc = await t.call('POST', `/api/books/${BOOK}/suggestions/${made.json.id}`, { cookie: t.c.editor, body: { decision: 'accept' } });
  assert.equal(acc.status, 200, acc.text);
  assert.match(await sceneFile(t), /waist-deep in water/);
});

test('viewer and share: cannot comment, reply, resolve or suggest (403); anonymous gets 401; files unchanged; a viewer may send presence', async () => {
  const t = await boot();
  const scene = await loadScene(t);
  const made = await t.call('POST', `/api/books/${BOOK}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 15, text: 'First.' } });
  assert.equal(made.status, 201, made.text);
  const snap = await libSnapshot(t);
  const attempts = [
    ['POST', `/api/books/${BOOK}/comments`, { target: SCENE, line: 15, text: 'x' }],
    ['POST', `/api/books/${BOOK}/comments/${made.json.id}/replies`, { text: 'x' }],
    ['POST', `/api/books/${BOOK}/comments/${made.json.id}`, { status: 'resolved' }],
    ['POST', `/api/books/${BOOK}/suggestions`, { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'x' } }],
    ['PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: 'x\n', base_sha256: scene.sha256 }],
  ];
  for (const who of ['viewer', 'share', 'exportShare']) {
    for (const [method, url, body] of attempts) {
      const r = await t.call(method, url, { cookie: t.c[who], body });
      assert.equal(r.status, 403, `${who}: ${method} ${url}: ${r.text}`);
    }
  }
  for (const [method, url, body] of attempts) assert.equal((await t.call(method, url, { body })).status, 401, `anonymous ${method} ${url}`);
  assert.deepEqual(await libSnapshot(t), snap);

  // presence is class read: a viewer's heartbeat is accepted; a share link's is accepted and records nothing; another book's share and anonymous are refused
  const beat = (cookie, book = BOOK) => t.call('POST', `/api/books/${book}/presence`, { cookie, body: { scene: SCENE } });
  assert.equal((await beat(t.c.viewer)).status, 200);
  assert.equal((await beat(t.c.share)).status, 200);
  assert.equal((await beat(t.c.share, OTHER_BOOK)).status, 403);
  assert.equal((await beat(undefined)).status, 401);
  const who = (await t.call('GET', `/api/books/${BOOK}/presence?scene=${SCENE}`, { cookie: t.c.viewer })).json;
  assert.deepEqual(who.users.map((u) => u.name), ['The viewer'], 'only the signed-in viewer is listed, not the share link');
  assert.deepEqual(await libSnapshot(t), snap, 'presence writes nothing to the library');
});

test('audit: comment, suggest and refused calls are recorded with the route class and target, never the text', async () => {
  const t = await boot();
  const secret = 'GIRAFFE-COMMENT-TEXT';
  const made = await t.call('POST', `/api/books/${BOOK}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 15, text: secret } });
  assert.equal(made.status, 201);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/comments`, { cookie: t.c.viewer, body: { target: SCENE, line: 15, text: secret } })).status, 403);
  const lines = (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === 'comment.comment-create' && l.actor === t.users.reviewer.id && l.result === 201 && l.target === `${BOOK}`), JSON.stringify(lines.slice(-4)));
  assert.ok(lines.some((l) => l.event === 'comment.comment-create.refused' && l.actor === t.users.viewer.id && l.result === 403));
  assert.ok(!JSON.stringify(lines).includes(secret), 'the audit log never contains comment text');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// attribution on receipts (contract section 6)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('receipts carry by: a save then a flush names the editor; an accepted suggestion names the one who accepted; the receipt file has the by line', async () => {
  const t = await boot();
  const scene = await loadScene(t, 'editor');
  const body = scene.body.replace(FERRY, 'The ferry bumped the jetty');
  const saved = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body, base_sha256: scene.sha256 } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/receipts/flush`, { cookie: t.c.owner, body: { sceneId: SCENE } })).status, 200);
  const sug = await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...range(body, DUNES), replacement: 'waist-deep in water' } } });
  assert.equal(sug.status, 201, sug.text);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/suggestions/${sug.json.id}`, { cookie: t.c.owner, body: { decision: 'accept' } })).status, 200);

  const rc = (await t.call('GET', `/api/books/${BOOK}/receipts?scene=${SCENE}`, { cookie: t.c.viewer })).json.receipts;
  const edit = rc.find((r) => r.operation === 'author.edit');
  assert.deepEqual(edit?.by, { id: t.users.editor.id, name: 'The editor' }, JSON.stringify(rc.map((r) => [r.operation, r.by])));
  const accept = rc.find((r) => r.operation === 'suggestion.accept');
  assert.deepEqual(accept?.by, { id: t.users.owner.id, name: 'Ilse' });
  assert.equal(rc.find((r) => r.operation === 'baseline')?.by, null, 'the system baseline names nobody');
  const file = await fs.readFile(path.join(t.root, ...edit.path.split('/')), 'utf8');
  assert.match(file, new RegExp(`^by: \\{ id: ${t.users.editor.id}, name: "The editor" \\}$`, 'm'));
  assert.deepEqual(await errorsOf(t.root), []);
  assert.equal((await t.call('GET', `/api/books/${BOOK}/receipts/verify`, { cookie: t.c.owner })).json.ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8 item 3: simultaneous edit
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('8.3 simultaneous edit: A saves, B saves from the old base -> 409 STALE; B text is a suggestion, A text is on disk; accepting B hunks merges; nothing is lost', async () => {
  const t = await boot();
  const a0 = await loadScene(t, 'editor');
  const b0 = await loadScene(t, 'editor2');
  assert.equal(a0.sha256, b0.sha256, 'both load the same version');
  const bodyA = a0.body.replace(FERRY, 'The ferry bumped the jetty');
  const bodyB = b0.body.replace(DUNES, 'waist-deep in water');
  assert.notEqual(bodyA, a0.body);
  assert.notEqual(bodyB, b0.body);

  const aSave = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: a0.sha256 } });
  assert.equal(aSave.status, 200, aSave.text);
  const onDiskAfterA = await sceneFile(t);
  assert.ok(onDiskAfterA.includes('The ferry bumped the jetty'));

  const bSave = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: bodyB, base_sha256: b0.sha256 } });
  assert.equal(bSave.status, 409, bSave.text);
  assert.equal(bSave.json.error, 'STALE');
  assert.equal(bSave.json.code, 'STALE');
  assert.equal(bSave.json.current.body, bodyA, 'the 409 carries the current text');
  assert.equal(bSave.json.current.sha256, aSave.json.sha256);
  assert.equal(bSave.json.kept, true);
  assert.ok(bSave.json.suggestion?.id, 'B text was kept as a suggestion');
  assert.equal(await sceneFile(t), onDiskAfterA, "A's text is on disk and the file was not touched by B's save");

  // B's text exists as a suggestion: source author, mode suggest, by B, the stated rationale
  const sug = (await t.call('GET', `/api/books/${BOOK}/suggestions/${bSave.json.suggestion.id}`, { cookie: t.c.editor2 })).json;
  assert.equal(sug.source, 'author');
  assert.equal(sug.mode, 'suggest');
  assert.equal(sug.rationale, 'Saved over a newer version');
  assert.deepEqual(sug.by, { id: t.users.editor2.id, name: 'Second editor' });
  assert.equal(sug.target, SCENE);
  assert.equal(sug.base_sha256, aSave.json.sha256, 'it is made against the current file');
  assert.equal(sug.status, 'pending');
  const suggestionFile = await fs.readFile(path.join(t.root, ...sug.path.split('/')), 'utf8');
  assert.ok(suggestionFile.includes('waist-deep in water'), "B's new line is kept in the suggestion file");
  assert.equal(sug.hunks.length, 2, JSON.stringify(sug.hunks.map((h) => [h.id, h.originalLines, h.newLines])));
  const hB = sug.hunks.find((h) => h.newLines.join('\n').includes('waist-deep'));
  const hRevertA = sug.hunks.find((h) => h !== hB);
  assert.ok(hB && hRevertA);
  assert.ok(hRevertA.originalLines.join('\n').includes('bumped'), "the other hunk would undo A's line: it is B's call, not applied");

  // merge: accept B's hunk, decline the one that would undo A
  const acc = await t.call('POST', `/api/books/${BOOK}/suggestions/${sug.id}/hunks/${hB.id}`, { cookie: t.c.editor2, body: { decision: 'accept' } });
  assert.equal(acc.status, 200, acc.text);
  const dec = await t.call('POST', `/api/books/${BOOK}/suggestions/${sug.id}/hunks/${hRevertA.id}`, { cookie: t.c.editor2, body: { decision: 'decline' } });
  assert.equal(dec.status, 200, dec.text);
  const merged = await sceneFile(t);
  assert.ok(merged.includes('The ferry bumped the jetty'), "A's change is still there");
  assert.ok(merged.includes('waist-deep in water'), "B's change is merged");
  assert.ok(!merged.includes(DUNES));
  assert.equal(merged, onDiskAfterA.replace(DUNES, 'waist-deep in water'), 'exactly the two changes, nothing else');
  assert.deepEqual((await t.call('GET', `/api/books/${BOOK}/suggestions/${sug.id}`, { cookie: t.c.owner })).json.status, 'partial');
  assert.deepEqual(await errorsOf(t.root), []);

  // B can now save normally from the merged version
  const merged1 = await loadScene(t, 'editor2');
  const ok = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: `${merged1.body}`, base_sha256: merged1.sha256 } });
  assert.equal(ok.status, 200, ok.text);
});

test('8.3 offline reconnect: a buffer based on an old sha, sent much later, takes the same 409 path; an identical buffer keeps nothing but still reports STALE', async () => {
  const t = await boot();
  const old = await loadScene(t, 'editor2');
  const bodyA = old.body.replace(FERRY, 'The ferry bumped the jetty');
  assert.equal((await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: old.sha256 } })).status, 200);
  const before = await sceneFile(t);
  // an offline buffer that happens to equal what is on disk now
  const same = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: bodyA, base_sha256: old.sha256 } });
  assert.equal(same.status, 409);
  assert.equal(same.json.error, 'STALE');
  assert.equal(same.json.suggestion, null);
  assert.equal(same.json.kept, true, 'nothing to keep: the two texts are the same');
  // a wholly different buffer: kept
  const different = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: `${old.body}\nAn extra line written offline.\n`, base_sha256: old.sha256 } });
  assert.equal(different.status, 409);
  assert.ok(different.json.suggestion?.id);
  assert.equal(await sceneFile(t), before, 'the file never changed');
  const list = (await t.call('GET', `/api/books/${BOOK}/suggestions?target=${SCENE}`, { cookie: t.c.owner })).json.suggestions;
  assert.equal(list.length, 1);
  // a save from the CURRENT base still works and writes the file
  const cur = await loadScene(t, 'editor2');
  assert.equal((await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: `${cur.body}`, base_sha256: cur.sha256 } })).status, 200);
});

test('personal mode: a stale save is still the plain 409 conflict with no suggestion and no `by` anywhere', async () => {
  const root = await (await import('./helpers.mjs')).copyFixture('valid/salt-orchard');
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  const server = createServer({ repository });
  personal.push(server);
  const port = await listen(server);
  const s0 = (await call(port, 'GET', `/api/books/${BOOK}/scenes/${SCENE}`)).json;
  const a = await call(port, 'PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: { body: s0.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: s0.sha256 } });
  assert.equal(a.status, 200, a.text);
  const b = await call(port, 'PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { body: { body: s0.body.replace(DUNES, 'waist-deep in water'), base_sha256: s0.sha256 } });
  assert.equal(b.status, 409);
  assert.equal(b.json.error, 'conflict');
  assert.equal(b.json.suggestion, undefined);
  await assert.rejects(fs.access(path.join(root, 'suggestions')), 'no suggestion was written');
  // comments work in personal mode as author notes with anchors
  const c = await call(port, 'POST', `/api/books/${BOOK}/comments`, { body: { target: SCENE, line: 15, text: 'Check this.' } });
  assert.equal(c.status, 201, c.text);
  assert.deepEqual(c.json.comment.by, { name: 'Author' });
  assert.deepEqual((await validate(root)).diagnostics, []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// section 8 item 4: export completeness
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('8.4 after a shared session a personal-mode backup has every canonical file plus comments/, and an independent validate() of the restored backup has 0 errors; the export has no comment text', async () => {
  const t = await boot();
  const secret = 'OKAPI-COMMENT-NEVER-EXPORTED';
  const scene = await loadScene(t, 'editor');
  // a shared session: comments, a reviewer suggestion, an edit, a stale save and merge
  const c = await t.call('POST', `/api/books/${BOOK}/comments`, { cookie: t.c.reviewer, body: { target: SCENE, line: 19, quote: 'Past the dunes', text: secret } });
  assert.equal(c.status, 201, c.text);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/comments/${c.json.id}/replies`, { cookie: t.c.editor, body: { text: `${secret} reply` } })).status, 200);
  const rs = await t.call('POST', `/api/books/${BOOK}/suggestions`, { cookie: t.c.reviewer, body: { target: SCENE, proposedRange: { ...range(scene.body, DUNES), replacement: 'waist-deep in water' }, rationale: secret } });
  assert.equal(rs.status, 201, rs.text);
  const bodyA = scene.body.replace(FERRY, 'The ferry bumped the jetty');
  assert.equal((await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: scene.sha256 } })).status, 200);
  const stale = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor2, body: { body: `${scene.body}\nOffline line.\n`, base_sha256: scene.sha256 } });
  assert.equal(stale.status, 409);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/comments/${c.json.id}`, { cookie: t.c.owner, body: { status: 'resolved' } })).status, 200);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/suggestions/${rs.json.id}`, { cookie: t.c.owner, body: { decision: 'accept' } })).status, 200);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/receipts/flush`, { cookie: t.c.owner, body: { sceneId: SCENE } })).status, 200);
  assert.ok((await commentFiles(t)).length >= 1);

  // a personal-mode server over the same library: backup (with and without provenance) and a manuscript export
  const repo = createFsRepository(t.root, { watch: false, pollMs: 0 });
  const server = createServer({ repository: repo });
  personal.push(server);
  const port = await listen(server);
  const live = await libSnapshot(t);
  for (const q of ['', '?provenance=1']) {
    const bk = await call(port, 'GET', `/api/books/${BOOK}/backup${q}`);
    assert.equal(bk.status, 200);
    const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-restore-')), 'restored');
    const restored = await restoreBackup(bk.bytes, target);
    const back = await snapshot(restored.bookRoot, { skipStoryforge: true });
    const want = Object.fromEntries(Object.entries(live).filter(([k]) => q !== '' || !(k === 'provenance' || k.startsWith('provenance/'))));
    // every file of the library (canonical files, comments/, suggestions/) is in the restored backup, byte for byte
    for (const [k, v] of Object.entries(want)) assert.equal(back[k], v, `${q || 'default'}: ${k} is in the backup`);
    assert.ok(Object.keys(back).some((k) => k.startsWith('comments/') && k.endsWith('.md')), 'comments/ is in the backup');
    assert.ok(Object.keys(back).some((k) => k.startsWith('suggestions/')), 'suggestions/ is in the backup');
    assert.ok(Object.keys(back).some((k) => k.startsWith('manuscript/')), 'the manuscript is in the backup');
    // validated independently of the server
    const errs = await errorsOf(restored.bookRoot);
    assert.deepEqual(errs, [], `${q || 'default'}: the restored backup validates with 0 errors`);
  }
  assert.deepEqual(await libSnapshot(t), live, 'backup and export never change the library');

  // comments are never exported to readers
  for (const format of ['markdown']) {
    const ex = await call(port, 'GET', `/api/books/${BOOK}/export?format=${format}`);
    assert.equal(ex.status, 200);
    assert.ok(!ex.text.includes(secret), `${format}: no comment or suggestion rationale text in the export`);
  }
  const exShared = await t.call('GET', `/api/books/${BOOK}/export?format=markdown`, { cookie: t.c.exportShare });
  assert.equal(exShared.status, 200);
  assert.ok(!exShared.text.includes(secret));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// presence (contract section 7): in memory, heartbeat 20 s, expires after 60 s, never blocks a save
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('presence: a heartbeat lasts 60 s on a fake clock; a later heartbeat refreshes it; leaving removes it; bad ids are refused; the table is bounded', () => {
  assert.equal(HEARTBEAT_MS, 20_000);
  assert.equal(EXPIRE_MS, 60_000);
  const clock = { t: 1_000_000 };
  const p = createPresence({ now: () => clock.t });
  assert.equal(p.beat('book_1', 'scene_1', { id: 'usr_a', name: 'Ilse' }), true);
  clock.t += 20_000;
  assert.equal(p.beat('book_1', 'scene_1', { id: 'usr_b', name: 'Tobin' }), true);
  assert.deepEqual(p.who('book_1', 'scene_1').map((u) => u.name), ['Ilse', 'Tobin']);
  assert.deepEqual(p.who('book_1', 'scene_1', 'usr_a').map((u) => u.name), ['Tobin'], 'a person can leave themselves out');
  assert.deepEqual(p.who('book_1', 'scene_2'), []);
  assert.deepEqual(p.who('book_2', 'scene_1'), []);
  clock.t += 39_999; // Ilse's heartbeat is 59.999 s old
  assert.deepEqual(p.who('book_1', 'scene_1').map((u) => u.name), ['Ilse', 'Tobin']);
  clock.t += 1; // exactly 60 s
  assert.deepEqual(p.who('book_1', 'scene_1').map((u) => u.name), ['Tobin'], 'gone 60 s after the last heartbeat');
  p.beat('book_1', 'scene_1', { id: 'usr_b', name: 'Tobin' }); // refreshed
  clock.t += 59_000;
  assert.deepEqual(p.who('book_1', 'scene_1').map((u) => u.name), ['Tobin']);
  clock.t += 1_000;
  assert.deepEqual(p.who('book_1', 'scene_1'), []);
  assert.equal(p.size(), 0, 'expired entries are dropped');
  p.beat('book_1', 'scene_1', { id: 'usr_a', name: 'Ilse' });
  p.beat('book_1', 'scene_2', { id: 'usr_a', name: 'Ilse' });
  assert.equal(p.beat('book_1', null, { id: 'usr_a', name: 'Ilse' }), true, 'scene null: they closed it');
  assert.equal(p.size(), 0);
  assert.equal(p.beat('book_1', '../x', { id: 'usr_a', name: 'Ilse' }), false);
  assert.equal(p.beat('book_1', 'scene_1', { id: 'bad id', name: 'x' }), false);
  for (let i = 0; i < 2100; i++) p.beat('book_1', `scene_${i}`, { id: 'usr_a', name: 'Ilse' });
  assert.ok(p.size() <= 2000, 'bounded');
});

test('presence through the server: "X is also in this scene" for the other editor; self is left out; a heartbeat never blocks or changes a save', async () => {
  const t = await boot();
  const scene = await loadScene(t, 'editor');
  const a = await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor, body: { scene: SCENE } });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(a.json.users, [], 'nobody else yet');
  const b = await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor2, body: { scene: SCENE } });
  assert.deepEqual(b.json.users.map((u) => u.name), ['The editor'], 'the second editor is told who else is here');
  const a2 = await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor, body: { scene: SCENE } });
  assert.deepEqual(a2.json.users.map((u) => u.name), ['Second editor']);
  const get = await t.call('GET', `/api/books/${BOOK}/presence?scene=${SCENE}`, { cookie: t.c.reviewer });
  assert.deepEqual(get.json.users.map((u) => u.name), ['Second editor', 'The editor']);
  // presence never blocks a save
  const saved = await t.call('PUT', `/api/books/${BOOK}/scenes/${SCENE}/body`, { cookie: t.c.editor, body: { body: scene.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: scene.sha256 } });
  assert.equal(saved.status, 200, saved.text);
  // leaving
  await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor2, body: { scene: null } });
  assert.deepEqual((await t.call('GET', `/api/books/${BOOK}/presence?scene=${SCENE}`, { cookie: t.c.owner })).json.users.map((u) => u.name), ['The editor']);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor, body: { scene: 'a/../b' } })).status, 400);
  assert.equal((await t.call('POST', `/api/books/${BOOK}/presence`, { cookie: t.c.editor, body: { scene: 5 } })).status, 400);
  assert.equal((await t.call('GET', `/api/books/${BOOK}/presence`, { cookie: t.c.editor })).status, 400);
});
