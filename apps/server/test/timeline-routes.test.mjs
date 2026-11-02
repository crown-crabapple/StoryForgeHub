// M04-J04 acceptance 2 (timeline data from the API), 3 (reorder by `order` midpoint: one line changes, Undo is byte-identical) and
// 4 (events: exact file effects of create / edit fields / lists / scenes incl. the optional two-sided `events` edit / archive / restore;
// refusals write nothing; 403 guards; dry runs):
//   GET  /api/books/:b/timeline                        { events, archived, scenes, entries, threads, unreadable, prefix }
//   GET  /api/books/:b/events/:e                       one event + body + sha256
//   POST /api/books/:b/events                          { title, slug?, order?, when?, date?, scenes?, characters?, locations?, dryRun? }
//   POST /api/books/:b/events/:e/fields                { title?, when?, date?, order?, scenes?, characters?, locations?, add?, remove?, two_sided?, base_sha256?, dryRun? }
//   POST /api/books/:b/events/:e/archive | restore     { base_sha256?, dryRun? }      POST /api/books/:b/events/restore { path | id }
//   PUT  /api/books/:b/events/:e/body                  { body, base_sha256 }
// Contract: docs/contracts/M04-J04-timeline-research.md sections 1, 2 and acceptance 2-4; FORMAT-v1 section 6.2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import { ARRIVAL, BOOK, FERRY, GRAFTING, KEY, KEY_ALT, LOWTIDE, PROLOGUE, WALL, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(closeAll);

const ARCHIVED_SCENE = 'scene_01S50000000000000000000007';
const EV = {
  grafting: ['event_01S5000000000000000000000V', 'the-first-grafting'],
  flood: ['event_01S5000000000000000000000W', 'the-flood'],
  key: ['event_01S5000000000000000000000X', 'the-key-found-twice'],
  ret: ['event_01S5000000000000000000000Y', 'the-return'],
  wall: ['event_01S5000000000000000000000Z', 'the-wall-falls'],
};
const file = (k) => `planning/timeline/${EV[k][1]}.md`;
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const fields = (port, k, body) => post(port, u('events', EV[k][0], 'fields'), body);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const text = async (root, rel) => (await fs.readFile(path.join(root, ...rel.split('/')))).toString('utf8');
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const codes = async (root) => (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}`).sort();
const fmOf = (raw) => YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)[1]);
const toCrlf = (rel) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\r?\n/g, '\r\n'));
};
const sameFiles = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of paths');
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical`);
};
const putFile = (rel, content) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content);
};
const seq = (...preps) => async (root) => { for (const p of preps) await p(root); };

/** Lines removed and added between two texts (LCS), independent of the code under test. */
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

