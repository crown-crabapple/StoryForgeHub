// Phase 0 (H0 section 6): fixtures/hosted-import is complete, and expected-import.json matches the files.
// The fixture is the input of every Phase 1 importer test, so this test fails when a KINDS kind (or any listed category) goes missing,
// and when the manifest and the files disagree. Pure file reading plus validate(); no network, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validate, parseCanvas } from '../src/index.mjs';
import { parseText } from '../src/frontmatter.mjs';
import { KINDS } from '../src/schema.mjs';
import { FIXTURES, walkFiles } from './helpers.mjs';

const ROOT = path.join(FIXTURES, 'hosted-import');
const SHARED = path.join(ROOT, 'shared-data');
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'expected-import.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const sharedJson = (name) => JSON.parse(fs.readFileSync(path.join(SHARED, name), 'utf8'));
const HEX64 = /^[0-9a-f]{64}$/;

// every file of the library (shared-data/ is the shared-mode store, not part of the library; .storyforge/ is machine-local)
const ALL = walkFiles(ROOT);
const LIBRARY_FILES = ALL.filter((f) => !f.startsWith('shared-data/') && !f.includes('.storyforge/'));

/** @type {{ rel: string, kind: string, fm: any, body: string, archived: boolean, bookPath: string | null }[]} */
const DOCS = [];
for (const rel of LIBRARY_FILES.filter((f) => f.endsWith('.md'))) {
  const parsed = parseText(read(rel));
  const m = /^storyforge\.([a-z-]+)\/v1$/.exec(parsed.fm?.schema ?? '');
  if (!m) continue;
  const book = /^(saltmarsh\/[^/]+)\//.exec(rel);
  DOCS.push({ rel, kind: m[1], fm: parsed.fm, body: parsed.body, archived: rel.split('/').includes('archive'), bookPath: book ? book[1] : null });
}
const byKind = (kind) => DOCS.filter((d) => d.kind === kind);
const idOfFile = (rel) => parseText(read(rel)).fm.id;
const tally = (items) => {
  const out = {};
  for (const k of items) out[k] = (out[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
};
const sortedKeys = (o) => Object.fromEntries(Object.entries(o).sort());

const result = await validate(ROOT);

// ---- (a) the package's own validator ---------------------------------------------------------------------------------------------------

test('validate(): reports exactly the findings in expected-import.json, and no error beyond the one deliberate E301', () => {
  const got = result.diagnostics.map((d) => ({ code: d.code, record_id: idOfFile(d.file), file: d.file, location: d.location }));
  const want = expected.expected_findings.map((f) => ({ code: f.code, record_id: f.record_id, file: f.file, location: f.location }));
  const order = (a, b) => `${a.code}|${a.file}|${a.location}`.localeCompare(`${b.code}|${b.file}|${b.location}`);
  assert.deepEqual(got.sort(order), want.sort(order));
  // H0 section 6 requires an unresolved [[link]], which the validator can only report as E301; nothing else may be an error
  const errors = result.diagnostics.filter((d) => d.severity === 'error' || d.code.startsWith('E'));
  assert.deepEqual(errors.map((d) => d.code), ['E301']);
});

test('validate(): the expected findings cover the deliberate W303 (archived scene) and the unresolved [[link]]', () => {
  const w303 = expected.expected_findings.find((f) => f.code === 'W303');
  assert.ok(w303, 'a W303 finding is listed');
  const thread = DOCS.find((d) => d.fm.id === w303.record_id);
  assert.equal(thread.kind, 'thread');
  const archivedScenes = DOCS.filter((d) => d.kind === 'scene' && d.archived).map((d) => d.fm.id);
  assert.ok(thread.fm.develop.some((id) => archivedScenes.includes(id)), 'the thread points at an archived scene');
  const e301 = expected.expected_findings.find((f) => f.code === 'E301');
  const scene = DOCS.find((d) => d.fm.id === e301.record_id);
  assert.match(scene.body, /\[\[the-ferry-ledger\]\]/);
  assert.equal(DOCS.filter((d) => d.kind === 'entry').some((d) => d.fm.slug === 'the-ferry-ledger'), false, 'the link really is unresolved');
});

test('validate(): finds both books of the series with series_number 1 and 2', () => {
  assert.equal(result.books.length, expected.books.length);
  for (const want of expected.books) {
    const book = result.books.find((b) => b.id === want.id);
    assert.ok(book, `book ${want.id} found`);
    assert.equal(book.slug, want.slug);
    assert.equal(book.path, want.path);
    assert.equal(book.series, want.series);
  }
  const doc = (p) => DOCS.find((d) => d.rel === `${p}/book.md`);
  assert.deepEqual(expected.books.map((b) => doc(b.path).fm.series_number), [1, 2]);
  assert.deepEqual(expected.books.map((b) => b.series_number), [1, 2]);
});

// ---- (b) every KINDS kind is present -------------------------------------------------------------------------------------------------------

for (const kind of Object.keys(KINDS)) {
  test(`KINDS: the fixture holds at least one ${kind}`, () => {
    assert.ok(byKind(kind).length >= 1, `no storyforge.${kind}/v1 document in hosted-import/`);
  });
}

test('KINDS: the manifest counts every kind in KINDS (a new kind needs a count)', () => {
  const missing = Object.keys(KINDS).filter((k) => !(expected.counts.documents[k] >= 1));
  assert.deepEqual(missing, []);
});

test('KINDS: every kind lives where the format puts it (no W201 placement findings)', () => {
  assert.deepEqual(result.diagnostics.filter((d) => d.code === 'W201'), []);
});

// ---- structure of the library -----------------------------------------------------------------------------------------------------------

test('layout: library.md, one series folder with two books, series-shared entries and a _types file, shared-data as a sibling', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'library.md')));
  assert.equal(byKind('library').length, 1);
  assert.equal(byKind('series').length, 1);
  const series = byKind('series')[0];
  assert.equal(series.rel, 'saltmarsh/series.md');
  const shared = DOCS.filter((d) => d.rel.startsWith('saltmarsh/codex/'));
  assert.ok(shared.filter((d) => d.kind === 'entry').length >= 2, 'series-shared Codex entries');
  assert.ok(shared.some((d) => d.kind === 'codex-type' && d.rel.startsWith('saltmarsh/codex/_types/')), 'a _types file');
  assert.ok(shared.some((d) => d.kind === 'entry' && !['character', 'location', 'faction', 'object', 'lore'].includes(d.fm.type)), 'an entry of the custom type');
  assert.ok(fs.statSync(SHARED).isDirectory());
  assert.equal(ALL.filter((f) => f.startsWith('shared-data/')).some((f) => f.endsWith('.md') && f !== 'shared-data/README.md'), false, 'shared-data holds no library documents');
});

