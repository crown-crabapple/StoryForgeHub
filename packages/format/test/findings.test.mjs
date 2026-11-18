// M13-J01: the finding contract, the validation result contract and capability states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDING_SCHEMA, VALIDATION_SCHEMA, FINDING_CATEGORIES, FINDING_SEVERITIES, VALIDATION_OUTCOMES, VALIDATION_SEVERITIES,
  CAPABILITY_STATES, CAPABILITY_EVENTS, findingId, findingProblems, findingMatches, validationProblems, outcomeOf,
  isCleanValidation, nextCapability, mayShowClean,
} from '../src/index.mjs';

const BODY = 'She walked to the the market.\nIt was late.';
const SHA = 'a'.repeat(64);
const SCENE = 'scene_01HZX3K9M2N4P6Q8R0S1T2V3W4';

function finding(over = {}) {
  const base = {
    schema: FINDING_SCHEMA,
    engine: 'sample',
    engineVersion: '1.0.0',
    ruleId: 'repeated-word',
    category: 'repetition',
    severity: 'warning',
    advisory: false,
    message: 'The word "the" is repeated.',
    sceneId: SCENE,
    source: { sha256: SHA, length: BODY.length },
    range: { from: 14, to: 21 },
    original: 'the the',
    replacements: ['the'],
    ...over,
  };
  if (!over.id) base.id = findingId(base);
  return base;
}
const fields = (f) => findingProblems(f).map((p) => p.field);

test('a valid finding has no problems; the sample matches the body', () => {
  assert.equal(BODY.slice(14, 21), 'the the');
  assert.deepEqual(findingProblems(finding()), []);
  assert.deepEqual(findingProblems(finding({ replacements: [] })), []);
  assert.deepEqual(findingProblems(finding({ replacements: [''] })), [], 'an empty replacement deletes');
  assert.deepEqual(findingProblems(finding({ advisory: true, category: 'style', severity: 'info' })), []);
});

test('every category and severity is accepted, others are refused', () => {
  for (const category of FINDING_CATEGORIES) assert.deepEqual(findingProblems(finding({ category })), []);
  for (const severity of FINDING_SEVERITIES) assert.deepEqual(findingProblems(finding({ severity })), []);
  assert.deepEqual(fields(finding({ category: 'tone' })), ['category']);
  assert.deepEqual(fields(finding({ severity: 'fatal' })), ['severity']);
});

test('invalid findings name the field', () => {
  assert.deepEqual(findingProblems(null), [{ field: '', message: 'a finding is a JSON object' }]);
  assert.deepEqual(fields(finding({ schema: 'x' })), ['schema']);
  assert.ok(fields(finding({ engine: 'Harper' })).includes('engine'));
  assert.ok(fields(finding({ engine: '1abc' })).includes('engine'));
  assert.ok(fields(finding({ engine: 'a'.repeat(33) })).includes('engine'));
  assert.deepEqual(fields(finding({ engineVersion: '' })), ['engineVersion']);
  assert.deepEqual(fields(finding({ engineVersion: 'v'.repeat(65) })), ['engineVersion']);
  assert.ok(fields(finding({ ruleId: '' })).includes('ruleId'));
  assert.ok(fields(finding({ ruleId: 'r'.repeat(129) })).includes('ruleId'));
  assert.deepEqual(fields(finding({ advisory: 'yes' })), ['advisory']);
  assert.deepEqual(fields(finding({ message: '' })), ['message']);
  assert.deepEqual(fields(finding({ message: 'm'.repeat(1001) })), ['message']);
  assert.deepEqual(fields(finding({ message: 'm'.repeat(1000) })), []);
  assert.ok(fields(finding({ sceneId: 'scene_short' })).includes('sceneId'));
  assert.ok(fields(finding({ sceneId: 'chapter_01HZX3K9M2N4P6Q8R0S1T2V3W4' })).includes('sceneId'));
});

