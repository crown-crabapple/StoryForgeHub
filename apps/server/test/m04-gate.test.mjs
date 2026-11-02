// M04 milestone gate, end to end with real server processes (main.mjs) on a temp library holding copies of salt-orchard and codex-graph.
// "Every Codex card, board card, timeline event, and research link can be located in a human-readable project file and survives index rebuild."
//   1. through the API: create a Codex entry (and edit a field), a board card (outline scene with summary) and move it, a thread mark (setup), a timeline
//      event linked two-sided to a scene and reordered, a research note linked to an entry with an uploaded attachment and a source citation;
//   2. every item the API returns (Codex cards, board cards + thread marks, timeline events, research links / sources / attachments), in BOTH books, is found
//      in exactly one .md file read straight from disk (front matter / Markdown link text), with the field it comes from;
//   3. stop the server, delete every .storyforge/, start again: every one of those API responses is identical and validate() diagnostics are unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import { FIXTURES, request } from './helpers.mjs';
import { GOOD, killAll, startServer, waitFor } from './proc-helpers.mjs';

after(killAll);

const SO = 'book_01S5000000000000000000000A';
const CG = 'book_01CG0000000000000000000001';
const sid = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
const KEY = sid(3);
const LOWTIDE = sid(8);
const THREAD = 'thread_01S5000000000000000000000T';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** Response fields that may legitimately differ after the index is rebuilt. None are expected: file mtimes are not touched by a rebuild. */
const VOLATILE = [];
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (VOLATILE.includes(k) ? undefined : x)));

function send(port, method, pathname, body, { raw, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { Host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload), ...(headers ?? GOOD) }) };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, json, text: buf.toString('utf8'), body: buf });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const b = (book, p = '') => `/api/books/${book}${p}`;
const get = async (port, url) => {
  const r = await request(port, 'GET', url);
  assert.equal(r.status, 200, `${url}: ${r.text}`);
  return r.json;
};
const mustOk = (r, what) => {
  assert.ok(r.status === 200 || r.status === 201, `${what}: ${r.status} ${r.text}`);
  return r.json;
};

// ---------------------------------------------------------------- reading the files directly (no product code)

async function walkMd(dir, rel = '', out = []) {
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.storyforge' || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkMd(dir, r, out);
    else if (e.name.endsWith('.md')) out.push(r);
  }
  return out;
}
const splitFile = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return m ? { fm: YAML.parse(m[1]), body: m[2] } : null;
};
/** { rel -> { fm, body } } of every Markdown file of a book (rel is book-relative; archive/ included). */
async function readBook(root) {
  const out = new Map();
  for (const rel of await walkMd(root)) {
    const parsed = splitFile(await fs.readFile(path.join(root, ...rel.split('/')), 'utf8'));
    if (parsed && parsed.fm) out.set(rel, parsed);
  }
  return out;
}
/** The one file whose front matter `id` is this id. */
function fileOfId(files, id) {
  const hits = [...files].filter(([, f]) => f.fm.id === id).map(([rel]) => rel);
  assert.equal(hits.length, 1, `${id} must be in exactly one file, found ${JSON.stringify(hits)}`);
  return hits[0];
}
const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)), msg);

