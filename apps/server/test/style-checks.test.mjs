// M13-J03: Style checks on the server: the settings route (checks.style in book.md), dismissals (planning/style/<slug>.md), checking one text, scans (in memory, one scene
// at a time), applying one finding to a scene that is not open, and the policy classes of every new route.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { STYLE_RULE_IDS } from '@storyforge/style';
import { classifyRead, WRITE_CLASSES, allowed } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { createStyleScans, styleScans } from '../src/style-scans.mjs';
import { BOOK } from './move-helpers.mjs';
import { SCENE, bootPersonal, closeAll } from './plugin-helpers.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const realYield = settle;

after(closeAll);
afterEach(() => styleScans.setHooks({ yieldFn: realYield }));

const B = `/api/books/${BOOK}`;
const STYLE = `${B}/checks/style`;
const post = (t, url, body) => t.member('POST', url, body);
const readBook = (t) => fs.readFile(path.join(t.root, 'book.md'));
const fileOf = (t, rel) => path.join(t.root, ...rel.split('/'));

/** A fixture library with style checks on (repeated-words only unless `rules` says more). */
async function boot(rules = { 'repeated-words': { enabled: true } }, fixture = 'valid/salt-orchard') {
  const t = await bootPersonal({ fixture });
  const r = await post(t, STYLE, { enabled: true, rules });
  assert.equal(r.status, 200, r.text);
  return t;
}

/** Append prose to a scene file on disk (the repository re-reads files on every call). */
const addText = async (t, rel, text) => fs.appendFile(fileOf(t, rel), `\n\n${text}\n`);

const liveScenes = async (t) => (await t.repository.listLiveScenes(BOOK)).scenes;

async function waitFor(t, scanId, ok, what = 'condition') {
  for (let i = 0; i < 1000; i += 1) {
    const r = await t.member('GET', `${STYLE}/scans/${scanId}`);
    assert.equal(r.status, 200, r.text);
    if (ok(r.json)) return r.json;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`scan ${scanId} never reached: ${what}`);
}
const finished = (s) => s.state !== 'running';

/** A yield that waits for `release()`: holds a scan after its first scene so a test can look at it, cancel it or start another. */
function gate() {
  let release = () => {};
  const open = new Promise((resolve) => {
    release = resolve;
  });
  styleScans.setHooks({ yieldFn: () => open });
  return release;
}

