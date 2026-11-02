// M04-J04 acceptance 4 for research notes, planning docs and sources (exact file effects of create / edit fields / archive / restore,
// CITE_KEY_TAKEN, refusals write nothing, 403 guards, dry runs, Undo), plus the data the Notes page and the inspectors read:
//   GET  /api/books/:b/notes                     { notes, tags, objects, unreadable }
//   GET  /api/books/:b/notes/:id                 one note + body + sha256
//   GET  /api/books/:b/scene-notes               { scenes: [{ id, title, position, chapter_label, path, notes: [{ text, line }] }] }
//   POST /api/books/:b/notes                     { kind: research | doc | source, title, slug?, tags?, links?, sources?, canon?, cite_key?, type?, author?, year?, ..., dryRun? }
//   POST /api/books/:b/notes/:id/fields | archive | restore
//   PUT  /api/books/:b/notes/:id/body            { body, base_sha256 }
// Contract: docs/contracts/M04-J04-timeline-research.md sections 3, 5 and acceptance 4; FORMAT-v1 section 7.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import { BOOK, KEY, KEY_ALT, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(closeAll);

const N = {
  plan: ['note_01S50000000000000000000010', 'planning/plan.md'],
  tides: ['note_01S50000000000000000000011', 'research/tidal-ranges.md'],
  tables: ['note_01S50000000000000000000012', 'research/sources/admiralty-tables.md'],
};
const SALT_ORCHARD_ENTRY = 'entry_01S5000000000000000000000M';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const nfields = (port, k, body) => post(port, u('notes', N[k][0], 'fields'), body);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const text = async (root, rel) => (await fs.readFile(path.join(root, ...rel.split('/')))).toString('utf8');
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const codes = async (root) => (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}`).sort();
const fmOf = (raw) => YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)[1]);
const toCrlf = (rel) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\r?\n/g, '\r\n'));
};
const putFile = (rel, content) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content);
};
const sameFiles = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of paths');
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical`);
};
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  return { removed, added };
}
async function diffOf(target, act, { prep, expectStatus = [200, 201] } = {}) {
  const ctx = await freshBook('valid/salt-orchard', prep);
  const original = await readAll(ctx.root);
  const before = await text(ctx.root, target);
  const r = await act(ctx);
  assert.ok(expectStatus.includes(r.status), `${r.status}: ${r.text}`);
  const after = await text(ctx.root, target);
  return { ctx, r, original, before, after, ...lineDiff(before, after) };
}
async function assertOnlyChanged(root, original, ...files) {
  const now = await readAll(root);
  assert.deepEqual([...now.keys()].sort(), [...original.keys()].sort());
  for (const [p, buf] of original) if (!files.includes(p)) assert.ok(now.get(p).equals(buf), `${p} untouched`);
  for (const f of files) assert.ok(!now.get(f).equals(original.get(f)), `${f} did change`);
}

// ---------------------------------------------------------------- reads

test('GET notes on salt-orchard: the doc, the research note and the source, by title, with every field', async () => {
  const { port } = await freshBook();
  const r = await send(port, 'GET', u('notes'));
  assert.equal(r.status, 200, r.text);
  const { notes } = r.json;
  assert.deepEqual(notes.map((n) => [n.id, n.kind, n.path]), [
    [N.plan[0], 'doc', 'planning/plan.md'],
    [N.tides[0], 'research', 'research/tidal-ranges.md'],
    [N.tables[0], 'source', 'research/sources/admiralty-tables.md'],
  ], 'threads and events are not notes');
  const by = (k) => notes.find((n) => n.id === N[k][0]);
  const tides = by('tides');
  assert.equal(tides.title, 'Tidal ranges on the coast');
  assert.deepEqual(tides.tags, ['tides', 'setting']);
  assert.equal(tides.canon, false);
  assert.equal(tides.archived, false);
  assert.equal(tides.excerpt, 'Spring tides here reach four metres. Neap tides about two.');
  assert.deepEqual(tides.sources, [{ cite_key: 'admiralty-tables', id: N.tables[0], title: 'Tide Tables for the North Shore', state: 'ok' }]);
  assert.equal(tides.links.length, 1);
  assert.deepEqual([tides.links[0].ref, tides.links[0].id, tides.links[0].kind, tides.links[0].slug, tides.links[0].state], ['salt-orchard', SALT_ORCHARD_ENTRY, 'entry', 'salt-orchard', 'ok']);
  assert.match(tides.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(tides.updated_at)));
  assert.deepEqual(tides.problems, []);
  const plan = by('plan');
  assert.deepEqual([plan.title, plan.locked, plan.cite_key], ['Book plan', false, null]);
  const src = by('tables');
  assert.equal(src.cite_key, 'admiralty-tables');
  assert.deepEqual([src.source.type, src.source.author, src.source.year, src.source.publisher], ['report', 'Aldine Harbour Office', '1998', '']);
});

