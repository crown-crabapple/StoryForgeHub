// M12 W4: CS1 (dead on the page), CS2 (gone object used), TH2 (promise overdue), the settings file, the chapter filter and the planned-cast pre-flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContinuity, RULES } from '../src/index.mjs';
import { KNIFE, PELL, MAREN, buildBook, id, ofRule } from './helpers.mjs';

const sc = (n, extra = {}) => ({ n, ch: n, title: `Scene ${n}`, body: 'Text.', ...extra });
const ev = (n, slug, order, scene, state) => ({ n, slug, order, scenes: [scene], state: [state] });
const died = '{ slug: pell, event: died }';
const revived = '{ slug: pell, event: revived }';
const lost = '{ slug: grafting-knife, event: lost }';
const destroyed = '{ slug: grafting-knife, event: destroyed }';
const found = '{ slug: grafting-knife, event: found }';
const cast = (entry, role = 'appears') => ({ cast: [{ entry, role }] });

test('the rule table lists CS1, CS2 and TH2', () => {
  for (const want of ['CS1', 'CS2', 'TH2']) assert.ok(RULES.some((r) => r.id === want), want);
});

test('CS1: a character who died appears or is pov in a later chapter -> error; same chapter, mentioned, or revived -> nothing', async () => {
  const base = { entries: [PELL, MAREN] };
  const root = buildBook({ ...base, scenes: [sc(1), sc(2, cast('pell')), sc(3, cast('pell', 'pov'))], events: [ev(1, 'pell-dies', 10, 1, died)] });
  const f = ofRule(await checkContinuity(root), 'CS1');
  assert.equal(f.length, 2);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].subject.kind, 'entry');
  assert.equal(f[0].subject.slug, 'pell');
  assert.deepEqual(f.map((x) => x.related).flat().sort(), [id('scene', 2), id('scene', 3)]);
  assert.equal(f[0].sources[0].kind, 'event');
  assert.equal(f[0].sources[1].kind, 'scene');
  assert.match(f[0].fingerprint, /^cs1-[0-9a-f]{16}$/);

  const same = buildBook({ ...base, scenes: [sc(1, cast('pell'))], events: [ev(1, 'pell-dies', 10, 1, died)] });
  assert.equal(ofRule(await checkContinuity(same), 'CS1').length, 0, 'same chapter');
  const mention = buildBook({ ...base, scenes: [sc(1), sc(2, cast('pell', 'mentioned'))], events: [ev(1, 'pell-dies', 10, 1, died)] });
  assert.equal(ofRule(await checkContinuity(mention), 'CS1').length, 0, 'mentioned is fine');
  const back = buildBook({ ...base, scenes: [sc(1), sc(2), sc(3, cast('pell'))], events: [ev(1, 'pell-dies', 10, 1, died), ev(2, 'pell-returns', 20, 2, revived)] });
  assert.equal(ofRule(await checkContinuity(back), 'CS1').length, 0, 'revived');
  const alive = buildBook({ ...base, scenes: [sc(1), sc(2, cast('maren-hollis'))], events: [ev(1, 'pell-dies', 10, 1, died)] });
  assert.equal(ofRule(await checkContinuity(alive), 'CS1').length, 0, 'someone else');
});

test('CS2: a destroyed or lost object in a later cast -> error; found again -> nothing', async () => {
  const base = { entries: [KNIFE, PELL] };
  for (const state of [lost, destroyed]) {
    const root = buildBook({ ...base, scenes: [sc(1), sc(2, cast('grafting-knife'))], events: [ev(1, 'knife-gone', 10, 1, state)] });
    const f = ofRule(await checkContinuity(root), 'CS2');
    assert.equal(f.length, 1, state);
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].subject.slug, 'grafting-knife');
    assert.deepEqual(f[0].related, [id('scene', 2)]);
  }
  const refound = buildBook({ ...base, scenes: [sc(1), sc(2), sc(3, cast('grafting-knife'))], events: [ev(1, 'knife-gone', 10, 1, lost), ev(2, 'knife-back', 20, 2, found)] });
  assert.equal(ofRule(await checkContinuity(refound), 'CS2').length, 0);
  const asCharacter = buildBook({ ...base, scenes: [sc(1), sc(2, cast('grafting-knife'))], events: [ev(1, 'pell-dies', 10, 1, died)] });
  assert.equal(ofRule(await checkContinuity(asCharacter), 'CS2').length, 0);
});

const long = (n, thread, extra = {}) => buildBook({
  scenes: Array.from({ length: n }, (_, i) => sc(i + 1)),
  threads: [{ n: 1, slug: 'the-promise', kind: 'promise', ...thread }],
  ...extra,
});

