// M07-J01b: the repository side of series shared worlds, labels, typed fields and library templates, on a copy of the tidewater fixture
// (series tidewater with books salt-orchard-2 and low-tide, a standalone pilgrims-road, a library template mystery-arc).
// Every refusal is checked to change nothing (a snapshot of every file); the independent resolver (tools/canon-check) is the second opinion on links.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { resolveLibrary } from '../../../tools/canon-check/resolve.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const SO = 'book_01W10000000000000000000006';
const LT = 'book_01W1000000000000000000000A';
const PR = 'book_01W1000000000000000000000E';
const ILSE = 'entry_01W10000000000000000000003';
const MAREN = 'entry_01W10000000000000000000008';
const VESSEL = 'entry_01W10000000000000000000009';

const repos = [];
after(async () => {
  for (const r of repos) await r.close();
});

async function setup() {
  const root = await copyFixture('valid/tidewater');
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  repos.push(repo);
  return { root, repo };
}
const snap = (root) => snapshot(root, { skipStoryforge: true });
const errors = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const text = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);

test('a shared entry shows in both books of the series, flagged and with its series; a standalone book does not see it', async () => {
  const { repo } = await setup();
  for (const book of [SO, LT]) {
    const list = await repo.listCodexEntries(book);
    const ilse = list.entries.find((e) => e.slug === 'ilse-hollis');
    assert.equal(ilse.shared, true);
    assert.equal(ilse.series.slug, 'tidewater');
    assert.equal(ilse.path, 'tidewater/codex/characters/ilse-hollis.md');
    assert.deepEqual(ilse.labels, ['Mystery']);
    assert.equal(list.series.title, 'The Tidewater Books');
  }
  const alone = await repo.listCodexEntries(PR);
  assert.equal(alone.entries.some((e) => e.shared), false);
  assert.equal(alone.series, undefined);
  assert.equal((await repo.getEntry(PR, 'ilse-hollis')), null);
  const viaEntry = await repo.getEntry(LT, 'ilse-hollis');
  assert.equal(viaEntry.shared, true);
  assert.equal(viaEntry.series.slug, 'tidewater');
  assert.match(viaEntry.body, /Ilse kept the lamp/);
});

test('the type list shows typed fields: labels as the default fields, kinds beside them (J01a follow-up 1)', async () => {
  const { repo } = await setup();
  const vessel = (await repo.getCodexTypes(SO)).find((t) => t.type === 'vessel');
  assert.deepEqual(vessel.fields, ['Master', 'Tonnage', 'Launched', 'Home port', 'Rig', 'Cargoes', 'Notes']);
  assert.deepEqual(
    vessel.field_defs.map((f) => [f.label, f.kind]),
    [['Master', 'text'], ['Tonnage', 'number'], ['Launched', 'date'], ['Home port', 'link'], ['Rig', 'choice'], ['Cargoes', 'list'], ['Notes', 'text']],
  );
  assert.deepEqual(vessel.field_defs[4].choices, ['sloop', 'ketch', 'schooner']);
  assert.equal(vessel.shared, true);
  // another book of the series sees the series' type too; a new entry starts with every label, empty
  const { repo: repo2, root } = await setup();
  const made = await repo2.createEntry(LT, { type: 'vessel', name: 'The Heron', slug: 'the-heron' });
  assert.equal(made.ok, true, made.message);
  const fm = await text(root, 'tidewater/low-tide/codex/vessels/the-heron.md');
  for (const label of ['Master', 'Tonnage', 'Launched', 'Home port', 'Rig', 'Cargoes', 'Notes']) assert.match(fm, new RegExp(`^  ${label}: ""$`, 'm'));
});

