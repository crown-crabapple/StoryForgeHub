// M04-J04 acceptance 6: attachments are portable and the upload / serve routes are safe.
//   POST /api/books/:b/attachments?name=<file name>   raw bytes, write-guarded (x-storyforge: 1) -> { path, markdown }
//   GET  /api/books/:b/attachments?path=assets/...    only allowed files under assets/
// Contract: docs/contracts/M04-J04-timeline-research.md section 4 and acceptance 6. Safety pattern: cover-route and
// entry-image-route tests (M02-J02 / M04-J02).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { BOOK, closeAll, freshBook, readAll } from './move-helpers.mjs';

after(closeAll);

const SECRET = 'SECRET-OUTSIDE-BYTES';
const base = `/api/books/${BOOK}/attachments`;
const NOTE = 'research/tidal-ranges.md'; // exists in salt-orchard
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

/** Raw request with a Buffer body; tolerates a server that answers (413) before reading the whole body. */
function raw(port, method, pathname, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = body.length;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        finish({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (!done) reject(e); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const GUARD = (type = 'application/octet-stream') => ({ 'x-storyforge': '1', 'content-type': type });
const upload = (port, name, body, headers = GUARD()) =>
  raw(port, 'POST', `${base}?name=${encodeURIComponent(name)}`, { headers, body });
const get = (port, p, opts) => raw(port, 'GET', `${base}?path=${p}`, opts);
const ok = (r) => assert.ok(r.status === 200 || r.status === 201, `${r.status}: ${r.text.slice(0, 300)}`);
const exists = (root, rel) => fs.stat(path.join(root, ...rel.split('/'))).then(() => true, () => false);
const bytes = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')));
const diagKeys = async (root) => (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`).sort();
const linkTarget = (markdown) => /\]\(([^)]+)\)/.exec(markdown)?.[1];
const same = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of paths');
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical`);
};

// ---------------------------------------------------------------- upload: stored path and link

test('upload stores the bytes at assets/research/<name> and returns a path and a link relative to the note folder', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'map.png', PNG, GUARD('image/png'));
  ok(r);
  assert.equal(r.json.path, 'assets/research/map.png');
  assert.ok((await bytes(root, 'assets/research/map.png')).equals(PNG));
  assert.equal(typeof r.json.markdown, 'string');
  assert.equal(linkTarget(r.json.markdown), '../assets/research/map.png');
  assert.equal(path.posix.resolve('/book/research', linkTarget(r.json.markdown)), '/book/assets/research/map.png');
});

test('upload adds exactly one file to the book and writes nothing outside it', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  const outerBefore = await fs.readdir(path.dirname(root));
  ok(await upload(port, 'notes.txt', Buffer.from('plain text\n'), GUARD('text/plain')));
  const after = await readAll(root);
  assert.deepEqual([...after.keys()].filter((p) => !before.has(p)), ['assets/research/notes.txt']);
  for (const [p, buf] of before) assert.ok(after.get(p).equals(buf), `${p} untouched`);
  assert.deepEqual(await fs.readdir(path.dirname(root)), outerBefore, 'no sibling files created outside the book');
});

test('every allowed extension is accepted and stored under its own name', async () => {
  const { port, root } = await freshBook();
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv']) {
    const body = Buffer.from(`content for ${ext}\n`);
    const r = await upload(port, `file.${ext}`, body);
    ok(r);
    assert.equal(r.json.path, `assets/research/file.${ext}`);
    assert.ok((await bytes(root, r.json.path)).equals(body), ext);
  }
});

test('an upper-case extension is accepted and normalised to lower case', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'PHOTO.JPG', Buffer.from([1, 2, 3]));
  ok(r);
  assert.equal(r.json.path, 'assets/research/photo.jpg');
  assert.ok(await exists(root, 'assets/research/photo.jpg'));
});

