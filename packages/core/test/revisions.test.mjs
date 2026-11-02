// M03-J04 acceptance 3 (revisions) and the byte-level half of 4 (restore without erasing):
//   - snapshot triggers (createSnapshotTracker, fake clock): session / interval
//   - storage (store.saveRevision / listRevisions / readRevision / pruneRevisions): dedupe, names, index, byte fidelity
//   - retention (planRetention, fake clock over 120 days) and pruning into the trash, never deleting
//   - revisions follow the scene id across move / rename
//   - splitRevision: front matter / body split used by restore
// The HTTP restore flows (into / new / stale base 409) are in apps/server/test/j04-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '@storyforge/store';
import { createFsRepository } from '../src/index.mjs';
import { INTERVAL_MS, KEEP_DAYS, KEEP_LATEST, SESSION_IDLE_MS, createSnapshotTracker, planRetention, splitRevision } from '../src/revisions.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const SCENE = 'scene_01S50000000000000000000002';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const MIN = 60_000;
const DAY = 86_400_000;

async function openFresh() {
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root, { recover: false });
  return { root, store };
}
const revDir = (root, id = SCENE) => path.join(root, '.storyforge', 'revisions', id);

// ------------------------------------------------------------------ triggers (fake clock)

test('tracker: contract constants (10 min idle, 15 min interval, keep 30 latest + 90 days)', () => {
  assert.equal(SESSION_IDLE_MS, 10 * MIN);
  assert.equal(INTERVAL_MS, 15 * MIN);
  assert.equal(KEEP_LATEST, 30);
  assert.equal(KEEP_DAYS, 90);
});

test('tracker: the first save of a scene is a `session` snapshot', () => {
  const t = createSnapshotTracker();
  assert.equal(t.due(SCENE, 1_000_000), 'session');
});

test('tracker: further saves within the session and under 15 minutes need no snapshot', () => {
  const t = createSnapshotTracker();
  const t0 = 5_000_000;
  assert.equal(t.due(SCENE, t0), 'session');
  for (const m of [1, 2, 5, 9, 12, 14]) assert.equal(t.due(SCENE, t0 + m * MIN), null, `+${m} min`);
});

test('tracker: continuous editing gets an `interval` snapshot every 15 minutes', () => {
  const t = createSnapshotTracker();
  const t0 = 0;
  const reasons = [];
  for (let m = 0; m <= 45; m += 5) reasons.push([m, t.due(SCENE, t0 + m * MIN)]);
  assert.deepEqual(
    reasons.filter(([, r]) => r !== null),
    [[0, 'session'], [15, 'interval'], [30, 'interval'], [45, 'interval']],
  );
});

test('tracker: a gap longer than 10 minutes starts a new session; exactly 10 minutes does not', () => {
  const t = createSnapshotTracker();
  assert.equal(t.due(SCENE, 0), 'session');
  assert.equal(t.due(SCENE, 10 * MIN), null, 'exactly the idle limit is still the same session');
  assert.equal(t.due(SCENE, 20 * MIN + 1), 'session', 'more than 10 minutes since the last save');
  assert.equal(t.due(SCENE, 21 * MIN), null);
});

test('tracker: a new session resets the 15 minute interval', () => {
  const t = createSnapshotTracker();
  assert.equal(t.due(SCENE, 0), 'session');
  assert.equal(t.due(SCENE, 60 * MIN), 'session'); // long gap
  assert.equal(t.due(SCENE, 70 * MIN), null, 'only 10 min since the new session snapshot');
  assert.equal(t.due(SCENE, 75 * MIN), 'interval');
});

test('tracker: scenes are tracked independently', () => {
  const t = createSnapshotTracker();
  assert.equal(t.due('scene_A', 0), 'session');
  assert.equal(t.due('scene_B', MIN), 'session');
  assert.equal(t.due('scene_A', 2 * MIN), null);
  assert.equal(t.due('scene_B', 2 * MIN), null);
});

test('tracker: injectable idle and interval lengths are honoured', () => {
  const t = createSnapshotTracker({ idleMs: 1000, intervalMs: 3000 });
  assert.equal(t.due('s', 0), 'session');
  assert.equal(t.due('s', 900), null);
  assert.equal(t.due('s', 1800), null);
  assert.equal(t.due('s', 2700), null);
  assert.equal(t.due('s', 3600), 'interval');
  assert.equal(t.due('s', 5000), 'session');
});

// ------------------------------------------------------------------ storage