/** One request against a fresh salt-orchard copy; the line diff of `target` (a book-relative file). */
async function diffOf(target, act, { prep, expectStatus = [200, 201] } = {}) {
  const ctx = await freshBook('valid/salt-orchard', prep);
  const before = await text(ctx.root, target);
  const original = await readAll(ctx.root);
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

// ---------------------------------------------------------------- acceptance 2: timeline data

test('2. GET timeline on salt-orchard: the five events by order then id, every field as in the files', async () => {
  const { port } = await freshBook();
  const r = await send(port, 'GET', u('timeline'));
  assert.equal(r.status, 200, r.text);
  const t = r.json;
  assert.deepEqual(t.events.map((e) => e.slug), ['the-first-grafting', 'the-flood', 'the-key-found-twice', 'the-return', 'the-wall-falls']);
  assert.deepEqual(t.events.map((e) => e.id), Object.values(EV).map(([id]) => id));
  assert.deepEqual(t.events.map((e) => e.order), [10, 100, 150, 200, 300]);
  assert.deepEqual(t.events.map((e) => e.when), ['Autumn, year -30', 'Spring, year 0', 'Spring, year 30', 'Spring, year 30', 'Summer, year 30']);
  assert.deepEqual(t.events.map((e) => e.title), ['The first grafting', 'The spring flood', 'The key is found', 'Maren returns', 'The wall falls']);
  for (const e of t.events) {
    assert.equal(e.date, '', `${e.slug}: no date`);
    assert.deepEqual(e.characters, []);
    assert.deepEqual(e.locations, []);
    assert.deepEqual(e.problems, [], `${e.slug}: salt-orchard has no diagnostics`);
    assert.ok(!e.stale);
    assert.ok(e.path.endsWith(`planning/timeline/${e.slug}.md`));
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(t.archived, []);
  assert.deepEqual(t.unreadable, []);
});

test('2. the union of an event\'s scenes list and the scenes naming it, with state, side and the narrative position (variants and archived are not placed)', async () => {
  const { port } = await freshBook();
  const t = (await send(port, 'GET', u('timeline'))).json;
  const by = (k) => t.events.find((e) => e.id === EV[k][0]);
  const rows = (k) => by(k).scenes.map((s) => [s.id, s.state, s.side, s.position !== null]);
  assert.deepEqual(rows('grafting'), [[GRAFTING, 'live', 'event', true]]);
  assert.deepEqual(rows('flood'), [[PROLOGUE, 'live', 'both', true]], 'both sides agree');
  assert.deepEqual(rows('key'), [[KEY_ALT, 'variant', 'event', false]], 'a variant has no narrative position');
  assert.deepEqual(rows('ret'), [[ARRIVAL, 'live', 'scene', true]], 'one-sided link (only the scene names the event) still counts');
  assert.deepEqual(rows('wall'), [[WALL, 'live', 'both', true]]);

  // positions agree with the book's reading order
  const order = t.scenes.map((s) => s.id);
  assert.deepEqual(order, [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
  const pos = (k) => by(k).scenes[0].position;
  for (const k of ['grafting', 'flood', 'ret', 'wall']) assert.equal(pos(k), t.scenes.find((s) => s.id === by(k).scenes[0].id).position, k);
  assert.ok(pos('flood') < pos('ret') && pos('ret') < pos('grafting') && pos('grafting') < pos('wall'), 'narrative order: flood, return, first grafting, wall');
  assert.ok(by('flood').scenes[0].chapter_label !== undefined && by('flood').scenes[0].act !== undefined);
});

test('2. the page inputs: scenes in book order, live entries (id, slug, name, type), threads with their scene lists', async () => {
  const { port } = await freshBook();
  const t = (await send(port, 'GET', u('timeline'))).json;
  assert.ok(t.scenes.every((s, i) => i === 0 || s.position > t.scenes[i - 1].position));
  const slugs = t.entries.map((e) => e.slug).sort();
  assert.deepEqual(slugs, ['ferry-bell', 'grafting-knife', 'harbour-board', 'ilse-hollis', 'maren-hollis', 'pell', 'port-aldine', 'salt-orchard', 'saltmarks', 'tobin-reyes']);
  const maren = t.entries.find((e) => e.slug === 'maren-hollis');
  assert.deepEqual([maren.name, maren.type], ['Maren Hollis', 'character']);
  assert.equal(t.threads.length, 1);
  assert.deepEqual([t.threads[0].slug, t.threads[0].setup, t.threads[0].payoff], ['brass-key', [KEY], [WALL]]);
});

test('2. simultaneous events (equal order) sort by id; scenes of an event are listed in book order', async () => {
  const twin = `---\nschema: storyforge.event/v1\nid: event_01S5000000000000000000000A\nslug: the-flood-twin\ntitle: The flood, seen from the ferry\norder: 100\nwhen: "Spring, year 0"\nscenes: [${WALL}, ${FERRY}]\n---\nSame moment.\n`;
  const { port } = await freshBook('valid/salt-orchard', putFile('planning/timeline/the-flood-twin.md', twin));
  const t = (await send(port, 'GET', u('timeline'))).json;
  assert.deepEqual(t.events.map((e) => e.slug), ['the-first-grafting', 'the-flood-twin', 'the-flood', 'the-key-found-twice', 'the-return', 'the-wall-falls'], '...0A sorts before ...0W');
  const twinRow = t.events[1];
  assert.deepEqual(twinRow.scenes.map((s) => s.id), [FERRY, WALL], 'scenes by narrative position, not as listed');
  assert.deepEqual(twinRow.problems, []);
});

test('2. problems: bad date E102, broken scene reference E301, archived scene state, listed per event', async () => {
  const bad = (slug, n, extra) => `---\nschema: storyforge.event/v1\nid: event_01S5000000000000000000AA0${n}\nslug: ${slug}\ntitle: ${slug}\norder: ${400 + n}\n${extra}---\n`;
  const { port } = await freshBook('valid/salt-orchard', seq(
    putFile('planning/timeline/bad-date.md', bad('bad-date', 1, 'date: "2024-13-45"\n')),
    putFile('planning/timeline/broken-scene.md', bad('broken-scene', 2, 'scenes: [scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ]\n')),
    putFile('planning/timeline/archived-scene.md', bad('archived-scene', 3, `scenes: [${ARCHIVED_SCENE}]\n`)),
  ));
  const t = (await send(port, 'GET', u('timeline'))).json;
  const ev = (s) => t.events.find((e) => e.slug === s);
  assert.deepEqual(ev('bad-date').problems.map((p) => `${p.code}|${p.severity}|${p.location}`), ['E102|error|date']);
  assert.deepEqual(ev('broken-scene').problems.map((p) => `${p.code}|${p.severity}|${p.location}`), ['E301|error|scenes[0]']);
  assert.deepEqual(ev('broken-scene').scenes.map((s) => s.state), ['missing']);
  const arch = ev('archived-scene');
  assert.deepEqual(arch.scenes.map((s) => [s.id, s.state, s.position]), [[ARCHIVED_SCENE, 'archived', null]]);
  assert.ok(arch.problems.every((p) => p.severity !== 'error'), 'archived scene is a warning at most');
  for (const s of ['the-flood', 'the-return', 'the-first-grafting']) assert.deepEqual(ev(s).problems, [], 'other events stay clean');
});

test('2. GET one event by id and by slug: body byte for byte, sha256 of the file; unknown event and unknown book are 404', async () => {
  const { port, root } = await freshBook();
  const raw = await fs.readFile(path.join(root, file('flood')));
  for (const ref of [EV.flood[0], EV.flood[1]]) {
    const r = await send(port, 'GET', u('events', ref));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.id, EV.flood[0]);
    assert.equal(r.json.sha256, sha(raw));
    assert.ok(raw.toString('utf8').endsWith(r.json.body));
    assert.match(r.json.body, /The spring flood\./);
  }
  assert.equal((await send(port, 'GET', u('events', 'event_01S5ZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);
  assert.equal((await send(port, 'GET', u('events', 'no-such-event'))).status, 404);
  assert.equal((await send(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/timeline')).status, 404);
});

test('2. an event whose file became unreadable is reported (unreadable) with the last valid projection kept, marked stale', async () => {
  const { port, root } = await freshBook();
  assert.equal((await send(port, 'GET', u('timeline'))).status, 200); // primes the last-good copy
  await fs.writeFile(path.join(root, file('flood')), '---\nschema: storyforge.event/v1\ntitle: [unclosed\n---\nbroken\n');
  const t = (await send(port, 'GET', u('timeline'))).json;
  assert.ok(t.unreadable.some((x) => x.path === file('flood') && x.code === 'E100'), JSON.stringify(t.unreadable));
  const kept = t.events.find((e) => e.id === EV.flood[0]);
  assert.ok(kept, 'the last valid event is still listed');
  assert.equal(kept.stale, true);
  assert.equal(kept.order, 100);
  assert.ok(kept.problems.some((p) => p.code === 'E100'));
  assert.equal(t.events.length, 5);
});

// ---------------------------------------------------------------- acceptance 3: midpoint reorder

test('3. dropping an event between two others sets only its order to the midpoint: one line changes (LF and CRLF)', async () => {
  for (const [label, prep, eol] of [['LF', undefined, ''], ['CRLF', toCrlf(file('wall')), '\r']]) {
    // story time: grafting 10, flood 100, key 150, return 200, wall 300; drop the wall between the flood (100) and the key (150)
    const d = await diffOf(file('wall'), ({ port }) => fields(port, 'wall', { order: 125 }), { prep });
    assert.deepEqual(d.removed, [`order: 300${eol}`], label);
    assert.deepEqual(d.added, [`order: 125${eol}`], label);
    await assertOnlyChanged(d.ctx.root, d.original, file('wall'));
    assert.deepEqual(await errorsOf(d.ctx.root), []);
    const t = (await send(d.ctx.port, 'GET', u('timeline'))).json;
    assert.deepEqual(t.events.map((e) => e.slug), ['the-first-grafting', 'the-flood', 'the-wall-falls', 'the-key-found-twice', 'the-return']);
    assert.deepEqual(t.events.map((e) => e.order), [10, 100, 125, 150, 200], 'no other event was renumbered');
  }
});

test('3. repeated midpoints produce decimals, still one line each, never renumbering the others', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  // keep dropping the wall just after the flood: 125, 112.5, 106.25, 103.125
  for (const [n, order] of [[1, 125], [2, 112.5], [3, 106.25], [4, 103.125]]) {
    const before = await text(ctx.root, file('wall'));
    const r = await fields(ctx.port, 'wall', { order });
    assert.equal(r.status, 200, `${n}: ${r.text}`);
    const d = lineDiff(before, await text(ctx.root, file('wall')));
    assert.equal(d.removed.length, 1, `${n}`);
    assert.deepEqual(d.added, [`order: ${order}`], `${n}`);
  }
  await assertOnlyChanged(ctx.root, original, file('wall'));
  const t = (await send(ctx.port, 'GET', u('timeline'))).json;
  assert.deepEqual(t.events.map((e) => e.slug), ['the-first-grafting', 'the-flood', 'the-wall-falls', 'the-key-found-twice', 'the-return']);
  assert.equal(t.events.find((e) => e.slug === 'the-wall-falls').order, 103.125);
  assert.deepEqual(await errorsOf(ctx.root), []);
});

test('3. dropping first / last, and onto a simultaneous slot, are single-line edits too (before 10, after 300, equal to 100)', async () => {
  for (const [slug, key, order] of [['first', 'flood', 5], ['last', 'flood', 310], ['simultaneous', 'ret', 100], ['zero', 'ret', 0], ['negative', 'key', -20]]) {
    const d = await diffOf(file(key), ({ port }) => fields(port, key, { order }));
    assert.equal(d.removed.length, 1, slug);
    assert.deepEqual(d.added, [`order: ${order}`], slug);
    await assertOnlyChanged(d.ctx.root, d.original, file(key));
    assert.deepEqual(await errorsOf(d.ctx.root), [], slug);
  }
});

test('3. a float-rounding midpoint is written as a plain short number, not 0.30000000000000004', async () => {
  const d = await diffOf(file('key'), ({ port }) => fields(port, 'key', { order: 0.1 + 0.2 }));
  assert.deepEqual(d.added, ['order: 0.3']);
});

test('3. Undo (ops/:opId/restore) of a reorder is byte-identical, including the file times not mattering', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await fields(ctx.port, 'wall', { order: 125 });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string');
  assert.notEqual(await text(ctx.root, file('wall')), original.get(file('wall')).toString('utf8'));
  const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  sameFiles(original, await readAll(ctx.root));
});

test('3. a reorder with a stale base_sha256 is 409 and the external edit stays', async () => {
  const ctx = await freshBook();
  const base = sha(await fs.readFile(path.join(ctx.root, file('wall'))));
  await fs.appendFile(path.join(ctx.root, file('wall')), '\nAdded elsewhere.\n');
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, 'wall', { order: 125, base_sha256: base });
  assert.equal(r.status, 409, r.text);
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- acceptance 4: file effects

test('4. new event: one new file planning/timeline/<slug>.md, exact front matter, default order = last + 10, valid and listed', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('events'), { title: 'The ferry sinks', slug: 'ferry-sinks', when: 'Autumn, year 30', date: '2024-10' });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), ['planning/timeline/ferry-sinks.md']);
  for (const [p, buf] of original) assert.ok(now.get(p).equals(buf), `${p} untouched`);
  const raw = await text(ctx.root, 'planning/timeline/ferry-sinks.md');
  const fm = fmOf(raw);
  assert.equal(fm.schema, 'storyforge.event/v1');
  assert.match(fm.id, /^event_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(fm.slug, 'ferry-sinks');
  assert.equal(fm.title, 'The ferry sinks');
  assert.equal(fm.order, 310);
  assert.equal(fm.when, 'Autumn, year 30');
  assert.equal(fm.date, '2024-10');
  assert.deepEqual([fm.scenes, fm.characters, fm.locations], [[], [], []]);
  assert.ok(raw.endsWith('---\n'), 'empty body');
  assert.deepEqual(await codes(ctx.root), []);
  assert.equal(r.json.id, fm.id);
  assert.equal(r.json.path, 'planning/timeline/ferry-sinks.md');
  const list = (await send(ctx.port, 'GET', u('timeline'))).json;
  assert.deepEqual(list.events.at(-1).slug, 'ferry-sinks');
});

test('4. new event: slug from the title, explicit order (decimal), scenes / characters / locations given; two-sided not implied', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('events'), { title: 'Tobin Hears The Bell', order: 105.5, scenes: [FERRY], characters: ['tobin-reyes'], locations: ['port-aldine'] });
  assert.equal(r.status, 201, r.text);
  const f = 'planning/timeline/tobin-hears-the-bell.md';
  const fm = fmOf(await text(ctx.root, f));
  assert.equal(fm.order, 105.5);
  assert.deepEqual([fm.scenes, fm.characters, fm.locations], [[FERRY], ['tobin-reyes'], ['port-aldine']]);
  assert.ok(!/^(when|date):/m.test(await text(ctx.root, f)), 'no when / date lines when none given');
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), [f]);
  for (const [p, buf] of original) assert.ok(now.get(p).equals(buf), `${p} untouched (the scene is not edited by create)`);
  assert.deepEqual(await errorsOf(ctx.root), []);
});

test('4. the first event of a book without events gets order 10', async () => {
  const ctx = await freshBook('valid/codex-graph', async (root) => {
    await fs.rm(path.join(root, 'planning', 'timeline'), { recursive: true });
    const f = path.join(root, 'manuscript', 'act-01-one', 'ch-001-one', '0010-landfall.md');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/^events: \[the-landfall\]\r?\n/m, ''));
  });
  const book = 'book_01CG0000000000000000000001';
  const r = await post(ctx.port, `/api/books/${book}/events`, { title: 'First' });
  assert.equal(r.status, 201, r.text);
  assert.equal(fmOf(await text(ctx.root, 'planning/timeline/first.md')).order, 10);
});

