// M07-J01: series shared worlds, cross-book links, labels, typed fields and user templates in the validator.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, extractLinks, extractShared } from '../src/index.mjs';
import { VALID, keyOf } from './helpers.mjs';

const TIDEWATER = path.join(VALID, 'tidewater');
const temps = [];
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

/** A copy of the tidewater fixture in a temp folder. */
function copyTidewater() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-world-'));
  temps.push(dir);
  const dest = path.join(dir, 'tidewater-lib');
  fs.cpSync(TIDEWATER, dest, { recursive: true });
  return dest;
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const write = (root, rel, text) => fs.writeFileSync(path.join(root, ...rel.split('/')), text);
const edit = (root, rel, from, to) => {
  const text = read(root, rel);
  assert.ok(text.includes(from), `${rel} contains ${from}`);
  write(root, rel, text.replace(from, to));
};
const keys = (r) => r.diagnostics.map(keyOf);
const lineOf = (root, rel, needle) => `line ${read(root, rel).split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1}`;
const idOf = (root, rel) => /^id: (.+)$/m.exec(read(root, rel))[1];

const ILSE = 'tidewater/codex/characters/ilse-hollis.md';
const PORT = 'tidewater/codex/locations/port-aldine.md';
const LOCAL_PORT = 'tidewater/low-tide/codex/locations/port-aldine.md';
const ARRIVAL = 'tidewater/salt-orchard-2/manuscript/act-01-one/ch-001-one/0010-arrival.md';
const EBB = 'tidewater/low-tide/manuscript/act-01-one/ch-001-one/0010-ebb.md';
const START = 'pilgrims-road/manuscript/act-01-one/ch-001-one/0010-start.md';

test('tidewater: ilse-hollis is one file in the library, and both books resolve it by bare slug', async () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(TIDEWATER);
  assert.equal(files.filter((f) => f.endsWith('ilse-hollis.md')).length, 1);

  const result = await validate(TIDEWATER);
  const ilse = idOf(TIDEWATER, ILSE);
  for (const book of ['tidewater/salt-orchard-2', 'tidewater/low-tide']) {
    const links = extractLinks(result, book);
    const hits = links.filter((l) => l.target_id === ilse);
    assert.ok(hits.some((l) => l.location === 'characters[0]' && l.resolution === 'ok'), `${book} front matter`);
    assert.ok(hits.some((l) => l.location.startsWith('line ') && l.resolution === 'ok'), `${book} body`);
    assert.equal(extractShared(result, book).series.slug, 'tidewater');
  }
  assert.equal(extractShared(result, 'pilgrims-road'), null);
});

test('tidewater: a book outside the series cannot resolve shared entries (E301), bare or by series prefix', async () => {
  const root = copyTidewater();
  edit(root, START, 'characters: [captain-vane]', 'characters: [captain-vane, ilse-hollis]');
  edit(root, START, 'Captain Vane set out at first light.', 'Captain Vane met [[ilse-hollis]] and recalled [[port-aldine]].');
  const r = await validate(root);
  assert.deepEqual(keys(r).filter((k) => k.startsWith('E301')).sort(), [
    `E301 | ${START} | characters[1]`,
    `E301 | ${START} | ${lineOf(root, START, 'Captain Vane met')}`,
  ].sort());
});

test('tidewater: [[series:slug]] reaches the shared entry even when a local entry shadows it', async () => {
  const result = await validate(TIDEWATER);
  const links = extractLinks(result, 'tidewater/low-tide');
  const shared = idOf(TIDEWATER, PORT);
  const local = idOf(TIDEWATER, LOCAL_PORT);
  assert.notEqual(shared, local);
  assert.equal(links.find((l) => l.location === 'locations[0]').target_id, local, 'bare slug: the local entry wins');
  assert.equal(links.find((l) => l.raw === 'tidewater:port-aldine').target_id, shared, 'explicit form: the shared entry');
  assert.deepEqual(result.diagnostics.filter((d) => d.code === 'W309').map(keyOf), [`W309 | ${LOCAL_PORT} | slug`]);
});

test('tidewater: cross-book links resolve to the other book (no I402), and a shared entry may link across books', async () => {
  const result = await validate(TIDEWATER);
  assert.ok(!result.diagnostics.some((d) => d.code === 'I402' || d.code === 'E303'));
  const thread = idOf(TIDEWATER, 'tidewater/low-tide/planning/threads/the-lost-ledger.md');
  const fromBook = extractLinks(result, 'tidewater/salt-orchard-2').find((l) => l.raw === 'low-tide:the-lost-ledger');
  assert.equal(fromBook.target_id, thread);
  assert.equal(fromBook.target_kind, 'thread');
  assert.equal(fromBook.target_owner.kind, 'book');
  assert.equal(fromBook.target_owner.slug, 'low-tide');
  const fromShared = extractShared(result, 'tidewater/salt-orchard-2').links.find((l) => l.raw === 'low-tide:the-lost-ledger');
  assert.equal(fromShared.target_id, thread);
  assert.equal(fromShared.src_path, ILSE, 'shared links are relative to the validated root');
});