test('GET notes: tag list with counts (live research notes only) and the objects a note can link to', async () => {
  const { port } = await freshBook();
  const r = (await send(port, 'GET', u('notes'))).json;
  assert.deepEqual(r.tags, [{ tag: 'setting', count: 1 }, { tag: 'tides', count: 1 }]);
  assert.ok(r.objects.some((o) => o.kind === 'entry' && o.slug === 'maren-hollis' && o.name === 'Maren Hollis'));
  assert.ok(r.objects.some((o) => o.kind === 'thread' && o.slug === 'brass-key'));
  assert.ok(r.objects.some((o) => o.kind === 'event' && o.slug === 'the-flood'));
  assert.equal(r.objects.filter((o) => o.kind === 'entry').length, 10);
  assert.deepEqual(r.unreadable, []);
});

test('GET notes: tag counts add up across notes, and archived notes are listed but not counted', async () => {
  const research = (n, tags) => `---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000BB0${n}\ntitle: Note ${n}\ntags: [${tags}]\n---\nBody ${n}.\n`;
  const { port } = await freshBook('valid/salt-orchard', async (root) => {
    await putFile('research/n1.md', research(1, 'tides, maps'))(root);
    await putFile('research/n2.md', research(2, 'maps'))(root);
    await putFile('archive/research/n3.md', research(3, 'maps, old'))(root);
  });
  const r = (await send(port, 'GET', u('notes'))).json;
  assert.deepEqual(r.tags, [{ tag: 'maps', count: 2 }, { tag: 'tides', count: 2 }, { tag: 'setting', count: 1 }]);
  const archived = r.notes.find((n) => n.title === 'Note 3');
  assert.equal(archived.archived, true);
});

test('GET notes: a link / source that resolves to nothing is shown broken, with its problem', async () => {
  const f = `---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000BB09\ntitle: Broken refs\nsources: [admiralty-tables, no-such-source]\nlinks: [pell, nobody-here, the-flood, brass-key]\n---\n`;
  const { port } = await freshBook('valid/salt-orchard', putFile('research/broken.md', f));
  const n = (await send(port, 'GET', u('notes'))).json.notes.find((x) => x.title === 'Broken refs');
  assert.deepEqual(n.sources.map((s) => [s.cite_key, s.state]), [['admiralty-tables', 'ok'], ['no-such-source', 'broken']]);
  assert.deepEqual(n.links.map((l) => [l.ref, l.kind, l.state]), [['pell', 'entry', 'ok'], ['nobody-here', null, 'broken'], ['the-flood', 'event', 'ok'], ['brass-key', 'thread', 'ok']]);
  assert.deepEqual(n.problems.map((p) => `${p.code}|${p.location}`).sort(), ['E301|links[1]', 'E301|sources[1]']);
});