test('saving a shared entry writes the series file once and the other book sees it; no receipts, no book file changes', async () => {
  const { root, repo } = await setup();
  const before = await snap(root);
  const r = await repo.setEntryFields(SO, ILSE, { role: 'Lamp keeper', labels: ['Mystery', 'Backstory'] });
  assert.equal(r.ok, true, r.message);
  const after = await snap(root);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.deepEqual(changed, ['tidewater/codex/characters/ilse-hollis.md']);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/provenance'), false, 'no receipts for a series file');
  const seen = (await repo.listCodexEntries(LT)).entries.find((e) => e.id === ILSE);
  assert.equal(seen.role, 'Lamp keeper');
  assert.deepEqual(seen.labels, ['Mystery', 'Backstory']);
  assert.match(await text(root, 'tidewater/codex/characters/ilse-hollis.md'), /^labels: \[Mystery, Backstory\]$/m);
  assert.deepEqual(await errors(root), []);
});

test('the text of a shared entry saves to the series file; a stale base is a conflict that writes nothing', async () => {
  const { root, repo } = await setup();
  const entry = await repo.getEntry(SO, ILSE);
  const stale = await repo.updateEntryBody(SO, ILSE, 'x', { baseSha256: 'f'.repeat(64) });
  assert.equal(stale.code, 'CONFLICT');
  assert.equal(stale.current.sha256, entry.sha256);
  const ok = await repo.updateEntryBody(SO, ILSE, `${entry.body}More.\n`, { baseSha256: entry.sha256 });
  assert.equal(ok.ok, true);
  assert.match(await text(root, 'tidewater/codex/characters/ilse-hollis.md'), /More\.\n$/);
  assert.match((await repo.getEntry(LT, ILSE)).body, /More\./);
});

