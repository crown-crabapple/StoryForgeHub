// Fixture generator for packages/format/fixtures. NOT a test.
//
// The committed fixtures are the source of truth; this script only exists so
// the ~35 near-identical minimal books stay consistent. It does nothing unless
// run explicitly:  node test/build-fixtures.mjs --write
// (`node --test` also executes every file under test/, hence the guard.)
//
// It regenerates fixtures/invalid/*, fixtures/valid/salt-orchard,
// fixtures/valid/library and fixtures/valid/spec-example/expected.json.
// It never touches the byte-copied spec example itself.
// All text is synthetic. IDs are deterministic (counter based), no randomness.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--write')) {
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');

// suggestion documents (M05-J06) are built with the same package the app uses, so the fixtures cannot drift from it
const { buildSuggestion } = await import('../../suggestions/src/index.mjs');

// ---------------------------------------------------------------- ids
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, no I L O U
function ulid(tag, n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 22; i++) {
    s = ALPHA[x % 32] + s;
    x = Math.floor(x / 32);
  }
  return `01${tag}${s}`;
}
function mkIds(tag) {
  let n = 0;
  return (prefix) => `${prefix}_${ulid(tag, ++n)}`;
}
const ID_RE = /^(lib|series|book|act|chap|scene|entry|thread|event|note|rcpt)_[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------------------------------------------------------------- rendering
function fmLines(obj) {
  const out = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) out.push(`${k}: [${v.join(', ')}]`);
    else if (v && typeof v === 'object' && v.block) out.push(`${k}:`, ...v.block);
    else out.push(`${k}: ${v}`);
  }
  out.push('---');
  return out;
}
function render(entry) {
  if (typeof entry === 'string' || Buffer.isBuffer(entry)) return entry;
  let text = fmLines(entry.fm).join('\n') + '\n' + (entry.body ?? '');
  if (entry.crlf) text = text.replace(/\n/g, '\r\n');
  if (entry.bom) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return text;
}
function lineOf(files, rel, needle) {
  const text = render(files.get(rel)).toString();
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`needle ${needle} not in ${rel}`);
  return `line ${i + 1}`;
}
function writeTree(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, entry] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, render(entry));
  }
}
function checkIds(files) {
  for (const [rel, entry] of files) {
    if (typeof entry === 'string' || Buffer.isBuffer(entry)) continue;
    for (const k of ['id', 'first_appearance', 'variant_of']) {
      const v = entry.fm[k];
      if (typeof v === 'string' && /^[a-z]+_/.test(v) && !ID_RE.test(v)) {
        if (!entry.allowBadId) throw new Error(`bad id ${v} in ${rel}`);
      }
    }
  }
}

// ---------------------------------------------------------------- minimal book
const ACT1 = 'manuscript/act-01-one/';
const CH1 = `${ACT1}ch-001-one/`;

function sceneFm(ids, o = {}) {
  const fm = {
    schema: 'storyforge.scene/v1',
    id: ids('scene'),
    title: 'Scene',
    act: 1,
    chapter: 1,
    sequence: 10,
    status: 'drafting',
    pov: 'maren-hollis',
  };
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete fm[k];
    else fm[k] = v;
  }
  return fm;
}

/** A minimal valid book: book.md, one act, one chapter, two scenes, one entry. */
function newBook(ids, { prefix = '', slug = 'mini-book', series_number } = {}) {
  const files = new Map();
  const b = {
    files,
    prefix,
    A: `${prefix}${CH1}0010-a.md`,
    B: `${prefix}${CH1}0020-b.md`,
    BOOK: `${prefix}book.md`,
    ENTRY: `${prefix}codex/characters/maren-hollis.md`,
    ids,
  };
  files.set(b.BOOK, {
    fm: {
      schema: 'storyforge.book/v1',
      id: ids('book'),
      slug,
      title: 'Mini Book',
      profile: 'fiction',
      status: 'drafting',
      ...(series_number != null ? { series_number } : {}),
    },
    body: 'A minimal book.\n',
  });
  files.set(b.A, {
    fm: sceneFm(ids, { title: 'First', sequence: 10 }),
    body: 'The tide went out before dawn.\n',
  });
  files.set(b.B, {
    fm: sceneFm(ids, { title: 'Second', sequence: 20 }),
    body: 'Nobody spoke on the ferry.\n',
  });
  files.set(b.ENTRY, {
    fm: {
      schema: 'storyforge.entry/v1',
      id: ids('entry'),
      slug: 'maren-hollis',
      type: 'character',
      name: 'Maren Hollis',
      status: 'canon',
    },
    body: '## Overview\nA cartographer.\n',
  });
  return b;
}
const D = (code, file, location) => ({ code, file, location });
const move = (files, from, to) => {
  files.set(to, files.get(from));
  files.delete(from);
};
function addThread(b, o = {}, where = 'planning/threads/brass-key.md') {
  const p = `${b.prefix}${where}`;
  b.files.set(p, {
    fm: {
      schema: 'storyforge.thread/v1',
      id: b.ids('thread'),
      slug: 'brass-key',
      title: 'The brass key',
      kind: 'mystery',
      status: 'open',
      setup: [],
      payoff: [],
      ...o,
    },
    body: 'What the key opens.\n',
  });
  return p;
}

// ---------------------------------------------------------------- invalid cases
const invalid = {}; // name -> () => { files, expected }
function bookCase(name, fn) {
  invalid[name] = () => {
    const ids = mkIds('CS');
    const b = newBook(ids);
    const expected = fn(b, ids) ?? [];
    return { files: b.files, expected };
  };
}

bookCase('E006-future-schema', (b) => {
  b.files.get(b.B).fm.schema = 'storyforge.scene/v2';
  return [D('E006', b.B, 'schema')];
});

bookCase('E100-bad-yaml', (b) => {
  b.files.set(
    b.B,
    '---\nschema: storyforge.scene/v1\ntitle: [unclosed\nact: 1\n---\nBody.\n',
  );
  return [D('E100', b.B, '')];
});

bookCase('E100-unclosed-fence', (b) => {
  b.files.set(
    b.B,
    '---\nschema: storyforge.scene/v1\nid: ' + b.ids('scene') + '\ntitle: Second\nThe fence never closes.\n',
  );
  return [D('E100', b.B, '')];
});

bookCase('E101-anchor', (b) => {
  const e = b.files.get(b.B);
  e.fm.title = '&t Second';
  e.fm.summary = '*t';
  return [D('E101', b.B, '')];
});

bookCase('E101-tag', (b) => {
  b.files.get(b.B).fm.title = '!!str Second';
  return [D('E101', b.B, '')];
});

bookCase('E102-missing-field', (b) => {
  delete b.files.get(b.B).fm.sequence;
  return [D('E102', b.B, 'sequence')];
});

bookCase('E102-bad-id', (b) => {
  const e = b.files.get(b.B);
  e.allowBadId = true;
  e.fm.id = e.fm.id.slice(0, 15) + 'I' + e.fm.id.slice(16);
  return [D('E102', b.B, 'id')];
});

bookCase('E102-scalar-for-list', (b) => {
  b.files.get(b.B).fm.characters = 'maren-hollis';
  return [D('E102', b.B, 'characters')];
});

bookCase('E102-bad-enum', (b) => {
  b.files.get(b.B).fm.status = 'done';
  return [D('E102', b.B, 'status')];
});

bookCase('E103-path-escape', (b) => {
  b.files.get(b.BOOK).fm.cover = '../outside.jpg';
  return [D('E103', b.BOOK, 'cover')];
});

// ---- M04-J04
bookCase('E102-event-date', (b, ids) => {
  const p = 'planning/timeline/the-flood.md';
  b.files.set(p, {
    fm: { schema: 'storyforge.event/v1', id: ids('event'), slug: 'the-flood', title: 'The flood', order: 100, date: '2024-13-45' },
    body: 'The sea wall fails.\n',
  });
  return [D('E102', p, 'date')];
});

bookCase('E103-absolute-link', (b) => {
  b.files.get(b.B).body = 'See [the chart](/maps/coast.pdf) before the ferry.\n';
  return [D('E103', b.B, lineOf(b.files, b.B, '/maps/coast.pdf'))];
});

bookCase('E301-research-source', (b, ids) => {
  const p = 'research/tide-notes.md';
  b.files.set(p, {
    fm: { schema: 'storyforge.research/v1', id: ids('note'), title: 'Tide notes', sources: ['no-such-source'] },
    body: 'Spring tides run high.\n',
  });
  return [D('E301', p, 'sources[0]')];
});

bookCase('E201-duplicate-id', (b) => {
  b.files.get(b.B).fm.id = b.files.get(b.A).fm.id;
  return [D('E201', b.A, 'id'), D('E201', b.B, 'id')];
});

bookCase('E204-duplicate-sequence', (b) => {
  const e = b.files.get(b.B);
  e.fm.sequence = 10;
  move(b.files, b.B, `${CH1}0010-b.md`);
  return [D('E204', b.A, 'sequence'), D('E204', `${CH1}0010-b.md`, 'sequence')];
});