test('source and range rules', () => {
  assert.ok(fields(finding({ source: { sha256: 'A'.repeat(64), length: 10 } })).includes('source.sha256'));
  assert.ok(fields(finding({ source: { sha256: 'abc', length: 10 } })).includes('source.sha256'));
  assert.ok(fields(finding({ source: { sha256: SHA, length: 1.5 } })).includes('source.length'));
  assert.ok(fields(finding({ source: null })).includes('source'));
  assert.ok(fields(finding({ range: { from: 5, to: 5 }, original: '' })).includes('range'));
  assert.ok(fields(finding({ range: { from: 9, to: 3 } })).includes('range'));
  assert.ok(fields(finding({ range: { from: -1, to: 3 } })).includes('range'));
  assert.ok(fields(finding({ range: { from: 1.5, to: 3 } })).includes('range'));
  assert.ok(fields(finding({ range: { from: 14, to: BODY.length + 1 } })).includes('range'));
  assert.ok(fields(finding({ range: null, id: `fnd_${'1'.repeat(16)}` })).includes('range'));
  assert.deepEqual(fields(finding({ range: { from: 0, to: BODY.length }, original: BODY })), []);
});

test('original must be the length of the range', () => {
  assert.deepEqual(fields(finding({ original: 'the' })), ['original']);
  assert.deepEqual(fields(finding({ original: 5 })), ['original']);
});

test('replacements: 0 to 8 strings', () => {
  assert.deepEqual(findingProblems(finding({ replacements: Array(8).fill('x') })), []);
  assert.deepEqual(fields(finding({ replacements: Array(9).fill('x') })), ['replacements']);
  assert.deepEqual(fields(finding({ replacements: 'the' })), ['replacements']);
  assert.deepEqual(fields(finding({ replacements: ['a', 3] })), ['replacements.1']);
});

test('id: format and match', () => {
  assert.deepEqual(fields(finding({ id: 'fnd_xyz' })), ['id']);
  assert.deepEqual(fields(finding({ id: `fnd_${'A'.repeat(16)}` })), ['id']);
  assert.deepEqual(fields(finding({ id: `fnd_${'0'.repeat(16)}` })), ['id'], 'well formed but not the derived id');
});

test('findingId is stable, well formed and differs per input', () => {
  const f = finding();
  assert.match(f.id, /^fnd_[0-9a-f]{16}$/);
  assert.equal(findingId(finding()), f.id);
  assert.equal(findingId({ ...f, message: 'other', replacements: [] }), f.id, 'message and replacements are not part of the id');
  const ids = new Set([
    f.id,
    findingId({ ...f, range: { from: 15, to: 22 } }),
    findingId({ ...f, range: { from: 14, to: 22 } }),
    findingId({ ...f, range: { from: 15, to: 21 } }),
    findingId({ ...f, engine: 'harper' }),
    findingId({ ...f, ruleId: 'other' }),
    findingId({ ...f, sceneId: 'scene_01HZX3K9M2N4P6Q8R0S1T2V3W5' }),
    findingId({ ...f, original: 'THE the' }),
  ]);
  assert.equal(ids.size, 8);
});

test('findingId keeps field boundaries apart', () => {
  const a = findingId({ engine: 'ab', ruleId: 'c', sceneId: 's', range: { from: 1, to: 2 }, original: 'x' });
  const b = findingId({ engine: 'a', ruleId: 'bc', sceneId: 's', range: { from: 1, to: 2 }, original: 'x' });
  assert.notEqual(a, b);
});

test('findingMatches', () => {
  const f = finding();
  assert.equal(findingMatches(f, BODY), true);
  assert.equal(findingMatches(f, BODY.replace('walked', 'ran')), false, 'length changed');
  assert.equal(findingMatches(f, BODY.replace('the the', 'a   ab')), false, 'same length, different text');
  assert.equal(findingMatches(f, `${BODY}!`), false);
  assert.equal(findingMatches(f, 'x'.repeat(BODY.length)), false);
});

// ---------------------------------------------------------------- validation results