test('binary bytes survive unchanged (every byte value, no text re-encoding)', async () => {
  const { port, root } = await freshBook();
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const r = await upload(port, 'all.pdf', all);
  ok(r);
  assert.ok((await bytes(root, r.json.path)).equals(all));
});

// ---------------------------------------------------------------- upload: safe names

const SAFE = /^assets\/research\/[a-z0-9._-]+$/;

test('safe name: spaces and upper case become [a-z0-9._-]', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'My Harbour Map.PNG', PNG);
  ok(r);
  assert.match(r.json.path, /^assets\/research\/my[-_.]?harbour[-_.]?map\.png$/);
  assert.ok(await exists(root, r.json.path));
});

test('safe name: unicode names are reduced to the safe alphabet and keep their extension', async () => {
  const { port, root } = await freshBook();
  for (const name of ['café ñandú.png', '地図.png', 'émile — résumé.pdf']) {
    const r = await upload(port, name, PNG);
    ok(r);
    assert.match(r.json.path, SAFE, name);
    assert.equal(path.posix.extname(r.json.path), path.posix.extname(name).toLowerCase(), name);
    assert.ok(path.posix.basename(r.json.path, path.posix.extname(r.json.path)).length > 0, `${name}: stem not empty`);
    assert.ok(await exists(root, r.json.path), name);
  }
});

test('safe name: ../ and ..\\ and absolute prefixes cannot leave assets/research/', async () => {
  const { port, root } = await freshBook();
  for (const name of ['../../evil.png', '..\\..\\evil.png', '../evil.png', '/etc/evil.png', 'C:\\Windows\\evil.png', 'a/b/evil.png', 'assets/../../evil.png']) {
    const before = await readAll(root);
    const outer = await fs.readdir(path.dirname(root));
    const r = await upload(port, name, PNG);
    if (r.status >= 400) {
      assert.ok(r.status < 500, `${name}: ${r.status}`);
      same(before, await readAll(root));
    } else {
      assert.match(r.json.path, SAFE, name);
      assert.ok(!r.json.path.includes('..'), name);
      assert.ok((await bytes(root, r.json.path)).equals(PNG), name);
      const after = await readAll(root);
      assert.equal([...after.keys()].filter((p) => !before.has(p)).length, 1, `${name}: exactly one new file`);
    }
    assert.deepEqual(await fs.readdir(path.dirname(root)), outer, `${name}: nothing created beside the book`);
    assert.ok(!(await exists(path.dirname(root), 'evil.png')), name);
    assert.ok(!(await exists(root, 'evil.png')), name);
    assert.ok(!(await exists(root, 'assets/evil.png')), name);
  }
});

test('safe name: Windows reserved device names are not used as file names', async () => {
  const { port, root } = await freshBook();
  for (const name of ['CON.txt', 'nul.png', 'COM1.pdf', 'lpt1.md', 'aux.csv', 'con']) {
    const r = await upload(port, name, Buffer.from('x'));
    if (r.status >= 400) {
      assert.ok(r.status < 500, `${name}: ${r.status}`);
      continue;
    }
    assert.match(r.json.path, SAFE, name);
    const stem = path.posix.basename(r.json.path).split('.')[0];
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem), `${name} stored as device name ${stem}`);
    assert.ok((await bytes(root, r.json.path)).equals(Buffer.from('x')), name);
  }
});

test('safe name: a very long name is shortened to something the file system accepts and keeps its extension', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, `${'long-name-'.repeat(60)}.png`, PNG);
  ok(r);
  assert.match(r.json.path, SAFE);
  assert.ok(path.posix.basename(r.json.path).length <= 255);
  assert.ok(r.json.path.endsWith('.png'));
  assert.ok((await bytes(root, r.json.path)).equals(PNG));
});

test('safe name: dots and dashes only is not an empty or hidden file name', async () => {
  const { port } = await freshBook();
  const r = await upload(port, '...png', PNG);
  if (r.status < 400) {
    assert.match(r.json.path, SAFE);
    assert.ok(!path.posix.basename(r.json.path).startsWith('.'), 'no hidden file');
  } else {
    assert.ok(r.status < 500);
  }
});

