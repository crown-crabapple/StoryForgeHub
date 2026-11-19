// EPUBCheck, run locally (M13-J04). The author installs Java and EPUBCheck; this file only finds and runs them, never installs or
// downloads anything. The one place in packages/export that starts a process: an argument array (never a shell), a scrubbed
// environment, a scratch folder that is always removed, hard limits on time and output. The JSON report decides the verdict;
// the exit code is not trusted (EPUBCheck exits 1 for an invalid book and for a usage error alike).
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { outcomeOf, VALIDATION_SCHEMA, VALIDATION_SEVERITIES } from '@storyforge/format';
import { withScratchDir } from '@storyforge/store';

const TESTED_VERSION = '5.4.0';
const SUPPORTED_MAJOR = 5;
const MIN_JAVA = 8;
const PROBE_TIMEOUT_MS = 15000;
const OUTPUT_CAP_BYTES = 256 * 1024;
const REPORT_CAP_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const ENV_KEYS = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'JAVA_HOME'];

/** Only what Java needs to start: PATH, SystemRoot, TEMP/TMP, JAVA_HOME (names matched without regard to case, as Windows does). @param {Record<string, string | undefined>} source */
function filteredEnv(source) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of ENV_KEYS) {
    const hit = Object.keys(source).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit !== undefined && typeof source[hit] === 'string') out[key] = source[hit];
  }
  return out;
}

/**
 * Start one process and gather its capped output. Never rejects. `aborted` / `timedOut` say why it was stopped; `error` is a spawn error.
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, signal: string | null, error: any, timedOut: boolean, aborted: boolean }>}
 */