test('4. new event: SLUG_TAKEN (event, thread and entry slugs) is 409 and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const slug of ['the-flood', 'brass-key', 'maren-hollis']) {
    const r = await post(ctx.port, u('events'), { title: 'Clash', slug });
    assert.equal(r.status, 409, `${slug}: ${r.text}`);
    assert.equal(r.json.code, 'SLUG_TAKEN');
    sameFiles(before, await readAll(ctx.root));
  }
});

for (const [label, prep, eol] of [['LF', undefined, ''], ['CRLF', toCrlf(file('flood')), '\r']]) {
  test(`4. edit fields (${label}): title, when, order each change only their own line`, async () => {
    const t = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { title: 'The great flood' }), { prep });
    assert.deepEqual(t.removed, [`title: The spring flood${eol}`]);
    assert.deepEqual(t.added, [`title: The great flood${eol}`]);
    const w = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { when: 'Spring, year 1' }), { prep });
    assert.deepEqual(w.removed, [`when: "Spring, year 0"${eol}`]);
    assert.equal(w.added.length, 1);
    assert.equal(fmOf(w.after).when, 'Spring, year 1');
    const o = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { order: 101 }), { prep });
    assert.deepEqual(o.removed, [`order: 100${eol}`]);
    assert.deepEqual(o.added, [`order: 101${eol}`]);
    for (const d of [t, w, o]) {
      await assertOnlyChanged(d.ctx.root, d.original, file('flood'));
      assert.deepEqual(await errorsOf(d.ctx.root), []);
      if (eol) assert.ok(!/[^\r]\n/.test(d.after), 'no bare LF appeared');
    }
  });
}

