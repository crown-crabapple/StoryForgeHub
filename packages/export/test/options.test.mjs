// M05-J03 acceptance 4 (exclusions and sceneTitles) and the negative side of verifyExport (contract 1.3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assembleManuscript, exportBook, verifyExport } from '../src/index.mjs';
import { FORMATS, ORDER, SCENES, cleanup, copyBook, orderProblems, phrasesFor, readZip, textOf, writeZip } from './helpers.mjs';

after(cleanup);

const idsOf = (m) => m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
const withStatus = (...statuses) => ORDER.filter((id) => statuses.includes(SCENES[id].status));
const without = (...statuses) => ORDER.filter((id) => !statuses.includes(SCENES[id].status));

test('the oracle statuses match the fixture (revised x1, outline x1, drafting x5)', () => {
  assert.deepEqual([withStatus('revised').length, withStatus('outline').length, withStatus('drafting').length], [1, 1, 5]);
});

for (const statuses of [['revised'], ['outline'], ['drafting'], ['revised', 'outline']]) {
  test(`assembleManuscript: excludeStatuses ${JSON.stringify(statuses)} removes exactly the scenes with those statuses`, async () => {
    const m = await assembleManuscript(copyBook(), { excludeStatuses: statuses });
    assert.deepEqual(idsOf(m), without(...statuses));
    const reasons = new Map(m.excluded.map((e) => [e.id, e.reason]));
    for (const id of withStatus(...statuses)) assert.ok(reasons.has(id) && reasons.get(id), `${id} listed as excluded with a reason`);
    // the variant and archived scene stay excluded
    assert.equal(m.excluded.length, 2 + withStatus(...statuses).length);
  });
}

test('assembleManuscript: a status nobody has ("idea") and the default [] exclude nothing extra and give the same manuscript', async () => {
  const root = copyBook();
  const base = await assembleManuscript(root, {});
  const idea = await assembleManuscript(root, { excludeStatuses: ['idea'] });
  const empty = await assembleManuscript(root, { excludeStatuses: [] });
  assert.deepEqual(idsOf(idea), ORDER);
  assert.deepEqual(idsOf(empty), ORDER);
  const sameModel = (m) => ({ ...m, options: undefined });
  assert.deepEqual(sameModel(idea), sameModel(base));
  assert.deepEqual(sameModel(empty), sameModel(base));
});

test('assembleManuscript: excluding every status leaves a manuscript with no scenes and no crash', async () => {
  const m = await assembleManuscript(copyBook(), { excludeStatuses: ['revised', 'drafting', 'outline'] });
  assert.deepEqual(idsOf(m), []);
});

for (const format of FORMATS) {
  test(`${format}: excludeStatuses removes those scenes' text, keeps the order of the rest, and still verifies`, async () => {
    const root = copyBook();
    const opts = { excludeStatuses: ['revised', 'outline'] };
    const out = await exportBook(root, format, opts);
    const text = textOf(format, out.bytes);
    const kept = without('revised', 'outline');
    assert.deepEqual(orderProblems(text, phrasesFor(kept)), []);
    for (const id of withStatus('revised', 'outline')) assert.ok(!text.includes(SCENES[id].phrase), `${id} is gone`);
    const v = await verifyExport(out.bytes, format, await assembleManuscript(root, opts));
    assert.deepEqual(v.problems, []);
    assert.ok(v.ok);
  });
}

test('markdown: sceneTitles adds a heading for every scene; the default has none', async () => {
  const root = copyBook();
  const plain = (await exportBook(root, 'markdown', {})).bytes.toString('utf8');
  const titled = (await exportBook(root, 'markdown', { sceneTitles: true })).bytes.toString('utf8');
  for (const t of ['Arrival', 'The Key', 'Ferry', 'Low Tide', 'The Wall']) {
    assert.doesNotMatch(plain, new RegExp(`^#+\\s+${t}\\s*$`, 'm'), `default: no heading for ${t}`);
    assert.match(titled, new RegExp(`^#+\\s+${t}\\s*$`, 'm'), `sceneTitles: heading for ${t}`);
  }
  assert.ok(titled.length > plain.length);
  assert.deepEqual(orderProblems(titled, phrasesFor(ORDER)), []);
});

