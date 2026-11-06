// Story Planner load-time benchmark (ADR 0003, risk "many small files"): builds a temp book with 500 scenes and 1,000 links, then prints
// how long validate(), listLinks() and flowGraph() take. Not part of the test suite:  node packages/core/test/bench-planner.mjs (lives under test/ because only packages/store/src may write files from src or scripts)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '@storyforge/core';
import { validate } from '@storyforge/format';
import { LINK_RELATIONS, ulid } from '@storyforge/manuscript';

const SCENES = 500;
const LINKS = 1000;
const PER_CHAPTER = 10;
const pad = (n, w) => String(n).padStart(w, '0');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bench-planner-'));
const put = (rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

try {
  put('book.md', `---\nschema: storyforge.book/v1\nid: book_${ulid()}\nslug: bench-planner\ntitle: Bench Planner\nprofile: fiction\nstatus: drafting\n---\n`);
  const ids = [];
  for (let i = 0; i < SCENES; i++) {
    const chapter = Math.floor(i / PER_CHAPTER) + 1;
    const sequence = (i % PER_CHAPTER + 1) * 10;
    const id = `scene_${ulid()}`;
    ids.push(id);
    put(
      `manuscript/act-01-bench/ch-${pad(chapter, 3)}-bench/${pad(sequence, 4)}-scene-${pad(i + 1, 3)}.md`,
      `---\nschema: storyforge.scene/v1\nid: ${id}\ntitle: Scene ${i + 1}\nact: 1\nchapter: ${chapter}\nsequence: ${sequence}\nstatus: drafting\n---\nScene ${i + 1} text.\n`,
    );
  }
  // 1,000 distinct links: scene i to the next scene, then to the one after, each with one of the relation words
  for (let n = 0; n < LINKS; n++) {
    const i = n % SCENES;
    const to = (i + 1 + Math.floor(n / SCENES)) % SCENES;
    const relation = LINK_RELATIONS[n % LINK_RELATIONS.length];
    put(
      `planning/links/link-${pad(n + 1, 4)}.md`,
      `---
schema: storyforge.link/v1
id: note_${ulid()}
slug: link-${pad(n + 1, 4)}
from: ${ids[i]}
to: ${ids[to]}
relation: ${relation}
created: 2026-11-05
---

Why scene ${i + 1} ${relation} scene ${to + 1}.
`,
    );
  }

  const ms = async (fn) => {
    const t = process.hrtime.bigint();
    const out = await fn();
    return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 };
  };
  const cold = await ms(() => validate(root));
  const errors = cold.out.diagnostics.filter((d) => d.severity === 'error');
  const warm = await ms(() => validate(root));
  const bookId = cold.out.books[0].id;
  const repo = createFsRepository(root);
  try {
    const first = await ms(() => repo.listLinks(bookId));
    const second = await ms(() => repo.listLinks(bookId));
    const flow = await ms(() => repo.flowGraph(bookId));
    console.log(`book: ${SCENES} scenes, ${first.out.links.length} links, ${errors.length} errors, ${cold.out.diagnostics.length} diagnostics`);
    console.log(`validate()   cold ${cold.ms.toFixed(0)} ms, warm ${warm.ms.toFixed(0)} ms`);
    console.log(`listLinks()  first ${first.ms.toFixed(0)} ms (validate cache cold), second ${second.ms.toFixed(0)} ms`);
    console.log(`flowGraph()  ${flow.ms.toFixed(0)} ms (${flow.out.nodes.length} nodes, ${flow.out.edges.length} edges)`);
  } finally {
    await repo.close();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
