// Fixture generator for the shared-world fixtures (M07-J01): fixtures/valid/tidewater and the invalid cases for
// E210, E303, W309, W311, W312, I403, the new E102 shapes and the shared-entry link rules. NOT a test.
//
// The committed fixtures are the source of truth; this script only keeps the many small trees consistent.
// It does nothing unless run explicitly:  node test/build-world-fixtures.mjs --write
// (`node --test` also executes every file under test/, hence the guard.) IDs are deterministic; all text is synthetic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--write')) process.exit(0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');

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
const mkIds = (tag) => {
  let n = 0;
  return (prefix) => `${prefix}_${ulid(tag, ++n)}`;
};

/** @param {string[]} lines front matter lines @param {string} body */
const md = (lines, body = '') => `---\n${lines.join('\n')}\n---\n${body}`;
const lineOf = (files, rel, needle) => {
  const i = files.get(rel).split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`needle ${needle} not in ${rel}`);
  return `line ${i + 1}`;
};

const CH = 'manuscript/act-01-one/ch-001-one/';

/** A book at `prefix` ('' or 'dir/'): book.md and one scene. `extra` is merged into the scene options. */
function addBook(files, ids, prefix, { slug, title, series_number, bookFm = [], scene = {} }) {
  files.set(`${prefix}book.md`, md([
    'schema: storyforge.book/v1', `id: ${ids('book')}`, `slug: ${slug}`, `title: ${title}`,
    ...(series_number ? [`series_number: ${series_number}`] : []),
    'profile: fiction', 'status: drafting', ...bookFm,
  ], 'A synthetic book.\n'));
  files.set(`${prefix}${CH}0010-${scene.file ?? 'scene'}.md`, md([
    'schema: storyforge.scene/v1', `id: ${ids('scene')}`, `title: ${scene.title ?? 'Scene'}`, 'act: 1', 'chapter: 1', 'sequence: 10', 'status: drafting',
    ...(scene.fm ?? []),
  ], scene.body ?? 'The tide went out before dawn.\n'));
}

const entry = (ids, { slug, type, name, fm = [], body = '' }) => md([
  'schema: storyforge.entry/v1', `id: ${ids('entry')}`, `slug: ${slug}`, `type: ${type}`, `name: ${name}`, 'status: canon', ...fm,
], body);
const seriesMd = (ids, slug, extra = []) => md(['schema: storyforge.series/v1', `id: ${ids('series')}`, `slug: ${slug}`, 'title: The Tidewater Books', 'status: active', ...extra], 'A synthetic series.\n');
const vesselType = (ids, fieldLines) => md([
  'schema: storyforge.codex-type/v1', `id: ${ids('note')}`, 'type: vessel', 'name: Vessel', 'plural: Vessels', 'fields:', ...fieldLines,
], 'Ships and boats.\n');
const bookLabels = ['labels:', '  - name: Known', '    color: "#3A5F7D"'];

function writeTree(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}
const D = (code, file, location) => ({ code, file, location });
const writeExpected = (root, diagnostics) => fs.writeFileSync(path.join(root, 'expected.json'), `${JSON.stringify({ diagnostics }, null, 2)}\n`);

