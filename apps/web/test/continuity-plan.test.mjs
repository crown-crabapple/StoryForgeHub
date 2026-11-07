// Continuity review, plan family (M6): the PL rules in RULE_INFO, the family helper and filter, the structure link, the Review card's wording. Pure functions only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root: webDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const m = await vite.ssrLoadModule('/src/continuity/model.js');
const req = await vite.ssrLoadModule('/src/continuity/requests.js');
test.after(() => vite.close());

const finding = (rule, over = {}) => ({ rule, severity: 'info', title: rule, fingerprint: `${rule.toLowerCase()}-1`, subject: { kind: 'scene', id: `s_${rule}`, name: rule }, sources: [], ...over });
const result = {
  findings: [finding('CF1', { severity: 'error' }), finding('PL1'), finding('PL3'), finding('PL4', { severity: 'warning' })],
  suppressed: [{ finding: finding('PL2'), exception: { file: 'planning/continuity/x.md', slug: 'x', intentional: true } }],
  stale_exceptions: [{ file: 'planning/continuity/old.md', slug: 'old', fingerprint: 'pl3-abc' }, { file: 'planning/continuity/old2.md', slug: 'old2', fingerprint: 'cf1-abc' }],
};

test('RULE_INFO names PL1 to PL4 in plain words', () => {
  for (const id of ['PL1', 'PL2', 'PL3', 'PL4']) {
    assert.ok(m.RULE_INFO[id].name);
    assert.match(m.RULE_INFO[id].description, /not documented in the plan|may be on purpose/);
    assert.ok(m.RULE_IDS.includes(id));
  }
  assert.equal(m.ruleName('PL3'), 'Beat with no scenes');
});

test('familyOf', () => {
  assert.equal(m.familyOf('PL2'), 'plan');
  assert.equal(m.familyOf('CF1'), 'facts');
  assert.equal(m.familyOf('TH1a'), 'facts');
  assert.equal(m.familyOf('pl4'), 'plan');
  assert.equal(m.familyOf('XX9'), null);
  assert.equal(m.familyOf(''), null);
  assert.deepEqual(m.RULE_FAMILIES.plan.rules, ['PL1', 'PL2', 'PL3', 'PL4', 'PL5', 'PL6']);
});

test('queueModel narrows by family and composes with the other filters', () => {
  const all = m.queueModel(result, {});
  assert.equal(all.rows.length, 4);
  const plan = m.queueModel(result, { family: 'plan' });
  assert.deepEqual(plan.rows.map((f) => f.rule), ['PL1', 'PL3', 'PL4']);
  assert.deepEqual(plan.rules.map((r) => r.id), ['PL1', 'PL2', 'PL3', 'PL4', 'PL5', 'PL6']);
  assert.equal(plan.counts.all, 3);
  assert.equal(m.queueModel(result, { family: 'facts' }).rows.length, 1);
  assert.deepEqual(m.queueModel(result, { family: 'plan', status: 'warning' }).rows.map((f) => f.rule), ['PL4']);
  assert.deepEqual(m.queueModel(result, { family: 'plan', rule: 'PL3' }).rows.map((f) => f.rule), ['PL3']);
  const ack = m.queueModel(result, { family: 'plan', status: 'acknowledged' });
  assert.deepEqual(ack.rows.map((f) => f.rule), ['PL2']);
  assert.equal(ack.rows[0].exception.intentional, true);
  assert.deepEqual(ack.stale.map((x) => x.slug), ['old']);
});

test('family query parses and builds', () => {
  assert.equal(m.parseContinuitySearch('?family=plan').family, 'plan');
  assert.equal(m.parseContinuitySearch('?family=nope').family, null);
  assert.equal(m.parseContinuitySearch('').family, null);
  assert.equal(m.continuityHref('b1', { family: 'plan' }), '/books/b1/continuity?family=plan');
  assert.equal(m.continuityHref('b1', { finding: 'f', family: 'facts' }), '/books/b1/continuity?finding=f&family=facts');
  assert.equal(m.continuityHref('b1'), '/books/b1/continuity');
});

test('a structure source opens the Plan tab structure view', () => {
  assert.equal(m.structureHref('b1', 'three-act'), '/books/b1/plan?view=structure&structure=three-act');
  assert.equal(m.sourceHref('b1', { kind: 'structure', id: 'st1', slug: 'three-act' }), '/books/b1/plan?view=structure&structure=three-act');
  assert.equal(m.sourceHref('b1', { kind: 'structure', id: 'st1', file: 'planning/structures/hero.md' }), '/books/b1/plan?view=structure&structure=hero');
  assert.equal(m.sourceLabel({ file: 'planning/structures/hero.md', location: 'beats' }), 'planning/structures/hero.md › beats');
});

test('plan notes count and wording', () => {
  assert.equal(m.planNoteCount(result), 3);
  assert.equal(m.planNoteCount(null), 0);
  assert.equal(m.planNotesLabel(0), 'No plan notes to review');
  assert.equal(m.planNotesLabel(1), '1 plan note to review');
  assert.equal(m.planNotesLabel(3), '3 plan notes to review');
});

test('the acknowledge request carries intentional only when true', () => {
  assert.deepEqual(req.acknowledgeRequest('b', { fingerprint: 'f', rationale: 'r', intentional: true }).body, { fingerprint: 'f', rationale: 'r', intentional: true });
  assert.deepEqual(req.acknowledgeRequest('b', { fingerprint: 'f', rationale: 'r', intentional: false }).body, { fingerprint: 'f', rationale: 'r' });
});
