// M06-J01 acceptance 1, 3, 4, 5 on the two committed fixtures (seed-dump and edge-dump): 100% disposition, byte-preserving split,
// determinism, expected-plan-summary.json, and format validation of the planned tree (written to a temp dir, test only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { validate } from '@storyforge/format';
import {
  EDGE_DUMP, LI, SEED_DUMP, allFiles, copyTree, loadImporter, rejoinProblem, scenesOf, serializePlan, tmpDir, writeTree,
} from './helpers.mjs';

const { planImport, planToTree } = await loadImporter();

/** Every table in a dump directory with its rows, read straight from the JSONL (independent of the importer). */
function readDump(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = {};
  for (const [name, info] of Object.entries(manifest.tables)) {
    const file = path.join(dir, 'tables', `${name}.jsonl`);
    tables[name] = info.skipped || !fs.existsSync(file) ? [] : fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return { manifest, tables };
}

/** Codes of the plan's issues, sorted and de-duplicated. */
const codesOf = (plan) => [...new Set(plan.issues.map((i) => i.code))].sort();

function expectedOf(dir) {
  const file = path.join(dir, LI.expectedSummaryFile);
  assert.ok(fs.existsSync(file), `${file} must be committed`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The planned tree with each book under its root, as @storyforge/format expects a library. */
function treeFor(plan) {
  const tree = planToTree(plan);
  assert.ok(tree instanceof Map, 'planToTree returns a Map<path, Buffer>');
  if (plan.books.length === 1 && ![...tree.keys()].some((k) => k.startsWith(plan.books[0].root))) {
    return new Map([...tree].map(([k, v]) => [plan.books[0].root + k, v]));
  }
  return tree;
}

for (const [label, dir] of [['seed-dump', SEED_DUMP], ['edge-dump', EDGE_DUMP]]) {
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), `fixture ${label} must be committed`);
  const { manifest, tables } = readDump(dir);
  const plan = await planImport(dir, {});
  describe(label, () => {

    test('every row has exactly one disposition; coverage is 1', () => {
      let total = 0;
      for (const [table, rows] of Object.entries(tables)) {
        if (manifest.tables[table].skipped === 'server-only') continue; // listed with a row count, but dump.php writes no jsonl for it
        assert.equal(rows.length, manifest.tables[table].rows, `${table}: jsonl rows match manifest`);
        for (const row of rows) {
          total++;
          const hits = plan.dispositions.filter((d) => d.table === table && String(d.id) === String(row.id));
          assert.equal(hits.length, 1, `${table} #${row.id}`);
        }
      }
      assert.equal(plan.dispositions.length, total);
      assert.equal(plan.summary.coverage, 1);
      for (const [table, rows] of Object.entries(tables)) {
        const t = plan.summary.tables[table];
        if (manifest.tables[table].skipped === 'server-only') {
          assert.equal(t.rows, manifest.tables[table].rows, `${table} rows come from the manifest`);
          assert.deepEqual(t.by_disposition, {}, `${table} has no dispositions`);
          continue;
        }
        assert.equal(t.rows, rows.length, table);
        assert.equal(Object.values(t.by_disposition).reduce((a, b) => a + b, 0), rows.length, `${table} by_disposition`);
      }
    });

    test('summary and issue codes match expected-plan-summary.json', () => {
      const expected = expectedOf(dir);
      assert.deepEqual(plan.summary, expected.summary);
      const codes = expected.issue_codes ?? expected.issues?.map((i) => i.code ?? i);
      assert.ok(Array.isArray(codes), 'expected-plan-summary.json lists the issue codes (issue_codes)');
      assert.deepEqual(codesOf(plan), [...new Set(codes)].sort());
    });

    test('re-joining the scenes of every chapter reproduces chapters.body exactly', () => {
      const chapters = tables.chapters ?? [];
      assert.ok(chapters.length > 0);
      for (const ch of chapters) {
        const body = typeof ch.body === 'string' ? ch.body : '';
        if (ch.status === 'archived') continue; // archived chapters live under archive/ with the same layout; covered below
        const problem = rejoinProblem(body, scenesOf(plan, ch.id).map((s) => s.body));
        assert.equal(problem, null, `chapter #${ch.id} ${JSON.stringify(ch.title)}: ${problem}`);
      }
    });

    test('archived chapters are planned too (archive/), and re-join as well', () => {
      for (const ch of (tables.chapters ?? []).filter((c) => c.status === 'archived')) {
        const files = allFiles(plan).filter((f) => f.sources?.some((s) => s.table === 'chapters' && String(s.id) === String(ch.id)));
        assert.ok(files.length >= 1, `archived chapter #${ch.id} has a destination`);
        assert.ok(files.every((f) => /(^|\/)archive\//.test(f.path)), `archived chapter #${ch.id} lives under archive/`);
        const bodies = files
          .filter((f) => !/chapter\.md$/.test(f.path) && /\.md$/.test(f.path))
          .map((f) => Buffer.from(f.bytes).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, ''));
        assert.equal(rejoinProblem(ch.body ?? '', bodies), null, `archived chapter #${ch.id}`);
      }
    });

    test('the same dump, and a copy of it elsewhere, plan identically', async () => {
      const copy = copyTree(dir, path.join(tmpDir('sf-li-fixcopy-'), 'moved'));
      assert.equal(serializePlan(await planImport(copy, {})), serializePlan(plan));
      assert.equal(serializePlan(await planImport(dir, {})), serializePlan(plan));
    });

    test('the planned tree validates with no errors; warnings are the expected ones', async () => {
      const root = writeTree(treeFor(plan));
      const { diagnostics } = await validate(root);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      assert.deepEqual(errors.map((d) => `${d.code} ${d.file} ${d.location} ${d.message}`), []);
      const expected = expectedOf(dir);
      const warnCodes = [...new Set(diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code))].sort();
      assert.deepEqual(warnCodes, [...new Set(expected.validation_warnings ?? [])].sort(), 'validator warnings are listed in expected-plan-summary.json (validation_warnings)');
    });

    test('server-only tables produce no files', () => {
      for (const d of plan.dispositions.filter((x) => x.disposition === 'server-only')) assert.equal(d.target, undefined, `${d.table} #${d.id}`);
      const serverOnly = new Set(plan.dispositions.filter((x) => x.disposition === 'server-only').map((x) => x.table));
      for (const f of allFiles(plan)) for (const s of f.sources ?? []) assert.ok(!serverOnly.has(s.table), `${f.path} sourced from server-only ${s.table}`);
    });
  });
}

describe('edge-dump content-type coverage', () => {
  // Content types of contract section 2 (the M00-J01 audit list): each must be present in the edge dump and not skipped.
  const TYPES = [
    'books', 'chapters', 'entries', 'entry_fields', 'entry_sections', 'entry_relations', 'sources', 'note_pages', 'meta_pages',
    'workspace_docs', 'progressions', 'state_events', 'knowledge_facts', 'story_ledger', 'chapter_cast', 'continuity_exemptions',
    'tasks', 'task_steps', 'writing_log', 'chapter_notes', 'canvas_cards', 'canvas_links', 'vision_items', 'captures',
    'dictionary_terms', 'chapter_revisions', 'entry_revisions', 'workspace_revisions',
  ];
  test('every content type has rows and none of them is skipped', async () => {
    const { tables } = readDump(EDGE_DUMP);
    const plan = await planImport(EDGE_DUMP, {});
    for (const t of TYPES) {
      assert.ok((tables[t] ?? []).length > 0, `edge dump has at least one ${t} row`);
      const ds = plan.dispositions.filter((d) => d.table === t);
      assert.ok(ds.length > 0, t);
      assert.ok(ds.every((d) => d.disposition !== 'skipped'), `${t} rows are not skipped`);
    }
  });

  test('edge dump carries the documented hazards', async () => {
    const { tables, manifest } = readDump(EDGE_DUMP);
    const plan = await planImport(EDGE_DUMP, {});
    const nums = tables.chapters.map((c) => String(c.num));
    assert.ok(nums.includes('3.5') && nums.includes('prologue'), 'chapters 3.5 and prologue');
    assert.ok(tables.chapters.some((c) => c.status === 'archived'), 'an archived chapter');
    const known = new Set(['books', 'acts', ...TYPES, 'users', 'book_members', 'book_activity', 'api_tokens', 'invites', 'password_resets', 'editing_locks',
      'threads', 'mentions', 'prose_analysis', 'claim_sources', 'exercises', 'sync_state', 'scenes', 'oauth_clients', 'oauth_codes', 'oauth_tokens']);
    const unknown = Object.keys(manifest.tables).filter((t) => !known.has(t) && !t.startsWith('oauth_'));
    assert.ok(unknown.length >= 1, 'an unknown table');
    for (const t of unknown) assert.ok(plan.issues.some((i) => i.severity === 'info' && i.table === t), `info issue for ${t}`);
    assert.ok(plan.issues.some((i) => i.severity === 'warning'), 'warnings for the duplicate sort_order, slug collision and missing chapter');
    const text = JSON.stringify(Object.values(tables).flat());
    assert.ok(/\$b64/.test(text), 'a non-UTF-8 value stored as {"$b64": ...}');
  });
});