// ---------------------------------------------------------------- upload: collisions

test('collisions get -2, -3 and never overwrite; a name that differs only by case collides too', async () => {
  const { port, root } = await freshBook();
  const a = await upload(port, 'map.pdf', Buffer.from('first'));
  const b = await upload(port, 'map.pdf', Buffer.from('second'));
  const c = await upload(port, 'map.pdf', Buffer.from('third'));
  const d = await upload(port, 'MAP.PDF', Buffer.from('fourth'));
  for (const r of [a, b, c, d]) ok(r);
  assert.deepEqual([a, b, c].map((r) => r.json.path), ['assets/research/map.pdf', 'assets/research/map-2.pdf', 'assets/research/map-3.pdf']);
  assert.equal(d.json.path, 'assets/research/map-4.pdf');
  assert.equal((await bytes(root, 'assets/research/map.pdf')).toString(), 'first');
  assert.equal((await bytes(root, 'assets/research/map-2.pdf')).toString(), 'second');
  assert.equal((await bytes(root, 'assets/research/map-3.pdf')).toString(), 'third');
  assert.equal((await bytes(root, 'assets/research/map-4.pdf')).toString(), 'fourth');
});

test('collision with a file that already exists on disk is honoured', async () => {
  const { port, root } = await freshBook('valid/salt-orchard', async (r) => {
    await fs.mkdir(path.join(r, 'assets', 'research'), { recursive: true });
    await fs.writeFile(path.join(r, 'assets', 'research', 'chart.png'), 'ORIGINAL');
  });
  const r = await upload(port, 'chart.png', PNG);
  ok(r);
  assert.equal(r.json.path, 'assets/research/chart-2.png');
  assert.equal((await bytes(root, 'assets/research/chart.png')).toString(), 'ORIGINAL');
});

test('simultaneous uploads of one name end up as distinct files with their own bytes', async () => {
  const { port, root } = await freshBook();
  const rs = await Promise.all([1, 2, 3, 4].map((n) => upload(port, 'same.txt', Buffer.from(`body ${n}`))));
  rs.forEach(ok);
  const paths = rs.map((r) => r.json.path);
  assert.equal(new Set(paths).size, 4, paths.join(', '));
  const got = new Set();
  for (const [i, p] of paths.entries()) {
    assert.equal((await bytes(root, p)).toString(), `body ${i + 1}`);
    got.add(p);
  }
});

// ---------------------------------------------------------------- upload: the link is relative to the note's own folder

test('markdown link is relative to the note given in ?note= (research/, research/sources/, planning/)', async () => {
  const { port } = await freshBook();
  const cases = [
    ['research/x.md', '../assets/research/rel.pdf'],
    ['research/sources/s.md', '../../assets/research/rel-2.pdf'],
    ['planning/doc.md', '../assets/research/rel-3.pdf'],
    ['planning/deep/doc.md', '../../assets/research/rel-4.pdf'],
  ];
  for (const [note, href] of cases) {
    const r = await raw(port, 'POST', `${base}?name=rel.pdf&note=${encodeURIComponent(note)}`, { headers: GUARD('application/pdf'), body: PDF });
    ok(r);
    assert.equal(linkTarget(r.json.markdown), href, note);
  }
});

test('?note= may also be a note id: the link is relative to that note\'s folder (research note, source, planning doc)', async () => {
  const { port } = await freshBook();
  const cases = [
    ['note_01S50000000000000000000011', '../assets/research/by-id.pdf'], // research/tidal-ranges.md
    ['note_01S50000000000000000000012', '../../assets/research/by-id-2.pdf'], // research/sources/admiralty-tables.md
    ['note_01S50000000000000000000010', '../assets/research/by-id-3.pdf'], // planning/plan.md
  ];
  for (const [id, href] of cases) {
    const r = await raw(port, 'POST', `${base}?name=by-id.pdf&note=${id}`, { headers: GUARD('application/pdf'), body: PDF });
    ok(r);
    assert.equal(linkTarget(r.json.markdown), href, id);
  }
});