test('GET one note: body byte for byte and the sha256 of the file; unknown note and unknown book are 404', async () => {
  const { port, root } = await freshBook();
  const raw = await fs.readFile(path.join(root, N.tides[1]));
  const r = await send(port, 'GET', u('notes', N.tides[0]));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sha256, sha(raw));
  assert.ok(raw.toString('utf8').endsWith(r.json.body));
  assert.match(r.json.body, /Spring tides here reach four metres\./);
  assert.equal((await send(port, 'GET', u('notes', N.tables[0]))).json.body, '');
  assert.equal((await send(port, 'GET', u('notes', 'note_01S5ZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);
  assert.equal((await send(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/notes')).status, 404);
});

test('associations: a note whose links name an entry / thread / event is found from the link data (the Codex and editor Research sections read this)', async () => {
  const note = (n, links) => `---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000CC0${n}\ntitle: About ${links}\nlinks: [${links}]\n---\n`;
  const { port } = await freshBook('valid/salt-orchard', async (root) => {
    await putFile('research/about-maren.md', note(1, 'maren-hollis'))(root);
    await putFile('research/about-key.md', note(2, 'brass-key'))(root);
    await putFile('research/about-flood.md', note(3, 'the-flood'))(root);
  });
  const { notes } = (await send(port, 'GET', u('notes'))).json;
  const linking = (id) => notes.filter((n) => n.links.some((l) => l.id === id)).map((n) => n.title).sort();
  assert.deepEqual(linking('entry_01S5000000000000000000000G'), ['About maren-hollis'], 'Maren');
  assert.deepEqual(linking(SALT_ORCHARD_ENTRY), ['Tidal ranges on the coast'], 'salt-orchard entry has the fixture note');
  assert.deepEqual(linking('thread_01S5000000000000000000000T'), ['About brass-key']);
  assert.deepEqual(linking('event_01S5000000000000000000000W'), ['About the-flood']);
  assert.deepEqual(linking('entry_01S5000000000000000000000K'), [], 'Pell has none');
});

// ---------------------------------------------------------------- scene notes

test('scene notes: the one note of salt-orchard with its scene, chapter label and body line', async () => {
  const { port, root } = await freshBook();
  const r = await send(port, 'GET', u('scene-notes'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.scenes.length, 1);
  const s = r.json.scenes[0];
  assert.equal(s.id, KEY);
  assert.equal(s.path, 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md');
  assert.deepEqual(s.notes.map((n) => n.text), ['check the tide times against chapter 3']);
  // line is 1-based within the text the editor shows (after the front matter), computed here from the file
  const raw = await text(root, s.path);
  const body = raw.slice(raw.indexOf('\n---', 4) + 5);
  assert.equal(body.split('\n')[s.notes[0].line - 1].trim(), '<!-- note: check the tide times against chapter 3 -->');
  assert.ok(s.chapter_label !== undefined && s.position !== undefined);
});

test('scene notes: several per scene in line order, grouped by scene in book order; the other comment forms, code and non-live scenes are not listed', async () => {
  const add = (rel, extra) => async (root) => { await fs.appendFile(path.join(root, ...rel.split('/')), extra); };
  const prologue = 'manuscript/act-01-low-water/ch-000-prologue/0010-before-the-tide.md';
  const alt = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key-alt.md';
  const cut = 'archive/manuscript/act-01-low-water/ch-002-the-grafting/0030-the-cut-scene.md';
  const { port, root } = await freshBook('valid/salt-orchard', async (r) => {
    await add(prologue, '\n<!-- note: first -->\nText <!-- note: second --> and <!--   note:   spaced\n   over lines  --> end.\n<!-- opaque: not a note -->\n<!-- TODO: nope -->\n\n```\n<!-- note: inside a fence -->\n```\n\nInline `<!-- note: in code -->` here.\n')(r);
    await add(alt, '\n<!-- note: a variant is not in the book -->\n')(r);
    await add(cut, '\n<!-- note: an archived scene is not in the book -->\n')(r);
  });
  const { scenes } = (await send(port, 'GET', u('scene-notes'))).json;
  assert.deepEqual(scenes.map((s) => s.id), ['scene_01S50000000000000000000001', KEY], 'prologue before the key scene; variant and archived absent');
  const got = scenes[0].notes;
  assert.deepEqual(got.map((n) => n.text), ['first', 'second', 'spaced over lines']);
  assert.ok(got[0].line < got[1].line || got[0].line === got[1].line);
  const raw = await text(root, prologue);
  const body = raw.slice(raw.indexOf('\n---', 4) + 5).split('\n');
  assert.match(body[got[0].line - 1], /note: first/);
  assert.match(body[got[1].line - 1], /note: second/);
  assert.match(body[got[2].line - 1], /note:\s+spaced/);
  assert.ok(!scenes.some((s) => s.id === KEY_ALT));
});

test('scene notes: a book with no notes answers an empty list; unknown book is 404', async () => {
  const { port } = await freshBook('valid/codex-graph');
  const r = await send(port, 'GET', '/api/books/book_01CG0000000000000000000001/scene-notes');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.scenes, []);
  assert.equal((await send(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/scene-notes')).status, 404);
});

// ---------------------------------------------------------------- create

test('create research note: one new file research/<slug>.md, exact front matter, valid, listed', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('notes'), { kind: 'research', title: 'Harbour dredging', slug: 'harbour-dredging', tags: ['harbour', 'history'], links: ['port-aldine', 'brass-key'], sources: ['admiralty-tables'], canon: true });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), ['research/harbour-dredging.md']);
  for (const [p, buf] of original) assert.ok(now.get(p).equals(buf), `${p} untouched`);
  const raw = await text(ctx.root, 'research/harbour-dredging.md');
  const fm = fmOf(raw);
  assert.equal(fm.schema, 'storyforge.research/v1');
  assert.match(fm.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(fm.title, 'Harbour dredging');
  assert.deepEqual([fm.tags, fm.links, fm.sources, fm.canon], [['harbour', 'history'], ['port-aldine', 'brass-key'], ['admiralty-tables'], true]);
  assert.ok(raw.endsWith('---\n'), 'empty body');
  assert.deepEqual(await codes(ctx.root), []);
  assert.equal(r.json.id, fm.id);
  assert.equal(r.json.path, 'research/harbour-dredging.md');
  const list = (await send(ctx.port, 'GET', u('notes'))).json;
  assert.ok(list.notes.some((n) => n.id === fm.id && n.kind === 'research' && n.canon === true));
});

test('create research note: slug from the title, defaults (no tags, canon false, no links); non-canon is the default', async () => {
  const ctx = await freshBook();
  const r = await post(ctx.port, u('notes'), { kind: 'research', title: 'Salt Marsh Plants' });
  assert.equal(r.status, 201, r.text);
  const fm = fmOf(await text(ctx.root, 'research/salt-marsh-plants.md'));
  assert.deepEqual([fm.canon, fm.tags, fm.links, fm.sources], [false, [], [], []]);
  assert.deepEqual(await codes(ctx.root), []);
});

test('create planning doc: planning/<slug>.md as storyforge.doc/v1, not locked', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('notes'), { kind: 'doc', title: 'Style guide', slug: 'style-guide' });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), ['planning/style-guide.md']);
  const fm = fmOf(await text(ctx.root, 'planning/style-guide.md'));
  assert.equal(fm.schema, 'storyforge.doc/v1');
  assert.match(fm.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([fm.title, fm.locked], ['Style guide', false]);
  assert.deepEqual(await codes(ctx.root), []);
  const list = (await send(ctx.port, 'GET', u('notes'))).json.notes;
  assert.ok(list.some((n) => n.id === fm.id && n.kind === 'doc'));
});

test('create source: research/sources/<cite-key>.md with cite_key and the given fields; cited from a note it validates', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('notes'), { kind: 'source', title: 'A History of Salt', cite_key: 'salt-history', type: 'book', author: 'M. Reyes', year: '2011', publisher: 'Port Press', url: 'https://example.com/salt', locator: 'ch. 4' });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), ['research/sources/salt-history.md']);
  const fm = fmOf(await text(ctx.root, 'research/sources/salt-history.md'));
  assert.equal(fm.schema, 'storyforge.source/v1');
  assert.match(fm.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(fm.cite_key, 'salt-history');
  assert.equal(fm.title, 'A History of Salt');
  assert.deepEqual([fm.type, fm.author, String(fm.year), fm.publisher, fm.url, fm.locator], ['book', 'M. Reyes', '2011', 'Port Press', 'https://example.com/salt', 'ch. 4']);
  assert.ok(!('accessed' in fm), 'a field not given is not written');
  assert.deepEqual(await codes(ctx.root), []);
  // the new key can be cited by a research note and in prose
  const n = await post(ctx.port, u('notes'), { kind: 'research', title: 'Cites it', sources: ['salt-history'] });
  assert.equal(n.status, 201, n.text);
  assert.deepEqual(await codes(ctx.root), []);
});

test('create source: CITE_KEY_TAKEN is 409 and writes nothing (live key, archived key, and a key given with different file slug)', async () => {
  const ctx = await freshBook();
  assert.equal((await post(ctx.port, u('notes', N.tables[0], 'archive'), {})).status, 200);
  const before = await readAll(ctx.root);
  for (const body of [
    { kind: 'source', title: 'Again', cite_key: 'admiralty-tables' },
    { kind: 'source', title: 'Again', cite_key: 'admiralty-tables', slug: 'other-name' },
  ]) {
    const r = await post(ctx.port, u('notes'), body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'CITE_KEY_TAKEN');
    sameFiles(before, await readAll(ctx.root));
  }
  const live = await freshBook();
  const b2 = await readAll(live.root);
  const r2 = await post(live.port, u('notes'), { kind: 'source', title: 'Again', cite_key: 'admiralty-tables' });
  assert.equal(r2.status, 409, r2.text);
  assert.equal(r2.json.code, 'CITE_KEY_TAKEN');
  sameFiles(b2, await readAll(live.root));
});

test('create: a file that already exists is 409 and untouched; refusals write nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const clash = await post(ctx.port, u('notes'), { kind: 'research', title: 'Clash', slug: 'tidal-ranges' });
  assert.equal(clash.status, 409, clash.text);
  sameFiles(before, await readAll(ctx.root));
  const clashDoc = await post(ctx.port, u('notes'), { kind: 'doc', title: 'Clash', slug: 'plan' });
  assert.equal(clashDoc.status, 409, clashDoc.text);
  sameFiles(before, await readAll(ctx.root));
  for (const body of [
    {}, { kind: 'research' }, { kind: 'research', title: '' }, { kind: 'research', title: '!!!' }, { kind: 'essay', title: 'x' },
    { kind: 'research', title: 'x', slug: 'Not A Slug' }, { kind: 'research', title: 'x', slug: '../escape' }, { kind: 'research', title: 'x\ny' },
    { kind: 'research', title: 'x', tags: 'tides' }, { kind: 'research', title: 'x', tags: [''] }, { kind: 'research', title: 'x', canon: 'yes' },
    { kind: 'research', title: 'x', links: ['nobody-here'] }, { kind: 'research', title: 'x', sources: ['no-such-source'] },
    { kind: 'source', title: 'x' }, { kind: 'source', title: 'x', cite_key: 'Bad Key' }, { kind: 'source', title: 'x', cite_key: 'k', year: 'a\nb' },
  ]) {
    const r = await post(ctx.port, u('notes'), body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
});

// ---------------------------------------------------------------- edit fields

for (const [label, prep, eol] of [['LF', undefined, ''], ['CRLF', toCrlf(N.tides[1]), '\r']]) {
  test(`edit research fields (${label}): title, canon, tags, sources, links each change only their own line`, async () => {
    const t = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { title: 'Tides and ranges' }), { prep });
    assert.deepEqual([t.removed, t.added], [[`title: Tidal ranges on the coast${eol}`], [`title: Tides and ranges${eol}`]]);
    const c = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { canon: true }), { prep });
    assert.deepEqual([c.removed, c.added], [[`canon: false${eol}`], [`canon: true${eol}`]]);
    const g = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { tags: ['tides', 'setting', 'maps'] }), { prep });
    assert.deepEqual([g.removed, g.added], [[`tags: [tides, setting]${eol}`], [`tags: [tides, setting, maps]${eol}`]]);
    const l = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { links: ['salt-orchard', 'brass-key', 'the-flood'] }), { prep });
    assert.deepEqual([l.removed, l.added], [[`links: [salt-orchard]${eol}`], [`links: [salt-orchard, brass-key, the-flood]${eol}`]]);
    const s = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { sources: [] }), { prep });
    assert.deepEqual([s.removed, s.added], [[`sources: [admiralty-tables]${eol}`], [`sources: []${eol}`]]);
    for (const d of [t, c, g, l, s]) {
      await assertOnlyChanged(d.ctx.root, d.original, N.tides[1]);
      assert.deepEqual(await errorsOf(d.ctx.root), []);
      if (eol) assert.ok(!/[^\r]\n/.test(d.after), 'no bare LF appeared');
    }
  });
}