test('variant scene, archived scene and archived planner record are all present', () => {
  const variants = byKind('scene').filter((d) => d.fm.variant_of);
  assert.equal(variants.length, 1);
  const base = byKind('scene').find((d) => d.fm.id === variants[0].fm.variant_of);
  assert.ok(base && !base.archived, 'variant_of names a live scene');
  const archivedScene = byKind('scene').filter((d) => d.archived);
  assert.equal(archivedScene.length, 1);
  assert.match(archivedScene[0].rel, /\/archive\/manuscript\//);
  const planner = new Set(['link', 'scene-plan', 'story-plan', 'arc', 'structure', 'relationship', 'synopsis', 'clue', 'thread', 'event', 'task']);
  assert.ok(DOCS.some((d) => d.archived && planner.has(d.kind)), 'an archived planner record under archive/');
});

test('a record with an x-* field and a record with an unknown field', () => {
  const withX = DOCS.filter((d) => Object.keys(d.fm).some((k) => k.startsWith('x-')));
  assert.ok(withX.length >= 2);
  const unknown = DOCS.filter((d) => KINDS[d.kind] && Object.keys(d.fm).some((k) => !k.startsWith('x-') && k !== 'schema' && k !== 'id' && !(k in KINDS[d.kind].fields)));
  assert.ok(unknown.length >= 1);
});

// ---- (c) the manifest matches the files -----------------------------------------------------------------------------------------------------

test('counts.documents and counts.archived_documents match the files, kind by kind', () => {
  assert.deepEqual(sortedKeys(expected.counts.documents), tally(DOCS.map((d) => d.kind)));
  assert.deepEqual(sortedKeys(expected.counts.archived_documents), tally(DOCS.filter((d) => d.archived).map((d) => d.kind)));
  assert.equal(expected.counts.variant_scenes, byKind('scene').filter((d) => d.fm.variant_of).length);
});

test('import_metadata lists exactly the front-matter fields the format has no column for (x-* and unknown)', () => {
  const actual = {};
  for (const d of DOCS) {
    if (!KINDS[d.kind]) continue;
    const unknown = Object.keys(d.fm).filter((k) => k !== 'schema' && k !== 'id' && !(k in KINDS[d.kind].fields)).sort();
    if (unknown.length) actual[d.fm.id] = unknown;
  }
  assert.deepEqual(expected.import_metadata, actual);
  assert.ok(Object.values(actual).flat().some((k) => k.startsWith('x-')));
  assert.ok(Object.values(actual).flat().some((k) => !k.startsWith('x-')));
});

test('scene_order: ordered ids per book match validate() and the front matter (act, chapter, sequence), variants and archived excluded', () => {
  for (const book of expected.books) {
    const want = expected.scene_order[book.id];
    const fromValidator = result.books.find((b) => b.id === book.id).order.map((s) => s.id);
    assert.deepEqual(fromValidator, want, `validate() order of ${book.slug}`);
    const fromFiles = DOCS.filter((d) => d.kind === 'scene' && d.bookPath === book.path && !d.archived && !d.fm.variant_of)
      .sort((a, b) => a.fm.act - b.fm.act || a.fm.chapter - b.fm.chapter || a.fm.sequence - b.fm.sequence)
      .map((d) => d.fm.id);
    assert.deepEqual(fromFiles, want, `file order of ${book.slug}`);
  }
  const ordered = new Set(Object.values(expected.scene_order).flat());
  for (const id of [...expected.excluded_scenes.variant, ...expected.excluded_scenes.archived]) assert.ok(!ordered.has(id), `${id} must not be in an order`);
  assert.deepEqual(expected.excluded_scenes.variant, byKind('scene').filter((d) => d.fm.variant_of).map((d) => d.fm.id));
  assert.deepEqual(expected.excluded_scenes.archived, byKind('scene').filter((d) => d.archived).map((d) => d.fm.id));
});

test('field_mappings: 5 to 10 examples, each names a real record, a real front-matter field and a table.column target', () => {
  assert.ok(expected.field_mappings.length >= 5 && expected.field_mappings.length <= 10);
  for (const m of expected.field_mappings) {
    const doc = DOCS.find((d) => d.rel === m.source);
    assert.ok(doc, `${m.source} exists`);
    assert.equal(doc.fm.id, m.record_id);
    assert.ok(Object.hasOwn(doc.fm, m.field), `${m.source} has ${m.field}`);
    assert.match(m.target, /^[a-z_]+\.[a-z_]+/, `${m.target} is table.column`);
  }
  assert.ok(new Set(expected.field_mappings.map((m) => m.target.split('.')[0])).size >= 4, 'examples span several tables');
});

// ---- prose constructs (H0 section 5 / 6) ------------------------------------------------------------------------------------------------------

const PROSE = DOCS.filter((d) => d.kind === 'scene').map((d) => d.body).join('\n');
const CONSTRUCTS = {
  'author note': /<!--\s*note:/,
  'sf:anchor pair': /<!-- sf:anchor id=\S+ -->[\s\S]*?<!-- \/sf:anchor -->/,
  '[[slug]]': /\[\[[a-z0-9][a-z0-9-]*\]\]/,
  '[[slug|label]]': /\[\[[^\]|:]+\|[^\]]+\]\]/,
  'cross-book link': /\[\[[a-z0-9-]+:[a-z0-9-]+(\|[^\]]+)?\]\]/,
  '[@cite]': /\[@[^\]\s]+\]/,
  'Markdown link': /(?<!!)\[[^\]\n^]+\]\([^)\n]+\)/,
  image: /!\[[^\]\n]*\]\([^)\n]+\)/,
  footnote: /\[\^[^\]\n]+\][^:]/,
  'footnote definition': /^\[\^[^\]\n]+\]:/m,
  'fenced code block': /^```[a-z]*\n[\s\S]*?\n```$/m,
  table: /^\|.+\|\n\|[-: |]+\|\n\|.+\|/m,
  'scene break': /^\* \* \*$/m,
  'emphasis (strong)': /\*\*(?=\S)[^*\n]+\*\*/,
  'emphasis (italic)': /(?<![*\w])\*(?=\S)[^*\n]*\S\*(?![*\w])/,
};
for (const [name, re] of Object.entries(CONSTRUCTS)) {
  test(`prose construct: ${name}`, () => {
    assert.match(PROSE, re);
  });
}

