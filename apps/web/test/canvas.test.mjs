// M09-J01 acceptance 7 (web half, no browser): the Canvas model (kinds, Markdown blocks, to-dos, column layout, edge geometry, fitting, history, names, links)
// and render tests of the page with a real repository answer (a copy of salt-orchard with one canvas holding every kind of card), plus the a11y audit.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { copyFixture } from '../../server/test/helpers.mjs';
import { audit } from './a11y-check.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const BOOK = 'book_01S5000000000000000000000A';
const MAREN = 'entry_01S5000000000000000000000G';
const KEY = 'scene_01S50000000000000000000003';
let vite;
let model;
let page;
const d = {};
const html = (el) => renderToStaticMarkup(el);
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const node = (id, extra) => ({ id, type: 'text', text: '', x: 0, y: 0, width: 100, height: 60, ...extra });

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  model = await vite.ssrLoadModule('/src/canvas/model.js');
  page = await vite.ssrLoadModule('/src/canvas/CanvasView.jsx');
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    await repo.createCanvas(BOOK, { title: 'Neon Shadows' });
    const got = await repo.getCanvas(BOOK, 'neon-shadows');
    const canvas = {
      ...got.canvas,
      nodes: [
        node('n1', { text: '# Atmosphere\n- rain-slicked streets\n[ref](https://example.com/a) and [bad](javascript:alert(1))', x: 0, y: 0, width: 260, height: 160 }),
        node('t1', { text: 'Shot list\n- [x] alley\n- [ ] rooftop', x: 300, y: 0, width: 260, height: 160, storyforge: { kind: 'todo' } }),
        node('s1', { text: '**Pearl Bush**\n#E8DDD4', color: '#E8DDD4', x: 600, y: 0, width: 140, height: 150, storyforge: { kind: 'swatch', name: 'Pearl Bush', hex: '#E8DDD4' } }),
        { id: 'c1', type: 'file', file: 'x.md', x: 0, y: 200, width: 260, height: 150, storyforge: { ref: MAREN } },
        { id: 'c2', type: 'file', file: 'gone.md', x: 300, y: 200, width: 260, height: 150, storyforge: { ref: 'entry_GONE' } },
        { id: 'i1', type: 'file', file: 'assets/canvas/city.png', x: 600, y: 200, width: 280, height: 200 },
        { id: 'l1', type: 'link', url: 'https://example.com/blade', x: 0, y: 400, width: 260, height: 90 },
        { id: 'w1', type: 'group', label: 'Central themes', x: 900, y: 0, width: 300, height: 360, storyforge: { kind: 'column' } },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 't1', toEnd: 'arrow', label: 'leads to' }],
    };
    const saved = await repo.saveCanvas(BOOK, 'neon-shadows', { canvas, baseSha256: got.sha256 });
    assert.ok(saved.ok, JSON.stringify(saved));
    d.list = JSON.parse(JSON.stringify(await repo.listCanvases(BOOK)));
    d.open = JSON.parse(JSON.stringify(await repo.getCanvas(BOOK, 'neon-shadows')));
  } finally {
    await repo.close?.();
  }
});
after(async () => {
  await vite?.close();
});

