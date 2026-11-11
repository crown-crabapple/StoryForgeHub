// The two narrow codex repoints over the plugin API v1 (permission 'workspace', book AI level planner):
//   POST /api/v1/books/:b/timeline/events/:e                 { scenes? | add? | remove?, two_sided?, base_sha256? }   (app route event-fields)
//   POST /api/v1/books/:b/codex/entries/:e/first-appearance  { first_appearance: <scene id> | null, base_sha256? }     (app route entry-fields; nothing else is forwarded)
// They fix diagnostics W303 ("points into archive/") for an event's scenes[i] and an entry's first_appearance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { v1RouteOf } from '../src/api-v1.mjs';
import { decidePlugin } from '../src/plugin-policy.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SCENE, SLUG, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const base = `/api/v1/books/${BOOK}`;
const ARCHIVED = 'scene_01S50000000000000000000007';
const LIVE = SCENE; // scene_01S50000000000000000000002
const OTHER = 'scene_01S50000000000000000000004';
const UNKNOWN = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const EVENT = 'planning/timeline/the-flood.md';
const ENTRY = 'codex/characters/maren-hollis.md';

const edit = async (root, rel, fn) => {
  const file = path.join(root, ...rel.split('/'));
  await fs.writeFile(file, fn(await fs.readFile(file, 'utf8')));
};
const text = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
/** The W303 diagnostics of one file, read through the plugin API with a read token. */
async function w303(t, reader, file) {
  const r = await t.plugin(reader, 'GET', `${base}/diagnostics`);
  assert.equal(r.status, 200, r.text);
  return r.json.diagnostics.filter((d) => d.code === 'W303' && d.file === file);
}

test('the policy: both paths need workspace at level planner; other event and entry paths stay out of reach', () => {
  const grant = (permissions) => ({ id: 'g1', plugin: 'p', permissions, books: 'all' });
  const slugOf = (x) => (x === BOOK || x === SLUG ? SLUG : null);
  const decide = (permissions, method, p) => decidePlugin(grant(permissions), method, `${base}${p}`, slugOf);
  for (const p of ['/timeline/events/the-flood', '/codex/entries/maren-hollis/first-appearance']) {
    const ok = decide(['read', 'workspace'], 'POST', p);
    assert.deepEqual([ok.ok, ok.need, ok.level], [true, 'workspace', 'planner'], p);
    const refused = decide(['read', 'plan', 'canvas', 'propose'], 'POST', p);
    assert.equal(refused.ok, false, p);
    assert.match(refused.body.message, /"workspace"/, p);
  }
  for (const [method, p] of [['POST', '/codex/entries/maren-hollis'], ['POST', '/codex/entries/maren-hollis/fields'], ['POST', '/timeline/events/the-flood/fields'], ['POST', '/timeline/events'], ['GET', '/timeline/events/the-flood'], ['PUT', '/timeline/events/the-flood'], ['POST', '/entries/maren-hollis/fields']]) {
    const d = decide(['read', 'plan', 'canvas', 'propose', 'workspace', 'draft'], method, p);
    assert.equal(d.ok, false, `${method} ${p}`);
  }
  assert.equal(v1RouteOf('POST', `${base}/timeline/events/the-flood`), 'event-scenes');
  assert.equal(v1RouteOf('POST', `${base}/codex/entries/x/first-appearance`), 'entry-first-appearance');
});

