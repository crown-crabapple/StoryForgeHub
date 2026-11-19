// M13-J04: EPUBCheck runner, detectors, validation mapping, source map and explanations, with a fake `spawn` (no Java needed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { validationProblems } from '@storyforge/format';
import { assembleManuscript, detectEpubCheck, detectJava, explainEpubCheck, exportBook, runEpubCheck, toValidation } from '../src/index.mjs';
import { renderEpub, epubSourceMap } from '../src/epub.mjs';
import { SCENES, cleanup, copyBook, readEpub, sha256 } from './helpers.mjs';

after(cleanup);

const JAVA = path.join(path.sep, 'opt', 'java', 'bin', 'java');
const JAR = path.join(path.sep, 'opt', 'epubcheck', 'epubcheck.jar');

/**
 * A fake spawn. `script({ child, command, args, options, calls })` runs on the next tick; it may write to the child's streams, emit
 * 'error' / 'close', or do nothing (a hang). `kill` records the signal and closes the child like a killed process.
 */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (sig) => {
      child.killed.push(sig ?? 'SIGTERM');
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(() => script?.({ child, command, args, options, calls }));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const writeReport = (args, report) => fs.writeFileSync(args[args.indexOf('--json') + 1], typeof report === 'string' ? report : JSON.stringify(report));
const sampleReport = (messages = [], extra = {}) => ({ messages, customMessageFileName: null, checker: { path: 'x', filename: 'book.epub', checkerVersion: '5.4.0', checkDate: '2026-01-01T00:00:00Z', elapsedTime: 10, nFatal: 0, nError: 0, nWarning: 0, nUsage: 0, ...extra }, publication: {}, items: [] });
const msg = (ID, severity, message, locations = [], extra = {}) => ({ ID, severity, message, additionalLocations: 0, locations, suggestion: null, ...extra });
const loc = (p, line = -1, column = -1) => ({ url: `file:${p}`, path: p, line, column, context: null });
const closeWith = (child, code) => child.emit('close', code, null);

// ------------------------------------------------------------------ runEpubCheck

test('runEpubCheck runs java with a fixed argument array: no shell, scrubbed environment, scratch cwd; the scratch folder is removed', async () => {
  const spawn = fakeSpawn(({ child, args }) => {
    writeReport(args, sampleReport());
    closeWith(child, 0);
  });
  const env = { PATH: '/bin', Path: undefined, SystemRoot: 'C:\\Windows', TEMP: '/t', TMP: '/t', JAVA_HOME: '/jh', SECRET_TOKEN: 'nope', HOME: '/home/x', NODE_OPTIONS: '--x' };
  const bytes = Buffer.from('PK-not-checked-here');
  const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: bytes, name: 'My Secret Title.epub', spawn, env });
  assert.equal(run.ok, true);
  assert.equal(spawn.calls.length, 1);
  const { command, args, options } = spawn.calls[0];
  assert.equal(command, JAVA);
  const dir = path.dirname(args[2]);
  assert.deepEqual(args, ['-jar', JAR, path.join(dir, 'book.epub'), '--json', path.join(dir, 'report.json'), '-q']);
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.ok(!args.join(' ').includes('Secret'), 'no user text in the arguments');
  assert.equal(options.cwd, dir);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(!('shell' in options) || options.shell === false || options.shell === undefined);
  assert.deepEqual(Object.keys(options.env).sort(), ['JAVA_HOME', 'PATH', 'SystemRoot', 'TEMP', 'TMP']);
  assert.equal(options.env.PATH, '/bin');
  assert.equal(options.env.JAVA_HOME, '/jh');
  assert.equal(fs.existsSync(dir), false, 'scratch folder removed');
});

test('runEpubCheck writes the EPUB bytes to book.epub before starting', async () => {
  let seen = null;
  const spawn = fakeSpawn(({ child, args }) => {
    seen = fs.readFileSync(args[2]);
    writeReport(args, sampleReport());
    closeWith(child, 0);
  });
  const bytes = Buffer.from([1, 2, 3, 4, 5, 250]);
  await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: bytes, spawn, env: {} });
  assert.ok(seen.equals(bytes));
});

