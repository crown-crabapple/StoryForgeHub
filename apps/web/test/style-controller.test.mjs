// Style controller (M13-J03 section 6) with a fake request and fake timers: pause, coalescing, old results discarded, off means no requests, errors mean failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STYLE_PAUSE_MS, createStyleController } from '../src/grammar/style-controller.js';

const SCENE = 'scene_01HZX0000000000000000000AA';
const ON = { enabled: true, rules: {} };

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

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const timers = fakeTimers();
  const calls = [];
  const emitted = [];
  const request = (req) => new Promise((resolve, reject) => calls.push({ req, resolve, reject }));
  const controller = createStyleController({
    sceneId: SCENE,
    request,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    onFindings: (list) => emitted.push(list),
  });
  return { controller, timers, calls, emitted };
}

function finding(body, word, ruleId = 'repeated-words') {
  const from = body.indexOf(word);
  return { id: `fnd_${String(from).padStart(16, '0')}`, ruleId, original: word, range: { from, to: from + word.length }, replacements: [] };
}

test('the pause is 1,500 ms', () => {
  assert.equal(STYLE_PAUSE_MS, 1500);
});

test('off: no request is ever made, whatever happens', async () => {
  const { controller, timers, calls } = setup();
  assert.equal(controller.snapshot().state, 'disabled');
  controller.configure({ enabled: false });
  controller.docChanged(1, 'Some text here.');
  controller.checkNow();
  timers.advance(10000);
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().state, 'disabled');
  assert.equal(timers.pending, 0);
  controller.configure(null);
  assert.equal(calls.length, 0);
});

test('configure on checks at once with the latest text; the request carries the scene id and the body', async () => {
  const { controller, calls } = setup();
  controller.docChanged(1, 'The the cat.');
  controller.configure(ON);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].req, { sceneId: SCENE, body: 'The the cat.' });
  assert.equal(controller.snapshot().state, 'running');
});

test('a pause then exactly one check; the result completes with a timestamp and the body it came from', async () => {
  const { controller, timers, calls, emitted } = setup();
  controller.configure(ON);
  assert.equal(controller.snapshot().state, 'ready', 'nothing to check yet');
  controller.docChanged(1, 'The the cat.');
  timers.advance(STYLE_PAUSE_MS - 1);
  assert.equal(calls.length, 0);
  timers.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().state, 'running');
  const found = [finding('The the cat.', 'The the')];
  calls[0].resolve({ findings: found });
  await tick();
  const s = controller.snapshot();
  assert.equal(s.state, 'completed');
  assert.equal(s.checkedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(s.findings, found);
  assert.equal(s.body, 'The the cat.');
  assert.deepEqual(emitted.at(-1), found);
});

test('typing restarts the pause: only the newest text is checked', () => {
  const { controller, timers, calls } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'a');
  timers.advance(1000);
  controller.docChanged(2, 'ab');
  timers.advance(1000);
  assert.equal(calls.length, 0);
  timers.advance(500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req.body, 'ab');
});

test('coalescing: a change while a request is in flight causes exactly one follow-up with the newest text', async () => {
  const { controller, timers, calls } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'one');
  timers.advance(STYLE_PAUSE_MS);
  assert.equal(calls.length, 1);
  controller.docChanged(2, 'two');
  timers.advance(STYLE_PAUSE_MS);
  controller.docChanged(3, 'three');
  timers.advance(STYLE_PAUSE_MS);
  assert.equal(calls.length, 1, 'still one request in flight');
  calls[0].resolve({ findings: [] });
  await tick();
  assert.equal(calls.length, 2, 'exactly one follow-up');
  assert.equal(calls[1].req.body, 'three');
  calls[1].resolve({ findings: [] });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(controller.snapshot().state, 'completed');
});

test('a result for an old version is discarded and a fresh check is scheduled', async () => {
  const { controller, timers, calls, emitted } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'The the cat.');
  timers.advance(STYLE_PAUSE_MS);
  controller.docChanged(2, 'The cat.');
  calls[0].resolve({ findings: [finding('The the cat.', 'The the')] });
  await tick();
  // the follow-up flag from the change during flight runs one more check straight away with the newest text
  assert.equal(emitted.filter((l) => l.length > 0).length, 0, 'the old result never reached the editor');
  const next = calls.length === 2 ? calls[1] : null;
  if (next) {
    assert.equal(next.req.body, 'The cat.');
  } else {
    timers.advance(STYLE_PAUSE_MS);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].req.body, 'The cat.');
  }
});

test('an old result with no change in flight is discarded and the check is scheduled again', async () => {
  const { controller, timers, calls, emitted } = setup();
  controller.configure(ON);
  controller.docChanged(1, 'old');
  controller.checkNow();
  assert.equal(calls.length, 1);
  // a change arrives; the pause timer starts, the follow-up flag is not set because the timer has not fired
  controller.docChanged(2, 'new');
  calls[0].resolve({ findings: [finding('old', 'old')] });
  await tick();
  assert.equal(emitted.filter((l) => l.length > 0).length, 0);
  assert.equal(calls.length, 1);
  timers.advance(STYLE_PAUSE_MS);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].req.body, 'new');
});

test('a failed request is failed with the message, never "no problems"; the next check recovers', async () => {
  const { controller, calls, emitted } = setup();
  controller.docChanged(1, 'text');
  controller.configure(ON);
  calls[0].reject(new Error('The style check was refused (500).'));
  await tick();
  let s = controller.snapshot();
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'The style check was refused (500).');
  assert.deepEqual(s.findings, []);
  assert.deepEqual(emitted.at(-1), []);
  controller.checkNow();
  assert.equal(controller.snapshot().state, 'running');
  calls[1].resolve({ findings: [] });
  await tick();
  s = controller.snapshot();
  assert.equal(s.state, 'completed');
  assert.equal(s.reason, null);
});

test('the server saying style checks are off moves to disabled and stops asking', async () => {
  const { controller, timers, calls } = setup();
  controller.docChanged(1, 'text');
  controller.configure(ON);
  calls[0].resolve({ findings: [], state: 'disabled' });
  await tick();
  assert.equal(controller.snapshot().state, 'disabled');
  controller.docChanged(2, 'more');
  timers.advance(10000);
  assert.equal(calls.length, 1);
});

test('turning off while a request is in flight ignores its answer; turning on again checks', async () => {
  const { controller, calls, emitted } = setup();
  controller.docChanged(1, 'text');
  controller.configure(ON);
  controller.configure({ enabled: false });
  calls[0].resolve({ findings: [finding('text', 'text')] });
  await tick();
  assert.equal(controller.snapshot().state, 'disabled');
  assert.equal(emitted.filter((l) => l.length > 0).length, 0);
  controller.configure(ON);
  assert.equal(calls.length, 2);
});

test('subscribe is called on changes (not on subscribe); dispose stops everything', async () => {
  const { controller, timers, calls } = setup();
  const seen = [];
  const off = controller.subscribe((snap) => seen.push(snap.state));
  assert.deepEqual(seen, []);
  controller.configure(ON);
  assert.deepEqual(seen, ['ready']);
  off();
  controller.docChanged(1, 'x');
  controller.dispose();
  timers.advance(10000);
  controller.checkNow();
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(timers.pending, 0);
});
