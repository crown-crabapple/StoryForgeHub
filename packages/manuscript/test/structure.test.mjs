// M03-J01 acceptance 2, 3, 4, 6, 7 (library level) and 8: structure commands in @storyforge/manuscript.
//   2 no scene body is ever lost by any command      3 split round trip + BAD_SPLIT_POINT
//   4 merge                                          6 chapters (gap, NO_CHAPTER_GAP, renumber)
//   7 dry runs write nothing                         8 undo via restoreOp
// Archive / restore of a single scene belongs to core and is tested in packages/core/test/tree.test.mjs.
//
// Arguments follow the contract's signatures; options such as dryRun go in the last argument object, like
// insertScene / moveScene already do. A missing export fails with "implementation missing: ...".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import YAML from 'yaml';
import * as M from '../src/index.mjs';
import {
  ARRIVAL, CH1, CH2, CH3, FERRY, GRAFTING, KEY, LOWTIDE, P, PROLOGUE, SALT, WALL,
  allBodyHashes, bodies, bodyOf, cleanup, copyFixture, diagnosticsOf, diffSnap, edit, errorsOf, exists, orderIds, orderRows,
  read, rename, sha256, snapshot, trashFiles, write,
} from './helpers.mjs';

after(cleanup);

const fn = (name) => {
  assert.equal(typeof M[name], 'function', `implementation missing: @storyforge/manuscript does not export ${name}`);
  return M[name];
};
const call = (name, ...args) => fn(name)(...args);

const NOTHING = { added: [], removed: [], changed: [] };
const ULID_SCENE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;

function parseFm(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  return YAML.parse(lines.slice(1, end).join('\n'));
}
const fmText = (buf) => {
  const s = buf.toString('latin1');
  return s.slice(0, s.length - bodyOf(buf).length);
};

/** Nothing written at all, not even trash or temp files. */
function assertUntouched(dir, before) {
  assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING, 'nothing was written');
}

/** Every body that existed before still exists byte-for-byte in the book, archive/ or trash. */
function assertNoBodyLost(dir, hashesBefore, what) {
  const now = allBodyHashes(dir);
  for (const h of hashesBefore) assert.ok(now.has(h), `${what}: a scene body (sha ${h.slice(0, 12)}) was lost`);
}

/** Shift a chapter number in a copy: every md under its folder gets `chapter: to`, and the folder is renamed. */
function shiftChapter(dir, folder, from, to) {
  const pad = (n) => String(n).padStart(3, '0');
  const slug = folder.split('/').pop().replace(/^ch-\d+/, '');
  const parent = folder.split('/').slice(0, -1).join('/');
  const target = `${parent}/ch-${pad(to)}${slug}`;
  for (const f of fs.readdirSync(path.join(dir, ...folder.split('/')))) {
    edit(dir, `${folder}/${f}`, (t) => t.replace(new RegExp(`^chapter: ${from}(\\r?)$`, 'm'), `chapter: ${to}$1`));
  }
  const base = path.join(dir, ...parent.split('/'));
  fs.renameSync(path.join(base, `ch-${pad(from)}${slug}`), path.join(base, `ch-${pad(to)}${slug}`));
  return target;
}

/** salt-orchard with chapters 0, 1, 4, 5 (gaps at 2-3 and, at the end, free numbers above 5). */
function gapCopy() {
  const dir = copyFixture(SALT);
  shiftChapter(dir, CH3, 3, 5);
  shiftChapter(dir, CH2, 2, 4);
  return dir;
}

/** Write a scene with every common field, in the middle of chapter 3 (between sequence 10 and 20). */
const MID = 'scene_01S50000000000000000000011';
const MID_PATH = `${CH3}/0012-split-me.md`;
function putMid(dir, body, eol = '\n') {
  const fm = [
    '---',
    'schema: storyforge.scene/v1',
    `id: ${MID}`,
    'title: Split Me',
    'act: 2',
    'chapter: 3',
    'sequence: 12',
    'status: revised',
    'pov: maren-hollis',
    'characters: [maren-hollis, pell]',
    'locations: [salt-orchard]',
    'x-mood: cold',
    '---',
    '',
  ].join(eol);
  write(dir, MID_PATH, fm + body);
  return fm;
}

// ================================================================ acceptance 3: split

const LINES = ['First line.', 'Second line with café 🌊.', '', 'Fourth 日本語 line.', 'Fifth has a   inside.', 'Last line.'];
/** Body text with the given eol; final newline optional. Returns { body, parts } where parts[i] is line i+1 with its terminator. */
function bodyWith(eol, trailing = true) {
  const parts = LINES.map((l, i) => l + (i < LINES.length - 1 || trailing ? eol : ''));
  return { body: parts.join(''), parts };
}