test('an image gets image syntax and a document gets a plain link; the label is the original file name', async () => {
  const { port } = await freshBook();
  const img = await upload(port, 'harbour.png', PNG, GUARD('image/png'));
  const doc = await upload(port, 'tables.pdf', PDF, GUARD('application/pdf'));
  assert.match(img.json.markdown, /^!\[[^\]]*harbour\.png[^\]]*\]\(/);
  assert.match(doc.json.markdown, /^\[[^\]]*tables\.pdf[^\]]*\]\(/);
});

test('a hostile ?note= is a 4xx and writes nothing', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  for (const note of ['../x.md', '/etc/x.md', 'C:\\x.md', 'research/../../x.md', 'research/x.txt', 'research/x.md\\0']) {
    const r = await raw(port, 'POST', `${base}?name=n.pdf&note=${encodeURIComponent(note)}`, { headers: GUARD('application/pdf'), body: PDF });
    assert.ok(r.status >= 400 && r.status < 500, `${note} -> ${r.status}`);
    same(before, await readAll(root));
  }
});

// ---------------------------------------------------------------- upload: limits, types, guard

test('over 25 MB is 413 and nothing is written', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  const r = await upload(port, 'big.pdf', Buffer.alloc(26 * 1024 * 1024 + 1));
  assert.equal(r.status, 413, r.text.slice(0, 200));
  same(before, await readAll(root));
  assert.ok(!(await exists(root, 'assets/research/big.pdf')));
});

test('a file well under the limit is accepted (5 MB)', async () => {
  const { port, root } = await freshBook();
  const body = Buffer.alloc(5 * 1024 * 1024, 7);
  const r = await upload(port, 'five.pdf', body);
  ok(r);
  assert.equal((await bytes(root, r.json.path)).length, body.length);
});

test('disallowed extensions are 415 and nothing is written', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  for (const name of ['run.exe', 'RUN.EXE', 'diagram.svg', 'DIAGRAM.SVG', 'page.html', 'page.htm', 'code.js', 'mod.mjs', 'a.sh', 'a.bat', 'a.php', 'archive.zip', 'doc.docx', 'noext', 'a.png.exe', 'trail.png.']) {
    const r = await upload(port, name, Buffer.from('<svg onload=alert(1)></svg>'));
    assert.equal(r.status, 415, `${name} -> ${r.status} ${r.text.slice(0, 120)}`);
    same(before, await readAll(root));
  }
});

test('an allowed extension is not enough to smuggle a different file: a.svg.png is stored as .png only', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'a.svg.png', PNG);
  ok(r);
  assert.ok(r.json.path.endsWith('.png'));
  assert.ok(await exists(root, r.json.path));
});

test('missing or empty name is a 4xx and writes nothing', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  for (const p of [base, `${base}?name=`, `${base}?name=%20`, `${base}?other=x.png`]) {
    const r = await raw(port, 'POST', p, { headers: GUARD(), body: PNG });
    assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
    same(before, await readAll(root));
  }
});

test('an empty body never produces a server error', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'empty.txt', Buffer.alloc(0));
  assert.ok(r.status < 500, String(r.status));
  if (r.status < 300) assert.equal((await bytes(root, r.json.path)).length, 0);
});

