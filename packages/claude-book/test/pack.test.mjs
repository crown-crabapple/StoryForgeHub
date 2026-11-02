// M05-J05 acceptance 5.1: valid context pack for salt-orchard chapter 2.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyFixture, makeFramework, run, read, exists, abs, readTree, parseConcatenatedJson,
  jsType, shapeFor, typeMatches, SHAPES,
} from './helpers.mjs';

const WORK = '.work/salt-orchard';
let book;
let fw;
let result;

before(() => {
  book = copyFixture('salt-orchard');
  fw = makeFramework();
  result = run('context', { book, fw, chapter: 2 });
});

const ctx = (rel) => read(fw, `${WORK}/context/${rel}`);
const json = (rel) => parseConcatenatedJson(ctx(rel));

test('context --chapter 2 exits 0', () => {
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('every file listed in the contract exists', () => {
  const files = [
    'book.md', 'style.md', 'structure.md', 'synopsis.md', 'plan.md',
    'previous-chapter.md', 'previous-scene.md', 'entries-index.md', 'ledger.md', 'state-events.md',
    'state/current/characters.md', 'state/current/inventory.md',
    'state/current/knowledge.md', 'state/current/situation.md',
    'timeline/history.md', 'timeline/current-chapter.md', 'continuity-check.md',
  ];
  for (const f of files) assert.ok(exists(fw, `${WORK}/context/${f}`), `missing context/${f}`);
  assert.ok(exists(fw, `${WORK}/candidate/chapter-02-candidate.md`), 'missing candidate/chapter-02-candidate.md');
  assert.ok(exists(fw, `${WORK}/adapter-manifest.json`), 'missing adapter-manifest.json');
});

test('relevant entries get a file in their plural folder; irrelevant ones do not', () => {
  const want = [
    'characters/maren-hollis.md', 'characters/tobin-reyes.md', 'characters/pell.md',
    'locations/port-aldine.md', 'locations/salt-orchard.md',
    'factions/harbour-board.md', 'objects/ferry-bell.md', 'objects/grafting-knife.md', 'lore/saltmarks.md',
  ];
  for (const f of want) assert.ok(exists(fw, `${WORK}/context/${f}`), `missing context/${f}`);
  assert.ok(!exists(fw, `${WORK}/context/characters/ilse-hollis.md`), 'ilse-hollis is not in chapter 2');
});

test('entry file layout: heading, labelled bullets, related, body', () => {
  const t = ctx('characters/maren-hollis.md');
  assert.match(t, /^# Maren Hollis$/m);
  assert.match(t, /^- \*\*Slug:\*\* maren-hollis$/m);
  assert.match(t, /^- \*\*Status:\*\* canon$/m);
  assert.match(t, /^- \*\*Type:\*\* /m);
  assert.match(t, /^- \*\*Eyes:\*\* Grey$/m);
  assert.match(t, /^- \*\*Age:\*\* 34$/m);
  const related = t.split('\n').find((l) => l.startsWith('- **Related:**'));
  assert.ok(related, 'no Related line');
  assert.match(related, /\[\[ilse-hollis\]\]/);
  assert.match(related, /\[\[tobin-reyes\]\]/);
  assert.ok(t.indexOf('Cartographer who maps coastlines') > t.indexOf('# Maren Hollis'));
});

test('book.md renders front matter as field lines plus the body', () => {
  const t = ctx('book.md');
  assert.match(t, /^- \*\*Title:\*\* The Salt Orchard$/m);
  assert.match(t, /^- \*\*Slug:\*\* salt-orchard$/mi);
  assert.ok(t.includes('A cartographer comes home to sell a drowned orchard'));
});

test('planning docs: plan.md carries the doc, missing ones carry the placeholder', () => {
  assert.ok(ctx('plan.md').includes('Act one: arrival and the key.'));
  for (const f of ['style.md', 'structure.md', 'synopsis.md']) {
    assert.ok(ctx(f).includes('_Not provided in the StoryForge project._'), f);
  }
});

test('previous-chapter.md: chapter 1 scenes in order, comments stripped, links become names', () => {
  const t = ctx('previous-chapter.md');
  assert.ok(t.includes('The ferry nudged the jetty'));
  assert.ok(t.includes('The key was colder than the morning.'));
  assert.ok(!t.includes('<!--'), 'comments must be stripped');
  assert.ok(!t.includes('[['), 'links must be replaced by names');
  assert.ok(t.includes('the ferryman threw her bag ashore'), 'aliased link keeps its label');
  assert.ok(t.includes('\n\n---\n\n'), 'scenes joined by a rule');
  assert.ok(t.indexOf('The ferry nudged') < t.indexOf('The key was colder'));
  assert.ok(!t.includes('Tobin ran the ferry'), 'chapter 2 text must not leak into previous chapter');
});

test('previous-scene.md is the last scene before the target chapter', () => {
  const t = ctx('previous-scene.md');
  assert.ok(t.includes('The key was colder than the morning.'));
  assert.ok(!t.includes('The ferry nudged the jetty'));
  assert.ok(!t.includes('Tobin ran the ferry'));
});

test('candidate is the target chapter, comments stripped, scenes joined by a rule', () => {
  const t = read(fw, `${WORK}/candidate/chapter-02-candidate.md`);
  assert.ok(t.includes('Tobin ran the ferry twice a day'));
  assert.ok(t.includes('Pell handed over the'));
  assert.ok(!t.includes('<!--'));
  assert.ok(t.includes('\n\n---\n\n'));
  assert.ok(t.indexOf('Tobin ran') < t.indexOf('Pell handed'));
  assert.ok(!t.includes('The ferry nudged the jetty'));
});

test('entries-index.md lists every non-archived entry with the documented keys', () => {
  const rows = json('entries-index.md');
  const slugs = fs.readdirSync(abs(book, 'codex'), { recursive: true })
    .filter((f) => f.endsWith('.md') && !f.includes('_types'))
    .map((f) => path.basename(f, '.md'))
    .sort();
  assert.equal(slugs.length, 10);
  assert.deepEqual(rows.map((r) => r.slug).sort(), slugs);
  const maren = rows.find((r) => r.slug === 'maren-hollis');
  assert.deepEqual(maren, {
    db: 'characters', slug: 'maren-hollis', name: 'Maren Hollis', status: 'canon', type: 'Character', detail: 'Protagonist',
  });
  const orchard = rows.find((r) => r.slug === 'salt-orchard');
  assert.equal(orchard.db, 'locations');
  assert.equal(orchard.type, 'Location');
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['db', 'detail', 'name', 'slug', 'status', 'type']);
});

test('ledger.md has brass-key, status and chapters mapped per contract', () => {
  const rows = json('ledger.md');
  const key = rows.find((r) => r.slug === 'brass-key');
  assert.ok(key, 'brass-key missing from ledger.md');
  assert.equal(key.title, 'The brass key');
  assert.equal(key.kind, 'mystery');
  assert.equal(key.status, 'paid-off');
  assert.equal(key.planted_in, '1');
  assert.equal(typeof key.payoff_in, 'string');
  assert.ok(key.payoff_in !== '');
  assert.ok(key.characters.includes('maren-hollis') && key.characters.includes('ilse-hollis'));
  assert.equal(key.notes, 'What the key opens, and why Ilse left it where Maren would find it.');
  const mtime = fs.statSync(abs(book, 'planning/threads/brass-key.md')).mtimeMs;
  assert.equal(new Date(key.updated_at).getTime(), Math.floor(mtime));
});

test('JSON context files parse as concatenated objects whose keys and types match the shapes file', () => {
  assert.ok(fs.existsSync(SHAPES), 'shapes/kethra-context-shapes.json missing');
  const shapes = JSON.parse(fs.readFileSync(SHAPES, 'utf8'));
  const files = ['entries-index.md', 'ledger.md', 'state-events.md'];
  const knowledge = path.join(fw, ...`${WORK}/context/knowledge`.split('/'));
  if (fs.existsSync(knowledge)) for (const f of fs.readdirSync(knowledge)) files.push(`knowledge/${f}`);
  let described = 0;
  for (const f of files) {
    const shape = shapeFor(shapes, f);
    const rows = json(f);
    if (!shape) {
      assert.ok(f !== 'entries-index.md' && f !== 'ledger.md', `shapes file does not describe ${f}`);
      continue;
    }
    described++;
    for (const row of rows) {
      const required = [...shape.keys.keys()].filter((k) => !shape.optional.has(k)).sort();
      const have = Object.keys(row);
      assert.deepEqual(have.filter((k) => required.includes(k)).sort(), required, `${f}: required keys`);
      assert.deepEqual(have.filter((k) => !shape.keys.has(k)), [], `${f}: keys not in the schema`);
      for (const [k, v] of Object.entries(row)) {
        assert.ok(typeMatches(jsType(v), shape.keys.get(k)), `${f}: ${k} is ${jsType(v)}, schema says ${shape.keys.get(k)}`);
      }
    }
  }
  assert.ok(described >= 2);
});

test('timeline split: history is before chapter 2 in story time, current is chapter 2', () => {
  const h = ctx('timeline/history.md');
  const c = ctx('timeline/current-chapter.md');
  assert.match(h, /^## .+ — The spring flood$/m);
  assert.match(h, /^## .+ — The key is found$/m);
  assert.ok(h.indexOf('The spring flood') < h.indexOf('The key is found'), 'story-time order');
  assert.ok(!h.includes('The wall falls'));
  assert.ok(!h.includes('The first grafting'));
  assert.match(c, /^## .+ — The first grafting$/m);
  assert.ok(!c.includes('The spring flood'));
  assert.ok(!c.includes('The wall falls'));
});

test('continuity-check.md reports the Maren eyes CF1 with both file:line sources', () => {
  const t = ctx('continuity-check.md');
  assert.match(t, /^# Continuity check - chapter 02 candidate/m);
  assert.ok(t.includes('Maren Hollis'));
  assert.match(t, /Eyes/);
  assert.match(t, /codex\/characters\/maren-hollis\.md:13/);
  assert.match(t, /manuscript\/act-01-low-water\/ch-001-the-drowned-rows\/0010-arrival\.md:17/);
});

test('manifest lists generated files and sources with sha256', () => {
  const m = JSON.parse(read(fw, `${WORK}/adapter-manifest.json`));
  assert.equal(m.adapter_version, 1);
  assert.equal(m.book_id, 'book_01S5000000000000000000000A');
  assert.equal(m.chapter, 2);
  assert.ok(Array.isArray(m.generated) && m.generated.length > 10);
  assert.ok(m.sources.length > 5);
  for (const s of m.sources) assert.match(s.sha256, /^[0-9a-f]{64}$/);
  assert.ok(m.sources.some((s) => String(s.path).replace(/\\/g, '/').endsWith('codex/characters/maren-hollis.md')));
});

test('deterministic: a second run over the same book gives identical bytes', () => {
  const before = readTree(path.join(fw, ...WORK.split('/')));
  const r = run('context', { book, fw, chapter: 2 });
  assert.equal(r.status, 0, r.stderr);
  const after = readTree(path.join(fw, ...WORK.split('/')));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [k, buf] of before) assert.ok(buf.equals(after.get(k)), `${k} differs between runs`);
});

test('a second run replaces context/ entirely (stale files do not survive)', () => {
  const stale = `${WORK}/context/characters/stale-entry.md`;
  const f = abs(fw, stale);
  fs.writeFileSync(f, 'stale');
  const r = run('context', { book, fw, chapter: 2 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(f));
});