test('edit research fields: a key the file lacks is inserted as one line (tags / links / canon), after the previous key', async () => {
  const bare = `---\nschema: storyforge.research/v1\nid: note_01S5000000000000000000DD01\ntitle: Bare\n---\nText.\n`;
  const ctx = await freshBook('valid/salt-orchard', putFile('research/bare.md', bare));
  const id = 'note_01S5000000000000000000DD01';
  const before = await text(ctx.root, 'research/bare.md');
  const r = await post(ctx.port, u('notes', id, 'fields'), { tags: ['a', 'b'], canon: true, links: ['pell'], sources: ['admiralty-tables'] });
  assert.equal(r.status, 200, r.text);
  const after = await text(ctx.root, 'research/bare.md');
  const d = lineDiff(before, after);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.sort(), ['canon: true', 'links: [pell]', 'sources: [admiralty-tables]', 'tags: [a, b]']);
  assert.equal(after.slice(after.indexOf('\n---', 4)), before.slice(before.indexOf('\n---', 4)), 'closing --- and body identical');
  assert.deepEqual(await errorsOf(ctx.root), []);
  const empty = await post(ctx.port, u('notes', id, 'fields'), { tags: [] });
  assert.ok(empty.status === 200 || empty.status === 400);
});

test('edit research fields: awkward text round-trips; tags that need quoting stay one value each', async () => {
  const awkward = 'He said: "wait" # not a comment, then [left].';
  const d = await diffOf(N.tides[1], ({ port }) => nfields(port, 'tides', { title: awkward, tags: ['a, b', 'c: d', '#e'] }));
  const fm = fmOf(d.after);
  assert.equal(fm.title, awkward);
  assert.deepEqual(fm.tags, ['a, b', 'c: d', '#e']);
  assert.equal(d.removed.length, 2);
  assert.deepEqual(await errorsOf(d.ctx.root), []);
});