async function splitAndCheck({ eol, trailing, atLine }) {
  const dir = copyFixture(SALT);
  const { body, parts } = bodyWith(eol, trailing);
  const fm = putMid(dir, body, eol);
  assert.deepEqual(await errorsOf(dir), [], 'prepared book is valid');
  const idsBefore = await orderIds(dir);
  const hashes = allBodyHashes(dir);
  const before = snapshot(dir);
  const original = Buffer.from(fm + body);

  const r = await call('splitScene', dir, MID, { atLine });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');

  // the original file: front matter byte-identical, body = the lines before atLine
  const file = Buffer.from(read(dir, MID_PATH));
  assert.equal(fmText(file), fmText(original), 'front matter of the original is untouched');
  const body1 = bodyOf(file).toString('utf8');
  assert.equal(body1, parts.slice(0, atLine - 1).join(''), 'lines before atLine stay in the original');

  // exactly one new file, a scene right after the original
  const d = diffSnap(before, snapshot(dir));
  assert.equal(d.added.length, 1, JSON.stringify(d));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, [MID_PATH]);
  const newPath = d.added[0];
  const newFile = Buffer.from(read(dir, newPath));
  const body2 = bodyOf(newFile).toString('utf8');
  assert.equal(body2, parts.slice(atLine - 1).join(''), 'lines from atLine go to the new scene');
  assert.equal(body1 + body2, body, 'body1 + body2 === original body, byte for byte');
  if (eol === '\r\n') {
    assert.ok(body1.endsWith('\r\n'), 'CR stays with its LF: the cut is not between \\r and \\n');
    assert.ok(!body2.startsWith('\n'));
  }

  const nfm = parseFm(newFile.toString('utf8'));
  const ofm = parseFm(original.toString('utf8'));
  assert.match(nfm.id, ULID_SCENE);
  assert.notEqual(nfm.id, MID);
  assert.equal(nfm.title, 'Split Me (part 2)');
  for (const k of ['act', 'chapter', 'status', 'pov', 'characters', 'locations']) assert.deepEqual(nfm[k], ofm[k], `${k} copied`);
  assert.equal(nfm.sequence, Math.floor((12 + 20) / 2), 'sequence is the midpoint between the original and the next scene');

  const ids = await orderIds(dir);
  assert.deepEqual(ids, [...idsBefore.slice(0, idsBefore.indexOf(MID) + 1), nfm.id, ...idsBefore.slice(idsBefore.indexOf(MID) + 1)], 'new scene sits right after the original');
  assert.deepEqual(await errorsOf(dir), []);
  assert.deepEqual(await diagnosticsOf(dir), [], 'no warnings: new file path and prefix are canonical');
  assertNoBodyLost(dir, hashes, 'split');
  assert.ok(allBodyHashes(dir).has(sha256(Buffer.from(body))), 'the original body is still intact in the trash');
  return { dir, nfm };
}

