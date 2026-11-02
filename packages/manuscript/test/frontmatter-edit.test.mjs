// M03-J01 acceptance 5: editFrontMatterLine table tests (quote/escape rules, insert-after-anchor, CRLF,
// refusals) and setSceneFields changing only the lines it was asked to change.
//
// The contract fixes the name and arguments of editFrontMatterLine(bytes, key, value) but not the shape of
// its return value or how it refuses, so `edit()` accepts the plausible shapes: a Buffer/string, or
// { ok, buf | bytes | text | content }, and a refusal as a thrown error or { ok:false, code } / { error:{code} }.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import YAML from 'yaml';
import * as M from '../src/index.mjs';
import {
  ARRIVAL, KEY, P, SALT, bodies, cleanup, copyFixture, diffSnap, edit as editFile, errorsOf, orderRows, read, snapshot, trashFiles, write,
} from './helpers.mjs';

after(cleanup);

function need(name) {
  assert.equal(typeof M[name], 'function', `implementation missing: @storyforge/manuscript does not export ${name}`);
  return M[name];
}

/** Run editFrontMatterLine and normalise: { ok, text, code }. */
function edit(input, key, value) {
  const fn = need('editFrontMatterLine');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  let r;
  try {
    r = fn(bytes, key, value);
  } catch (e) {
    return { ok: false, code: e.code ?? e.message, text: null };
  }
  assert.ok(!(r instanceof Promise), 'editFrontMatterLine is synchronous (pure bytes in, bytes out)');
  if (Buffer.isBuffer(r)) return { ok: true, text: r.toString('utf8'), buf: r };
  if (typeof r === 'string') return { ok: true, text: r, buf: Buffer.from(r, 'utf8') };
  const out = r.buf ?? r.bytes ?? r.content ?? r.text ?? r.result;
  if (r.ok === false || r.error || out === undefined) return { ok: false, code: r.code ?? r.error?.code ?? r.error, text: null };
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out, 'utf8');
  return { ok: true, text: buf.toString('utf8'), buf };
}

const fmLines = (text) => text.split('\n');
const nl = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));

const SCENE = (extra = '') =>
  `---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\ntitle: Arrival\nact: 1\nchapter: 1\nsequence: 10\nstatus: drafting\npov: maren-hollis\ncharacters: [maren-hollis, tobin-reyes]\nsummary: Maren steps off the ferry.\n${extra}---\nBody line one.\ntitle: this is prose, not front matter\n\nUnicode: caf\u00e9 \u2014 \ud83c\udf0a\n`;

/** Parse the front matter of `text` with YAML (independent of the code under test). */
function parseFm(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  return YAML.parse(lines.slice(1, end).join('\n'));
}

/** Everything but one line is byte-identical: returns the [before, after] lines that differ. */
function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      out.push([a[i] ?? null, b[j] ?? null]);
      i++;
      j++;
    }
  }
  return out;
}

for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  describe(`editFrontMatterLine, replacing an existing line (${eolName})`, () => {
    const src = nl(SCENE(), eol);

    it('a plain word is written and nothing else changes', () => {
      const r = edit(src, 'pov', 'ilse-hollis');
      assert.equal(r.ok, true, JSON.stringify(r));
      const expected = src.replace(/^pov: maren-hollis(\r?)$/m, (_, cr) => `pov: ilse-hollis${cr}`);
      // a plain word may be written bare or quoted, but the value must be right and only that line may differ
      assert.equal(parseFm(r.text).pov, 'ilse-hollis');
      const diff = changedLines(src, r.text);
      assert.equal(diff.length, 1, JSON.stringify(diff));
      assert.match(diff[0][1], /^pov: /);
      if (eol === '\r\n') assert.ok(diff[0][1].endsWith('\r'), 'the changed line keeps its CRLF');
    });

    it('the body (including a prose line that looks like `title:`) is byte-identical', () => {
      const r = edit(src, 'title', 'The Arrival');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.text.endsWith(src.slice(src.indexOf('Body line one.'))), 'body bytes unchanged');
      assert.ok(r.text.includes(`title: this is prose, not front matter`), 'the prose line was not touched');
      assert.equal(parseFm(r.text).title, 'The Arrival');
    });

    it('every line ending in the file is preserved', () => {
      const r = edit(src, 'title', 'New');
      assert.equal(r.ok, true);
      const count = (t, re) => (t.match(re) ?? []).length;
      assert.equal(count(r.text, /\r\n/g), count(src, /\r\n/g));
      assert.equal(count(r.text, /(?<!\r)\n/g), count(src, /(?<!\r)\n/g));
    });

    it('other keys, comments and flow lists are untouched', () => {
      const r = edit(src, 'summary', 'A new one-liner.');
      assert.equal(r.ok, true, JSON.stringify(r));
      const fm = parseFm(r.text);
      assert.deepEqual(fm.characters, ['maren-hollis', 'tobin-reyes']);
      assert.equal(fm.sequence, 10);
      assert.equal(changedLines(src, r.text).length, 1);
    });
  });
}