bookCase('E205-act-mismatch', (b) => {
  const e = b.files.get(b.B);
  e.fm.act = 2;
  const to = 'manuscript/act-02-two/ch-001-one/0020-b.md';
  move(b.files, b.B, to);
  return [D('E205', b.A, 'act'), D('E205', to, 'act')];
});

bookCase('E206-act-decreases', (b, ids) => {
  // chapter 2 in act 2, then chapter 3 back in act 1 (no chapter 1 needed)
  b.files.delete(b.A);
  b.files.delete(b.B);
  const p2 = 'manuscript/act-02-two/ch-002-two/0010-c.md';
  const p3 = 'manuscript/act-01-one/ch-003-three/0010-d.md';
  b.files.set(p2, { fm: sceneFm(ids, { title: 'Two', act: 2, chapter: 2, sequence: 10 }), body: 'Second chapter.\n' });
  b.files.set(p3, { fm: sceneFm(ids, { title: 'Three', act: 1, chapter: 3, sequence: 10 }), body: 'Third chapter.\n' });
  return [D('E206', p3, 'act')];
});

bookCase('E207-duplicate-chapter-md', (b, ids) => {
  const p1 = `${CH1}chapter.md`;
  const p2 = `${ACT1}ch-001-extra/chapter.md`;
  for (const p of [p1, p2]) {
    b.files.set(p, {
      fm: { schema: 'storyforge.chapter/v1', id: ids('chap'), chapter: 1, title: 'Chapter' },
      body: '',
    });
  }
  return [D('E207', p1, 'chapter'), D('E207', p2, 'chapter')];
});

bookCase('E208-duplicate-slug', (b, ids) => {
  const tp = addThread(b);
  const ep = 'codex/objects/brass-key.md';
  b.files.set(ep, {
    fm: {
      schema: 'storyforge.entry/v1',
      id: ids('entry'),
      slug: 'brass-key',
      type: 'object',
      name: 'Brass Key',
      status: 'seed',
    },
    body: '',
  });
  return [D('E208', ep, 'slug'), D('E208', tp, 'slug')];
});

bookCase('E301-broken-body-link', (b) => {
  b.files.get(b.B).body = 'She asked about [[nobody]] twice.\n';
  return [D('E301', b.B, lineOf(b.files, b.B, '[[nobody]]'))];
});

bookCase('E301-broken-reference', (b) => {
  b.files.get(b.B).fm.pov = 'nobody';
  return [D('E301', b.B, 'pov')];
});

bookCase('E301-missing-cite', (b) => {
  b.files.get(b.B).body = 'The tables disagree [@no-such-source].\n';
  return [D('E301', b.B, lineOf(b.files, b.B, '[@no-such-source]'))];
});

bookCase('E302-wrong-kind', (b) => {
  addThread(b);
  b.files.get(b.B).fm.pov = 'brass-key';
  return [D('E302', b.B, 'pov')];
});

bookCase('E301-develop-missing-scene', (b) => {
  const p = addThread(b, {
    status: 'developed',
    setup: [b.files.get(b.A).fm.id],
    develop: [`scene_${ulid('CS', 999)}`],
    payoff: [],
  });
  return [D('E301', p, 'develop[0]')];
});

bookCase('E302-develop-wrong-kind', (b) => {
  const p = addThread(b, {
    status: 'developed',
    setup: [b.files.get(b.A).fm.id],
    develop: [b.files.get(b.ENTRY).fm.id],
    payoff: [],
  });
  return [D('E302', p, 'develop[0]')];
});

bookCase('W306-planted-no-setup', (b) => {
  const p = addThread(b, { status: 'planted', setup: [], payoff: [] });
  return [D('W306', p, 'status')];
});

bookCase('W306-developed-no-develop', (b) => {
  const p = addThread(b, {
    status: 'developed',
    setup: [b.files.get(b.A).fm.id],
    develop: [],
    payoff: [],
  });
  return [D('W306', p, 'status')];
});

bookCase('W201-misfiled-scene', (b) => {
  const to = `${ACT1}ch-002-two/0020-b.md`;
  move(b.files, b.B, to); // fields still say chapter 1
  return [D('W201', to, 'chapter')];
});

bookCase('W201-entry-type-folder', (b, ids) => {
  const p = 'codex/characters/salt-orchard.md';
  b.files.set(p, {
    fm: {
      schema: 'storyforge.entry/v1',
      id: ids('entry'),
      slug: 'salt-orchard',
      type: 'location',
      name: 'Salt Orchard',
      status: 'canon',
    },
    body: '',
  });
  return [D('W201', p, 'type')];
});

bookCase('W202-prefix-mismatch', (b) => {
  const to = `${CH1}0015-x.md`;
  move(b.files, b.B, to); // sequence stays 20
  return [D('W202', to, 'sequence')];
});

bookCase('W203-bad-filename', (b) => {
  const p = 'research/Chapter One Notes.md';
  b.files.set(p, 'Plain note, no front matter.\n\nRemember to check the ferry timetable.\n');
  return [D('W203', p, '')];
});

bookCase('W204-bom', (b) => {
  b.files.get(b.B).bom = true;
  return [D('W204', b.B, '')];
});

bookCase('W301-previous-slug', (b) => {
  b.files.get(b.ENTRY).fm.previous_slugs = ['mare-h'];
  b.files.get(b.B).body = 'People still call her [[mare-h]] here.\n';
  return [D('W301', b.B, lineOf(b.files, b.B, '[[mare-h]]'))];
});

bookCase('W302-paid-no-payoff', (b) => {
  const p = addThread(b, { status: 'paid', setup: [b.files.get(b.A).fm.id], payoff: [] });
  return [D('W302', p, 'payoff')];
});

bookCase('W303-archived-target', (b, ids) => {
  b.files.set('archive/codex/characters/old-friend.md', {
    fm: {
      schema: 'storyforge.entry/v1',
      id: ids('entry'),
      slug: 'old-friend',
      type: 'character',
      name: 'Old Friend',
      status: 'sketch',
    },
    body: 'Cut from the book.\n',
  });
  b.files.get(b.B).body = 'She remembered [[old-friend]] fondly.\n';
  return [D('W303', b.B, lineOf(b.files, b.B, '[[old-friend]]'))];
});

const typeFile = (ids, type) => ({
  fm: {
    schema: 'storyforge.codex-type/v1',
    id: ids('note'),
    type,
    name: 'Ship',
    plural: 'Ships',
    fields: ['Captain', 'Tonnage'],
  },
  body: 'Vessels that work the estuary.\n',
});

bookCase('E209-duplicate-type', (b, ids) => {
  b.files.set('codex/_types/ship.md', typeFile(ids, 'ship'));
  b.files.set('codex/_types/ships.md', typeFile(ids, 'ship'));
  return [D('E209', 'codex/_types/ship.md', 'type'), D('E209', 'codex/_types/ships.md', 'type')];
});

bookCase('W304-shared-alias', (b, ids) => {
  const ilse = 'codex/characters/ilse-hollis.md';
  b.files.get(b.ENTRY).fm.aliases = ['Mare'];
  b.files.set(ilse, {
    fm: {
      schema: 'storyforge.entry/v1',
      id: ids('entry'),
      slug: 'ilse-hollis',
      type: 'character',
      name: 'Ilse Hollis',
      aliases: ['Mare'],
      status: 'canon',
    },
    body: '## Overview\nAn aunt.\n',
  });
  return [D('W304', b.ENTRY, 'aliases[0]'), D('W304', ilse, 'aliases[0]')];
});

bookCase('W305-self-relation', (b) => {
  b.files.get(b.ENTRY).fm.related = { block: ['  - to: maren-hollis', '    as: herself'] };
  return [D('W305', b.ENTRY, 'related[0].to')];
});

bookCase('I401-unknown-field', (b) => {
  b.files.get(b.A).fm.mood = 'cold';
  return [D('I401', b.A, 'mood')];
});

bookCase('I402-cross-book', (b) => {
  b.files.get(b.B).body = 'Her cousin in [[other-book:someone]] would know.\n';
  return [D('I402', b.B, lineOf(b.files, b.B, '[[other-book:someone]]'))];
});

bookCase('W201-thread-folder', (b) => {
  const p = addThread(b, {}, 'planning/threads-old/brass-key.md');
  return [D('W201', p, 'schema')];
});

bookCase('W201-event-folder', (b, ids) => {
  const p = 'planning/events/the-flood.md';
  b.files.set(p, {
    fm: { schema: 'storyforge.event/v1', id: ids('event'), slug: 'the-flood', title: 'The flood', order: 100 },
    body: 'The sea wall fails.\n',
  });
  return [D('W201', p, 'schema')];
});

bookCase('W201-scene-outside-manuscript', (b, ids) => {
  const p = 'planning/drafts/0010-stray.md';
  b.files.set(p, {
    fm: sceneFm(ids, { title: 'Stray', sequence: 30 }),
    body: 'A scene saved in the wrong place.\n',
  });
  return [D('W201', p, 'schema')];
});