/** Step 2: map every API item to one file and the field it comes from. Returns the number of items checked per kind. */
async function locateAll(port, roots) {
  const n = { codex: 0, board: 0, marks: 0, events: 0, links: 0, sources: 0, attachments: 0 };
  for (const [bookId, root] of Object.entries(roots)) {
    const files = await readBook(root);
    const pre = `${path.basename(root)}/`; // API paths are relative to the library
    const bookPath = (await get(port, b(bookId))).path;
    assert.ok(typeof bookPath === 'string');

    // ---- Codex cards
    const { entries } = await get(port, b(bookId, '/codex/entries'));
    for (const e of entries) {
      const rel = fileOfId(files, e.id);
      assert.ok(rel.endsWith('.md'));
      assert.equal(e.path, pre + rel, `${e.slug}: the API path is the file`);
      const { fm } = files.get(rel);
      assert.equal(fm.schema, 'storyforge.entry/v1');
      assert.equal(fm.slug, e.slug, `${rel} slug`);
      assert.equal(fm.name, e.name, `${rel} name`);
      assert.equal(fm.type, e.type, `${rel} type`);
      assert.equal(fm.status, e.status, `${rel} status`);
      eq(fm.fields ?? {}, e.fields, `${rel} fields come from the fields: map`);
      assert.equal(rel.startsWith('archive/'), e.archived, `${rel} archived == location`);
      n.codex++;
    }

    // ---- board cards (scenes) and thread marks
    const planning = await get(port, b(bookId, '/threads'));
    for (const s of planning.scenes) {
      const rel = fileOfId(files, s.id);
      assert.equal(s.path, pre + rel);
      const { fm } = files.get(rel);
      assert.equal(fm.schema, 'storyforge.scene/v1');
      assert.equal(fm.title, s.title, `${rel} title`);
      assert.equal(fm.status, s.status, `${rel} status`);
      assert.equal(fm.chapter, s.chapter, `${rel} chapter`);
      assert.equal(fm.sequence, s.sequence, `${rel} sequence`);
      assert.equal(fm.summary ?? '', s.summary ?? '', `${rel} summary`);
      assert.equal(fm.pov ?? null, s.pov ?? null, `${rel} pov`);
      n.board++;
    }
    for (const t of planning.threads) {
      const rel = fileOfId(files, t.id);
      assert.equal(t.path, pre + rel);
      const { fm } = files.get(rel);
      assert.equal(fm.schema, 'storyforge.thread/v1');
      assert.equal(fm.slug, t.slug);
      assert.equal(fm.status, t.status);
      for (const list of ['setup', 'develop', 'payoff']) {
        eq(fm[list] ?? [], t[list], `${rel} ${list}`);
        for (const sceneId of t[list]) {
          assert.equal(files.get(fileOfId(files, sceneId)).fm.schema, 'storyforge.scene/v1', `${rel} ${list} names a real scene file`);
          n.marks++;
        }
      }
    }

    // ---- timeline events
    const tl = await get(port, b(bookId, '/timeline'));
    for (const e of tl.events) {
      const rel = fileOfId(files, e.id);
      assert.equal(e.path, pre + rel);
      assert.ok(rel.startsWith('planning/timeline/'), rel);
      const { fm } = files.get(rel);
      assert.equal(fm.schema, 'storyforge.event/v1');
      assert.equal(fm.slug, e.slug);
      assert.equal(fm.title, e.title);
      assert.equal(fm.order, e.order, `${rel} order`);
      assert.equal(fm.when ?? null, e.when, `${rel} when`);
      eq(fm.characters ?? [], e.characters);
      eq(fm.locations ?? [], e.locations);
      for (const row of e.scenes) {
        const sceneRel = fileOfId(files, row.id);
        const sceneFm = files.get(sceneRel).fm;
        const eventSide = (fm.scenes ?? []).includes(row.id);
        const sceneSide = (sceneFm.events ?? []).some((r) => r === e.slug || r === e.id);
        assert.ok(eventSide || sceneSide, `${rel} <-> ${sceneRel}: one side of the link is in a file`);
        assert.equal(row.side, eventSide && sceneSide ? 'both' : eventSide ? 'event' : 'scene', `${rel} <-> ${sceneRel} side`);
      }
      // and no file-side link is missing from the API
      for (const id of fm.scenes ?? []) assert.ok(e.scenes.some((r) => r.id === id), `${rel} scenes: ${id} is in the API row`);
      n.events++;
    }

    // ---- research links, sources, attachments
    const notes = await get(port, b(bookId, '/notes'));
    for (const note of notes.notes) {
      const rel = fileOfId(files, note.id);
      assert.equal(note.path, pre + rel);
      const { fm, body } = files.get(rel);
      if (note.kind === 'source') {
        assert.equal(fm.schema, 'storyforge.source/v1');
        assert.equal(fm.cite_key, note.cite_key);
        continue;
      }
      assert.equal(fm.title, note.title);
      eq(fm.tags ?? [], note.tags);
      if (note.kind === 'research') {
        assert.equal(fm.schema, 'storyforge.research/v1');
        assert.equal(fm.canon === true, note.canon);
        eq(fm.links ?? [], note.links.map((l) => l.ref), `${rel} links[]`);
        for (const l of note.links) {
          assert.equal(l.state, 'ok', `${rel} link ${l.ref}`);
          const target = files.get(fileOfId(files, l.id));
          assert.ok(target.fm.slug === l.ref || target.fm.id === l.ref, `${rel} link ${l.ref} resolves to a file whose slug / id it is`);
          n.links++;
        }
        eq(fm.sources ?? [], note.sources.map((s) => s.cite_key), `${rel} sources[]`);
        for (const s of note.sources) {
          const src = [...files].filter(([, f]) => f.fm.schema === 'storyforge.source/v1' && f.fm.cite_key === s.cite_key);
          assert.equal(src.length, 1, `${rel} cites ${s.cite_key}: exactly one source file`);
          assert.equal(src[0][1].fm.id, s.id);
          n.sources++;
        }
      }
      // every local Markdown link in the text resolves relative to this note, and attachments sit under assets/
      for (const m of body.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const abs = path.resolve(root, path.dirname(rel), decodeURIComponent(target.split('#')[0]));
        assert.ok(abs.startsWith(root + path.sep), `${rel}: ${target} stays inside the book`);
        const bookRel = path.relative(root, abs).split(path.sep).join('/');
        assert.ok((await fs.stat(abs)).isFile(), `${rel}: ${target} resolves`);
        if (bookRel.startsWith('assets/')) n.attachments++;
      }
    }
  }
  return n;
}