test('prose construct: the cross-book link resolves into the other book of the series', () => {
  const m = /\[\[([a-z0-9-]+):([a-z0-9-]+)(?:\|[^\]]+)?\]\]/.exec(PROSE);
  const [, bookSlug, target] = m;
  const other = expected.books.find((b) => b.slug === bookSlug);
  assert.ok(other, `${bookSlug} is a book of the fixture`);
  assert.ok(DOCS.some((d) => d.bookPath === other.path && d.fm.slug === target), `${target} exists in ${bookSlug}`);
  assert.equal(result.diagnostics.some((d) => ['E303', 'I402'].includes(d.code)), false);
});

test('raw_import_constructs: each named record contains each construct that will become rawImport', () => {
  const RAW = {
    fenced_code: CONSTRUCTS['fenced code block'],
    table: CONSTRUCTS.table,
    image: CONSTRUCTS.image,
    footnote: CONSTRUCTS['footnote definition'],
  };
  const named = new Set(Object.values(expected.raw_import_constructs).flat());
  assert.deepEqual([...named].sort(), Object.keys(RAW).sort(), 'fenced code, table, image and footnote are all covered');
  for (const [id, constructs] of Object.entries(expected.raw_import_constructs)) {
    const doc = DOCS.find((d) => d.fm.id === id);
    assert.ok(doc && doc.kind === 'scene', `${id} is a scene`);
    for (const c of constructs) assert.match(doc.body, RAW[c], `${id} has ${c}`);
  }
  // and nothing else in the fixture carries one of the four that the manifest does not list
  for (const [c, re] of Object.entries(RAW)) {
    const holders = DOCS.filter((d) => d.kind === 'scene' && re.test(d.body)).map((d) => d.fm.id).sort();
    const listed = Object.entries(expected.raw_import_constructs).filter(([, v]) => v.includes(c)).map(([id]) => id).sort();
    assert.deepEqual(holders, listed, `scenes with ${c}`);
  }
});