// ---- M05-J01: event state and continuity exceptions
const eventDoc = (ids, slug, order, state, extra = {}) => ({
  fm: { schema: 'storyforge.event/v1', id: ids('event'), slug, title: 'The flood', order, ...extra, ...(state ? { state: { block: state } } : {}) },
  body: 'The sea wall fails.\n',
});

bookCase('E102-event-state', (b, ids) => {
  const p = 'planning/timeline/the-flood.md';
  b.files.set(p, eventDoc(ids, 'the-flood', 100, ['  - { slug: maren-hollis, event: vanished }']));
  return [D('E102', p, 'state[0].event')];
});

bookCase('E301-event-state', (b, ids) => {
  const p = 'planning/timeline/the-flood.md';
  b.files.set(p, eventDoc(ids, 'the-flood', 100, ['  - { slug: nobody, event: died }']));
  return [D('E301', p, 'state[0].slug')];
});

bookCase('E302-event-state', (b, ids) => {
  const p = 'planning/timeline/the-flood.md';
  // a location value must be a location entry; maren-hollis is a character
  b.files.set(p, eventDoc(ids, 'the-flood', 100, ['  - { slug: maren-hollis, event: location, value: maren-hollis }']));
  return [D('E302', p, 'state[0].value')];
});

const exceptionDoc = (ids, slug, fingerprint, body = 'The author wants it this way.\n') => ({
  fm: {
    schema: 'storyforge.continuity-exception/v1',
    id: ids('note'),
    slug,
    fingerprint,
    rule: 'CF1',
    title: 'Kept on purpose',
    created: '"2026-11-02"',
  },
  body,
});

bookCase('W307-duplicate-exception', (b, ids) => {
  const p1 = 'planning/continuity/eyes-one.md';
  const p2 = 'planning/continuity/eyes-two.md';
  b.files.set(p1, exceptionDoc(ids, 'eyes-one', 'cf1-0123456789abcdef'));
  b.files.set(p2, exceptionDoc(ids, 'eyes-two', 'cf1-0123456789abcdef'));
  return [D('W307', p1, 'fingerprint'), D('W307', p2, 'fingerprint')];
});

// ---- Story Planner records (ADR 0003): E211, W316, W317
const linkDoc = (ids, slug, from, to, relation = 'therefore') => ({
  fm: { schema: 'storyforge.link/v1', id: ids('note'), slug, from, to, relation, created: '2026-11-05' },
  body: 'Why this scene leads to the next.\n',
});
const planDoc = (ids, scene, o = {}) => ({
  fm: { schema: 'storyforge.scene-plan/v1', id: ids('note'), scene, goal: 'Get the key.', characters: ['maren-hollis'], ...o },
  body: 'Free planning notes.\n',
});

bookCase('E211-self-link', (b, ids) => {
  const a = b.files.get(b.A).fm.id;
  const p = 'planning/links/first-therefore-first.md';
  b.files.set(p, linkDoc(ids, 'first-therefore-first', a, a));
  return [D('E211', p, 'to')];
});

bookCase('W316-duplicate-link', (b, ids) => {
  const from = b.files.get(b.A).fm.id;
  const to = b.files.get(b.B).fm.id;
  b.files.set('planning/links/first-therefore-second.md', linkDoc(ids, 'first-therefore-second', from, to));
  const p2 = 'planning/links/first-therefore-second-2.md';
  b.files.set(p2, linkDoc(ids, 'first-therefore-second-2', from, to));
  return [D('W316', p2, 'relation')];
});

bookCase('W317-duplicate-scene-plan', (b, ids) => {
  const scene = b.files.get(b.A).fm.id;
  b.files.set('planning/scene-plans/first.md', planDoc(ids, scene));
  const p2 = 'planning/scene-plans/first-2.md';
  b.files.set(p2, planDoc(ids, scene));
  return [D('W317', p2, 'scene')];
});

bookCase('W318-story-plan-path', (b, ids) => {
  const p = 'planning/story-notes.md';
  b.files.set(p, { fm: { schema: 'storyforge.story-plan/v1', id: ids('note'), premise: 'A harbour key opens the wrong door.' }, body: 'Free notes.\n' });
  return [D('W318', p, 'schema')];
});

// Story Planner M3: W319
const arcDoc = (ids, slug, character, o = {}) => ({
  fm: { schema: 'storyforge.arc/v1', id: ids('note'), slug, character, arc_type: 'positive', ...o },
  body: 'Free arc notes.\n',
});
bookCase('W319-duplicate-arc', (b, ids) => {
  const character = b.files.get(b.ENTRY).fm.id;
  b.files.set('planning/arcs/maren-hollis.md', arcDoc(ids, 'maren-hollis', character));
  const p2 = 'planning/arcs/maren-hollis-2.md';
  b.files.set(p2, arcDoc(ids, 'maren-hollis-2', character));
  return [D('W319', p2, 'character')];
});

