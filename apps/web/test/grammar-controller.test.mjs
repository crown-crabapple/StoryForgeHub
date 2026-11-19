// Grammar controller (M13-J02 §4, §6, §8) with a fake worker and fake timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrammarController, ignoreKey, PAUSE_MS } from '../src/grammar/grammar-controller.js';

const SCENE = 'scene_01HZX0000000000000000000AA';
const ON = { enabled: true, language: 'en', dialect: 'british', words: ['Mara'], rules: { SpellCheck: false } };

function fakeTimers() {
  let t = 0;
  let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, at: t + ms }); return id; },
    clearTimeout: (h) => { pending.delete(h); },
    advance(ms) {
      t += ms;
      for (const [h, e] of [...pending]) if (e.at <= t) { pending.delete(h); e.fn(); }
    },
    get pending() { return pending.size; },
  };
}

function setup({ throwOnCreate = null } = {}) {
  const timers = fakeTimers();
  const workers = [];
  const emitted = [];
  const controller = createGrammarController({
    sceneId: SCENE,
    createWorker: () => {
      if (throwOnCreate) throw throwOnCreate;
      const w = { sent: [], terminated: false, onmessage: null, onerror: null, postMessage(m) { this.sent.push(m); }, terminate() { this.terminated = true; } };
      workers.push(w);
      return w;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    onFindings: (list) => emitted.push(list),
  });
  const checks = () => workers[0].sent.filter((m) => m.type === 'check');
  const reply = (msg) => workers[0].onmessage({ data: msg });
  return { controller, timers, workers, emitted, checks, reply };
}

function finding(body, word, ruleId = 'SpellCheck') {
  const from = body.indexOf(word);
  return { id: `fnd_${String(from).padStart(16, '0')}`, ruleId, original: word, range: { from, to: from + word.length }, replacements: [] };
}

test('disabled creates no worker and never checks', () => {
  const { controller, timers, workers } = setup();
  assert.equal(controller.snapshot().state, 'disabled');
  controller.configure({ enabled: false });
  controller.docChanged(1, 'Some text here.');
  controller.checkNow();
  timers.advance(5000);
  assert.equal(workers.length, 0);
  assert.equal(controller.snapshot().state, 'disabled');
  assert.equal(timers.pending, 0);
});

test('configure sends dialect, words and rules; state is ready', () => {
  const { controller, workers } = setup();
  controller.configure(ON);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent, [{ type: 'configure', dialect: 'british', words: ['Mara'], rules: { SpellCheck: false } }]);
  assert.equal(controller.snapshot().state, 'ready');
});

test('a pause then exactly one check; the result completes with a timestamp', () => {
  const { controller, timers, checks, reply, emitted } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS - 1);
  assert.equal(checks().length, 0);
  timers.advance(1);
  assert.equal(checks().length, 1);
  assert.deepEqual(checks()[0], { type: 'check', requestId: checks()[0].requestId, sceneId: SCENE, body: 'Teh cat.' });
  assert.equal(controller.snapshot().state, 'running');
  const f = finding('Teh cat.', 'Teh');
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [f] });
  const snap = controller.snapshot();
  assert.equal(snap.state, 'completed');
  assert.deepEqual(snap.findings, [f]);
  assert.equal(snap.checkedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(emitted.at(-1), [f]);
  timers.advance(10000);
  assert.equal(checks().length, 1);
});

test('subscribers get every change and can unsubscribe', () => {
  const { controller, timers, checks, reply } = setup();
  const seen = [];
  const off = controller.subscribe((s) => seen.push(s.state));
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [] });
  assert.deepEqual(seen, ['ready', 'running', 'completed']);
  off();
  controller.checkNow();
  assert.equal(seen.length, 3);
});