// ---------------------------------------------------------------- valid/tidewater
{
  const ids = mkIds('W1');
  const files = new Map();
  files.set('library.md', md(['schema: storyforge.library/v1', `id: ${ids('lib')}`, 'title: Tidewater Library'], 'A library with one shared series world.\n'));

  // the library template (laid out like packages/templates/templates/<name>/)
  files.set('_templates/mystery-arc/template.md', md([
    'schema: storyforge.template/v1', 'name: mystery-arc', 'title: Mystery arc', 'description: One act, one chapter and a mystery thread to follow.',
    'beats:', '  - The crime', '  - The clue',
  ], 'A small mystery structure saved from a book.\n'));
  files.set('_templates/mystery-arc/book/book.md', md([
    'schema: storyforge.book/v1', 'id: {{id:book}}', 'slug: {{book_slug}}', 'title: {{book_title}}', 'series_number: {{series_number}}', 'pen_name: {{pen_name}}',
    'profile: fiction', 'status: planning', 'language: en',
  ]));
  files.set('_templates/mystery-arc/book/manuscript/act-01-clues/act.md', md(['schema: storyforge.act/v1', 'id: {{id:act-01}}', 'act: 1', 'title: Clues']));
  files.set('_templates/mystery-arc/book/manuscript/act-01-clues/ch-001-the-crime/0010-the-crime.md', md([
    'schema: storyforge.scene/v1', 'id: {{id:scene-01}}', 'title: The crime', 'act: 1', 'chapter: 1', 'sequence: 10', 'status: outline',
  ]));
  files.set('_templates/mystery-arc/book/planning/threads/the-mystery.md', md([
    'schema: storyforge.thread/v1', 'id: {{id:thread-mystery}}', 'slug: the-mystery', 'title: The mystery', 'kind: mystery', 'status: planned',
  ]));

  // the series and its shared world
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater', [
    'labels:', '  - name: Mystery', '    color: "#B5446E"', '  - name: Backstory', '    color: "#3A5F7D"',
  ]));
  files.set('tidewater/codex/characters/ilse-hollis.md', entry(ids, {
    slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis', fm: [
      'aliases: [Aunt Ilse]', 'role: Keeper of the lamp', 'labels: [Mystery]', 'fields:', '  Age: 61', '  Home: "[[port-aldine]]"',
      'related:', '  - to: port-aldine', '    as: lives at',
    ],
    body: '## Overview\nIlse kept the lamp at [[port-aldine]]. What she left behind is chased in [[low-tide:the-lost-ledger]].\n',
  }));
  files.set('tidewater/codex/locations/port-aldine.md', entry(ids, {
    slug: 'port-aldine', type: 'location', name: 'Port Aldine', body: '## Overview\nA harbour town of salt and rope.\n',
  }));
  files.set('tidewater/codex/_types/vessel.md', vesselType(ids, [
    '  - Master',
    '  - label: Tonnage', '    kind: number',
    '  - label: Launched', '    kind: date',
    '  - label: Home port', '    kind: link',
    '  - label: Rig', '    kind: choice', '    choices: [sloop, ketch, schooner]',
    '  - label: Cargoes', '    kind: list',
    '  - label: Notes', '    kind: text',
  ]));

  // book one: references the shared entries by bare slug, has no copy of them
  addBook(files, ids, 'tidewater/salt-orchard-2/', {
    slug: 'salt-orchard-2', title: 'Salt Orchard Two', series_number: 1,
    bookFm: ['labels:', '  - name: Draft Two', '    color: "#2E7D32"'],
    scene: {
      file: 'arrival', title: 'Arrival',
      fm: ['pov: ilse-hollis', 'characters: [ilse-hollis]', 'locations: [port-aldine]', 'labels: [Mystery, Draft Two]'],
      body: 'Maren stepped onto the quay where [[ilse-hollis]] waited.\n\nLater she would ask about [[low-tide:the-lost-ledger]].\n',
    },
  });
  files.set('tidewater/salt-orchard-2/codex/characters/maren-hollis.md', entry(ids, {
    slug: 'maren-hollis', type: 'character', name: 'Maren Hollis', fm: ['labels: [Backstory]', 'related:', '  - to: ilse-hollis', '    as: aunt'],
    body: '## Overview\nCartographer, niece of [[ilse-hollis]].\n',
  }));
  files.set('tidewater/salt-orchard-2/codex/vessels/gull-and-ledger.md', entry(ids, {
    slug: 'gull-and-ledger', type: 'vessel', name: 'Gull and Ledger', fm: [
      'fields:', '  Master: Captain Pell', '  Tonnage: 42', '  Launched: "1891-04-12"', '  Home port: "[[port-aldine]]"', '  Rig: ketch', '  Cargoes: [salt, tar]', '  Notes: Leaks in a swell.',
    ],
  }));

  // book two: also uses ilse-hollis by bare slug; shadows port-aldine with a local entry (W309) and owns the thread the other book links to
  addBook(files, ids, 'tidewater/low-tide/', {
    slug: 'low-tide', title: 'Low Tide', series_number: 2,
    scene: {
      file: 'ebb', title: 'Ebb',
      fm: ['pov: ilse-hollis', 'characters: [ilse-hollis]', 'locations: [port-aldine]', 'plot_threads: [the-lost-ledger]'],
      body: '[[ilse-hollis]] opened the ledger. The shared harbour, [[tidewater:port-aldine]], showed in its first page.\n',
    },
  });
  files.set('tidewater/low-tide/codex/locations/port-aldine.md', entry(ids, {
    slug: 'port-aldine', type: 'location', name: 'Port Aldine (as it is in this book)', body: '## Overview\nThis book rebuilds the harbour after a storm.\n',
  }));
  files.set('tidewater/low-tide/planning/threads/the-lost-ledger.md', md([
    'schema: storyforge.thread/v1', `id: ${ids('thread')}`, 'slug: the-lost-ledger', 'title: The lost ledger', 'kind: mystery', 'status: planned', 'labels: [Mystery]',
  ], 'Where did the ledger go?\n'));

  // a standalone book outside the series: it must not see the shared entries
  addBook(files, ids, 'pilgrims-road/', {
    slug: 'pilgrims-road', title: 'Pilgrims Road',
    scene: { file: 'start', title: 'Start', fm: ['pov: captain-vane', 'characters: [captain-vane]'], body: 'Captain Vane set out at first light.\n' },
  });
  files.set('pilgrims-road/codex/characters/captain-vane.md', entry(ids, { slug: 'captain-vane', type: 'character', name: 'Captain Vane', body: '## Overview\nA walker.\n' }));

  const root = path.join(FIXTURES, 'valid/tidewater');
  writeTree(root, files);
  writeExpected(root, [D('W309', 'tidewater/low-tide/codex/locations/port-aldine.md', 'slug')]);
}

