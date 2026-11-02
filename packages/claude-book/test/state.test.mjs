// M05-J05 acceptance 5.5: state derivation on continuity-cases (event `state` -> state-events, knowledge, state/current).
// The fixture's events are unplaced, so the copy pins the ones under test to scenes (chapter 1 or 2) and
// one deliberately to chapter 3, which must NOT show up when building the pack for chapter 3.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixture, makeFramework, run, read, put, exists, parseConcatenatedJson } from './helpers.mjs';

const CH1 = 'scene_01C7000000000000000000000F'; // Lamp Room (ch 1)
const CH1B = 'scene_01C7000000000000000000000G'; // The Dock (ch 1)
const CH2 = 'scene_01C7000000000000000000000H'; // Tide Office (ch 2)
const CH3 = 'scene_01C7000000000000000000000K'; // The Last Light (ch 3)

const PLACE = {
  'cleo-dies': CH1,
  'ana-tower': CH1,
  'ana-stall': CH2, // later in story time than ana-tower
  'bell-a': CH1B,
  'ana-learns': CH1,
  'ana-knows': CH1B,
  'cleo-reads': CH2,
  'dov-dies': CH3,
};

const WORK = '.work/lantern-ledger';
let fw;

function placeEvents(book) {
  for (const [slug, scene] of Object.entries(PLACE)) {
    const rel = `planning/timeline/${slug}.md`;
    let t = read(book, rel);
    if (slug === 'ana-stall') t = t.replace('order: 300', 'order: 305');
    const next = t.replace(/\norder: (\d+)\n/, `\norder: $1\nscenes: [${scene}]\n`);
    assert.notEqual(next, t, `could not place ${slug}`);
    put(book, rel, next);
  }
}

before(() => {
  const book = copyFixture('continuity-cases');
  placeEvents(book);
  fw = makeFramework();
  const r = run('context', { book, fw, chapter: 3 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

const ctx = (rel) => read(fw, `${WORK}/context/${rel}`);
const events = () => parseConcatenatedJson(ctx('state-events.md'));

/** Lines of `text` under the section whose heading matches `re`, up to the next heading. */
function section(text, re) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && re.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^#{1,6} /.test(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
}

test('state-events.md holds state items before chapter 3 in the documented shape', () => {
  const ev = events();
  for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ['chapter', 'event', 'note', 'slug', 'value']);
  const died = ev.find((e) => e.slug === 'cleo-marsh' && e.event === 'died');
  assert.ok(died, 'cleo died');
  assert.equal(String(died.chapter), '1');
  assert.equal(died.note, 'Cleo is struck down');
  const holder = ev.find((e) => e.slug === 'brass-bell' && e.event === 'holder');
  assert.equal(holder.value, 'cleo-marsh');
  assert.equal(holder.note, 'Cleo rings the bell');
  const locations = ev.filter((e) => e.slug === 'ana-voss' && e.event === 'location');
  assert.deepEqual(locations.map((e) => e.value), ['lighthouse', 'market'], 'story-time order');
  assert.deepEqual(locations.map((e) => String(e.chapter)), ['1', '2']);
});

test('state-events.md excludes learns/knows and events from chapter 3 on', () => {
  const ev = events();
  assert.ok(!ev.some((e) => e.event === 'learns' || e.event === 'knows'));
  assert.ok(!ev.some((e) => e.slug === 'dov-ellis'), 'dov dies in chapter 3, not before it');
});

test('knowledge/<slug>.md carries the learns facts for each relevant character', () => {
  const ana = JSON.parse(ctx('knowledge/ana-voss.md'));
  assert.equal(ana.ok, true);
  assert.ok(['ana-voss', 'Ana Voss'].includes(ana.character), `character: ${ana.character}`);
  assert.equal(String(ana.at), '2');
  assert.equal(ana.facts.length, 1, 'knows events do not add facts');
  assert.equal(ana.facts[0].fact, 'moon-phase');
  assert.equal(ana.facts[0].knows, 'moon phase');
  assert.equal(String(ana.facts[0].learned_in), '1');

  const cleo = JSON.parse(ctx('knowledge/cleo-marsh.md'));
  assert.equal(cleo.ok, true);
  assert.equal(String(cleo.at), '2');
  assert.deepEqual(cleo.facts.map((f) => [f.fact, f.knows, String(f.learned_in)]), [['tide-times', 'tide times', '2']]);
});

test('knowledge files exist only for characters, not for objects or locations', () => {
  const dir = path.join(fw, ...`${WORK}/context/knowledge`.split('/'));
  for (const f of fs.readdirSync(dir)) {
    assert.ok(['ana-voss.md', 'cleo-marsh.md', 'dov-ellis.md', 'bram-keel.md'].includes(f), f);
  }
});

test('state/current/characters.md: Cleo is dead, Ana is alive and at the market', () => {
  const t = ctx('state/current/characters.md');
  const lines = t.split('\n');
  const cleo = lines.find((l) => /cleo/i.test(l) && /^\s*[-*]/.test(l));
  assert.ok(cleo, 'a bullet about Cleo');
  const dead = section(t, /dead/i);
  assert.ok((dead && /cleo/i.test(dead)) || /dead|died/i.test(cleo), 'Cleo listed as dead');
  const ana = lines.filter((l) => /ana/i.test(l) && /^\s*[-*]/.test(l)).join('\n');
  assert.ok(/market/i.test(ana), 'Ana is at the market (latest location)');
  assert.ok(!/lighthouse/i.test(ana), 'the earlier location is superseded');
  assert.ok(!(dead && /ana/i.test(dead)), 'Ana is not dead');
  assert.ok(!/dov/i.test(dead ?? ''), 'Dov dies later than chapter 2');
});

test('state/current/inventory.md: Cleo holds the brass bell', () => {
  const t = ctx('state/current/inventory.md');
  const line = t.split('\n').find((l) => /brass[- ]bell/i.test(l));
  assert.ok(line, 'brass bell listed');
  assert.match(line, /cleo/i);
});

test('state/current/knowledge.md: per character facts', () => {
  const t = ctx('state/current/knowledge.md');
  assert.match(t, /ana/i);
  assert.match(t, /moon phase|moon-phase/i);
  assert.match(t, /cleo/i);
  assert.match(t, /tide times|tide-times/i);
});

test('state/current/situation.md: derived header and at most the last five events', () => {
  const t = ctx('state/current/situation.md');
  assert.ok(t.includes('_Derived from StoryForge events up to chapter 2._'));
  const bullets = t.split('\n').filter((l) => /^\s*-\s/.test(l));
  assert.ok(bullets.length >= 1 && bullets.length <= 5, `${bullets.length} bullets`);
  assert.ok(bullets.some((l) => l.includes('Cleo rings the bell')), 'latest event is listed');
  assert.ok(!t.includes('Dov dies'));
});

test('templates headings are preserved in the derived state files', () => {
  assert.match(ctx('state/current/characters.md'), /^## Dead/m);
  assert.match(ctx('state/current/inventory.md'), /^## Holders/m);
  assert.ok(exists(fw, `${WORK}/context/state/current/situation.md`));
});