test('TH2: an open promise more than 12 chapters after its setup -> warning; 12 or fewer, paid, dropped or a mystery -> nothing', async () => {
  const f = ofRule(await checkContinuity(long(14, { status: 'planted', setup: [1] })), 'TH2');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].subject.kind, 'thread');
  assert.deepEqual(f[0].related, [id('scene', 1)]);
  assert.match(f[0].fingerprint, /^th2-[0-9a-f]{16}$/);
  assert.equal(ofRule(await checkContinuity(long(13, { status: 'planted', setup: [1] })), 'TH2').length, 0, 'exactly 12 chapters is not overdue');
  assert.equal(ofRule(await checkContinuity(long(14, { status: 'paid', setup: [1] })), 'TH2').length, 0);
  assert.equal(ofRule(await checkContinuity(long(14, { status: 'dropped', setup: [1] })), 'TH2').length, 0);
  assert.equal(ofRule(await checkContinuity(long(14, { status: 'planted', setup: [1], kind: 'mystery' })), 'TH2').length, 0);
  assert.equal(ofRule(await checkContinuity(long(14, { status: 'planted' })), 'TH2').length, 0, 'no setup scene');
  const q = ofRule(await checkContinuity(long(14, { status: 'open', setup: [1], kind: 'question' })), 'TH2');
  assert.equal(q.length, 1);
});

test('settings: overdue_chapters moves the TH2 limit; severity overrides a rule or turns it off', async () => {
  const lenient = long(14, { status: 'planted', setup: [1] }, { settings: 'overdue_chapters: 20\n' });
  const r = await checkContinuity(lenient);
  assert.equal(ofRule(r, 'TH2').length, 0);
  assert.equal(r.settings.overdue_chapters, 20);
  const strict = long(6, { status: 'planted', setup: [1] }, { settings: 'overdue_chapters: 3\nseverity:\n  TH2: error\n' });
  const s = ofRule(await checkContinuity(strict), 'TH2');
  assert.equal(s.length, 1);
  assert.equal(s[0].severity, 'error');
  const off = long(14, { status: 'planted', setup: [1] }, { settings: 'severity:\n  TH2: off\n  CS1: info\n' });
  const o = await checkContinuity(off);
  assert.equal(ofRule(o, 'TH2').length, 0);
  assert.deepEqual(o.settings.severity, { TH2: 'off', CS1: 'info' });
  const cs1 = buildBook({ entries: [PELL], scenes: [sc(1), sc(2, cast('pell'))], events: [ev(1, 'pell-dies', 10, 1, died)], settings: 'severity:\n  CS1: info\n' });
  assert.equal(ofRule(await checkContinuity(cs1), 'CS1')[0].severity, 'info');
  const none = buildBook({ entries: [PELL], scenes: [sc(1), sc(2, cast('pell'))], events: [ev(1, 'pell-dies', 10, 1, died)], settings: 'severity:\n  CS1: off\n' });
  assert.equal(ofRule(await checkContinuity(none), 'CS1').length, 0);
  // an invalid word or number is ignored by the engine
  const bad = buildBook({ entries: [PELL], scenes: [sc(1), sc(2, cast('pell'))], events: [ev(1, 'pell-dies', 10, 1, died)], settings: 'overdue_chapters: 0\nseverity:\n  CS1: loud\n' });
  const b = await checkContinuity(bad);
  assert.equal(b.settings.overdue_chapters, 12);
  assert.equal(ofRule(b, 'CS1')[0].severity, 'error');
});

test('chapter filter keeps only findings that touch the chapter; a planned cast is checked as a scene of that chapter', async () => {
  const root = buildBook({
    entries: [PELL, KNIFE],
    scenes: [sc(1), sc(2, cast('pell')), sc(3), sc(4, cast('grafting-knife'))],
    events: [ev(1, 'pell-dies', 10, 1, died), ev(2, 'knife-gone', 20, 1, lost)],
  });
  const all = await checkContinuity(root);
  assert.deepEqual(all.findings.map((f) => f.rule).sort(), ['CS1', 'CS2']);
  const ch2 = await checkContinuity(root, { chapter: 2 });
  assert.deepEqual(ch2.findings.map((f) => f.rule), ['CS1']);
  const ch3 = await checkContinuity(root, { chapter: 3 });
  assert.deepEqual(ch3.findings, []);
  const planned = await checkContinuity(root, { chapter: 3, cast: [{ entry: 'pell', role: 'appears' }, { entry: 'grafting-knife', role: 'pov' }, { entry: 'nobody', role: 'appears' }] });
  assert.deepEqual(planned.findings.map((f) => [f.rule, f.planned === true]).sort(), [['CS1', true], ['CS2', true]]);
  // a mentioned planned entry is fine; a planned cast without a chapter is ignored
  const mention = await checkContinuity(root, { chapter: 3, cast: [{ entry: 'pell', role: 'mentioned' }] });
  assert.deepEqual(mention.findings, []);
  const noChapter = await checkContinuity(root, { cast: [{ entry: 'pell', role: 'appears' }] });
  assert.equal(noChapter.findings.length, 2);
});