test('the image the prose names exists in the book', () => {
  const doc = byKind('scene').find((d) => /!\[[^\]]*\]\(/.test(d.body));
  const target = /!\[[^\]]*\]\(([^)]+)\)/.exec(doc.body)[1];
  assert.ok(fs.existsSync(path.join(ROOT, path.posix.normalize(path.posix.join(path.posix.dirname(doc.rel), target)))));
});

// ---- records that are not plain documents ---------------------------------------------------------------------------------------------

test('comment with two replies, pending suggestion', () => {
  const [comment] = byKind('comment');
  const replies = comment.body.split('\n').filter((l) => /^## Reply — .+ — \d{4}-\d{2}-\d{2}T\S+$/.test(l));
  assert.equal(replies.length, expected.counts.comment_replies);
  assert.equal(replies.length, 2);
  assert.match(comment.rel, /\/comments\/\d{4}\/\d{8}-\d{6}-[a-z0-9-]+\.md$/);
  assert.equal(comment.fm.status, 'open');
  const target = DOCS.find((d) => d.fm.id === comment.fm.target);
  assert.ok(target && target.kind === 'scene', 'the comment targets a scene');
  const [suggestion] = byKind('suggestion');
  assert.equal(suggestion.fm.status, 'pending');
  assert.ok(suggestion.fm.hunks.length >= 1 && suggestion.fm.hunks.every((h) => h.status === 'pending'));
});

test('receipt chain of three: one root, each receipt names the sha256 of its parent file', () => {
  const receipts = byKind('receipt').sort((a, b) => a.fm.at.localeCompare(b.fm.at));
  assert.equal(receipts.length, expected.counts.receipt_chain_length);
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts[0].fm.parents, []);
  for (let i = 1; i < receipts.length; i++) {
    assert.deepEqual(receipts[i].fm.parents.map((p) => p.id), [receipts[i - 1].fm.id]);
    assert.equal(receipts[i].fm.parents[0].sha256, sha256(read(receipts[i - 1].rel)), `receipt ${i + 1} names its parent's bytes`);
  }
  const blobs = ALL.filter((f) => f.includes('/provenance/objects/'));
  assert.equal(blobs.length, expected.counts.other_records.provenance_blobs);
  for (const f of blobs) assert.equal(sha256(fs.readFileSync(path.join(ROOT, f))), path.posix.basename(f), `${f} is named by its hash`);
});