test('edit research fields never touch the note text', async () => {
  const ctx = await freshBook();
  const before = await text(ctx.root, N.tides[1]);
  const r = await nfields(ctx.port, 'tides', { title: 'T', canon: true, tags: ['x'], links: ['pell'], sources: [] });
  assert.equal(r.status, 200, r.text);
  const after = await text(ctx.root, N.tides[1]);
  assert.equal(after.slice(after.indexOf('\n---', 4)), before.slice(before.indexOf('\n---', 4)));
});

test('edit planning doc: locked and title change only their own line; research-only fields are refused', async () => {
  const lock = await diffOf(N.plan[1], ({ port }) => nfields(port, 'plan', { locked: true }));
  assert.deepEqual([lock.removed, lock.added], [['locked: false'], ['locked: true']]);
  await assertOnlyChanged(lock.ctx.root, lock.original, N.plan[1]);
  const title = await diffOf(N.plan[1], ({ port }) => nfields(port, 'plan', { title: 'The plan' }));
  assert.deepEqual([title.removed, title.added], [['title: Book plan'], ['title: The plan']]);
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const body of [{ tags: ['x'] }, { canon: true }, { links: ['pell'] }, { sources: [] }, { author: 'x' }]) {
    const r = await nfields(ctx.port, 'plan', body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
    sameFiles(before, await readAll(ctx.root));
  }
});