test('403 without the write guard (no header / wrong value / foreign host) and nothing is written', async () => {
  const { port, root } = await freshBook();
  const before = await readAll(root);
  const cases = [
    { headers: { 'content-type': 'image/png' } },
    { headers: { 'content-type': 'image/png', 'x-storyforge': '0' } },
    { headers: { 'content-type': 'image/png', 'x-storyforge': 'yes' } },
    { headers: GUARD('image/png'), host: 'evil.example.com' },
    { headers: GUARD('image/png'), host: `localhost:${port + 1}` },
  ];
  for (const c of cases) {
    const r = await raw(port, 'POST', `${base}?name=guard.png`, { ...c, body: PNG });
    assert.equal(r.status, 403, JSON.stringify(c.headers) + (c.host ?? ''));
    same(before, await readAll(root));
  }
});

test('unknown book is 404 for both routes and writes nothing', async () => {
  const { port } = await freshBook();
  const r = await raw(port, 'POST', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/attachments?name=a.png', { headers: GUARD(), body: PNG });
  assert.equal(r.status, 404);
  const g = await raw(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/attachments?path=assets/research/a.png');
  assert.equal(g.status, 404);
});

test('an uploaded attachment is also served back (round trip)', async () => {
  const { port } = await freshBook();
  const r = await upload(port, 'round.png', PNG, GUARD('image/png'));
  ok(r);
  const g = await get(port, r.json.path);
  assert.equal(g.status, 200);
  assert.ok(g.body.equals(PNG));
});

// ---------------------------------------------------------------- serve

async function withAssets(files) {
  return freshBook('valid/salt-orchard', async (root) => {
    for (const [rel, content] of Object.entries(files)) {
      const f = path.join(root, ...rel.split('/'));
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, content);
    }
  });
}

test('serve: content-type per extension, bytes exact, nosniff always', async () => {
  const types = {
    'a.png': ['image/png'], 'a.jpg': ['image/jpeg'], 'a.jpeg': ['image/jpeg'], 'a.webp': ['image/webp'], 'a.gif': ['image/gif'],
    'a.pdf': ['application/pdf'], 'a.txt': ['text/plain'], 'a.md': ['text/markdown', 'text/plain'], 'a.csv': ['text/csv'],
  };
  const files = Object.fromEntries(Object.keys(types).map((f, i) => [`assets/research/${f}`, Buffer.from([i, 1, 2, 3, 65, 66])]));
  const { port, root } = await withAssets(files);
  for (const [f, accept] of Object.entries(types)) {
    const r = await get(port, `assets/research/${f}`);
    assert.equal(r.status, 200, f);
    assert.ok(accept.some((t) => r.headers['content-type'].toLowerCase().startsWith(t)), `${f}: ${r.headers['content-type']}`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', f);
    assert.ok(r.body.equals(await bytes(root, `assets/research/${f}`)), `${f} bytes`);
  }
});

test('serve: images are inline, everything else is content-disposition: attachment', async () => {
  const names = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv'];
  const { port } = await withAssets(Object.fromEntries(names.map((e) => [`assets/research/d.${e}`, 'x'])));
  for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    const d = (await get(port, `assets/research/d.${e}`)).headers['content-disposition'];
    assert.ok(d === undefined || /^inline/i.test(d), `${e}: ${d}`);
  }
  for (const e of ['pdf', 'txt', 'md', 'csv']) {
    const d = (await get(port, `assets/research/d.${e}`)).headers['content-disposition'];
    assert.match(d ?? '', /^attachment/i, e);
  }
});

test('serve: upper-case extension and other folders under assets/ are served', async () => {
  const { port } = await withAssets({ 'assets/Cover.PNG': 'a', 'assets/deep/er/x.pdf': 'b' });
  assert.equal((await get(port, 'assets/Cover.PNG')).status, 200);
  assert.equal((await get(port, 'assets/Cover.PNG')).headers['content-type'], 'image/png');
  assert.equal((await get(port, 'assets/deep/er/x.pdf')).status, 200);
});

test('serve: SVG is never served, in any case or place', async () => {
  const { port } = await withAssets({ 'assets/x.svg': '<svg>SECRET-SVG</svg>', 'assets/research/Y.SVG': '<svg>SECRET-SVG</svg>' });
  for (const p of ['assets/x.svg', 'assets/research/Y.SVG', 'assets/research/y.svg']) {
    const r = await get(port, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('SECRET'), `${p} leaked`);
    assert.ok(!/svg/i.test(r.headers['content-type'] ?? ''), p);
  }
});

test('serve: html, js, exe and other types are refused even under assets/', async () => {
  const { port } = await withAssets({ 'assets/a.html': 'SECRET-HTML', 'assets/a.js': 'SECRET-JS', 'assets/a.exe': 'SECRET-EXE', 'assets/noext': 'SECRET-NOEXT', 'assets/a.png.html': 'SECRET-DOUBLE' });
  for (const p of ['assets/a.html', 'assets/a.js', 'assets/a.exe', 'assets/noext', 'assets/a.png.html']) {
    const r = await get(port, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('SECRET'), `${p} leaked`);
  }
});

test('serve: escapes, absolute paths, files outside assets/, missing files and directories are 404 with nothing leaked', async () => {
  const abs = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
  const { port, root } = await withAssets({ 'assets/research/ok.png': 'fine', 'secret.png': SECRET, 'codex/pic.png': SECRET });
  await fs.writeFile(path.join(path.dirname(root), 'secret.png'), SECRET);
  const cases = [
    '../secret.png', 'assets/../secret.png', 'assets/research/../../secret.png', 'assets/../../secret.png',
    '..%2Fsecret.png', 'assets%2F..%2F..%2Fsecret.png', 'assets/%2e%2e/secret.png', 'assets/research/%2e%2e/%2e%2e/secret.png',
    '%2e%2e/%2e%2e/secret.png', '..\\secret.png', 'assets\\..\\secret.png',
    abs, encodeURIComponent(abs), '/etc/passwd', '//etc/passwd', 'file:///etc/passwd', `file:///${abs}`,
    'secret.png', 'codex/pic.png', 'codex/characters/maren-hollis.md', 'book.md', 'planning/plan.md', '.storyforge/trash/old-scene.md',
    'assets/missing.png', 'assets', 'assets/', 'assets/research', 'assets/research/', 'assets-evil/x.png', 'assetsx/ok.png',
    'assets/research/ok.png%00.txt', 'assets/research/ok.png%00',
  ];
  for (const p of cases) {
    const r = await get(port, p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('SECRET') && !r.text.includes('fine') && !r.text.includes('[fonts]'), `${p} leaked`);
  }
  assert.equal((await get(port, 'assets/research/ok.png')).status, 200, 'control: the good file is served');
});

test('serve: a missing or empty path parameter is refused', async () => {
  const { port } = await freshBook();
  for (const p of [base, `${base}?path=`, `${base}?other=assets/x.png`]) {
    const r = await raw(port, 'GET', p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
  }
});

test('serve: a symlink or junction under assets/ that points outside the book is not followed', async (t) => {
  const made = { file: false, dir: false };
  const { port } = await freshBook('valid/salt-orchard', async (root) => {
    await fs.mkdir(path.join(root, 'assets', 'research'), { recursive: true });
    const outside = path.join(path.dirname(root), 'outside-dir');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'outside.pdf'), SECRET);
    try {
      await fs.symlink(path.join(outside, 'outside.pdf'), path.join(root, 'assets', 'research', 'link.pdf'));
      made.file = true;
    } catch { /* not permitted */ }
    try {
      await fs.symlink(outside, path.join(root, 'assets', 'dirlink'), 'junction');
      made.dir = true;
    } catch { /* not permitted */ }
  });
  if (!made.file && !made.dir) {
    t.skip('neither symlinks nor junctions are permitted on this machine');
    return;
  }
  if (made.file) {
    const r = await get(port, 'assets/research/link.pdf');
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('SECRET'));
  }
  if (made.dir) {
    const r = await get(port, 'assets/dirlink/outside.pdf');
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('SECRET'));
  }
});