// ---------------------------------------------------------------- invalid cases
const invalid = {};
invalid['E210-book-series-slug'] = () => {
  const ids = mkIds('W2');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'tidewater', title: 'Book One', series_number: 1 });
  return { files, expected: [D('E210', 'tidewater/series.md', 'slug'), D('E210', 'tidewater/book-one/book.md', 'slug')] };
};

invalid['E303-cross-book-missing'] = () => {
  const ids = mkIds('W3');
  const files = new Map();
  addBook(files, ids, 'book-a/', { slug: 'book-a', title: 'Book A', scene: { file: 'a', body: 'See [[book-b:nobody]].\n\nAnd also [[nowhere:anyone]].\n' } });
  addBook(files, ids, 'book-b/', { slug: 'book-b', title: 'Book B' });
  const f = 'book-a/' + CH + '0010-a.md';
  return { files, expected: [D('E303', f, lineOf(files, f, '[[book-b:nobody]]')), D('E303', f, lineOf(files, f, '[[nowhere:anyone]]'))] };
};

invalid['W311-unknown-label'] = () => {
  const ids = mkIds('W4');
  const files = new Map();
  addBook(files, ids, '', { slug: 'mini-book', title: 'Mini Book', bookFm: bookLabels, scene: { fm: ['labels: [Known, Missing]'] } });
  return { files, expected: [D('W311', `${CH}0010-scene.md`, 'labels[1]')] };
};

invalid['W312-field-kind'] = () => {
  const ids = mkIds('W5');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  files.set('tidewater/codex/_types/vessel.md', vesselType(ids, ['  - label: Tonnage', '    kind: number']));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'book-one', title: 'Book One', series_number: 1 });
  files.set('tidewater/book-one/codex/vessels/heron.md', entry(ids, { slug: 'heron', type: 'vessel', name: 'Heron', fm: ['fields:', '  Tonnage: heavy'] }));
  return { files, expected: [D('W312', 'tidewater/book-one/codex/vessels/heron.md', 'fields.Tonnage')] };
};

