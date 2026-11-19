// The author's own tools (contract M13-J04 section 1): where Java and EPUBCheck are. StoryForge never bundles, downloads or installs them; it only remembers the two paths the author
// gives in Settings (the user config file tools.json, per machine, never in a book) and reports whether they work.
//   saved:      { java: <absolute path to java or java.exe> | null, epubcheckJar: <absolute path to epubcheck.jar> | null }
//   discovery:  tools.json, then STORYFORGE_JAVA / STORYFORGE_EPUBCHECK_JAR, then (Java only) JAVA_HOME/bin/java[.exe], then `java` on PATH. EPUBCheck has no search beyond these.
// The detectors that run `java -version` and `java -jar <jar> --version` live in @storyforge/export (packages/export/src/epubcheck.mjs); they are injectable here for tests.
import path from 'node:path';
import { fileExists } from '@storyforge/core';
import * as exportPackage from '@storyforge/export';
import { readUserConfig, writeUserConfig } from '@storyforge/store';

export const TOOLS_FILE = 'tools.json';
const MAX_PATH_CHARS = 1024;
const NOT_INSTALLED = 'EPUB validation is not available in this build of StoryForge.';

/** @typedef {{ state: 'ready' | 'unavailable', path: string | null, version: string | null, reason: string | null }} ToolStatus */

/** A saved value as the settings file holds it: a non-empty string, else null. @param {unknown} v @returns {string | null} */
const pathOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Why a path may not be saved as `field`, or null when it is fine (an absolute path with the right file name; that it exists is checked by the caller).
 * @param {'java' | 'epubcheckJar'} field @param {string} value
 */
export function pathProblem(field, value) {
  if (value.length > MAX_PATH_CHARS || value.includes('\0')) return `${field} must be a path of at most ${MAX_PATH_CHARS} characters`;
  if (!path.isAbsolute(value)) return `${field} must be an absolute path (the whole path from the drive or the root folder)`;
  const name = path.basename(value).toLowerCase();
  if (field === 'java' && name !== 'java' && name !== 'java.exe') return 'java must be the file named java (or java.exe on Windows)';
  if (field === 'epubcheckJar' && !name.endsWith('.jar')) return 'epubcheckJar must be a file that ends in .jar';
  return null;
}

/**
 * The tools of this process. Every dependency is injectable (`env`, `platform`, `readConfig`, `writeConfig`, `fileExists`, `detectJava`, `detectEpubCheck`); setHooks() replaces them later.
 * @param {Record<string, any>} [options]
 */
