// M13-J04 section 6: the real EPUBCheck. Needs Java 8+ and STORYFORGE_EPUBCHECK_JAR (an EPUBCheck 5 epubcheck.jar). Locally the tests skip with a
// notice when either is missing (also in CI, which does not install them).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import { validationProblems } from '@storyforge/format';
import { assembleManuscript, detectEpubCheck, detectJava, exportBook, runEpubCheck, toValidation } from '../src/index.mjs';
import { epubSourceMap } from '../src/epub.mjs';
import { cleanup, copyBook, rewriteZip, sha256 } from './helpers.mjs';

after(cleanup);

const jar = process.env.STORYFORGE_EPUBCHECK_JAR || null;
const java = await detectJava({ javaPath: process.env.STORYFORGE_JAVA || undefined });
const epubcheck = jar ? await detectEpubCheck({ java: java.path, jarPath: jar }) : null;
const problem = java.state !== 'ready' ? `Java is not available (${java.reason})` : !jar ? 'STORYFORGE_EPUBCHECK_JAR is not set' : epubcheck.state !== 'ready' ? `EPUBCheck is not available (${epubcheck.reason})` : null;
if (problem) console.log(`# EPUBCheck real tests: ${problem} - skipped`);

/** Run `body` when the tools are there; otherwise skip with the reason. */
const real = (name, body, options) =>
  test(name, options, async (t) => {
    if (problem) {
      t.skip(problem);
      return;
    }
    await body(t);
  });

const NAME = 'salt-orchard.epub';
const check = async (bytes, sourceMap = null, extra = {}) => {
  const run = await runEpubCheck({ java: java.path, jar, epubBytes: bytes, ...extra });
  assert.equal(run.ok, true, run.ok ? '' : `${run.kind}: ${run.detail}`);
  const result = toValidation({ run, artifact: { sha256: sha256(bytes), name: NAME }, sourceMap });
  assert.deepEqual(validationProblems(result), []);
  return { run, result };
};

async function sampleEpub() {
  const root = copyBook();
  const manuscript = await assembleManuscript(root, {});
  const { bytes } = await exportBook(root, 'epub', {});
  return { bytes, map: epubSourceMap(manuscript) };
}

real('the sample book export passes EPUBCheck with no messages', async () => {
  const { bytes, map } = await sampleEpub();
  const { run, result } = await check(bytes, map);
  assert.equal(run.report.checker.checkerVersion.split('.')[0], '5');
  assert.deepEqual(result.messages, []);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.validator, 'epubcheck');
  assert.match(result.validatorVersion, /^5\.\d+\.\d+$/);
});

real('a copy with the nav document removed fails with RSC-001 for the nav file', async () => {
  const { bytes, map } = await sampleEpub();
  const broken = rewriteZip(bytes, (entries) => ({ entries: entries.filter((e) => e.name !== 'OEBPS/nav.xhtml') }));
  const { result } = await check(broken, map);
  assert.equal(result.outcome, 'failed');
  const hit = result.messages.find((m) => m.code === 'RSC-001' && m.location?.path === 'OEBPS/nav.xhtml');
  assert.ok(hit, `RSC-001 for the nav file in ${JSON.stringify(result.messages.map((m) => [m.code, m.location?.path]))}`);
  assert.equal(hit.severity, 'error');
  assert.deepEqual([hit.sceneId, hit.chapterId], [null, null], 'the nav file is not a chapter');
});

real('a copy referencing a missing image fails with RSC-007 mapped to the chapter and scene', async () => {
  const { bytes, map } = await sampleEpub();
  const [file, entry] = Object.entries(map).find(([, e]) => e.scenes.length > 0);
  const scene = entry.scenes[0];
  const broken = rewriteZip(bytes, (entries) => {
    const target = entries.find((e) => e.name === file);
    const lines = target.data.toString('utf8').split('\n');
    const i = scene.firstLine - 1;
    assert.match(lines[i], /^<p\b[^>]*>/, 'the first line of the scene is a paragraph');
    lines[i] = lines[i].replace(/^<p\b[^>]*>/, (open) => `${open}<img src="missing.png" alt="missing"/>`);
    target.data = Buffer.from(lines.join('\n'), 'utf8');
  });
  const { result } = await check(broken, map);
  assert.equal(result.outcome, 'failed');
  const hit = result.messages.find((m) => m.code === 'RSC-007');
  assert.ok(hit, 'RSC-007 reported');
  assert.equal(hit.location.path, file);
  assert.equal(hit.location.line, scene.firstLine);
  assert.equal(hit.sceneId, scene.sceneId);
  assert.equal(hit.chapterId, entry.chapterId);
});

real('a line in a chapter file outside any scene maps to the chapter only', async () => {
  const { bytes, map } = await sampleEpub();
  const [file, entry] = Object.entries(map).find(([, e]) => e.scenes.length > 0 && e.scenes[0].firstLine > 10);
  const line = entry.scenes[0].firstLine - 1; // the chapter heading (or title page) line, before the first scene
  const broken = rewriteZip(bytes, (entries) => {
    const target = entries.find((e) => e.name === file);
    const lines = target.data.toString('utf8').split('\n');
    lines[line - 1] = `${lines[line - 1]}<img src="missing.png" alt="missing"/>`;
    target.data = Buffer.from(lines.join('\n'), 'utf8');
  });
  const { result } = await check(broken, map);
  const hit = result.messages.find((m) => m.code === 'RSC-007');
  assert.ok(hit, 'RSC-007 reported');
  assert.equal(hit.location.line, line);
  assert.deepEqual([hit.sceneId, hit.chapterId], [null, entry.chapterId]);
});

real('a file that is not a zip fails with a PKG fatal', async () => {
  const { result } = await check(Buffer.from('this is not an epub, just text\n'));
  assert.equal(result.outcome, 'failed');
  assert.ok(result.messages.some((m) => m.severity === 'fatal' && m.code.startsWith('PKG-')), JSON.stringify(result.messages.map((m) => [m.code, m.severity])));
});

real('cancelling a real run kills it and removes the scratch folder', async () => {
  const { bytes } = await sampleEpub();
  let cwd = null;
  const spawn = (command, args, options) => {
    cwd = options.cwd ?? cwd;
    return realSpawn(command, args, options);
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const run = await runEpubCheck({ java: java.path, jar, epubBytes: bytes, signal: ac.signal, spawn });
  assert.deepEqual([run.ok, run.kind], [false, 'cancelled']);
  assert.ok(cwd, 'the process was started in a scratch folder');
  assert.equal(fs.existsSync(cwd), false, 'scratch folder removed');
  assert.equal(toValidation({ run, artifact: { sha256: sha256(bytes), name: NAME } }).outcome, 'cancelled');
});

real('the detectors see the real Java and EPUBCheck', () => {
  assert.equal(java.state, 'ready');
  assert.equal(epubcheck.state, 'ready');
  assert.match(epubcheck.version, /^5\.\d+\.\d+$/);
});
