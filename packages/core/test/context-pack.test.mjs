// M12 W6: the pure assembly of the chapter context pack (budget, priority order, the truncated list). No files, no repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, MAX_BUDGET, MIN_BUDGET, SECTIONS, assembleContext, normalizeBudget, tailOf } from '../src/context-pack.mjs';

const para = (word, n) => Array.from({ length: n }, () => word).join(' ');
const sectionChars = (pack) => SECTIONS.reduce((n, s) => n + JSON.stringify(pack[s.key]).length + s.key.length + 4, 0);

/** A full input: every section has content, sized so that some budgets cut some sections. */
function input(over = {}) {
  return {
    chapter: 3,
    workspace: [{ path: 'workspace/book', title: 'Book', body: para('book', 100) }, { path: 'workspace/style', title: 'Style', body: para('style', 100) }],
    story: { logline: 'A ferryman hides a key.', premise: para('premise', 50), protagonist_goal: 'Open the sluice.' },
    scene_plans: [{ scene: 'scene_1', title: 'Arrival', plan: { goal: 'Reach the dock' }, beats: [{ structure: 'Three act', beat: 'Setup', purpose: 'Meet the cast', state: 'open' }] }],
    cast: [{ id: 'entry_1', slug: 'maren', name: 'Maren', type: 'character', role: 'pov', summary: 'Ferryman.' }],
    knowledge: [{ character: 'Maren', facts: ['the key opens the sluice'] }],
    open_ledger: [{ kind: 'promise', title: 'Mend the wall', status: 'planted', planted_in_chapters: [1] }],
    state_events: [{ chapter: 1, subject: 'Pell', kind: 'lost', value: 'the lamp' }],
    state_docs: [{ path: 'state/chapter-02/situation', title: 'Situation', body: para('state', 120) }],
    previous_tail: para('tail', 200),
    continuity: [{ rule: 'TL1', severity: 'warning', title: 'Order', message: 'Scene order disagrees.' }],
    ...over,
  };
}

test('with room to spare nothing is cut, every section is whole and truncated is empty', () => {
  const pack = assembleContext(input({ budget: MAX_BUDGET }));
  assert.deepEqual(pack.truncated, []);
  assert.equal(pack.chapter, 3);
  assert.equal(pack.budget, MAX_BUDGET);
  assert.equal(pack.workspace.length, 2);
  assert.equal(pack.workspace[1].body, para('style', 100));
  assert.deepEqual(pack.story, { logline: 'A ferryman hides a key.', premise: para('premise', 50), protagonist_goal: 'Open the sluice.' });
  assert.equal(pack.previous_tail, para('tail', 200));
  assert.equal(pack.continuity.length, 1);
  assert.equal(pack.chars, sectionChars(pack));
});

test('the default budget is 24000 and a bad one falls back or is clamped', () => {
  assert.equal(assembleContext(input()).budget, DEFAULT_BUDGET);
  assert.equal(DEFAULT_BUDGET, 24000);
  assert.equal(normalizeBudget(undefined), DEFAULT_BUDGET);
  assert.equal(normalizeBudget('x'), DEFAULT_BUDGET);
  assert.equal(normalizeBudget(10), MIN_BUDGET);
  assert.equal(normalizeBudget(10_000_000), MAX_BUDGET);
  assert.equal(normalizeBudget(1234.9), 1234);
});

test('the sections together never take more than the budget, at any budget', () => {
  for (const budget of [MIN_BUDGET, 600, 800, 1000, 1500, 2500, 4000, 7000, 24000]) {
    const pack = assembleContext(input({ budget }));
    assert.ok(sectionChars(pack) <= budget, `${budget}: ${sectionChars(pack)}`);
    assert.equal(pack.chars, sectionChars(pack), `chars is the real size at ${budget}`);
    assert.ok(pack.chars <= pack.budget);
  }
});

