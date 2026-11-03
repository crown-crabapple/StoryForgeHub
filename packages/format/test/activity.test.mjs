import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { keysOf } from './helpers.mjs';

// M07-J02: goals, sessions files and revision tasks in a book. Built in a temp folder; every id is synthetic.
const ID = (prefix, n) => `${prefix}_01J${String(n).padStart(23, '0')}`.slice(0, prefix.length + 27);
const BOOK = ID('book', 1);
const SCENE = ID('scene', 2);
const CHAP = ID('chap', 3);
const ACT = ID('act', 4);

function book(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-act-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w('book.md', `---\nschema: storyforge.book/v1\nid: ${BOOK}\nslug: mini\ntitle: Mini\nprofile: fiction\nstatus: drafting\ndaily_word_goal: 500\n---\n`);
  w('manuscript/act-01-one/act.md', `---\nschema: storyforge.act/v1\nid: ${ACT}\nact: 1\n---\n`);
  w('manuscript/act-01-one/ch-001-one/chapter.md', `---\nschema: storyforge.chapter/v1\nid: ${CHAP}\nchapter: 1\n---\n`);
  w('manuscript/act-01-one/ch-001-one/0010-scene.md', `---\nschema: storyforge.scene/v1\nid: ${SCENE}\ntitle: Scene\nact: 1\nchapter: 1\nsequence: 10\nstatus: drafting\n---\nThe tide went out.\n`);
  extra(w);
  return root;
}

test('a goals file, a sessions file and a task that are well formed raise nothing', async () => {
  const root = book((w) => {
    w('activity/goals.md', `---\nschema: storyforge.goals/v1\nid: ${ID('note', 5)}\ngoals:\n  - { id: g1, kind: words, target: 500, period: day }\n  - { id: g2, kind: words, target: 90000, period: total, due: 2027-03-01 }\n  - { id: g3, kind: minutes, target: 300, period: week, scope: ${CHAP} }\n  - { id: g4, kind: scenes, target: 2, period: month, scope: ${ACT} }\n---\n`);
    w('activity/sessions/2026/2026-11.md', `---\nschema: storyforge.doc/v1\nid: ${ID('note', 6)}\ntitle: Sessions 2026-11\n---\n\n| Start | End | Minutes | Added | Removed | Kind | Scenes |\n|---|---|---|---|---|---|---|\n| 2026-11-02T10:00:00Z | 2026-11-02T10:25:00Z | 25 | 410 | 12 | sprint | ${SCENE} |\nnot a row\n`);
    w('planning/tasks/fix-the-tide.md', `---\nschema: storyforge.task/v1\nid: ${ID('note', 7)}\nslug: fix-the-tide\ntitle: "Fix the tide"\nstatus: open\nsource: { kind: continuity, code: CF1, fingerprint: cf1-0123456789abcdef }\ntargets:\n  - { id: ${SCENE}, line: 1, quote: "tide", sha256: ${'a'.repeat(64)} }\ncreated: "2026-11-02T14:03:22Z"\nlabels: []\n---\nEvidence.\n`);
  });
  const r = await validate(root);
  assert.deepEqual(r.diagnostics, []);
});

test('legacy planning/tasks docs (no task schema) stay plain docs and raise nothing', async () => {
  const root = book((w) => w('planning/tasks/old.md', `---\nschema: storyforge.doc/v1\nid: ${ID('note', 8)}\ntitle: Old task list\n---\n- [ ] something\n`));
  assert.deepEqual((await validate(root)).diagnostics, []);
});

test('W313 names an unresolved target; E301 an unresolved scope; a scope may be an act or a chapter', async () => {
  const root = book((w) => {
    w('activity/goals.md', `---\nschema: storyforge.goals/v1\nid: ${ID('note', 5)}\ngoals:\n  - { id: g1, kind: minutes, target: 60, period: day, scope: ${ID('chap', 99)} }\n  - { id: g2, kind: minutes, target: 60, period: day, scope: ${ACT} }\n---\n`);
    w('planning/tasks/x.md', `---\nschema: storyforge.task/v1\nid: ${ID('note', 7)}\nslug: x\ntitle: X\nstatus: doing\ntargets:\n  - { id: ${SCENE} }\n  - { id: ${ID('scene', 98)} }\n---\n`);
  });
  const r = await validate(root);
  assert.deepEqual(keysOf(r.diagnostics), ['E301 | activity/goals.md | goals[0].scope', 'W313 | planning/tasks/x.md | targets[1].id'].sort());
  assert.equal(r.diagnostics.find((d) => d.code === 'W313').severity, 'warning');
});