test('a book validated alone cannot see its series or the other books: I402 for cross-book links, E301 for shared slugs', async () => {
  const r = await validate(path.join(TIDEWATER, 'tidewater', 'salt-orchard-2'));
  assert.ok(r.diagnostics.some((d) => d.code === 'I402'));
  assert.ok(!r.diagnostics.some((d) => d.code === 'E303'));
  assert.ok(r.diagnostics.some((d) => d.code === 'E301' && d.location === 'characters[0]'));
});

test('a series root sees its books and its shared world; a prefix it cannot see is I402, not E303', async () => {
  const root = copyTidewater();
  edit(root, ARRIVAL, 'Later she would', 'Later [[elsewhere:somebody]] and she would');
  const r = await validate(path.join(root, 'tidewater'));
  assert.ok(!r.diagnostics.some((d) => d.code === 'E301' || d.code === 'E303'), JSON.stringify(r.diagnostics));
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'I402').map((d) => d.file), ['salt-orchard-2/manuscript/act-01-one/ch-001-one/0010-arrival.md']);
  assert.ok(extractShared(r, 'salt-orchard-2').docs.length >= 3);
});

test('a library root reports an unknown prefix as E303, and the cross-book form in a front-matter reference as E302', async () => {
  const root = copyTidewater();
  edit(root, ARRIVAL, 'Later she would', 'Later [[elsewhere:somebody]] and she would');
  edit(root, ARRIVAL, 'characters: [ilse-hollis]', 'characters: [low-tide:ilse-hollis]');
  const k = keys(await validate(root));
  assert.ok(k.includes(`E303 | ${ARRIVAL} | ${lineOf(root, ARRIVAL, 'elsewhere:somebody')}`));
  assert.ok(k.includes(`E302 | ${ARRIVAL} | characters[0]`));
});

test('shared lookups follow previous_slugs (W301) and a live shared entry beats an archived local one', async () => {
  const root = copyTidewater();
  edit(root, ILSE, 'slug: ilse-hollis', 'slug: ilse-holloway\nprevious_slugs: [ilse-hollis]');
  const k = keys(await validate(root));
  assert.ok(k.includes(`W301 | ${ARRIVAL} | characters[0]`));
  assert.ok(k.includes(`W301 | ${EBB} | pov`));
});

test('a shared entry under a book archive/ is a local archived entry, not a shared one', async () => {
  const root = copyTidewater();
  fs.mkdirSync(path.join(root, 'tidewater/salt-orchard-2/archive/codex/characters'), { recursive: true });
  fs.renameSync(path.join(root, ILSE), path.join(root, 'tidewater/salt-orchard-2/archive/codex/characters/ilse-hollis.md'));
  const k = keys(await validate(root));
  assert.ok(k.includes(`W303 | ${ARRIVAL} | characters[0]`), 'resolves only in its own book, with W303');
  assert.ok(k.includes(`E301 | ${EBB} | characters[0]`), 'the other book no longer sees it');
});

test('series-level folders other than codex/ and archive/ are ignored', async () => {
  const root = copyTidewater();
  fs.mkdirSync(path.join(root, 'tidewater/notes'), { recursive: true });
  write(root, 'tidewater/notes/stray.md', '---\nschema: storyforge.entry/v1\nid: entry_01W1000000000000000000000Z\nslug: stray\n---\n');
  assert.deepEqual(keys(await validate(root)), [`W309 | ${LOCAL_PORT} | slug`]);
});

test('typed fields: a value that fits is silent, a value that does not is W312 at fields.<label>', async () => {
  const root = copyTidewater();
  const vessel = 'tidewater/salt-orchard-2/codex/vessels/gull-and-ledger.md';
  edit(root, vessel, 'Tonnage: 42', 'Tonnage: heavy');
  edit(root, vessel, 'Launched: "1891-04-12"', 'Launched: "1891-13-40"');
  edit(root, vessel, 'Rig: ketch', 'Rig: junk');
  edit(root, vessel, 'Cargoes: [salt, tar]', 'Cargoes: salt');
  edit(root, vessel, 'Home port: "[[port-aldine]]"', 'Home port: Port Aldine');
  const k = keys(await validate(root)).filter((x) => x.startsWith('W312'));
  assert.deepEqual(k.sort(), ['Tonnage', 'Launched', 'Rig', 'Cargoes', 'Home port'].map((l) => `W312 | ${vessel} | fields.${l}`).sort());
});

test('labels: a label defined by the book or the series is fine, anything else is W311', async () => {
  const root = copyTidewater();
  edit(root, ARRIVAL, 'labels: [Mystery, Draft Two]', 'labels: [Mystery, Draft Two, Nope]');
  edit(root, 'tidewater/low-tide/planning/threads/the-lost-ledger.md', 'labels: [Mystery]', 'labels: [Draft Two]');
  const k = keys(await validate(root)).filter((x) => x.startsWith('W311'));
  assert.deepEqual(k.sort(), [
    `W311 | ${ARRIVAL} | labels[2]`,
    'W311 | tidewater/low-tide/planning/threads/the-lost-ledger.md | labels[0]',
  ].sort());
});

test('_templates/ is not scanned as a book or series, and a library template is validated as a template only', async () => {
  const r = await validate(TIDEWATER);
  assert.ok(!r.books.some((b) => b.path.startsWith('_templates')));
  assert.ok(!r.diagnostics.some((d) => d.file.startsWith('_templates')));
});