function collect(spawn, command, args, options, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    const out = { stdout: '', stderr: '', code: null, signal: null, error: null, timedOut: false, aborted: false };
    if (signal?.aborted) {
      out.aborted = true;
      resolve(out);
      return;
    }
    let child;
    try {
      child = spawn(command, args, options);
    } catch (e) {
      out.error = e;
      resolve(out);
      return;
    }
    const chunks = { stdout: /** @type {Buffer[]} */ ([]), stderr: /** @type {Buffer[]} */ ([]) };
    const sizes = { stdout: 0, stderr: 0 };
    const take = (key) => (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = OUTPUT_CAP_BYTES - sizes[key];
      if (room <= 0) return;
      const part = buf.length > room ? buf.subarray(0, room) : buf;
      chunks[key].push(part);
      sizes[key] += part.length;
    };
    child.stdout?.on('data', take('stdout'));
    child.stderr?.on('data', take('stderr'));
    let settled = false;
    /** @type {any} */ let timer;
    /** @type {any} */ let killTimer;
    /** @type {any} */ let retryTimer;
    const onAbort = () => {
      out.aborted = true;
      stop();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(retryTimer);
      signal?.removeEventListener('abort', onAbort);
      out.stdout = Buffer.concat(chunks.stdout).toString('utf8');
      out.stderr = Buffer.concat(chunks.stderr).toString('utf8');
      resolve(out);
    };
    const killTree = () => {
      // On Windows the java.exe found on PATH can be a launcher that starts the real JVM: end the whole tree with taskkill (repeated by `stop`
      // until the process closes; killing only the launcher would leave the JVM running with the scratch folder open).
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: options.env }).on?.('error', () => {
            try {
              child.kill();
            } catch {
              // already gone
            }
          });
          return;
        } catch {
          // fall back to the plain kill below
        }
      }
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killTree();
      // a kill sent while the JVM is still starting can miss part of the tree: repeat until the process has closed
      retryTimer = setInterval(killTree, 400);
      retryTimer.unref?.();
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        finish();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    child.on('error', (e) => {
      out.error = e;
      finish();
    });
    child.on('close', (code, sig) => {
      out.code = code;
      out.signal = sig ?? null;
      finish();
    });
    timer = setTimeout(() => {
      out.timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const spawnOptions = (env, cwd) => ({ ...(cwd ? { cwd } : {}), windowsHide: true, env: filteredEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });

/** @typedef {{ state: 'ready' | 'unavailable', path: string | null, version: string | null, reason: string | null }} ToolStatus */

/** What a failed probe means, in plain words. @param {Awaited<ReturnType<typeof collect>>} r @param {string} what */
function probeFailure(r, what, timeoutMs) {
  if (r.error?.code === 'ENOENT') return `${what} was not found at that location.`;
  if (r.error) return `${what} could not be started (${r.error.code ?? r.error.message}).`;
  if (r.aborted) return `The check for ${what} was cancelled.`;
  if (r.timedOut) return `${what} did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`;
  return null;
}

/**
 * Is there a usable Java (8 or newer)? Runs `java -version` (which prints to stderr).
 * @param {{ javaPath?: string | null, env?: Record<string, string | undefined>, spawn?: typeof nodeSpawn, timeoutMs?: number }} [options] without `javaPath`: JAVA_HOME/bin/java, then `java` on PATH
 * @returns {Promise<ToolStatus>}
 */
export async function detectJava({ javaPath, env = process.env, spawn = nodeSpawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = typeof javaPath === 'string' && javaPath !== '' ? [javaPath] : [...(env.JAVA_HOME ? [path.join(env.JAVA_HOME, 'bin', exe)] : []), 'java'];
  /** @type {ToolStatus | null} */
  let last = null;
  for (const candidate of candidates) {
    const r = await collect(spawn, candidate, ['-version'], spawnOptions(env), { timeoutMs });
    const failure = probeFailure(r, 'Java', timeoutMs);
    if (failure !== null) {
      last = { state: 'unavailable', path: candidate, version: null, reason: failure };
      continue;
    }
    const text = `${r.stderr}\n${r.stdout}`;
    const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
    if (!m) {
      last = { state: 'unavailable', path: candidate, version: null, reason: 'Java did not report a version StoryForge can read.' };
      continue;
    }
    const major = Number(m[1]) === 1 ? Number(m[2] ?? 0) : Number(m[1]);
    const full = /version "([^"]{1,64})"/.exec(text)?.[1] ?? `${m[1]}${m[2] !== undefined ? `.${m[2]}` : ''}`;
    if (major < MIN_JAVA) {
      last = { state: 'unavailable', path: candidate, version: full, reason: `Java ${MIN_JAVA} or newer is required (found ${full}).` };
      continue;
    }
    return { state: 'ready', path: candidate, version: full, reason: null };
  }
  return last ?? { state: 'unavailable', path: null, version: null, reason: 'Java was not found.' };
}

/**
 * Is there a usable EPUBCheck 5? Runs `java -jar <jar> --version`. Another 5.x runs with a note; any other major version is unavailable.
 * @param {{ java?: string | null, jarPath?: string | null, env?: Record<string, string | undefined>, spawn?: typeof nodeSpawn, timeoutMs?: number }} [options]
 * @returns {Promise<ToolStatus>}
 */
export async function detectEpubCheck({ java, jarPath, env = process.env, spawn = nodeSpawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof jarPath !== 'string' || jarPath === '') return { state: 'unavailable', path: null, version: null, reason: 'EPUBCheck is not set up.' };
  if (typeof java !== 'string' || java === '') return { state: 'unavailable', path: jarPath, version: null, reason: 'Java is needed to run EPUBCheck and is not available.' };
  const r = await collect(spawn, java, ['-jar', jarPath, '--version'], spawnOptions(env), { timeoutMs });
  const failure = probeFailure(r, 'Java', timeoutMs);
  if (failure !== null) return { state: 'unavailable', path: jarPath, version: null, reason: failure };
  const m = /EPUBCheck v(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  if (!m) return { state: 'unavailable', path: jarPath, version: null, reason: 'That file did not answer like EPUBCheck. Check the path to epubcheck.jar.' };
  const version = m[1];
  if (Number(version.split('.')[0]) !== SUPPORTED_MAJOR) return { state: 'unavailable', path: jarPath, version, reason: `StoryForge supports EPUBCheck ${SUPPORTED_MAJOR} (found ${version}).` };
  return { state: 'ready', path: jarPath, version, reason: version === TESTED_VERSION ? null : `Tested with ${TESTED_VERSION}.` };
}

/**
 * Check EPUB bytes with EPUBCheck. The bytes go into a private scratch folder as `book.epub`; nothing but fixed flags and the scratch paths is
 * passed to the process. The scratch folder is removed in every case. `name` is not used here (no user text reaches the process); callers give
 * it to toValidation.
 * @param {{ java: string, jar: string, epubBytes: Buffer, name?: string, signal?: AbortSignal, timeoutMs?: number, spawn?: typeof nodeSpawn, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ ok: true, report: any, stdout: string, stderr: string, exitCode: number | null, elapsedMs: number } | { ok: false, kind: 'unavailable' | 'timeout' | 'cancelled' | 'crashed' | 'bad-output', detail: string }>}
 */
export async function runEpubCheck({ java, jar, epubBytes, signal, timeoutMs = 120000, spawn = nodeSpawn, env = process.env }) {
  const fail = (kind, detail) => ({ ok: false, kind, detail });
  if (signal?.aborted) return fail('cancelled', 'The check was cancelled.');
  return withScratchDir('storyforge-epubcheck', async (dir) => {
    await dir.write('book.epub', epubBytes);
    const started = Date.now();
    const args = ['-jar', jar, dir.path('book.epub'), '--json', dir.path('report.json'), '-q'];
    const r = await collect(spawn, java, args, spawnOptions(env, dir.root), { timeoutMs, signal });
    const elapsedMs = Date.now() - started;
    if (r.aborted) return fail('cancelled', 'The check was cancelled.');
    if (r.timedOut) return fail('timeout', `EPUBCheck did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`);
    if (r.error) {
      if (r.error.code === 'ENOENT') return fail('unavailable', 'Java was not found at the saved location.');
      return fail('crashed', `Java could not be started (${r.error.code ?? r.error.message}).`);
    }
    let bytes;
    try {
      bytes = await dir.read('report.json', { maxBytes: REPORT_CAP_BYTES });
    } catch (e) {
      if (e?.code === 'TOO_LARGE') return fail('bad-output', 'EPUBCheck wrote a report larger than 20 MB, which StoryForge does not read.');
      if (r.signal !== null || (r.code !== 0 && r.code !== 1)) return fail('crashed', `EPUBCheck stopped without a report (${r.signal !== null ? `signal ${r.signal}` : `exit code ${r.code}`}).${tail(r.stderr)}`);
      return fail('bad-output', `EPUBCheck did not write a report (exit code ${r.code}).${tail(r.stderr)}`);
    }
    let report;
    try {
      report = JSON.parse(bytes.toString('utf8'));
    } catch {
      return fail('bad-output', 'EPUBCheck wrote a report that is not valid JSON.');
    }
    if (report === null || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.messages)) return fail('bad-output', 'EPUBCheck wrote a report in a shape StoryForge does not know.');
    return { ok: true, report, stdout: r.stdout, stderr: r.stderr, exitCode: r.code, elapsedMs };
  });
}

/** A short, single-line tail of the process's error output for a detail text. @param {string} stderr */
function tail(stderr) {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return line ? ` ${line.slice(0, 200)}` : '';
}

/**
 * Turn a run into a `storyforge.validation/v1` result (M13-J01 section 3). A run that did not reach a verdict is never a pass.
 * Unknown line/column (EPUBCheck's -1) become null. `validatorVersion` is the version the caller detected (detectEpubCheck); a report's own
 * checkerVersion wins when there is one, so a failed or cancelled run still names the validator it tried.
 * @param {{ run: Awaited<ReturnType<typeof runEpubCheck>>, artifact: { sha256: string, name: string }, sourceMap?: ReturnType<typeof import('./epub.mjs').epubSourceMap> | null, now?: () => Date, validatorVersion?: string | null }} options
 */
export function toValidation({ run, artifact, sourceMap = null, now = () => new Date(), validatorVersion = null }) {
  const base = { schema: VALIDATION_SCHEMA, validator: 'epubcheck', artifact: { kind: 'epub', sha256: artifact.sha256, name: artifact.name } };
  const known = typeof validatorVersion === 'string' && validatorVersion !== '' ? validatorVersion.slice(0, 64) : null;
  if (!run.ok) {
    const outcome = run.kind === 'unavailable' ? 'unavailable' : run.kind === 'cancelled' ? 'cancelled' : 'error';
    return { ...base, validatorVersion: outcome === 'unavailable' ? known : known ?? 'unknown', checkedAt: null, outcome, messages: [], report: null, detail: run.detail || 'No reason was given.' };
  }
  const checker = run.report.checker;
  const version = typeof checker?.checkerVersion === 'string' && checker.checkerVersion !== '' ? checker.checkerVersion.slice(0, 64) : known ?? 'unknown';
  const messages = run.report.messages.filter((m) => m !== null && typeof m === 'object').map((m) => toMessage(m, sourceMap));
  return { ...base, validatorVersion: version, checkedAt: now().toISOString(), outcome: outcomeOf(messages), messages, report: null, detail: null };
}

/** @param {any} m an EPUBCheck message @param {Record<string, any> | null} sourceMap */
function toMessage(m, sourceMap) {
  const code = typeof m.ID === 'string' && m.ID !== '' ? m.ID.slice(0, 64) : 'UNKNOWN';
  const lower = typeof m.severity === 'string' ? m.severity.toLowerCase() : '';
  const severity = VALIDATION_SEVERITIES.includes(lower) ? lower : 'warning';
  const locations = Array.isArray(m.locations) ? m.locations.filter((l) => l !== null && typeof l === 'object') : [];
  const first = locations[0];
  const num = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
  const location = first && typeof first.path === 'string' && first.path !== '' ? { path: first.path, line: num(first.line), column: num(first.column) } : null;
  const more = Math.max(0, locations.length - 1) + (Number.isInteger(m.additionalLocations) && m.additionalLocations > 0 ? m.additionalLocations : 0);
  let sceneId = null;
  let chapterId = null;
  const entry = location && sourceMap && Object.hasOwn(sourceMap, location.path) ? sourceMap[location.path] : null;
  if (entry) {
    chapterId = entry.chapterId ?? null;
    if (location.line >= 1) sceneId = entry.scenes.find((s) => location.line >= s.firstLine && location.line <= s.lastLine)?.sceneId ?? null;
  }
  return { code, severity, message: typeof m.message === 'string' && m.message !== '' ? m.message : code, location, sceneId, chapterId, ...(more > 0 ? { more } : {}) };
}

const EXPLAIN_EXACT = {
  'RSC-001': 'A file the book points to is missing from the EPUB. Export the book again; if it keeps happening, a link or image may point at something that is not there.',
  'RSC-005': 'A page in the EPUB does not follow the EPUB rules for its markup. The message says which rule.',
  'RSC-007': 'The book refers to a file (often an image) that is not inside the EPUB.',
  'RSC-008': 'The book refers to a file that is not listed in the EPUB package, so readers may not load it.',
  'RSC-012': 'A link points to a place inside a page that does not exist.',
};
const EXPLAIN_GROUPS = [
  ['OPF-', 'This is about the package file that lists the parts of the book and its details (title, language, reading order).'],
  ['NAV-', 'This is about the table of contents document that reading apps use for navigation.'],
  ['PKG-', 'This is about the EPUB file itself: how it is packed as a zip and which files it contains.'],
  ['HTM-', 'This is about the markup of a chapter page.'],
  ['CSS-', 'This is about the style sheet that sets how the book looks.'],
];

/**
 * A short plain-language explanation of a common EPUBCheck code, or null (then show EPUBCheck's own message).
 * @param {string} code @returns {string | null}
 */
export function explainEpubCheck(code) {
  if (typeof code !== 'string') return null;
  if (Object.hasOwn(EXPLAIN_EXACT, code)) return EXPLAIN_EXACT[code];
  for (const [prefix, text] of EXPLAIN_GROUPS) if (code.startsWith(prefix) && code.length > prefix.length) return text;
  return null;
}