test('rapid edits restart the pause and coalesce to one check', () => {
  const { controller, timers, checks } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'a');
  timers.advance(1000);
  controller.docChanged(2, 'ab');
  timers.advance(1000);
  controller.docChanged(3, 'abc');
  timers.advance(1199);
  assert.equal(checks().length, 0);
  timers.advance(1);
  assert.equal(checks().length, 1);
  assert.equal(checks()[0].body, 'abc');
});

test('edits during a check give exactly one follow-up with the newest snapshot', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'one');
  timers.advance(PAUSE_MS);
  assert.equal(checks().length, 1);
  controller.docChanged(2, 'two');
  timers.advance(PAUSE_MS); // fires while the first is in flight: marks a follow-up, sends nothing
  controller.docChanged(3, 'three');
  timers.advance(PAUSE_MS); // again: still just one follow-up
  assert.equal(checks().length, 1);
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [finding('one', 'one')] });
  assert.equal(checks().length, 2);
  assert.equal(checks()[1].body, 'three');
  assert.equal(controller.snapshot().state, 'running');
  reply({ type: 'result', requestId: checks()[1].requestId, findings: [] });
  assert.equal(controller.snapshot().state, 'completed');
  timers.advance(10000);
  assert.equal(checks().length, 2);
});

test('a result for an old version is discarded and a fresh check is scheduled', () => {
  const { controller, timers, checks, reply, emitted } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  controller.docChanged(2, 'Teh cats.'); // timer pending, not yet fired
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [finding('Teh cat.', 'Teh')] });
  assert.deepEqual(controller.snapshot().findings, []);
  assert.equal(emitted.length, 0, 'nothing from the old version reaches the editor');
  assert.notEqual(controller.snapshot().state, 'running');
  timers.advance(PAUSE_MS);
  assert.equal(checks().length, 2);
  assert.equal(checks()[1].body, 'Teh cats.');
});

test('a discarded result with no timer pending still schedules a fresh check', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  controller.docChanged(2, 'Teh cats.');
  timers.advance(PAUSE_MS); // follow-up flagged
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [finding('Teh cat.', 'Teh')] });
  assert.equal(checks().length, 2);
  assert.equal(checks()[1].body, 'Teh cats.');
  assert.deepEqual(controller.snapshot().findings, []);
});

test('checkNow runs without the pause and coalesces while running', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  controller.checkNow();
  assert.equal(checks().length, 1);
  assert.equal(timers.pending, 0);
  controller.checkNow();
  assert.equal(checks().length, 1);
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [] });
  assert.equal(checks().length, 2);
});

test('configure again re-sends settings and re-checks the current text', () => {
  const { controller, workers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  controller.checkNow();
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [] });
  controller.configure({ ...ON, words: ['Mara', 'Kestrel'] });
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent.filter((m) => m.type === 'configure').at(-1).words, ['Mara', 'Kestrel']);
  assert.equal(checks().length, 2);
});

test('ignore keys hide repeats of the same occurrence only', () => {
  const body = 'Mara met Kestral at dawn. Later Kestral left.';
  const first = finding(body, 'Kestral');
  const second = { ...finding(body, 'Kestral'), range: { from: body.lastIndexOf('Kestral'), to: body.lastIndexOf('Kestral') + 7 } };
  second.id = 'fnd_0000000000000099';
  assert.notEqual(ignoreKey(first, body), ignoreKey(second, body));
  assert.equal(ignoreKey(first, body), ['SpellCheck', 'Kestral', 'Mara met ', ' at dawn. Later Kestral '].join(' '));

  const { controller, timers, checks, reply, emitted } = setup();
  controller.configure(ON);
  controller.docChanged(1, body);
  timers.advance(PAUSE_MS);
  reply({ type: 'result', requestId: checks()[0].requestId, findings: [first, second] });
  assert.equal(controller.snapshot().findings.length, 2);
  controller.ignore(first, body);
  assert.deepEqual(controller.snapshot().findings, [second]);
  assert.deepEqual(emitted.at(-1), [second]);

  // A later check yields the same two findings: the ignored one stays hidden.
  controller.docChanged(2, body);
  timers.advance(PAUSE_MS);
  reply({ type: 'result', requestId: checks()[1].requestId, findings: [first, second] });
  assert.deepEqual(controller.snapshot().findings, [second]);
});