test('an event: scenes pointing into archive/ (W303) are repointed to a live scene and the W303 is gone; an archived or unknown scene is 400 REFUSED_UNKNOWN_SCENE', async () => {
  const t = await bootPersonal();
  await edit(t.root, EVENT, (s) => s.replace(/^scenes: .*$/m, `scenes: [${ARCHIVED}]`));
  const reader = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const rw = (await t.grant({ plugin: 'repointer', permissions: ['read', 'workspace'] })).token;
  assert.equal((await w303(t, reader, EVENT)).length, 1, 'the archived scene is flagged first');

  const before = await readAll(t.root);
  for (const body of [{ scenes: [ARCHIVED] }, { add: { scenes: [ARCHIVED] } }, { scenes: [UNKNOWN] }]) {
    const r = await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} ${r.text}`);
    assert.equal(r.json.code, 'REFUSED_UNKNOWN_SCENE');
  }
  assert.deepEqual(await readAll(t.root), before, 'refusals wrote nothing');

  const stale = await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body: { scenes: [LIVE], base_sha256: '0'.repeat(64) } });
  assert.equal(stale.status, 409, stale.text);

  const ok = await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body: { scenes: [LIVE] } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(await text(t.root, EVENT), new RegExp(`^scenes: \\[${LIVE}\\]$`, 'm'));
  assert.deepEqual(await w303(t, reader, EVENT), []);

  // add and remove, and an event named by id
  const added = await t.plugin(rw, 'POST', `${base}/timeline/events/event_01S5000000000000000000000W`, { body: { add: { scenes: [OTHER] } } });
  assert.equal(added.status, 200, added.text);
  assert.match(await text(t.root, EVENT), new RegExp(`^scenes: \\[${LIVE}, ${OTHER}\\]$`, 'm'));
  assert.equal((await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body: { remove: { scenes: [OTHER] } } })).status, 200);
  assert.match(await text(t.root, EVENT), new RegExp(`^scenes: \\[${LIVE}\\]$`, 'm'));
  assert.equal((await t.plugin(rw, 'POST', `${base}/timeline/events/no-such-event`, { body: { scenes: [LIVE] } })).status, 404);
});

test('an event: only scenes, add, remove, two_sided and base_sha256 are forwarded (title, order and the rest are ignored)', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'repointer', permissions: ['read', 'workspace'] })).token;
  const r = await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body: { title: 'Hijacked', order: 5, when: 'never', characters: ['pell'], scenes: [OTHER] } });
  assert.equal(r.status, 200, r.text);
  const file = await text(t.root, EVENT);
  assert.match(file, /^title: The spring flood$/m);
  assert.match(file, /^order: 100$/m);
  assert.match(file, /^when: "Spring, year 0"$/m);
  assert.doesNotMatch(file, /characters/);
  assert.match(file, new RegExp(`^scenes: \\[${OTHER}\\]$`, 'm'));
  const nothing = await t.plugin(rw, 'POST', `${base}/timeline/events/the-flood`, { body: { title: 'Only a title' } });
  assert.equal(nothing.status, 400, nothing.text);
});

test('an entry: first_appearance pointing into archive/ (W303) is repointed, cleared with null, and an archived or unknown scene is 400 REFUSED_UNKNOWN_SCENE', async () => {
  const t = await bootPersonal();
  await edit(t.root, ENTRY, (s) => s.replace(/^first_appearance: .*$/m, `first_appearance: ${ARCHIVED}`));
  const reader = (await t.grant({ plugin: 'reader', permissions: ['read'] })).token;
  const rw = (await t.grant({ plugin: 'repointer', permissions: ['read', 'workspace'] })).token;
  const url = `${base}/codex/entries/maren-hollis/first-appearance`;
  assert.equal((await w303(t, reader, ENTRY)).length, 1, 'the archived scene is flagged first');

  const before = await readAll(t.root);
  for (const first_appearance of [ARCHIVED, UNKNOWN]) {
    const r = await t.plugin(rw, 'POST', url, { body: { first_appearance } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'REFUSED_UNKNOWN_SCENE');
  }
  assert.equal((await t.plugin(rw, 'POST', url, { body: { first_appearance: 7 } })).status, 400);
  assert.equal((await t.plugin(rw, 'POST', url, { body: { first_appearance: LIVE, base_sha256: '0'.repeat(64) } })).status, 409);
  assert.deepEqual(await readAll(t.root), before, 'refusals wrote nothing');

  const ok = await t.plugin(rw, 'POST', url, { body: { first_appearance: LIVE } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(await text(t.root, ENTRY), new RegExp(`^first_appearance: ${LIVE}$`, 'm'));
  assert.deepEqual(await w303(t, reader, ENTRY), []);

  const cleared = await t.plugin(rw, 'POST', `${base}/codex/entries/entry_01S5000000000000000000000G/first-appearance`, { body: { first_appearance: null } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.doesNotMatch(await text(t.root, ENTRY), /first_appearance/);
  const set = await t.plugin(rw, 'POST', `${base}/codex/entries/pell/first-appearance`, { body: { first_appearance: LIVE } });
  assert.equal(set.status, 200, set.text);
  assert.match(await text(t.root, 'codex/characters/pell.md'), new RegExp(`^first_appearance: ${LIVE}$`, 'm'));
  assert.equal((await t.plugin(rw, 'POST', `${base}/codex/entries/no-such-entry/first-appearance`, { body: { first_appearance: LIVE } })).status, 404);
});

test('the first-appearance path changes nothing else: name, status, role, aliases, fields and the rest of the body are ignored', async () => {
  const t = await bootPersonal();
  const rw = (await t.grant({ plugin: 'repointer', permissions: ['read', 'workspace'] })).token;
  const url = `${base}/codex/entries/maren-hollis/first-appearance`;
  const before = await text(t.root, ENTRY);
  const r = await t.plugin(rw, 'POST', url, { body: { first_appearance: OTHER, name: 'Hijacked', status: 'seed', role: 'Villain', aliases: ['X'], fields: { Age: 99 }, labels: ['x'], dryRun: true } });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.dryRun, true, 'dryRun is not forwarded');
  const after1 = await text(t.root, ENTRY);
  assert.equal(after1, before.replace(/^first_appearance: .*$/m, `first_appearance: ${OTHER}`), 'only the first_appearance line changed');
  // a body without first_appearance is refused (nothing to change), whatever else it carries
  const none = await t.plugin(rw, 'POST', url, { body: { name: 'Hijacked' } });
  assert.equal(none.status, 400, none.text);
  assert.equal(await text(t.root, ENTRY), after1);
});