describe('model', () => {
  test('kinds: every card type maps to what the author sees', () => {
    const k = (n) => model.nodeKind(n);
    assert.equal(k(node('a')), 'note');
    assert.equal(k(node('a', { storyforge: { kind: 'todo' } })), 'todo');
    assert.equal(k(node('a', { storyforge: { kind: 'swatch', hex: '#112233' } })), 'swatch');
    assert.equal(k(node('a', { storyforge: { kind: 'swatch', hex: 'nope' } })), 'note', 'a broken swatch is shown as a note');
    assert.equal(k({ type: 'file', file: 'assets/canvas/a.webp' }), 'image');
    assert.equal(k({ type: 'file', file: 'research/a.pdf' }), 'file');
    assert.equal(k({ type: 'file', file: 'x.md', storyforge: { ref: 'r' } }), 'story');
    assert.equal(k({ type: 'link', url: 'x' }), 'link');
    assert.equal(k({ type: 'group' }), 'group');
    assert.equal(k({ type: 'group', storyforge: { kind: 'column' } }), 'column');
  });

  test('makeNode: centred and snapped, with the JSON Canvas fields of each kind', () => {
    const rand = seq(0.1);
    const sw = model.makeNode('swatch', { x: 100, y: 100 }, { hex: '#e8ddd4', name: 'Pearl' }, rand);
    assert.deepEqual([sw.type, sw.color, sw.text, sw.storyforge], ['text', '#E8DDD4', '**Pearl**\n#E8DDD4', { kind: 'swatch', name: 'Pearl', hex: '#E8DDD4' }]);
    assert.equal(sw.x % 8, 0);
    assert.equal(sw.id.length, 16);
    assert.deepEqual(model.makeNode('story', { x: 0, y: 0 }, { ref: 'entry_1' }, rand).storyforge, { ref: 'entry_1' });
    assert.equal(model.makeNode('column', { x: 0, y: 0 }, {}, rand).storyforge.kind, 'column');
    assert.match(model.makeNode('todo', { x: 0, y: 0 }, {}, rand).text, /^- \[ \]/);
  });

  test('Markdown: safe blocks only; a link that is not http(s) or mailto stays text', () => {
    const b = model.markdownBlocks('# Title\n\nPlain **bold** _it_ `code`\n- item\n- [x] done\n---\n[ok](https://a.example/x) [no](javascript:alert(1)) <b>raw</b>');
    assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'li', 'task', 'hr', 'p']);
    assert.deepEqual(b[1].runs.map((r) => r.t), ['text', 'b', 'text', 'i', 'text', 'code']);
    const links = b[5].runs.filter((r) => r.t === 'link');
    assert.deepEqual(links.map((l) => l.text), ['ok']);
    assert.ok(b[5].runs.some((r) => r.t === 'text' && r.text.includes('javascript:')));
    assert.ok(b[5].runs.some((r) => r.text.includes('<b>raw</b>')), 'HTML is text, never markup');
  });

  test('to-dos: toggle a line, count, ignore other lines', () => {
    const t = 'List\n- [ ] one\n- [x] two\nnot a task';
    assert.equal(model.toggleTask(t, 1), 'List\n- [x] one\n- [x] two\nnot a task');
    assert.equal(model.toggleTask(t, 2), 'List\n- [ ] one\n- [ ] two\nnot a task');
    assert.equal(model.toggleTask(t, 3), t);
    assert.deepEqual(model.taskCounts(t), { done: 1, total: 2 });
  });

  test('columns: members stack top to bottom at the column width; the column grows to fit; groups carry what they contain', () => {
    const col = { id: 'w', type: 'group', label: 'W', x: 0, y: 0, width: 300, height: 400, storyforge: { kind: 'column' } };
    const a = node('a', { x: 50, y: 60, height: 100 });
    const b = node('b', { x: 10, y: 20, height: 50 });
    const out = node('o', { x: 900, y: 0 });
    const c = model.layoutColumns({ nodes: [col, a, b, out], edges: [] });
    const at = (id) => c.nodes.find((n) => n.id === id);
    assert.deepEqual([at('b').x, at('b').y, at('b').width], [12, 44, 276], 'the higher card comes first');
    assert.deepEqual([at('a').x, at('a').y], [12, 44 + 50 + 12]);
    assert.equal(at('w').height, 44 + 50 + 12 + 100 + 12);
    assert.deepEqual(at('o'), out, 'a card outside is left alone');
    assert.equal(model.layoutColumns(c), c, 'a laid-out canvas is returned as it is');
    const g = { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500 };
    assert.deepEqual(model.carried([g, a, out], g).map((n) => n.id), ['a']);
  });

  test('edges: facing sides, a curve between them, a label point between the ends', () => {
    const a = node('a', { x: 0, y: 0, width: 100, height: 100 });
    const b = node('b', { x: 300, y: 0, width: 100, height: 100 });
    const g = model.edgeGeometry({ id: 'e', fromNode: 'a', toNode: 'b' }, a, b);
    assert.deepEqual([g.fromSide, g.toSide, g.a, g.b], ['right', 'left', { x: 100, y: 50 }, { x: 300, y: 50 }]);
    assert.match(g.d, /^M 100 50 C /);
    assert.ok(g.mid.x > 100 && g.mid.x < 300);
    assert.deepEqual(model.facingSides(a, node('c', { x: 0, y: 400 })), ['bottom', 'top']);
    const c = model.connect({ nodes: [a, b], edges: [] }, 'a', 'b', seq(0.5));
    assert.equal(c.edges.length, 1);
    assert.equal(model.connect(c, 'a', 'b'), c, 'no duplicate');
    assert.equal(model.connect(c, 'a', 'a'), c, 'no self-loop');
  });

  test('view: fit, zoom about a point, screen to world', () => {
    const v = model.fitView({ x: 0, y: 0, width: 1000, height: 500 }, 1096, 596, 48);
    assert.equal(v.zoom, 1);
    assert.deepEqual([v.x, v.y], [48, 48]);
    assert.deepEqual(model.fitView(null, 800, 600), { x: 400, y: 300, zoom: 1 });
    const z = model.zoomAt({ x: 0, y: 0, zoom: 1 }, 2, 100, 100);
    assert.deepEqual(model.toWorld(z, 100, 100), { x: 100, y: 100 }, 'the point under the pointer stays still');
    assert.equal(model.clampZoom(99), model.ZOOM_MAX);
  });

  test('edits and history: remove takes its edges; duplicate copies edges between copies; undo / redo', () => {
    const c = { nodes: [node('a'), node('b'), node('c')], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] };
    assert.deepEqual(model.removeIds(c, new Set(['b'])).edges, []);
    const dup = model.duplicate(c, new Set(['a', 'b']), seq(0.3, 0.6, 0.9));
    assert.equal(dup.canvas.nodes.length, 5);
    assert.equal(dup.canvas.edges.length, 2);
    let hst = model.history(c);
    const c2 = model.moveBy(c, new Set(['a']), 8, 0);
    hst = model.record(hst, c2);
    assert.equal(model.record(hst, c2), hst, 'the same document records nothing');
    hst = model.undo(hst);
    assert.equal(hst.present, c);
    hst = model.redo(hst);
    assert.equal(hst.present, c2);
  });

  test('names and links: accessible names per kind; story cards open the real thing', () => {
    assert.equal(model.cardName(node('s', { storyforge: { kind: 'swatch', name: 'Pearl Bush', hex: '#e8ddd4' } })), 'Swatch: Pearl Bush #E8DDD4');
    assert.equal(model.cardName(node('t', { text: 'Shots\n- [x] a\n- [ ] b', storyforge: { kind: 'todo' } })), 'To-do: Shots (1 of 2 done)');
    assert.equal(model.cardName({ type: 'file', file: 'x', storyforge: { ref: 'r' } }, { state: 'ok', kind: 'entry', title: 'Maren' }), 'Codex: Maren');
    assert.equal(model.cardName({ type: 'link', url: 'mailto:a@b.example' }), 'Link: mailto:a@b.example');
    assert.equal(model.storyHref('b', { kind: 'scene', id: 's' }), '/books/b?scene=s');
    assert.equal(model.storyHref('b', { kind: 'entry', id: 'e', slug: 'maren' }), '/books/b/codex?entry=maren');
    assert.equal(model.storyHref('b', { kind: 'thread', id: 't' }), '/books/b?view=threads&thread=t');
    assert.equal(model.storyHref('b', { kind: 'event', id: 'v' }), '/books/b/timeline?event=v');
    assert.equal(model.storyHref('b', { kind: 'research', id: 'n' }), '/books/b/notes?note=n');
    assert.equal(model.safeUrl('javascript:alert(1)'), null);
    assert.equal(model.inkOn('#FFFFFF'), '#141414');
    assert.equal(model.inkOn('#000000'), '#F5F5F5');
    assert.deepEqual(model.hexToRgb('#E8DDD4'), [232, 221, 212]);
  });
});