test('4. edit fields: a date is inserted as exactly one line, replaced in place, and "" empties the line', async () => {
  const ins = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { date: '1998-07-21' }));
  assert.deepEqual(ins.removed, []);
  assert.equal(ins.added.length, 1);
  assert.match(ins.added[0], /^date: .*1998-07-21/);
  assert.equal(fmOf(ins.after).date, '1998-07-21');
  assert.deepEqual(await errorsOf(ins.ctx.root), []);

  const dated = async (root) => { const f = path.join(root, ...file('flood').split('/')); await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('when:', 'date: "1998"\nwhen:')); };
  const rep = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { date: '1998-07' }), { prep: dated });
  assert.equal(rep.removed.length, 1);
  assert.equal(rep.added.length, 1);
  assert.equal(fmOf(rep.after).date, '1998-07');
  const clear = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { date: '' }), { prep: dated });
  assert.equal(fmOf(clear.after).date ?? '', '');
  assert.deepEqual(await errorsOf(clear.ctx.root), []);
  for (const y of ['2024', '2024-02', '2024-02-29']) {
    const ok = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { date: y }));
    assert.equal(String(fmOf(ok.after).date), y);
  }
});

test('4. edit fields: characters and locations are inserted as one block each when the file lacks the key; replaced when present', async () => {
  const d = await diffOf(file('wall'), ({ port }) => fields(port, 'wall', { characters: ['maren-hollis', 'pell'], locations: ['salt-orchard'] }));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.map((l) => l.replace(/\r$/, '')), ['characters: [maren-hollis, pell]', 'locations: [salt-orchard]']);
  const fm = fmOf(d.after);
  assert.deepEqual([fm.characters, fm.locations], [['maren-hollis', 'pell'], ['salt-orchard']]);
  await assertOnlyChanged(d.ctx.root, d.original, file('wall'));
  assert.deepEqual(await errorsOf(d.ctx.root), []);

  // now replace: the second edit changes only the characters line
  const before = await text(d.ctx.root, file('wall'));
  const r = await fields(d.ctx.port, 'wall', { characters: ['pell'] });
  assert.equal(r.status, 200, r.text);
  const d2 = lineDiff(before, await text(d.ctx.root, file('wall')));
  assert.deepEqual(d2.removed, ['characters: [maren-hollis, pell]']);
  assert.deepEqual(d2.added, ['characters: [pell]']);
  // and by id
  const r2 = await fields(d.ctx.port, 'wall', { characters: ['entry_01S5000000000000000000000G'] });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(await errorsOf(d.ctx.root), []);
});