test('ignore key uses 24 characters of context either side', () => {
  const body = `${'a'.repeat(40)} word ${'b'.repeat(40)}`;
  const f = finding(body, 'word');
  const key = ignoreKey(f, body);
  assert.equal(key, ['SpellCheck', 'word', `${'a'.repeat(23)} `, ` ${'b'.repeat(23)}`].join('\u0000'));
  const far = `x${'a'.repeat(39)} word ${'b'.repeat(39)}y`;
  assert.equal(ignoreKey(finding(far, 'word'), far), key);
});

test('a worker error message gives failed with the message, never completed', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  reply({ type: 'error', requestId: checks()[0].requestId, message: 'WASM did not load' });
  const snap = controller.snapshot();
  assert.equal(snap.state, 'failed');
  assert.equal(snap.reason, 'WASM did not load');
  assert.deepEqual(snap.findings, []);
});

test('a worker error event gives failed', () => {
  const { controller, workers } = setup();
  controller.configure(ON);
  workers[0].onerror({ message: 'script failed' });
  assert.equal(controller.snapshot().state, 'failed');
  assert.equal(controller.snapshot().reason, 'script failed');
});

test('a createWorker that throws gives failed with its message', () => {
  const { controller } = setup({ throwOnCreate: new Error('Workers are not supported') });
  controller.configure(ON);
  const snap = controller.snapshot();
  assert.equal(snap.state, 'failed');
  assert.equal(snap.reason, 'Workers are not supported');
});

test('failed can be retried by the next check', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  reply({ type: 'error', requestId: checks()[0].requestId, message: 'boom' });
  controller.checkNow();
  assert.equal(controller.snapshot().state, 'running');
  reply({ type: 'result', requestId: checks()[1].requestId, findings: [] });
  assert.equal(controller.snapshot().state, 'completed');
});

test('unsupported gives unavailable with the reason and no findings', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Ceci est un texte.');
  timers.advance(PAUSE_MS);
  const reason = 'This scene does not look like English. Grammar checks support English only.';
  reply({ type: 'unsupported', requestId: checks()[0].requestId, reason });
  const snap = controller.snapshot();
  assert.equal(snap.state, 'unavailable');
  assert.equal(snap.reason, reason);
  assert.deepEqual(snap.findings, []);
  // A later edit can check again.
  controller.docChanged(2, 'This is English now.');
  timers.advance(PAUSE_MS);
  assert.equal(checks().length, 2);
  assert.equal(controller.snapshot().state, 'running');
});

test('turning grammar off terminates the worker and clears findings', () => {
  const { controller, workers, emitted, timers } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  controller.configure({ ...ON, enabled: false });
  assert.equal(workers[0].terminated, true);
  assert.equal(controller.snapshot().state, 'disabled');
  assert.deepEqual(emitted.at(-1), []);
  timers.advance(10000);
  assert.equal(workers[0].sent.filter((m) => m.type === 'check').length, 0);
});

test('results from a stale request id are ignored', () => {
  const { controller, timers, checks, reply } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  timers.advance(PAUSE_MS);
  reply({ type: 'result', requestId: checks()[0].requestId + 50, findings: [finding('Teh cat.', 'Teh')] });
  assert.equal(controller.snapshot().state, 'running');
  assert.deepEqual(controller.snapshot().findings, []);
});

test('dispose terminates the worker, stops timers and ignores later calls', () => {
  const { controller, workers, timers } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'Teh cat.');
  controller.dispose();
  assert.equal(workers[0].terminated, true);
  assert.equal(timers.pending, 0);
  controller.docChanged(2, 'x');
  controller.checkNow();
  timers.advance(10000);
  assert.equal(workers[0].sent.filter((m) => m.type === 'check').length, 0);
});
