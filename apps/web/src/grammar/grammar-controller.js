// Grammar controller (M13-J02 §4, §6): one per open scene editor. Pure and Node-testable: the worker, the timers and the clock are injected.
// It owns the capability state (J01 §4), the pause-then-check schedule with one-follow-up coalescing, discarding of results for an old
// version, and the per-session "ignore this occurrence" list. It never touches the editor text.
import { nextCapability } from '../findings/findings.js';

export const PAUSE_MS = 1200;
const CONTEXT_CHARS = 24;

/**
 * The key of an occurrence: rule, flagged text and up to 24 characters of body either side.
 * @param {{ ruleId: string, original: string, range: { from: number, to: number } }} finding @param {string} body
 */
export function ignoreKey(finding, body) {
  const { from, to } = finding.range;
  return [finding.ruleId, finding.original, body.slice(Math.max(0, from - CONTEXT_CHARS), from), body.slice(to, to + CONTEXT_CHARS)].join('\u0000');
}

/**
 * @typedef {{ state: string, reason: string | null, findings: object[], checkedAt: string | null }} GrammarSnapshot
 * @param {{
 *   sceneId: string,
 *   createWorker: () => { postMessage: (m: object) => void, terminate: () => void, onmessage: any, onerror?: any },
 *   setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void, now: () => number,
 *   onFindings?: (findings: object[]) => void,
 * }} deps
 */
export function createGrammarController({ sceneId, createWorker, setTimeout, clearTimeout, now, onFindings = () => {} }) {
  let state = 'disabled';
  let reason = null;
  let findings = [];
  let checkedAt = null;
  /** @type {GrammarSnapshot} */
  let current = { state, reason, findings, checkedAt };
  const listeners = new Set();

  let worker = null;
  let settings = null;
  let latest = null; // { version, body }
  let timer = null;
  let inFlight = null; // { requestId, version, body }
  let followUp = false;
  let requestCounter = 0;
  let disposed = false;
  let lastRaw = []; // findings from the last used result, before ignore filtering
  let lastBody = '';
  const ignored = new Set();

  const publish = () => {
    current = { state, reason, findings, checkedAt };
    for (const fn of [...listeners]) fn(current);
  };
  const setFindings = (list) => {
    findings = list;
    onFindings(list);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const stopWorker = () => {
    if (worker) {
      try { worker.postMessage({ type: 'dispose' }); } catch { /* the worker is going away anyway */ }
      try { worker.terminate(); } catch { /* ignore */ }
    }
    worker = null;
    inFlight = null;
    followUp = false;
  };
  const visible = (raw, body) => raw.filter((f) => !ignored.has(ignoreKey(f, body)));

  /** Move to `failed` through the legal capability moves, so it never reads as "no problems". */
  const fail = (message) => {
    if (state === 'disabled' || disposed) return;
    let s = state;
    if (s === 'unavailable') s = nextCapability(s, 'restore');
    if (s !== 'running') s = nextCapability(s, 'start');
    state = nextCapability(s, 'fail');
    reason = message;
    inFlight = null;
    followUp = false;
    lastRaw = [];
    setFindings([]);
    publish();
  };

  const runCheck = () => {
    if (disposed || !worker || state === 'disabled' || !latest) return;
    if (inFlight) {
      followUp = true;
      return;
    }
    stopTimer();
    if (state === 'unavailable') state = nextCapability(state, 'restore');
    requestCounter += 1;
    inFlight = { requestId: requestCounter, version: latest.version, body: latest.body };
    state = nextCapability(state, 'start');
    reason = null;
    publish();
    try {
      worker.postMessage({ type: 'check', requestId: inFlight.requestId, sceneId, body: latest.body });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const schedule = () => {
    if (disposed || !worker || state === 'disabled') return;
    stopTimer();
    timer = setTimeout(() => {
      timer = null;
      runCheck();
    }, PAUSE_MS);
  };

  const afterResult = (discarded) => {
    if (followUp) {
      followUp = false;
      runCheck();
    } else if (discarded && timer === null) schedule();
  };

  const onMessage = (event) => {
    const msg = event?.data;
    if (disposed || !msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') return;
    if (msg.type === 'error') return fail(String(msg.message || 'The grammar checker failed.'));
    if (!inFlight || msg.requestId !== inFlight.requestId) return;
    const done = inFlight;
    inFlight = null;
    if (msg.type === 'unsupported') {
      state = nextCapability(state, 'lose');
      reason = String(msg.reason || 'Grammar checks are not available for this scene.');
      lastRaw = [];
      setFindings([]);
      publish();
      return afterResult(false);
    }
    if (msg.type !== 'result') return;
    state = nextCapability(state, 'finish');
    if (!latest || done.version !== latest.version) {
      publish();
      return afterResult(true);
    }
    reason = null;
    lastRaw = Array.isArray(msg.findings) ? msg.findings : [];
    lastBody = done.body;
    checkedAt = new Date(now()).toISOString();
    setFindings(visible(lastRaw, lastBody));
    publish();
    return afterResult(false);
  };

  const onError = (event) => fail(event?.message ? String(event.message) : 'The grammar checker failed.');

  const ensureWorker = () => {
    if (worker) return true;
    try {
      worker = createWorker();
    } catch (err) {
      worker = null;
      fail(err instanceof Error ? err.message : String(err));
      return false;
    }
    worker.onmessage = onMessage;
    worker.onerror = onError;
    return true;
  };

  return {
    /** Apply the book's `checks.grammar` settings. Disabled: no worker is created (an existing one is terminated). */
    configure(next) {
      if (disposed) return;
      settings = next ?? null;
      if (!settings || settings.enabled !== true) {
        stopTimer();
        stopWorker();
        state = nextCapability(state, 'disable');
        reason = null;
        lastRaw = [];
        checkedAt = null;
        setFindings([]);
        publish();
        return;
      }
      if (state === 'disabled') state = nextCapability(state, 'enable');
      if (!ensureWorker()) return;
      try {
        worker.postMessage({ type: 'configure', dialect: settings.dialect ?? 'american', words: settings.words ?? [], rules: settings.rules ?? {} });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      publish();
      if (inFlight) followUp = true;
      else runCheck();
    },
    /** The editor text changed: remember the newest snapshot and restart the pause timer. */
    docChanged(version, body) {
      if (disposed) return;
      latest = { version, body };
      schedule();
    },
    /** The explicit "Check scene" action: no pause. */
    checkNow() {
      if (disposed || state === 'disabled') return;
      runCheck();
    },
    /** Hide this occurrence (rule, text and 24 characters of context either side) for the rest of the session. */
    ignore(finding, body) {
      if (disposed) return;
      ignored.add(ignoreKey(finding, body));
      setFindings(visible(lastRaw, lastBody));
      publish();
    },
    /** `fn({ state, reason, findings, checkedAt })` on every change. Returns an unsubscribe function. Not called on subscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The current `{ state, reason, findings, checkedAt }`; the same object until something changes. */
    snapshot() {
      return current;
    },
    /** Terminate the worker and stop all timers. The controller does nothing afterwards. */
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      stopWorker();
      listeners.clear();
    },
  };
}
