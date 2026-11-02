// M05-J05 section 4: review-request lists each reviewer agent, its inputs and its expected output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFixture, makeFramework, run, read } from './helpers.mjs';

test('review-request --chapter 2 names the three reviewers, their pack inputs and outputs', () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  assert.equal(run('context', { book, fw, chapter: 2 }).status, 0);
  const r = run('review-request', { book, fw, chapter: 2 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(fw, '.work/salt-orchard/reports/chapter-02-review-request.md');
  for (const a of ['style-linter', 'character-reviewer', 'continuity-reviewer']) {
    assert.ok(t.includes(a), `reviewer ${a}`);
    assert.ok(t.includes(`analysis/.claude/agents/${a}.md`.replace(/\//g, '/')) ||
      t.includes(`analysis\\.claude\\agents\\${a}.md`), `agent file path of ${a}`);
  }
  const outs = new Set(t.match(/chapter-02-[a-z-]+-report\.md/g));
  assert.ok(outs.size >= 3, `expected three distinct expected-output paths, got ${[...outs]}`);
  assert.match(t, /context[\\/]continuity-check\.md/);
  assert.match(t, /candidate[\\/]chapter-02-candidate\.md/);
});