test('4. edit fields: an empty list for a key the file does not have changes nothing (no empty line added), and is not an error', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, 'wall', { characters: [], locations: [] });
  assert.ok(r.status === 200 || r.status === 400, r.text);
  sameFiles(before, await readAll(ctx.root));
});

test('4. scenes: replace / add / remove change only the scenes line of the event file', async () => {
  const rep = await diffOf(file('wall'), ({ port }) => fields(port, 'wall', { scenes: [WALL, LOWTIDE] }));
  assert.deepEqual(rep.removed, [`scenes: [${WALL}]`]);
  assert.deepEqual(rep.added, [`scenes: [${WALL}, ${LOWTIDE}]`]);
  await assertOnlyChanged(rep.ctx.root, rep.original, file('wall'));

  const add = await diffOf(file('wall'), ({ port }) => fields(port, 'wall', { add: { scenes: [GRAFTING] } }));
  assert.deepEqual(add.removed, [`scenes: [${WALL}]`]);
  assert.deepEqual(add.added, [`scenes: [${WALL}, ${GRAFTING}]`]);
  await assertOnlyChanged(add.ctx.root, add.original, file('wall'));

  const rem = await diffOf(file('wall'), ({ port }) => fields(port, 'wall', { remove: { scenes: [WALL] } }));
  assert.deepEqual(rem.removed, [`scenes: [${WALL}]`]);
  assert.deepEqual(rem.added, ['scenes: []']);
  assert.deepEqual(await errorsOf(rem.ctx.root), []);

  const noop = await freshBook();
  const before = await readAll(noop.root);
  const r = await fields(noop.port, 'wall', { add: { scenes: [WALL] } });
  assert.ok(r.status === 200 || r.status === 400, r.text);
  sameFiles(before, await readAll(noop.root));
});

test('4. a scene list on an event that has none yet: one inserted line after the last of order / when', async () => {
  const d = await diffOf(file('ret'), ({ port }) => fields(port, 'ret', { add: { scenes: [KEY] } }));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, [`scenes: [${KEY}]`]);
  const lines = d.after.split('\n');
  assert.equal(lines[lines.findIndex((l) => l.startsWith('when:')) + 1], `scenes: [${KEY}]`);
});

