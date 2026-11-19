// EPUB validation jobs (contract M13-J04 section 4), modelled on the style scans (style-scans.mjs): an in-memory job per book, kept until the next validation of that book or 30
// minutes. A job holds the exact EPUB bytes that were built and checked (an immutable snapshot of the manuscript at that moment), the validation result, and EPUBCheck's own report.
// It never writes into the book. Java and EPUBCheck are the author's own installs (tools.mjs); with either missing the job completes at once with outcome `unavailable`.
// The runner and the mappers come from @storyforge/export (packages/export/src/epubcheck.mjs) and are injectable for tests.
import { createHash, randomBytes } from 'node:crypto';
import * as exportPackage from '@storyforge/export';
import { tools as defaultTools } from './tools.mjs';

export const KEEP_FINISHED_MS = 30 * 60 * 1000;
/** The name the EPUB has inside the scratch folder (the only name any process argument carries). */
export const SCRATCH_NAME = 'book.epub';
const CANCELLED = 'You stopped the check before it finished.';

/** @typedef {{ bytes: Buffer, filename: string }} EpubFile */

/**
 * The validations of this process. `now` (milliseconds), `keepMs`, `tools` and the four mappers/runners are injectable; setHooks() replaces them later.
 * @param {Record<string, any>} [options] now, keepMs, tools, runEpubCheck, toValidation, explainEpubCheck
 */
