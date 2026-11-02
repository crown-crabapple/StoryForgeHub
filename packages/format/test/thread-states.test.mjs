// M04-J03 section 1 / acceptance 5: thread states, the `develop` list and W306 on a copy of salt-orchard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

const SETUP = 'scene_01S50000000000000000000003';
const DEVELOP = 'scene_01S50000000000000000000005';
const PAYOFF = 'scene_01S50000000000000000000009';
const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();
const THREAD = 'planning/threads/brass-key.md';

function copy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-j03-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}
function setThread(root, { status, setup = [], develop, payoff = [] }) {
  const lines = [
    '---', 'schema: storyforge.thread/v1', 'id: thread_01S5000000000000000000000T', 'slug: brass-key',
    'title: The brass key', 'kind: mystery', `status: ${status}`, `setup: [${setup.join(', ')}]`,
  ];
  if (develop !== undefined) lines.push(`develop: [${develop.join(', ')}]`);
  lines.push(`payoff: [${payoff.join(', ')}]`, 'characters: [maren-hollis, ilse-hollis]', '---', 'What the key opens.', '');
  fs.writeFileSync(path.join(root, THREAD), lines.join('\n'));
}

test('baseline: salt-orchard copy is clean', async () => {
  assert.deepEqual(keys(await validate(copy())), []);
});

const CLEAN = {
  planned: {},
  planted: { setup: [SETUP] },
  developed: { setup: [SETUP], develop: [DEVELOP] },
  paid: { setup: [SETUP], develop: [DEVELOP], payoff: [PAYOFF] },
  dropped: {},
  unresolved: { setup: [SETUP] },
  open: { setup: [SETUP] },
  abandoned: {},
};
for (const [status, lists] of Object.entries(CLEAN)) {
  test(`thread status ${status} validates clean`, async () => {
    const root = copy();
    setThread(root, { status, ...lists });
    assert.deepEqual(keys(await validate(root)), []);
  });
}

test('an unknown thread status is still E102', async () => {
  const root = copy();
  setThread(root, { status: 'sleeping', setup: [SETUP] });
  assert.deepEqual(keys(await validate(root)), [`E102 | ${THREAD} | status`]);
});

test('develop is optional: a planted thread without the key is clean', async () => {
  const root = copy();
  setThread(root, { status: 'planted', setup: [SETUP] });
  assert.deepEqual(keys(await validate(root)), []);
});

test('W306 only fires for planted/developed with the matching list empty', async () => {
  const root = copy();
  setThread(root, { status: 'planted', setup: [] });
  assert.deepEqual(keys(await validate(root)), [`W306 | ${THREAD} | status`]);
  setThread(root, { status: 'developed', setup: [SETUP], develop: [] });
  assert.deepEqual(keys(await validate(root)), [`W306 | ${THREAD} | status`]);
  setThread(root, { status: 'developed', setup: [SETUP] }); // key missing counts as empty
  assert.deepEqual(keys(await validate(root)), [`W306 | ${THREAD} | status`]);
  setThread(root, { status: 'planned', setup: [] });
  assert.deepEqual(keys(await validate(root)), []);
});

test('W306 is a warning, not an error', async () => {
  const root = copy();
  setThread(root, { status: 'planted', setup: [] });
  const r = await validate(root);
  assert.equal(r.diagnostics.find((d) => d.code === 'W306').severity, 'warning');
});

test('develop references are resolved (E301) and kind-checked (E302)', async () => {
  const root = copy();
  setThread(root, { status: 'developed', setup: [SETUP], develop: ['scene_01S5000000000000000000ZZZZ'] });
  assert.deepEqual(keys(await validate(root)), [`E301 | ${THREAD} | develop[0]`]);
  setThread(root, { status: 'developed', setup: [SETUP], develop: ['entry_01S50000000000000000000001'] });
  const r = keys(await validate(root));
  assert.ok(r.every((k) => /^E30[12] /.test(k)) && r.length === 1, r.join('\n'));
});