for (const format of ['docx', 'epub', 'pdf']) {
  test(`${format}: sceneTitles puts each scene title before its text, in order`, async () => {
    const root = copyBook();
    const plain = textOf(format, (await exportBook(root, format, {})).bytes);
    const titled = textOf(format, (await exportBook(root, format, { sceneTitles: true })).bytes);
    // "Arrival" and "Low Tide" occur nowhere in the prose, so their presence is the scene title
    for (const t of ['Arrival', 'Low Tide']) {
      assert.ok(!plain.includes(t), `default has no "${t}"`);
      assert.ok(titled.includes(t), `sceneTitles has "${t}"`);
    }
    assert.deepEqual(orderProblems(titled, ['Arrival', SCENES[ORDER[1]].phrase, 'Low Tide', SCENES[ORDER[5]].phrase]), []);
  });
}

test('includeActs: act labels from act.md appear by default (two acts) and not when includeActs is false', async () => {
  const root = copyBook();
  const on = (await exportBook(root, 'markdown', {})).bytes.toString('utf8');
  const off = (await exportBook(root, 'markdown', { includeActs: false })).bytes.toString('utf8');
  assert.match(on, /Low Water/);
  assert.match(on, /High Water/);
  assert.doesNotMatch(off, /Low Water|High Water/);
  assert.deepEqual(orderProblems(off, phrasesFor(ORDER)), []);
});

test('titlePage: false drops the title page data, the default keeps it', async () => {
  const root = copyBook();
  const off = (await exportBook(root, 'markdown', { titlePage: false })).bytes.toString('utf8');
  assert.ok(!off.includes('The Salt Orchard\n') || !off.startsWith('# The Salt Orchard'), 'no "# The Salt Orchard" title heading');
  assert.doesNotMatch(off, /^# The Salt Orchard$/m);
});

// ---------------------------------------------------------------- verifyExport must be able to fail

for (const format of FORMATS) {
  test(`${format}: verifyExport reports a problem when the bytes lack a scene the manuscript has`, async () => {
    const root = copyBook();
    const full = await assembleManuscript(root, {});
    const short = await exportBook(root, format, { excludeStatuses: ['drafting'] });
    const v = await verifyExport(short.bytes, format, full);
    assert.equal(v.ok, false);
    assert.ok(v.problems.length > 0 && v.problems.every((p) => typeof p === 'string' && p.length > 0));
  });

  test(`${format}: verifyExport reports a problem when the scenes are out of order`, async () => {
    const root = copyBook();
    const m = await assembleManuscript(root, {});
    const bytes = (await exportBook(root, format, {})).bytes;
    const swapped = structuredClone(m);
    const chapter = swapped.parts[0].chapters[1];
    chapter.scenes.reverse();
    const v = await verifyExport(bytes, format, swapped);
    assert.equal(v.ok, false, 'reversed scene order in the manuscript no longer matches the bytes');
    assert.ok(v.problems.length > 0);
  });
}

test('docx: verifyExport notices a document.xml whose paragraphs were reordered', async () => {
  const root = copyBook();
  const m = await assembleManuscript(root, {});
  const good = (await exportBook(root, 'docx', {})).bytes;
  const z = readZip(good);
  const entries = z.entries.map((e) => {
    if (e.name !== 'word/document.xml') return { name: e.name, data: e.data };
    const xml = e.data.toString('utf8');
    const paras = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
    const rev = [...paras].reverse();
    let i = 0;
    const reversed = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, () => rev[i++]);
    return { name: e.name, data: Buffer.from(reversed, 'utf8') };
  });
  const v = await verifyExport(writeZip(entries), 'docx', m);
  assert.equal(v.ok, false);
});