test('saveRevision stores the whole file at <stamp>-<reason>.md with an index entry', async () => {
  const { root, store } = await openFresh();
  const bytes = Buffer.from('---\nschema: storyforge.scene/v1\n---\nbody words here\n');
  const at = new Date(Date.UTC(2026, 9, 31, 14, 2, 3));
  const r = await store.saveRevision(SCENE, bytes, { reason: 'session', at, words: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.stored, true);
  assert.equal(r.entry.file, '20261031T140203Z-session.md');
  assert.deepEqual(r.entry, { file: '20261031T140203Z-session.md', at: at.toISOString(), reason: 'session', sha256: sha(bytes), words: 3 });
  assert.equal(Buffer.compare(await fs.readFile(path.join(revDir(root), r.entry.file)), bytes), 0);
  const index = JSON.parse(await fs.readFile(path.join(revDir(root), 'index.json'), 'utf8'));
  assert.deepEqual(index, [r.entry]);
});

test('saveRevision keeps a trimmed label; a blank label is omitted', async () => {
  const { store } = await openFresh();
  const a = await store.saveRevision(SCENE, Buffer.from('a'), { reason: 'manual', at: 1_000_000, label: '  before rewrite  ' });
  assert.equal(a.entry.label, 'before rewrite');
  const b = await store.saveRevision(SCENE, Buffer.from('b'), { reason: 'manual', at: 2_000_000_000, label: '   ' });
  assert.equal('label' in b.entry, false);
});

test('saveRevision does not store the same bytes twice in a row', async () => {
  const { root, store } = await openFresh();
  const bytes = Buffer.from('same bytes\n');
  const first = await store.saveRevision(SCENE, bytes, { reason: 'session', at: 1_700_000_000_000 });
  const again = await store.saveRevision(SCENE, bytes, { reason: 'manual', at: 1_700_000_900_000 });
  assert.equal(again.ok, true);
  assert.equal(again.stored, false);
  assert.deepEqual(again.entry, first.entry);
  assert.deepEqual((await fs.readdir(revDir(root))).sort(), ['index.json', first.entry.file].sort());
});

test('saveRevision compares with the newest snapshot only: A, B, A stores three', async () => {
  const { store } = await openFresh();
  const A = Buffer.from('A');
  const B = Buffer.from('B');
  const t = 1_700_000_000_000;
  assert.equal((await store.saveRevision(SCENE, A, { reason: 'session', at: t })).stored, true);
  assert.equal((await store.saveRevision(SCENE, B, { reason: 'interval', at: t + MIN })).stored, true);
  assert.equal((await store.saveRevision(SCENE, A, { reason: 'manual', at: t + 2 * MIN })).stored, true);
  assert.equal((await store.listRevisions(SCENE)).length, 3);
});

test('saveRevision in the same second does not overwrite: distinct file names, both bytes kept', async () => {
  const { root, store } = await openFresh();
  const at = Date.UTC(2026, 9, 31, 10, 0, 0);
  const a = await store.saveRevision(SCENE, Buffer.from('one'), { reason: 'manual', at });
  const b = await store.saveRevision(SCENE, Buffer.from('two'), { reason: 'manual', at });
  assert.notEqual(a.entry.file, b.entry.file);
  assert.equal((await fs.readFile(path.join(revDir(root), a.entry.file), 'utf8')), 'one');
  assert.equal((await fs.readFile(path.join(revDir(root), b.entry.file), 'utf8')), 'two');
});

test('saveRevision keeps every kind of byte exactly (CRLF, Unicode, BOM-less UTF-8, empty body)', async () => {
  const { store } = await openFresh();
  const samples = [
    Buffer.from('---\r\nid: x\r\n---\r\nline one\r\nline two\n'),
    Buffer.from('潮が引く café “quoted” 👩‍🚀\n', 'utf8'),
    Buffer.from('---\nid: x\n---\n'),
    Buffer.from([0x00, 0xff, 0xfe, 0x41]),
  ];
  let t = 1_700_000_000_000;
  for (const s of samples) {
    const r = await store.saveRevision(SCENE, s, { reason: 'manual', at: (t += MIN) });
    assert.equal(r.stored, true);
    assert.equal(Buffer.compare(await store.readRevision(SCENE, r.entry.file), s), 0);
  }
});

test('saveRevision refuses bad arguments and unusable scene ids; nothing is written', async () => {
  const { root, store } = await openFresh();
  assert.equal((await store.saveRevision(SCENE, 'not a buffer', { reason: 'manual' })).ok, false);
  assert.equal((await store.saveRevision(SCENE, Buffer.from('x'), { reason: 'Bad Reason!' })).ok, false);
  assert.equal((await store.saveRevision(SCENE, Buffer.from('x'), { reason: 'manual', at: 'nonsense' })).ok, false);
  assert.equal((await store.saveRevision('../../escape', Buffer.from('x'), { reason: 'manual' })).ok, false);
  assert.equal((await store.saveRevision('a/b', Buffer.from('x'), { reason: 'manual' })).ok, false);
  await assert.rejects(fs.stat(revDir(root)));
  await assert.rejects(fs.stat(path.join(root, '..', 'escape')));
});

test('listRevisions: newest first; empty for a scene with none; null for an unusable id', async () => {
  const { store } = await openFresh();
  assert.deepEqual(await store.listRevisions(SCENE), []);
  assert.equal(await store.listRevisions('../x'), null);
  const t = Date.UTC(2026, 0, 1);
  await store.saveRevision(SCENE, Buffer.from('1'), { reason: 'session', at: t });
  await store.saveRevision(SCENE, Buffer.from('3'), { reason: 'manual', at: t + 2 * DAY, label: 'third' });
  await store.saveRevision(SCENE, Buffer.from('2'), { reason: 'interval', at: t + DAY });
  const list = await store.listRevisions(SCENE);
  assert.deepEqual(list.map((e) => e.reason), ['manual', 'interval', 'session']);
  assert.equal(list[0].label, 'third');
});

test('listRevisions tolerates a corrupt or hand-edited index.json (no throw, bad entries ignored)', async () => {
  const { root, store } = await openFresh();
  await fs.mkdir(revDir(root), { recursive: true });
  await fs.writeFile(path.join(revDir(root), 'index.json'), '{ not json');
  assert.deepEqual(await store.listRevisions(SCENE), []);
  await fs.writeFile(path.join(revDir(root), 'index.json'), JSON.stringify([{ file: '../../book.md' }, { nope: 1 }, null]));
  assert.deepEqual(await store.listRevisions(SCENE), []);
});

test('readRevision: exact bytes; null for unknown files and for names that could escape the folder', async () => {
  const { root, store } = await openFresh();
  const r = await store.saveRevision(SCENE, Buffer.from('keep'), { reason: 'manual', at: 1_700_000_000_000 });
  assert.equal((await store.readRevision(SCENE, r.entry.file)).toString(), 'keep');
  assert.equal(await store.readRevision(SCENE, '20200101T000000Z-manual.md'), null);
  for (const evil of ['../../../book.md', '..\\..\\book.md', 'index.json', '/etc/passwd', '', '20200101T000000Z-manual.md/../../x']) {
    assert.equal(await store.readRevision(SCENE, evil), null, evil);
  }
  assert.equal(await store.readRevision('../x', r.entry.file), null);
  assert.ok((await fs.readFile(path.join(root, 'book.md'), 'utf8')).includes('The Salt Orchard'), 'the book was not touched');
});

test('saving revisions never touches the manuscript files', async () => {
  const { root, store } = await openFresh();
  const before = await fs.readFile(path.join(root, 'book.md'));
  await store.saveRevision(SCENE, Buffer.from('x'), { reason: 'session' });
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, 'book.md')), before), 0);
});