test('the settings route: 200 with the resulting map, unchanged, 400 for each bad field, 404; GET /api/preferences shows it effective', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const defaults = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(defaults.json.effective.checks.style.enabled, false);

  const first = await post(t, STYLE, { enabled: true, rules: { 'repeated-words': { enabled: true }, 'preferred-terms': { enabled: true, terms: [{ use: 'grey', avoid: ['gray'] }] } } });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { ok: true, style: { enabled: true, rules: { 'repeated-words': { enabled: true }, 'preferred-terms': { enabled: true, terms: [{ use: 'grey', avoid: ['gray'] }] } } } });
  const prefs = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(prefs.json.effective.checks.style.enabled, true);
  assert.deepEqual(prefs.json.effective.checks.style.rules['preferred-terms'].terms, [{ use: 'grey', avoid: ['gray'] }]);

  // a given rule map replaces that rule's whole map; the others stay
  const second = await post(t, STYLE, { rules: { 'preferred-terms': { enabled: true, terms: [{ use: 'colour', avoid: ['color', 'colr'] }] } } });
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.json.style.rules['preferred-terms'].terms, [{ use: 'colour', avoid: ['color', 'colr'] }]);
  assert.deepEqual(second.json.style.rules['repeated-words'], { enabled: true });

  const bytes = await readBook(t);
  const same = await post(t, STYLE, { enabled: true });
  assert.equal(same.status, 200, same.text);
  assert.equal(same.json.unchanged, true);
  assert.equal(Buffer.compare(await readBook(t), bytes), 0, 'an unchanged request writes nothing');

  const bad = [
    [{}, 'empty body'],
    [{ nope: 1 }, 'unknown key'],
    [{ enabled: true, extra: 1 }, 'unknown key beside a good one'],
    [{ enabled: 'yes' }, 'enabled type'],
    [{ rules: [] }, 'rules not a mapping'],
    [{ rules: { 'textlint-rule-anything': { enabled: true } } }, 'a rule that is not one of the six'],
    [{ rules: { 'repeated-words': 5 } }, 'rule map not a mapping'],
    [{ rules: { 'repeated-words': { enabled: true, module: 'x' } } }, 'a key the rule does not have'],
    [{ rules: { 'repeated-phrases': { enabled: true, minWords: 2 } } }, 'minWords out of range'],
    [{ rules: { 'repeated-phrases': { enabled: true, window: 5000 } } }, 'window out of range'],
    [{ rules: { 'long-paragraphs': { enabled: true, maxWords: 'many' } } }, 'maxWords type'],
    [{ rules: { 'isolated-lines': { minRun: 1 } } }, 'minRun out of range'],
    [{ rules: { punctuation: { quotes: 'fancy' } } }, 'quote style'],
    [{ rules: { 'preferred-terms': { terms: [{ use: 'a', avoid: ['a'] }] } } }, 'avoid equal to use'],
    [{ rules: { 'preferred-terms': { terms: [{ use: '', avoid: ['b'] }] } } }, 'empty use'],
    [{ rules: { 'preferred-terms': { terms: [{ use: 'a', avoid: [] }] } } }, 'no avoid'],
  ];
  for (const [b, why] of bad) {
    const r = await post(t, STYLE, b);
    assert.equal(r.status, 400, `${why}: ${r.text}`);
    assert.equal(typeof r.json.message, 'string', why);
  }
  assert.match((await post(t, STYLE, { nope: 1 })).json.message, /nope/);
  assert.match((await post(t, STYLE, { rules: { 'repeated-phrases': { minWords: 2 } } })).json.message, /repeated-phrases/);
  assert.equal(Buffer.compare(await readBook(t), bytes), 0, 'refusals write nothing');
  assert.equal((await post(t, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/style', { enabled: true })).status, 404);
});

test('dismissals: create, list, check hides it, 409 when repeated, archive restores it, undo through /ops/:opId/restore', async () => {
  const t = await boot();
  const text = 'We had had enough of it.';
  const checked = await post(t, `${STYLE}/check`, { sceneId: SCENE, body: text });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json.findings.length, 1, checked.text);
  const f = checked.json.findings[0];
  assert.equal(f.ruleId, 'repeated-words');
  assert.equal(f.original, 'had had');
  assert.match(f.fingerprint, /^sty-[0-9a-f]{16}$/);
  assert.equal(text.slice(f.range.from, f.range.to), f.original);

  assert.deepEqual((await t.member('GET', `${STYLE}/dismissals`)).json, { dismissals: [] });
  const made = await post(t, `${STYLE}/dismissals`, { fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: f.original, note: 'On purpose.' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.ok, true);
  assert.match(made.json.slug, /^[a-z0-9-]+$/);
  assert.match(made.json.id, /^note_/);
  assert.equal(made.json.file, `planning/style/${made.json.slug}.md`);
  assert.equal(typeof made.json.opId, 'string');
  assert.deepEqual(made.json.undo, { op: made.json.opId });
  const onDisk = await fs.readFile(fileOf(t, made.json.file), 'utf8');
  assert.match(onDisk, /schema: storyforge\.style-dismissal\/v1/);
  assert.match(onDisk, /On purpose\./);

  const listed = (await t.member('GET', `${STYLE}/dismissals`)).json.dismissals;
  assert.equal(listed.length, 1);
  assert.deepEqual({ ...listed[0], created: undefined }, { slug: made.json.slug, fingerprint: f.fingerprint, rule: 'repeated-words', sceneId: SCENE, text: 'had had', note: 'On purpose.', created: undefined });
  assert.deepEqual((await post(t, `${STYLE}/check`, { sceneId: SCENE, body: text })).json.findings, [], 'a dismissed finding is not reported');

  const again = await post(t, `${STYLE}/dismissals`, { fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: f.original });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'ALREADY_DISMISSED');

  for (const [b, why] of [
    [{}, 'empty'],
    [{ fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: 'x', extra: 1 }, 'unknown key'],
    [{ fingerprint: 'sty-123', rule: f.ruleId, sceneId: SCENE, text: 'x' }, 'bad fingerprint'],
    [{ fingerprint: f.fingerprint, rule: 'textlint-rule-anything', sceneId: SCENE, text: 'x' }, 'rule not one of the six'],
    [{ fingerprint: f.fingerprint, rule: f.ruleId, sceneId: 'scene_x', text: 'x' }, 'bad scene id'],
    [{ fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: '  ' }, 'blank text'],
    [{ fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: 'x', note: 5 }, 'note type'],
  ]) assert.equal((await post(t, `${STYLE}/dismissals`, b)).status, 400, why);
  assert.equal((await post(t, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/style/dismissals', { fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: 'x' })).status, 404);

  // archive = restore the finding
  const removed = await t.member('DELETE', `${STYLE}/dismissals/${made.json.slug}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.ok, true);
  assert.equal(removed.json.slug, made.json.slug);
  assert.equal(removed.json.archived, `archive/planning/style/${made.json.slug}.md`);
  assert.equal(typeof removed.json.opId, 'string');
  assert.deepEqual((await t.member('GET', `${STYLE}/dismissals`)).json, { dismissals: [] });
  assert.equal((await post(t, `${STYLE}/check`, { sceneId: SCENE, body: text })).json.findings.length, 1, 'the finding is back');
  assert.equal((await t.member('DELETE', `${STYLE}/dismissals/${made.json.slug}`)).status, 404, 'already archived');
  assert.equal((await t.member('GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/style/dismissals')).status, 404);

  // undo of a dismissal: POST /ops/:opId/restore removes the file again
  const second = await post(t, `${STYLE}/dismissals`, { fingerprint: f.fingerprint, rule: f.ruleId, sceneId: SCENE, text: f.original });
  assert.equal(second.status, 201, second.text);
  const undone = await post(t, `${B}/ops/${second.json.opId}/restore`, {});
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual((await t.member('GET', `${STYLE}/dismissals`)).json, { dismissals: [] });
  assert.equal((await post(t, `${STYLE}/check`, { sceneId: SCENE, body: text })).json.findings.length, 1);
});

test('the check route: off state, bad bodies, 413 over 2,000,000 characters, and nothing written', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const off = await post(t, `${STYLE}/check`, { sceneId: SCENE, body: 'We had had enough.' });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json, { findings: [], state: 'disabled' });

  assert.equal((await post(t, STYLE, { enabled: true, rules: { 'repeated-words': { enabled: true } } })).status, 200);
  const before = await readBook(t);
  assert.equal((await post(t, `${STYLE}/check`, { sceneId: SCENE, body: 'Clean prose only.' })).json.findings.length, 0);
  for (const [b, why] of [
    [{}, 'empty'],
    [{ sceneId: SCENE }, 'no body'],
    [{ sceneId: SCENE, body: 5 }, 'body type'],
    [{ sceneId: 'nope', body: 'x' }, 'scene id'],
    [{ sceneId: SCENE, body: 'x', extra: true }, 'unknown key'],
  ]) assert.equal((await post(t, `${STYLE}/check`, b)).status, 400, why);
  const big = await post(t, `${STYLE}/check`, { sceneId: SCENE, body: 'a'.repeat(2_000_001) });
  assert.equal(big.status, 413, big.text.slice(0, 200));
  assert.equal(big.json.code, 'TOO_LARGE');
  assert.equal((await post(t, `${STYLE}/check`, { sceneId: SCENE, body: `${'a '.repeat(1000)}` })).status, 200);
  assert.equal(Buffer.compare(await readBook(t), before), 0);
  assert.equal((await post(t, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/style/check', { sceneId: SCENE, body: 'x' })).status, 404);
});

test('a chapter scan: done rises, it completes, findings carry the scene file sha256 and a fingerprint, chapters group them, dismissed findings stay away', async () => {
  const t = await boot();
  const scenes = await liveScenes(t);
  const sizes = Object.groupBy(scenes, (s) => `${s.act}/${s.chapter}`);
  const chapterScenes = Object.values(sizes).sort((a, b) => b.length - a.length)[0];
  const first = chapterScenes[0];
  assert.ok(chapterScenes.length >= 2, 'the fixture chapter has several scenes');
  for (const s of chapterScenes) await addText(t, s.path, `She said it twice, the the end of ${s.title}.`);

  // slow each scene a little so the progress can be seen
  const seen = [];
  styleScans.setHooks({ yieldFn: () => new Promise((resolve) => setTimeout(resolve, 25)) });
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'chapter', act: first.act, chapter: first.chapter } });
  assert.equal(started.status, 202, started.text);
  assert.match(started.json.scanId, /^scan_[0-9a-f]{20}$/);
  assert.deepEqual(Object.keys(started.json), ['scanId']);
  const done = await waitFor(t, started.json.scanId, (s) => {
    seen.push(s.done);
    return finished(s);
  }, 'finished');
  assert.equal(done.state, 'completed');
  assert.equal(done.total, chapterScenes.length);
  assert.equal(done.done, chapterScenes.length);
  assert.ok(new Set(seen).size >= 2, `done rose over the polls: ${seen}`);
  assert.deepEqual(done.errors, []);
  assert.equal(done.truncated, false);
  assert.deepEqual(done.staleDismissals, []);
  assert.match(done.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(done.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(done.chapters).sort(), chapterScenes.map((s) => s.id).sort());
  assert.deepEqual(done.chapters[first.id], { act: first.act, chapter: first.chapter, chapterLabel: first.chapterLabel, title: first.title });
  const twice = done.findings.filter((f) => f.original.toLowerCase() === 'the the');
  assert.equal(twice.length, chapterScenes.length, 'one repeated-words finding per scene');
  for (const f of done.findings) {
    assert.ok(done.chapters[f.sceneId], 'every finding is in a scanned chapter scene');
    assert.match(f.fingerprint, /^sty-[0-9a-f]{16}$/);
    const sha = (await t.member('GET', `${B}/scenes/${f.sceneId}`)).json.sha256;
    assert.equal(f.fileSha256, sha, 'fileSha256 is the scene file hash the apply route expects');
  }
  // grouped by rule and by chapter, from the data the page gets
  const byRule = Object.groupBy(done.findings, (f) => f.ruleId);
  assert.ok(byRule['repeated-words'].length >= chapterScenes.length);
  const byChapter = Object.groupBy(done.findings, (f) => done.chapters[f.sceneId].chapterLabel);
  assert.deepEqual(Object.keys(byChapter), [first.chapterLabel]);

  // dismiss one, rescan: it is gone and nothing is stale
  const victim = twice[0];
  const d = await post(t, `${STYLE}/dismissals`, { fingerprint: victim.fingerprint, rule: victim.ruleId, sceneId: victim.sceneId, text: victim.original });
  assert.equal(d.status, 201, d.text);
  styleScans.setHooks({ yieldFn: realYield });
  const again = await post(t, `${STYLE}/scans`, { scope: { kind: 'chapter', act: first.act, chapter: first.chapter } });
  assert.equal(again.status, 202, again.text);
  const second = await waitFor(t, again.json.scanId, finished);
  assert.equal(second.state, 'completed');
  assert.equal(second.findings.filter((f) => f.original.toLowerCase() === 'the the').length, chapterScenes.length - 1);
  assert.ok(!second.findings.some((f) => f.fingerprint === victim.fingerprint));
  assert.deepEqual(second.staleDismissals, []);
  assert.equal((await t.member('GET', `${STYLE}/scans/${started.json.scanId}`)).status, 404, 'the earlier scan of the book was dropped when the next one started');

  // change the dismissed passage: the dismissal stops hiding anything and is listed as stale
  const file = fileOf(t, scenes.find((s) => s.id === victim.sceneId).path);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('the the end', 'then the end'));
  const third = await post(t, `${STYLE}/scans`, { scope: { kind: 'scenes', ids: [victim.sceneId] } });
  assert.equal(third.status, 202, third.text);
  const stale = await waitFor(t, third.json.scanId, finished);
  assert.equal(stale.total, 1);
  assert.deepEqual(stale.staleDismissals, [d.json.slug]);
  assert.ok(!stale.findings.some((f) => f.original.toLowerCase() === 'the the'));
});

test('a scene scope names scenes in book order, and reports an id that is not a live scene', async () => {
  const t = await boot();
  const scenes = await liveScenes(t);
  const ids = [scenes[2].id, scenes[0].id];
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'scenes', ids: [...ids, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] } });
  assert.equal(started.status, 202, started.text);
  const done = await waitFor(t, started.json.scanId, finished);
  assert.equal(done.state, 'completed');
  assert.equal(done.total, 2);
  assert.deepEqual(Object.keys(done.chapters), [scenes[0].id, scenes[2].id], 'book order');
  assert.deepEqual(done.errors.map((e) => e.sceneId), ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ']);
});

test('a manuscript scan can be cancelled: cancelled, done < total, partial findings kept; a second scan while one runs is 409', async () => {
  const t = await boot();
  const scenes = await liveScenes(t);
  assert.ok(scenes.length >= 4);
  for (const s of scenes) await addText(t, s.path, 'It was the the end.');
  const release = gate();
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(started.status, 202, started.text);
  const running = await waitFor(t, started.json.scanId, (s) => s.done >= 1);
  assert.equal(running.state, 'running');
  assert.equal(running.total, scenes.length);
  assert.equal(running.finishedAt, null);

  const second = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.code, 'SCAN_RUNNING');
  assert.equal(second.json.scanId, started.json.scanId);

  const cancelled = await post(t, `${STYLE}/scans/${started.json.scanId}/cancel`, {});
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.deepEqual(cancelled.json, { ok: true, cancelled: true, state: 'cancelled' });
  release();
  await settle();
  const after1 = (await t.member('GET', `${STYLE}/scans/${started.json.scanId}`)).json;
  assert.equal(after1.state, 'cancelled');
  assert.ok(after1.done >= 1 && after1.done < after1.total, `done ${after1.done} of ${after1.total}`);
  assert.ok(after1.findings.length >= 1, 'the findings so far are kept');
  assert.match(after1.finishedAt, /^\d{4}-/);
  const noMore = await post(t, `${STYLE}/scans/${started.json.scanId}/cancel`, {});
  assert.deepEqual(noMore.json, { ok: true, cancelled: false, state: 'cancelled' });
  assert.equal((await post(t, `${STYLE}/scans/scan_nope/cancel`, {})).status, 404);

  // a new scan can start now
  styleScans.setHooks({ yieldFn: realYield });
  const next = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(next.status, 202, next.text);
  const done = await waitFor(t, next.json.scanId, finished);
  assert.equal(done.state, 'completed');
  assert.equal(done.done, scenes.length);
});

test('scan refusals: style off is 409 STYLE_OFF, a bad scope is 400, an unknown book or scan is 404', async () => {
  const t = await boot();
  for (const [b, why] of [
    [{}, 'no scope'],
    [{ scope: 'all' }, 'scope not an object'],
    [{ scope: { kind: 'book' } }, 'unknown kind'],
    [{ scope: { kind: 'scenes', ids: [] } }, 'no ids'],
    [{ scope: { kind: 'scenes', ids: ['x'] } }, 'bad id'],
    [{ scope: { kind: 'scenes', ids: [SCENE], extra: 1 } }, 'unknown scope key'],
    [{ scope: { kind: 'chapter', act: 1 } }, 'no chapter'],
    [{ scope: { kind: 'chapter', act: 1.5, chapter: 1 } }, 'fraction'],
    [{ scope: { kind: 'chapter', act: -1, chapter: 1 } }, 'negative'],
    [{ scope: { kind: 'manuscript', ids: [] } }, 'unknown key for manuscript'],
    [{ scope: { kind: 'manuscript' }, extra: 1 }, 'unknown body key'],
  ]) assert.equal((await post(t, `${STYLE}/scans`, b)).status, 400, why);
  assert.equal((await post(t, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/style/scans', { scope: { kind: 'manuscript' } })).status, 404);
  assert.equal((await t.member('GET', `${STYLE}/scans/scan_nope`)).status, 404);
  assert.equal((await post(t, `${STYLE}/scans/scan_nope/cancel`, { x: 1 })).status, 400);

  assert.equal((await post(t, STYLE, { enabled: false })).status, 200);
  const off = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(off.status, 409, off.text);
  assert.equal(off.json.code, 'STYLE_OFF');
});

test('the scan injects its clock and yield: a finished scan is kept 30 minutes, then forgotten; bounds are listed', async () => {
  let clock = Date.UTC(2026, 10, 18, 9, 0, 0);
  let yields = 0;
  const scans = createStyleScans({ now: () => clock, yieldFn: async () => { yields += 1; } });
  const t = await boot();
  const settings = { enabled: true, rules: { 'repeated-words': { enabled: true } } };
  const scenes = await liveScenes(t);
  const { scanId } = scans.start({ repository: t.repository, bookId: BOOK, scope: { kind: 'manuscript' }, settings });
  for (let i = 0; i < 400 && scans.status(BOOK, scanId).state === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const s = scans.status(BOOK, scanId);
  assert.equal(s.state, 'completed');
  assert.equal(s.startedAt, '2026-11-18T09:00:00.000Z');
  assert.equal(yields, scenes.length, 'one yield per scene');
  clock += 29 * 60 * 1000;
  assert.equal(scans.status(BOOK, scanId).state, 'completed');
  assert.equal(scans.status('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ', scanId), null, 'another book cannot read it');
  clock += 2 * 60 * 1000;
  assert.equal(scans.status(BOOK, scanId), null, 'forgotten after 30 minutes');
});

test('cross-scene repeats: with repeated-phrases on, a phrase in two scenes is reported with related, and carries fileSha256', async () => {
  const t = await boot({ 'repeated-phrases': { enabled: true, minWords: 4, window: 300 } });
  const scenes = await liveScenes(t);
  await addText(t, scenes[0].path, 'The lantern keeper walked slowly homeward through fog.');
  await addText(t, scenes[1].path, 'Later the lantern keeper walked slowly homeward through rain.');
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(started.status, 202, started.text);
  const done = await waitFor(t, started.json.scanId, finished);
  assert.equal(done.state, 'completed', JSON.stringify(done.errors));
  const across = done.findings.filter((f) => f.ruleId === 'repeated-phrases' && /lantern keeper walked slowly homeward/i.test(f.original) && f.related?.some((r) => r.sceneId !== f.sceneId));
  assert.ok(across.length >= 2, `cross-scene findings: ${JSON.stringify(done.findings.map((f) => [f.sceneId, f.original]))}`);
  for (const f of across) {
    assert.equal(f.advisory, true);
    assert.match(f.fileSha256, /^[0-9a-f]{64}$/);
    assert.match(f.fingerprint, /^sty-/);
  }
});

test('a book.md naming textlint-rule-anything under checks.style.rules gets E102 and the scan runs only the built-in rules', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const scenes = await liveScenes(t);
  await addText(t, scenes[0].path, 'It was the the end.');
  // the book's own style settings are refused (E102, ignored); the profile turns style checks on, so a scan has something to run
  const prof = await t.member('PUT', '/api/profile', { checks: { style: { enabled: true, rules: { 'repeated-words': { enabled: true } } } } });
  assert.equal(prof.status, 200, prof.text);
  const file = fileOf(t, 'book.md');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace(/\n---\n/, '\npreferences:\n  checks:\n    style:\n      enabled: true\n      rules:\n        textlint-rule-anything: { enabled: true }\n        repeated-words: { enabled: true }\n---\n'));
  const diag = await t.member('GET', `${B}/diagnostics`);
  assert.equal(diag.status, 200, diag.text);
  const e102 = JSON.stringify(diag.json).includes('E102');
  assert.ok(e102 && /textlint-rule-anything/.test(JSON.stringify(diag.json)), 'the validator reports E102 for the unknown rule');

  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  assert.equal(started.status, 202, started.text);
  const done = await waitFor(t, started.json.scanId, finished);
  assert.equal(done.state, 'completed');
  assert.ok(done.findings.length >= 1);
  for (const f of done.findings) assert.ok(STYLE_RULE_IDS.includes(f.ruleId), `built-in rule only: ${f.ruleId}`);
});

test('apply-finding: applies a scan finding, SCENE_CHANGED on a stale sha, a receipt that says author / check, undo restores', async () => {
  const t = await boot();
  const scenes = await liveScenes(t);
  const target = scenes[0];
  await addText(t, target.path, 'It was the the end.');
  const before = await fs.readFile(fileOf(t, target.path));
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'scenes', ids: [target.id] } });
  const done = await waitFor(t, started.json.scanId, finished);
  const f = done.findings.find((x) => x.original === 'the the');
  assert.ok(f && f.replacements[0] === 'the', JSON.stringify(done.findings));
  const request = { baseSha256: f.fileSha256, from: f.range.from, to: f.range.to, original: f.original, replacement: f.replacements[0], ruleId: f.ruleId, engine: f.engine };
  const URL_ = `${B}/scenes/${target.id}/apply-finding`;

  for (const [b, why] of [
    [{}, 'empty'],
    [{ ...request, extra: 1 }, 'unknown key'],
    [{ ...request, from: 'a' }, 'from type'],
    [{ ...request, replacement: 5 }, 'replacement type'],
    [{ ...request, baseSha256: 'abc' }, 'sha shape'],
    [{ ...request, ruleId: 'Not A Rule' }, 'rule id shape'],
  ]) assert.equal((await post(t, URL_, b)).status, 400, why);
  assert.equal(Buffer.compare(await fs.readFile(fileOf(t, target.path)), before), 0, 'refusals write nothing');

  const wrongText = await post(t, URL_, { ...request, original: 'xx xx' });
  assert.equal(wrongText.status, 409);
  assert.equal(wrongText.json.code, 'SCENE_CHANGED');

  const applied = await post(t, URL_, request);
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.ok, true);
  assert.match(applied.json.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(applied.json.sha256, f.fileSha256);
  assert.equal(typeof applied.json.opId, 'string');
  assert.deepEqual(applied.json.undo, { opId: applied.json.opId });
  const after1 = await fs.readFile(fileOf(t, target.path), 'utf8');
  assert.ok(after1.includes('It was the end.') && !after1.includes('the the'));
  assert.equal(after1.length, before.toString('utf8').length - 4);

  const stale = await post(t, URL_, request);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.code, 'SCENE_CHANGED');
  assert.equal(await fs.readFile(fileOf(t, target.path), 'utf8'), after1, 'a stale request writes nothing');

  const receipts = await t.member('GET', `${B}/receipts?scene=${target.id}`);
  assert.equal(receipts.status, 200, receipts.text);
  const last = receipts.json.receipts.at(-1);
  assert.equal(last.operation, 'author.edit', JSON.stringify(last));
  assert.equal(last.actor, 'author');
  assert.equal(last.workflow, 'check');
  assert.match(last.summary, /Style check: .the the. -> .the. \(repeated-words\)/);

  const undone = await post(t, `${B}/ops/${applied.json.undo.opId}/restore`, {});
  assert.equal(undone.status, 200, undone.text);
  assert.equal(Buffer.compare(await fs.readFile(fileOf(t, target.path)), before), 0, 'undo restores the scene exactly');
  assert.equal((await post(t, `${B}/scenes/scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ/apply-finding`, request)).status, 404);
});

test('policy: every new route is routed, classed (settings, dismissals and apply are write; check and scans are read), and a share link reaches none of them', () => {
  const routes = [
    ['POST', `${STYLE}`, 'book-checks-style', 'write'],
    ['POST', `${STYLE}/dismissals`, 'style-dismiss', 'write'],
    ['DELETE', `${STYLE}/dismissals/some-slug`, 'style-undismiss', 'write'],
    ['POST', `${STYLE}/check`, 'style-check', 'read'],
    ['POST', `${STYLE}/scans`, 'style-scan-start', 'read'],
    ['POST', `${STYLE}/scans/scan_X/cancel`, 'style-scan-cancel', 'read'],
    ['POST', `${B}/scenes/${SCENE}/apply-finding`, 'scene-apply-finding', 'write'],
  ];
  for (const [method, url, route, cls] of routes) {
    assert.equal(matchWriteRoute(method, url)?.route, route, `${method} ${url}`);
    assert.equal(WRITE_CLASSES[route], cls, route);
    const share = { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read', 'export'] };
    assert.equal(allowed(share, cls, { book: BOOK, shareable: false }), false, `a share link cannot use ${route}`);
    assert.equal(allowed({ kind: 'user', id: 'u', role: 'viewer' }, cls, { book: BOOK }), cls === 'read', `a viewer: ${route}`);
    assert.equal(allowed({ kind: 'user', id: 'u', role: 'editor' }, cls, { book: BOOK }), true, `an editor: ${route}`);
  }
  assert.equal(matchWriteRoute('GET', `${STYLE}/dismissals`), null);
  assert.equal(matchWriteRoute('PUT', `${STYLE}/scans`), null);
  assert.equal(matchWriteRoute('DELETE', `${STYLE}/dismissals`), null);
  for (const url of [`${STYLE}/dismissals`, `${STYLE}/scans/scan_X`]) {
    const r = classifyRead(url);
    assert.equal(r.cls, 'read', url);
    assert.equal(r.shareable, false, `${url} is private project data`);
  }
});

test('batching: a 60-scene scope reads bodies 25 per call, still yields once per scene, and gives each scene its own findings', async () => {
  const ulid = (n) => `scene_${String(n).padStart(26, '0')}`;
  const fake = Array.from({ length: 60 }, (_, i) => ({ id: ulid(i + 1), title: `Scene ${i + 1}`, act: 1, chapter: 1 + Math.floor(i / 20), chapterLabel: 'Chapter', path: `m/${i}.md` }));
  const calls = [];
  const repository = {
    listLiveScenes: async () => ({ ok: true, scenes: fake }),
    listStyleDismissals: async () => [],
    getSceneBodies: async (_book, ids) => {
      calls.push(ids.length);
      return { ok: true, scenes: ids.map((id) => ({ id, body: `Scene ${id.slice(-2)} had had enough.`, sha256: id.slice(-2).padStart(64, 'a') })), missing: [] };
    },
  };
  let yields = 0;
  const scans = createStyleScans({ yieldFn: async () => { yields += 1; } });
  const { scanId } = scans.start({ repository, bookId: BOOK, scope: { kind: 'manuscript' }, settings: { enabled: true, rules: { 'repeated-words': { enabled: true } } } });
  let s;
  for (let i = 0; i < 400; i += 1) {
    s = scans.status(BOOK, scanId);
    if (s.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(s.state, 'completed', JSON.stringify(s.errors));
  assert.deepEqual(calls, [25, 25, 10]);
  assert.equal(yields, 60);
  assert.equal(s.done, 60);
  assert.equal(s.findings.length, 60);
  assert.deepEqual(s.findings.map((f) => f.sceneId), fake.map((x) => x.id), 'one finding per scene, in book order');
  for (const f of s.findings) assert.equal(f.fileSha256, f.sceneId.slice(-2).padStart(64, 'a'));

  // a scan cancelled after the first scene reads no further batch
  calls.length = 0;
  let open = () => {};
  const held = new Promise((resolve) => { open = resolve; });
  const scans2 = createStyleScans({ yieldFn: () => held });
  const second = scans2.start({ repository, bookId: BOOK, scope: { kind: 'manuscript' }, settings: { enabled: true, rules: { 'repeated-words': { enabled: true } } } });
  for (let i = 0; i < 400 && scans2.status(BOOK, second.scanId).done < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  scans2.cancel(BOOK, second.scanId);
  open();
  await settle();
  assert.deepEqual(calls, [25]);
  assert.equal(scans2.status(BOOK, second.scanId).done, 1);
});

test('scan status ?from=n lists only the findings from that index on, with findingsTotal; a bad from is 400', async () => {
  const t = await boot();
  const scenes = await liveScenes(t);
  for (const s of scenes.slice(0, 3)) await addText(t, s.path, 'It was the the end.');
  const started = await post(t, `${STYLE}/scans`, { scope: { kind: 'manuscript' } });
  const all = await waitFor(t, started.json.scanId, finished);
  assert.ok(all.findings.length >= 3);
  assert.equal(all.findingsTotal, all.findings.length);
  const url = `${STYLE}/scans/${started.json.scanId}`;
  const tail = (await t.member('GET', `${url}?from=2`)).json;
  assert.deepEqual(tail.findings, all.findings.slice(2));
  assert.equal(tail.findingsTotal, all.findings.length);
  assert.equal(tail.state, 'completed');
  assert.equal(tail.done, all.done);
  assert.deepEqual((await t.member('GET', `${url}?from=0`)).json.findings, all.findings);
  assert.deepEqual((await t.member('GET', `${url}?from=${all.findings.length + 5}`)).json.findings, []);
  for (const bad of ['-1', 'x', '1.5', '']) assert.equal((await t.member('GET', `${url}?from=${bad}`)).status, 400, bad);
});