test('edit source: a field is replaced in place, a missing one is inserted as one line, "" empties it; the cite_key never changes', async () => {
  const year = await diffOf(N.tables[1], ({ port }) => nfields(port, 'tables', { year: '2001' }));
  assert.deepEqual(year.removed, ['year: 1998']);
  assert.equal(year.added.length, 1);
  assert.equal(String(fmOf(year.after).year), '2001');
  const pub = await diffOf(N.tables[1], ({ port }) => nfields(port, 'tables', { publisher: 'Port Press', locator: 'p. 12' }));
  assert.deepEqual(pub.removed, []);
  assert.equal(pub.added.length, 2);
  const fm = fmOf(pub.after);
  assert.deepEqual([fm.publisher, fm.locator, fm.cite_key, fm.author], ['Port Press', 'p. 12', 'admiralty-tables', 'Aldine Harbour Office']);
  const clear = await diffOf(N.tables[1], ({ port }) => nfields(port, 'tables', { author: '' }));
  assert.equal(clear.removed.length, 1);
  assert.ok(!fmOf(clear.after).author);
  const noop = await freshBook();
  const before = await readAll(noop.root);
  const r = await nfields(noop.port, 'tables', { publisher: '' });
  assert.ok(r.status === 200 || r.status === 400, r.text);
  sameFiles(before, await readAll(noop.root));
  for (const d of [year, pub, clear]) {
    await assertOnlyChanged(d.ctx.root, d.original, N.tables[1]);
    assert.deepEqual(await errorsOf(d.ctx.root), []);
  }
  const bad = await nfields(noop.port, 'tables', { cite_key: 'renamed' });
  assert.ok(bad.status >= 400 && bad.status < 500, 'cite_key is not editable here');
  sameFiles(before, await readAll(noop.root));
});