test('4. optional two-sided edit: adding a scene also adds the event to that scene\'s `events` (exactly one scene line), and nothing else', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const FERRY_FILE = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md';
  const before = await text(ctx.root, FERRY_FILE);
  const r = await fields(ctx.port, 'flood', { add: { scenes: [FERRY] }, two_sided: true });
  assert.equal(r.status, 200, r.text);
  await assertOnlyChanged(ctx.root, original, file('flood'), FERRY_FILE);
  assert.deepEqual(lineDiff(original.get(file('flood')).toString('utf8'), await text(ctx.root, file('flood'))), { removed: [`scenes: [${PROLOGUE}]`], added: [`scenes: [${PROLOGUE}, ${FERRY}]`] });
  const d = lineDiff(before, await text(ctx.root, FERRY_FILE));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.map((l) => l.replace(/\r$/, '')), ['events: [the-flood]']);
  assert.deepEqual(await errorsOf(ctx.root), []);
  assert.deepEqual(await codes(ctx.root), []);
  const t = (await send(ctx.port, 'GET', u('timeline'))).json;
  assert.equal(t.events.find((e) => e.slug === 'the-flood').scenes.find((s) => s.id === FERRY).side, 'both');
});

test('4. two-sided edit appends to a scene\'s existing events list (one replaced line) and never duplicates', async () => {
  const ctx = await freshBook();
  const SCENE_FILE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md'; // events: [the-return]
  const before = await text(ctx.root, SCENE_FILE);
  const r = await fields(ctx.port, 'flood', { add: { scenes: [ARRIVAL] }, two_sided: true });
  assert.equal(r.status, 200, r.text);
  const d = lineDiff(before, await text(ctx.root, SCENE_FILE));
  assert.deepEqual(d.removed.map((l) => l.replace(/\r$/, '')), ['events: [the-return]']);
  assert.deepEqual(d.added.map((l) => l.replace(/\r$/, '')), ['events: [the-return, the-flood]']);
  // a second identical request must not list it twice
  const again = await fields(ctx.port, 'flood', { add: { scenes: [ARRIVAL] }, two_sided: true });
  assert.ok(again.status === 200 || again.status === 400);
  assert.equal((await text(ctx.root, SCENE_FILE)).match(/the-flood/g).length, 1);
});

test('4. two-sided removal takes the event out of the scene\'s events list too; without two_sided the scene file is left alone', async () => {
  const SCENE_FILE = 'manuscript/act-01-low-water/ch-000-prologue/0010-before-the-tide.md'; // events: [the-flood]
  const two = await diffOf(SCENE_FILE, ({ port }) => fields(port, 'flood', { remove: { scenes: [PROLOGUE] }, two_sided: true }));
  assert.deepEqual(two.removed.map((l) => l.replace(/\r$/, '')), ['events: [the-flood]']);
  assert.ok(!/the-flood/.test(two.after), 'the scene no longer names the event');
  assert.deepEqual(await errorsOf(two.ctx.root), []);
  const t = (await send(two.ctx.port, 'GET', u('timeline'))).json;
  assert.deepEqual(t.events.find((e) => e.slug === 'the-flood').scenes, []);

  const one = await diffOf(SCENE_FILE, ({ port }) => fields(port, 'flood', { remove: { scenes: [PROLOGUE] } }));
  assert.deepEqual(one.removed, []);
  assert.deepEqual(one.added, []);
  const t2 = (await send(one.ctx.port, 'GET', u('timeline'))).json;
  const rows = t2.events.find((e) => e.slug === 'the-flood').scenes;
  assert.deepEqual(rows.map((s) => [s.id, s.side]), [[PROLOGUE, 'scene']], 'the scene side still links: a one-sided link is valid');
});

test('4. text fields round-trip awkward text through YAML (colon, quote, hash, bracket)', async () => {
  const awkward = 'He said: "wait" # not a comment, then [left].';
  const d = await diffOf(file('flood'), ({ port }) => fields(port, 'flood', { title: awkward, when: awkward }));
  const fm = fmOf(d.after);
  assert.equal(fm.title, awkward);
  assert.equal(fm.when, awkward);
  assert.equal(d.removed.length, 2);
  assert.equal(d.added.length, 2);
  assert.deepEqual(await errorsOf(d.ctx.root), []);
});

test('4. edit fields never touch the event body or the closing front matter', async () => {
  const ctx = await freshBook();
  const before = await text(ctx.root, file('flood'));
  const r = await fields(ctx.port, 'flood', { title: 'T', when: 'W', order: 1, date: '2000', characters: ['pell'], locations: ['port-aldine'], scenes: [KEY] });
  assert.equal(r.status, 200, r.text);
  const after = await text(ctx.root, file('flood'));
  assert.equal(after.slice(after.indexOf('\n---', 4)), before.slice(before.indexOf('\n---', 4)));
});

test('4. archive moves the file to archive/planning/timeline/ byte-identical; the scenes\' links keep working (W303 at most); Undo restores', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('events', EV.flood[0], 'archive'), {});
  assert.equal(r.status, 200, r.text);
  const now = await readAll(ctx.root);
  assert.ok(!now.has(file('flood')));
  assert.ok(now.get(`archive/${file('flood')}`).equals(original.get(file('flood'))), 'content byte-identical');
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), [`archive/${file('flood')}`]);
  assert.deepEqual(await errorsOf(ctx.root), []);
  const t = (await send(ctx.port, 'GET', u('timeline'))).json;
  assert.ok(!t.events.some((e) => e.slug === 'the-flood'));
  assert.deepEqual(t.archived.map((a) => [a.id, a.slug, a.path]), [[EV.flood[0], 'the-flood', `archive/${file('flood')}`]]);
  const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  sameFiles(original, await readAll(ctx.root));
});

