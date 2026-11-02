// M05 milestone gate, end to end with real server processes (main.mjs) and the real adapter CLI on temp copies of salt-orchard.
// "The fixture contradiction opens exact source files/lines; export produces a readable manuscript; the Claude-Book adapter can check an author-written scene
//  without modifying it; author, AI, and external changes have a verified receipt chain; and with no provider configured, the full app remains functional and
//  sends no network request."
// One test per clause, each on a fresh copy. Expected values are read from the files on disk and from the independent oracles of the earlier M05 jobs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bodyLineOf, frontMatterLines, sourceHref } from '../../web/src/continuity/model.js';
import { FORMATS, MIME, ORDER, REQUIRED, FORBIDDEN, orderProblems, phrasesFor, textOf } from '../../../packages/export/test/helpers.mjs';
import { diffSnapshots, pythonAvailable, snapshot as cbSnapshot } from '../../../packages/claude-book/test/helpers.mjs';
import { netCalls, netEnv, setup as cbSetup } from '../../../packages/claude-book/test/author-helpers.mjs';
import { AI, ARRIVAL, ARRIVAL_PATH, BOOK, freshLibrary, makeHome, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { RCPT, checkChain, chainOf, getBinary, opOf, readReceipts, receiptsOf, runScenario, sha } from './receipts-helpers.mjs';
import { SUG, CF1, readBytes } from './suggest-helpers.mjs';
import { waitFor } from './proc-helpers.mjs';

after(stopAll);

const b = (p = '') => `/api/books/${BOOK}${p}`;
const MAREN = 'codex/characters/maren-hollis.md';

const lineOfFile = async (library, rel, n) => (await readBytes(library, rel)).toString('utf8').split(/\r?\n/)[n - 1];

// ------------------------------------------------------------------------------------------------------------------------------
// Clause 1: the fixture contradiction opens exact source files and lines.

test('M05 gate 1: the CF1 opens the exact files and lines: context shows the evidence text at that line, and the editor target lands on it', async () => {
  const library = await freshLibrary();
  const app = await startApp({ library, home: await makeHome() });

  const res = await app.get(b('/continuity'));
  assert.equal(res.status, 200, res.text);
  const cf1s = res.json.findings.filter((f) => f.rule === 'CF1');
  assert.equal(cf1s.length, 1, 'exactly one CF1 in the fixture');
  const cf1 = cf1s[0];
  assert.equal(cf1.fingerprint, CF1);
  assert.deepEqual(cf1.sources.map((s) => [s.file, s.line]), [[MAREN, 13], [ARRIVAL_PATH, 17]]);
  assert.deepEqual(cf1.sources[1].range, { from: 56, to: 66 });

  for (const s of cf1.sources) {
    const onDisk = await lineOfFile(library, s.file, s.line);
    assert.ok(onDisk.length > 0, `${s.file}:${s.line} is a real, non-empty line`);
    const ctx = await app.get(`${b('/continuity/context')}?file=${encodeURIComponent(s.file)}&line=${s.line}&radius=3`);
    assert.equal(ctx.status, 200, ctx.text);
    const at = ctx.json.lines.find((l) => l.n === s.line);
    assert.ok(at, `context contains line ${s.line}`);
    assert.equal(at.text, onDisk, 'the context line is exactly the file line');
    // the evidence the finding quotes is on that very line
    assert.ok(onDisk.includes(s.excerpt), `the finding's excerpt is on ${s.file}:${s.line}`);
  }
  assert.ok((await lineOfFile(library, MAREN, 13)).includes('Eyes: Grey'));
  assert.ok((await lineOfFile(library, ARRIVAL_PATH, 17)).includes('green eyes ringed with salt'));

  // the editor target: file line -> body line (the app's own link rule), and that body line of the scene text is the evidence line
  const textSource = cf1.sources[1];
  const raw = await app.get(`${b('/raw')}?path=${encodeURIComponent(textSource.file)}`);
  assert.equal(raw.status, 200, raw.text);
  const bodyLine = bodyLineOf(textSource.line, frontMatterLines(raw.json.body));
  assert.ok(bodyLine > 0);
  const href = sourceHref(BOOK, textSource, bodyLine);
  assert.equal(href, `/books/${BOOK}?scene=${textSource.id}&line=${bodyLine}`);
  const target = Number(new URL(href, 'http://x').searchParams.get('line'));
  const scene = (await app.get(b(`/scenes/${ARRIVAL}`))).json;
  assert.equal(textSource.id, ARRIVAL);
  assert.equal(scene.body.split('\n')[target - 1], await lineOfFile(library, ARRIVAL_PATH, 17), 'editor ?line= is the evidence line in the body');
});

// ------------------------------------------------------------------------------------------------------------------------------
// Clause 2: export produces a readable manuscript.

test('M05 gate 2: export markdown, docx, epub and pdf through the route: right type, scenes in canonical order, nothing a reader should not see', async () => {
  const library = await freshLibrary();
  const app = await startApp({ library, home: await makeHome() });
  const phrases = phrasesFor(ORDER);
  const texts = {};

  for (const format of FORMATS) {
    const r = await getBinary(app.port, RCPT.exportUrl(`format=${format}`));
    assert.equal(r.status, 200, `${format}: ${r.body.toString('utf8').slice(0, 200)}`);
    assert.ok(r.headers['content-type'].toLowerCase().startsWith(MIME[format]), `${format} content-type ${r.headers['content-type']}`);
    assert.match(r.headers['content-disposition'], /^attachment/);
    assert.ok(r.body.length > 200, `${format} is not empty`);
    const text = textOf(format, r.body);
    texts[format] = text;
    assert.deepEqual(orderProblems(text, phrases), [], `${format}: every scene present, in canonical order`);
    for (const need of REQUIRED) assert.ok(text.replace(/\s+/g, ' ').includes(need), `${format} keeps: ${need}`);
    for (const nope of FORBIDDEN) assert.ok(!text.includes(nope), `${format} leaks: ${nope}`);
  }

  const md = texts.markdown;
  assert.match(md, /^#{1,3} .*Drowned Rows/m, 'a chapter heading for chapter 1');
  assert.match(md, /^#{1,3} .*Grafting/m, 'a chapter heading for chapter 2');
  const heads = md.split('\n').filter((l) => /^#{1,3} /.test(l));
  assert.ok(heads.length >= 2, `headings: ${heads.join(' | ')}`);
  assert.ok(md.includes('The ferry nudged the jetty'), "Arrival's text is in the manuscript");
  assert.ok(md.indexOf('Drowned Rows') < md.indexOf('The ferry nudged the jetty'), 'the chapter heading comes before its first scene');
});

// ------------------------------------------------------------------------------------------------------------------------------
// Clause 3: the Claude-Book adapter checks an author-written scene without modifying it.

test('M05 gate 3: sf-claude-book check --scene Arrival reports the CF1 with file:line and leaves the whole book tree byte- and mtime-identical', async () => {
  const { book, fw, go } = cbSetup();
  const before = cbSnapshot(book);
  const { status, r, bookD } = go('check', { extra: ['--scene', ARRIVAL, '--no-style'] });
  assert.equal(status, 0, r.stderr + r.stdout);
  const after = cbSnapshot(book);
  const d = diffSnapshots(before, after);
  const real = (p) => !p.startsWith('.storyforge');
  assert.deepEqual({ added: d.added.filter(real), removed: d.removed.filter(real), changed: d.changed.filter(real) }, { added: [], removed: [], changed: [] }, 'book tree identical (bytes, mtimes, file list)');
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });

  const dir = path.join(fw, '.work', 'salt-orchard', 'reports');
  {
    const names = await fs.readdir(dir);
    const jsons = names.filter((n) => /check-report\.json$/.test(n));
    assert.ok(jsons.length >= 1, `a check report was written (${names})`);
    const j = JSON.parse(await fs.readFile(path.join(dir, jsons[0]), 'utf8'));
    const cf1 = j.findings.find((f) => f.fingerprint === CF1);
    assert.ok(cf1, `CF1 in ${JSON.stringify(j.findings.map((f) => f.fingerprint ?? f.code))}`);
    assert.equal(cf1.file, ARRIVAL_PATH);
    assert.equal(cf1.line, 17);
    assert.ok(cf1.evidence.includes('green eyes ringed with salt'));
    const mdName = names.find((n) => /check-report\.md$/.test(n));
    assert.ok(mdName, 'a Markdown report too');
    assert.match(await fs.readFile(path.join(dir, mdName), 'utf8'), /0010-arrival\.md:17/);
  }
});

test('M05 gate 3b: the same check with the style checker still leaves the book untouched', { skip: !pythonAvailable() && 'python missing: the style checker stand-in cannot run' }, () => {
  const { book, go } = cbSetup();
  const before = cbSnapshot(book);
  const { status, r } = go('check', { chapter: 1 });
  assert.equal(status, 0, r.stderr + r.stdout);
  const d = diffSnapshots(before, cbSnapshot(book));
  const real = (p) => !p.startsWith('.storyforge');
  assert.deepEqual({ added: d.added.filter(real), removed: d.removed.filter(real), changed: d.changed.filter(real) }, { added: [], removed: [], changed: [] });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Clause 4: author, AI and external changes have a verified receipt chain.

test('M05 gate 4: author save, AI rewrite, accepted hunk and an outside edit are one chain, verified by an independent checker and by the verify route', async () => {
  const mock = await startMockProvider({ reply: 'unused' });
  let sc;
  try {
    sc = await runScenario({ mock }); // opens Arrival, author appends + flush, AI rewrite, accept h1, decline h2, hand edit + flush
    const { app, library } = sc;

    // an outside program changes the scene. The watcher can ignore an event that lands right after the server's own save, so the outside edit is
    // (re)written with a new marker until the watcher has recorded it; nothing is slept on.
    const file = path.join(library, ...ARRIVAL_PATH.split('/'));
    const base = await fs.readFile(file, 'utf8');
    let marker = '';
    let current;
    let polls = 0;
    await waitFor(async () => {
      if (polls++ % 10 === 0) {
        marker = `zzgatemarker${polls}`;
        await fs.writeFile(file, base.replace('ticket hut', `ticket ${marker} hut`));
        current = await readBytes(library, ARRIVAL_PATH);
      }
      return chainOf(await readReceipts(library), ARRIVAL).some((r) => r.fm.operation === 'external.change');
    }, { timeout: 45000, what: 'an external.change receipt for the outside edit' });
    const flushed = await app.post(RCPT.flush(), { sceneId: ARRIVAL });
    assert.ok(flushed.status < 300, flushed.text);

    const chain = chainOf(await readReceipts(library), ARRIVAL);
    const ops = chain.map((r) => r.fm.operation);
    for (const op of ['author.edit', 'ai.proposal', 'suggestion.accept', 'external.change']) assert.ok(ops.includes(op), `${op} in ${ops}`);
    const by = (op) => chain.filter((r) => r.fm.operation === op);
    assert.equal(by('author.edit')[0].fm.actor, 'author');
    assert.equal(by('ai.proposal')[0].fm.actor, 'ai');
    assert.equal(by('suggestion.accept')[0].fm.actor, 'ai', 'an accepted AI hunk is attributed to the AI');
    assert.equal(by('external.change').at(-1).fm.actor, 'external');
    assert.equal(chain.at(-1).fm.operation, 'external.change', 'the outside edit is the newest link');
    assert.equal(chain.at(-1).fm.after_sha256, sha(current), 'the last receipt names the bytes on disk');
    assert.ok(chain.at(-1).body.includes(marker), 'its diff shows the outside change');
    assert.ok(ops.indexOf('author.edit') < ops.indexOf('ai.proposal') && ops.indexOf('ai.proposal') < ops.indexOf('suggestion.accept'), 'recorded in the order it happened');

    // independent checker (files only) and the product's verify route agree
    assert.deepEqual(await checkChain(library, { [ARRIVAL]: current }), [], 'independent chain check');
    const v = await app.get(RCPT.verify());
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.ok, true, v.text);
    assert.deepEqual(v.json.problems, []);
    const api = await app.get(RCPT.receipts(ARRIVAL));
    assert.deepEqual(receiptsOf(api.json).map(opOf), ops, 'the route lists the same chain');
  } finally {
    await sc?.app.stop();
    await mock.close();
  }
});

// ------------------------------------------------------------------------------------------------------------------------------
// Clause 5: no provider: the app works and sends nothing.

test('M05 gate 5: with no provider configured every tab reads, saving / exceptions / export / checks work, zero outbound calls, AI routes answer 409 AI_NOT_CONFIGURED', async () => {
  const library = await freshLibrary();
  const home = await makeHome(); // empty user config
  const app = await startApp({ library, home, net: true });

  // read routes: one per tab, all must answer 200
  const reads = [
    '/api/library', b(), b(`/scenes/${ARRIVAL}`), b('/codex/entries'), b('/threads'), b('/timeline'), b('/notes'), b('/graph'), b('/continuity'),
    b('/diagnostics'), b('/activity'), '/api/search?q=maren', RCPT.receipts(ARRIVAL), RCPT.verify(),
  ];
  for (const p of reads) {
    const r = await app.get(p);
    assert.equal(r.status, 200, `GET ${p} -> ${r.status}: ${r.text.slice(0, 200)}`);
  }
  assert.deepEqual((await app.get(AI.profiles)).json.profiles ?? [], [], 'no provider exists');

  // a body save
  const scene = (await app.get(b(`/scenes/${ARRIVAL}`))).json;
  const saved = await app.put(RCPT.body(ARRIVAL), { body: `${scene.body}\nA line written with no provider.\n`, base_sha256: scene.sha256 });
  assert.equal(saved.status, 200, saved.text);
  assert.ok((await readBytes(library, ARRIVAL_PATH)).toString('utf8').includes('A line written with no provider.'), 'the save reached the file');

  // a continuity exception
  const exc = await app.post(b('/continuity/exceptions'), { fingerprint: CF1, rationale: 'Maren wears tinted glass in this scene.' });
  assert.ok(exc.status >= 200 && exc.status < 300, exc.text);
  const after = (await app.get(b('/continuity'))).json;
  assert.ok(!after.findings.some((f) => f.fingerprint === CF1), 'the acknowledged CF1 leaves the open queue');
  assert.ok(after.suppressed.some((s) => s.finding.fingerprint === CF1), '...and is listed as acknowledged');

  // an export
  const ex = await getBinary(app.port, RCPT.exportUrl('format=markdown'));
  assert.equal(ex.status, 200);
  assert.ok(ex.body.toString('utf8').includes('A line written with no provider.'), 'the export has the new text');

  // a check (app route, and the adapter CLI with the same recorder in its process)
  const chk = await app.post(SUG.check(), { sceneId: ARRIVAL });
  assert.equal(chk.status, 200, chk.text);
  assert.ok(Array.isArray(chk.json.findings));
  const { log, env } = netEnv();
  const { go } = cbSetup();
  const run = go('check', { extra: ['--scene', ARRIVAL, '--no-style'], env });
  assert.equal(run.status, 0, run.r.stderr + run.r.stdout);
  assert.deepEqual(netCalls(log), [], 'the adapter makes no network call');

  // AI routes are refused, not attempted
  for (const [url, body] of [
    [AI.context(), { task: 'chat', files: ['book.md'], instruction: 'hello' }],
    [AI.send(), { contextId: 'ctx_nope' }],
    [AI.apply(), { contextId: 'ctx_nope' }],
    [AI.discard(), { contextId: 'ctx_nope' }],
  ]) {
    const r = await app.post(url, body);
    assert.equal(r.status, 409, `${url}: ${r.text}`);
    assert.equal(r.json.code ?? r.json.error, 'AI_NOT_CONFIGURED', r.text);
  }

  const calls = await app.netCalls();
  assert.deepEqual(calls, [], `outbound calls recorded: ${JSON.stringify(calls)}`);
});