test('edit: refusals write nothing (unknown note, empty change, wrong types, unknown link / source, stray control characters)', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const cases = [
    [u('notes', 'note_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'fields'), { title: 'x' }],
    [u('notes', N.tides[0], 'fields'), {}],
    [u('notes', N.tides[0], 'fields'), { title: '' }],
    [u('notes', N.tides[0], 'fields'), { title: 'a\nb' }],
    [u('notes', N.tides[0], 'fields'), { canon: 'yes' }],
    [u('notes', N.tides[0], 'fields'), { tags: 'tides' }],
    [u('notes', N.tides[0], 'fields'), { tags: [''] }],
    [u('notes', N.tides[0], 'fields'), { tags: ['a\nb'] }],
    [u('notes', N.tides[0], 'fields'), { links: ['nobody-here'] }],
    [u('notes', N.tides[0], 'fields'), { sources: ['no-such-source'] }],
    [u('notes', N.tides[0], 'fields'), { locked: true }],
    [u('notes', N.tides[0], 'fields'), { year: '2000' }],
    [u('notes', N.tables[0], 'fields'), { year: 'a\nb' }],
    [u('notes', N.tables[0], 'fields'), { tags: ['x'] }],
    [u('notes', 'tidal-ranges', 'fields'), { title: 'by slug is not an id' }],
  ];
  for (const [url, body] of cases) {
    const r = await post(ctx.port, url, body);
    assert.ok(r.status >= 400 && r.status < 500, `${url} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
});

test('edit: a stale base_sha256 is 409 and the external edit stays; the right one succeeds', async () => {
  const ctx = await freshBook();
  const base = sha(await fs.readFile(path.join(ctx.root, N.tides[1])));
  await fs.appendFile(path.join(ctx.root, N.tides[1]), '\nAn edit made elsewhere.\n');
  const before = await readAll(ctx.root);
  const r = await nfields(ctx.port, 'tides', { title: 'Nope', base_sha256: base });
  assert.equal(r.status, 409, r.text);
  sameFiles(before, await readAll(ctx.root));
  const ok = await nfields(ctx.port, 'tides', { title: 'Yes', base_sha256: sha(before.get(N.tides[1])) });
  assert.equal(ok.status, 200, ok.text);
  assert.match(await text(ctx.root, N.tides[1]), /An edit made elsewhere\./);
});

test('edit: an unsimple tag block (a comment inside it) is refused and nothing is written', async () => {
  const ctx = await freshBook('valid/salt-orchard', async (root) => {
    const f = path.join(root, ...N.tides[1].split('/'));
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/^tags: .*$/m, 'tags:\n  # by hand\n  - tides'));
  });
  const before = await readAll(ctx.root);
  const r = await nfields(ctx.port, 'tides', { tags: ['x'] });
  assert.ok(r.status >= 400 && r.status < 500, r.text);
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- note text

test('note text: PUT body saves new text, front matter bytes identical; stale / missing base refused', async () => {
  const ctx = await freshBook();
  const raw = await fs.readFile(path.join(ctx.root, N.tides[1]));
  const r = await send(ctx.port, 'PUT', u('notes', N.tides[0], 'body'), { body: { body: 'Rewritten, see [map](../assets/research/m.png) and [site](https://example.com).\n', base_sha256: sha(raw) } });
  assert.equal(r.status, 200, r.text);
  const now = await text(ctx.root, N.tides[1]);
  const head = (t) => t.slice(0, t.indexOf('\n---', 4) + 5);
  assert.equal(head(now), head(raw.toString('utf8')));
  assert.ok(now.endsWith('https://example.com).\n'));
  const before = await readAll(ctx.root);
  const stale = await send(ctx.port, 'PUT', u('notes', N.tides[0], 'body'), { body: { body: 'Again.\n', base_sha256: sha(raw) } });
  assert.equal(stale.status, 409, stale.text);
  const missing = await send(ctx.port, 'PUT', u('notes', N.tides[0], 'body'), { body: { body: 'Again.\n' } });
  assert.ok(missing.status >= 400 && missing.status < 500);
  sameFiles(before, await readAll(ctx.root));
});

test('note text: an absolute local path in the text is written (the editor is not a gatekeeper) and then shows as E103 in the note\'s problems', async () => {
  const ctx = await freshBook();
  const base = sha(await fs.readFile(path.join(ctx.root, N.tides[1])));
  const r = await send(ctx.port, 'PUT', u('notes', N.tides[0], 'body'), { body: { body: 'See [x](C:\\maps\\x.pdf).\n', base_sha256: base } });
  assert.ok([200, 400, 409].includes(r.status), r.text);
  if (r.status === 200) {
    const n = (await send(ctx.port, 'GET', u('notes', N.tides[0]))).json;
    assert.ok(n.problems.some((p) => p.code === 'E103'), JSON.stringify(n.problems));
  }
});

// ---------------------------------------------------------------- archive / restore

test('archive moves a research note, a doc and a source to archive/<same path> byte-identical; restore moves each back', async () => {
  for (const k of ['tides', 'plan', 'tables']) {
    const ctx = await freshBook();
    const original = await readAll(ctx.root);
    const r = await post(ctx.port, u('notes', N[k][0], 'archive'), {});
    assert.equal(r.status, 200, `${k}: ${r.text}`);
    const now = await readAll(ctx.root);
    assert.ok(!now.has(N[k][1]), k);
    assert.ok(now.get(`archive/${N[k][1]}`).equals(original.get(N[k][1])), `${k}: content byte-identical`);
    assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), [`archive/${N[k][1]}`]);
    assert.deepEqual(await errorsOf(ctx.root), [], `${k}: archiving never adds an error`);
    const list = (await send(ctx.port, 'GET', u('notes'))).json.notes;
    assert.equal(list.find((n) => n.id === N[k][0]).archived, true, k);
    const back = await post(ctx.port, u('notes', N[k][0], 'restore'), {});
    assert.equal(back.status, 200, `${k}: ${back.text}`);
    sameFiles(original, await readAll(ctx.root));
  }
});

test('archiving a cited source leaves the citing note with a warning at most, and the note shows the source as archived', async () => {
  const ctx = await freshBook();
  assert.equal((await post(ctx.port, u('notes', N.tables[0], 'archive'), {})).status, 200);
  assert.deepEqual(await errorsOf(ctx.root), []);
  const n = (await send(ctx.port, 'GET', u('notes'))).json.notes.find((x) => x.id === N.tides[0]);
  assert.deepEqual(n.sources.map((s) => [s.cite_key, s.state]), [['admiralty-tables', 'archived']]);
});

test('restore: a live source with the same cite key now is 409 CITE_KEY_TAKEN; a file already at the path is 409 REFUSED_PATH_TAKEN; both write nothing', async () => {
  const ctx = await freshBook();
  assert.equal((await post(ctx.port, u('notes', N.tables[0], 'archive'), {})).status, 200);
  const dup = `---\nschema: storyforge.source/v1\nid: note_01S5000000000000000000EE01\ncite_key: admiralty-tables\ntype: report\ntitle: A newer copy\n---\n`;
  await putFile('research/sources/newer.md', dup)(ctx.root);
  const before = await readAll(ctx.root);
  const r = await post(ctx.port, u('notes', N.tables[0], 'restore'), {});
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'CITE_KEY_TAKEN');
  sameFiles(before, await readAll(ctx.root));

  const c2 = await freshBook();
  assert.equal((await post(c2.port, u('notes', N.tides[0], 'archive'), {})).status, 200);
  assert.equal((await post(c2.port, u('notes'), { kind: 'research', title: 'Replacement', slug: 'tidal-ranges' })).status, 201);
  const b2 = await readAll(c2.root);
  const r2 = await post(c2.port, u('notes', N.tides[0], 'restore'), {});
  assert.equal(r2.status, 409, r2.text);
  assert.equal(r2.json.code, 'REFUSED_PATH_TAKEN');
  sameFiles(b2, await readAll(c2.root));
});

test('archive / restore of a note that is not there (or already in the other state) is refused and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const [k, body] of [['note_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'archive'], ['note_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'restore'], [N.tides[0], 'restore']]) {
    const r = await post(ctx.port, u('notes', k, body), {});
    assert.ok(r.status >= 400 && r.status < 500, `${k} ${body} -> ${r.status}`);
    sameFiles(before, await readAll(ctx.root));
  }
  await post(ctx.port, u('notes', N.tides[0], 'archive'), {});
  const mid = await readAll(ctx.root);
  assert.ok((await post(ctx.port, u('notes', N.tides[0], 'archive'), {})).status >= 400);
  sameFiles(mid, await readAll(ctx.root));
});

test('Undo (ops/:opId/restore) of a fields edit and of an archive is byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  for (const act of [
    () => nfields(ctx.port, 'tides', { title: 'Changed', canon: true, tags: ['z'] }),
    () => post(ctx.port, u('notes', N.plan[0], 'archive'), {}),
    () => post(ctx.port, u('notes', N.tables[0], 'archive'), {}),
  ]) {
    const r = await act();
    assert.equal(r.status, 200, r.text);
    const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
    assert.equal(un.status, 200, un.text);
    sameFiles(original, await readAll(ctx.root));
  }
});

// ---------------------------------------------------------------- dry runs and guards

test('dry runs write nothing and report the would-be changes (create x3, fields, archive, restore)', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const [url, body] of [
    [u('notes'), { kind: 'research', title: 'Dry', dryRun: true }],
    [u('notes'), { kind: 'doc', title: 'Dry', dryRun: true }],
    [u('notes'), { kind: 'source', title: 'Dry', cite_key: 'dry-source', dryRun: true }],
    [u('notes', N.tides[0], 'fields'), { title: 'Dry', tags: ['x'], dryRun: true }],
    [u('notes', N.tides[0], 'archive'), { dryRun: true }],
  ]) {
    const r = await post(ctx.port, url, body);
    assert.equal(r.status, 200, `${url} ${JSON.stringify(body)}: ${r.text}`);
    assert.ok(Array.isArray(r.json.changes) && r.json.changes.length >= 1, `${url}: ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
  await post(ctx.port, u('notes', N.tides[0], 'archive'), {});
  const mid = await readAll(ctx.root);
  const r = await post(ctx.port, u('notes', N.tides[0], 'restore'), { dryRun: true });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.changes.length >= 1);
  sameFiles(mid, await readAll(ctx.root));
});

test('a dry run still refuses what a real run would (CITE_KEY_TAKEN, unknown link) and still writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const a = await post(ctx.port, u('notes'), { kind: 'source', title: 'x', cite_key: 'admiralty-tables', dryRun: true });
  assert.equal(a.status, 409, a.text);
  assert.equal(a.json.code, 'CITE_KEY_TAKEN');
  const b = await post(ctx.port, u('notes'), { kind: 'research', title: 'x', links: ['nobody-here'], dryRun: true });
  assert.ok(b.status >= 400 && b.status < 500, b.text);
  sameFiles(before, await readAll(ctx.root));
});

test('every note write route is 403 without the write guard (header / content type / host) and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const sha0 = sha(before.get(N.tides[1]));
  const calls = [
    ['POST', u('notes'), { kind: 'research', title: 'Nope' }],
    ['POST', u('notes', N.tides[0], 'fields'), { title: 'Nope' }],
    ['POST', u('notes', N.tides[0], 'archive'), {}],
    ['POST', u('notes', N.tides[0], 'restore'), {}],
    ['PUT', u('notes', N.tides[0], 'body'), { body: 'x\n', base_sha256: sha0 }],
  ];
  for (const [m, p, body] of calls) {
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'application/json' }, body })).status, 403, `${m} ${p} without x-storyforge`);
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body })).status, 403, `${m} ${p} wrong content type`);
    assert.equal((await send(ctx.port, m, p, { body, host: 'evil.example.com' })).status, 403, `${m} ${p} foreign host`);
  }
  sameFiles(before, await readAll(ctx.root));
});

test('unknown book is 404 for note writes', async () => {
  const { port } = await freshBook();
  assert.equal((await post(port, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/notes', { kind: 'research', title: 'x' })).status, 404);
});
