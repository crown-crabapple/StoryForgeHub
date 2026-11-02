import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../store/src/index.mjs';
import { openIndex } from '../src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../format/fixtures');
export const INDEX_SRC = path.resolve(here, '../src');

export const SALT_BOOK = 'book_01S5000000000000000000000A';
export const SALT_ARRIVAL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const SALT_LOWTIDE = 'manuscript/act-02-high-water/ch-003-the-wall/0010-low-tide.md';
export const SALT_LOWTIDE_ID = 'scene_01S50000000000000000000008';
export const SALT_ARRIVAL_ID = 'scene_01S50000000000000000000002';
export const MAREN_ENTRY = 'entry_01S5000000000000000000000G';
export const PORT_ALDINE_ENTRY = 'entry_01S5000000000000000000000N';
export const TOBIN_ENTRY = 'entry_01S5000000000000000000000J';

/** Words planted by `plantSearchWords` (they are not in the original fixture). */
export const PLANTED = {
  accented: 'Ísle',
  japanese: '潮が引く音がした',
  commentOnly: 'zephyrcomment',
  codeOnly: 'quokkacode',
};

/** Copy a fixture (e.g. 'valid/salt-orchard') into a fresh temp dir; returns its path. */
export async function copyFixture(rel) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-idx-'));
  const dest = path.join(base, path.basename(rel));
  await fs.cp(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}

export async function readExpected(rel) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, rel, 'expected.json'), 'utf8'));
}

/** Book roots inside a copied fixture (the library fixture holds several books). */
export function bookRootsOf(fixtureRel, copyRoot) {
  if (fixtureRel === 'valid/library') {
    return [
      path.join(copyRoot, 'lantern-hill'),
      path.join(copyRoot, 'tidewater', 'tidewater-one'),
      path.join(copyRoot, 'tidewater', 'tidewater-two'),
    ];
  }
  return [copyRoot];
}

export const ALL_FIXTURES = ['valid/salt-orchard', 'valid/library', 'valid/spec-example'];

/** Open an index for a book root with its own store. */
export async function openFor(bookRoot) {
  const store = await openStore(bookRoot);
  const idx = openIndex(bookRoot, { store });
  return { store, idx, dbPath: dbPathOf(bookRoot) };
}

export const dbPathOf = (bookRoot) => path.join(bookRoot, '.storyforge', 'index.sqlite');

/** Append planted search text to a scene of a salt-orchard copy (before any index is built). */
export async function plantSearchWords(root) {
  const file = path.join(root, ...SALT_ARRIVAL.split('/'));
  const extra =
    '\n\nThe Ísle keeper hummed a tune.\n\n' +
    `${PLANTED.japanese}。\n\n` +
    `<!-- ${PLANTED.commentOnly} hidden note -->\n\n` +
    '```\n' + `${PLANTED.codeOnly}()\n` + '```\n';
  await fs.appendFile(file, extra, 'utf8');
}

/**
 * Every table of an index file as sorted JSON strings, excluding `meta.built_at` and the FTS
 * shadow tables (their segment layout legitimately differs between build paths; the `fts`
 * table itself is dumped by content).
 */
export function dumpTables(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name")
      .all()
      .map((r) => r.name);
    const isShadow = (n) => names.some((o) => o !== n && n.startsWith(`${o}_`) && ['data', 'idx', 'content', 'docsize', 'config'].includes(n.slice(o.length + 1)));
    const out = {};
    for (const name of names) {
      if (isShadow(name)) continue;
      let rows;
      if (name === 'fts') {
        rows = db.prepare('SELECT id, kind, title, body FROM fts').all();
      } else {
        rows = db.prepare(`SELECT * FROM "${name}"`).all();
      }
      if (name === 'meta') rows = rows.filter((r) => r.key !== 'built_at');
      out[name] = rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))).sort();
    }
    return out;
  } finally {
    db.close();
  }
}

/** Plain-JSON copy so results compare structurally whatever prototype the index returns. */
export const plain = (v) => JSON.parse(JSON.stringify(v));

/** Sorted-by-JSON copy, for result sets whose order is not part of the contract. */
export const sortedJson = (rows) => plain(rows).map((r) => JSON.stringify(r)).sort();