invalid['W309-shadowed-entry'] = () => {
  const ids = mkIds('W6');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  files.set('tidewater/codex/characters/ilse-hollis.md', entry(ids, { slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis' }));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'book-one', title: 'Book One', series_number: 1 });
  files.set('tidewater/book-one/codex/characters/ilse-hollis.md', entry(ids, { slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis (local)' }));
  return { files, expected: [D('W309', 'tidewater/book-one/codex/characters/ilse-hollis.md', 'slug')] };
};

invalid['I403-type-override'] = () => {
  const ids = mkIds('W7');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  files.set('tidewater/codex/_types/vessel.md', vesselType(ids, ['  - label: Tonnage', '    kind: number']));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'book-one', title: 'Book One', series_number: 1 });
  files.set('tidewater/book-one/codex/_types/vessel.md', vesselType(ids, ['  - Master']));
  return { files, expected: [D('I403', 'tidewater/book-one/codex/_types/vessel.md', 'type')] };
};

invalid['E102-label-duplicate'] = () => {
  const ids = mkIds('W8');
  const files = new Map();
  addBook(files, ids, '', { slug: 'mini-book', title: 'Mini Book', bookFm: ['labels:', '  - name: Mystery', '    color: "#B5446E"', '  - name: mystery', '    color: "#3A5F7D"'] });
  return { files, expected: [D('E102', 'book.md', 'labels[1].name')] };
};

invalid['E102-label-color'] = () => {
  const ids = mkIds('W9');
  const files = new Map();
  addBook(files, ids, '', { slug: 'mini-book', title: 'Mini Book', bookFm: ['labels:', '  - name: Mystery', '    color: red'] });
  return { files, expected: [D('E102', 'book.md', 'labels[0].color')] };
};

invalid['E102-field-kind'] = () => {
  const ids = mkIds('WA');
  const files = new Map();
  addBook(files, ids, '', { slug: 'mini-book', title: 'Mini Book' });
  files.set('codex/_types/vessel.md', vesselType(ids, ['  - label: Price', '    kind: money']));
  return { files, expected: [D('E102', 'codex/_types/vessel.md', 'fields[0]')] };
};

invalid['E102-field-choices'] = () => {
  const ids = mkIds('WB');
  const files = new Map();
  addBook(files, ids, '', { slug: 'mini-book', title: 'Mini Book' });
  files.set('codex/_types/vessel.md', vesselType(ids, ['  - Master', '  - label: Rig', '    kind: choice']));
  return { files, expected: [D('E102', 'codex/_types/vessel.md', 'fields[1]')] };
};

invalid['E102-template-shape'] = () => {
  const ids = mkIds('WC');
  const files = new Map();
  files.set('library.md', md(['schema: storyforge.library/v1', `id: ${ids('lib')}`, 'title: Library']));
  files.set('_templates/broken/template.md', md(['schema: storyforge.template/v1', 'name: broken', 'title: Broken']));
  files.set('_templates/broken/book/book.md', md(['schema: storyforge.book/v1', 'id: {{id:book}}', 'slug: {{book_slug}}', 'title: {{book_title}}', 'profile: fiction', 'status: planning']));
  return { files, expected: [D('E102', '_templates/broken/template.md', 'description')] };
};

invalid['E301-shared-private-link'] = () => {
  const ids = mkIds('WD');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  files.set('tidewater/codex/characters/ilse-hollis.md', entry(ids, {
    slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis', body: '## Overview\nShe is close to [[maren-hollis]], who lives in one book only.\n',
  }));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'book-one', title: 'Book One', series_number: 1 });
  files.set('tidewater/book-one/codex/characters/maren-hollis.md', entry(ids, { slug: 'maren-hollis', type: 'character', name: 'Maren Hollis' }));
  const f = 'tidewater/codex/characters/ilse-hollis.md';
  return { files, expected: [D('E301', f, lineOf(files, f, '[[maren-hollis]]'))] };
};

invalid['E302-cross-book-reference'] = () => {
  const ids = mkIds('WE');
  const files = new Map();
  addBook(files, ids, 'book-a/', { slug: 'book-a', title: 'Book A', scene: { fm: ['characters: ["book-b:someone"]'] } });
  addBook(files, ids, 'book-b/', { slug: 'book-b', title: 'Book B' });
  files.set('book-b/codex/characters/someone.md', entry(ids, { slug: 'someone', type: 'character', name: 'Someone' }));
  return { files, expected: [D('E302', `book-a/${CH}0010-scene.md`, 'characters[0]')] };
};

invalid['E208-shared-duplicate-slug'] = () => {
  const ids = mkIds('WF');
  const files = new Map();
  files.set('tidewater/series.md', seriesMd(ids, 'tidewater'));
  files.set('tidewater/codex/characters/ilse-hollis.md', entry(ids, { slug: 'ilse-hollis', type: 'character', name: 'Ilse Hollis' }));
  files.set('tidewater/codex/characters/ilse-hollis-again.md', entry(ids, { slug: 'ilse-hollis', type: 'character', name: 'Ilse Again' }));
  addBook(files, ids, 'tidewater/book-one/', { slug: 'book-one', title: 'Book One', series_number: 1 });
  return {
    files,
    expected: [D('E208', 'tidewater/codex/characters/ilse-hollis.md', 'slug'), D('E208', 'tidewater/codex/characters/ilse-hollis-again.md', 'slug')],
  };
};

invalid['W303-cross-book-archived'] = () => {
  const ids = mkIds('WG');
  const files = new Map();
  addBook(files, ids, 'book-a/', { slug: 'book-a', title: 'Book A', scene: { file: 'a', body: 'Remember [[book-b:old-one]].\n' } });
  addBook(files, ids, 'book-b/', { slug: 'book-b', title: 'Book B' });
  files.set('book-b/archive/codex/characters/old-one.md', entry(ids, { slug: 'old-one', type: 'character', name: 'Old One' }));
  const f = 'book-a/' + CH + '0010-a.md';
  return { files, expected: [D('W303', f, lineOf(files, f, '[[book-b:old-one]]'))] };
};

for (const [name, build] of Object.entries(invalid)) {
  const { files, expected } = build();
  const root = path.join(FIXTURES, 'invalid', name);
  writeTree(root, files);
  writeExpected(root, expected);
}