// ------------------------------------------------------------------ retention (fake clock)

/** A local-time instant: the retention plan buckets by the author's local date. */
const localAt = (daysAgo, hour, now) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const NOW = new Date(2026, 10, 1, 23, 0, 0).getTime();
const entry = (daysAgo, hour, reason = 'session', now = NOW) => {
  const at = localAt(daysAgo, hour, now).toISOString();
  return { file: `${at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${reason}.md`, at, reason };
};

test('planRetention: nothing is pruned while a scene has 30 or fewer ordinary snapshots', () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(i, 12));
  assert.deepEqual(planRetention(entries, NOW), []);
  assert.deepEqual(planRetention([], NOW), []);
});

test('planRetention over 120 days, one snapshot a day: keeps the latest 30 and one per day up to 90 days, prunes older', () => {
  const entries = Array.from({ length: 120 }, (_, d) => entry(d, 12));
  const pruned = new Set(planRetention(entries, NOW));
  entries.forEach((e, d) => {
    if (d <= 88) assert.equal(pruned.has(e.file), false, `day ${d} ago is kept`);
    if (d >= 91) assert.equal(pruned.has(e.file), true, `day ${d} ago is pruned`);
  });
  assert.ok(pruned.size >= 29 && pruned.size <= 31, `about 29-31 pruned, got ${pruned.size}`);
});