test('New entry with where: series makes a shared entry; a book outside a series has no series to put it in', async () => {
  const { root, repo } = await setup();
  const r = await repo.createEntry(SO, { type: 'character', name: 'Tobin Reyes', slug: 'tobin-reyes', where: 'series' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.path, 'codex/characters/tobin-reyes.md', 'relative to the series folder');
  assert.equal(await exists(root, 'tidewater/codex/characters/tobin-reyes.md'), true);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/tobin-reyes.md'), false);
  assert.equal((await repo.listCodexEntries(LT)).entries.some((e) => e.slug === 'tobin-reyes' && e.shared), true);
  // a slug the series has is refused
  const again = await repo.createEntry(LT, { type: 'character', name: 'Tobin', slug: 'tobin-reyes', where: 'series' });
  assert.equal(again.code, 'SLUG_TAKEN');
  // standalone book
  const before = await snap(root);
  const alone = await repo.createEntry(PR, { type: 'character', name: 'Nobody', where: 'series' });
  assert.equal(alone.ok, false);
  assert.equal(alone.code, 'REFUSED_NO_SERIES');
  assert.deepEqual(await snap(root), before);
  const bad = await repo.createEntry(SO, { type: 'character', name: 'X', where: 'elsewhere' });
  assert.equal(bad.code, 'BAD_ARGS');
  assert.deepEqual(await errors(root), []);
});

test('Move to series keeps the id; links keep resolving, checked by the independent resolver', async () => {
  const { root, repo } = await setup();
  const before = resolveLibrary(root);
  assert.equal(before.owners[MAREN], 'book:salt-orchard-2');
  const dry = await repo.moveEntryToSeries(SO, 'maren-hollis', { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/maren-hollis.md'), true, 'a dry run writes nothing');
  const r = await repo.moveEntryToSeries(SO, 'maren-hollis');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.id, MAREN);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/maren-hollis.md'), false);
  assert.equal(await exists(root, 'tidewater/codex/characters/maren-hollis.md'), true);
  assert.match(await text(root, 'tidewater/codex/characters/maren-hollis.md'), new RegExp(`^id: ${MAREN}$`, 'm'));
  const after = resolveLibrary(root);
  assert.equal(after.owners[MAREN], 'series:tidewater');
  // every link that resolved before resolves to the same id now
  for (const l of before.links.filter((x) => x.to_id)) {
    assert.ok(after.links.some((y) => y.from_id === l.from_id && y.raw === l.raw && y.to_id === l.to_id), `${l.from_id} ${l.raw} still resolves to ${l.to_id}`);
  }
  assert.deepEqual(await errors(root), []);
  // the other book of the series now has it too, and the repository answers by id
  assert.equal((await repo.getEntry(LT, MAREN)).shared, true);
  assert.equal((await repo.listCodexEntries(SO)).entries.filter((e) => e.id === MAREN).length, 1);
});

test('Move to series is refused when the series already has the slug, and nothing changes', async () => {
  const { root, repo } = await setup();
  const before = await snap(root);
  const r = await repo.moveEntryToSeries(LT, 'port-aldine'); // low-tide's own port-aldine shadows the series' one
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SLUG_TAKEN');
  assert.deepEqual(await snap(root), before);
  const none = await repo.moveEntryToSeries(PR, 'captain-vane');
  assert.equal(none.code, 'REFUSED_NO_SERIES');
  assert.equal((await repo.moveEntryToSeries(SO, 'nobody')).ok, false);
  assert.deepEqual(await snap(root), before);
});

test('Move to series is refused (and rolled back) when the entry links to something only its book has', async () => {
  const { root, repo } = await setup();
  // a book entry that names a book-private entry: fine in the book, an E301 once it is shared canon
  const mid = await repo.createEntry(SO, { type: 'character', name: 'Pell', slug: 'captain-pell' });
  assert.equal(mid.ok, true, mid.message);
  const body = await repo.getEntry(SO, 'captain-pell');
  assert.equal((await repo.updateEntryBody(SO, 'captain-pell', `${body.body}Friend of [[maren-hollis]].\n`, { baseSha256: body.sha256 })).ok, true);
  const before = await snap(root);
  const r = await repo.moveEntryToSeries(SO, 'captain-pell');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROLLED_BACK');
  assert.ok(r.diagnostics.some((d) => d.code === 'E301'));
  assert.deepEqual(await snap(root), before);
});

test('Copy into this book makes a new id with the same slug and shows W309; a second copy is refused', async () => {
  const { root, repo } = await setup();
  const dry = await repo.copyEntryIntoBook(LT, 'ilse-hollis', { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(await exists(root, 'tidewater/low-tide/codex/characters/ilse-hollis.md'), false);
  const r = await repo.copyEntryIntoBook(LT, 'ilse-hollis');
  assert.equal(r.ok, true, r.message);
  assert.notEqual(r.id, ILSE);
  assert.match(r.id, /^entry_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(r.slug, 'ilse-hollis');
  assert.equal(r.path, 'tidewater/low-tide/codex/characters/ilse-hollis.md');
  assert.deepEqual(r.warnings.map((w) => w.code), ['W309']);
  const copy = await text(root, 'tidewater/low-tide/codex/characters/ilse-hollis.md');
  assert.match(copy, new RegExp(`^id: ${r.id}$`, 'm'));
  assert.match(copy, /^slug: ilse-hollis$/m);
  assert.match(await text(root, 'tidewater/codex/characters/ilse-hollis.md'), new RegExp(`^id: ${ILSE}$`, 'm'), 'the shared entry is untouched');
  assert.equal((await repo.getDiagnostics(LT)).some((d) => d.code === 'W309' && d.file === r.path), true);
  assert.deepEqual(await errors(root), []);
  const before = await snap(root);
  const again = await repo.copyEntryIntoBook(LT, 'ilse-hollis');
  assert.equal(again.code, 'SLUG_TAKEN');
  assert.deepEqual(await snap(root), before);
  assert.equal((await repo.copyEntryIntoBook(PR, 'ilse-hollis')).code, 'REFUSED_NO_SERIES');
  assert.equal((await repo.copyEntryIntoBook(LT, 'nobody')).ok, false);
});

test('a typed value that does not fit is saved, and shows W312; a list value round-trips', async () => {
  const { root, repo } = await setup();
  const r = await repo.setEntryFields(SO, VESSEL, {
    fields: [
      { label: 'Master', value: 'Captain Pell' },
      { label: 'Tonnage', value: 'a lot' }, // number kind
      { label: 'Cargoes', value: ['salt', 'tar', 'kelp, dry'] },
      { label: 'Home port', value: '[[port-aldine]]' },
    ],
  });
  assert.equal(r.ok, true, r.message);
  const entry = (await repo.listCodexEntries(SO)).entries.find((e) => e.id === VESSEL);
  assert.deepEqual(entry.fields.Cargoes, ['salt', 'tar', 'kelp, dry']);
  assert.deepEqual(entry.problems.map((p) => [p.code, p.location]), [['W312', 'fields.Tonnage']]);
  assert.match(await text(root, 'tidewater/salt-orchard-2/codex/vessels/gull-and-ledger.md'), /^ {2}Cargoes: \[salt, tar, "kelp, dry"\]$/m);
  assert.deepEqual(await errors(root), []);
});

test('book and series labels: the lists are read, written with their own block only, and a bad colour or a repeated name writes nothing', async () => {
  const { root, repo } = await setup();
  const got = await repo.getLabels(SO);
  assert.deepEqual(got.book.labels, [{ name: 'Draft Two', color: '#2E7D32' }]);
  assert.deepEqual(got.series.labels.map((l) => l.name), ['Mystery', 'Backstory']);
  assert.equal((await repo.getLabels(PR)).series, null);
  const before = await snap(root);
  for (const labels of [[{ name: 'A', color: 'red' }], [{ name: 'A', color: '#112233' }, { name: 'a', color: '#445566' }], [{ name: '', color: '#112233' }]]) {
    const bad = await repo.setLabels(SO, { scope: 'book', labels });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'REFUSED_BAD_ARGS');
  }
  assert.equal((await repo.setLabels(PR, { scope: 'series', labels: [] })).code, 'REFUSED_NO_SERIES');
  assert.deepEqual(await snap(root), before);

  const w = await repo.setLabels(SO, { scope: 'book', labels: [{ name: 'Draft Two', color: '#2e7d32' }, { name: 'Rewrite', color: '#C77DFF' }] });
  assert.equal(w.ok, true, w.message);
  const s = await repo.setLabels(SO, { scope: 'series', labels: [...got.series.labels, { name: 'Clue', color: '#E0A64B' }] });
  assert.equal(s.ok, true, s.message);
  const book = await text(root, 'tidewater/salt-orchard-2/book.md');
  assert.match(book, /^labels:\n {2}- name: Draft Two\n {4}color: "#2E7D32"\n {2}- name: Rewrite\n {4}color: "#C77DFF"\n/m);
  assert.match(book, /^title: Salt Orchard Two$/m);
  assert.deepEqual((await repo.getLabels(LT)).series.labels.map((l) => l.name), ['Mystery', 'Backstory', 'Clue']);
  assert.deepEqual(await errors(root), []);
});

test("a shared entry's own problems show in each book's problems list, badged as the series' (J01a follow-up 2)", async () => {
  const { root, repo } = await setup();
  const made = await repo.createEntry(SO, { type: 'vessel', name: 'The Gull', slug: 'the-gull', where: 'series', fields: [{ label: 'Tonnage', value: 'heavy' }] });
  assert.equal(made.ok, true, made.message);
  for (const book of [SO, LT]) {
    const items = await repo.getDiagnostics(book);
    const hit = items.find((d) => d.code === 'W312');
    assert.equal(hit?.file, 'tidewater/codex/vessels/the-gull.md');
    assert.equal(hit.scope, 'series');
    assert.equal(hit.series, 'tidewater');
  }
  assert.equal((await repo.getDiagnostics(PR)).some((d) => d.scope === 'series'), false);
  assert.equal((await repo.getDiagnostics(LT)).filter((d) => d.scope === undefined).every((d) => d.file.startsWith('tidewater/low-tide/')), true);
  assert.equal(await exists(root, 'tidewater/codex/vessels/the-gull.md'), true);
});

test('link targets: this book, then its series, then the other books written book-slug:slug', async () => {
  const { repo } = await setup();
  const t = await repo.getLinkTargets(LT);
  assert.deepEqual(t.book.map((i) => i.link).sort(), ['[[port-aldine]]', '[[the-lost-ledger]]']);
  assert.equal(t.series.slug, 'tidewater');
  assert.deepEqual(t.series.items.map((i) => i.link), ['[[ilse-hollis]]', '[[port-aldine]]']);
  const so = t.books.find((b) => b.slug === 'salt-orchard-2');
  assert.deepEqual(so.items.map((i) => i.link).sort(), ['[[salt-orchard-2:gull-and-ledger]]', '[[salt-orchard-2:maren-hollis]]']);
  assert.ok(t.books.some((b) => b.slug === 'pilgrims-road'));
  assert.equal((await repo.getLinkTargets(PR)).series, null);
  assert.equal(await repo.getLinkTargets('book_NONE'), null);
});

test('Save as template writes _templates/<name>/ and a book made from it validates clean; an existing name is refused and changes nothing', async () => {
  const { root, repo } = await setup();
  const r = await repo.saveAsTemplate(SO, { name: 'second-book', title: 'Second book', description: 'The shape of book two.' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.path, '_templates/second-book');
  assert.equal(await exists(root, '_templates/second-book/template.md'), true);
  assert.deepEqual(await errors(root), []);
  assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.file.startsWith('_templates/')), []);
  const listed = (await repo.listTemplates()).find((t) => t.name === 'second-book');
  assert.equal(listed.source, 'library');
  // no story text and no entries in it
  assert.equal(await exists(root, '_templates/second-book/book/codex/characters'), false, 'no entries');
  assert.equal(await exists(root, '_templates/second-book/book/manuscript/act-01-one/ch-001-one/0010-arrival.md'), true, 'the scene is kept, without its text');
  assert.doesNotMatch(await text(root, '_templates/second-book/book/manuscript/act-01-one/ch-001-one/0010-arrival.md'), /Maren stepped/);

  const made = await repo.createBook({ title: 'Book Three', template: 'second-book', templateSource: 'library', seriesSlug: 'tidewater' });
  assert.equal(made.ok, true, made.message);
  assert.equal(made.path, 'tidewater/book-three');
  assert.deepEqual(await errors(root), []);
  const info = (await repo.getBook(made.bookId));
  assert.equal(info.series, 'tidewater');
  assert.equal(info.title, 'Book Three');
  assert.ok(info.acts[0].chapters[0].scenes.length >= 1);
  // the book has the labels its scenes use (the series' Mystery was copied into the template's book.md)
  assert.deepEqual((await repo.getDiagnostics(made.bookId)).filter((d) => d.code === 'W311'), []);

  const before = await snap(root);
  const again = await repo.saveAsTemplate(SO, { name: 'second-book', title: 'Another' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'TEMPLATE_EXISTS');
  assert.deepEqual(await snap(root), before);
  assert.equal((await repo.saveAsTemplate(SO, { name: 'Bad Name', title: 'x' })).code, 'BAD_NAME');
  assert.equal((await repo.saveAsTemplate(SO, { name: 'ok', title: '  ' })).code, 'BAD_TITLE');
  assert.equal((await repo.saveAsTemplate('book_NONE', { name: 'ok', title: 'x' })).ok, false);
  assert.deepEqual(await snap(root), before);
});

test('a library template that shares a built-in name is picked by source; the library one is not the built-in', async () => {
  const { root, repo } = await setup();
  await fs.cp(path.join(root, '_templates', 'mystery-arc'), path.join(root, '_templates', 'blank'), { recursive: true });
  const meta = path.join(root, '_templates', 'blank', 'template.md');
  await fs.writeFile(meta, (await fs.readFile(meta, 'utf8')).replace('name: mystery-arc', 'name: blank'));
  const listed = (await repo.listTemplates()).filter((t) => t.name === 'blank');
  assert.deepEqual(listed.map((t) => [t.source, t.shadows_builtin === true]), [['builtin', false], ['library', true]]);
  const lib = await repo.createBook({ title: 'Shadow Book', template: 'blank', templateSource: 'library' });
  assert.equal(lib.ok, true, lib.message);
  assert.ok((await repo.getBook(lib.bookId)).acts[0].chapters[0].scenes.length >= 1, 'the library template has a scene; the built-in blank has none');
  const builtin = await repo.createBook({ title: 'Plain Book', template: 'blank', templateSource: 'builtin' });
  assert.equal(builtin.ok, true, builtin.message);
  assert.equal((await repo.createBook({ title: 'Nope', template: 'nope', templateSource: 'library' })).code, 'NO_SUCH_TEMPLATE');
});