/** Every answer of the API that the gate promises survives a rebuild, per book. */
async function collect(port) {
  const out = {};
  for (const book of [SO, CG]) {
    out[book] = {
      book: await get(port, b(book)),
      entries: await get(port, b(book, '/codex/entries')),
      types: await get(port, b(book, '/codex/types')),
      threads: await get(port, b(book, '/threads')),
      timeline: await get(port, b(book, '/timeline')),
      notes: await get(port, b(book, '/notes')),
      sceneNotes: await get(port, b(book, '/scene-notes')),
      objects: await get(port, b(book, '/objects?kinds=entry,thread,event')),
      graph: await get(port, b(book, '/graph')),
    };
  }
  return strip(out);
}

async function findStoryforgeDirs(dir, found = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === '.storyforge') found.push(full);
    else await findStoryforgeDirs(full, found);
  }
  return found;
}
const diagKeys = async (root) => (await validate(root)).diagnostics.map((d) => `${d.severity}|${d.code}|${d.file}|${d.location}`).sort();

test('M04 gate: create across Codex, board, timeline and research; locate every item in a project file; survive index rebuild', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-m04-cfg-'));
  Object.assign(process.env, { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home });

  // one library holding both books
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-m04-lib-'));
  await fs.copyFile(path.join(FIXTURES, 'valid', 'library', 'library.md'), path.join(lib, 'library.md'));
  await fs.cp(path.join(FIXTURES, 'valid', 'salt-orchard'), path.join(lib, 'salt-orchard'), { recursive: true });
  await fs.cp(path.join(FIXTURES, 'valid', 'codex-graph'), path.join(lib, 'codex-graph'), { recursive: true });
  const roots = { [SO]: path.join(lib, 'salt-orchard'), [CG]: path.join(lib, 'codex-graph') };
  const baselineDiagnostics = await diagKeys(lib);

  let s = await startServer(lib);
  let port = s.port;
  const fresh = () => waitFor(async () => (await get(port, '/api/status')).books.every((x) => x.index === 'fresh'), { what: 'fresh index', timeout: 30000 });
  await fresh();

  // ---- 1. create through the API
  // Codex entry, then edit a field
  const entry = mustOk(await send(port, 'POST', b(SO, '/entries'), { type: 'character', name: 'Gate Person', slug: 'gate-person' }), 'create entry');
  mustOk(await send(port, 'POST', b(SO, `/entries/${entry.id}/fields`), { role: 'Courier', fields: { Home: 'Port Aldine' } }), 'edit entry field');

  // board card: new outline scene with a summary, then moved
  const card = mustOk(await send(port, 'POST', b(SO, '/scenes'), { chapter: 1, after: KEY, title: 'The gate scene', slug: 'the-gate-scene', body: '', status: 'outline', summary: 'Gate Person arrives with the post.' }), 'new card');
  mustOk(await send(port, 'POST', b(SO, `/scenes/${card.id}/move`), { chapter: 3, after: LOWTIDE }), 'move card');

  // thread mark: the card is a setup of the brass key
  mustOk(await send(port, 'POST', b(SO, `/threads/${THREAD}/fields`), { add: { setup: [card.id] } }), 'thread mark');

  // timeline event linked two-sided to the card, then reordered between the flood (100) and the key (150)
  const event = mustOk(await send(port, 'POST', b(SO, '/events'), { title: 'Gate event', slug: 'gate-event', when: 'Winter, year 31', characters: ['gate-person'] }), 'new event');
  mustOk(await send(port, 'POST', b(SO, `/events/${event.id}/fields`), { add: { scenes: [card.id] }, two_sided: true }), 'link event to the card, two-sided');
  mustOk(await send(port, 'POST', b(SO, `/events/${event.id}/fields`), { order: 125 }), 'reorder event');

  // research: a source, a note linked to the new entry citing it, an uploaded attachment linked from the note's text
  const source = mustOk(await send(port, 'POST', b(SO, '/notes'), { kind: 'source', title: 'Gate Source', cite_key: 'gate-source', author: 'A. Writer', year: '2020' }), 'new source');
  const note = mustOk(await send(port, 'POST', b(SO, '/notes'), { kind: 'research', title: 'Gate research', slug: 'gate-research', tags: ['gate'], links: ['gate-person'], sources: ['gate-source'] }), 'new note');
  const up = await send(port, 'POST', `${b(SO, '/attachments')}?name=${encodeURIComponent('Gate Map.PNG')}&note=${note.id}`, undefined, { raw: PNG, headers: { 'x-storyforge': '1', 'content-type': 'image/png' } });
  const uploaded = mustOk(up, 'upload');
  assert.equal(uploaded.path, 'assets/research/gate-map.png');
  const current = await get(port, b(SO, `/notes/${note.id}`));
  mustOk(await send(port, 'PUT', b(SO, `/notes/${note.id}/body`), { body: `The route, as drawn: ${uploaded.markdown}\n\nCited here [@gate-source].\n`, base_sha256: current.sha256 }), 'note text with the attachment');
  await fresh();

  // the created items are visible through the API
  const entries = (await get(port, b(SO, '/codex/entries'))).entries;
  const gate = entries.find((e) => e.id === entry.id);
  assert.equal(gate.role, 'Courier');
  assert.equal(gate.fields.Home, 'Port Aldine');
  const planning = await get(port, b(SO, '/threads'));
  assert.equal(planning.scenes.find((x) => x.id === card.id).summary, 'Gate Person arrives with the post.');
  assert.equal(planning.scenes.find((x) => x.id === card.id).chapter, 3, 'the card was moved');
  assert.ok(planning.threads.find((t) => t.id === THREAD).setup.includes(card.id));
  const tl = await get(port, b(SO, '/timeline'));
  const ev = tl.events.find((e) => e.id === event.id);
  assert.equal(ev.order, 125);
  assert.equal(ev.scenes.find((x) => x.id === card.id).side, 'both');
  assert.deepEqual(tl.events.map((e) => e.slug).slice(0, 4), ['the-first-grafting', 'the-flood', 'gate-event', 'the-key-found-twice']);
  const notes = (await get(port, b(SO, '/notes'))).notes;
  const gn = notes.find((n) => n.id === note.id);
  assert.deepEqual(gn.links.map((l) => [l.ref, l.id, l.state]), [['gate-person', entry.id, 'ok']]);
  assert.deepEqual(gn.sources.map((x) => [x.cite_key, x.id, x.state]), [['gate-source', source.id, 'ok']]);
  const served = await send(port, 'GET', `${b(SO, '/attachments')}?path=${encodeURIComponent(uploaded.path)}`);
  assert.equal(served.status, 200);
  assert.ok(served.body.equals(PNG));

  // ---- 2. every item is located in a human-readable file
  const found = await locateAll(port, roots);
  for (const [kind, count] of Object.entries(found)) assert.ok(count > 0, `${kind}: at least one item was located (not vacuous)`);
  assert.ok(found.codex >= 10 + 8 + 1, 'both books\' Codex cards');
  assert.ok(found.attachments >= 1, 'the attachment link resolves');
  // the items made above, located specifically
  const files = await readBook(roots[SO]);
  assert.equal(files.get('codex/characters/gate-person.md').fm.role, 'Courier');
  assert.equal(files.get('codex/characters/gate-person.md').fm.fields.Home, 'Port Aldine');
  assert.equal(files.get(fileOfId(files, card.id)).fm.summary, 'Gate Person arrives with the post.');
  assert.deepEqual(files.get('planning/threads/brass-key.md').fm.setup.includes(card.id), true);
  assert.equal(files.get('planning/timeline/gate-event.md').fm.order, 125);
  assert.deepEqual(files.get('planning/timeline/gate-event.md').fm.scenes, [card.id]);
  assert.deepEqual(files.get(fileOfId(files, card.id)).fm.events, ['gate-event']);
  const noteFile = files.get('research/gate-research.md');
  assert.deepEqual([noteFile.fm.links, noteFile.fm.sources], [['gate-person'], ['gate-source']]);
  assert.ok(noteFile.body.includes('(../assets/research/gate-map.png)'), 'the note links the attachment relative to itself');
  assert.ok((await fs.readFile(path.join(roots[SO], 'assets', 'research', 'gate-map.png'))).equals(PNG));
  assert.deepEqual(await diagKeys(lib), baselineDiagnostics, 'the work above added no diagnostics');

  // ---- 3. survives an index rebuild: stop, delete every .storyforge/, start again
  const before = await collect(port);
  const bytesBefore = createHash('sha256').update(await fs.readFile(path.join(roots[SO], 'assets', 'research', 'gate-map.png'))).digest('hex');
  await s.stop();
  const dirs = await findStoryforgeDirs(lib);
  assert.ok(dirs.length >= 1, 'there were .storyforge/ folders to delete');
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  assert.deepEqual(await findStoryforgeDirs(lib), [], 'none left');

  s = await startServer(lib);
  port = s.port;
  await fresh();
  const after = await collect(port);
  for (const book of [SO, CG]) {
    for (const key of Object.keys(before[book])) assert.deepEqual(after[book][key], before[book][key], `${book} ${key} is identical after the rebuild (ignored fields: ${VOLATILE.length ? VOLATILE.join(', ') : 'none'})`);
  }
  assert.deepEqual(await diagKeys(lib), baselineDiagnostics, 'validate() diagnostics unchanged');
  const again = await locateAll(port, roots);
  assert.deepEqual(again, found, 'the same items are located in the same files');
  const servedAgain = await send(port, 'GET', `${b(SO, '/attachments')}?path=${encodeURIComponent(uploaded.path)}`);
  assert.equal(createHash('sha256').update(servedAgain.body).digest('hex'), bytesBefore);
  await s.stop();
});