test('canvas with story cards: valid JSON Canvas, every card points at a real record', () => {
  const canvases = LIBRARY_FILES.filter((f) => f.endsWith('.canvas'));
  assert.equal(canvases.length, expected.counts.other_records.canvas);
  const parsed = parseCanvas(read(canvases[0]));
  assert.equal(parsed.ok, true, parsed.message);
  const cards = parsed.canvas.nodes.filter((n) => n.type === 'file' && n.storyforge?.ref);
  assert.equal(cards.length, expected.counts.other_records.canvas_story_cards);
  const ids = new Set(DOCS.map((d) => d.fm.id));
  for (const c of cards) assert.ok(ids.has(c.storyforge.ref), `${c.id} points at ${c.storyforge.ref}`);
  assert.ok(parsed.canvas.nodes.some((n) => n.type === 'group') && parsed.canvas.edges.length >= 1);
});

test('activity: writing log, sessions and goals', () => {
  const log = byKind('doc').find((d) => d.rel.endsWith('activity/writing-log.md'));
  const sessions = byKind('doc').find((d) => /activity\/sessions\/\d{4}\/\d{4}-\d{2}\.md$/.test(d.rel));
  const [goals] = byKind('goals');
  assert.equal(log.body.split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l)).length, expected.counts.other_records.writing_log_rows);
  assert.equal(sessions.body.split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2}T/.test(l)).length, expected.counts.other_records.session_rows);
  assert.equal(goals.fm.goals.length, expected.counts.other_records.goal_items);
  assert.ok(goals.fm.goals.length >= 1 && sessions && log);
});

test('assets: the files the manifest counts, and the asset note names a file whose hash it records', () => {
  const assets = LIBRARY_FILES.filter((f) => f.includes('/assets/') && f.endsWith('.png'));
  assert.equal(assets.length, expected.counts.other_records.asset_files);
  const [note] = byKind('asset-note');
  const file = path.posix.join(path.posix.dirname(note.rel), note.fm.asset);
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, file))), note.fm.sha256);
  const book = byKind('book').find((d) => d.fm.cover);
  assert.ok(fs.existsSync(path.join(ROOT, path.posix.dirname(book.rel), book.fm.cover)), 'the cover file exists');
});

// ---- restore points ---------------------------------------------------------------------------------------------------------------------

