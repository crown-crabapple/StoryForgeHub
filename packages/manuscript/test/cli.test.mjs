// Acceptance 12 (CLI) and the CLI half of 11.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { readIndex } from '../src/index.mjs';
import { validate } from '../../format/src/index.mjs';
import { CLI, SALT, SALT_ORDER, cleanup, copyFixture, diffSnap, snapshot, write } from './helpers.mjs';

after(cleanup);

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('sf-manuscript CLI (acceptance 12)', () => {
  it('order on salt-orchard exits 0 and lists every scene id in book order', () => {
    const dir = copyFixture(SALT);
    const r = run('order', dir);
    assert.equal(r.code, 0, r.err);
    const positions = SALT_ORDER.map((id) => r.out.indexOf(id));
    assert.ok(positions.every((p) => p >= 0), `all ids printed:\n${r.out}`);
    assert.deepEqual(positions, positions.slice().sort((a, b) => a - b), 'ids appear in book order');
    assert.ok(r.out.includes('manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md'));
    assert.ok(!r.out.includes('scene_01S50000000000000000000004'), 'variant is not in the order');
  });

  it('order exits 1 on a book with manuscript errors (E204)', () => {
    assert.equal(run('order', copyFixture('invalid/E204-duplicate-sequence')).code, 1);
  });

  it('order exits 1 on a book with unparseable front matter (E100)', () => {
    assert.equal(run('order', copyFixture('invalid/E100-bad-yaml')).code, 1);
  });

  it('repair without --apply prints the plan and writes nothing', () => {
    const dir = copyFixture('valid/spec-example');
    const before = snapshot(dir);
    const r = run('repair', dir);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('0010-ferry.md'));
    assert.ok(r.out.includes('0020-the-key.md'));
    assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] });
  });

  it('repair --apply writes the renames and exits 0', async () => {
    const dir = copyFixture('valid/spec-example');
    const r = run('repair', dir, '--apply');
    assert.equal(r.code, 0, r.err);
    const codes = (await validate(dir)).diagnostics.map((d) => d.code);
    assert.ok(!codes.includes('W201') && !codes.includes('W202'));
  });

  it('index builds .storyforge/index.json and exits 0', async () => {
    const dir = copyFixture(SALT);
    const r = run('index', dir);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((await readIndex(dir)).scenes.map((s) => s.id), SALT_ORDER);
  });

  it('usage errors exit 2: no arguments, unknown command, missing book', () => {
    assert.equal(run().code, 2);
    assert.equal(run('frobnicate', copyFixture(SALT)).code, 2);
    assert.equal(run('order').code, 2);
  });

  it('order still prints the true order when index.json is wrong (acceptance 11)', () => {
    const dir = copyFixture(SALT);
    const reversed = SALT_ORDER.slice().reverse().map((id, i) => ({
      position: i + 1, id, act: 9, chapter: 9, sequence: 9, path: 'nowhere.md', sha256: '0'.repeat(64),
    }));
    write(dir, '.storyforge/index.json', JSON.stringify({ schema: 'storyforge.index/v1', built_at: 'x', scenes: reversed }));
    const r = run('order', dir);
    assert.equal(r.code, 0, r.err);
    const positions = SALT_ORDER.map((id) => r.out.indexOf(id));
    assert.ok(positions.every((p) => p >= 0));
    assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
  });
});
