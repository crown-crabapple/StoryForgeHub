// M05-J07 acceptance 5 (exports) and 7 (no key; full prompt only when ticked), over HTTP against a real server process.
//   GET /api/books/:b/export?format=markdown|docx|epub|pdf[&include=manuscript|summary|evidence][&scenes=id,id][&excludeStatuses=a,b]
//   GET /api/books/:b/backup?provenance=0|1
// Zip, PDF and EPUB readers come from the independent oracles in packages/export/test/helpers.mjs; the expected file lists are computed here from the receipts on disk.
// Contract: docs/contracts/M05-J07-receipts.md sections 1.1, 5, 7, 8.5, 8.7.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { readZip, textOf, normSpace } from '../../../packages/export/test/helpers.mjs';
import { ARRIVAL, MODEL, NOTE, PROMPT, PROVIDER, RCPT, SECRET, getBinary, listFiles, readReceipts, runScenario } from './receipts-helpers.mjs';
import { getScene, readConfigFiles, readEverything, stopAll, startMockProvider } from './ai-helpers.mjs';
import { readText } from './suggest-helpers.mjs';
import path from 'node:path';

const PROLOGUE = 'scene_01S50000000000000000000001';
const SECOND_PROMPT = 'SECONDPROMPT-5521 shorten it.';
const FORMATS = ['markdown', 'docx', 'epub', 'pdf'];
const PHRASE = 'the ferryman'; // text that must survive in every manuscript-only export

let mock;
let sc;
let kept; // a second book whose first rewrite ticked "keep the full prompt"
let receipts;
const exportUrl = (q) => RCPT.exportUrl(q);

before(async () => {
  mock = await startMockProvider({ reply: 'unused' });
  sc = await runScenario({ mock });
  await getScene(sc.app, PROLOGUE); // a second scene with receipts (baseline), "revised" status
  receipts = await readReceipts(sc.library);
  kept = await runScenario({ mock, keep: { [RCPT.keepPromptField]: true } });
});
after(async () => {
  await mock.close();
  await stopAll();
});

/** Every byte string worth searching in an export file: the file, and for zips every part inflated; for a PDF every inflated stream. */
function blobs(format, bytes) {
  const out = [bytes];
  if (format === 'docx' || format === 'epub') for (const e of readZip(bytes).entries) out.push(e.data);
  if (format === 'pdf') {
    const s = bytes.toString('latin1');
    for (const m of s.matchAll(/stream\r?\n/g)) {
      const end = s.indexOf('endstream', m.index);
      const raw = Buffer.from(s.slice(m.index + m[0].length, end), 'latin1');
      try {
        out.push(zlib.inflateSync(raw));
      } catch {
        /* not flate */
      }
    }
  }
  return out;
}

/** Strings that must not be in a manuscript-only export, taken from the receipts of the book. */
function forbiddenTerms(all) {
  const terms = new Set([PROVIDER, MODEL, 'ZORBLAXPROMPT', 'rcpt_', 'storyforge.receipt', 'provenance/']);
  for (const r of all) {
    terms.add(r.fm.id);
    terms.add(r.sha);
    for (const k of ['before_sha256', 'after_sha256']) if (r.fm[k]) terms.add(r.fm[k]);
    for (const k of ['settings_sha256', 'prompt_sha256', 'context_sha256']) if (r.fm.ai?.[k]) terms.add(r.fm.ai[k]);
    for (const p of r.fm.parents ?? []) terms.add(p.sha256);
  }
  return [...terms];
}