test('priority: when the budget runs out the later sections are cut first and named in truncated, in priority order', () => {
  const pack = assembleContext(input({ budget: 1500 }));
  assert.ok(pack.truncated.length > 0);
  const order = SECTIONS.map((s) => s.key);
  assert.deepEqual(pack.truncated, [...pack.truncated].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  // the workspace docs come first: they take the room, and the rest is cut
  assert.ok(pack.workspace.length >= 1);
  assert.deepEqual(pack.continuity, [], 'the last section is the first to go');
  assert.equal(pack.previous_tail, null);
  assert.ok(pack.truncated.includes('continuity'));
  assert.ok(pack.truncated.includes('previous_tail'));
  // a section that was cut entirely is empty, never half an item
  for (const k of ['scene_plans', 'cast', 'knowledge', 'open_ledger', 'state_events']) {
    for (const item of pack[k]) assert.ok(JSON.stringify(item).length > 5, k);
  }
});

test('a budget that holds the workspace and the plan but not everything keeps the higher sections whole', () => {
  const full = assembleContext(input({ budget: MAX_BUDGET }));
  const need = (keys) => keys.reduce((n, k) => n + JSON.stringify(full[k]).length + k.length + 4, 0);
  const budget = need(['workspace', 'story', 'scene_plans', 'cast']) + 150; // + the empty form of every later section
  const pack = assembleContext(input({ budget }));
  assert.deepEqual(pack.workspace, full.workspace);
  assert.deepEqual(pack.story, full.story);
  assert.deepEqual(pack.scene_plans, full.scene_plans);
  assert.deepEqual(pack.cast, full.cast);
  assert.ok(pack.truncated.includes('previous_tail'));
  assert.ok(!pack.truncated.includes('workspace') && !pack.truncated.includes('story') && !pack.truncated.includes('scene_plans') && !pack.truncated.includes('cast'));
});

test('a long text is shortened with an ellipsis (the first words stay), a long tail keeps its end', () => {
  const pack = assembleContext(input({ budget: 700, workspace: [{ path: 'workspace/book', title: 'Book', body: `${para('alpha', 400)} END` }], previous_tail: `START ${para('beta', 400)} the last line.` }));
  assert.deepEqual(pack.truncated.filter((k) => k === 'workspace'), ['workspace']);
  assert.match(pack.workspace[0].body, /^alpha alpha/);
  assert.ok(pack.workspace[0].body.endsWith('…'));
  assert.ok(pack.workspace[0].body.length < 400 * 6);

  const big = assembleContext(input({ budget: 1400, workspace: [], story: {}, scene_plans: [], cast: [], knowledge: [], open_ledger: [], state_events: [], state_docs: [], previous_tail: `START ${para('beta', 600)} the last line.`, continuity: [] }));
  assert.ok(big.truncated.includes('previous_tail'));
  assert.ok(big.previous_tail.endsWith('the last line.'), 'the end of the scene is what stays');
  assert.ok(!big.previous_tail.startsWith('START'));
});

test('empty sections are not truncated; the shape is stable (every section key is present)', () => {
  const pack = assembleContext({ chapter: 0, budget: 2000 });
  assert.deepEqual(pack.truncated, []);
  for (const s of SECTIONS) assert.ok(s.key in pack, s.key);
  assert.deepEqual(pack.workspace, []);
  assert.deepEqual(pack.story, {});
  assert.equal(pack.previous_tail, null);
});

test('fields of the story plan that are empty are left out', () => {
  const pack = assembleContext(input({ story: { logline: 'One line.', premise: null, protagonist_goal: '  ' } }));
  assert.deepEqual(pack.story, { logline: 'One line.' });
});

test('tailOf: the whole text when short, else about the last 1500 characters starting at a break', () => {
  assert.equal(tailOf('Short scene.'), 'Short scene.');
  const text = `${para('one', 800)}.\n\nSecond paragraph starts here. ${para('two', 300)}`;
  const tail = tailOf(text);
  assert.ok(tail.length <= 1500);
  assert.ok(tail.length > 1000);
  assert.ok(text.endsWith(tail));
  assert.equal(tailOf('a\r\nb'), 'a\nb');
});
