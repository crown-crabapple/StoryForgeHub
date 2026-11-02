// Generator for fixtures/valid/covers. NOT a test.
// Does nothing unless run explicitly:  node test/build-covers-fixture.mjs --write
// (`node --test` also executes every file under test/, hence the guard.)
// All text is synthetic. IDs are counter based. The PNG is a solid-colour
// 200x300 image built with node:zlib (deterministic, no randomness).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--write')) process.exit(0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../fixtures/valid/covers');

let n = 0;
const id = (prefix) => `${prefix}_01V3${String(++n).padStart(22, '0')}`;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = new Map();
const put = (rel, content) => files.set(rel, content);
const fm = (lines, body) => `---\n${lines.join('\n')}\n---\n${body}\n`;

put('library.md', fm([
  'schema: storyforge.library/v1', `id: ${id('lib')}`, 'title: Synthetic Cover Library',
  'pen_names:', '  - name: R. Fenwick', '    slug: r-fenwick', '  - name: A. Marsh', '    slug: a-marsh',
], ''));
put('expected.json', JSON.stringify({ diagnostics: [] }, null, 2) + '\n');
put('harbour-lights/series.md', fm([
  'schema: storyforge.series/v1', `id: ${id('series')}`, 'slug: harbour-lights', 'title: Harbour Lights', 'status: active',
], ''));

function book(dir, slug, title, extra, blurb) {
  put(`${dir}/book.md`, fm([
    'schema: storyforge.book/v1', `id: ${id('book')}`, `slug: ${slug}`, `title: ${title}`,
    'profile: fiction', ...extra,
  ], blurb));
  put(`${dir}/codex/characters/${slug}-keeper.md`, fm([
    'schema: storyforge.entry/v1', `id: ${id('entry')}`, `slug: ${slug}-keeper`, 'type: character',
    `name: Keeper of ${title}`, 'status: canon',
  ], '## Overview\nA synthetic lamp keeper.'));
  const sc = `${dir}/manuscript/act-01-one/ch-001-one`;
  [['0010-a.md', 'First', 10], ['0020-b.md', 'Second', 20]].forEach(([f, t, seq]) => {
    put(`${sc}/${f}`, fm([
      'schema: storyforge.scene/v1', `id: ${id('scene')}`, `title: ${t}`, 'act: 1', 'chapter: 1',
      `sequence: ${seq}`, 'status: drafting',
    ], `A synthetic line for ${title}, scene ${t}.`));
  });
}

book('harbour-lights/first-light', 'first-light', 'First Light', [
  'status: drafting', 'series_number: 1', 'pen_name: r-fenwick', 'subtitle: The Beacon Is Lit',
  'genre: [mystery, coastal]', 'word_target: 90000', 'language: en', 'cover: assets/cover.png',
], 'The beacon was lit at dusk.\n\nA second paragraph that is not the blurb.');
book('harbour-lights/second-light', 'second-light', 'Second Light', [
  'status: planning', 'series_number: 2', 'pen_name: r-fenwick', 'cover_color: "#2F4A3A"',
], 'The fog rolled in.');
book('north-road', 'north-road', 'North Road', [
  'status: revising', 'pen_name: a-marsh', 'word_target: 60000',
], 'A long road north.');
book('old-draft', 'old-draft', 'Old Draft', ['status: archived'], 'Shelved long ago.');
book('lost-cover', 'lost-cover', 'Lost Cover', ['status: drafting', 'cover: assets/missing.png'], 'The art went missing.');
book('svg-cover', 'svg-cover', 'Svg Cover', ['status: drafting', 'cover: assets/cover.svg'], 'Vector art is not served.');

put('harbour-lights/first-light/assets/cover.png', solidPng(200, 300, [0x3a, 0x5f, 0x7d]));
put('svg-cover/assets/cover.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#3A5F7D"/></svg>\n');

fs.rmSync(ROOT, { recursive: true, force: true });
for (const [rel, content] of files) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
console.log(`wrote ${files.size} files to ${ROOT}`);
