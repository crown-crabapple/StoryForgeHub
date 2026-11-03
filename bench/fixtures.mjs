// The benchmark fixtures (M08-J04 contract section 4). All synthetic and generated into a temp folder; nothing here is user text and nothing generated is committed.
//
//   S   the salt-orchard sample (the committed sample book, copied)
//   M   1 book, 60 chapters, 320 scenes, about 130,000 words (the M06-J03 large book, packages/format/test/build-large.mjs)
//   L   3 books of M in one series ("tidewater-bench") with 200 shared entries
//   XL  1 book, 1,500 scenes, about 600,000 words (bench/gen-book.mjs)
//
// Each fixture: { name, root (the library folder), bookRoot, bookId, sceneIds, scenePaths, searchTerm, books, description }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLargeBook } from '../packages/format/test/build-large.mjs';
import { generateBook, ulid } from './gen-book.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE = path.resolve(here, '../packages/format/fixtures/valid/salt-orchard');
export const FIXTURE_NAMES = ['S', 'M', 'L', 'XL'];

const ID_RE = /\b(book|act|chap|scene|entry|thread|event|note|rcpt)_01([A-Z]{2}[0-9A-Z]{22})\b/g;

/** Every .md file under `dir` (recursive). @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Scene ids and paths of a book, read from its files (relative to the book folder). @param {string} bookRoot */
export function readScenes(bookRoot) {
  const ids = [];
  const paths = [];
  const base = path.join(bookRoot, 'manuscript');
  if (!fs.existsSync(base)) return { ids, paths };
  for (const file of markdownFiles(base).sort()) {
    const name = path.basename(file);
    if (name === 'act.md' || name === 'chapter.md') continue;
    const m = /^id:\s*(scene_\S+)/m.exec(fs.readFileSync(file, 'utf8').slice(0, 600));
    if (m) {
      ids.push(m[1]);
      paths.push(path.relative(bookRoot, file).split(path.sep).join('/'));
    }
  }
  return { ids, paths };
}

/** Size of a fixture: books, files, bytes, scenes, words (whitespace-separated words of the scene bodies). @param {string} libraryRoot @param {string[]} bookRoots */
export function measureSize(libraryRoot, bookRoots) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(libraryRoot);
  let scenes = 0;
  let words = 0;
  for (const b of bookRoots) {
    for (const rel of readScenes(b).paths) {
      const text = fs.readFileSync(path.join(b, ...rel.split('/')), 'utf8');
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      scenes++;
      words += body.split(/\s+/).filter(Boolean).length;
    }
  }
  return { books: bookRoots.length, files, bytes, scenes, words };
}

/** @param {string} dir an empty temp folder */
export function makeS(dir) {
  const root = path.join(dir, 'salt-orchard');
  fs.cpSync(SAMPLE, root, { recursive: true });
  const { ids, paths } = readScenes(root);
  const bookId = /^id:\s*(book_\S+)/m.exec(fs.readFileSync(path.join(root, 'book.md'), 'utf8'))?.[1];
  return { name: 'S', description: 'the salt-orchard sample', root, bookRoots: [root], bookRoot: root, bookId, sceneIds: ids, scenePaths: paths, searchTerm: 'orchard' };
}

/** @param {string} dir an empty temp folder */
export function makeM(dir) {
  const { root, bookId } = buildLargeBook(path.join(dir, 'large-book'));
  const { ids, paths } = readScenes(root);
  return { name: 'M', description: '1 book, 60 chapters, 320 scenes, about 130k words', root, bookRoots: [root], bookRoot: root, bookId, sceneIds: ids, scenePaths: paths, searchTerm: 'harbour' };
}

/**
 * 3 books of M in one series with 200 shared entries. Copies 2 and 3 get their own ids and slug so the library validates clean (the same trick as perf-read.large.mjs).
 * @param {string} dir an empty temp folder
 */
export function makeL(dir) {
  const base = buildLargeBook(path.join(dir, 'source-book')).root;
  const lib = path.join(dir, 'library');
  const series = path.join(lib, 'tidewater-bench');
  fs.mkdirSync(series, { recursive: true });
  fs.writeFileSync(path.join(lib, 'library.md'), '---\nschema: storyforge.library/v1\nid: lib_01BN0000000000000000000001\ntitle: Benchmark Library\n---\nA synthetic library.\n');
  fs.writeFileSync(path.join(series, 'series.md'), '---\nschema: storyforge.series/v1\nid: series_01BN0000000000000000000002\nslug: tidewater-bench\ntitle: The Benchmark Books\nstatus: active\n---\nA synthetic series.\n');
  const bookRoots = [];
  for (let k = 1; k <= 3; k++) {
    const dest = path.join(series, `large-${k}`);
    fs.cpSync(base, dest, { recursive: true });
    bookRoots.push(dest);
    if (k > 1) {
      for (const file of markdownFiles(dest)) {
        let text = fs.readFileSync(file, 'utf8');
        text = text.replace(ID_RE, (_m, kind, rest) => `${kind}_0${k}${rest}`);
        if (path.basename(file) === 'book.md' && path.dirname(file) === dest) text = text.replace(/^slug: large-book$/m, `slug: large-book-${k}`);
        fs.writeFileSync(file, text);
      }
    }
    const bookMd = path.join(dest, 'book.md');
    fs.writeFileSync(bookMd, fs.readFileSync(bookMd, 'utf8').replace(/^language: en$/m, `series_number: ${k}\nlanguage: en`));
  }
  // 200 shared entries in the series' own Codex
  const FOLDER = { character: 'characters', location: 'locations' };
  for (let i = 1; i <= 200; i++) {
    const type = i <= 120 ? 'character' : 'location';
    const slug = `shared-${String(i).padStart(3, '0')}`;
    const file = path.join(series, 'codex', FOLDER[type], `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['---', 'schema: storyforge.entry/v1', `id: entry_${ulid('SH', i)}`, `slug: ${slug}`, `type: ${type}`, `name: Shared ${i}`, 'status: canon', '---', '## Overview', `Shared entry number ${i} of the series.`, ''].join('\n'));
  }
  const first = bookRoots[0];
  const { ids, paths } = readScenes(first);
  const bookId = /^id:\s*(book_\S+)/m.exec(fs.readFileSync(path.join(first, 'book.md'), 'utf8'))?.[1];
  return { name: 'L', description: '3 books of M in one series, 200 shared entries', root: lib, bookRoots, bookRoot: first, bookId, sceneIds: ids, scenePaths: paths, searchTerm: 'harbour' };
}

/** @param {string} dir an empty temp folder */
export function makeXL(dir) {
  const { root, stats } = generateBook(path.join(dir, 'xl-book'), { chapters: 150, scenesPerChapter: 10, wordsPerScene: 400 });
  return { name: 'XL', description: '1 book, 1,500 scenes, about 600k words', root, bookRoots: [root], bookRoot: root, bookId: stats.bookId, sceneIds: stats.sceneIds, scenePaths: stats.scenePaths, searchTerm: 'harbour' };
}

export const MAKERS = { S: makeS, M: makeM, L: makeL, XL: makeXL };
