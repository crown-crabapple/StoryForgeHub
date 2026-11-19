// Style checks scans (contract M13-J03 section 7): selected scenes, one chapter or the manuscript, checked one scene at a time in this process.
// A scan is an in-memory job (a reconstructible cache, never saved): it reads scene bodies through the repository, runs the built-in style rules on each, removes
// dismissed findings and keeps the rest. It writes nothing. A finished scan is kept until the next scan of its book or 30 minutes, whichever comes first.
import { randomBytes } from 'node:crypto';
import { crossSceneRepeats, checkStyle, styleFingerprint } from '@storyforge/style';

export const MAX_SCAN_SCENES = 5000;
export const MAX_SCENE_CHARS = 2_000_000;
export const BATCH_SIZE = 25;
export const MAX_SCAN_FINDINGS = 20_000;
export const KEEP_FINISHED_MS = 30 * 60 * 1000;

/** @typedef {{ kind: 'scenes', ids: string[] } | { kind: 'chapter', act: number, chapter: number } | { kind: 'manuscript' }} ScanScope */

/**
 * The scans of this process. `now` (milliseconds) and `yieldFn` (awaited between scenes) are injectable for tests; setHooks() replaces them later.
 * @param {{ now?: () => number, yieldFn?: () => Promise<void>, keepMs?: number }} [options]
 */
