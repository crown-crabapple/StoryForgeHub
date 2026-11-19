// Style controller (M13-J03 section 6): one per open scene editor, the counterpart of grammar-controller.js. The check runs on the server (POST /checks/style/check), so
// instead of a worker it takes an injected `request({ sceneId, body })` that resolves to `{ findings, state? }` or rejects. Same rules as J02: a pause then one check, one request in
// flight plus one follow-up, results for an old version discarded, a failure is `failed` (never "no problems"). Pure and Node-testable. It never touches the editor text.
import { nextCapability } from '../findings/findings.js';

export const STYLE_PAUSE_MS = 1500;

/**
 * @typedef {{ state: string, reason: string | null, findings: object[], checkedAt: string | null, body: string }} StyleSnapshot
 * @param {{
 *   sceneId: string,
 *   request: (req: { sceneId: string, body: string }) => Promise<{ findings?: object[], state?: string }>,
 *   setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void, now: () => number,
 *   onFindings?: (findings: object[]) => void,
 * }} deps
 */
export function createStyleController({ sceneId, request, setTimeout, clearTimeout, now, onFindings = () => {} }) {
  let state = 'disabled';
  let reason = null;
  let findings = [];
  let checkedAt = null;
  let foundIn = ''; // the text the current findings were found in
  /** @type {StyleSnapshot} */
  let current = { state, reason, findings, checkedAt, body: foundIn };
  const listeners = new Set();

  let enabled = false;
  let latest = null; // { version, body }
  let timer = null;
  let inFlight = null; // { requestId, version, body }
  let followUp = false;
  let requestCounter = 0;
  let disposed = false;

  const publish = () => {
    current = { state, reason, findings, checkedAt, body: foundIn };
    for (const fn of [...listeners]) fn(current);
  };
  const setFindings = (list, body = '') => {
    findings = list;
    foundIn = body;
    onFindings(list);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

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
    setFindings([]);
    publish();
  };

  const runCheck = () => {
    if (disposed || !enabled || !latest) return;
    if (inFlight) {
      followUp = true;
      return;
    }
    stopTimer();
    if (state === 'unavailable') state = nextCapability(state, 'restore');
    requestCounter += 1;
    const mine = { requestId: requestCounter, version: latest.version, body: latest.body };
    inFlight = mine;
    state = nextCapability(state, 'start');
    reason = null;
    publish();
    let pending;
    try {
      pending = Promise.resolve(request({ sceneId, body: mine.body }));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    pending.then(
      (answer) => onResult(mine, answer),
      (err) => {
        if (inFlight !== mine) return;
        fail(err instanceof Error ? err.message : String(err));
      },
    );
    return undefined;
  };

  const schedule = () => {
    if (disposed || !enabled) return;
    stopTimer();
    timer = setTimeout(() => {
      timer = null;
      runCheck();
    }, STYLE_PAUSE_MS);
  };

  const afterResult = (discarded) => {
    if (followUp) {
      followUp = false;
      runCheck();
    } else if (discarded && timer === null) schedule();
  };

  const onResult = (mine, answer) => {
    if (disposed || inFlight !== mine) return;
    inFlight = null;
    if (answer && answer.state === 'disabled') {
      // the book's style checks were turned off meanwhile: nothing to show, nothing more to ask
      enabled = false;
      stopTimer();
      followUp = false;
      state = nextCapability(state, 'disable');
      reason = null;
      checkedAt = null;
      setFindings([]);
      publish();
      return;
    }
    state = nextCapability(state, 'finish');
    if (!latest || mine.version !== latest.version) {
      publish();
      afterResult(true);
      return;
    }
    reason = null;
    checkedAt = new Date(now()).toISOString();
    setFindings(Array.isArray(answer?.findings) ? answer.findings : [], mine.body);
    publish();
    afterResult(false);
  };

  return {
    /** Apply the book's `checks.style` settings. Off: no request is ever made (a pending timer is dropped, a result in flight is ignored). */
    configure(next) {
      if (disposed) return;
      enabled = Boolean(next) && next.enabled === true;
      if (!enabled) {
        stopTimer();
        inFlight = null;
        followUp = false;
        state = nextCapability(state, 'disable');
        reason = null;
        checkedAt = null;
        setFindings([]);
        publish();
        return;
      }
      if (state === 'disabled') state = nextCapability(state, 'enable');
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
    /** The explicit check, or a re-check after a dismissal: no pause. */
    checkNow() {
      if (disposed || !enabled) return;
      runCheck();
    },
    /** `fn({ state, reason, findings, checkedAt, body })` on every change. Returns an unsubscribe function. Not called on subscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The current snapshot; the same object until something changes. */
    snapshot() {
      return current;
    },
    /** Stop all timers; a request in flight is ignored when it answers. The controller does nothing afterwards. */
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      inFlight = null;
      listeners.clear();
    },
  };
}