test('runEpubCheck: the JSON report decides; exit code 1 with a report is a normal result, and stdout/stderr come back', async () => {
  const report = sampleReport([msg('RSC-001', 'ERROR', 'missing', [loc('OEBPS/nav.xhtml')])], { nError: 1 });
  const spawn = fakeSpawn(({ child, args }) => {
    child.stdout.emit('data', Buffer.from('Validating...'));
    child.stderr.emit('data', Buffer.from('ERROR(RSC-001)'));
    writeReport(args, report);
    closeWith(child, 1);
  });
  const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn, env: {} });
  assert.equal(run.ok, true);
  assert.deepEqual(run.report, report);
  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, 'Validating...');
  assert.equal(run.stderr, 'ERROR(RSC-001)');
  assert.ok(Number.isInteger(run.elapsedMs) && run.elapsedMs >= 0);
});

test('runEpubCheck: exit code 0 with no usable report is not a pass (bad-output)', async () => {
  for (const [label, write] of [
    ['no report', null],
    ['not JSON', (args) => writeReport(args, '{ nope')],
    ['wrong shape', (args) => writeReport(args, '[]')],
    ['no messages list', (args) => writeReport(args, { checker: {} })],
  ]) {
    const spawn = fakeSpawn(({ child, args }) => {
      write?.(args);
      closeWith(child, 0);
    });
    const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn, env: {} });
    assert.equal(run.ok, false, label);
    assert.equal(run.kind, 'bad-output', label);
    assert.ok(run.detail.length > 0, label);
  }
});

test('runEpubCheck: usage error (exit 1, no report) is bad-output; death by signal or an odd exit code is crashed', async () => {
  const exit1 = fakeSpawn(({ child }) => {
    child.stderr.emit('data', Buffer.from('Usage error: something\nmore'));
    closeWith(child, 1);
  });
  const a = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: exit1, env: {} });
  assert.equal(a.kind, 'bad-output');
  assert.match(a.detail, /Usage error: something/);
  const killed = fakeSpawn(({ child }) => child.emit('close', null, 'SIGKILL'));
  const b = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: killed, env: {} });
  assert.deepEqual([b.ok, b.kind], [false, 'crashed']);
  const odd = fakeSpawn(({ child }) => closeWith(child, 134));
  const c = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: odd, env: {} });
  assert.deepEqual([c.ok, c.kind], [false, 'crashed']);
});

test('runEpubCheck: a report over 20 MB is bad-output and is not read', async () => {
  const spawn = fakeSpawn(({ child, args }) => {
    fs.writeFileSync(args[args.indexOf('--json') + 1], Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
    closeWith(child, 1);
  });
  const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn, env: {} });
  assert.deepEqual([run.ok, run.kind], [false, 'bad-output']);
  assert.match(run.detail, /20 MB/);
});

test('runEpubCheck keeps only the first 256 KB of stdout and of stderr', async () => {
  const spawn = fakeSpawn(({ child, args }) => {
    for (let i = 0; i < 5; i += 1) {
      child.stdout.emit('data', Buffer.alloc(100 * 1024, 0x61));
      child.stderr.emit('data', Buffer.alloc(100 * 1024, 0x62));
    }
    child.stdout.emit('data', Buffer.from('LATE'));
    writeReport(args, sampleReport());
    closeWith(child, 0);
  });
  const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn, env: {} });
  assert.equal(run.stdout.length, 256 * 1024);
  assert.equal(run.stderr.length, 256 * 1024);
  assert.ok(!run.stdout.includes('LATE'));
  assert.ok(/^a+$/.test(run.stdout) && /^b+$/.test(run.stderr));
});