describe('8.5 exports', () => {
  test('precondition (8.5): the books really hold receipts and objects, so the scans below are not scanning nothing', async () => {
    for (const lib of [sc.library, kept.library]) {
      const all = await readReceipts(lib);
      assert.ok(all.length >= 6, `receipts under provenance/: ${all.length}`);
      assert.ok(all.some((r) => r.fm?.operation === 'ai.proposal'));
      assert.ok((await listFiles(path.join(lib, 'provenance', 'objects'))).length >= 4, 'content objects');
    }
  });

  for (const format of FORMATS) {
    test(`manuscript only (${format}) carries no provider, model, prompt, receipt id or hash anywhere in its bytes`, async () => {
      for (const q of [`format=${format}`, `format=${format}&include=manuscript`]) {
        const r = await getBinary(sc.app.port, exportUrl(q));
        assert.equal(r.status, 200, r.body.toString('utf8').slice(0, 300));
        assert.ok(textOf(format, r.body).includes(PHRASE), 'the manuscript itself is there');
        const hay = blobs(format, r.body).map((b) => b.toString('latin1'));
        for (const term of forbiddenTerms(receipts)) for (const h of hay) assert.ok(!h.includes(term), `${q}: found ${term.slice(0, 40)}`);
        for (const h of hay) assert.doesNotMatch(h, /\b[0-9a-f]{64}\b/, `${q}: a sha256-looking string`);
      }
    });
  }

  test('manuscript only (markdown) is byte-identical with and without `include=manuscript`, and the receipts did not change it', async () => {
    const a = await getBinary(sc.app.port, exportUrl('format=markdown'));
    const b = await getBinary(sc.app.port, exportUrl('format=markdown&include=manuscript'));
    assert.ok(a.body.equals(b.body));
    assert.doesNotMatch(a.body.toString('utf8'), /Provenance summary/i);
  });

  test('an unknown include value is a 400, not a silent fallback', async () => {
    const r = await getBinary(sc.app.port, exportUrl('format=markdown&include=everything'));
    assert.equal(r.status, 400);
  });

  for (const format of ['markdown', 'docx']) {
    test(`manuscript + provenance summary (${format}): lineage in words per scene, counts, the not-legal-advice note; no prompt, no hashes`, async () => {
      const r = await getBinary(sc.app.port, exportUrl(`format=${format}&include=summary`));
      assert.equal(r.status, 200, r.body.toString('utf8').slice(0, 300));
      const text = normSpace(textOf(format, r.body));
      assert.ok(text.includes(PHRASE), 'still the manuscript');
      assert.match(text, /Provenance summary/i);
      assert.ok(text.includes(normSpace(NOTE)), 'the note');
      for (const step of ['Author wrote (baseline)', 'Author edited', 'AI suggested 3 changes', 'Author accepted lines 15', 'Author declined 1 change']) assert.ok(text.includes(step), `lineage step "${step}"`);
      assert.match(text, /Arrival/);
      assert.ok(!text.includes('ZORBLAXPROMPT'), 'no prompt');
      assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, 'no content or settings hashes');
      for (const k of ['settings_sha256', 'prompt_sha256', 'context_sha256']) for (const rc of receipts) if (rc.fm.ai?.[k]) assert.ok(!text.includes(rc.fm.ai[k]));
    });
  }

  describe('evidence package', () => {
    const expectedProvenance = async (sceneIds) => {
      const mine = receipts.filter((r) => sceneIds.includes(r.fm.target?.id));
      const objs = new Set(mine.flatMap((r) => [r.fm.before_sha256, r.fm.after_sha256]).filter(Boolean));
      return [...mine.map((r) => r.rel), ...[...objs].map((h) => `provenance/objects/${h.slice(0, 2)}/${h}`)].sort();
    };
    const open = async (q) => {
      const r = await getBinary(sc.app.port, exportUrl(q));
      assert.equal(r.status, 200, r.body.toString('utf8').slice(0, 300));
      assert.match(r.headers['content-type'], /application\/zip/);
      assert.match(r.headers['content-disposition'], /\.zip"/);
      const zip = readZip(r.body);
      const names = zip.entries.map((e) => e.name);
      return { zip, names, byName: new Map(zip.entries.map((e) => [e.name, e.data])) };
    };

    test('scenes=<Arrival>: exactly the manuscript, Arrival\'s receipts, the objects they name, verify.json and README.txt', async () => {
      const { names, byName } = await open(`format=markdown&include=evidence&scenes=${ARRIVAL}`);
      const prov = names.filter((n) => n.startsWith('provenance/')).sort();
      assert.deepEqual(prov, await expectedProvenance([ARRIVAL]));
      const rest = names.filter((n) => !n.startsWith('provenance/')).sort();
      const manuscript = rest.filter((n) => n !== 'verify.json' && n !== 'README.txt');
      assert.equal(manuscript.length, 1, `exactly one manuscript file, saw ${rest}`);
      assert.deepEqual(rest.filter((n) => n === 'verify.json' || n === 'README.txt'), ['README.txt', 'verify.json']);
      assert.equal(names.length, new Set(names).size, 'no duplicate entries');
      assert.ok(!names.some((n) => n.startsWith('.storyforge') || n.startsWith('suggestions/')), 'nothing else from the book folder');
      // each stored file is byte-identical with the book's file
      for (const n of prov) assert.ok(byName.get(n).equals(await fs.readFile(path.join(sc.library, ...n.split('/')))), n);
      // the manuscript is the manuscript-only export
      const plain = await getBinary(sc.app.port, exportUrl('format=markdown'));
      assert.ok(byName.get(manuscript[0]).equals(plain.body), 'the manuscript inside is the plain export');
      assert.ok(byName.get(manuscript[0]).toString('utf8').includes(PHRASE));
    });

    test('verify.json is the integrity result of the moment, and README.txt says what it is, that it is private, and carries the note', async () => {
      const { byName } = await open(`format=markdown&include=evidence&scenes=${ARRIVAL}`);
      const verify = JSON.parse(byName.get('verify.json').toString('utf8'));
      const live = (await sc.app.get(RCPT.verify())).json;
      assert.equal(verify.ok, true);
      assert.deepEqual(verify.problems, []);
      assert.equal(verify.receipts, live.receipts);
      const readme = byName.get('README.txt').toString('utf8');
      assert.match(readme, /private/i);
      assert.ok(normSpace(readme).includes(normSpace(NOTE)));
      assert.match(readme, /evidence|record/i);
    });

    test('default selection = the exported scenes; excludeStatuses=revised drops the Prologue\'s receipts and objects', async () => {
      const all = await open('format=markdown&include=evidence');
      assert.deepEqual(all.names.filter((n) => n.startsWith('provenance/')).sort(), await expectedProvenance([ARRIVAL, PROLOGUE]));
      const noPrologue = await open('format=markdown&include=evidence&excludeStatuses=revised');
      assert.deepEqual(noPrologue.names.filter((n) => n.startsWith('provenance/')).sort(), await expectedProvenance([ARRIVAL]));
    });

    test('an evidence package for another format holds that format\'s manuscript', async () => {
      const { names, byName } = await open(`format=docx&include=evidence&scenes=${ARRIVAL}`);
      const file = names.find((n) => /\.docx$/.test(n));
      assert.ok(file, `a .docx inside: ${names.filter((n) => !n.startsWith('provenance/'))}`);
      assert.ok(textOf('docx', byName.get(file)).includes(PHRASE));
    });

    test('the export never writes into the book', async () => {
      const before = await listFiles(sc.library);
      await open(`format=markdown&include=evidence`);
      await getBinary(sc.app.port, exportUrl('format=epub&include=summary'));
      assert.deepEqual((await listFiles(sc.library)).filter((f) => !f.startsWith('.storyforge/')), before.filter((f) => !f.startsWith('.storyforge/')));
    });
  });

  test('backup: provenance=1 now holds every receipt and object; the default holds none', async () => {
    const off = readZip((await getBinary(sc.app.port, `/api/books/${'book_01S5000000000000000000000A'}/backup`)).body).entries.map((e) => e.name);
    assert.ok(!off.some((n) => /(^|\/)provenance\//.test(n)), 'off by default');
    const on = readZip((await getBinary(sc.app.port, `/api/books/${'book_01S5000000000000000000000A'}/backup?provenance=1`)).body).entries.map((e) => e.name);
    const mine = on.filter((n) => /(^|\/)provenance\/.+/.test(n) && !n.endsWith('/')).map((n) => n.replace(/^.*?provenance\//, 'provenance/')).sort();
    const onDisk = (await listFiles(path.join(sc.library, 'provenance'))).map((f) => `provenance/${f}`).sort();
    assert.deepEqual(mine, onDisk);
    assert.ok(onDisk.some((f) => f.startsWith('provenance/objects/')) && onDisk.some((f) => /rcpt_/.test(f)));
  });
});

describe('8.7 no key, and the full prompt only when ticked', () => {
  test('precondition (8.7): the books really hold receipts and objects, so the scans below are not scanning nothing', async () => {
    for (const lib of [sc.library, kept.library]) {
      const all = await readReceipts(lib);
      assert.ok(all.length >= 6, `receipts under provenance/: ${all.length}`);
      assert.ok(all.some((r) => r.fm?.operation === 'ai.proposal'));
      assert.ok((await listFiles(path.join(lib, 'provenance', 'objects'))).length >= 4, 'content objects');
    }
  });

  test('the API key is in no file of the book (receipts, objects, .storyforge included), no response and no config file', async () => {
    for (const lib of [sc.library, kept.library]) for (const [name, buf] of await readEverything(lib)) assert.ok(!buf.toString('latin1').includes(SECRET), `key in ${name}`);
    for (const a of [sc.app, kept.app]) assert.ok(!a.output().includes(SECRET));
    assert.ok(!JSON.stringify(await readConfigFiles(sc.home.configDir)).includes(SECRET));
    for (const url of [RCPT.receipts(ARRIVAL), RCPT.blame(ARRIVAL, 15, 19), RCPT.verify()]) assert.ok(!(await sc.app.get(url)).text.includes(SECRET), url);
  });

  test('no key in a summary or an evidence package (every part inflated)', async () => {
    for (const q of ['format=markdown&include=summary', 'format=docx&include=summary', 'format=markdown&include=evidence', 'format=pdf&include=summary']) {
      const r = await getBinary(sc.app.port, exportUrl(q));
      const format = /format=(\w+)/.exec(q)[1];
      const parts = q.includes('evidence') ? readZip(r.body).entries.flatMap((e) => (/\.(docx|epub)$/.test(e.name) ? blobs(format, e.data) : [e.data])) : blobs(format, r.body);
      for (const b of [r.body, ...parts]) assert.ok(!b.toString('latin1').includes(SECRET), q);
    }
  });

  test('default: the full prompt is in no receipt (only its hash); there is no Prompt section', async () => {
    for (const r of await readReceipts(sc.library)) {
      assert.ok(!r.bytes.toString('utf8').includes('ZORBLAXPROMPT'), `${r.rel} holds the prompt`);
      assert.doesNotMatch(r.body, /^##\s+Prompt/m);
    }
    for (const rel of await listFiles(path.join(sc.library, 'provenance'))) assert.ok(!(await fs.readFile(path.join(sc.library, 'provenance', ...rel.split('/')))).toString('latin1').includes('ZORBLAXPROMPT'), rel);
  });

  test('ticked: the proposal receipt of that action holds the prompt under `## Prompt`; no other receipt does; the hash is still recorded', async () => {
    const all = await readReceipts(kept.library);
    const withPrompt = all.filter((r) => r.bytes.toString('utf8').includes('ZORBLAXPROMPT'));
    assert.deepEqual(withPrompt.map((r) => r.fm.operation), ['ai.proposal']);
    assert.match(withPrompt[0].body, /^##\s+Prompt\s*$/m);
    const section = withPrompt[0].body.split(/^##\s+Prompt\s*$/m)[1];
    assert.ok(section.includes(PROMPT), 'the instruction text is in the Prompt section');
    assert.equal(withPrompt[0].fm.ai.prompt_sha256, (await import('node:crypto')).createHash('sha256').update(PROMPT).digest('hex'));
  });

  test('per action: the next rewrite on the same book, not ticked, keeps no prompt', async () => {
    await getScene(kept.app, ARRIVAL);
    const { rewriteWhole } = await import('./receipts-helpers.mjs');
    const sug = await rewriteWhole(kept.app, kept.library, mock, { instruction: SECOND_PROMPT, edits: { 17: 'In the glass of the ticket hut she saw salt on her lashes.' } });
    assert.ok(sug.fm.id);
    const all = await readReceipts(kept.library);
    assert.ok(all.some((r) => r.fm.operation === 'ai.proposal' && r.fm.ai.suggestion === sug.fm.id), 'a second proposal was recorded');
    for (const r of all) assert.ok(!r.bytes.toString('utf8').includes('SECONDPROMPT'), r.rel);
    assert.equal(all.filter((r) => r.bytes.toString('utf8').includes('ZORBLAXPROMPT')).length, 1, 'still only the ticked one');
  });

  test('ticked prompt stays out of a manuscript-only export and a summary, and is in the private evidence package', async () => {
    const port = kept.app.port;
    for (const q of ['format=markdown', 'format=markdown&include=summary']) assert.ok(!(await getBinary(port, exportUrl(q))).body.toString('utf8').includes('ZORBLAXPROMPT'), q);
    const ev = readZip((await getBinary(port, exportUrl('format=markdown&include=evidence'))).body);
    assert.ok(ev.entries.some((e) => e.name.startsWith('provenance/') && e.data.toString('utf8').includes('ZORBLAXPROMPT')), 'the evidence package carries what the author chose to keep');
  });

  test('the suggestion document the author sees keeps no prompt text either way', async () => {
    for (const s of [sc, kept]) for (const rel of await listFiles(path.join(s.library, 'suggestions'))) assert.ok(!(await readText(s.library, `suggestions/${rel}`)).includes('ZORBLAXPROMPT'), rel);
  });
});