test('serve: a foreign Host header is refused', async () => {
  const { port } = await withAssets({ 'assets/research/ok.png': 'fine' });
  assert.equal((await get(port, 'assets/research/ok.png', { host: 'evil.example.com' })).status, 403);
});

test('serve does not need the write guard (GET) and never changes the book', async () => {
  const { port, root } = await withAssets({ 'assets/research/ok.png': 'fine' });
  const before = await readAll(root);
  assert.equal((await get(port, 'assets/research/ok.png')).status, 200);
  same(before, await readAll(root));
});

// ---------------------------------------------------------------- portability

test('portable: uploaded files linked from notes in three folders validate clean, and still do after the book is copied elsewhere', async () => {
  const { port, root } = await freshBook();
  const base0 = await diagKeys(root);
  const png = await upload(port, 'Harbour Map.PNG', PNG, GUARD('image/png'));
  const pdf = await upload(port, 'tables.pdf', PDF, GUARD('application/pdf'));
  ok(png);
  ok(pdf);

  // links as the route returns them, which are relative to research/; deeper / shallower folders re-express the same target
  const fromResearch = (r) => linkTarget(r.json.markdown);
  const target = (r) => path.posix.join('..', r.json.path); // from research/
  assert.equal(fromResearch(png), target(png));
  assert.equal(fromResearch(pdf), target(pdf));

  const notes = {
    'research/maps.md': `---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000BB01\ntitle: Maps\n---\n${png.json.markdown}\n\n${pdf.json.markdown}\n`,
    'planning/maps-doc.md': `---\nschema: storyforge.doc/v1\nid: note_01S5000000000000000000BB02\ntitle: Maps doc\n---\n[map](../${png.json.path})\n`,
    'research/sources/maps-src.md': `---\nschema: storyforge.source/v1\nid: note_01S5000000000000000000BB03\ncite_key: maps-src\ntype: report\ntitle: Maps source\n---\n[tables](../../${pdf.json.path})\n`,
  };
  for (const [rel, text] of Object.entries(notes)) {
    const f = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  }
  assert.deepEqual(await diagKeys(root), base0, 'inserted links validate clean');

  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-portable-'));
  const copy = path.join(elsewhere, 'a-different-name');
  await fs.cp(root, copy, { recursive: true });
  assert.deepEqual(await diagKeys(copy), base0, 'copy validates exactly like the original');

  // independent of validate(): every local link in every note resolves to a real file inside the copy
  let checked = 0;
  for (const rel of Object.keys(notes)) {
    const text = await fs.readFile(path.join(copy, ...rel.split('/')), 'utf8');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(!/^([a-z]:|\/|file:)/i.test(m[1]), `${rel}: link ${m[1]} is not absolute`);
      const abs = path.resolve(copy, path.dirname(rel), m[1]);
      assert.ok(abs.startsWith(copy + path.sep), `${rel}: ${m[1]} stays inside the book`);
      assert.ok((await fs.stat(abs)).isFile(), `${rel}: ${m[1]} resolves`);
      checked++;
    }
  }
  assert.equal(checked, 4);

  // nothing in the book mentions where it was before
  for (const [p, buf] of await readAll(copy)) {
    assert.ok(!buf.includes(root) && !buf.includes(root.split(path.sep).join('/')), `${p} mentions the original location`);
  }
});

test('portable: the copy can be served by a second server (links work in the new place)', async () => {
  const { port, root } = await freshBook();
  const r = await upload(port, 'later.pdf', PDF);
  ok(r);
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-portable2-'));
  const copy = path.join(elsewhere, 'salt-orchard');
  await fs.cp(root, copy, { recursive: true });
  const second = await freshBook('valid/salt-orchard', async (dest) => {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(copy, dest, { recursive: true });
  });
  const g = await get(second.port, r.json.path);
  assert.equal(g.status, 200);
  assert.ok(g.body.equals(PDF));
});