describe('editFrontMatterLine, value quoting and escaping', () => {
  // value -> must round-trip through a YAML parser unchanged, and only one line may differ
  const VALUES = [
    ['plain words with spaces', 'The Drowned Rows'],
    ['colon and space', 'Part 1: The Arrival'],
    ['hash comment lookalike', 'Chapter #1 # not a comment'],
    ['double quote', 'She said "hello"'],
    ['backslash', 'C:\\tides\\low'],
    ['quote and backslash together', 'a\\"b\\\\"c"'],
    ['single quote', "Maren's key"],
    ['leading dash', '- not a list'],
    ['leading and trailing spaces', '  padded  '],
    ['yaml boolean word', 'yes'],
    ['yaml null word', 'null'],
    ['number-looking', '0123'],
    ['float-looking', '1e3'],
    ['flow-looking', '[a, b]'],
    ['brace-looking', '{a: b}'],
    ['ampersand', '&anchor text'],
    ['asterisk', '*alias'],
    ['bang', '!tag'],
    ['percent', '%directive'],
    ['at sign', '@handle'],
    ['backtick', '`code`'],
    ['pipe', '| literal'],
    ['gt', '> folded'],
    ['unicode and emoji', 'caf\u00e9 \u2014 \ud83c\udf0a \u65e5\u672c\u8a9e'],
    ['empty string', ''],
    ['document marker', '---'],
  ];
  for (const eol of ['\n', '\r\n']) {
    for (const [name, value] of VALUES) {
      it(`${name} (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
        const src = nl(SCENE(), eol);
        const r = edit(src, 'title', value);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.strictEqual(parseFm(r.text).title, value, 'value round-trips through YAML exactly');
        const diff = changedLines(src, r.text);
        assert.equal(diff.length, 1, `exactly one line changed: ${JSON.stringify(diff)}`);
        assert.ok(diff[0][1].startsWith('title: '));
        assert.ok(r.text.endsWith(src.slice(src.indexOf('Body line one.'))), 'body unchanged');
        assert.equal(parseFm(r.text).sequence, 10, 'other fields still parse');
      });
    }
  }

  it('a value that needs quoting is written as a double-quoted string with `\\` and `"` escaped', () => {
    const r = edit(SCENE(), 'title', 'say "hi" \\ bye');
    assert.equal(r.ok, true);
    assert.match(r.text, /^title: "say \\"hi\\" \\\\ bye"$/m);
  });
});

describe('editFrontMatterLine, rejected values', () => {
  const BAD = [
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['CRLF', 'a\r\nb'],
    ['NUL', 'a\u0000b'],
    ['bell', 'a\u0007b'],
    ['escape', 'a\u001bb'],
    ['unit separator', 'a\u001fb'],
    ['DEL', 'a\u007fb'],
  ];
  for (const [name, value] of BAD) {
    it(`${name} in the value is refused and the input is not changed`, () => {
      const src = SCENE();
      const buf = Buffer.from(src);
      const r = edit(buf, 'title', value);
      assert.equal(r.ok, false, 'refused');
      assert.ok(buf.equals(Buffer.from(src)), 'input buffer unchanged');
    });
  }

  it('a non-string value is refused', () => {
    assert.equal(edit(SCENE(), 'title', 42).ok, false);
    assert.equal(edit(SCENE(), 'title', null).ok, false);
    assert.equal(edit(SCENE(), 'title', undefined).ok, false);
  });
});

describe('editFrontMatterLine, inserting an absent key after its anchor', () => {
  const NO_TITLE = (eol) => nl('---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\nact: 1\nchapter: 1\nsequence: 10\nstatus: drafting\n---\nBody.\n', eol);
  const NO_STATUS = (eol) => nl('---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\ntitle: T\nact: 1\nchapter: 1\nsequence: 10\ncharacters: [a]\n---\nBody.\n', eol);
  const NO_POV = (eol) => nl('---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\ntitle: T\nact: 1\nchapter: 1\nsequence: 10\nstatus: drafting\ncharacters: [a]\n---\nBody.\n', eol);

  for (const eol of ['\n', '\r\n']) {
    const tag = eol === '\n' ? 'LF' : 'CRLF';

    it(`title goes right after id (${tag})`, () => {
      const src = NO_TITLE(eol);
      const r = edit(src, 'title', 'Fresh Title');
      assert.equal(r.ok, true, JSON.stringify(r));
      const lines = r.text.split(eol);
      assert.equal(lines[lines.indexOf('id: scene_01S50000000000000000000002') + 1].replace(/^title: .*/, 'title'), 'title');
      assert.equal(parseFm(r.text).title, 'Fresh Title');
      const diff = changedLines(src.split(eol).join('\n'), r.text.split(eol).join('\n'));
      assert.ok(diff.length >= 1);
      assert.equal(r.text.length - src.length, `title: "Fresh Title"${eol}`.length - 0 > 0 ? r.text.length - src.length : 0);
      assert.equal(r.text.replace(/^title: .*\r?\n/m, ''), src, 'removing the inserted line gives back the original exactly');
      assert.equal(r.text.split(eol).filter((l) => l.startsWith('title:')).length, 1);
    });

    it(`status goes right after sequence (${tag})`, () => {
      const src = NO_STATUS(eol);
      const r = edit(src, 'status', 'revised');
      assert.equal(r.ok, true, JSON.stringify(r));
      const lines = r.text.split(eol);
      assert.match(lines[lines.indexOf('sequence: 10') + 1], /^status: "?revised"?$/);
      assert.equal(r.text.replace(/^status: .*\r?\n/m, ''), src, 'only one inserted line, same line endings');
    });

    it(`pov goes right after status (${tag})`, () => {
      const src = NO_POV(eol);
      const r = edit(src, 'pov', 'maren-hollis');
      assert.equal(r.ok, true, JSON.stringify(r));
      const lines = r.text.split(eol);
      assert.match(lines[lines.indexOf('status: drafting') + 1], /^pov: "?maren-hollis"?$/);
      assert.equal(r.text.replace(/^pov: .*\r?\n/m, ''), src);
    });
  }

  it('an inserted line is written with the quoting rules too', () => {
    const r = edit(NO_TITLE('\n'), 'title', 'A "quoted": title');
    assert.equal(r.ok, true);
    assert.strictEqual(parseFm(r.text).title, 'A "quoted": title');
  });

  it('inserting into a file with no title and no id anchor is refused with REFUSED_UNSIMPLE_FIELD', () => {
    const src = '---\nschema: storyforge.scene/v1\nact: 1\nchapter: 1\nsequence: 10\n---\nBody.\n';
    const r = edit(src, 'title', 'X');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
  });

  it('status without a sequence line is refused (anchor missing)', () => {
    const src = '---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\ntitle: T\n---\nBody.\n';
    const r = edit(src, 'status', 'final');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
  });

  it('pov without a status line is refused (anchor missing)', () => {
    const src = '---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\nsequence: 10\n---\nBody.\n';
    const r = edit(src, 'pov', 'ilse');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
  });
});

describe('editFrontMatterLine, refusing anything that is not a single-line scalar', () => {
  const FILE = (line) => `---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\n${line}\nact: 1\nchapter: 1\nsequence: 10\nstatus: drafting\n---\nBody.\n`;
  const CASES = [
    ['folded block scalar', 'title: >\n  folded text\n  more'],
    ['literal block scalar', 'title: |\n  literal text'],
    ['multi-line plain scalar', 'title: first part\n  continued here'],
    ['multi-line double-quoted scalar', 'title: "first part\n  continued here"'],
    ['flow sequence', 'title: [a, b]'],
    ['flow mapping', 'title: {a: b}'],
    ['block sequence', 'title:\n  - a\n  - b'],
    ['block mapping', 'title:\n  a: b'],
    ['anchor', 'title: &x Anchored'],
    ['alias', 'title: *x'],
    ['tag', 'title: !!str Tagged'],
    ['trailing comment', 'title: Arrival # my note'],
    ['quoted with trailing comment', 'title: "Arrival" # my note'],
  ];
  for (const [name, line] of CASES) {
    it(`${name} -> REFUSED_UNSIMPLE_FIELD, input untouched`, () => {
      const src = FILE(line);
      const buf = Buffer.from(src);
      const r = edit(buf, 'title', 'New');
      assert.equal(r.ok, false, 'refused');
      assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
      assert.ok(buf.equals(Buffer.from(src)));
    });
  }

  it('a duplicated key is refused (cannot tell which line to edit)', () => {
    const r = edit(FILE('title: One\ntitle: Two'), 'title', 'New');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
  });

  it('an indented (nested) `title:` is not a top-level key and is never edited', () => {
    const src = '---\nschema: storyforge.scene/v1\nid: scene_01S50000000000000000000002\nmeta:\n  title: nested\nact: 1\nchapter: 1\nsequence: 10\n---\nBody.\n';
    const r = edit(src, 'title', 'Top');
    if (r.ok) {
      assert.ok(r.text.includes('  title: nested'), 'nested line untouched');
      assert.equal(parseFm(r.text).title, 'Top');
      assert.equal(parseFm(r.text).meta.title, 'nested');
    } else assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
  });

  it('a file with no closing front matter is refused', () => {
    const r = edit('---\nschema: storyforge.scene/v1\nid: x\ntitle: T\n', 'title', 'New');
    assert.equal(r.ok, false);
  });

  it('a file with no front matter at all is refused, never edited', () => {
    const r = edit('title: T\n\nJust prose.\n', 'title', 'New');
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------- setSceneFields

describe('setSceneFields changes only the requested lines', () => {
  /** Lines of a scene file that differ between before and after. */
  const lineDiff = (b, a) => changedLines(b, a).map(([x, y]) => ({ before: x, after: y }));

  it('title only: one line differs in one file; filename, other files and body are untouched', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const text = read(dir, P.KEY);
    const r = await need('setSceneFields')(dir, KEY, { title: 'The Brass Key' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');
    const d = diffSnap(before, snapshot(dir));
    assert.deepEqual(d, { added: [], removed: [], changed: [P.KEY] }, 'only the scene file changed; slug unchanged');
    const after = read(dir, P.KEY);
    const diff = lineDiff(text, after);
    assert.equal(diff.length, 1, JSON.stringify(diff));
    assert.equal(diff[0].before, 'title: The Key');
    assert.equal(parseFm(after).title, 'The Brass Key');
    assert.ok(after.endsWith(text.slice(text.indexOf('\n---\n', 4) + 5)), 'body bytes identical');
    assert.equal(parseFm(after)['x-mood'], 'cold', 'unknown x- fields survive');
    assert.deepEqual(await errorsOf(dir), []);
  });

  it('status and pov: exactly those two lines differ', async () => {
    const dir = copyFixture(SALT);
    const text = read(dir, P.ARRIVAL);
    const r = await need('setSceneFields')(dir, ARRIVAL, { status: 'revised', pov: 'tobin-reyes' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const diff = lineDiff(text, read(dir, P.ARRIVAL));
    assert.equal(diff.length, 2, JSON.stringify(diff));
    assert.deepEqual(diff.map((x) => x.before).sort(), ['pov: maren-hollis', 'status: drafting']);
    const fm = parseFm(read(dir, P.ARRIVAL));
    assert.equal(fm.status, 'revised');
    assert.equal(fm.pov, 'tobin-reyes');
    assert.deepEqual(fm.characters, ['maren-hollis', 'tobin-reyes']);
  });

  it('a title with quotes, a colon and a backslash round-trips through the parser', async () => {
    const dir = copyFixture(SALT);
    const title = 'She said "go": C:\\low';
    const r = await need('setSceneFields')(dir, KEY, { title });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.strictEqual(parseFm(read(dir, P.KEY)).title, title);
    assert.equal((await orderRows(dir)).find((x) => x.id === KEY).title, title);
  });

  it('works on a CRLF scene file and keeps every CRLF', async () => {
    const dir = copyFixture(SALT);
    const crlf = read(dir, P.KEY).replace(/\n/g, '\r\n');
    write(dir, P.KEY, crlf);
    const r = await need('setSceneFields')(dir, KEY, { title: 'Crlf Key' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = read(dir, P.KEY);
    assert.equal((after.match(/(?<!\r)\n/g) ?? []).length, 0, 'no bare LF introduced');
    assert.equal((after.match(/\r\n/g) ?? []).length, (crlf.match(/\r\n/g) ?? []).length);
    assert.equal(lineDiff(crlf, after).length, 1);
  });

  it('changing nothing the file does not already say still succeeds without altering other files', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await need('setSceneFields')(dir, KEY, { status: 'drafting' });
    assert.ok(r.ok === true || r.code === 'OK' || r.changes?.length === 0, JSON.stringify(r));
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [] });
  });

  it('bodies of every scene are unchanged', async () => {
    const dir = copyFixture(SALT);
    const b = bodies(dir);
    await need('setSceneFields')(dir, KEY, { title: 'Changed', status: 'final', pov: 'pell' });
    assert.deepEqual(bodies(dir), b);
  });

  it('an unknown scene is refused with REFUSED_UNKNOWN_SCENE and nothing is written', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const r = await need('setSceneFields')(dir, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', { title: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNKNOWN_SCENE');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  for (const [name, fields] of [
    ['a status outside outline/drafting/revised/final', { status: 'done' }],
    ['a title with a newline', { title: 'a\nb' }],
    ['a title that is not a string', { title: 7 }],
    ['an empty field set', {}],
  ]) {
    it(`${name} is refused and nothing is written`, async () => {
      const dir = copyFixture(SALT);
      const before = snapshot(dir);
      const r = await need('setSceneFields')(dir, KEY, fields);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.code, /^REFUSED_|^BAD_/);
      assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
    });
  }

  it('a scene whose title line is not simple is refused with REFUSED_UNSIMPLE_FIELD and nothing is written', async () => {
    const dir = copyFixture(SALT);
    editFile(dir, P.KEY, (t) => t.replace(/^title: The Key$/m, 'title: The Key # working title'));
    const before = snapshot(dir);
    const r = await need('setSceneFields')(dir, KEY, { title: 'New' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REFUSED_UNSIMPLE_FIELD');
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  it('records the old file in the trash (nothing is overwritten without a copy)', async () => {
    const dir = copyFixture(SALT);
    const original = read(dir, P.KEY);
    const r = await need('setSceneFields')(dir, KEY, { title: 'Trash Me' });
    assert.equal(r.ok, true);
    const t = trashFiles(dir).filter((f) => f.endsWith('0020-the-key.md'));
    assert.equal(t.length, 1);
    assert.equal(read(dir, t[0]), original);
    assert.equal(typeof r.opId, 'string');
  });
});
