// M04-J03 acceptance 3 (outline / matrix / thread counts are accurate: pure projections checked against the fixture FILES,
// independently of the product's code) and 6 (render tests: Board, Outline, Threads, Matrix, inspector; lifecycle suggestions only
// where applicable; no dead controls).
//
// Fixture data is the real answer of the core repository (getBook / listThreads) over a copy of each fixture, so the views are
// rendered with what the API returns. Props follow the JSDoc of apps/web/src/planning/*.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.resolve(webDir, '../../packages/format/fixtures/valid');
const CG = 'book_01CG0000000000000000000001';
const SO = 'book_01S5000000000000000000000A';

let vite;
let model;
let requests;
let views = {};
const data = {};

const walk = async (dir, out = []) => {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
};
const frontOf = async (file) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await fs.readFile(file, 'utf8'));
  return m ? YAML.parse(m[1]) : null;
};

/** Read the fixture the way a person would: every scene and thread file's front matter, nothing from the product's code. */
async function filesOracle(root) {
  const scenes = [];
  const threads = [];
  for (const f of await walk(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel.startsWith('archive/') || rel.startsWith('.storyforge/')) continue;
    const fm = await frontOf(f);
    if (fm?.schema === 'storyforge.scene/v1' && rel.startsWith('manuscript/') && !fm.variant_of) scenes.push(fm);
    if (fm?.schema === 'storyforge.thread/v1') threads.push(fm);
  }
  scenes.sort((a, b) => a.chapter - b.chapter || a.sequence - b.sequence);
  return { scenes, threads };
}

async function load(fixture, bookId) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-planning-'));
  const root = path.join(base, fixture);
  await fs.cp(path.join(FIXTURES, fixture), root, { recursive: true });
  const repo = createFsRepository(root);
  const book = await repo.getBook(bookId);
  const planning = await repo.listThreads(bookId);
  return { bookId, book, planning, model: model.buildModel(book, planning), oracle: await filesOracle(root) };
}

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  model = await vite.ssrLoadModule('/src/planning/model.js');
  requests = await vite.ssrLoadModule('/src/planning/requests.js');
  views = {
    ...(await vite.ssrLoadModule('/src/planning/BoardView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/OutlineView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/ThreadsView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/MatrixView.jsx')),
    ...(await vite.ssrLoadModule('/src/planning/ThreadInspector.jsx')),
  };
  data.so = await load('salt-orchard', SO);
  data.cg = await load('codex-graph', CG);
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => decode(renderToStaticMarkup(el));
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) ?? []).length;
const noop = () => {};
const rowOf = (html, id) => new RegExp(`<tr[^>]*data-scene-id="${id}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? '';
const clone = (x) => JSON.parse(JSON.stringify(x));

/** The expected tags of a scene, worked out from the files: threads named in its plot_threads plus threads listing it, with S/D/P. */
function expectedTags(oracle, scene) {
  const out = new Map(); // thread id -> { roles, own }
  const refOf = (ref) => oracle.threads.find((t) => t.id === ref || t.slug === ref || (t.previous_slugs ?? []).includes(ref));
  for (const ref of scene.plot_threads ?? []) {
    const t = refOf(ref);
    if (t) out.set(t.id, { roles: '', own: true });
  }
  for (const t of oracle.threads) {
    const roles = [['S', 'setup'], ['D', 'develop'], ['P', 'payoff']].filter(([, l]) => (t[l] ?? []).includes(scene.id)).map(([k]) => k).join('');
    if (roles) out.set(t.id, { roles, own: out.get(t.id)?.own ?? false });
  }
  return out;
}

for (const key of ['so', 'cg']) {
  const label = key === 'so' ? 'salt-orchard' : 'codex-graph';

  describe(`acceptance 3 on ${label}: projections equal the files`, () => {
    test('cards are the book scenes in reading order, with summary and POV from the files', () => {
      const { model: m, oracle } = data[key];
      assert.deepEqual(m.scenes.map((s) => s.id), oracle.scenes.map((s) => s.id));
      for (const s of oracle.scenes) {
        const card = m.sceneById.get(s.id);
        assert.equal(card.summary, s.summary ?? '');
        assert.equal(card.pov, s.pov ?? null);
        assert.equal(card.status, s.status ?? null);
        assert.equal(card.title, s.title);
      }
    });

    test('every scene\'s thread tags == union of its plot_threads and the threads listing it, with S/D/P', () => {
      const { model: m, oracle } = data[key];
      let tagged = 0;
      for (const s of oracle.scenes) {
        const want = expectedTags(oracle, s);
        const got = new Map(m.sceneById.get(s.id).tags.map((t) => [t.thread_id, { roles: t.roles.join(''), own: t.own }]));
        assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `threads of ${s.title}`);
        for (const [id, w] of want) assert.deepEqual(got.get(id), w, `${s.title} / ${id}`);
        tagged += want.size;
      }
      assert.ok(tagged > 0, 'the fixture has at least one tag, so the check is not vacuous');
    });

    test('matrix cells == thread lists exactly (S / D / P / dot / empty), for every scene and thread', () => {
      const { model: m, oracle } = data[key];
      for (const t of m.threads) {
        const file = oracle.threads.find((x) => x.id === t.id);
        for (const s of oracle.scenes) {
          const cell = model.matrixCell(m, t, s.id);
          const roles = [['S', 'setup'], ['D', 'develop'], ['P', 'payoff']].filter(([, l]) => (file[l] ?? []).includes(s.id)).map(([k]) => k);
          assert.deepEqual(cell.roles, roles, `${t.title} / ${s.title}`);
          const own = expectedTags(oracle, s).get(t.id)?.own ?? false;
          assert.equal(cell.dot, roles.length === 0 && own, `dot for ${t.title} / ${s.title}`);
        }
      }
    });

    test('thread S/D/P counts equal the lengths of the lists in the file', () => {
      const { model: m, oracle } = data[key];
      assert.equal(m.threads.length, oracle.threads.length);
      for (const t of m.threads) {
        const file = oracle.threads.find((x) => x.id === t.id);
        assert.deepEqual(t.counts, { S: (file.setup ?? []).length, D: (file.develop ?? []).length, P: (file.payoff ?? []).length });
        assert.equal(t.status, file.status);
      }
    });

    test('rendered outline: one row per scene; Threads column shows each thread title with the right S/D/P markers', () => {
      const { model: m, oracle, bookId } = data[key];
      const html = render(h(views.OutlineView, { bookId, model: m }));
      assert.equal(count(html, /<tr[^>]*data-scene-id=/g), oracle.scenes.length);
      for (const s of oracle.scenes) {
        const row = rowOf(html, s.id);
        const want = expectedTags(oracle, s);
        assert.equal(count(row, /class="thread-tag"/g), want.size, `tag count in the row of ${s.title}`);
        for (const [id, w] of want) {
          const t = oracle.threads.find((x) => x.id === id);
          const tag = new RegExp(`<li[^>]*data-thread-id="${id}"[\\s\\S]*?</li>`).exec(row)?.[0] ?? '';
          assert.ok(tag.includes(t.title), `${s.title} shows ${t.title}`);
          assert.deepEqual([...tag.matchAll(/data-role="([SDP])"/g)].map((x) => x[1]).join(''), w.roles);
        }
      }
    });

    test('chapter totals: scene count and words add up to the cards', () => {
      const { model: m } = data[key];
      for (const ch of m.chapters) assert.equal(ch.words, ch.scenes.reduce((n, s) => n + s.word_count, 0));
      const html = render(h(views.OutlineView, { bookId: data[key].bookId, model: m }));
      for (const ch of m.chapters) {
        const row = new RegExp(`<tr[^>]*data-chapter="${ch.chapter}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? '';
        assert.match(textOf(row), new RegExp(`${ch.scenes.length} ${ch.scenes.length === 1 ? 'scene' : 'scenes'}, ${ch.words} words`));
      }
    });

    test('rendered matrix: every cell carries the roles / dot of the lists', () => {
      const { model: m, oracle, bookId } = data[key];
      const html = render(h(views.MatrixView, { bookId, model: m }));
      for (const s of oracle.scenes) {
        const row = rowOf(html, s.id);
        const cells = [...row.matchAll(/<td[^>]*class="matrix-cell"([^>]*)>/g)].map((x) => x[1]);
        assert.equal(cells.length, m.threads.length);
        m.threads.forEach((t, i) => {
          const cell = model.matrixCell(m, t, s.id);
          assert.match(cells[i], new RegExp(`data-roles="${cell.roles.join('')}"`));
          assert.equal(/data-dot="true"/.test(cells[i]), cell.dot);
        });
      }
    });
  });
}