describe('page', () => {
  const render = (props = {}) =>
    html(h(page.CanvasPage, { bookId: BOOK, list: d.list, slug: 'neon-shadows', onNew: () => {}, onArchive: () => {}, onRestore: () => {}, initial: d.open, ...props }));

  test('the repository answer: refs resolve, targets list scenes and entries, the story card file was refreshed', () => {
    assert.equal(d.open.refs.c1.state, 'ok');
    assert.equal(d.open.refs.c1.title, 'Maren Hollis');
    assert.equal(d.open.refs.c2.state, 'broken');
    assert.equal(d.open.canvas.nodes.find((n) => n.id === 'c1').file, 'codex/characters/maren-hollis.md');
    assert.ok(d.open.targets.some((t) => t.ref === KEY && t.kind === 'scene'));
    assert.deepEqual(d.list.canvases.map((c) => [c.slug, c.title, c.nodes]), [['neon-shadows', 'Neon Shadows', 8]]);
  });

  test('every kind of card renders with its name; links are safe; the toolbar names every tool', () => {
    const markup = render();
    for (const name of ['Note: Atmosphere', 'To-do: Shot list (1 of 2 done)', 'Swatch: Pearl Bush #E8DDD4', 'Codex: Maren Hollis', 'Story card: missing entry_GONE', 'Image: city.png', 'Link: example.com', 'Column: Central themes']) {
      assert.ok(markup.includes(`aria-label="${name}`), name);
    }
    assert.match(markup, /href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(markup, /href="javascript:/);
    assert.match(markup, /Missing from the book/);
    assert.match(markup, /href="\/books\/book_01S5000000000000000000000A\/codex\?entry=maren-hollis"/);
    assert.match(markup, /src="\/api\/books\/book_01S5000000000000000000000A\/attachments\?path=assets%2Fcanvas%2Fcity\.png"/);
    assert.match(markup, /RGB \(232, 221, 212\)/);
    assert.match(markup, /type="checkbox" aria-label="Task: alley" checked=""/);
    assert.match(markup, /type="checkbox" aria-label="Task: rooftop"\/>/);
    assert.match(markup, /class="cv-edge-label"[^>]*>leads to</);
    const toolbar = /<div class="cv-toolbar" role="toolbar" aria-label="Add to the canvas">([\s\S]*?)<\/div>/.exec(markup)[1];
    assert.deepEqual([...toolbar.matchAll(/aria-label="([^"]+)"/g)].map((x) => x[1]), ['Note', 'To-do list', 'Colour swatch', 'Image', 'Story card', 'Web link', 'Column', 'Group', 'Connect two cards']);
    assert.match(toolbar, /aria-keyshortcuts="N"/);
    assert.match(markup, /planning\/canvases\/neon-shadows\.canvas/);
  });

  test('cards come in reading order (top-left first) so Tab walks them sensibly', () => {
    const markup = render();
    const names = [...markup.matchAll(/class="cv-node cv-(?!column|group)[^"]*"[^>]*aria-label="([^"]+)"/g)].map((x) => x[1].split(':')[0]);
    assert.deepEqual(names, ['Note', 'To-do', 'Swatch', 'Codex', 'Story card', 'Image', 'Link']);
  });

  test('an empty book: the start panel and the New canvas button; an unreadable file opens read-only without a toolbar', () => {
    const empty = html(h(page.CanvasPage, { bookId: BOOK, list: { canvases: [], archived: [] }, slug: null, onNew: () => {}, onArchive: () => {}, onRestore: () => {} }));
    assert.match(empty, /Start a canvas/);
    assert.equal([...empty.matchAll(/>New canvas</g)].length, 2);
    const broken = render({ initial: { ...d.open, problem: 'not JSON', canvas: { nodes: [], edges: [] } } });
    assert.match(broken, /cannot be read as a canvas \(not JSON\)/);
    assert.doesNotMatch(broken, /role="toolbar"/);
  });

  test('archived canvases are listed with Restore', () => {
    const markup = render({ list: { ...d.list, archived: [{ slug: 'old', title: 'Old board', nodes: 0 }] } });
    assert.match(markup, /Archived \(1\)/);
    assert.match(markup, /Old board/);
    assert.match(markup, />Restore</);
  });

  test('accessibility audit of the page', () => {
    assert.deepEqual(audit(`<main id="main">${render()}</main>`, { landmarks: ['main'] }), []);
  });
});