test('runEpubCheck: a missing java is unavailable; another start failure (or a throw) is crashed', async () => {
  const enoent = fakeSpawn(({ child }) => child.emit('error', Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' })));
  const a = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: enoent, env: {} });
  assert.deepEqual([a.ok, a.kind], [false, 'unavailable']);
  const eacces = fakeSpawn(({ child }) => child.emit('error', Object.assign(new Error('nope'), { code: 'EACCES' })));
  const b = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: eacces, env: {} });
  assert.deepEqual([b.ok, b.kind], [false, 'crashed']);
  const throws = () => {
    throw Object.assign(new Error('bad'), { code: 'EINVAL' });
  };
  const c = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), spawn: throws, env: {} });
  assert.deepEqual([c.ok, c.kind], [false, 'crashed']);
});

test('runEpubCheck: a run over its time limit is killed and reported as timeout; the scratch folder is removed', async () => {
  const spawn = fakeSpawn();
  const run = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), timeoutMs: 40, spawn, env: {} });
  assert.deepEqual([run.ok, run.kind], [false, 'timeout']);
  assert.deepEqual(spawn.calls[0].child.killed, ['SIGTERM']);
  assert.equal(fs.existsSync(spawn.calls[0].options.cwd), false);
});

test('runEpubCheck: abort kills the process and returns cancelled; an already-aborted signal never starts it', async () => {
  const spawn = fakeSpawn();
  const ac = new AbortController();
  const pending = runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), signal: ac.signal, spawn, env: {} });
  setTimeout(() => ac.abort(), 30);
  const run = await pending;
  assert.deepEqual([run.ok, run.kind], [false, 'cancelled']);
  assert.equal(spawn.calls[0].child.killed.length, 1);
  assert.equal(fs.existsSync(spawn.calls[0].options.cwd), false);

  const never = fakeSpawn();
  const done = new AbortController();
  done.abort();
  const again = await runEpubCheck({ java: JAVA, jar: JAR, epubBytes: Buffer.alloc(1), signal: done.signal, spawn: never, env: {} });
  assert.deepEqual([again.ok, again.kind], [false, 'cancelled']);
  assert.equal(never.calls.length, 0);
});

// ------------------------------------------------------------------ detectors

const javaSpawn = (stderr, code = 0) => fakeSpawn(({ child }) => {
  child.stderr.emit('data', Buffer.from(stderr));
  closeWith(child, code);
});

test('detectJava parses java -version from stderr (1.8 is 8) and requires 8 or newer', async () => {
  const cases = [
    ['java version "19.0.2" 2023-01-17\nJava(TM) SE Runtime Environment', 'ready', '19.0.2'],
    ['openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime', 'ready', '17.0.9'],
    ['openjdk version "21" 2023-09-19', 'ready', '21'],
    ['java version "1.8.0_392"\nJava(TM) SE', 'ready', '1.8.0_392'],
    ['java version "1.7.0_80"', 'unavailable', '1.7.0_80'],
    ['openjdk version "1.6"', 'unavailable', '1.6'],
  ];
  for (const [stderr, state, version] of cases) {
    const spawn = javaSpawn(stderr);
    const r = await detectJava({ javaPath: JAVA, env: {}, spawn });
    assert.equal(r.state, state, stderr);
    assert.equal(r.version, version, stderr);
    assert.equal(r.path, JAVA);
    assert.equal(r.reason === null, state === 'ready', stderr);
    assert.deepEqual(spawn.calls[0].args, ['-version']);
    assert.equal(spawn.calls[0].command, JAVA);
  }
});

