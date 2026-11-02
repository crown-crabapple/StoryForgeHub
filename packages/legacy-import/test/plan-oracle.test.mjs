// M06-J01 acceptance 1 and 4 on a hand-built dump: every row one disposition, coverage 1, unknown tables, server-only secrets,
// deterministic plans (same dump twice, dump copied elsewhere). The dump is written here, so the expectations are independent of the fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  BOOK_ID, allFiles, bookRow, chapterRow, copyTree, frontMatterSplit, loadImporter, planText, serializePlan, tmpDir, writeDump,
} from './helpers.mjs';

const { planImport } = await loadImporter();

const SECRETS = ['SECRETHASH-aaaa1111', 'SECRETTOKEN-bbbb2222', 'SECRETINVITE-cccc3333', 'SECRETRESET-dddd4444'];
const DISPOSITIONS = ['converted', 'merged', 'history', 'kept-as-data', 'derived', 'server-only', 'skipped'];
const ID_RE = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

function oracleTables() {
  return {
    books: [bookRow(), bookRow({ id: 'bk-other', folder: 'other-book', title: 'Other', sort_order: 1 })],
    chapters: [
      chapterRow({ id: 1, num: '1', sort_order: 1, title: 'Arrival', body: '# Arrival\n\nShe met [[mara-voss]] at the quay.\n\n---\n\nA second beat, see [[no-such-entry]].\n' }),
      chapterRow({ id: 2, num: '2', sort_order: 2, title: 'Departure', body: 'Gone by dawn.\n' }),
      chapterRow({ id: 3, book_id: 'bk-other', num: '1', sort_order: 1, title: 'Elsewhere', body: 'Not this book.\n' }),
    ],
    entries: [
      { id: 10, book_id: BOOK_ID, db_key: 'characters', slug: 'mara-voss', name: 'Mara Voss', status: 'canon', type: 'person', detail: 'ferrywoman', detail_label: 'Role', first_app: '1', related_raw: '', sort_order: 1, updated_at: '2026-01-01 00:00:00' },
    ],
    entry_fields: [{ id: 20, entry_id: 10, label: 'Age', value: '34', sort_order: 1 }],
    entry_sections: [{ id: 30, entry_id: 10, heading: 'History', body: 'Born on the salt flats.\n', sort_order: 1 }],
    entry_relations: [{ id: 40, entry_id: 10, target_slug: 'the-quay', sort_order: 1 }],
    progressions: [{ id: 50, book_id: BOOK_ID, chapter: '1', type: 'turn', what: 'Mara arrives', related_csv: 'mara-voss', sort_order: 1 }],
    users: [{ id: 1, display_name: 'Test Author', password_hash: SECRETS[0] }],
    api_tokens: [
      { id: 1, user_id: 1, token_hash: SECRETS[1], label: 'laptop', created_at: '2026-01-01 00:00:00' },
      { id: 2, user_id: 1, token_hash: `${SECRETS[1]}-2`, label: 'phone', created_at: '2026-01-01 00:00:00' },
    ],
    invites: [{ id: 1, email: '', token: SECRETS[2] }],
    password_resets: [{ id: 1, user_id: 1, token: SECRETS[3] }],
    zz_future_table: [{ id: 1, note: 'schema drift one' }, { id: 2, note: 'schema drift two' }],
  };
}

function oracleDump() {
  const dir = tmpDir('sf-li-oracle-');
  writeDump(dir, oracleTables());
  return dir;
}

const plans = new Map();
async function oraclePlan() {
  if (!plans.has('p')) plans.set('p', await planImport(oracleDump(), {}));
  return plans.get('p');
}

test('every row of every dumped table has exactly one disposition and coverage is 1', async () => {
  const plan = await oraclePlan();
  const tables = oracleTables();
  let total = 0;
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      total++;
      const hits = plan.dispositions.filter((d) => d.table === table && String(d.id) === String(row.id));
      assert.equal(hits.length, 1, `${table} #${row.id}: ${hits.length} dispositions`);
      assert.ok(DISPOSITIONS.includes(hits[0].disposition), `${table} #${row.id}: unknown disposition ${hits[0].disposition}`);
      if (hits[0].disposition === 'skipped') assert.ok(hits[0].reason, `${table} #${row.id}: skipped needs a reason`);
    }
  }
  assert.equal(plan.dispositions.length, total, 'no disposition for a row that does not exist');
  assert.equal(plan.summary.coverage, 1);
  for (const [table, rows] of Object.entries(tables)) {
    const t = plan.summary.tables[table];
    assert.ok(t, `summary.tables.${table}`);
    assert.equal(t.rows, rows.length);
    assert.equal(Object.values(t.by_disposition).reduce((a, b) => a + b, 0), rows.length, `${table}: by_disposition adds up`);
  }
  assert.equal(plan.summary.files, allFiles(plan).length);
});

test('entry_fields, sections and relations are merged into the entry file, not given files of their own', async () => {
  const plan = await oraclePlan();
  for (const table of ['entry_fields', 'entry_sections', 'entry_relations']) {
    const d = plan.dispositions.find((x) => x.table === table);
    assert.equal(d.disposition, 'merged', table);
  }
  const entry = allFiles(plan).find((f) => /(^|\/)codex\/characters\/mara-voss\.md$/.test(f.path));
  assert.ok(entry, 'codex/characters/mara-voss.md');
  const text = Buffer.from(entry.bytes).toString('utf8');
  assert.equal(String(frontMatterSplit(entry.bytes).fm.fields.Age), '34'); // the field lives in the YAML fields map only
  assert.match(text, /Born on the salt flats\./);
  assert.match(text, /the-quay/);
});