describe('salt-orchard known values', () => {
  test('brass-key: S 1, D 0, P 1; Key is S, Wall is P, Prologue only names it (dot)', () => {
    const { model: m } = data.so;
    const t = m.threads[0];
    assert.equal(t.slug, 'brass-key');
    assert.deepEqual(t.counts, { S: 1, D: 0, P: 1 });
    const byTitle = (title) => m.scenes.find((s) => s.title === title);
    assert.deepEqual(model.matrixCell(m, t, byTitle('The Key').id), { roles: ['S'], dot: false });
    assert.deepEqual(model.matrixCell(m, t, byTitle('The Wall').id), { roles: ['P'], dot: false });
    assert.deepEqual(model.matrixCell(m, t, byTitle('Before the Tide').id), { roles: [], dot: true });
    assert.deepEqual(model.matrixCell(m, t, byTitle('Arrival').id), { roles: [], dot: false });
  });

  test('last touched is the last scene of any list; first setup position drives the sort', () => {
    const t = data.so.model.threads[0];
    assert.equal(t.lastTouched.label, 'Ch 3');
    assert.equal(t.firstSetup, data.so.model.sceneById.get(t.setup[0]).index);
  });
});

// ---------------------------------------------------------------- pure helpers

describe('pure helpers', () => {
  test('lifecycleSuggestions: only where applicable', () => {
    const s = (status, setup = [], develop = [], payoff = []) => model.lifecycleSuggestions({ status, setup, develop, payoff }).map((x) => x.to);
    assert.deepEqual(s('planned', ['a']), ['planted']);
    assert.deepEqual(s('planned'), []);
    assert.deepEqual(s('planted', ['a'], ['b']), ['developed']);
    assert.deepEqual(s('planted', ['a']), []);
    assert.deepEqual(s('planned', [], ['b']), [], 'planned with only develop scenes: no "developed" jump');
    assert.deepEqual(s('developed', ['a'], ['b'], ['c']), ['paid']);
    assert.deepEqual(s('planted', ['a'], [], ['c']), ['paid']);
    assert.deepEqual(s('planned', ['a'], [], ['c']), ['planted', 'paid']);
    assert.deepEqual(s('paid', ['a'], ['b'], ['c']), [], 'already paid: nothing to suggest');
    assert.deepEqual(s('open', ['a']), [], 'legacy open: no suggestion to plant');
    assert.deepEqual(s('dropped'), []);
  });

  test('stateOptions: the six states, plus the legacy one a thread already has; labels have text', () => {
    assert.deepEqual(model.stateOptions('planned'), ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved']);
    assert.deepEqual(model.stateOptions('open'), ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved', 'open']);
    assert.deepEqual(model.stateOptions('abandoned').slice(-1), ['abandoned']);
    for (const st of [...model.THREAD_STATES, ...model.LEGACY_STATES]) assert.ok(model.stateLabel(st).length > 0);
    assert.equal(model.stateLabel(null), 'No state');
  });

  test('parseView / viewHref round-trip, and unknown views fall back to Write', () => {
    assert.deepEqual(model.parseView(''), { view: 'write', mode: 'list', thread: null });
    assert.deepEqual(model.parseView('?view=bogus'), { view: 'write', mode: 'list', thread: null });
    assert.equal(model.parseView('?view=board').view, 'board');
    assert.equal(model.parseView('?view=outline').view, 'outline');
    assert.equal(model.parseView('?view=threads&show=matrix').mode, 'matrix');
    assert.equal(model.parseView('?view=board&show=matrix').mode, 'list');
    assert.equal(model.parseView('?view=threads&thread=abc').thread, 'abc');
    assert.equal(model.viewHref('book_1', 'write'), '/books/book_1');
    assert.equal(model.viewHref('book_1', 'board'), '/books/book_1?view=board');
    assert.equal(model.viewHref('book_1', 'threads', { mode: 'matrix' }), '/books/book_1?view=threads&show=matrix');
    for (const v of ['write', 'board', 'outline', 'threads']) assert.equal(model.parseView(new URL(model.viewHref('b', v), 'http://x').search).view, v);
  });

  test('visibleThreads: state filter, sorted by first setup then title; no setup last', () => {
    const t = (title, status, firstSetup) => ({ id: title, title, status, firstSetup });
    const list = [t('Zed', 'planted', 5), t('Alpha', 'planned', null), t('Mid', 'planted', 2), t('Beta', 'planned', null)];
    assert.deepEqual(model.visibleThreads(list).map((x) => x.title), ['Mid', 'Zed', 'Alpha', 'Beta']);
    assert.deepEqual(model.visibleThreads(list, { state: 'planned' }).map((x) => x.title), ['Alpha', 'Beta']);
    assert.deepEqual(model.visibleThreads(list, { state: 'paid' }), []);
  });

  test('outlineRows filters by status, POV and thread; empty chapters drop out only while filtering', () => {
    const { model: m } = data.so;
    const total = (rows) => rows.reduce((n, g) => n + g.chapters.reduce((k, c) => k + c.scenes.length, 0), 0);
    assert.equal(total(model.outlineRows(m)), 7);
    assert.equal(total(model.outlineRows(m, { status: 'final' })), m.scenes.filter((s) => s.status === 'final').length);
    const thread = m.threads[0];
    const tagged = model.outlineRows(m, { thread: thread.id });
    assert.deepEqual(tagged.flatMap((g) => g.chapters.flatMap((c) => c.scenes.map((s) => s.title))).sort(), m.scenes.filter((s) => s.tags.some((x) => x.thread_id === thread.id)).map((s) => s.title).sort());
    assert.equal(total(model.outlineRows(m, { pov: m.povs[0] })), m.scenes.filter((s) => s.pov === m.povs[0]).length);
    assert.equal(total(model.outlineRows(m, { status: 'no-such-status' })), 0);
    assert.equal(model.outlineRows(m, { status: 'no-such-status' }).length, 0);
    assert.equal(model.outlineRows(m, { status: 'all', pov: '', thread: '' }).length, m.acts.length);
  });

  test('chapterShiftTarget: end of the previous / next chapter, across acts, into empty chapters, null at the ends', () => {
    const { book } = data.so;
    const flat = book.acts.flatMap((a) => a.chapters);
    const first = flat[0].scenes[0];
    assert.equal(model.chapterShiftTarget(book, first.id, 'left'), null);
    const right = model.chapterShiftTarget(book, first.id, 'right');
    assert.equal(right.chapter, flat[1].chapter);
    assert.equal(right.after, flat[1].scenes[flat[1].scenes.length - 1].id);
    const lastCh = flat[flat.length - 1];
    assert.equal(model.chapterShiftTarget(book, lastCh.scenes[lastCh.scenes.length - 1].id, 'right'), null);
    // across the act boundary (chapter 2 -> chapter 3 is act 1 -> act 2)
    const ch2 = flat.find((c) => c.chapter === 2);
    const cross = model.chapterShiftTarget(book, ch2.scenes[0].id, 'right');
    assert.equal(cross.chapter, 3);
    assert.equal(cross.act, 2);
    // into an empty chapter: after is null
    const b = clone(book);
    const chs = b.acts.flatMap((a) => a.chapters);
    chs[1].scenes = [];
    const empty = model.chapterShiftTarget(b, chs[0].scenes[0].id, 'right');
    assert.equal(empty.chapter, chs[1].chapter);
    assert.equal(empty.after, null);
    assert.equal(model.chapterShiftTarget(book, 'scene_unknown', 'right'), null);
  });

  test('requests: exact routes and bodies (single-list edits use add/remove, base_sha256 only when known)', () => {
    const th = { id: 'thread_X', sha256: 'abc' };
    assert.deepEqual(requests.threadStateRequest('book_1', th, 'planted'), { method: 'POST', url: '/api/books/book_1/threads/thread_X/fields', body: { status: 'planted', base_sha256: 'abc' } });
    assert.deepEqual(requests.threadStateRequest('book_1', { id: 'thread_X', sha256: null }, 'paid').body, { status: 'paid' });
    assert.deepEqual(requests.threadListRequest('book_1', th, 'develop', 'scene_A', true).body, { add: { develop: ['scene_A'] }, base_sha256: 'abc' });
    assert.deepEqual(requests.threadListRequest('book_1', th, 'payoff', 'scene_A', false).body, { remove: { payoff: ['scene_A'] }, base_sha256: 'abc' });
    const card = requests.newCardRequest('book_1', { chapter: 2, act: 1, after: null, title: 'T', slug: 't', summary: '  s  ' });
    assert.equal(card.url, '/api/books/book_1/scenes');
    assert.equal(card.body.status, 'outline');
    assert.equal(card.body.summary, 's');
    assert.ok(!('summary' in requests.newCardRequest('book_1', { chapter: 2, act: 1, after: null, title: 'T', slug: 't' }).body));
    assert.deepEqual(requests.sceneFieldsRequest('book_1', 'scene_A', { summary: 'x' }), { method: 'POST', url: '/api/books/book_1/scenes/scene_A/fields', body: { summary: 'x' } });
    assert.deepEqual(requests.newThreadRequest('book_1', { title: 'T', kind: 'arc' }).body, { title: 'T', kind: 'arc', status: 'planned' });
  });
});

// ---------------------------------------------------------------- acceptance 6: render

describe('Board', () => {
  const props = () => ({ bookId: SO, model: data.so.model });

  test('one column per chapter with its act heading; cards in book order; counts in the column head', () => {
    const html = render(h(views.BoardView, props()));
    const { model: m } = data.so;
    assert.equal(count(html, /data-chapter-column="/g), m.chapters.length);
    assert.equal(count(html, /<section[^>]*class="board-act"/g), m.acts.length);
    for (const a of m.acts) assert.ok(html.includes(`>${a.name}<`), a.name);
    const order = [...html.matchAll(/<li[^>]*class="board-card[^"]*"[^>]*data-scene-id="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(order, m.scenes.map((s) => s.id));
    for (const ch of m.chapters) assert.match(textOf(html), new RegExp(`${ch.scenes.length} ${ch.scenes.length === 1 ? 'card' : 'cards'}, ${ch.words}w`));
  });

  test('card fields: title link, summary or "No summary yet", status, POV initial, word count', () => {
    const html = render(h(views.BoardView, props()));
    const card = (id) => new RegExp(`<li[^>]*data-scene-id="${id}"[\\s\\S]*?</li>\\s*(?=<li[^>]*data-scene-id=|</ul>)`).exec(html)?.[0] ?? '';
    const key = data.so.model.scenes.find((s) => s.title === 'The Key');
    const keyHtml = card(key.id);
    assert.ok(keyHtml.includes('Maren finds the key under the porch step.'));
    assert.ok(keyHtml.includes('The Key'));
    assert.match(keyHtml, /Status: drafting/);
    assert.match(keyHtml, /POV maren-hollis/);
    assert.match(textOf(keyHtml), new RegExp(`${key.word_count} words`));
    assert.ok(keyHtml.includes(`href="/books/${SO}?scene=${key.id}"`), 'title links to the scene in Write');
    const ferry = data.so.model.scenes.find((s) => s.title === 'Ferry');
    assert.ok(card(ferry.id).includes('No summary yet'));
    assert.ok(!card(key.id).includes('No summary yet'));
  });

  test('thread tags show the thread title with S / D / P markers; own-only tags have no marker', () => {
    const html = render(h(views.BoardView, props()));
    const { model: m } = data.so;
    const tagOf = (title) => {
      const id = m.scenes.find((s) => s.title === title).id;
      const card = new RegExp(`<li[^>]*data-scene-id="${id}"[\\s\\S]*?</ul>`).exec(html)?.[0] ?? '';
      return card;
    };
    const key = tagOf('The Key');
    assert.ok(key.includes('The brass key'));
    assert.deepEqual([...key.matchAll(/data-role="([SDP])"/g)].map((x) => x[1]), ['S']);
    assert.deepEqual([...tagOf('The Wall').matchAll(/data-role="([SDP])"/g)].map((x) => x[1]), ['P']);
    const prologue = tagOf('Before the Tide');
    assert.ok(prologue.includes('The brass key'));
    assert.equal(count(prologue, /data-role=/g), 0);
    assert.ok(!/class="card-tags"/.test(new RegExp(`<li[^>]*data-scene-id="${m.scenes.find((s) => s.title === 'Arrival').id}"[\\s\\S]*?</li>`).exec(html)[0]), 'a card without threads has no tag list');
  });

  test('a develop-listed scene shows a D marker', () => {
    const planning = clone(data.so.planning);
    const g = data.so.model.scenes.find((s) => s.title === 'The Grafting');
    planning.threads[0].develop = [g.id];
    const m = model.buildModel(data.so.book, planning);
    const html = render(h(views.BoardView, { bookId: SO, model: m }));
    const card = new RegExp(`<li[^>]*data-scene-id="${g.id}"[\\s\\S]*?</ul>`).exec(html)[0];
    assert.deepEqual([...card.matchAll(/data-role="([SDP])"/g)].map((x) => x[1]), ['D']);
  });

  test('an empty chapter is an empty column with "Add a card"', () => {
    const book = clone(data.so.book);
    const ch = book.acts.flatMap((a) => a.chapters).find((c) => c.chapter === 0);
    ch.scenes = [];
    const m = model.buildModel(book, data.so.planning);
    const html = render(h(views.BoardView, { bookId: SO, model: m, onNewCard: noop }));
    const col = new RegExp('<section[^>]*data-chapter-column="0"[\\s\\S]*?</section>').exec(html)[0];
    assert.equal(count(col, /data-scene-id=/g), 0);
    assert.match(textOf(col), /0 cards/);
    assert.ok(col.includes('Add a card'));
  });

  test('"Add a card" appears in every column when the page can create cards, and nowhere when it cannot', () => {
    const { model: m } = data.so;
    assert.equal(count(render(h(views.BoardView, { ...props(), onNewCard: noop })), /Add a card/g), m.chapters.length);
    assert.equal(count(render(h(views.BoardView, props())), /Add a card/g), 0);
  });

  test('cards are draggable and have a Move... / Edit card... menu only when the page handles them', () => {
    const full = render(h(views.BoardView, { ...props(), onMove: noop, onEdit: noop, onMoveDialog: noop }));
    assert.equal(count(full, /<li[^>]*class="board-card[^"]*"[^>]*draggable="true"/g), 7);
    assert.equal(count(full, /aria-haspopup="menu"/g), 7, 'one card menu per card');
    const bare = render(h(views.BoardView, props()));
    assert.equal(count(bare, /draggable="true"/g), 0);
    assert.equal(count(bare, /aria-haspopup="menu"/g), 0);
    assert.equal(count(bare, /<button/g), 0, 'a read-only board has no buttons at all');
  });

  test('keeps an aria-live announcer for drags and keyboard moves', () => {
    assert.match(render(h(views.BoardView, props())), /role="status"[^>]*aria-live="polite"/);
  });

  test('a book with no chapters says so instead of rendering nothing', () => {
    const m = model.buildModel({ id: SO, acts: [] }, { threads: [], scenes: [] });
    assert.match(textOf(render(h(views.BoardView, { bookId: SO, model: m }))), /no chapters yet/i);
  });
});

describe('Outline', () => {
  test('table headers, grouped by act and chapter, rows link to the scene in Write', () => {
    const { model: m } = data.so;
    const html = render(h(views.OutlineView, { bookId: SO, model: m }));
    const heads = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((x) => x[1]);
    assert.deepEqual(heads, ['Chapter', 'Scene', 'Summary', 'POV', 'Status', 'Words', 'Threads']);
    assert.equal(count(html, /outline-table-act/g), m.acts.length);
    assert.equal(count(html, /outline-table-chapter/g), m.chapters.length);
    for (const s of m.scenes) assert.ok(rowOf(html, s.id).includes(`href="/books/${SO}?scene=${s.id}"`), s.title);
    assert.match(textOf(html), /7 scenes/);
  });

  test('summary text or "No summary yet"; status and word count per row', () => {
    const { model: m } = data.so;
    const html = render(h(views.OutlineView, { bookId: SO, model: m }));
    const key = m.scenes.find((s) => s.title === 'The Key');
    assert.ok(rowOf(html, key.id).includes('Maren finds the key under the porch step.'));
    assert.ok(rowOf(html, m.scenes.find((s) => s.title === 'Ferry').id).includes('No summary yet'));
    assert.match(textOf(rowOf(html, key.id)), new RegExp(`drafting\\s*${key.word_count}`));
  });

  test('filters: status, POV and thread selects list every option; initial filters narrow the rows', () => {
    const { model: m } = data.so;
    const html = render(h(views.OutlineView, { bookId: SO, model: m }));
    const select = (name) => new RegExp(`<select name="${name}"[\\s\\S]*?</select>`).exec(html)?.[0] ?? '';
    assert.deepEqual([...select('status').matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', 'outline', 'drafting', 'revised', 'final']);
    assert.deepEqual([...select('pov').matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', ...m.povs]);
    assert.deepEqual([...select('thread').matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]), ['', ...m.threads.map((t) => t.id)]);
    assert.ok(!/Clear filters/.test(html));

    const only = render(h(views.OutlineView, { bookId: SO, model: m, initialFilters: { thread: m.threads[0].id } }));
    const want = m.scenes.filter((s) => s.tags.some((t) => t.thread_id === m.threads[0].id));
    assert.equal(count(only, /<tr[^>]*data-scene-id=/g), want.length);
    assert.ok(want.length > 0 && want.length < m.scenes.length);
    assert.match(textOf(only), new RegExp(`${want.length} scenes? match`));
    assert.ok(/Clear filters/.test(only));
    const none = render(h(views.OutlineView, { bookId: SO, model: m, initialFilters: { status: 'final' } }));
    if (!m.scenes.some((s) => s.status === 'final')) assert.match(textOf(none), /No scenes match these filters/);
  });

  test('inline editing controls exist only when the page can save; none otherwise', () => {
    const { model: m } = data.so;
    const bare = render(h(views.OutlineView, { bookId: SO, model: m }));
    assert.equal(count(bare, /<select aria-label="Status of/g), 0);
    assert.equal(count(bare, /aria-label="Edit summary of/g), 0);
    const edit = render(h(views.OutlineView, { bookId: SO, model: m, onSetFields: noop }));
    assert.equal(count(edit, /<select aria-label="Status of/g), m.scenes.length);
    assert.equal(count(edit, /aria-label="Edit summary of/g), m.scenes.length);
    const key = m.scenes.find((s) => s.title === 'The Key');
    assert.match(rowOf(edit, key.id), /<option value="drafting" selected/);
  });

  test('an empty book says so', () => {
    const m = model.buildModel({ id: SO, acts: [] }, { threads: [], scenes: [] });
    assert.match(textOf(render(h(views.OutlineView, { bookId: SO, model: m }))), /no scenes yet/i);
  });
});

describe('Threads list and inspector', () => {
  test('a thread row shows title, kind, state chip with text, S/D/P counts and where it was last touched', () => {
    const html = render(h(views.ThreadsView, { model: data.so.model }));
    const row = textOf(new RegExp('<li[^>]*class="thread-row"[\\s\\S]*?</li>').exec(html)[0]);
    assert.match(row, /The brass key/);
    assert.match(row, /mystery/);
    assert.match(row, /Paid/);
    assert.match(row, /S 1\s*D 0\s*P 1/);
    assert.match(row, /Last touched in Ch 3/);
    assert.match(textOf(html), /1 thread/);
  });

  test('legacy state shows as text; the state filter offers the six states and only legacy ones in use', () => {
    const html = render(h(views.ThreadsView, { model: data.cg.model })); // the-key-mystery is legacy "open"
    assert.match(textOf(html), /Open \(legacy\)/);
    const opts = [...new RegExp('<select name="state"[\\s\\S]*?</select>').exec(html)[0].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(opts, ['all', 'planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved', 'open']);
    const so = render(h(views.ThreadsView, { model: data.so.model }));
    assert.ok(!/value="open"/.test(so) && !/value="abandoned"/.test(so));
  });

  test('state filter narrows the list and empty / no-thread states have messages', () => {
    assert.match(textOf(render(h(views.ThreadsView, { model: data.so.model, initialState: 'planned' }))), /No threads in that state/);
    const none = model.buildModel(data.so.book, { threads: [], scenes: data.so.planning.scenes });
    assert.match(textOf(render(h(views.ThreadsView, { model: none }))), /no plot threads yet/i);
  });

  test('"New thread" appears only when the page can create one', () => {
    assert.ok(!/New thread/.test(render(h(views.ThreadsView, { model: data.so.model }))));
    assert.ok(/New thread/.test(render(h(views.ThreadsView, { model: data.so.model, onNewThread: noop }))));
  });

  test('inspector: state select with all six states (+ the legacy one present), lists with links, characters', () => {
    const so = data.so.model;
    const html = render(h(views.ThreadInspector, { bookId: SO, model: so, thread: so.threads[0], body: 'What the key opens.\n', onState: noop }));
    const opts = [...new RegExp('<select name="state"[\\s\\S]*?</select>').exec(html)[0].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(opts, ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved']);
    assert.match(html, /<option value="paid" selected/);
    for (const role of ['setup', 'develop', 'payoff']) assert.ok(html.includes(`data-list="${role}"`));
    const sec = (list) => new RegExp(`data-list="${list}"[\\s\\S]*?</section>`).exec(html)[0];
    assert.match(sec('setup'), /The Key/);
    assert.match(sec('payoff'), /The Wall/);
    assert.match(textOf(sec('develop')), /No scenes yet/);
    assert.ok(html.includes(`href="/books/${SO}?scene=${so.threads[0].setup[0]}"`));
    assert.match(textOf(html), /What the key opens/);
    assert.match(textOf(html), /maren-hollis/);

    const cg = data.cg.model;
    const legacy = render(h(views.ThreadInspector, { bookId: CG, model: cg, thread: cg.threads[0], onState: noop }));
    const lopts = [...new RegExp('<select name="state"[\\s\\S]*?</select>').exec(legacy)[0].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(lopts.slice(-1), ['open']);
    assert.equal(lopts.length, 7);
  });

  test('inspector: no thread selected, loading and empty bodies', () => {
    const so = data.so.model;
    assert.match(textOf(render(h(views.ThreadInspector, { bookId: SO, model: so, thread: null }))), /Select a thread/);
    assert.match(textOf(render(h(views.ThreadInspector, { bookId: SO, model: so, thread: so.threads[0], body: null }))), /Loading/);
    assert.match(textOf(render(h(views.ThreadInspector, { bookId: SO, model: so, thread: so.threads[0], body: '  \n' }))), /Nothing written yet/);
  });

  test('inspector: add / remove controls exist only with their handlers; the picker excludes scenes already listed', () => {
    const so = data.so.model;
    const t = so.threads[0];
    const bare = render(h(views.ThreadInspector, { bookId: SO, model: so, thread: t, body: '' }));
    assert.equal(count(bare, /<button/g), 0);
    assert.equal(count(bare, /<select/g), 0);
    const full = render(h(views.ThreadInspector, { bookId: SO, model: so, thread: t, body: '', onAddScene: noop, onRemoveScene: noop, onEditText: noop, onState: noop }));
    assert.equal(count(full, /aria-label="Remove [^"]* from (setup|development|payoff)"/g), t.setup.length + t.develop.length + t.payoff.length);
    assert.ok(full.includes('Edit text'));
    const setupPicker = new RegExp('<select aria-label="Add a scene to setup"[\\s\\S]*?</select>').exec(full)[0];
    assert.equal(count(setupPicker, /<option value="scene_/g), so.scenes.length - t.setup.length);
    assert.ok(!setupPicker.includes(`value="${t.setup[0]}"`));
    assert.ok(/<button type="submit" class="btn row-button" disabled/.test(full), 'Add is disabled until a scene is picked');
  });
});

describe('lifecycle suggestions render only where applicable and never apply themselves', () => {
  const planned = () => {
    const planning = clone(data.so.planning);
    planning.threads[0] = { ...planning.threads[0], status: 'planned', develop: [], payoff: [] };
    return model.buildModel(data.so.book, planning);
  };
  const buttons = (html) => [...html.matchAll(/<button[^>]*class="btn lifecycle-suggest"[^>]*data-to="([^"]+)"[^>]*>([^<]*)</g)].map((x) => `${x[1]}:${x[2]}`);

  test('planned thread whose setup has a scene: "Mark as planted"; with a payoff too: "Mark as paid"', () => {
    const m = planned();
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: m, onSuggest: noop }))), ['planted:Mark as planted']);
    const planning = clone(data.so.planning);
    planning.threads[0] = { ...planning.threads[0], status: 'planned' };
    const both = model.buildModel(data.so.book, planning);
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: both, onSuggest: noop }))), ['planted:Mark as planted', 'paid:Mark as paid']);
  });

  test('planted + develop scenes: "Mark as developed"', () => {
    const planning = clone(data.so.planning);
    const g = data.so.model.scenes.find((s) => s.title === 'The Grafting').id;
    planning.threads[0] = { ...planning.threads[0], status: 'planted', develop: [g], payoff: [] };
    const m = model.buildModel(data.so.book, planning);
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: m, onSuggest: noop }))), ['developed:Mark as developed']);
    assert.deepEqual(buttons(render(h(views.ThreadInspector, { bookId: SO, model: m, thread: m.threads[0], onSuggest: noop }))), ['developed:Mark as developed']);
  });

  test('no suggestion for the paid salt-orchard thread, the legacy-open codex-graph thread, or without a handler', () => {
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: data.so.model, onSuggest: noop }))), []);
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: data.cg.model, onSuggest: noop }))), []);
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: planned() }))), [], 'no handler: no buttons');
    assert.ok(!/Mark as/.test(render(h(views.ThreadsView, { model: planned() }))));
  });

  test('a planned thread with an empty setup gets no suggestion', () => {
    const planning = clone(data.so.planning);
    planning.threads[0] = { ...planning.threads[0], status: 'planned', setup: [], develop: [], payoff: [] };
    const m = model.buildModel(data.so.book, planning);
    assert.deepEqual(buttons(render(h(views.ThreadsView, { model: m, onSuggest: noop }))), []);
  });
});