function validation(over = {}) {
  return {
    schema: VALIDATION_SCHEMA,
    validator: 'epubcheck',
    validatorVersion: '5.1.0',
    artifact: { kind: 'epub', sha256: SHA, name: 'book.epub' },
    checkedAt: '2026-05-01T12:00:00Z',
    outcome: 'passed',
    messages: [],
    report: { path: 'reports/epubcheck.json' },
    detail: null,
    ...over,
  };
}
const vfields = (r) => validationProblems(r).map((p) => p.field);

test('valid validation results', () => {
  assert.deepEqual(validationProblems(validation()), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'passed-with-warnings', messages: [{ code: 'OPF-1', severity: 'warning', message: 'm', location: { path: 'a.xhtml', line: 3, column: 0 }, sceneId: SCENE, chapterId: null }] })), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'failed', artifact: { kind: 'pdf', sha256: SHA, name: 'b.pdf' }, report: null })), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'unavailable', validatorVersion: null, checkedAt: null, detail: 'Java was not found.', report: null })), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'not-checked', validatorVersion: null, checkedAt: null, report: null })), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'error', detail: 'EPUBCheck crashed.' })), []);
  assert.deepEqual(validationProblems(validation({ outcome: 'cancelled', detail: 'Stopped by the author.' })), []);
});

test('invalid validation results name the field', () => {
  assert.deepEqual(validationProblems(5), [{ field: '', message: 'a validation result is a JSON object' }]);
  assert.deepEqual(vfields(validation({ schema: 'x' })), ['schema']);
  assert.deepEqual(vfields(validation({ outcome: 'ok' })), ['outcome']);
  assert.deepEqual(vfields(validation({ validator: '' })), ['validator']);
  assert.deepEqual(vfields(validation({ validatorVersion: null })), ['validatorVersion'], 'null version only when nothing ran');
  assert.deepEqual(vfields(validation({ validatorVersion: '' })), ['validatorVersion']);
  assert.deepEqual(vfields(validation({ artifact: { kind: 'docx', sha256: SHA, name: 'b.docx' } })), ['artifact.kind']);
  assert.deepEqual(vfields(validation({ artifact: { kind: 'epub', sha256: 'zz', name: 'b.epub' } })), ['artifact.sha256']);
  assert.deepEqual(vfields(validation({ artifact: { kind: 'epub', sha256: SHA, name: 'out/b.epub' } })), ['artifact.name']);
  assert.deepEqual(vfields(validation({ artifact: { kind: 'epub', sha256: SHA, name: 'out\\b.epub' } })), ['artifact.name']);
  assert.deepEqual(vfields(validation({ artifact: null })), ['artifact']);
  assert.deepEqual(vfields(validation({ checkedAt: 'yesterday' })), ['checkedAt']);
  assert.deepEqual(vfields(validation({ checkedAt: '2026-05-01T12:00:00+02:00' })), ['checkedAt']);
  assert.deepEqual(vfields(validation({ checkedAt: null })), ['checkedAt'], 'a verdict needs a time');
  assert.deepEqual(vfields(validation({ messages: 'x' })), ['messages']);
  assert.deepEqual(vfields(validation({ report: { path: '' } })), ['report']);
  assert.deepEqual(vfields(validation({ detail: 'extra' })), ['detail']);
  assert.deepEqual(vfields(validation({ outcome: 'error', detail: null })), ['detail']);
  assert.deepEqual(vfields(validation({ outcome: 'unavailable', validatorVersion: null, checkedAt: null, detail: null })), ['detail']);
});