test('an unknown table is kept as data under legacy/tables/ with an info issue', async () => {
  const plan = await oraclePlan();
  const ds = plan.dispositions.filter((d) => d.table === 'zz_future_table');
  assert.equal(ds.length, 2);
  for (const d of ds) {
    assert.equal(d.disposition, 'kept-as-data');
    assert.match(d.target ?? '', /(^|\/)legacy\/tables\//);
  }
  assert.ok(plan.issues.some((i) => i.severity === 'info' && i.table === 'zz_future_table'), 'info issue naming the table');
  const kept = allFiles(plan).filter((f) => f.sources?.some((s) => s.table === 'zz_future_table'));
  assert.ok(kept.length >= 1);
  assert.ok(kept.every((f) => /(^|\/)legacy\/tables\//.test(f.path)));
  assert.match(Buffer.from(kept[0].bytes).toString('utf8'), /schema drift one/);
});

test('server-only tables are never turned into files and their secrets appear nowhere in the plan', async () => {
  const plan = await oraclePlan();
  for (const table of ['api_tokens', 'invites', 'password_resets']) {
    for (const d of plan.dispositions.filter((x) => x.table === table)) assert.equal(d.disposition, 'server-only', `${table} #${d.id}`);
    assert.deepEqual(allFiles(plan).filter((f) => f.sources?.some((s) => s.table === table)), [], `${table} must not source any file`);
  }
  const text = planText(plan);
  const raw = serializePlan(plan);
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `${secret} leaked into the plan`);
    assert.ok(!raw.includes(Buffer.from(secret).toString('hex')), `${secret} leaked (hex) into the plan`);
  }
});

test('the dumper form of a server-only table (listed with rows, flagged skipped, no jsonl) is accepted and produces no files', async () => {
  const dir = tmpDir('sf-li-skipped-');
  const tables = oracleTables();
  const { api_tokens, ...rest } = tables;
  writeDump(dir, rest);
  // add the table the way dump.php lists it: rows count, skipped flag, no rows on disk
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.tables.api_tokens = { rows: api_tokens.length, columns: ['id', 'user_id', 'label'], skipped: 'server-only' };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf));
  const plan = await planImport(dir, {});
  assert.equal(plan.summary.coverage, 1);
  assert.deepEqual(allFiles(plan).filter((f) => f.sources?.some((s) => s.table === 'api_tokens')), []);
});

test('the books option restricts the plan to the named legacy book', async () => {
  const plan = await planImport(oracleDump(), { books: ['salt-test'] });
  assert.equal(plan.books.length, 1);
  assert.equal(plan.books[0].legacy_id, BOOK_ID);
  assert.equal(plan.books[0].slug, 'salt-test');
  assert.match(plan.books[0].root, /^salt-test\/$/);
});

test('unknown links are reported as warnings and the link text is kept', async () => {
  const plan = await oraclePlan();
  assert.ok(plan.issues.some((i) => i.severity === 'warning' && JSON.stringify(i).includes('no-such-entry')), 'warning naming the unknown slug');
  const scene = allFiles(plan).find((f) => f.sources?.some((s) => s.table === 'chapters' && String(s.id) === '1') && /\.md$/.test(f.path) && Buffer.from(f.bytes).toString('utf8').includes('A second beat'));
  assert.ok(scene);
  assert.ok(Buffer.from(scene.bytes).toString('utf8').includes('[[no-such-entry]]'));
});

// ---- determinism ----------------------------------------------------------------------------------------------------------------

test('planning the same dump twice gives byte-identical plans', async () => {
  const dir = oracleDump();
  const a = serializePlan(await planImport(dir, {}));
  const b = serializePlan(await planImport(dir, {}));
  assert.equal(a, b);
});

test('a copy of the dump in another folder (new mtimes) gives the same plan, IDs and bytes', async () => {
  const dir = oracleDump();
  const copy = copyTree(dir, path.join(tmpDir('sf-li-copy-'), 'renamed-dump'));
  const later = new Date(Date.now() + 3600_000);
  for (const f of fs.readdirSync(path.join(copy, 'tables'))) fs.utimesSync(path.join(copy, 'tables', f), later, later);
  assert.equal(serializePlan(await planImport(copy, {})), serializePlan(await planImport(dir, {})));
});

test('proposed IDs are well formed and distinct per row, and survive a second plan unchanged', async () => {
  const plan = await oraclePlan();
  const again = await planImport(oracleDump(), {});
  const ids = (p) =>
    allFiles(p).flatMap((f) => {
      const { fm } = frontMatterSplit(f.bytes);
      return fm && typeof fm.id === 'string' ? [[f.path, fm.id]] : [];
    });
  const first = ids(plan);
  assert.ok(first.length >= 4, 'files with front-matter ids');
  for (const [p, id] of first) assert.match(id, ID_RE, p);
  assert.equal(new Set(first.map(([, id]) => id)).size, first.length, 'IDs are unique');
  assert.deepEqual(ids(again), first);
});

test('the dump sha256 in the plan is the sha256 of manifest.json', async () => {
  const dir = oracleDump();
  const { createHash } = await import('node:crypto');
  const plan = await planImport(dir, {});
  assert.equal(plan.dump.sha256, createHash('sha256').update(fs.readFileSync(path.join(dir, 'manifest.json'))).digest('hex'));
  assert.equal(plan.dump.dumper_version, 1);
  assert.equal(plan.importer_version, 1);
});

test('planning writes nothing into the dump directory', async () => {
  const dir = oracleDump();
  const { snapshot } = await import('./helpers.mjs');
  const before = snapshot(dir);
  await planImport(dir, {});
  assert.deepEqual(snapshot(dir), before);
});