describe('Matrix', () => {
  test('rows are scenes in book order grouped by chapter; columns are threads with a state chip', () => {
    const { model: m } = data.so;
    const html = render(h(views.MatrixView, { bookId: SO, model: m }));
    assert.deepEqual([...html.matchAll(/<tr[^>]*data-scene-id="([^"]+)"/g)].map((x) => x[1]), m.scenes.map((s) => s.id));
    assert.equal(count(html, /<tbody[^>]*data-chapter=/g), m.chapters.length);
    const head = /<thead>[\s\S]*?<\/thead>/.exec(html)[0];
    assert.equal(count(head, /data-thread-id=/g), m.threads.length);
    assert.match(textOf(head), /The brass key\s*Paid/);
  });

  test('cells show S / P / a dot, and read-only cells carry an accessible label', () => {
    const { model: m } = data.so;
    const html = render(h(views.MatrixView, { bookId: SO, model: m }));
    const cellText = (title) => textOf(/<td[^>]*class="matrix-cell"[\s\S]*?<\/td>/.exec(rowOf(html, m.scenes.find((s) => s.title === title).id))[0]);
    assert.equal(cellText('The Key'), 'S');
    assert.equal(cellText('The Wall'), 'P');
    assert.equal(cellText('Before the Tide'), '•');
    assert.equal(cellText('Arrival'), '');
    assert.match(html, /aria-label="The brass key in The Key: setup"/);
    assert.match(html, /aria-label="The brass key in Arrival: not used"/);
    assert.match(html, /aria-label="The brass key in Before the Tide: named in the scene's own thread list"/);
  });

  test('a scene can hold several roles (S D) in one cell', () => {
    const planning = clone(data.so.planning);
    const key = data.so.model.scenes.find((s) => s.title === 'The Key').id;
    planning.threads[0].develop = [key];
    const m = model.buildModel(data.so.book, planning);
    const html = render(h(views.MatrixView, { bookId: SO, model: m }));
    assert.equal(textOf(/<td[^>]*class="matrix-cell"[\s\S]*?<\/td>/.exec(rowOf(html, key))[0]), 'S D');
  });

  test('with a handler every cell is a button with a menu; without one there are no buttons', () => {
    const { model: m } = data.so;
    const live = render(h(views.MatrixView, { bookId: SO, model: m, onMark: noop }));
    assert.equal(count(live, /<button[^>]*class="matrix-button"/g), m.scenes.length * m.threads.length);
    assert.equal(count(live, /aria-haspopup="menu"/g), m.scenes.length * m.threads.length);
    assert.equal(count(live, /aria-expanded="true"/g), 0, 'no menu is open at rest');
    assert.equal(count(render(h(views.MatrixView, { bookId: SO, model: m })), /<button/g), 0);
  });

  test('no threads: a message instead of an empty grid', () => {
    const m = model.buildModel(data.so.book, { threads: [], scenes: data.so.planning.scenes });
    const html = render(h(views.MatrixView, { bookId: SO, model: m, onMark: noop }));
    assert.match(textOf(html), /no plot threads yet/i);
    assert.equal(count(html, /<table/g), 0);
  });
});

describe('no dead controls', () => {
  /** Every button has a name, every select has a label, every link a target. */
  function assertLive(html, where) {
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      assert.ok(/aria-label="[^"]+"/.test(m[1]) || textOf(m[2]) !== '', `${where}: a button with no name: ${m[0].slice(0, 120)}`);
    }
    for (const m of html.matchAll(/<select\b([^>]*)>/g)) {
      assert.ok(/aria-label="[^"]+"/.test(m[1]) || /name="[^"]+"/.test(m[1]), `${where}: a select with no label or name: ${m[0]}`);
    }
    for (const m of html.matchAll(/<a\b([^>]*)>/g)) assert.match(m[1], /href="[^"]+"/, `${where}: a link without a target`);
  }

  test('every control of every view, rendered with all handlers, has a name or label', () => {
    const handlers = { onMove: noop, onNewCard: noop, onEdit: noop, onMoveDialog: noop, onSetFields: noop, onNewThread: noop, onSuggest: noop, onMark: noop, onSelect: noop };
    for (const key of ['so', 'cg']) {
      const { model: m, bookId } = data[key];
      assertLive(render(h(views.BoardView, { bookId, model: m, ...handlers })), `board ${key}`);
      assertLive(render(h(views.OutlineView, { bookId, model: m, ...handlers })), `outline ${key}`);
      assertLive(render(h(views.ThreadsView, { model: m, ...handlers })), `threads ${key}`);
      assertLive(render(h(views.MatrixView, { bookId, model: m, ...handlers })), `matrix ${key}`);
      assertLive(render(h(views.ThreadInspector, { bookId, model: m, thread: m.threads[0], body: 'Text.', onAddScene: noop, onRemoveScene: noop, onEditText: noop, onState: noop, onSuggest: noop, onSetCharacters: noop, objects: [] })), `inspector ${key}`);
    }
  });

  test('every read-only view renders without a single button', () => {
    const { model: m } = data.so;
    for (const [name, html] of [
      ['board', render(h(views.BoardView, { bookId: SO, model: m }))],
      ['matrix', render(h(views.MatrixView, { bookId: SO, model: m }))],
      ['inspector', render(h(views.ThreadInspector, { bookId: SO, model: m, thread: m.threads[0], body: 'Text.' }))],
      ['threads', render(h(views.ThreadsView, { model: m }))],
    ]) {
      const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((x) => textOf(x[1]));
      // the thread list's rows are selection buttons by design; everything else must have no button at all
      if (name === 'threads') assert.equal(buttons.length, m.threads.length, name);
      else assert.deepEqual(buttons, [], name);
    }
  });
});