test('planRetention keeps every manual and restore snapshot however old or many', () => {
  const entries = [
    ...Array.from({ length: 50 }, (_, i) => entry(i * 3, 12, 'manual')),
    ...Array.from({ length: 50 }, (_, i) => entry(i * 3, 13, 'restore')),
    entry(400, 9, 'manual'),
    entry(400, 10, 'restore'),
  ];
  assert.deepEqual(planRetention(entries, NOW), []);
});

test('planRetention: manual and restore do not count against the 30 latest', () => {
  const entries = [...Array.from({ length: 40 }, (_, i) => entry(0, 0, 'manual', NOW - i * MIN)), ...Array.from({ length: 30 }, (_, i) => entry(0, 1, 'session', NOW - i * MIN))];
  // 40 manual (kept) + 30 ordinary (the full allowance): nothing to prune
  assert.deepEqual(planRetention(entries, NOW), []);
});

test('planRetention: many snapshots in one day: beyond the latest 30, only the newest of each older day survives', () => {
  const entries = [];
  for (let day = 0; day < 5; day++) for (let h = 0; h < 10; h++) entries.push(entry(day, 8 + h, h % 2 ? 'interval' : 'session'));
  // 50 ordinary snapshots; latest 30 = all of days 0, 1, 2; days 3 and 4 keep only their newest
  const pruned = new Set(planRetention(entries, NOW));
  assert.equal(pruned.size, 18);
  for (const day of [3, 4]) {
    const ofDay = entries.filter((e) => localDate(e.at) === localDate(localAt(day, 12, NOW).toISOString())).sort((a, b) => (a.at < b.at ? 1 : -1));
    assert.equal(pruned.has(ofDay[0].file), false, `newest of day ${day} kept`);
    for (const e of ofDay.slice(1)) assert.equal(pruned.has(e.file), true);
  }
  for (const e of entries.slice(0, 30)) assert.equal(pruned.has(e.file), false);
});

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

test('planRetention returns only files present in the input and does not mutate it', () => {
  const entries = Array.from({ length: 60 }, (_, i) => entry(i * 2, 12));
  const copy = JSON.parse(JSON.stringify(entries));
  const out = planRetention(entries, NOW);
  assert.deepEqual(entries, copy);
  const files = new Set(entries.map((e) => e.file));
  for (const f of out) assert.ok(files.has(f));
  assert.equal(new Set(out).size, out.length, 'no duplicates');
});

test('planRetention does not depend on input order', () => {
  const entries = Array.from({ length: 120 }, (_, d) => entry(d, 12));
  const forward = planRetention(entries, NOW).sort();
  const backward = planRetention([...entries].reverse(), NOW).sort();
  assert.deepEqual(backward, forward);
});

// ------------------------------------------------------------------ pruning moves to the trash

test('pruneRevisions moves files into .storyforge/trash/<opId>/revisions/<scene>/ and drops them from the index; bytes survive', async () => {
  const { root, store } = await openFresh();
  const a = await store.saveRevision(SCENE, Buffer.from('old text'), { reason: 'session', at: 1_700_000_000_000 });
  const b = await store.saveRevision(SCENE, Buffer.from('new text'), { reason: 'interval', at: 1_700_000_100_000 });
  const r = await store.pruneRevisions(SCENE, [a.entry.file]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pruned, [a.entry.file]);
  assert.ok(r.opId);
  await assert.rejects(fs.stat(path.join(revDir(root), a.entry.file)), 'gone from the revisions folder');
  const trashed = path.join(root, '.storyforge', 'trash', r.opId, 'revisions', SCENE, a.entry.file);
  assert.equal((await fs.readFile(trashed, 'utf8')), 'old text', 'in the trash, not deleted');
  assert.deepEqual((await store.listRevisions(SCENE)).map((e) => e.file), [b.entry.file]);
  assert.equal((await fs.readFile(path.join(revDir(root), b.entry.file), 'utf8')), 'new text');
});

test('pruneRevisions ignores unknown or unsafe names and reports nothing pruned', async () => {
  const { root, store } = await openFresh();
  const a = await store.saveRevision(SCENE, Buffer.from('x'), { reason: 'session', at: 1_700_000_000_000 });
  const r = await store.pruneRevisions(SCENE, ['20200101T000000Z-session.md', '../../book.md', 'index.json']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pruned, []);
  assert.equal(r.opId, null);
  assert.equal((await store.listRevisions(SCENE)).length, 1);
  assert.equal((await fs.readFile(path.join(revDir(root), a.entry.file), 'utf8')), 'x');
  assert.ok(await fs.stat(path.join(root, 'book.md')), 'book.md untouched');
});