// Story Planner M5: E212 and W320
const relationshipDoc = (ids, slug, a, b, o = {}) => ({
  fm: { schema: 'storyforge.relationship/v1', id: ids('note'), slug, a, b, baseline: 'Wary of each other.', ...o },
  body: 'Free relationship notes.\n',
});
bookCase('E212-relationship-self', (b, ids) => {
  const entry = b.files.get(b.ENTRY).fm.id;
  const p = 'planning/relationships/maren-hollis-and-maren-hollis.md';
  b.files.set(p, relationshipDoc(ids, 'maren-hollis-and-maren-hollis', entry, entry));
  return [D('E212', p, 'b')];
});
bookCase('W320-duplicate-relationship', (b, ids) => {
  const a = b.files.get(b.ENTRY).fm.id;
  const ilse = ids('entry');
  b.files.set('codex/characters/ilse-hollis.md', { fm: { schema: 'storyforge.entry/v1', id: ilse, slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis', status: 'canon' }, body: '## Overview\nAn aunt.\n' });
  const other = ilse;
  b.files.set('planning/relationships/maren-hollis-and-ilse-hollis.md', relationshipDoc(ids, 'maren-hollis-and-ilse-hollis', a, other));
  const p2 = 'planning/relationships/maren-hollis-and-ilse-hollis-2.md';
  b.files.set(p2, relationshipDoc(ids, 'maren-hollis-and-ilse-hollis-2', other, a));
  return [D('W320', p2, 'b')];
});

// Story Planner M7: E102 on a synopsis type or basis
const synopsisDoc = (ids, slug, o = {}) => ({
  fm: { schema: 'storyforge.synopsis/v1', id: ids('note'), slug, type: 'one-page', name: 'One page', target_words: 300, created: '2026-11-06', ...o },
  body: 'Free synopsis text.\n',
});
bookCase('E102-synopsis-type', (b, ids) => {
  const p = 'planning/synopses/one-page.md';
  b.files.set(p, synopsisDoc(ids, 'one-page', { type: 'blurb' }));
  return [D('E102', p, 'type')];
});
bookCase('E102-synopsis-basis', (b, ids) => {
  const p = 'planning/synopses/one-page.md';
  b.files.set(p, synopsisDoc(ids, 'one-page', { basis: 'not-a-hash' }));
  return [D('E102', p, 'basis')];
});

// Story Planner M8: E102 on a clue kind, E301 on a knower's scene
const clueDoc = (ids, slug, o = {}) => ({
  fm: { schema: 'storyforge.clue/v1', id: ids('note'), slug, fact: 'The key opens the sea gate.', kind: 'clue', created: '2026-11-06', ...o },
  body: 'Free clue notes.\n',
});
bookCase('E102-clue-kind', (b, ids) => {
  const p = 'planning/clues/sea-gate-key.md';
  b.files.set(p, clueDoc(ids, 'sea-gate-key', { kind: 'hint' }));
  return [D('E102', p, 'kind')];
});
bookCase('E301-clue-knower-scene', (b, ids) => {
  const p = 'planning/clues/sea-gate-key.md';
  b.files.set(p, clueDoc(ids, 'sea-gate-key', { knowers: { block: ['  - who: reader', '    scene: scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] } }));
  return [D('E301', p, 'knowers[0].scene')];
});

// Story Planner M4: E102 for a beat id used twice
bookCase('E102-duplicate-beat-id', (b, ids) => {
  const p = 'planning/structures/main-three-act.md';
  const beat = ids('note');
  b.files.set(p, {
    fm: {
      schema: 'storyforge.structure/v1', id: ids('note'), slug: 'main-three-act', name: 'Main structure', template: 'three-act', template_version: 1,
      beats: { block: [`  - id: ${beat}`, '    name: Opening image', `  - id: ${beat}`, '    name: Inciting event'] },
    },
    body: 'Free structure notes.\n',
  });
  return [D('E102', p, 'beats[1].id')];
});

// ---- suggestion documents (M05-J06)
const suggestionFor = (ids, targetId, targetPath, baseBytes, proposed) =>
  buildSuggestion({
    id: ids('note'), targetId, targetPath, baseBytes: Buffer.from(baseBytes), proposedBytes: Buffer.from(proposed),
    source: 'claude-book', mode: 'suggest', created: '2026-11-02T14:03:22Z',
  }).text;
const SUGGESTION_PATH = 'suggestions/2026/20261102-140322-first-line.md';

bookCase('W308-suggestion-target-missing', (b, ids) => {
  const base = render(b.files.get(b.A)).toString();
  b.files.set(SUGGESTION_PATH, suggestionFor(ids, `scene_${ulid('CS', 900)}`, b.A, base, base.replace('tide went out', 'tide drew back')));
  return [D('W308', SUGGESTION_PATH, 'target')];
});

bookCase('E102-suggestion-hunk', (b, ids) => {
  const base = render(b.files.get(b.A)).toString();
  const text = suggestionFor(ids, b.files.get(b.A).fm.id, b.A, base, base.replace('tide went out', 'tide drew back'));
  b.files.set(SUGGESTION_PATH, text.replace('lines: 1,', 'lines: 2,'));
  return [D('E102', SUGGESTION_PATH, 'hunks[0]')];
});

// ---- library cases: root is a library, books live under it
function addBookTo(files, ids, prefix, slug, series_number) {
  const b = newBook(ids, { prefix, slug, series_number });
  for (const [k, v] of b.files) files.set(k, v);
  return b;
}
function seriesMd(ids) {
  return {
    fm: {
      schema: 'storyforge.series/v1',
      id: ids('series'),
      slug: 'tidewater',
      title: 'The Tidewater Books',
      status: 'active',
    },
    body: '',
  };
}

invalid['E202-duplicate-series-number'] = () => {
  const ids = mkIds('B1');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids));
  addBookTo(files, ids, 'tidewater/book-a/', 'book-a', 1);
  addBookTo(files, ids, 'tidewater/book-b/', 'book-b', 1);
  return {
    files,
    expected: [
      D('E202', 'tidewater/book-a/book.md', 'series_number'),
      D('E202', 'tidewater/book-b/book.md', 'series_number'),
    ],
  };
};

invalid['E203-duplicate-book-slug'] = () => {
  const ids = mkIds('B1');
  const files = new Map();
  addBookTo(files, ids, 'book-a/', 'same-slug');
  addBookTo(files, ids, 'book-b/', 'same-slug');
  return {
    files,
    expected: [D('E203', 'book-a/book.md', 'slug'), D('E203', 'book-b/book.md', 'slug')],
  };
};

invalid['E301-unknown-pen-name'] = () => {
  const ids = mkIds('B1');
  const files = new Map();
  files.set('library.md', {
    fm: {
      schema: 'storyforge.library/v1',
      id: ids('lib'),
      title: 'Synthetic Library',
      pen_names: { block: ['  - name: R. Fenwick', '    slug: r-fenwick'] },
    },
    body: '',
  });
  const b = addBookTo(files, ids, 'only-book/', 'only-book');
  files.get(b.BOOK).fm.pen_name = 'nobody';
  return { files, expected: [D('E301', 'only-book/book.md', 'pen_name')] };
};

invalid['W101-too-deep'] = () => {
  const ids = mkIds('B1');
  const files = new Map();
  const deep = 'shelf-a/shelf-b/shelf-c/';
  files.set(`${deep}book.md`, {
    fm: {
      schema: 'storyforge.book/v1',
      id: ids('book'),
      slug: 'too-deep',
      title: 'Too Deep',
      profile: 'fiction',
      status: 'planning',
    },
    body: 'Three folders below the library root.\n',
  });
  return { files, expected: [D('W101', `${deep}book.md`, '')] };
};

// ---------------------------------------------------------------- valid: library
function buildLibrary() {
  const ids = mkIds('V1');
  const files = new Map();
  files.set('library.md', {
    fm: {
      schema: 'storyforge.library/v1',
      id: ids('lib'),
      title: 'Synthetic Library',
      pen_names: { block: ['  - name: R. Fenwick', '    slug: r-fenwick'] },
    },
    body: '',
  });
  files.set('tidewater/series.md', seriesMd(ids));
  const one = addBookTo(files, ids, 'tidewater/tidewater-one/', 'tidewater-one', 1);
  files.get(one.BOOK).fm.pen_name = 'r-fenwick';
  addBookTo(files, ids, 'tidewater/tidewater-two/', 'tidewater-two', 2);
  addBookTo(files, ids, 'lantern-hill/', 'lantern-hill');
  return { files, expected: { diagnostics: [] } };
}

// ---------------------------------------------------------------- valid: salt-orchard
function buildSaltOrchard() {
  const ids = mkIds('S5');
  const files = new Map();
  const doc = (p, fm, body = '', extra = {}) => files.set(p, { fm, body, ...extra });

  const A1 = 'manuscript/act-01-low-water/';
  const A2 = 'manuscript/act-02-high-water/';
  const C0 = `${A1}ch-000-prologue/`;
  const C1 = `${A1}ch-001-the-drowned-rows/`;
  const C2 = `${A1}ch-002-the-grafting/`;
  const C3 = `${A2}ch-003-the-wall/`;

  // scene ids, allocated up front so they can reference one another
  const sid = {
    tide: ids('scene'),
    arrival: ids('scene'),
    key: ids('scene'),
    keyAlt: ids('scene'),
    ferry: ids('scene'),
    graft: ids('scene'),
    cut: ids('scene'),
    low: ids('scene'),
    wall: ids('scene'),
  };
  const anchorId = `a_${ulid('S5', 9000)}`;

  doc('book.md', {
    schema: 'storyforge.book/v1',
    id: ids('book'),
    slug: 'salt-orchard',
    title: 'The Salt Orchard',
    subtitle: '""',
    profile: 'fiction',
    status: 'drafting',
    genre: ['literary', 'coastal gothic'],
    word_target: 90000,
    language: 'en',
  }, 'A cartographer comes home to sell a drowned orchard and stays to graft it back.\n');

  // ---- act / chapter metadata
  doc(`${A1}act.md`, { schema: 'storyforge.act/v1', id: ids('act'), act: 1, title: 'Low Water' });
  doc(`${A2}act.md`, { schema: 'storyforge.act/v1', id: ids('act'), act: 2, title: 'High Water' });
  doc(`${C0}chapter.md`, { schema: 'storyforge.chapter/v1', id: ids('chap'), chapter: 0, label: 'Prologue', title: 'Before the Tide', status: 'revised' });
  doc(`${C1}chapter.md`, { schema: 'storyforge.chapter/v1', id: ids('chap'), chapter: 1, label: 'Chapter One', title: 'The Drowned Rows', status: 'drafting', summary: 'Maren arrives and finds the orchard flooded.' }, 'Notes: keep the arrival slow.\n');
  doc(`${C2}chapter.md`, { schema: 'storyforge.chapter/v1', id: ids('chap'), chapter: 2, label: 'Chapter Two', title: 'The Grafting', status: 'drafting' });
  // chapter 3 deliberately has no chapter.md: its label defaults to "Chapter 3"

  // ---- scenes
  doc(`${C0}0010-before-the-tide.md`, {
    schema: 'storyforge.scene/v1', id: sid.tide, title: 'Before the Tide',
    act: 1, chapter: 0, sequence: 10, status: 'revised',
    pov: 'ilse-hollis', characters: ['ilse-hollis'], locations: ['salt-orchard'],
    plot_threads: ['brass-key'], events: ['the-flood'],
    summary: 'Ilse hides the key the night the sea wall fails.',
  }, [
    'Ilse counted the rows by lantern light — forty, then forty-one — and heard the sea wall groan.',
    '',
    '“Not tonight,” she told the water, and pressed the key into the dark under the porch step.',
    '',
    '潮が引く、そして戻る。',
    '',
  ].join('\n'));

  doc(`${C1}0010-arrival.md`, {
    schema: 'storyforge.scene/v1', id: sid.arrival, title: 'Arrival',
    act: 1, chapter: 1, sequence: 10, status: 'drafting',
    pov: 'maren-hollis', characters: ['maren-hollis', 'tobin-reyes'],
    locations: ['port-aldine', 'salt-orchard'], events: ['the-return'],
    summary: 'Maren steps off the ferry into the flooded rows.',
  }, [
    'The ferry nudged the jetty and [[tobin-reyes|the ferryman]] threw her bag ashore.',
    '',
    'In the glass of the ticket hut she caught her own face, green eyes ringed with salt, and looked away.',
    '',
    'Past the dunes lay [[salt-orchard]], half under water.',
    '',
  ].join('\n'));

  doc(`${C1}0020-the-key.md`, {
    schema: 'storyforge.scene/v1', id: sid.key, title: 'The Key',
    act: 1, chapter: 1, sequence: 20, status: 'drafting',
    pov: 'maren-hollis', characters: ['maren-hollis', 'pell'],
    locations: ['salt-orchard'], plot_threads: ['brass-key'],
    summary: 'Maren finds the key under the porch step.',
    'x-mood': 'cold',
  }, [
    'The key was colder than the morning.',
    '',
    '<!-- note: check the tide times against chapter 3 -->',
    '',
    'She turned it over twice before she understood it was hers.',
    '',
    '<!-- opaque: left by the first draft, keep -->',
    '',
    '[[pell]] watched from the gate and said nothing.',
    '',
  ].join('\n'));

  doc(`${C1}0020-the-key-alt.md`, {
    schema: 'storyforge.scene/v1', id: sid.keyAlt, title: 'The Key (alt)',
    act: 1, chapter: 1, sequence: 20, status: 'outline',
    pov: 'maren-hollis', variant_of: sid.key,
  }, 'In this take the key is already in her pocket when she arrives.\n');

  doc(`${C2}0010-ferry.md`, {
    schema: 'storyforge.scene/v1', id: sid.ferry, title: 'Ferry',
    act: 1, chapter: 2, sequence: 10, status: 'drafting',
    pov: 'tobin-reyes', characters: ['tobin-reyes', 'maren-hollis'],
    locations: ['port-aldine'],
  }, [
    'Tobin ran the ferry twice a day, tide allowing, and the [[harbour-board]] allowed it less each year.',
    '',
    'He rang the [[ferry-bell]] once for Maren, who was late.',
    '',
  ].join('\n'));

  doc(`${C2}0020-the-grafting.md`, {
    schema: 'storyforge.scene/v1', id: sid.graft, title: 'The Grafting',
    act: 1, chapter: 2, sequence: 20, status: 'drafting',
    pov: 'pell', characters: ['pell', 'maren-hollis'], locations: ['salt-orchard'],
    summary: 'Pell teaches Maren to graft a drowned tree.',
  }, [
    'Pell handed over the [[grafting-knife]] handle first.',
    '',
    `<!-- sf:anchor id=${anchorId} -->`,
    'Cut clean, he said, and never cut twice.',
    '<!-- /sf:anchor -->',
    '',
    'Every cut left its [[saltmarks]] on the bark by morning.',
    '',
  ].join('\n'), { crlf: true });

  doc(`${C3}0010-low-tide.md`, {
    schema: 'storyforge.scene/v1', id: sid.low, title: 'Low Tide',
    act: 2, chapter: 3, sequence: 10, status: 'drafting',
    pov: 'maren-hollis', characters: ['maren-hollis'], locations: ['salt-orchard'],
  }, [
    'The tables promised the lowest water in a decade [@admiralty-tables], and for once they were right.',
    '',
    'Zoë brought coffee from the café on the quay, and Maren drank it standing in the mud. 🌊',
    '',
  ].join('\n'));

  doc(`${C3}0020-the-wall.md`, {
    schema: 'storyforge.scene/v1', id: sid.wall, title: 'The Wall',
    act: 2, chapter: 3, sequence: 20, status: 'outline',
    pov: 'maren-hollis', characters: ['maren-hollis', 'pell', 'tobin-reyes'],
    locations: ['salt-orchard'], plot_threads: ['brass-key'], events: ['the-wall-falls'],
  }, [
    `At the breach she finally used [[${sid.key}|the key]], and the old sluice gate turned.`,
    '',
    'The wall came down slowly, then all at once.',
    '',
  ].join('\n'));

  // archived scene: excluded from order, still carries a unique id
  doc(`archive/${C2}0030-the-cut-scene.md`, {
    schema: 'storyforge.scene/v1', id: sid.cut, title: 'The Cut Scene',
    act: 1, chapter: 2, sequence: 30, status: 'drafting', pov: 'pell',
  }, 'A scene that did not survive the second draft.\n');

  // ---- codex
  const entry = (p, fm, body) => doc(p, { schema: 'storyforge.entry/v1', id: ids('entry'), ...fm }, body);
  entry('codex/characters/maren-hollis.md', {
    slug: 'maren-hollis', type: 'character', name: 'Maren Hollis', aliases: ['Mare'],
    status: 'canon', role: 'Protagonist', first_appearance: sid.arrival,
    fields: { block: ['  Age: 34', '  Eyes: Grey', '  Home: "[[port-aldine]]"'] },
    related: { block: ['  - to: ilse-hollis', '    as: aunt', '  - to: tobin-reyes', '    as: childhood friend'] },
  }, '## Overview\nCartographer who maps coastlines for a living and avoids her own.\n\n## Arc\nComes back to sell the estate. Ends choosing to stay.\n\n## Open threads\n- Why did Ilse leave the key?\n');
  entry('codex/characters/ilse-hollis.md', {
    slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis', status: 'sketch',
    first_appearance: sid.tide,
    related: { block: ['  - to: maren-hollis', '    as: niece'] },
  }, '## Overview\nOrchard keeper who vanished the night of the flood.\n');
  entry('codex/characters/tobin-reyes.md', {
    slug: 'tobin-reyes', type: 'character', name: 'Tobin Reyes', status: 'canon',
    fields: { block: ['  Trade: Ferryman'] },
  }, '## Overview\nRuns the ferry between [[port-aldine]] and the orchard shore.\n');
  entry('codex/characters/pell.md', {
    slug: 'pell', type: 'character', name: 'Pell', status: 'seed', role: 'Caretaker',
  }, '## Overview\nSilent caretaker of the orchard, handy with a [[grafting-knife]].\n');
  entry('codex/locations/salt-orchard.md', {
    slug: 'salt-orchard', type: 'location', name: 'The Salt Orchard', status: 'canon',
  }, '## Overview\nForty-one rows of apple trees below the sea wall.\n');
  entry('codex/locations/port-aldine.md', {
    slug: 'port-aldine', type: 'location', name: 'Port Aldine', status: 'sketch',
  }, '## Overview\nA ferry town with one café and too many gulls.\n');
  entry('codex/factions/harbour-board.md', {
    slug: 'harbour-board', type: 'faction', name: 'The Harbour Board', status: 'sketch',
  }, '## Overview\nThe committee that licenses the ferry and wants the orchard drained.\n');
  entry('codex/objects/grafting-knife.md', {
    slug: 'grafting-knife', type: 'object', name: 'Grafting Knife', status: 'seed',
  }, '## Overview\nBone-handled, older than anyone living on the shore.\n');
  entry('codex/objects/ferry-bell.md', {
    slug: 'ferry-bell', type: 'object', name: 'Ferry Bell', status: 'seed',
  }, '## Overview\nRung once for a passenger, twice for the post.\n');
  entry('codex/lore/saltmarks.md', {
    slug: 'saltmarks', type: 'lore', name: 'Saltmarks', status: 'sketch',
  }, '## Overview\nWhite tide scars that show on any tree the sea has touched.\n');

  // ---- planning
  doc('planning/threads/brass-key.md', {
    schema: 'storyforge.thread/v1', id: ids('thread'), slug: 'brass-key',
    title: 'The brass key', kind: 'mystery', status: 'paid',
    setup: [sid.key], payoff: [sid.wall], characters: ['maren-hollis', 'ilse-hollis'],
  }, 'What the key opens, and why Ilse left it where Maren would find it.\n');
  const event = (slug, title, order, when, scenes) =>
    doc(`planning/timeline/${slug}.md`, {
      schema: 'storyforge.event/v1', id: ids('event'), slug, title, order,
      when: `"${when}"`, ...(scenes ? { scenes } : {}),
    }, `${title}.\n`);
  event('the-first-grafting', 'The first grafting', 10, 'Autumn, year -30', [sid.graft]);
  event('the-flood', 'The spring flood', 100, 'Spring, year 0', [sid.tide]);
  event('the-key-found-twice', 'The key is found', 150, 'Spring, year 30', [sid.keyAlt]);
  event('the-return', 'Maren returns', 200, 'Spring, year 30'); // linked one-sided from the arrival scene
  event('the-wall-falls', 'The wall falls', 300, 'Summer, year 30', [sid.wall]);
  doc('planning/plan.md', {
    schema: 'storyforge.doc/v1', id: ids('note'), title: 'Book plan', locked: 'false',
  }, '## Plan\nAct one: arrival and the key. Act two: the wall.\n');

  // ---- research
  doc('research/tidal-ranges.md', {
    schema: 'storyforge.research/v1', id: ids('note'), title: 'Tidal ranges on the coast',
    tags: ['tides', 'setting'], canon: 'false', sources: ['admiralty-tables'], links: ['salt-orchard'],
  }, 'Spring tides here reach four metres. Neap tides about two.\n');
  doc('research/sources/admiralty-tables.md', {
    schema: 'storyforge.source/v1', id: ids('note'), cite_key: 'admiralty-tables',
    type: 'report', author: '"Aldine Harbour Office"', title: '"Tide Tables for the North Shore"', year: 1998,
  }, '');

  // ---- non-canonical decoy: if this were read it would raise E201
  files.set('.storyforge/trash/old-scene.md', render({
    fm: { schema: 'storyforge.scene/v1', id: sid.arrival, title: 'Old', act: 1, chapter: 1, sequence: 10, status: 'drafting' },
    body: 'Prior version from an atomic save. Must never be read.\n',
  }));

  // ---- contradiction note (plain note, no front matter)
  files.set('contradiction.md', [
    '# Intentional continuity contradiction (for M05)',
    '',
    'This book contains one deliberate fact conflict. The validator does NOT detect it;',
    'the continuity engine in M05 must.',
    '',
    '- Codex: `codex/characters/maren-hollis.md` says `Eyes: Grey`.',
    '- Scene: `manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md` says Maren has green eyes.',
    '',
    'Do not "fix" it. Synthetic fixture, no user manuscript.',
    '',
  ].join('\n'));

  const order = [sid.tide, sid.arrival, sid.key, sid.ferry, sid.graft, sid.low, sid.wall];
  const excluded = [
    { id: sid.keyAlt, path: `${C1}0020-the-key-alt.md`, reason: 'variant' },
    { id: sid.cut, path: `archive/${C2}0030-the-cut-scene.md`, reason: 'archived' },
  ];
  return {
    ids,
    files,
    expected: {
      diagnostics: [],
      order,
      timeline: ['the-first-grafting', 'the-flood', 'the-key-found-twice', 'the-return', 'the-wall-falls'],
      excluded,
    },
  };
}

// ---------------------------------------------------------------- valid: continuity-cases (M05-J01)
// One positive and one near-miss negative per continuity rule. Every name and sentence is invented.
function buildContinuityCases() {
  const ids = mkIds('C7');
  const files = new Map();
  const doc = (p, fm, body = '') => files.set(p, { fm, body });
  const CH2 = 'manuscript/act-01-one/ch-002-two/';
  const CH3 = 'manuscript/act-01-one/ch-003-three/';

  doc('book.md', { schema: 'storyforge.book/v1', id: ids('book'), slug: 'lantern-ledger', title: 'The Lantern Ledger', profile: 'fiction', status: 'drafting' }, 'A synthetic book that exercises every continuity rule.\n');

  // ---- codex
  const entry = (p, fm, body = '') => doc(p, { schema: 'storyforge.entry/v1', id: ids('entry'), status: 'canon', ...fm }, body);
  const fieldsOf = (...lines) => ({ block: lines.map((l) => `  ${l}`) });
  doc('codex/_types/character.md', {
    schema: 'storyforge.codex-type/v1', id: ids('note'), type: 'character', name: 'Character', plural: 'Characters',
    fields: ['Eyes', 'Hair', 'Build'], values: '{ Build: [slight, stocky] }',
  }, 'People of the book. Build has its own vocabulary.\n');
  entry('codex/characters/ana-voss.md', { slug: 'ana-voss', type: 'character', name: 'Ana Voss', aliases: ['Ana'], fields: fieldsOf('Eyes: Brown') });
  entry('codex/characters/bram-keel.md', { slug: 'bram-keel', type: 'character', name: 'Bram Keel', aliases: ['Bram'], fields: fieldsOf('Eyes: Blue', 'Hair: Grey') });
  entry('codex/characters/cleo-marsh.md', { slug: 'cleo-marsh', type: 'character', name: 'Cleo Marsh', aliases: ['Cleo'], fields: fieldsOf('Hair: Red', 'Build: Slight') });
  entry('codex/characters/dov-ellis.md', { slug: 'dov-ellis', type: 'character', name: 'Dov Ellis', aliases: ['Dov'] });
  for (const [slug, name] of [['lighthouse', 'The Lighthouse'], ['market', 'The Market'], ['harbour-town', 'Harbour Town']]) {
    entry(`codex/locations/${slug}.md`, { slug, type: 'location', name });
  }
  for (const [slug, name] of [['silver-lamp', 'Silver Lamp'], ['tin-whistle', 'Tin Whistle'], ['clay-jar', 'Clay Jar'], ['copper-kettle', 'Copper Kettle'], ['brass-bell', 'Brass Bell']]) {
    entry(`codex/objects/${slug}.md`, { slug, type: 'object', name });
  }

  // ---- scenes (book order: lamp-room, the-dock, tide-office, the-stairs, the-last-light)
  const sid = { lamp: ids('scene'), dock: ids('scene'), tide: ids('scene'), stairs: ids('scene'), last: ids('scene') };
  const scene = (p, id, fm, body) => doc(p, { schema: 'storyforge.scene/v1', id, status: 'drafting', act: 1, ...fm }, body);
  scene(`${CH1}0010-lamp-room.md`, sid.lamp, { title: 'Lamp Room', chapter: 1, sequence: 10, pov: 'ana-voss', characters: ['ana-voss', 'bram-keel'], plot_threads: ['lamp-oil'] }, [
    'Her green eyes caught the lamplight.',
    '',
    'She wore a green scarf, the green of old bottles.',
    '',
    "Bram's blue eyes narrowed as he counted the steps.",
    '',
  ].join('\n'));
  scene(`${CH1}0020-the-dock.md`, sid.dock, { title: 'The Dock', chapter: 1, sequence: 20, pov: 'bram-keel', characters: ['bram-keel'], plot_threads: ['ledger-seal'] }, [
    'His gray hair stuck to his forehead in the wet.',
    '',
  ].join('\n'));
  scene(`${CH2}0010-tide-office.md`, sid.tide, { title: 'Tide Office', chapter: 2, sequence: 10, pov: 'cleo-marsh', characters: ['cleo-marsh'], plot_threads: ['hollow-bell'] }, [
    'Her stocky build filled the doorway of the tide office.',
    '',
  ].join('\n'));
  scene(`${CH2}0020-the-stairs.md`, sid.stairs, { title: 'The Stairs', chapter: 2, sequence: 20, pov: 'ana-voss', characters: ['ana-voss', 'dov-ellis'], plot_threads: [] }, [
    'Forty steps up, and the ledger seal was still warm.',
    '',
  ].join('\n'));
  scene(`${CH3}0010-the-last-light.md`, sid.last, { title: 'The Last Light', chapter: 3, sequence: 10, pov: 'ana-voss', characters: ['ana-voss', 'cleo-marsh'], plot_threads: ['late-letter', 'lamp-oil'] }, [
    'She did not look away when the lamp went out.',
    '',
  ].join('\n'));

  // ---- threads: TH1a (ledger-seal: payoff first), TH1b (hollow-bell: open, book ends later)
  const thread = (slug, title, status, fm = {}) => doc(`planning/threads/${slug}.md`, {
    schema: 'storyforge.thread/v1', id: ids('thread'), slug, title, kind: 'mystery', status, setup: [], payoff: [], ...fm,
  }, `${title}.\n`);
  thread('ledger-seal', 'The ledger seal', 'paid', { setup: [sid.stairs], payoff: [sid.dock] });
  thread('lamp-oil', 'The lamp oil', 'paid', { setup: [sid.lamp], payoff: [sid.last] });
  thread('hollow-bell', 'The hollow bell', 'open');
  thread('old-grudge', 'The old grudge', 'unresolved');
  thread('late-letter', 'The late letter', 'open');

  // ---- events
  const ev = (slug, title, order, o = {}) => {
    const { state, ...rest } = o;
    doc(`planning/timeline/${slug}.md`, {
      schema: 'storyforge.event/v1', id: ids('event'), slug, title, order, ...rest, ...(state ? { state: { block: state.map((x) => `  - ${x}`) } } : {}),
    }, `${title}.\n`);
  };
  // TL1a: a character who died is present later; near-misses: same order as the death, and a revival in between
  ev('dov-dies', 'Dov dies', 100, { characters: ['dov-ellis'], state: ['{ slug: dov-ellis, event: died }'] });
  ev('dov-returns', 'Dov at the door', 200, { characters: ['dov-ellis'] });
  ev('cleo-dies', 'Cleo is struck down', 110, { state: ['{ slug: cleo-marsh, event: died }'] });
  ev('cleo-farewell', 'Cleo says goodbye', 110, { characters: ['cleo-marsh'] });
  ev('cleo-wakes', 'Cleo wakes', 115, { state: ['{ slug: cleo-marsh, event: revived }'] });
  ev('cleo-back', 'Cleo at the market', 130, { characters: ['cleo-marsh'] });
  // TL1a (objects): a destroyed object is used later
  ev('whistle-breaks', 'The whistle breaks', 140, { state: ['{ slug: tin-whistle, event: destroyed }'] });
  ev('whistle-held', 'Bram takes the whistle', 150, { state: ['{ slug: tin-whistle, event: holder, value: bram-keel }'] });
  // TL1b: one character in two places at the same order; near-misses: same place, different orders
  ev('ana-tower', 'Ana in the tower', 300, { state: ['{ slug: ana-voss, event: location, value: lighthouse }'] });
  ev('ana-stall', 'Ana at the stall', 300, { state: ['{ slug: ana-voss, event: location, value: market }'] });
  ev('meet-a', 'Bram on the quay', 310, { characters: ['bram-keel'], locations: ['harbour-town'] });
  ev('meet-b', 'Bram still on the quay', 310, { characters: ['bram-keel'], locations: ['harbour-town'] });
  ev('walk-a', 'Ana climbs', 320, { state: ['{ slug: ana-voss, event: location, value: lighthouse }'] });
  ev('walk-b', 'Ana descends', 330, { state: ['{ slug: ana-voss, event: location, value: market }'] });
  // TL1c: a later event with an earlier date; near-miss: equal at the shorter precision
  ev('dated-a', 'The spring inspection', 400, { date: '2020-05' });
  ev('dated-b', 'The earlier inspection', 410, { date: '2020-03' });
  ev('dated-c', 'The year of the fog', 420, { date: 2021 });
  ev('dated-d', 'The fog lifts', 430, { date: '2021-02-10' });
  // KN1: knows before learns; near-misses: learns at the same order, learns earlier
  ev('bram-suspects', 'Bram suspects', 500, { state: ['{ slug: bram-keel, event: knows, value: the-lamp-is-hollow }'] });
  ev('bram-told', 'Bram is told', 600, { state: ['{ slug: bram-keel, event: learns, value: the-lamp-is-hollow }'] });
  ev('cleo-reads', 'Cleo reads the tables', 700, { state: ['{ slug: cleo-marsh, event: learns, value: tide-times }'] });
  ev('cleo-recalls', 'Cleo recalls the tables', 700, { state: ['{ slug: cleo-marsh, event: knows, value: tide-times }'] });
  ev('ana-learns', 'Ana learns the moon', 710, { state: ['{ slug: ana-voss, event: learns, value: moon-phase }'] });
  ev('ana-knows', 'Ana knows the moon', 720, { state: ['{ slug: ana-voss, event: knows, value: moon-phase }'] });
  // ST1a: a lost object is held; near-miss: found first
  ev('jar-lost', 'The jar is lost', 800, { state: ['{ slug: clay-jar, event: lost }'] });
  ev('jar-held', 'Ana holds the jar', 810, { state: ['{ slug: clay-jar, event: holder, value: ana-voss }'] });
  ev('lamp-lost', 'The lamp is lost', 820, { state: ['{ slug: silver-lamp, event: lost }'] });
  ev('lamp-found', 'The lamp is found', 830, { state: ['{ slug: silver-lamp, event: found }'] });
  ev('lamp-held', 'Bram holds the lamp', 840, { state: ['{ slug: silver-lamp, event: holder, value: bram-keel }'] });
  // ST1b: two holders at the same order; near-miss: the same holder twice
  ev('kettle-ana', 'Ana has the kettle', 900, { state: ['{ slug: copper-kettle, event: holder, value: ana-voss }'] });
  ev('kettle-bram', 'Bram has the kettle', 900, { state: ['{ slug: copper-kettle, event: holder, value: bram-keel }'] });
  ev('bell-a', 'Cleo rings the bell', 910, { state: ['{ slug: brass-bell, event: holder, value: cleo-marsh }'] });
  ev('bell-b', 'Cleo still has the bell', 910, { state: ['{ slug: brass-bell, event: holder, value: cleo-marsh }'] });

  // ---- research: a canon note that disagrees (CF1), a non-canon note that is ignored
  doc('research/cleo-notes.md', {
    schema: 'storyforge.research/v1', id: ids('note'), title: 'Cleo, canon notes', canon: true, links: ['cleo-marsh'],
  }, '## Appearance\nHair: Black\n');
  doc('research/ana-rumours.md', {
    schema: 'storyforge.research/v1', id: ids('note'), title: 'Rumours about Ana', canon: false, links: ['ana-voss'],
  }, 'Eyes: Blue\n');

  return {
    files,
    expected: {
      diagnostics: [],
      order: [sid.lamp, sid.dock, sid.tide, sid.stairs, sid.last],
    },
  };
}

// ---------------------------------------------------------------- write everything
const json = (o) => JSON.stringify(o, null, 2) + '\n';

for (const [name, build] of Object.entries(invalid)) {
  const { files, expected } = build();
  checkIds(files);
  files.set('expected.json', json({ diagnostics: expected }));
  writeTree(path.join(FIXTURES, 'invalid', name), files);
}

{
  const { files, expected } = buildSaltOrchard();
  checkIds(files);
  // expected.json lives beside the book; it is not part of the book
  writeTree(path.join(FIXTURES, 'valid', 'salt-orchard'), files);
  fs.writeFileSync(path.join(FIXTURES, 'valid', 'salt-orchard', 'expected.json'), json(expected));
}
{
  const { files, expected } = buildLibrary();
  checkIds(files);
  writeTree(path.join(FIXTURES, 'valid', 'library'), files);
  fs.writeFileSync(path.join(FIXTURES, 'valid', 'library', 'expected.json'), json(expected));
}
{
  const S = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/';
  const expected = {
    diagnostics: [
      D('W201', `${S}0010-ferry.md`, 'chapter'),
      D('I402', `${S}0015-the-key.md`, 'line 18'),
      D('W301', `${S}0015-the-key.md`, 'line 18'),
      D('W202', `${S}0015-the-key.md`, 'sequence'),
    ],
    order: [
      'scene_01JQ971HFE865V215DE1CTEWH0',
      'scene_01JQ9AVNH9DN65R6PPG2X7R5JQ',
      'scene_01JQ9C42EJ5E6RHXQAQPDH4AFA',
      'scene_01JQ9XRHEM3E2MSH4DMDZSX9G8',
      'scene_01JQ9FGVSQE8Z5379AV4RRXG07',
      'scene_01JQ9HN7JVAX0GB6KC9QA0MZ17',
      'scene_01JQ9QKF3F55Z488YAGVDCKSQW',
    ],
    excluded: [
      { id: 'scene_01JQ9W7FE4N1EE043E42N4FHZD', path: `${S}0020-the-key-alt.md`, reason: 'variant' },
      { id: 'scene_01JQ98YFYTC66VPVTX363SN6FC', path: 'archive/manuscript/act-01-low-water/ch-002-cut/0020-cut-scene.md', reason: 'archived' },
    ],
  };
  fs.writeFileSync(path.join(FIXTURES, 'valid', 'spec-example', 'expected.json'), json(expected));
}

// ---- M05-J01: continuity expectations. expected-continuity.json is what the engine reports for the book as it
// was just written; it is reviewed by hand and then pinned by packages/continuity/test.
const { checkContinuity } = await import('../../continuity/src/index.mjs');
const continuityOf = async (dir) => {
  const r = await checkContinuity(dir);
  return { findings: r.findings, suppressed: r.suppressed, stale_exceptions: r.stale_exceptions };
};
const SALT = path.join(FIXTURES, 'valid', 'salt-orchard');
const saltExpected = await continuityOf(SALT);
fs.writeFileSync(path.join(SALT, 'expected-continuity.json'), json({ findings: saltExpected.findings, suppressed: [] }));

{
  const { files, expected } = buildContinuityCases();
  checkIds(files);
  const dir = path.join(FIXTURES, 'valid', 'continuity-cases');
  writeTree(dir, files);
  fs.writeFileSync(path.join(dir, 'expected.json'), json(expected));
  const got = await continuityOf(dir);
  fs.writeFileSync(path.join(dir, 'expected-continuity.json'), json({ findings: got.findings, suppressed: [] }));
}
{
  // salt-orchard plus two exceptions: one names the CF1 fingerprint, one names nothing
  const { files, expected, ids } = buildSaltOrchard();
  if (saltExpected.findings.length !== 1) throw new Error('salt-orchard must have exactly one finding');
  files.set('planning/continuity/maren-eyes.md', exceptionDoc(ids, 'maren-eyes', saltExpected.findings[0].fingerprint, 'Maren sees herself in the ticket-hut glass, which turns everything green.\n'));
  files.set('planning/continuity/old-note.md', exceptionDoc(ids, 'old-note', 'cf1-00000000deadbeef', 'Written for a conflict that was fixed long ago.\n'));
  checkIds(files);
  const dir = path.join(FIXTURES, 'valid', 'continuity-exception');
  writeTree(dir, files);
  fs.writeFileSync(path.join(dir, 'expected.json'), json(expected));
  const got = await continuityOf(dir);
  fs.writeFileSync(path.join(dir, 'expected-continuity.json'), json(got));
}
{
  // salt-orchard plus one suggestion with three hunks on Arrival (adjacent changes would merge, so each is separated by an unchanged line), none decided
  const { files, expected, ids } = buildSaltOrchard();
  const arrivalPath = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
  const arrival = files.get(arrivalPath);
  const base = render(arrival).toString();
  const proposed = base
    .replace('threw her bag ashore.', 'threw her bag ashore, and did not look up.')
    .replace('green eyes ringed', 'grey eyes ringed')
    .replace('half under water.', 'half drowned.');
  files.set('suggestions/2026/20261102-140322-arrival-eyes.md', suggestionFor(ids, arrival.fm.id, arrivalPath, base, proposed));
  checkIds(files);
  const dir = path.join(FIXTURES, 'valid', 'suggestion');
  writeTree(dir, files);
  fs.writeFileSync(path.join(dir, 'expected.json'), json(expected));
}
{
  // salt-orchard plus the first two receipts of Arrival (M05-J07): a baseline and an author edit, with the content objects they name (provenance/objects has no extension)
  const { buildReceipt, objectPath, receiptPath, sha256Hex } = await import('../../receipts/src/index.mjs');
  const { files, expected } = buildSaltOrchard();
  const arrivalPath = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
  const arrival = files.get(arrivalPath);
  const v0 = Buffer.from(render(arrival).toString());
  const v1 = Buffer.from(v0.toString().replace('green eyes ringed', 'grey eyes ringed'));
  const target = { id: arrival.fm.id, path: arrivalPath };
  const at0 = '2026-11-02T14:05:00.000Z';
  const at1 = '2026-11-02T14:09:30.250Z';
  const r0 = buildReceipt({ id: `rcpt_${ulid('RC', 1)}`, at: at0, actor: 'system', operation: 'baseline', workflow: 'editor', target, before_sha256: '', after_sha256: sha256Hex(v0), beforeBytes: Buffer.alloc(0), afterBytes: v0 });
  const r1 = buildReceipt({ id: `rcpt_${ulid('RC', 2)}`, at: at1, actor: 'author', operation: 'author.edit', workflow: 'editor', target, before_sha256: sha256Hex(v0), after_sha256: sha256Hex(v1), beforeBytes: v0, afterBytes: v1, parents: [{ id: `rcpt_${ulid('RC', 1)}`, sha256: r0.sha256 }] });
  const dir = path.join(FIXTURES, 'valid', 'receipts');
  writeTree(dir, files);
  const put = (rel, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
  };
  put(receiptPath(at0, `rcpt_${ulid('RC', 1)}`), r0.text);
  put(receiptPath(at1, `rcpt_${ulid('RC', 2)}`), r1.text);
  put(objectPath(sha256Hex(v0)), v0);
  put(objectPath(sha256Hex(v1)), v1);
  fs.writeFileSync(path.join(dir, 'expected.json'), json(expected));
}
{
  // salt-orchard plus the two Story Planner kinds (ADR 0003): one link and one scene plan, the ADR examples; no new diagnostic
  const { files, expected, ids } = buildSaltOrchard();
  const KEY = 'scene_01S50000000000000000000003';
  const FERRY = 'scene_01S50000000000000000000005';
  const SECOND_SCENE = 'scene_01S50000000000000000000002';
  files.set('planning/links/key-therefore-ferry.md', {
    fm: { schema: 'storyforge.link/v1', id: ids('note'), slug: 'key-therefore-ferry', from: KEY, to: FERRY, relation: 'therefore', created: '2026-11-05' },
    body: 'The key failing forces Maren onto the ferry.\n',
  });
  files.set('planning/scene-plans/the-key.md', {
    fm: {
      schema: 'storyforge.scene-plan/v1', id: ids('note'), scene: KEY,
      goal: 'Prove the harbour key opens the sea gate.',
      opposition: 'The harbourmaster wants the key returned before dusk.',
      conflict: 'Maren must choose between the gate and her apprenticeship.',
      turn: 'The key opens a different door.',
      outcome: 'Maren is locked out of the guild.',
      consequence: 'She has to ask the ferryman for passage.',
      stakes: 'Her place in the town.',
      emotional_start: 'hopeful',
      emotional_end: 'cornered',
      purpose: 'Close off the safe path.',
      characters: ['maren-hollis', 'pell'],
    },
    body: 'Free planning notes for this scene.\n',
  });
  files.set('planning/story.md', {
    fm: {
      schema: 'storyforge.story-plan/v1', id: ids('note'),
      premise: 'An apprentice finds that the harbour key opens the wrong door.',
      logline: 'Maren must choose between the sea gate and her place in the guild.',
      theme_question: 'What does belonging cost?',
      central_conflict: 'The guild wants the key back; Maren wants to know what it opens.',
      protagonist_goal: 'Learn what the key opens.',
      stakes: 'Her place in the town.',
      protagonist: 'maren-hollis',
    },
    body: 'Free story notes.\n',
  });
  files.set('planning/arcs/maren-hollis.md', {
    fm: {
      schema: 'storyforge.arc/v1', id: ids('note'), slug: 'maren-hollis',
      character: files.get('codex/characters/maren-hollis.md').fm.id,
      arc_type: 'positive',
      want: 'To learn what the harbour key opens.',
      need: 'To trust the town that raised her.',
      false_belief: 'Belonging means obeying the guild.',
      fear: 'Being locked out for good.',
      wound: 'Her mother left without a word.',
      start_state: 'Obedient and certain.',
      end_state: 'Free and uncertain.',
      milestones: {
        block: [
          `  - scene: ${KEY}`,
          '    pressure: The harbourmaster wants the key back.',
          '    choice: She keeps the key.',
          '    belief_before: The guild will protect her.',
          '    belief_after: The guild will not.',
          '    cost: Her apprenticeship.',
          `  - scene: ${FERRY}`,
          '    pressure: The ferryman asks for a price.',
        ],
      },
    },
    body: 'Free arc notes.\n',
  });
  // Story Planner M4: one structure, three beats; the key scene sits in two beats and one beat holds two scenes
  const structureId = ids('note');
  const beatIds = [ids('note'), ids('note'), ids('note')];
  files.set('planning/structures/main-three-act.md', {
    fm: {
      schema: 'storyforge.structure/v1', id: structureId, slug: 'main-three-act', name: 'Main structure',
      template: 'three-act', template_version: 1,
      beats: {
        block: [
          `  - id: ${beatIds[0]}`,
          '    name: Opening image',
          '    purpose: Show the world before it changes.',
          '    question: What does normal look like?',
          '    position: about 1%',
          '    state: done',
          `    scenes: [${KEY}, ${FERRY}]`,
          `  - id: ${beatIds[1]}`,
          '    name: Inciting event',
          '    purpose: Something knocks the hero off the usual path.',
          `    scenes: [${KEY}]`,
          `  - id: ${beatIds[2]}`,
          '    name: Final choice',
          '    state: omitted',
        ],
      },
    },
    body: 'Free structure notes.\n',
  });
  files.get('planning/story.md').fm.primary_structure = structureId;
  // Story Planner M5: one relationship with two developments, and one link that ends at a beat of the structure
  const MAREN = files.get('codex/characters/maren-hollis.md').fm.id;
  const PELL = files.get('codex/characters/pell.md').fm.id;
  files.set('planning/relationships/maren-hollis-and-pell.md', {
    fm: {
      schema: 'storyforge.relationship/v1', id: ids('note'), slug: 'maren-hollis-and-pell', a: MAREN, b: PELL,
      baseline: 'Apprentice and ferryman, wary of each other.',
      end_state: 'Allies who owe each other.',
      developments: {
        block: [
          `  - scene: ${KEY}`,
          '    change: Pell lends Maren the key.',
          '    a_view: Maren trusts Pell a little.',
          '    b_view: Pell fears what Maren will find.',
          `  - scene: ${FERRY}`,
          '    change: Maren pays Pell for passage.',
        ],
      },
    },
    body: 'Free relationship notes.\n',
  });
  files.set('planning/links/key-enables-inciting-event.md', {
    fm: { schema: 'storyforge.link/v1', id: ids('note'), slug: 'key-enables-inciting-event', from: KEY, to: beatIds[1], relation: 'enables', created: '2026-11-06' },
    body: 'The key scene is where the inciting event lands.\n',
  });
  // Story Planner M7: one one-page synopsis with a target
  files.set('planning/synopses/one-page.md', synopsisDoc(ids, 'one-page'));
  // Story Planner M8: one clue planted in two scenes and revealed later, known to the reader and (wrongly) to Maren
  files.set('planning/clues/sea-gate-key.md', {
    fm: {
      schema: 'storyforge.clue/v1', id: ids('note'), slug: 'sea-gate-key', fact: 'The harbour key opens the sea gate.',
      kind: 'clue', planted: [SECOND_SCENE, KEY], revealed: FERRY, red_herring: false,
      knowers: {
        block: [
          '  - who: reader',
          `    scene: ${FERRY}`,
          '    how: The ferryman shows the gate.',
          `  - who: ${files.get('codex/characters/maren-hollis.md').fm.id}`,
          `    scene: ${KEY}`,
          '    how: She believes the key opens the guild door.',
          '    reliable: false',
        ],
      },
      created: '2026-11-06',
    },
    body: 'Free clue notes.\n',
  });
  checkIds(files);
  const dir = path.join(FIXTURES, 'valid', 'planner');
  writeTree(dir, files);
  fs.writeFileSync(path.join(dir, 'expected.json'), json(expected));
}
console.log('fixtures written');