describe('splitScene round trip (acceptance 3)', () => {
  for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    for (const trailing of [true, false]) {
      for (const atLine of [2, 3, 4, 5, 6]) {
        const label = ['first possible', 'before a blank line', 'after a blank line', 'around the U+2028 line', 'last line'][atLine - 2];
        it(`${name}${trailing ? '' : ', no final newline'}: split at line ${atLine} (${label})`, async () => {
          await splitAndCheck({ eol, trailing, atLine });
        });
      }
    }
  }

  it('splitting the new second half again also round-trips (3 parts concatenate to the original)', async () => {
    const { dir, nfm } = await splitAndCheck({ eol: '\n', trailing: true, atLine: 3 });
    const second = bodyOf(Buffer.from(read(dir, (await orderRows(dir)).find((x) => x.id === nfm.id).path))).toString('utf8');
    const r = await call('splitScene', dir, nfm.id, { atLine: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await errorsOf(dir), []);
    const rows = await orderRows(dir);
    const at = rows.findIndex((x) => x.id === nfm.id);
    const b2 = bodyOf(Buffer.from(read(dir, rows[at].path))).toString('utf8');
    const b3 = bodyOf(Buffer.from(read(dir, rows[at + 1].path))).toString('utf8');
    assert.equal(b2 + b3, second);
  });

  it('a real fixture scene (salt-orchard Arrival) splits and recombines to its original body', async () => {
    const dir = copyFixture(SALT);
    const orig = bodyOf(Buffer.from(read(dir, P.ARRIVAL))).toString('utf8');
    const r = await call('splitScene', dir, ARRIVAL, { atLine: 3 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = await orderRows(dir);
    const at = rows.findIndex((x) => x.id === ARRIVAL);
    const b1 = bodyOf(Buffer.from(read(dir, rows[at].path))).toString('utf8');
    const b2 = bodyOf(Buffer.from(read(dir, rows[at + 1].path))).toString('utf8');
    assert.equal(b1 + b2, orig);
    assert.equal(rows[at + 1].title, 'Arrival (part 2)');
    assert.equal(rows[at + 1].sequence, 15, 'midpoint of 10 and 20');
  });

  it('out-of-range or non-integer atLine is refused and nothing is written', async () => {
    const dir = copyFixture(SALT);
    const lineCount = bodyOf(Buffer.from(read(dir, P.ARRIVAL))).toString('utf8').split('\n').length - 1;
    for (const atLine of [0, -1, 1.5, '3', null, undefined, NaN, lineCount + 1, 9999]) {
      const before = snapshot(dir);
      const r = await call('splitScene', dir, ARRIVAL, { atLine });
      assert.equal(r.ok, false, `atLine ${String(atLine)}: ${JSON.stringify(r)}`);
      assert.match(r.code, /^REFUSED_|^BAD_/);
      assertUntouched(dir, before);
    }
  });

  it('an unknown scene is REFUSED_UNKNOWN_SCENE', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('splitScene', dir, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', { atLine: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNKNOWN_SCENE');
    assertUntouched(dir, before);
  });
});

describe('splitScene refuses points inside code or comments (acceptance 3)', () => {
  const BODY = [
    'Before.', //            1
    '```js', //              2
    'const a = 1;', //       3
    '', //                   4
    '```', //                5
    'Between.', //           6
    '<!--', //               7
    'hidden note', //        8
    'still hidden', //       9
    '-->', //               10
    'After.', //            11
    '~~~', //               12
    'tilde fenced', //      13
    '~~~', //               14
    'End.', //              15
  ].join('\n') + '\n';

  for (const [atLine, what] of [[3, 'inside a backtick fence'], [4, 'a blank line inside a fence'], [8, 'inside an HTML comment'], [9, 'inside an HTML comment (second line)'], [13, 'inside a tilde fence']]) {
    it(`line ${atLine} (${what}) -> BAD_SPLIT_POINT and nothing is written`, async () => {
      const dir = copyFixture(SALT);
      putMid(dir, BODY);
      const before = snapshot(dir);
      const r = await call('splitScene', dir, MID, { atLine });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, 'BAD_SPLIT_POINT');
      assertUntouched(dir, before);
    });
  }

  for (const atLine of [6, 11, 15]) {
    it(`line ${atLine}, just after a closed fence/comment or outside any, is allowed and round-trips`, async () => {
      const dir = copyFixture(SALT);
      putMid(dir, BODY);
      const r = await call('splitScene', dir, MID, { atLine });
      assert.equal(r.ok, true, JSON.stringify(r));
      const rows = await orderRows(dir);
      const at = rows.findIndex((x) => x.id === MID);
      const b1 = bodyOf(Buffer.from(read(dir, rows[at].path))).toString('utf8');
      const b2 = bodyOf(Buffer.from(read(dir, rows[at + 1].path))).toString('utf8');
      assert.equal(b1 + b2, BODY);
      assert.deepEqual(await errorsOf(dir), []);
    });
  }

  it('a single-line comment does not make the next line unsplittable', async () => {
    const dir = copyFixture(SALT);
    putMid(dir, 'One <!-- c --> two.\nThree.\nFour.\n');
    const r = await call('splitScene', dir, MID, { atLine: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('the salt-orchard scene that holds a comment (The Key) can be split on either side of it', async () => {
    const dir = copyFixture(SALT);
    const text = bodyOf(Buffer.from(read(dir, P.KEY))).toString('utf8').split('\n');
    const commentLine = text.findIndex((l) => l.startsWith('<!--')) + 1;
    const r = await call('splitScene', dir, KEY, { atLine: commentLine + 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

// ================================================================ acceptance 4: merge

describe('mergeScenes (acceptance 4)', () => {
  const MERGED_COMMENT = (id) => new RegExp(`<!-- merged into ${id} on \\d{4}-\\d{2}-\\d{2} -->\\s*$`);

  it('adjacent scenes in a chapter: first body = first + separator + second; second archived with the comment; nothing deleted', async () => {
    const dir = copyFixture(SALT);
    const firstBody = bodyOf(Buffer.from(read(dir, P.ARRIVAL))).toString('utf8');
    const secondFile = Buffer.from(read(dir, P.KEY));
    const secondBody = bodyOf(secondFile).toString('utf8');
    const firstFm = fmText(Buffer.from(read(dir, P.ARRIVAL)));
    const hashes = allBodyHashes(dir);
    const before = snapshot(dir);

    const r = await call('mergeScenes', dir, ARRIVAL, KEY);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');

    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [`archive/${P.KEY}`], removed: [P.KEY], changed: [P.ARRIVAL] });

    const merged = Buffer.from(read(dir, P.ARRIVAL));
    assert.equal(fmText(merged), firstFm, 'front matter of the first is kept');
    const mergedBody = bodyOf(merged).toString('utf8');
    assert.ok(mergedBody.startsWith(firstBody), 'first body is a prefix: no character removed');
    assert.ok(mergedBody.endsWith(secondBody), 'second body is the suffix: no character removed');
    const sep = mergedBody.slice(firstBody.length, mergedBody.length - secondBody.length);
    const want = firstBody.endsWith('\n\n') ? '' : firstBody.endsWith('\n') ? '\n' : '\n\n';
    assert.equal(sep, want, 'separator is exactly the blank line that was missing');
    assert.match(firstBody + sep, /\n\n$/);

    const archived = Buffer.from(read(dir, `archive/${P.KEY}`));
    assert.equal(fmText(archived), fmText(secondFile), 'archived front matter unchanged, id kept');
    const archivedBody = bodyOf(archived).toString('utf8');
    assert.ok(archivedBody.startsWith(secondBody), 'archived body keeps the original text');
    assert.match(archivedBody, MERGED_COMMENT(ARRIVAL));
    assert.equal((archivedBody.match(/<!-- merged into /g) ?? []).length, 1);

    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL]);
    assert.deepEqual(await errorsOf(dir), []);
    assertNoBodyLost(dir, hashes, 'merge');
    assert.ok(allBodyHashes(dir).has(sha256(Buffer.from(secondBody))), 'the second body is whole somewhere (trash)');
    assert.ok(trashFiles(dir).some((f) => f.endsWith('0020-the-key.md')), 'the original second file is in the trash');
  });

  it('the second scene’s characters / locations / plot_threads are listed in the result but not merged into the first', async () => {
    const dir = copyFixture(SALT);
    const planned = await call('mergeScenes', dir, ARRIVAL, KEY, { dryRun: true });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const dump = JSON.stringify(planned);
    assert.ok(dump.includes('pell'), 'character of the second is listed');
    assert.ok(dump.includes('brass-key'), 'plot thread of the second is listed');
    await call('mergeScenes', dir, ARRIVAL, KEY);
    const fm = parseFm(read(dir, P.ARRIVAL));
    assert.deepEqual(fm.characters, ['maren-hollis', 'tobin-reyes']);
    assert.equal(fm.plot_threads, undefined);
  });

  it('CRLF first body without a final newline gets exactly one blank line and loses nothing', async () => {
    const dir = copyFixture(SALT);
    putMid(dir, 'Alpha line\r\nBeta line', '\r\n');
    const secondBody = bodyOf(Buffer.from(read(dir, P.WALL))).toString('utf8');
    const r = await call('mergeScenes', dir, MID, WALL);
    assert.equal(r.ok, true, JSON.stringify(r));
    const body = bodyOf(Buffer.from(read(dir, MID_PATH))).toString('utf8');
    assert.ok(body.startsWith('Alpha line\r\nBeta line'));
    assert.ok(body.endsWith(secondBody));
    const sep = body.slice('Alpha line\r\nBeta line'.length, body.length - secondBody.length);
    assert.match(sep, /^(\r?\n){2}$/, `exactly one blank line, got ${JSON.stringify(sep)}`);
  });

  it('a first body that already ends with a blank line gets no extra separator', async () => {
    const dir = copyFixture(SALT);
    putMid(dir, 'Alpha.\n\n');
    const secondBody = bodyOf(Buffer.from(read(dir, P.WALL))).toString('utf8');
    const r = await call('mergeScenes', dir, MID, WALL);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(bodyOf(Buffer.from(read(dir, MID_PATH))).toString('utf8'), `Alpha.\n\n${secondBody}`);
  });

  const REFUSALS = [
    ['across chapters (end of one, start of the next)', KEY, FERRY],
    ['across acts', GRAFTING, LOWTIDE],
    ['the prologue and chapter 1', PROLOGUE, ARRIVAL],
    ['a scene with itself', KEY, KEY],
    ['an unknown first scene', 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', KEY],
    ['an unknown second scene', ARRIVAL, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'],
  ];
  for (const [name, a, b] of REFUSALS) {
    it(`refused: ${name}; nothing is written`, async () => {
      const dir = copyFixture(SALT);
      const before = snapshot(dir);
      const r = await call('mergeScenes', dir, a, b);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.code, /^REFUSED_/);
      assertUntouched(dir, before);
    });
  }

  it('refused: same chapter but not adjacent (a scene sits between)', async () => {
    const dir = copyFixture(SALT);
    write(
      dir,
      `${CH1}/0030-third.md`,
      '---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000012\ntitle: Third\nact: 1\nchapter: 1\nsequence: 30\nstatus: drafting\n---\nThird body.\n',
    );
    const before = snapshot(dir);
    const r = await call('mergeScenes', dir, ARRIVAL, 'scene_01S50000000000000000000012');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.code, /^REFUSED_/);
    assertUntouched(dir, before);
    // and the adjacent pair next to it still merges
    const ok = await call('mergeScenes', dir, KEY, 'scene_01S50000000000000000000012');
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });
});

// ================================================================ acceptance 6: chapters

describe('createChapter / renumberChapters (acceptance 6)', () => {
  it('at the end of the book: next number, new folder with chapter.md and one empty scene', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const hashes = allBodyHashes(dir);
    const r = await call('createChapter', dir, { act: 2, after: 3, title: 'Aftermath' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = diffSnap(before, snapshot(dir));
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.changed, []);
    assert.equal(d.added.length, 2, JSON.stringify(d));
    const folder = 'manuscript/act-02-high-water/ch-004-aftermath';
    assert.deepEqual(d.added.filter((f) => f.startsWith(`${folder}/`)).length, 2, `both files are in ${folder}: ${d.added}`);
    assert.ok(d.added.includes(`${folder}/chapter.md`));
    const scenePath = d.added.find((f) => f !== `${folder}/chapter.md`);
    const ch = parseFm(read(dir, `${folder}/chapter.md`));
    assert.equal(ch.schema, 'storyforge.chapter/v1');
    assert.equal(ch.chapter, 4);
    assert.equal(ch.title, 'Aftermath');
    const scene = read(dir, scenePath);
    const sfm = parseFm(scene);
    assert.equal(sfm.chapter, 4);
    assert.equal(sfm.act, 2);
    assert.equal(bodyOf(Buffer.from(scene)).toString('utf8').trim(), '', 'the scene is empty');
    const ids = await orderIds(dir);
    assert.equal(ids.length, 8);
    assert.equal(ids[7], sfm.id, 'new scene is last in the book');
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await diagnosticsOf(dir), []);
    assertNoBodyLost(dir, hashes, 'createChapter');
  });

  it('between two chapters with room for a number: takes a free number in between and sits in order', async () => {
    const dir = gapCopy(); // chapters 0, 1, 4, 5
    const r = await call('createChapter', dir, { act: 1, after: 1, title: 'Interlude' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = await orderRows(dir);
    const fresh = rows.find((x) => ![PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL].includes(x.id));
    assert.ok(fresh, 'a new scene exists');
    assert.ok(fresh.chapter > 1 && fresh.chapter < 4, `new chapter number ${fresh.chapter} is between 1 and 4`);
    assert.equal(rows.map((x) => x.id).indexOf(fresh.id), 3, 'right after the last scene of chapter 1');
    assert.match(fresh.path, new RegExp(`/ch-00${fresh.chapter}-interlude/`));
    assert.deepEqual(await errorsOf(dir), []);
    // later chapters were not renumbered
    assert.ok(exists(dir, `${CH2.replace('ch-002', 'ch-004')}/0010-ferry.md`));
  });

  it('no free number between chapters 1 and 2 -> NO_CHAPTER_GAP, nothing written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('createChapter', dir, { act: 1, after: 1, title: 'Interlude' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'NO_CHAPTER_GAP');
    assertUntouched(dir, before);
  });

  it('inserting before the first chapter (after: null) in a book that starts at chapter 0 -> NO_CHAPTER_GAP', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('createChapter', dir, { act: 1, after: null, title: 'Cold Open' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'NO_CHAPTER_GAP');
    assertUntouched(dir, before);
  });

  it('an unknown "after" chapter is refused and nothing is written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('createChapter', dir, { act: 1, after: 77, title: 'Nowhere' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.code, /^REFUSED_/);
    assertUntouched(dir, before);
  });

  for (const [name, title] of [['empty title', ''], ['newline in title', 'a\nb'], ['non-string title', 5]]) {
    it(`createChapter with ${name} is refused and nothing is written`, async () => {
      const dir = copyFixture(SALT);
      const before = snapshot(dir);
      const r = await call('createChapter', dir, { act: 2, after: 3, title });
      assert.equal(r.ok, false, JSON.stringify(r));
      assertUntouched(dir, before);
    });
  }

  it('renumberChapters({ step: 1 }): contiguous numbers, folders match, bodies identical, validate clean, order unchanged', async () => {
    const dir = gapCopy(); // 0, 1, 4, 5
    assert.deepEqual((await orderRows(dir)).map((x) => x.chapter), [0, 1, 1, 4, 4, 5, 5]);
    const idsBefore = await orderIds(dir);
    const bodiesBefore = bodies(dir);
    const hashes = allBodyHashes(dir);
    const r = await call('renumberChapters', dir, { step: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = await orderRows(dir);
    assert.deepEqual(rows.map((x) => x.chapter), [0, 1, 1, 2, 2, 3, 3], 'chapters run 0..N with no gaps');
    assert.deepEqual(rows.map((x) => x.id), idsBefore, 'order unchanged');
    assert.deepEqual(bodies(dir), bodiesBefore, 'bodies identical');
    for (const row of rows) {
      const folder = row.path.split('/').slice(-2)[0];
      assert.match(folder, new RegExp(`^ch-${String(row.chapter).padStart(3, '0')}(-|$)`), `folder ${folder} matches chapter ${row.chapter}`);
    }
    // chapter.md carries the same number as its scenes
    for (const [folderGlob, n] of [['ch-002-the-grafting', 2], ['ch-003-the-wall', 3]]) {
      const dirOf = rows.find((x) => x.path.includes(folderGlob)).path.split('/').slice(0, -1).join('/');
      if (exists(dir, `${dirOf}/chapter.md`)) assert.equal(parseFm(read(dir, `${dirOf}/chapter.md`)).chapter, n);
    }
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await diagnosticsOf(dir), []);
    assertNoBodyLost(dir, hashes, 'renumberChapters');
  });

  it('a second renumberChapters run is a no-op (empty changes, nothing written)', async () => {
    const dir = gapCopy();
    await call('renumberChapters', dir, { step: 1 });
    const before = snapshot(dir);
    const again = await call('renumberChapters', dir, { step: 1 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.changes, [], 'nothing to do');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING);
  });

  it('a book already contiguous is a no-op (salt-orchard)', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('renumberChapters', dir, { step: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.changes, []);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING);
  });

  it('after renumbering with step 1 there is no gap inside the sequence, so NO_CHAPTER_GAP still applies', async () => {
    const dir = gapCopy();
    await call('renumberChapters', dir, { step: 1 });
    const r = await call('createChapter', dir, { act: 1, after: 1, title: 'Still Tight' });
    assert.equal(r.ok, false, 'renumber 1 makes chapters contiguous, so there is still no gap after 1');
    assert.equal(r.code, 'NO_CHAPTER_GAP');
  });
});

// ================================================================ chapter / act metadata

describe('chapter and act metadata commands', () => {
  const lineDiff = (a, b) => {
    const x = a.split('\n');
    const y = b.split('\n');
    return x.length === y.length ? x.map((l, i) => [l, y[i]]).filter(([p, q]) => p !== q) : null;
  };

  it('setChapterFields edits only the title line of an existing chapter.md', async () => {
    const dir = copyFixture(SALT);
    const cm = `${CH1}/chapter.md`;
    const textBefore = read(dir, cm);
    const before = snapshot(dir);
    const r = await call('setChapterFields', dir, 1, { title: 'The Flooded Rows' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [cm] });
    const diff = lineDiff(textBefore, read(dir, cm));
    assert.deepEqual(diff.map(([a]) => a), ['title: The Drowned Rows']);
    assert.equal(parseFm(read(dir, cm)).title, 'The Flooded Rows');
    assert.ok(read(dir, cm).endsWith('Notes: keep the arrival slow.\n'), 'chapter notes body untouched');
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('setChapterFields label edits only the label line, and the tree label follows', async () => {
    const dir = copyFixture(SALT);
    const cm = `${CH1}/chapter.md`;
    const textBefore = read(dir, cm);
    const r = await call('setChapterFields', dir, 1, { label: 'Part One' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(lineDiff(textBefore, read(dir, cm)).map(([a]) => a), ['label: Chapter One']);
    assert.equal((await orderRows(dir)).find((x) => x.id === ARRIVAL).chapter_label, 'Part One');
  });

  it('setChapterFields on a chapter with no chapter.md creates one (a `create`, nothing else changes)', async () => {
    const dir = copyFixture(SALT);
    assert.equal(exists(dir, `${CH3}/chapter.md`), false);
    const before = snapshot(dir);
    const r = await call('setChapterFields', dir, 3, { title: 'The Wall' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [`${CH3}/chapter.md`], removed: [], changed: [] });
    const fm = parseFm(read(dir, `${CH3}/chapter.md`));
    assert.equal(fm.schema, 'storyforge.chapter/v1');
    assert.equal(fm.chapter, 3);
    assert.equal(fm.title, 'The Wall');
    assert.match(fm.id, /^chap_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('setChapterFields on an unknown chapter is refused; nothing is written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('setChapterFields', dir, 42, { title: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.code, /^REFUSED_/);
    assertUntouched(dir, before);
  });

  it('setChapterFields refuses a chapter.md whose title line is not simple, and writes nothing', async () => {
    const dir = copyFixture(SALT);
    edit(dir, `${CH1}/chapter.md`, (t) => t.replace(/^title: .*$/m, 'title: >\n  folded title'));
    const before = snapshot(dir);
    const r = await call('setChapterFields', dir, 1, { title: 'New' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
    assertUntouched(dir, before);
  });

  it('createAct adds act.md with the next act number (3) and nothing else changes', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('createAct', dir, { title: 'Ebb Tide' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = diffSnap(before, snapshot(dir));
    assert.deepEqual([d.removed, d.changed], [[], []]);
    assert.equal(d.added.length, 1, JSON.stringify(d));
    assert.match(d.added[0], /^manuscript\/act-03(-ebb-tide)?\/act\.md$/);
    const fm = parseFm(read(dir, d.added[0]));
    assert.equal(fm.schema, 'storyforge.act/v1');
    assert.equal(fm.act, 3);
    assert.equal(fm.title, 'Ebb Tide');
    assert.match(fm.id, /^act_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('createAct twice gives acts 3 then 4', async () => {
    const dir = copyFixture(SALT);
    await call('createAct', dir, { title: 'Ebb Tide' });
    const r = await call('createAct', dir, { title: 'Slack Water' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const acts = r.changes.map((c) => parseFm(read(dir, c.to)).act);
    assert.deepEqual(acts, [4]);
  });

  it('setActFields edits only the title line of act.md', async () => {
    const dir = copyFixture(SALT);
    const am = 'manuscript/act-01-low-water/act.md';
    const textBefore = read(dir, am);
    const before = snapshot(dir);
    const r = await call('setActFields', dir, 1, { title: 'Lower Water' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [am] });
    assert.deepEqual(lineDiff(textBefore, read(dir, am)).map(([a]) => a), ['title: Low Water']);
    assert.equal(parseFm(read(dir, am)).title, 'Lower Water');
  });

  it('createAct / setActFields with a bad title or unknown act are refused with nothing written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    assert.equal((await call('createAct', dir, { title: 'a\nb' })).ok, false);
    assert.equal((await call('createAct', dir, {})).ok, false);
    assert.equal((await call('setActFields', dir, 9, { title: 'x' })).ok, false);
    assert.equal((await call('setActFields', dir, 1, { title: 'a\nb' })).ok, false);
    assertUntouched(dir, before);
  });

  it('archiveChapter moves every scene and chapter.md into archive/ in one operation; bodies survive; book stays valid', async () => {
    const dir = copyFixture(SALT);
    const hashes = allBodyHashes(dir);
    const before = snapshot(dir);
    const r = await call('archiveChapter', dir, 2);
    assert.equal(r.ok, true, JSON.stringify(r));
    const expectMoved = [`${CH2}/0010-ferry.md`, `${CH2}/0020-the-grafting.md`, `${CH2}/chapter.md`];
    const d = diffSnap(before, snapshot(dir));
    assert.deepEqual(d.removed, expectMoved.sort());
    assert.deepEqual(d.added, expectMoved.map((f) => `archive/${f}`).sort());
    assert.deepEqual(d.changed, []);
    for (const f of expectMoved) assert.equal(sha256(Buffer.from(read(dir, `archive/${f}`))), before.get(f), 'moved bytes unchanged');
    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, KEY, LOWTIDE, WALL]);
    assert.deepEqual(await errorsOf(dir), []);
    assertNoBodyLost(dir, hashes, 'archiveChapter');
    const ops = trashFiles(dir).filter((f) => f.endsWith('/op.json') && !f.includes('old-scene'));
    assert.equal(ops.length, 1, 'a single op.json for the whole chapter');
  });

  it('archiveChapter on an unknown chapter is refused; nothing is written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await call('archiveChapter', dir, 42);
    assert.equal(r.ok, false);
    assert.match(r.code, /^REFUSED_/);
    assertUntouched(dir, before);
  });
});

// ================================================================ acceptance 2: no body is ever lost

describe('no scene body is ever lost (acceptance 2)', () => {
  const RENAME_FILE_ARGS = { title: 'Renamed Scene', renameFile: true };
  const COMMANDS = [
    ['insertScene', () => copyFixture(SALT), (d) => call('insertScene', d, { chapter: 1, after: ARRIVAL, title: 'New', slug: 'new', body: 'New body.\n' })],
    ['setSceneFields (title)', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { title: 'Changed' })],
    ['setSceneFields (status + pov)', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { status: 'final', pov: 'pell' })],
    ['setSceneFields (title + rename the file)', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, RENAME_FILE_ARGS)],
    ['createChapter', () => copyFixture(SALT), (d) => call('createChapter', d, { act: 2, after: 3, title: 'Aftermath' })],
    ['setChapterFields (existing chapter.md)', () => copyFixture(SALT), (d) => call('setChapterFields', d, 1, { title: 'Other' })],
    ['setChapterFields (creating chapter.md)', () => copyFixture(SALT), (d) => call('setChapterFields', d, 3, { title: 'The Wall' })],
    ['createAct', () => copyFixture(SALT), (d) => call('createAct', d, { title: 'Ebb Tide' })],
    ['setActFields', () => copyFixture(SALT), (d) => call('setActFields', d, 2, { title: 'Higher Water' })],
    ['archiveChapter', () => copyFixture(SALT), (d) => call('archiveChapter', d, 1)],
    ['renumberChapters', () => gapCopy(), (d) => call('renumberChapters', d, { step: 1 })],
    ['splitScene', () => copyFixture(SALT), (d) => call('splitScene', d, ARRIVAL, { atLine: 3 })],
    ['mergeScenes', () => copyFixture(SALT), (d) => call('mergeScenes', d, ARRIVAL, KEY)],
  ];
  for (const [name, prep, run] of COMMANDS) {
    it(name, async () => {
      const dir = prep();
      const hashes = allBodyHashes(dir);
      const r = await run(dir);
      assert.equal(r.ok, true, JSON.stringify(r));
      assertNoBodyLost(dir, hashes, name);
      assert.deepEqual(await errorsOf(dir), []);
      assert.ok(r.opId, 'every write has an op in the trash');
    });
  }

  it('a rename that also renames the file moves the scene to NNNN-<new-slug>.md and keeps the body', async () => {
    const dir = copyFixture(SALT);
    const orig = bodyOf(Buffer.from(read(dir, P.KEY)));
    const r = await call('setSceneFields', dir, KEY, RENAME_FILE_ARGS);
    assert.equal(r.ok, true, JSON.stringify(r));
    const row = (await orderRows(dir)).find((x) => x.id === KEY);
    assert.equal(row.path, `${CH1}/0020-renamed-scene.md`);
    assert.equal(row.title, 'Renamed Scene');
    assert.equal(exists(dir, P.KEY), false);
    assert.ok(bodyOf(Buffer.from(read(dir, row.path))).equals(orig));
    assert.deepEqual(await diagnosticsOf(dir), []);
  });

  it('every command refuses on a book with manuscript errors (E204) and writes nothing', async () => {
    const A = 'scene_01CS0000000000000000000002';
    const B = 'scene_01CS0000000000000000000003';
    const dir = copyFixture('invalid/E204-duplicate-sequence');
    const calls = [
      ['setSceneFields', () => call('setSceneFields', dir, A, { title: 'x' })],
      ['createChapter', () => call('createChapter', dir, { act: 1, after: 1, title: 'x' })],
      ['setChapterFields', () => call('setChapterFields', dir, 1, { title: 'x' })],
      ['renumberChapters', () => call('renumberChapters', dir, { step: 1 })],
      ['createAct', () => call('createAct', dir, { title: 'x' })],
      ['setActFields', () => call('setActFields', dir, 1, { title: 'x' })],
      ['archiveChapter', () => call('archiveChapter', dir, 1)],
      ['splitScene', () => call('splitScene', dir, A, { atLine: 1 })],
      ['mergeScenes', () => call('mergeScenes', dir, A, B)],
    ];
    for (const [name, run] of calls) {
      const before = snapshot(dir);
      const r = await run();
      assert.equal(r.ok, false, name);
      assert.equal(r.code, 'REFUSED_INVALID_BOOK', `${name}: ${JSON.stringify(r)}`);
      assertUntouched(dir, before);
    }
  });

  it('a failed post-write validation rolls back byte-for-byte (rule 6) for a structure command', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    M.__testHooks.afterWrite = (book) => {
      // inject a duplicate id after the command wrote
      write(book, `${CH1}/0099-dup.md`, read(book, P.KEY).replace(/^sequence: 20$/m, 'sequence: 99'));
    };
    try {
      const r = await call('setSceneFields', dir, ARRIVAL, { title: 'Rolled Back' });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, 'ROLLED_BACK');
    } finally {
      M.__testHooks.afterWrite = undefined;
    }
    // the injected file is the test's own; remove it and the book must be byte-identical
    fs.rmSync(`${dir}/${CH1}/0099-dup.md`, { force: true });
    assert.deepEqual(diffSnap(before, snapshot(dir)), NOTHING);
  });
});

// ================================================================ acceptance 7: dry runs

describe('dry runs write nothing and return the planned changes (acceptance 7, library level)', () => {
  const DRY = [
    ['setSceneFields', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { title: 'Dry', dryRun: true })],
    ['setSceneFields with file rename', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { title: 'Dry', renameFile: true, dryRun: true })],
    ['createChapter', () => copyFixture(SALT), (d) => call('createChapter', d, { act: 2, after: 3, title: 'Dry', dryRun: true })],
    ['setChapterFields', () => copyFixture(SALT), (d) => call('setChapterFields', d, 1, { title: 'Dry', dryRun: true })],
    ['setChapterFields (create chapter.md)', () => copyFixture(SALT), (d) => call('setChapterFields', d, 3, { title: 'Dry', dryRun: true })],
    ['renumberChapters', () => gapCopy(), (d) => call('renumberChapters', d, { step: 1, dryRun: true })],
    ['createAct', () => copyFixture(SALT), (d) => call('createAct', d, { title: 'Dry', dryRun: true })],
    ['setActFields', () => copyFixture(SALT), (d) => call('setActFields', d, 1, { title: 'Dry', dryRun: true })],
    ['archiveChapter', () => copyFixture(SALT), (d) => call('archiveChapter', d, 2, { dryRun: true })],
    ['splitScene', () => copyFixture(SALT), (d) => call('splitScene', d, ARRIVAL, { atLine: 3, dryRun: true })],
    ['mergeScenes', () => copyFixture(SALT), (d) => call('mergeScenes', d, ARRIVAL, KEY, { dryRun: true })],
  ];
  for (const [name, prep, run] of DRY) {
    it(name, async () => {
      const dir = prep();
      const before = snapshot(dir);
      const r = await run(dir);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.code, 'OK');
      assert.ok(Array.isArray(r.changes) && r.changes.length > 0, 'planned changes are returned');
      for (const c of r.changes) assert.ok('to' in c && 'after_sha256' in c, JSON.stringify(c));
      assertUntouched(dir, before);
    });
  }

  it('a dry run predicts what the real run does (paths touched)', async () => {
    for (const [prep, run] of [
      [() => copyFixture(SALT), (d, o) => call('mergeScenes', d, ARRIVAL, KEY, o)],
      [() => copyFixture(SALT), (d, o) => call('splitScene', d, ARRIVAL, { atLine: 3, ...o })],
      [() => copyFixture(SALT), (d, o) => call('archiveChapter', d, 2, o)],
      [() => gapCopy(), (d, o) => call('renumberChapters', d, { step: 1, ...o })],
    ]) {
      const dir = prep();
      const planned = await run(dir, { dryRun: true });
      const before = snapshot(dir);
      const real = await run(dir, {});
      assert.equal(real.ok, true, JSON.stringify(real));
      const key = (c) => `${c.from}->${c.to}`;
      assert.deepEqual(planned.changes.map(key).sort().map((s) => s.replace(/scene_[0-9A-Z]+/g, 'ID')), real.changes.map(key).sort().map((s) => s.replace(/scene_[0-9A-Z]+/g, 'ID')));
      const d = diffSnap(before, snapshot(dir));
      const touched = new Set([...d.added, ...d.removed, ...d.changed]);
      for (const c of real.changes) assert.ok(touched.has(c.to) || touched.has(c.from), `${key(c)} is a real change`);
    }
  });

  it('a refused command still writes nothing when dryRun is set (E204)', async () => {
    const dir = copyFixture('invalid/E204-duplicate-sequence');
    const before = snapshot(dir);
    const r = await call('createAct', dir, { title: 'x', dryRun: true });
    assert.equal(r.ok, false);
    assertUntouched(dir, before);
  });
});

// ================================================================ acceptance 8: undo

describe('restoreOp (acceptance 8)', () => {
  const UNDOABLE = [
    ['rename a scene (title)', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { title: 'Undo Me' })],
    ['change status and pov', () => copyFixture(SALT), (d) => call('setSceneFields', d, ARRIVAL, { status: 'final', pov: 'pell' })],
    ['rename a scene and its file', () => copyFixture(SALT), (d) => call('setSceneFields', d, KEY, { title: 'Undo Me', renameFile: true })],
    ['rename a chapter', () => copyFixture(SALT), (d) => call('setChapterFields', d, 1, { title: 'Undo Chapter' })],
    ['rename an act', () => copyFixture(SALT), (d) => call('setActFields', d, 1, { title: 'Undo Act' })],
    ['renumber chapters', () => gapCopy(), (d) => call('renumberChapters', d, { step: 1 })],
    ['archive a chapter', () => copyFixture(SALT), (d) => call('archiveChapter', d, 2)],
  ];
  for (const [name, prep, run] of UNDOABLE) {
    it(`${name}, then restoreOp: files are back byte-for-byte`, async () => {
      const dir = prep();
      const before = snapshot(dir);
      const idsBefore = await orderIds(dir);
      const r = await run(dir);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.opId, 'result carries the op id');
      assert.notDeepEqual(diffSnap(before, snapshot(dir)), NOTHING, 'the command changed something');
      const u = await call('restoreOp', dir, r.opId);
      assert.equal(u.ok, true, JSON.stringify(u));
      assert.deepEqual(diffSnap(before, snapshot(dir)), NOTHING, 'every file is back, byte-for-byte');
      assert.deepEqual(await orderIds(dir), idsBefore);
      assert.deepEqual(await errorsOf(dir), []);
    });
  }

  it('after an external edit of an affected file, restoreOp refuses with a reason and leaves the edit alone', async () => {
    const dir = copyFixture(SALT);
    const r = await call('setSceneFields', dir, KEY, { title: 'Undo Me' });
    assert.equal(r.ok, true);
    edit(dir, P.KEY, (t) => `${t}\nAn external edit.\n`);
    const before = snapshot(dir);
    const u = await call('restoreOp', dir, r.opId);
    assert.equal(u.ok, false, JSON.stringify(u));
    assert.notEqual(u.code, 'OK');
    assert.equal(typeof u.message, 'string');
    assert.ok(u.message.length > 10, `a human-readable reason: ${u.message}`);
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), NOTHING, 'nothing written');
    assert.ok(read(dir, P.KEY).endsWith('An external edit.\n'));
  });

  it('after the file was moved away, restoreOp refuses', async () => {
    const dir = copyFixture(SALT);
    const r = await call('setSceneFields', dir, KEY, { title: 'Undo Me' });
    rename(dir, P.KEY, `${CH1}/0025-moved.md`);
    const before = snapshot(dir);
    const u = await call('restoreOp', dir, r.opId);
    assert.equal(u.ok, false, JSON.stringify(u));
    assertUntouched(dir, before);
  });

  it('undoing the same op twice: the second is refused (files no longer match the op)', async () => {
    const dir = copyFixture(SALT);
    const r = await call('setSceneFields', dir, KEY, { title: 'Undo Me' });
    assert.equal((await call('restoreOp', dir, r.opId)).ok, true);
    const before = snapshot(dir);
    const again = await call('restoreOp', dir, r.opId);
    assert.equal(again.ok, false, JSON.stringify(again));
    assertUntouched(dir, before);
  });

  it('an unknown op id or one that tries to leave the trash folder is refused and writes nothing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    for (const id of ['20990101T000000000Z-ZZZZZZ', '../../book.md', '..', '', 'x/../../y', undefined, 5]) {
      const u = await call('restoreOp', dir, id);
      assert.equal(u.ok, false, `${String(id)}: ${JSON.stringify(u)}`);
      assertUntouched(dir, before);
    }
  });

  it('undoing an op never loses a body (the undone state stays in the trash)', async () => {
    const dir = copyFixture(SALT);
    const r = await call('setSceneFields', dir, KEY, { title: 'Undo Me' });
    const hashes = allBodyHashes(dir);
    await call('restoreOp', dir, r.opId);
    assertNoBodyLost(dir, hashes, 'restoreOp');
    assert.deepEqual(bodies(dir), bodies(copyFixture(SALT)));
  });
});