test('4. restore (by id in the path, and by path in the body) moves it back byte-identical; a slug taken meanwhile is 409 SLUG_TAKEN', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  assert.equal((await post(ctx.port, u('events', EV.flood[0], 'archive'), {})).status, 200);
  const back = await post(ctx.port, u('events', EV.flood[0], 'restore'), {});
  assert.equal(back.status, 200, back.text);
  sameFiles(original, await readAll(ctx.root));

  assert.equal((await post(ctx.port, u('events', EV.flood[0], 'archive'), {})).status, 200);
  const byPath = await post(ctx.port, u('events', 'restore'), { path: `archive/${file('flood')}` });
  assert.equal(byPath.status, 200, byPath.text);
  sameFiles(original, await readAll(ctx.root));

  assert.equal((await post(ctx.port, u('events', EV.flood[0], 'archive'), {})).status, 200);
  assert.equal((await post(ctx.port, u('events'), { title: 'A new flood', slug: 'the-flood' })).status, 201);
  const mid = await readAll(ctx.root);
  const clash = await post(ctx.port, u('events', EV.flood[0], 'restore'), {});
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.code, 'SLUG_TAKEN');
  sameFiles(mid, await readAll(ctx.root));
});

test('4. restoring a live event, or archiving an archived one, is refused and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  assert.ok((await post(ctx.port, u('events', EV.flood[0], 'restore'), {})).status >= 400);
  sameFiles(before, await readAll(ctx.root));
  await post(ctx.port, u('events', EV.flood[0], 'archive'), {});
  const mid = await readAll(ctx.root);
  assert.ok((await post(ctx.port, u('events', EV.flood[0], 'archive'), {})).status >= 400);
  sameFiles(mid, await readAll(ctx.root));
});

test('4. event text: PUT body saves new text, front matter bytes identical; stale base is 409; missing base is refused', async () => {
  const ctx = await freshBook();
  const raw = await fs.readFile(path.join(ctx.root, file('flood')));
  const r = await send(ctx.port, 'PUT', u('events', EV.flood[0], 'body'), { body: { body: 'Rewritten.\n', base_sha256: sha(raw) } });
  assert.equal(r.status, 200, r.text);
  const now = await text(ctx.root, file('flood'));
  const head = (t) => t.slice(0, t.indexOf('\n---', 4) + 5);
  assert.equal(head(now), head(raw.toString('utf8')));
  assert.ok(now.endsWith('Rewritten.\n'));
  const before = await readAll(ctx.root);
  const stale = await send(ctx.port, 'PUT', u('events', EV.flood[0], 'body'), { body: { body: 'Again.\n', base_sha256: sha(raw) } });
  assert.equal(stale.status, 409, stale.text);
  sameFiles(before, await readAll(ctx.root));
  const missing = await send(ctx.port, 'PUT', u('events', EV.flood[0], 'body'), { body: { body: 'Again.\n' } });
  assert.ok(missing.status >= 400 && missing.status < 500);
  sameFiles(before, await readAll(ctx.root));
});

test('4. Undo of fields (with a two-sided scene edit) and of archive is byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  for (const act of [
    () => fields(ctx.port, 'flood', { add: { scenes: [FERRY] }, two_sided: true, title: 'Changed' }),
    () => post(ctx.port, u('events', EV.wall[0], 'archive'), {}),
  ]) {
    const r = await act();
    assert.ok(r.status === 200 || r.status === 201, r.text);
    const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
    assert.equal(un.status, 200, un.text);
    sameFiles(original, await readAll(ctx.root));
  }
});

// ---------------------------------------------------------------- dry runs, guards, refusals