export function createStyleScans(options = {}) {
  const hooks = {
    now: options.now ?? (() => Date.now()),
    yieldFn: options.yieldFn ?? (() => new Promise((resolve) => setImmediate(resolve))),
    keepMs: options.keepMs ?? KEEP_FINISHED_MS,
  };
  /** @type {Map<string, any>} */
  const jobs = new Map();

  /** Forget finished scans older than the keep time. */
  function sweep() {
    const t = hooks.now();
    for (const [id, job] of jobs) if (job.state !== 'running' && job.finishedMs !== null && t - job.finishedMs > hooks.keepMs) jobs.delete(id);
  }

  /** @param {any} job @param {'completed' | 'cancelled' | 'failed'} state */
  function finish(job, state) {
    if (job.state !== 'running') return;
    job.state = state;
    job.finishedMs = hooks.now();
    const stale = job.stale;
    if (state !== 'failed') job.staleDismissals = stale.dismissals.filter((d) => stale.scanned.has(d.sceneId) && !stale.seen.has(d.fingerprint)).map((d) => d.slug);
  }

  /** The scenes a scope names, in book order; ids that are not live scenes of the book are reported in `errors`. */
  function pick(live, scope, errors) {
    if (scope.kind === 'manuscript') return live;
    if (scope.kind === 'chapter') return live.filter((s) => s.act === scope.act && s.chapter === scope.chapter);
    const wanted = new Set(scope.ids);
    const picked = live.filter((s) => wanted.has(s.id));
    const have = new Set(picked.map((s) => s.id));
    for (const id of wanted) if (!have.has(id)) errors.push({ sceneId: id, message: 'This is not a scene of the book that can be checked.' });
    return picked;
  }

  async function run(job, repository, settings) {
    const stale = job.stale;
    try {
      const live = await repository.listLiveScenes(job.bookId);
      if (job.state !== 'running') return;
      if (!live.ok) throw new Error('the book was not found');
      let list = pick(live.scenes, job.scope, job.errors);
      if (list.length > MAX_SCAN_SCENES) {
        list = list.slice(0, MAX_SCAN_SCENES);
        job.errors.push({ sceneId: null, message: `Only the first ${MAX_SCAN_SCENES} scenes were checked.` });
      }
      job.total = list.length;
      for (const s of list) job.chapters[s.id] = { act: s.act, chapter: s.chapter, chapterLabel: s.chapterLabel, title: s.title };
      stale.dismissals = await repository.listStyleDismissals(job.bookId);
      if (job.state !== 'running') return;
      const dismissed = new Set(stale.dismissals.map((d) => d.fingerprint));
      const phrases = settings?.rules?.['repeated-phrases']?.enabled === true && list.length > 1;
      /** @type {{ sceneId: string, body: string, sha256: string }[]} */
      const kept = [];

      /** Add one finding unless it is dismissed; every fingerprint seen counts for the stale list. */
      const add = (finding, body, fileSha256) => {
        const fingerprint = styleFingerprint(finding, body);
        stale.seen.add(fingerprint);
        if (dismissed.has(fingerprint)) return;
        if (job.findings.length >= MAX_SCAN_FINDINGS) {
          job.truncated = true;
          return;
        }
        job.findings.push({ ...finding, fingerprint, fileSha256 });
      };

      /** Bodies are read BATCH_SIZE scenes per repository call (each call re-reads the library); cancel and the yield still happen between scenes. */
      let batch = new Map();
      let batchEnd = 0;
      for (const [index, s] of list.entries()) {
        if (job.state !== 'running') return;
        try {
          if (index >= batchEnd) {
            const ids = list.slice(index, index + BATCH_SIZE).map((x) => x.id);
            batchEnd = index + ids.length;
            batch = new Map();
            const r = await repository.getSceneBodies(job.bookId, ids);
            if (r.ok) for (const x of r.scenes ?? []) batch.set(x.id, x);
          }
          if (job.state !== 'running') return;
          const got = batch.get(s.id);
          if (!got) {
            job.errors.push({ sceneId: s.id, message: 'The scene could not be read.' });
          } else if (got.body.length > MAX_SCENE_CHARS) {
            job.errors.push({ sceneId: s.id, message: `The scene is over ${MAX_SCENE_CHARS.toLocaleString('en-US')} characters, so it was skipped.` });
          } else {
            const found = await checkStyle({ sceneId: s.id, body: got.body, settings, sha256: got.sha256 });
            if (job.state !== 'running') return;
            stale.scanned.add(s.id);
            for (const f of found) add(f, got.body, got.sha256);
            if (phrases) kept.push({ sceneId: s.id, body: got.body, sha256: got.sha256 });
          }
        } catch (e) {
          job.errors.push({ sceneId: s.id, message: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300) });
        }
        job.done += 1;
        await hooks.yieldFn();
      }
      if (job.state !== 'running') return;
      if (phrases && kept.length > 1) {
        try {
          const bodies = new Map(kept.map((k) => [k.sceneId, k]));
          for (const f of crossSceneRepeats(kept, settings)) {
            const k = bodies.get(f.sceneId);
            if (k) add(f, k.body, k.sha256);
          }
        } catch (e) {
          job.errors.push({ sceneId: null, message: `The check across scenes failed: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 300)}` });
        }
      }
      finish(job, 'completed');
    } catch (e) {
      if (job.state !== 'running') return;
      job.errors.push({ sceneId: null, message: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300) });
      finish(job, 'failed');
    }
  }

  return {
    /** Replace the clock, the between-scenes yield or the keep time (tests). @param {{ now?: () => number, yieldFn?: () => Promise<void>, keepMs?: number }} next */
    setHooks(next) {
      if (next.now) hooks.now = next.now;
      if (next.yieldFn) hooks.yieldFn = next.yieldFn;
      if (next.keepMs !== undefined) hooks.keepMs = next.keepMs;
    },

    /**
     * Start a scan of `bookId`. One scan runs per book: a second start answers { ok: false, code: 'SCAN_RUNNING', scanId } and starts nothing. The job is registered before anything
     * is awaited, so two starts at once cannot both run. The previous finished scans of the book are dropped.
     * @param {{ repository: any, bookId: string, scope: ScanScope, settings: any }} args
     * @returns {{ ok: true, scanId: string } | { ok: false, code: 'SCAN_RUNNING', scanId: string }}
     */
    start({ repository, bookId, scope, settings }) {
      sweep();
      for (const [id, job] of jobs) {
        if (job.bookId !== bookId) continue;
        if (job.state === 'running') return { ok: false, code: 'SCAN_RUNNING', scanId: id };
      }
      for (const [id, job] of jobs) if (job.bookId === bookId) jobs.delete(id);
      const scanId = `scan_${randomBytes(10).toString('hex')}`;
      const job = {
        bookId, scope, state: 'running', done: 0, total: 0, findings: [], errors: [], truncated: false, startedMs: hooks.now(), finishedMs: null, staleDismissals: [], chapters: {},
        stale: { dismissals: [], scanned: new Set(), seen: new Set() },
      };
      jobs.set(scanId, job);
      void run(job, repository, settings);
      return { ok: true, scanId };
    },

    /** The status of a scan of this book, or null (unknown, another book's, or expired). @param {string} bookId @param {string} scanId @param {number} [from] only the findings with index >= from are listed (findingsTotal counts them all) */
    status(bookId, scanId, from = 0) {
      sweep();
      const job = jobs.get(scanId);
      if (!job || job.bookId !== bookId) return null;
      return {
        state: job.state,
        done: job.done,
        total: job.total,
        findings: from > 0 ? job.findings.slice(from) : job.findings,
        findingsTotal: job.findings.length,
        errors: job.errors,
        truncated: job.truncated,
        startedAt: new Date(job.startedMs).toISOString(),
        finishedAt: job.finishedMs === null ? null : new Date(job.finishedMs).toISOString(),
        staleDismissals: job.staleDismissals,
        chapters: job.chapters,
      };
    },

    /**
     * Stop a running scan before its next scene: the state becomes `cancelled` at once and the findings so far are kept. A scan that already finished is left as it is.
     * @param {string} bookId @param {string} scanId @returns {{ cancelled: boolean, state: string } | null} null for an unknown scan
     */
    cancel(bookId, scanId) {
      sweep();
      const job = jobs.get(scanId);
      if (!job || job.bookId !== bookId) return null;
      if (job.state !== 'running') return { cancelled: false, state: job.state };
      finish(job, 'cancelled');
      return { cancelled: true, state: 'cancelled' };
    },
  };
}

/** The scans of this server process (router.mjs uses `state.styleScans` when a caller supplies its own). */
export const styleScans = createStyleScans();