test('restore_points: six revisions of one scene in the source, four to keep (the newest four)', () => {
  const [[sceneId, want]] = Object.entries(expected.restore_points);
  assert.equal(want.in_source, 6);
  assert.equal(want.kept, 4);
  const dir = `saltmarsh/salt-orchard/.storyforge/revisions/${sceneId}`;
  assert.ok(DOCS.some((d) => d.fm.id === sceneId && d.kind === 'scene'), 'the revisions belong to a real scene');
  const index = JSON.parse(read(`${dir}/index.json`));
  assert.equal(index.length, want.in_source);
  const onDisk = ALL.filter((f) => f.startsWith(`${dir}/`) && f !== `${dir}/index.json`).map((f) => path.posix.basename(f)).sort();
  assert.equal(onDisk.length, expected.counts.other_records.revision_files);
  assert.deepEqual(index.map((e) => e.file).sort(), onDisk);
  for (const e of index) {
    assert.match(e.file, /^\d{8}T\d{6}Z-[a-z]{1,20}\.md$/);
    assert.equal(sha256(fs.readFileSync(path.join(ROOT, dir, e.file))), e.sha256, `${e.file} matches its index entry`);
    assert.equal(e.file.slice(0, 16), e.at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'), `${e.file} is named by its time`);
  }
  assert.equal(new Set(index.map((e) => e.at)).size, 6, 'six distinct times, so "newest 4" is unambiguous');
  const newest = [...index].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, want.kept).map((e) => e.file).sort();
  assert.deepEqual(want.kept_files, newest);
});

// ---- shared-data ----------------------------------------------------------------------------------------------------------------------------

/** null when the chain is intact, else why not. Mirrors the rule of packages/shared audit.mjs: prev = sha256 of the previous line's exact text. */
function auditProblem(text, head) {
  if (!text.endsWith('\n')) return 'last line is incomplete';
  const lines = text.slice(0, -1).split('\n');
  let prev = '0'.repeat(64);
  for (const [i, line] of lines.entries()) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return `line ${i + 1} is not JSON`;
    }
    if (rec.seq !== i + 1) return `line ${i + 1} is out of sequence`;
    if (rec.prev !== prev) return `line ${i + 1} does not chain from line ${i}`;
    prev = sha256(line);
  }
  if (head.seq !== lines.length || head.hash !== prev) return 'audit-head.json does not name the last line';
  return null;
}

test('shared-data: audit.jsonl is a valid hash chain and audit-head.json names its last line', () => {
  const text = fs.readFileSync(path.join(SHARED, 'audit.jsonl'), 'utf8');
  const head = sharedJson('audit-head.json');
  assert.equal(auditProblem(text, head), null);
  assert.equal(text.split('\n').filter(Boolean).length, expected.counts.shared_data.audit_event);
  assert.ok(expected.counts.shared_data.audit_event >= 2, 'a chain of one proves nothing');
});

test('shared-data: the chain check itself notices an edited, removed or reordered line', () => {
  const text = fs.readFileSync(path.join(SHARED, 'audit.jsonl'), 'utf8');
  const head = sharedJson('audit-head.json');
  const lines = text.slice(0, -1).split('\n');
  const edited = [...lines];
  edited[1] = edited[1].replace('"event":"', '"event":"x');
  assert.notEqual(auditProblem(`${edited.join('\n')}\n`, head), null, 'edited line');
  assert.notEqual(auditProblem(`${[lines[0], ...lines.slice(2)].join('\n')}\n`, head), null, 'removed line');
  assert.notEqual(auditProblem(`${[lines[1], lines[0], ...lines.slice(2)].join('\n')}\n`, head), null, 'reordered lines');
  assert.notEqual(auditProblem(`${lines.slice(0, -1).join('\n')}\n`, head), null, 'truncated tail');
});