test('4. dry runs write nothing and report the would-be changes', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const [url, body] of [
    [u('events'), { title: 'Dry', slug: 'dry', dryRun: true }],
    [u('events', EV.flood[0], 'fields'), { title: 'Dry', order: 5, add: { scenes: [FERRY] }, two_sided: true, dryRun: true }],
    [u('events', EV.flood[0], 'archive'), { dryRun: true }],
  ]) {
    const r = await post(ctx.port, url, body);
    assert.equal(r.status, 200, `${url}: ${r.text}`);
    assert.ok(Array.isArray(r.json.changes) && r.json.changes.length >= 1, `${url}: ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
  // restore dry run needs an archived event
  await post(ctx.port, u('events', EV.flood[0], 'archive'), {});
  const mid = await readAll(ctx.root);
  const r = await post(ctx.port, u('events', EV.flood[0], 'restore'), { dryRun: true });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.changes.length >= 1);
  sameFiles(mid, await readAll(ctx.root));
});

test('4. a dry run of fields says exactly which files would change (two-sided: two)', async () => {
  const ctx = await freshBook();
  const r = await post(ctx.port, u('events', EV.flood[0], 'fields'), { add: { scenes: [FERRY] }, two_sided: true, dryRun: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.changes.length, 2);
  const files = r.json.changes.map((c) => c.to ?? c.path ?? c.file).sort();
  assert.ok(files.some((f) => f === file('flood')), JSON.stringify(r.json.changes));
  assert.ok(files.some((f) => /0010-ferry\.md$/.test(f)), JSON.stringify(r.json.changes));
});

test('4. every event write route is 403 without the write guard (header / content type) and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const sha0 = sha(before.get(file('flood')));
  const calls = [
    ['POST', u('events'), { title: 'Nope' }],
    ['POST', u('events', EV.flood[0], 'fields'), { title: 'Nope' }],
    ['POST', u('events', EV.flood[0], 'archive'), {}],
    ['POST', u('events', EV.flood[0], 'restore'), {}],
    ['POST', u('events', 'restore'), { path: 'archive/planning/timeline/x.md' }],
    ['PUT', u('events', EV.flood[0], 'body'), { body: 'x\n', base_sha256: sha0 }],
  ];
  for (const [m, p, body] of calls) {
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'application/json' }, body })).status, 403, `${m} ${p} without x-storyforge`);
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body })).status, 403, `${m} ${p} wrong content type`);
    assert.equal((await send(ctx.port, m, p, { body, host: 'evil.example.com' })).status, 403, `${m} ${p} foreign host`);
  }
  sameFiles(before, await readAll(ctx.root));
});

test('4. refusals write nothing: bad / missing fields, unknown event, scene, entry; wrong types', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const cases = [
    [u('events', EV.flood[0], 'fields'), {}],
    [u('events', EV.flood[0], 'fields'), { title: '' }],
    [u('events', EV.flood[0], 'fields'), { title: 'two\nlines' }],
    [u('events', EV.flood[0], 'fields'), { when: 'two\nlines' }],
    [u('events', EV.flood[0], 'fields'), { when: 'sep here' }],
    [u('events', EV.flood[0], 'fields'), { when: 'para here' }],
    [u('events', EV.flood[0], 'fields'), { when: 'tab\there' }],
    [u('events', EV.flood[0], 'fields'), { order: 'soon' }],
    [u('events', EV.flood[0], 'fields'), { order: null }],
    [u('events', EV.flood[0], 'fields'), { order: 1e21 }],
    [u('events', EV.flood[0], 'fields'), { date: 'spring' }],
    [u('events', EV.flood[0], 'fields'), { date: '2024-13' }],
    [u('events', EV.flood[0], 'fields'), { date: '2024-02-30' }],
    [u('events', EV.flood[0], 'fields'), { date: 2024 }],
    [u('events', EV.flood[0], 'fields'), { scenes: ['not-an-id'] }],
    [u('events', EV.flood[0], 'fields'), { scenes: 'scene' }],
    [u('events', EV.flood[0], 'fields'), { scenes: ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] }],
    [u('events', EV.flood[0], 'fields'), { scenes: [ARCHIVED_SCENE] }],
    [u('events', EV.flood[0], 'fields'), { add: { scenes: ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] } }],
    [u('events', EV.flood[0], 'fields'), { add: { characters: ['pell'] } }],
    [u('events', EV.flood[0], 'fields'), { characters: ['nobody-here'] }],
    [u('events', EV.flood[0], 'fields'), { locations: 'salt-orchard' }],
    [u('events', EV.flood[0], 'fields'), { two_sided: 'yes', add: { scenes: [FERRY] } }],
    [u('events', 'event_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'fields'), { title: 'x' }],
    [u('events', 'no-such-event', 'archive'), {}],
    [u('events'), {}],
    [u('events'), { title: '' }],
    [u('events'), { title: 'Fine', slug: 'Not A Slug' }],
    [u('events'), { title: 'Fine', order: 'x' }],
    [u('events'), { title: 'Fine', date: '24' }],
    [u('events'), { title: 'Fine', scenes: ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] }],
    [u('events'), { title: 'Fine', characters: ['nobody-here'] }],
    [u('events'), { title: '!!!' }],
  ];
  for (const [url, body] of cases) {
    const r = await post(ctx.port, url, body);
    assert.ok(r.status >= 400 && r.status < 500, `${url} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
  assert.equal((await post(ctx.port, '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/events', { title: 'x' })).status, 404);
});

test('4. a stale base_sha256 on an event edit is 409 and the external edit stays; the right one succeeds', async () => {
  const ctx = await freshBook();
  const base = sha(await fs.readFile(path.join(ctx.root, file('flood'))));
  await fs.appendFile(path.join(ctx.root, file('flood')), '\nAn edit made elsewhere.\n');
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, 'flood', { title: 'Nope', base_sha256: base });
  assert.equal(r.status, 409, r.text);
  sameFiles(before, await readAll(ctx.root));
  const ok = await fields(ctx.port, 'flood', { title: 'Yes', base_sha256: sha(before.get(file('flood'))) });
  assert.equal(ok.status, 200, ok.text);
  assert.match(await text(ctx.root, file('flood')), /An edit made elsewhere\./);
});

test('4. an unsimple list (comment inside the block) is refused and nothing is written, scene files included', async () => {
  const ctx = await freshBook('valid/salt-orchard', async (root) => {
    const f = path.join(root, ...file('flood').split('/'));
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/^scenes: .*$/m, `scenes:\n  # kept by hand\n  - ${PROLOGUE}`));
  });
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, 'flood', { add: { scenes: [FERRY] }, two_sided: true });
  assert.ok(r.status >= 400 && r.status < 500, r.text);
  sameFiles(before, await readAll(ctx.root));
});
