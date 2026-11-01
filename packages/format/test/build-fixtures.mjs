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
    files,
    expected: {
      diagnostics: [],
      order,
      timeline: ['the-first-grafting', 'the-flood', 'the-key-found-twice', 'the-return', 'the-wall-falls'],
      excluded,
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
console.log('fixtures written');