test('validation message rules', () => {
  const m = { code: 'X', severity: 'error', message: 'm', location: null, sceneId: null, chapterId: null };
  assert.deepEqual(vfields(validation({ outcome: 'failed', messages: [m] })), []);
  for (const severity of VALIDATION_SEVERITIES) assert.deepEqual(vfields(validation({ messages: [{ ...m, severity }] })), []);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, severity: 'bad' }] })), ['messages.0.severity']);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, code: '' }] })), ['messages.0.code']);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, message: '' }] })), ['messages.0.message']);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, location: { path: 'a' } }] })), ['messages.0.location']);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, sceneId: 'nope' }] })), ['messages.0.sceneId']);
  assert.deepEqual(vfields(validation({ messages: [{ ...m, chapterId: 'nope' }] })), ['messages.0.chapterId']);
  assert.deepEqual(vfields(validation({ messages: [7] })), ['messages.0']);
});

test('outcomeOf', () => {
  const sev = (...s) => s.map((severity) => ({ severity }));
  assert.equal(outcomeOf([]), 'passed');
  assert.equal(outcomeOf(sev('info', 'usage')), 'passed');
  assert.equal(outcomeOf(sev('info', 'warning')), 'passed-with-warnings');
  assert.equal(outcomeOf(sev('warning', 'error')), 'failed');
  assert.equal(outcomeOf(sev('fatal')), 'failed');
  assert.equal(outcomeOf(sev('usage', 'error', 'info')), 'failed');
});

test('isCleanValidation is true only for passed and passed-with-warnings', () => {
  for (const outcome of VALIDATION_OUTCOMES) {
    const clean = outcome === 'passed' || outcome === 'passed-with-warnings';
    assert.equal(isCleanValidation({ outcome }), clean, outcome);
  }
  for (const outcome of ['failed', 'not-checked', 'unavailable', 'error', 'cancelled']) assert.equal(isCleanValidation({ outcome }), false);
  assert.equal(isCleanValidation({ outcome: 'nonsense' }), false);
});

// ---------------------------------------------------------------- capability states

const ALLOWED = {
  'disabled enable': 'ready',
  'ready start': 'running',
  'completed start': 'running',
  'failed start': 'running',
  'cancelled start': 'running',
  'running finish': 'completed',
  'running fail': 'failed',
  'running cancel': 'cancelled',
  'unavailable restore': 'ready',
};

test('every capability move: allowed ones go where the contract says, all others return the state unchanged', () => {
  for (const state of CAPABILITY_STATES) {
    for (const event of CAPABILITY_EVENTS) {
      let expected;
      if (event === 'disable') expected = 'disabled';
      else if (event === 'lose') expected = state === 'disabled' ? 'disabled' : 'unavailable';
      else expected = ALLOWED[`${state} ${event}`] ?? state;
      assert.equal(nextCapability(state, event), expected, `${state} -${event}->`);
    }
  }
});

test('capability moves in sequence, and unknown input never throws', () => {
  let s = 'disabled';
  const steps = [['enable', 'ready'], ['start', 'running'], ['cancel', 'cancelled'], ['start', 'running'], ['fail', 'failed'], ['lose', 'unavailable'], ['start', 'unavailable'], ['restore', 'ready'], ['start', 'running'], ['finish', 'completed'], ['disable', 'disabled'], ['lose', 'disabled']];
  for (const [e, want] of steps) {
    s = nextCapability(s, e);
    assert.equal(s, want, e);
  }
  assert.equal(nextCapability('bogus', 'start'), 'bogus');
  assert.equal(nextCapability('ready', 'bogus'), 'ready');
  assert.equal(nextCapability(undefined, undefined), undefined);
});

test('mayShowClean is true only for completed', () => {
  for (const state of CAPABILITY_STATES) assert.equal(mayShowClean(state), state === 'completed', state);
  assert.equal(mayShowClean('bogus'), false);
});

test('constants list what the contract lists', () => {
  assert.equal(FINDING_SCHEMA, 'storyforge.finding/v1');
  assert.equal(VALIDATION_SCHEMA, 'storyforge.validation/v1');
  assert.deepEqual(CAPABILITY_STATES, ['ready', 'disabled', 'unavailable', 'running', 'cancelled', 'failed', 'completed']);
  assert.equal(VALIDATION_OUTCOMES.length, 7);
});