export function createEpubValidations(options = {}) {
  const hooks = {
    now: options.now ?? (() => Date.now()),
    keepMs: options.keepMs ?? KEEP_FINISHED_MS,
    tools: options.tools ?? defaultTools,
    runEpubCheck: options.runEpubCheck ?? null,
    toValidation: options.toValidation ?? null,
    explainEpubCheck: options.explainEpubCheck ?? null,
  };
  // the package functions are looked up when used (a build without them fails the job with a reason instead of failing to start)
  const pkg = /** @type {any} */ (exportPackage);
  const runner = () => hooks.runEpubCheck ?? pkg.runEpubCheck;
  const mapper = () => hooks.toValidation ?? pkg.toValidation;
  const explainer = () => hooks.explainEpubCheck ?? pkg.explainEpubCheck;

  /** @type {Map<string, any>} */
  const jobs = new Map();

  /** Forget finished jobs older than the keep time. */
  function sweep() {
    const t = hooks.now();
    for (const [id, job] of jobs) if (job.state !== 'running' && job.finishedMs !== null && t - job.finishedMs > hooks.keepMs) jobs.delete(id);
  }

  /** @param {any} job @param {'completed' | 'cancelled' | 'failed'} state */
  function finish(job, state) {
    if (job.state !== 'running') return;
    job.state = state;
    job.finishedMs = hooks.now();
  }

  /** The validation result for a run that did not produce a report, or one that did. Never a pass for a failed run. @param {any} job @param {any} run */
  function resultOf(job, run) {
    return mapper()({ run, artifact: job.artifact, sourceMap: job.sourceMap, ...(job.validatorVersion ? { validatorVersion: job.validatorVersion } : {}) });
  }

  /** Plain explanations for the codes of the result's messages. @param {any} result */
  function explanationsOf(result) {
    /** @type {Record<string, string>} */
    const out = {};
    const explain = explainer();
    if (typeof explain !== 'function') return out;
    for (const m of result?.messages ?? []) {
      if (Object.hasOwn(out, m.code)) continue;
      try {
        const text = explain(m.code);
        if (typeof text === 'string' && text !== '') out[m.code] = text;
      } catch {
        // an explanation is a nicety; the message itself is always shown
      }
    }
    return out;
  }

  /** The scene titles and chapter names the result's links need. @param {any} job @param {any} repository @param {any} result */
  async function sourcesOf(job, repository, result) {
    /** @type {Record<string, { title: string, chapterLabel: string }>} */
    const sources = {};
    /** @type {Record<string, { chapterLabel: string, sceneId: string | null }>} */
    const chapters = {};
    const sceneIds = new Set();
    for (const m of result?.messages ?? []) {
      if (typeof m.sceneId === 'string') sceneIds.add(m.sceneId);
      else if (typeof m.chapterId === 'string' && !Object.hasOwn(chapters, m.chapterId)) {
        const entry = Object.values(job.sourceMap ?? {}).find((/** @type {any} */ c) => c?.chapterId === m.chapterId);
        chapters[m.chapterId] = { chapterLabel: String(entry?.chapterLabel ?? ''), sceneId: entry?.scenes?.[0]?.sceneId ?? null };
      }
    }
    for (const c of Object.values(chapters)) if (c.sceneId !== null) sceneIds.add(c.sceneId);
    if (sceneIds.size > 0) {
      try {
        const live = await repository.listLiveScenes(job.bookId);
        if (live?.ok) for (const s of live.scenes) if (sceneIds.has(s.id)) sources[s.id] = { title: String(s.title ?? ''), chapterLabel: String(s.chapterLabel ?? '') };
      } catch {
        // the links still work without titles
      }
    }
    return { sources, chapters };
  }

  /** Run the check for one job: find the tools, run EPUBCheck on the stored bytes, map the report. @param {any} job @param {any} repository */
  async function run(job, repository) {
    try {
      const found = await hooks.tools.status();
      if (job.state !== 'running') return;
      job.validatorVersion = found.epubcheck.version ?? null; // the detected EPUBCheck version, so an error or cancelled result still names it
      /** @type {any} */
      let result;
      if (found.java.state !== 'ready' || found.epubcheck.state !== 'ready') {
        const why = found.java.state !== 'ready' ? found.java.reason : found.epubcheck.reason;
        result = resultOf(job, { ok: false, kind: 'unavailable', detail: why ?? 'Java or EPUBCheck is not set up.' });
      } else {
        const ran = await runner()({ java: found.java.path, jar: found.epubcheck.path, epubBytes: job.bytes, name: SCRATCH_NAME, signal: job.controller.signal });
        if (job.state !== 'running') return;
        job.checker = ran?.ok === true ? (ran.report?.checker ?? null) : null;
        result = resultOf(job, ran);
      }
      if (job.state !== 'running') return;
      job.result = result;
      job.explanations = explanationsOf(result);
      Object.assign(job, await sourcesOf(job, repository, result));
      if (job.state !== 'running') return;
      finish(job, result?.outcome === 'error' ? 'failed' : result?.outcome === 'cancelled' ? 'cancelled' : 'completed');
    } catch (e) {
      if (job.state !== 'running') return;
      const detail = `The check could not run: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 300)}`;
      try {
        job.result = resultOf(job, { ok: false, kind: 'crashed', detail });
      } catch {
        job.result = null;
      }
      job.detail = detail;
      finish(job, 'failed');
    }
  }

  return {
    /** Replace the clock, the keep time, the tools or a runner/mapper (tests). @param {Record<string, any>} next */
    setHooks(next) {
      for (const k of Object.keys(hooks)) if (Object.hasOwn(next, k) && next[k] !== undefined) /** @type {any} */ (hooks)[k] = next[k];
    },

    /** The id of the validation of this book that is running now, or null. @param {string} bookId */
    running(bookId) {
      sweep();
      for (const [id, job] of jobs) if (job.bookId === bookId && job.state === 'running') return id;
      return null;
    },

    /**
     * Start checking `file` (the EPUB just built from the book). One validation runs per book: a second start answers { ok: false, code: 'VALIDATION_RUNNING', validationId } and starts
     * nothing. The job is registered before anything is awaited. The earlier finished validations of the book are dropped (a result is never reused for different bytes).
     * @param {{ repository: any, bookId: string, file: EpubFile, sourceMap: Record<string, any> }} args
     * @returns {{ ok: true, validationId: string } | { ok: false, code: 'VALIDATION_RUNNING', validationId: string }}
     */
    start({ repository, bookId, file, sourceMap }) {
      sweep();
      const busy = this.running(bookId);
      if (busy !== null) return { ok: false, code: 'VALIDATION_RUNNING', validationId: busy };
      for (const [id, job] of jobs) if (job.bookId === bookId) jobs.delete(id);
      const validationId = `val_${randomBytes(10).toString('hex')}`;
      const job = {
        bookId, state: 'running', result: null, explanations: {}, sources: {}, chapters: {}, detail: null, checker: null, validatorVersion: null, sourceMap: sourceMap ?? {},
        filename: file.filename, bytes: file.bytes, controller: new AbortController(), startedMs: hooks.now(), finishedMs: null,
        artifact: { kind: 'epub', sha256: createHash('sha256').update(file.bytes).digest('hex'), name: file.filename },
      };
      jobs.set(validationId, job);
      void run(job, repository);
      return { ok: true, validationId };
    },

    /** The status of a validation of this book, or null (unknown, another book's, or expired). @param {string} bookId @param {string} id */
    status(bookId, id) {
      sweep();
      const job = jobs.get(id);
      if (!job || job.bookId !== bookId) return null;
      return { state: job.state, result: job.result, explanations: job.explanations, sources: job.sources, chapters: job.chapters, filename: job.filename };
    },

    /**
     * Stop a running validation: the process is killed (its scratch folder removed by the runner), the state becomes `cancelled` at once and the result's outcome is `cancelled`.
     * A validation that already finished is left as it is. @param {string} bookId @param {string} id
     * @returns {{ cancelled: boolean, state: string } | null} null for an unknown validation
     */
    cancel(bookId, id) {
      sweep();
      const job = jobs.get(id);
      if (!job || job.bookId !== bookId) return null;
      if (job.state !== 'running') return { cancelled: false, state: job.state };
      job.controller.abort();
      try {
        job.result = resultOf(job, { ok: false, kind: 'cancelled', detail: CANCELLED });
      } catch {
        job.result = null;
      }
      job.detail = CANCELLED;
      finish(job, 'cancelled');
      return { cancelled: true, state: 'cancelled' };
    },

    /** The exact EPUB bytes that were checked, whatever the outcome, or null. @param {string} bookId @param {string} id @returns {{ bytes: Buffer, filename: string } | null} */
    file(bookId, id) {
      sweep();
      const job = jobs.get(id);
      return !job || job.bookId !== bookId ? null : { bytes: job.bytes, filename: job.filename };
    },

    /**
     * The downloadable report: the validation result, the explanations and EPUBCheck's own `checker` block, as JSON. Null for an unknown validation; `{ running: true }` while it runs.
     * @param {string} bookId @param {string} id @returns {{ running: true } | { filename: string, bytes: Buffer } | null}
     */
    report(bookId, id) {
      sweep();
      const job = jobs.get(id);
      if (!job || job.bookId !== bookId) return null;
      if (job.state === 'running') return { running: true };
      const text = `${JSON.stringify({ result: job.result, explanations: job.explanations, checker: job.checker }, null, 2)}\n`;
      return { filename: `${job.filename.replace(/\.epub$/i, '')}-epubcheck-report.json`, bytes: Buffer.from(text, 'utf8') };
    },
  };
}

/** The validations of this server process (router.mjs uses `state.epubValidations` when a caller supplies its own). */
export const epubValidations = createEpubValidations();