test('retention end to end: 120 days of snapshots plus manual ones; plan then prune; trash holds every pruned file', async () => {
  const { root, store } = await openFresh();
  const saved = [];
  for (let d = 119; d >= 0; d--) {
    const at = localAt(d, 12, NOW);
    const r = await store.saveRevision(SCENE, Buffer.from(`text of day ${d}`), { reason: 'session', at, words: d });
    assert.equal(r.stored, true);
    saved.push(r.entry);
  }
  const manual = await store.saveRevision(SCENE, Buffer.from('ancient manual'), { reason: 'manual', at: localAt(200, 12, NOW), label: 'keep forever' });
  const list = await store.listRevisions(SCENE);
  assert.equal(list.length, 121);

  const plan = planRetention(list, NOW);
  assert.ok(plan.length >= 29);
  assert.ok(!plan.includes(manual.entry.file));
  const r = await store.pruneRevisions(SCENE, plan);
  assert.equal(r.pruned.length, plan.length);

  const left = await store.listRevisions(SCENE);
  assert.equal(left.length, 121 - plan.length);
  assert.ok(left.some((e) => e.file === manual.entry.file), 'manual survives');
  assert.ok(left.length >= 90, 'about 90 days remain');
  for (const f of plan) {
    await assert.rejects(fs.stat(path.join(revDir(root), f)));
    await fs.stat(path.join(root, '.storyforge', 'trash', r.opId, 'revisions', SCENE, f));
  }
  assert.deepEqual(planRetention(left, NOW), [], 'a second pass has nothing more to prune');
});

// ------------------------------------------------------------------ revisions follow the scene id

test('revisions survive a scene move and a file rename (keyed by scene id, not path)', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    const store = await openStore(root, { recover: false });
    const scene = await repo.getScene(BOOK, SCENE);
    const bytes = await fs.readFile(path.join(root, scene.path));
    const saved = await store.saveRevision(SCENE, bytes, { reason: 'manual', at: 1_700_000_000_000, label: 'before' });

    const renamed = await repo.setSceneFields(BOOK, SCENE, { title: 'Landfall', renameFile: true });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const afterRename = await repo.getScene(BOOK, SCENE);
    assert.notEqual(afterRename.path, scene.path, 'the file really was renamed');

    const moved = await repo.moveScene(BOOK, SCENE, { chapter: 2, after: null });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const afterMove = await repo.getScene(BOOK, SCENE);
    assert.notEqual(afterMove.path, afterRename.path, 'the file really moved');

    const list = await store.listRevisions(SCENE);
    assert.deepEqual(list.map((e) => e.file), [saved.entry.file]);
    assert.equal(Buffer.compare(await store.readRevision(SCENE, saved.entry.file), bytes), 0);
  } finally {
    await repo.close();
  }
});

// ------------------------------------------------------------------ splitRevision (restore preview and body restore)

test('splitRevision separates the front matter text, parsed front matter and the body', () => {
  const text = '---\nschema: storyforge.scene/v1\nid: scene_X\ntitle: Arrival\nsequence: 10\n---\nThe body.\n\nSecond paragraph.\n';
  const bytes = Buffer.from(text);
  const start = text.indexOf('The body.');
  const r = splitRevision(bytes, start);
  assert.equal(r.body, 'The body.\n\nSecond paragraph.\n');
  assert.equal(r.frontMatterText, text.slice(0, start));
  assert.deepEqual(r.frontMatter, { schema: 'storyforge.scene/v1', id: 'scene_X', title: 'Arrival', sequence: 10 });
});

test('splitRevision: a file with no front matter is all body; empty body and CRLF are kept', () => {
  assert.deepEqual(splitRevision(Buffer.from('just text\n'), -1), { frontMatterText: '', frontMatter: {}, body: 'just text\n' });
  const empty = '---\nid: x\n---\n';
  assert.equal(splitRevision(Buffer.from(empty), empty.length).body, '');
  const crlf = '---\r\nid: x\r\n---\r\nline\r\nnext\r\n';
  const r = splitRevision(Buffer.from(crlf), crlf.indexOf('line'));
  assert.equal(r.body, 'line\r\nnext\r\n');
  assert.equal(r.frontMatter.id, 'x');
});

test('splitRevision: unparseable front matter gives {} instead of throwing; body still returned', () => {
  const text = '---\n: : [unclosed\n---\nbody\n';
  const r = splitRevision(Buffer.from(text), text.indexOf('body'));
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, 'body\n');
});