test('shared-data: roles, a book-scoped member, an open and a used invite, a share link, OAuth, plugin token, webhook; counts match', () => {
  const users = sharedJson('users.json').users;
  const members = sharedJson('members.json').members;
  const invites = sharedJson('invites.json').invites;
  const shares = sharedJson('shares.json').shares;
  const oauth = sharedJson('oauth.json');
  const plugin = sharedJson('plugin-tokens.json').tokens;
  const hooks = sharedJson('webhooks.json').webhooks;
  const sessions = Object.keys(sharedJson('sessions.json').sessions);
  const setup = sharedJson('setup.json').setup;
  const c = expected.counts.shared_data;

  assert.deepEqual([users.length, members.length, sessions.length, invites.length, shares.length, plugin.length, oauth.clients.length, oauth.tokens.length, hooks.length, setup === null ? 0 : 1],
    [c.user, c.member, c.session, c.invite, c.share_link, c.plugin_token, c.oauth_client, c.oauth_token, c.webhook, c.setup_token]);
  assert.equal(sharedJson('settings.json').version, 1);

  const roles = members.map((m) => m.role);
  for (const role of ['owner', 'editor', 'reviewer', 'viewer']) assert.ok(roles.includes(role), `a ${role}`);
  const scoped = members.filter((m) => m.books && Object.keys(m.books).length > 0);
  assert.equal(scoped.length, c.book_scoped_member);
  const bookIds = new Set(byKind('book').map((d) => d.fm.id));
  for (const m of scoped) for (const id of Object.keys(m.books)) assert.ok(bookIds.has(id), `${id} is a book of the fixture`);
  const userIds = new Set(users.map((u) => u.id));
  for (const m of members) assert.ok(userIds.has(m.user));
  assert.equal(members.find((m) => m.role === 'owner').books, undefined, 'an owner has no book list');

  assert.equal(invites.filter((i) => i.used === null).length, c.invite_open);
  assert.equal(invites.filter((i) => i.used !== null).length, c.invite_used);
  assert.ok(invites.filter((i) => i.used !== null).every((i) => userIds.has(i.used)));
  for (const s of shares) assert.ok(bookIds.has(s.book));

  const grantIds = new Set(plugin.map((t) => t.id));
  assert.ok(oauth.tokens.every((t) => grantIds.has(t.grant) && oauth.clients.some((cl) => cl.id === t.client)), 'OAuth tokens point at a client and a plugin grant');
  assert.ok(oauth.tokens.some((t) => t.kind === 'access') && oauth.tokens.some((t) => t.kind === 'refresh'));
});

test('shared-data: only hashes and fake password records, never a raw secret', () => {
  const hashes = [
    ...invitesAndShares().map((r) => r.token_hash),
    ...sharedJson('plugin-tokens.json').tokens.map((t) => t.token_hash),
    ...sharedJson('oauth.json').tokens.map((t) => t.hash),
    ...sharedJson('webhooks.json').webhooks.map((w) => w.secret_hash),
    ...Object.keys(sharedJson('sessions.json').sessions),
  ];
  assert.ok(hashes.length >= 6);
  for (const h of hashes) assert.match(h, HEX64);
  for (const u of sharedJson('users.json').users) {
    assert.equal(u.pw.alg, 'scrypt');
    assert.equal(Buffer.from(u.pw.hash, 'base64url').length, 32);
  }
  for (const w of sharedJson('webhooks.json').webhooks) assert.equal(w.secret, undefined, 'no signing secret on disk');
  const everything = fs.readdirSync(SHARED).map((f) => fs.readFileSync(path.join(SHARED, f), 'utf8')).join('\n');
  assert.doesNotMatch(everything, /sfat_|sfrt_|sfcs_|-----BEGIN/, 'no raw token or key material');
});
function invitesAndShares() {
  return [...sharedJson('invites.json').invites, ...sharedJson('shares.json').shares];
}

// ---- the manifest itself -------------------------------------------------------------------------------------------------------------------

test('expected-import.json has every section H0 section 6 asks for', () => {
  for (const key of ['counts', 'scene_order', 'field_mappings', 'import_metadata', 'expected_findings', 'raw_import_constructs', 'restore_points']) {
    assert.ok(expected[key] !== undefined, `${key} present`);
  }
  assert.ok(expected.counts.documents && expected.counts.shared_data && expected.counts.other_records);
});