export function createTools(options = {}) {
  const hooks = {
    env: options.env ?? null,
    platform: options.platform ?? process.platform,
    readConfig: options.readConfig ?? readUserConfig,
    writeConfig: options.writeConfig ?? writeUserConfig,
    fileExists: options.fileExists ?? fileExists,
    detectJava: options.detectJava ?? null,
    detectEpubCheck: options.detectEpubCheck ?? null,
  };
  const envOf = () => hooks.env ?? process.env;
  /** The package functions are looked up when used, so a build without them answers "unavailable" instead of failing to start. */
  const javaDetector = () => hooks.detectJava ?? /** @type {any} */ (exportPackage).detectJava;
  const epubcheckDetector = () => hooks.detectEpubCheck ?? /** @type {any} */ (exportPackage).detectEpubCheck;

  /** The saved paths: { java, epubcheckJar }, nulls when unset. */
  async function saved() {
    const json = await hooks.readConfig(TOOLS_FILE);
    const ok = json !== null && typeof json === 'object' && !Array.isArray(json);
    return { java: ok ? pathOrNull(json.java) : null, epubcheckJar: ok ? pathOrNull(json.epubcheckJar) : null };
  }

  /** The paths to use now: the saved one, else the environment, else (Java) JAVA_HOME, else `java` on PATH. */
  async function paths() {
    const mine = await saved();
    const env = envOf();
    let java = mine.java ?? pathOrNull(env.STORYFORGE_JAVA);
    if (java === null) {
      const home = pathOrNull(env.JAVA_HOME);
      const candidate = home === null ? null : path.join(home, 'bin', hooks.platform === 'win32' ? 'java.exe' : 'java');
      java = candidate !== null && (await hooks.fileExists(candidate)) ? candidate : 'java';
    }
    return { java, epubcheckJar: mine.epubcheckJar ?? pathOrNull(env.STORYFORGE_EPUBCHECK_JAR) };
  }

  /** What a detector answered, as the four fields the route reports. @param {any} r @param {string | null} fallbackPath @returns {ToolStatus} */
  function normalise(r, fallbackPath) {
    const ready = r?.state === 'ready';
    return { state: ready ? 'ready' : 'unavailable', path: pathOrNull(r?.path) ?? fallbackPath, version: pathOrNull(r?.version), reason: ready ? null : (pathOrNull(r?.reason) ?? 'This tool could not be checked.') };
  }

  /** Run a detector; a detector that throws, or is missing, is "unavailable" with a reason. */
  async function detect(fn, args, fallbackPath) {
    if (typeof fn !== 'function') return { state: /** @type {const} */ ('unavailable'), path: fallbackPath, version: null, reason: NOT_INSTALLED };
    try {
      return normalise(await fn(args), fallbackPath);
    } catch (e) {
      return { state: /** @type {const} */ ('unavailable'), path: fallbackPath, version: null, reason: `The check could not run: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)}` };
    }
  }

  return {
    /** Replace a dependency (tests). @param {Record<string, any>} next */
    setHooks(next) {
      for (const k of Object.keys(hooks)) if (Object.hasOwn(next, k)) /** @type {any} */ (hooks)[k] = next[k];
    },

    /** The saved settings. */
    saved,

    /**
     * Save a change to the settings: only the given fields change (null clears one). The file of each given path must exist (a read-only stat).
     * @param {{ java?: string | null, epubcheckJar?: string | null }} patch @returns {Promise<{ ok: true, tools: { java: string | null, epubcheckJar: string | null } } | { ok: false, message: string }>}
     */
    async save(patch) {
      const next = await saved();
      for (const field of /** @type {const} */ (['java', 'epubcheckJar'])) {
        const v = patch[field];
        if (v === undefined) continue;
        if (v !== null) {
          const problem = pathProblem(field, v);
          if (problem) return { ok: false, message: problem };
          if (!(await hooks.fileExists(v))) return { ok: false, message: `${field}: there is no file at that path` };
        }
        next[field] = v;
      }
      const w = await hooks.writeConfig(TOOLS_FILE, next);
      if (!w.ok) return { ok: false, message: w.message ?? 'the settings could not be saved' };
      return { ok: true, tools: next };
    },

    /** Where Java and the EPUBCheck jar are looked for right now. */
    paths,

    /**
     * Run both detectors: `java -version`, then (only when Java works) `java -jar <jar> --version`. Reports, never installs.
     * @returns {Promise<{ java: ToolStatus, epubcheck: ToolStatus }>}
     */
    async status() {
      const where = await paths();
      const java = await detect(javaDetector(), { javaPath: where.java, env: envOf() }, where.java);
      if (where.epubcheckJar === null) {
        return { java, epubcheck: { state: 'unavailable', path: null, version: null, reason: 'EPUBCheck is not set up. Choose the epubcheck.jar file in Settings.' } };
      }
      if (java.state !== 'ready') {
        return { java, epubcheck: { state: 'unavailable', path: where.epubcheckJar, version: null, reason: 'EPUBCheck cannot be checked until Java works.' } };
      }
      return { java, epubcheck: await detect(epubcheckDetector(), { java: java.path ?? where.java, jarPath: where.epubcheckJar }, where.epubcheckJar) };
    },
  };
}

/** The tools of this server process. */
export const tools = createTools();