test('detectJava: missing binary, unreadable version and a hang are unavailable with a reason', async () => {
  const enoent = fakeSpawn(({ child }) => child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
  const a = await detectJava({ javaPath: JAVA, env: {}, spawn: enoent });
  assert.deepEqual([a.state, a.version], ['unavailable', null]);
  assert.match(a.reason, /not found/);
  const junk = await detectJava({ javaPath: JAVA, env: {}, spawn: javaSpawn('something else entirely') });
  assert.equal(junk.state, 'unavailable');
  assert.match(junk.reason, /version/);
  const hang = await detectJava({ javaPath: JAVA, env: {}, spawn: fakeSpawn(), timeoutMs: 30 });
  assert.equal(hang.state, 'unavailable');
  assert.match(hang.reason, /did not answer/);
});

test('detectJava without a path tries JAVA_HOME/bin/java then java on PATH', async () => {
  const seen = [];
  const spawn = fakeSpawn(({ child, command }) => {
    seen.push(command);
    if (command === 'java') {
      child.stderr.emit('data', Buffer.from('openjdk version "17.0.1"'));
      closeWith(child, 0);
    } else child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
  });
  const r = await detectJava({ env: { JAVA_HOME: path.join(path.sep, 'jh') }, spawn });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], path.join(path.sep, 'jh', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  assert.equal(seen[1], 'java');
  assert.deepEqual([r.state, r.path], ['ready', 'java']);
});

const checkSpawn = (stdout, code = 0) => fakeSpawn(({ child }) => {
  child.stdout.emit('data', Buffer.from(stdout));
  closeWith(child, code);
});

test('detectEpubCheck reads --version: 5.4.0 ready, another 5.x ready with a note, other majors and junk unavailable', async () => {
  const ok = checkSpawn('EPUBCheck v5.4.0\n');
  const a = await detectEpubCheck({ java: JAVA, jarPath: JAR, env: {}, spawn: ok });
  assert.deepEqual(a, { state: 'ready', path: JAR, version: '5.4.0', reason: null });
  assert.deepEqual(ok.calls[0].args, ['-jar', JAR, '--version']);
  assert.equal(ok.calls[0].command, JAVA);

  const b = await detectEpubCheck({ java: JAVA, jarPath: JAR, env: {}, spawn: checkSpawn('EPUBCheck v5.2.1\n') });
  assert.equal(b.state, 'ready');
  assert.equal(b.version, '5.2.1');
  assert.match(b.reason, /tested with 5\.4\.0/i);

  for (const v of ['4.2.1', '6.0.0']) {
    const c = await detectEpubCheck({ java: JAVA, jarPath: JAR, env: {}, spawn: checkSpawn(`EPUBCheck v${v}\n`) });
    assert.equal(c.state, 'unavailable', v);
    assert.equal(c.version, v);
    assert.match(c.reason, /supports EPUBCheck 5/);
  }
  const d = await detectEpubCheck({ java: JAVA, jarPath: JAR, env: {}, spawn: checkSpawn('Error: Unable to access jarfile', 1) });
  assert.deepEqual([d.state, d.version], ['unavailable', null]);
});

test('detectEpubCheck: no jar, no java, java missing', async () => {
  const never = fakeSpawn();
  assert.equal((await detectEpubCheck({ java: JAVA, jarPath: null, spawn: never })).state, 'unavailable');
  assert.equal((await detectEpubCheck({ java: null, jarPath: JAR, spawn: never })).state, 'unavailable');
  assert.equal(never.calls.length, 0);
  const enoent = fakeSpawn(({ child }) => child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
  assert.equal((await detectEpubCheck({ java: JAVA, jarPath: JAR, env: {}, spawn: enoent })).state, 'unavailable');
});

// ------------------------------------------------------------------ toValidation

const ART = { sha256: sha256(Buffer.from('epub')), name: 'salt-orchard.epub' };
const NOW = () => new Date('2026-05-06T07:08:09.000Z');
const okRun = (report) => ({ ok: true, report, stdout: '', stderr: '', exitCode: 1, elapsedMs: 5 });

test('toValidation maps EPUBCheck messages: code, lower-case severity, message, location, extra locations; and passes validationProblems', () => {
  const run = okRun(sampleReport([
    msg('RSC-007', 'ERROR', 'Referenced resource could not be found', [loc('OEBPS/chapter-001.xhtml', 10, 43), loc('OEBPS/chapter-002.xhtml', 3, 1)], { additionalLocations: 2 }),
    msg('PKG-008', 'FATAL', 'Fatal', [loc('book.epub')]),
    msg('OPF-099', 'Warning', 'mixed case', []),
    msg('ACC-001', 'INFO', 'info'),
    msg('OPF-100', 'USAGE', 'usage'),
  ]));
  const v = toValidation({ run, artifact: ART, now: NOW });
  assert.deepEqual(validationProblems(v), []);
  assert.equal(v.schema, 'storyforge.validation/v1');
  assert.equal(v.validator, 'epubcheck');
  assert.equal(v.validatorVersion, '5.4.0');
  assert.equal(v.checkedAt, '2026-05-06T07:08:09.000Z');
  assert.deepEqual(v.artifact, { kind: 'epub', sha256: ART.sha256, name: ART.name });
  assert.equal(v.outcome, 'failed');
  assert.equal(v.detail, null);
  assert.deepEqual(v.messages.map((m) => [m.code, m.severity]), [['RSC-007', 'error'], ['PKG-008', 'fatal'], ['OPF-099', 'warning'], ['ACC-001', 'info'], ['OPF-100', 'usage']]);
  assert.equal(v.messages[0].message, 'Referenced resource could not be found');
  assert.deepEqual(v.messages[0].location, { path: 'OEBPS/chapter-001.xhtml', line: 10, column: 43 });
  assert.equal(v.messages[0].more, 3, 'one extra location listed plus two more reported');
  assert.equal(v.messages[2].location, null, 'no location');
  assert.equal(v.messages[1].more, undefined);
  assert.ok(v.messages.every((m) => m.sceneId === null && m.chapterId === null), 'no source map, no mapping');
});

test('toValidation: unknown line and column (EPUBCheck -1) become null and the result still validates', () => {
  const v = toValidation({ run: okRun(sampleReport([msg('RSC-001', 'ERROR', 'File "OEBPS/nav.xhtml" could not be found.', [loc('OEBPS/nav.xhtml')])])), artifact: ART, now: NOW });
  assert.deepEqual(v.messages[0].location, { path: 'OEBPS/nav.xhtml', line: null, column: null });
  assert.deepEqual(validationProblems(v), []);
});

test('toValidation: outcome follows the messages (passed, passed-with-warnings, failed); a clean run has zero messages', () => {
  const clean = toValidation({ run: okRun(sampleReport([])), artifact: ART, now: NOW });
  assert.deepEqual([clean.outcome, clean.messages.length], ['passed', 0]);
  assert.deepEqual(validationProblems(clean), []);
  const warn = toValidation({ run: okRun(sampleReport([msg('OPF-1', 'WARNING', 'w', [loc('OEBPS/content.opf', 1, 1)]), msg('X-1', 'INFO', 'i')])), artifact: ART, now: NOW });
  assert.equal(warn.outcome, 'passed-with-warnings');
  assert.deepEqual(validationProblems(warn), []);
  const info = toValidation({ run: okRun(sampleReport([msg('X-1', 'USAGE', 'u')])), artifact: ART, now: NOW });
  assert.equal(info.outcome, 'passed');
});

test('toValidation: runs that did not reach a verdict are unavailable, error or cancelled, never a pass', () => {
  const cases = [
    [{ ok: false, kind: 'unavailable', detail: 'Java was not found' }, 'unavailable'],
    [{ ok: false, kind: 'timeout', detail: 'too slow' }, 'error'],
    [{ ok: false, kind: 'crashed', detail: 'died' }, 'error'],
    [{ ok: false, kind: 'bad-output', detail: 'junk' }, 'error'],
    [{ ok: false, kind: 'cancelled', detail: 'stopped' }, 'cancelled'],
  ];
  for (const [run, outcome] of cases) {
    const v = toValidation({ run, artifact: ART, now: NOW });
    assert.equal(v.outcome, outcome, run.kind);
    assert.equal(v.detail, run.detail);
    assert.deepEqual(v.messages, []);
    assert.deepEqual(validationProblems(v), [], run.kind);
    assert.ok(!['passed', 'passed-with-warnings'].includes(v.outcome));
  }
});

test('toValidation: odd EPUBCheck data is tolerated (unknown severity is a warning, missing text falls back to the code)', () => {
  const v = toValidation({ run: okRun(sampleReport([msg('OPF-1', 'SUPPRESSED', '', [loc('OEBPS/content.opf', 2, 3)])])), artifact: ART, now: NOW });
  assert.equal(v.messages[0].severity, 'warning');
  assert.equal(v.messages[0].message, 'OPF-1');
  assert.deepEqual(validationProblems(v), []);
});

// ------------------------------------------------------------------ source map

const MAP_FILE = 'OEBPS/chapter-001.xhtml';

async function sampleBook(options = {}) {
  const root = copyBook();
  const manuscript = await assembleManuscript(root, options);
  const bytes = renderEpub(manuscript);
  return { root, manuscript, bytes, map: epubSourceMap(manuscript), epub: readEpub(bytes) };
}

test('epubSourceMap: every chapter file is listed; scene line ranges are the real lines of the written XHTML', async () => {
  for (const options of [{}, { sceneTitles: true }, { titlePage: false, includeActs: true }]) {
    const { map, epub } = await sampleBook(options);
    const files = [...epub.byName.keys()].filter((n) => /^OEBPS\/chapter-\d+\.xhtml$/.test(n));
    assert.deepEqual(Object.keys(map), files);
    let scenesSeen = 0;
    for (const [file, entry] of Object.entries(map)) {
      assert.equal(typeof entry.chapterLabel, 'string');
      assert.ok(entry.chapterLabel.length > 0);
      assert.ok(entry.chapterId === null || /^chap_[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.chapterId), `${file} ${entry.chapterId}`);
      const lines = epub.byName.get(file).data.toString('utf8').split('\n');
      let previousLast = 0;
      for (const s of entry.scenes) {
        scenesSeen += 1;
        assert.ok(s.firstLine >= 10 && s.firstLine <= s.lastLine && s.lastLine <= lines.length, `${file} ${s.sceneId} range`);
        assert.ok(s.firstLine > previousLast, 'ranges do not overlap');
        previousLast = s.lastLine;
        assert.ok(/^<(p|h3)\b/.test(lines[s.firstLine - 1]), `first line of ${s.sceneId} is a paragraph or heading: ${lines[s.firstLine - 1]}`);
        assert.ok(/^<(p|h3)\b[^]*<\/(p|h3)>$/.test(lines[s.lastLine - 1]), 'last line is a whole paragraph');
        const phrase = SCENES[s.sceneId]?.phrase;
        if (phrase) {
          const text = lines.slice(s.firstLine - 1, s.lastLine).join('\n').replace(/<[^>]+>/g, '');
          assert.ok(text.includes(phrase), `${s.sceneId} range contains its text`);
        }
      }
    }
    assert.ok(scenesSeen >= 7, `scenes mapped (${scenesSeen})`);
  }
});

test('epubSourceMap does not change the EPUB: renderEpub bytes equal those of the code before the map existed (pinned hashes)', async () => {
  const pinned = new Map([
    ['{}', '95dcf07451e82f8354fb44606275def224b09b9b400311e450313c45a5d2e596'],
    ['{"sceneTitles":true}', '41ff1728fc6044dfc99c8145249706e698b9a55f1f8a3fd5cdb3e0793681b180'],
    ['{"titlePage":false,"includeActs":true}', '2a988f29c04eb66ac4e43d4d2ea8d0a0cd30c3e81b65720b77c0ddc168cdb466'],
  ]);
  const root = copyBook();
  for (const [key, hash] of pinned) {
    const m = await assembleManuscript(root, JSON.parse(key));
    epubSourceMap(m);
    assert.equal(sha256(renderEpub(m)), hash, key);
    assert.equal(sha256(renderEpub(m)), hash, `${key} again after the map was computed`);
  }
  const out = await exportBook(root, 'epub', {});
  assert.equal(sha256(out.bytes), pinned.get('{}'));
});

test('source mapping: a message inside a scene gets the scene, elsewhere in the chapter file the chapter only, other files nothing', async () => {
  const { map } = await sampleBook();
  const [file, entry] = Object.entries(map).find(([, e]) => e.scenes.length > 0 && e.chapterId !== null);
  const scene = entry.scenes[0];
  const at = (p, line) => msg('RSC-005', 'ERROR', 'x', [loc(p, line, 1)]);
  const run = okRun(sampleReport([
    at(file, scene.firstLine), // 0 first line of the scene
    at(file, scene.lastLine), // 1 last line of the scene
    at(file, scene.firstLine - 1), // 2 just before the scene
    at(file, scene.lastLine + 1), // 3 just after the scene (or the next scene)
    at(file, -1), // 4 unknown line
    at('OEBPS/nav.xhtml', 12), // 5 other file
    at('OEBPS/content.opf', 3), // 6
    at('OEBPS/styles.css', 3), // 7
    at('OEBPS/chapter-999.xhtml', 12), // 8 not in the map
    msg('PKG-008', 'FATAL', 'x', []), // 9 no location
  ]));
  const v = toValidation({ run, artifact: ART, sourceMap: map, now: NOW });
  assert.deepEqual(validationProblems(v), []);
  const m = v.messages;
  assert.deepEqual([m[0].sceneId, m[0].chapterId], [scene.sceneId, entry.chapterId]);
  assert.deepEqual([m[1].sceneId, m[1].chapterId], [scene.sceneId, entry.chapterId]);
  assert.deepEqual([m[2].sceneId, m[2].chapterId], [null, entry.chapterId]);
  const next = entry.scenes[1];
  assert.equal(m[3].sceneId, next && next.firstLine === scene.lastLine + 1 ? next.sceneId : null);
  assert.deepEqual([m[4].sceneId, m[4].chapterId], [null, entry.chapterId]);
  for (const i of [5, 6, 7, 8, 9]) assert.deepEqual([m[i].sceneId, m[i].chapterId], [null, null], `message ${i}`);
});

test('source mapping with a chapter that has no id: the scene still maps, the chapter id is null', () => {
  const sourceMap = { [MAP_FILE]: { chapterId: null, chapterLabel: 'Chapter 1', scenes: [{ sceneId: 'scene_01S5000000000000000000000A', firstLine: 12, lastLine: 14 }] } };
  const run = okRun(sampleReport([msg('RSC-005', 'ERROR', 'x', [loc(MAP_FILE, 13, 2)]), msg('RSC-005', 'ERROR', 'y', [loc(MAP_FILE, 30, 2)])]));
  const v = toValidation({ run, artifact: ART, sourceMap, now: NOW });
  assert.deepEqual([v.messages[0].sceneId, v.messages[0].chapterId], ['scene_01S5000000000000000000000A', null]);
  assert.deepEqual([v.messages[1].sceneId, v.messages[1].chapterId], [null, null]);
  assert.deepEqual(validationProblems(v), []);
});

// ------------------------------------------------------------------ explanations

test('explainEpubCheck: plain explanations for the common codes and groups, null for anything else', () => {
  for (const code of ['RSC-001', 'RSC-005', 'RSC-007', 'RSC-008', 'RSC-012', 'OPF-003', 'OPF-049', 'NAV-001', 'NAV-010', 'PKG-003', 'PKG-008', 'HTM-004', 'HTM-025', 'CSS-008', 'CSS-030']) {
    const text = explainEpubCheck(code);
    assert.equal(typeof text, 'string', code);
    assert.ok(text.length > 20 && text.length < 300, code);
  }
  assert.notEqual(explainEpubCheck('RSC-001'), explainEpubCheck('RSC-007'));
  for (const code of ['RSC-999', 'ACC-001', 'MED-002', 'OPF-', '', 'toString', '__proto__', null, undefined, 5]) assert.equal(explainEpubCheck(code), null, String(code));
});

test('toValidation: a failed or cancelled run names the detected validator version', () => {
  const err = toValidation({ run: { ok: false, kind: 'timeout', detail: 'EPUBCheck took too long.' }, artifact: ART, now: NOW, validatorVersion: '5.4.0' });
  assert.deepEqual([err.outcome, err.validatorVersion], ['error', '5.4.0']);
  const off = toValidation({ run: { ok: false, kind: 'unavailable', detail: 'Java was not found.' }, artifact: ART, now: NOW });
  assert.deepEqual([off.outcome, off.validatorVersion], ['unavailable', null]);
  assert.deepEqual(validationProblems(err), []);
  assert.deepEqual(validationProblems(off), []);
});
