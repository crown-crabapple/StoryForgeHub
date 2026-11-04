// M04-J02 acceptance 1: the Codex page rendered with fixture data (codex-graph and salt-orchard): sidebar types and counts,
// header counts, card fields, inspector facts / sections / presence bars / appears-in / relationships; plus the pure logic
// behind it (filter, sort, blurb, presence, needs-review rule).
//
// Fixture data is the real answer of the core repository (listCodexEntries / getCodexTypes) over a copy of each fixture, so the
// page is rendered with what the API returns. Component props follow the JSDoc of apps/web/src/codex/CodexPage.jsx and friends.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
let page;
let card;
let inspector;
let bars;
const data = {};

async function load(fixture, bookId) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-codex-'));
  const root = path.join(base, fixture);
  await fs.cp(path.join(FIXTURES, fixture), root, { recursive: true });
  const repo = createFsRepository(root);
  const { entries, chapters } = await repo.listCodexEntries(bookId);
  return { bookId, types: await repo.getCodexTypes(bookId), entries, chapters };
}

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  model = await vite.ssrLoadModule('/src/codex/model.js');
  page = await vite.ssrLoadModule('/src/codex/CodexPage.jsx');
  card = await vite.ssrLoadModule('/src/codex/CodexCard.jsx');
  inspector = await vite.ssrLoadModule('/src/codex/EntryInspector.jsx');
  bars = await vite.ssrLoadModule('/src/codex/PresenceBars.jsx');
  data.cg = await load('codex-graph', CG);
  data.so = await load('salt-orchard', SO);
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const bySlug = (set, slug) => set.entries.find((e) => e.slug === slug);

function renderPage(set, props = {}) {
  return renderToStaticMarkup(h(page.CodexPage, { bookId: set.bookId, types: set.types, entries: set.entries, chapters: set.chapters, typeKey: 'all', ...props }));
}
function sidebar(html) {
  const tablist = /<div[^>]*role="tablist"[^>]*aria-label="Codex sections"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  return [...tablist.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((m) => ({ attrs: m[1], text: textOf(m[2]) }))
    .map((b) => ({ ...b, ...(/^(.*?)\s*(\d+)$/.exec(b.text) ? { label: /^(.*?)\s*(\d+)$/.exec(b.text)[1], count: Number(/^(.*?)\s*(\d+)$/.exec(b.text)[2]) } : {}) }))
    .filter((b) => b.label !== undefined);
}
function cardHtml(html, id) {
  return new RegExp(`<button\\b[^>]*data-entry-id="${id}"[\\s\\S]*?</button>`).exec(html)?.[0] ?? '';
}
const anchors = (html) => [...decode(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: /href="([^"]*)"/.exec(m[1])?.[1] ?? null, text: textOf(m[2]) }));

// ------------------------------------------------------------------------------------------------ sidebar

describe('section tabs', () => {
  test('salt-orchard: All, built-in types with counts, Archived; selected row is marked', () => {
    const html = renderPage(data.so, { typeKey: 'character' });
    const rows = sidebar(html);
    assert.deepEqual(
      rows.map((r) => [r.label, r.count]),
      [['All', 10], ['Characters', 4], ['Locations', 2], ['Factions', 1], ['Objects', 2], ['Lore', 1], ['Archived', 0]],
    );
    const current = rows.filter((r) => /aria-selected="true"/.test(r.attrs));
    assert.deepEqual(current.map((r) => r.label), ['Characters']);
  });

  test('codex-graph: custom types (defined Ships, undefined Spells) follow the built-ins, A to Z', () => {
    const rows = sidebar(renderPage(data.cg));
    assert.deepEqual(
      rows.map((r) => [r.label, r.count]),
      [['All', 8], ['Characters', 2], ['Locations', 1], ['Factions', 1], ['Objects', 1], ['Lore', 1], ['Ships', 1], ['Spells', 1], ['Archived', 0]],
    );
  });

  test('an archived entry is counted in Archived only, not in All or its type', () => {
    const maren = bySlug(data.so, 'maren-hollis');
    const entries = data.so.entries.map((e) => (e.id === maren.id ? { ...e, archived: true } : e));
    const rows = sidebar(renderPage({ ...data.so, entries }));
    const count = (label) => rows.find((r) => r.label === label).count;
    assert.equal(count('All'), 9);
    assert.equal(count('Characters'), 3);
    assert.equal(count('Archived'), 1);
  });

  test('custom types are ordered A to Z whatever order the API lists them in', () => {
    const extra = (type, plural) => ({ type, name: plural, plural, fields: [], builtin: false, defined: true, count: 0 });
    const types = [extra('zeppelin', 'Zeppelins'), ...data.cg.types, extra('airship', 'Airships')];
    const labels = sidebar(renderPage({ ...data.cg, types })).map((r) => r.label);
    assert.deepEqual(labels, ['All', 'Characters', 'Locations', 'Factions', 'Objects', 'Lore', 'Airships', 'Ships', 'Spells', 'Zeppelins', 'Archived']);
  });
});

// ------------------------------------------------------------------------------------------------ header

describe('header', () => {
  test('title, "N entries · M need review" for All and for one type (seed and warnings both count)', () => {
    const all = textOf(renderPage(data.so));
    assert.ok(all.includes('10 entries · 3 need review'), 'salt-orchard has three seed entries');
    const chars = renderPage(data.so, { typeKey: 'character' });
    assert.ok(textOf(chars).includes('4 entries · 1 need review'));
    assert.match(chars, /<h1[^>]*>\s*Characters\s*<\/h1>/);
    const cg = textOf(renderPage(data.cg));
    assert.ok(cg.includes('8 entries · 2 need review'), 'codex-graph: two characters carry a W304 warning');
  });

  test('the count ignores the search and status chips; an empty archive reads "0 entries · 0 need review"', () => {
    const narrowed = textOf(renderPage(data.so, { typeKey: 'character', query: 'pell', status: 'seed' }));
    assert.ok(narrowed.includes('4 entries · 1 need review'));
    assert.ok(textOf(renderPage(data.so, { typeKey: 'archived' })).includes('0 entries · 0 need review'));
  });

  test('search box, sort options and status chips', () => {
    const html = renderPage(data.so, { query: 'mare', sort: 'scenes', status: 'canon' });
    assert.match(html, /<input[^>]*aria-label="Search entries"[^>]*value="mare"/);
    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    assert.deepEqual(options, ['Name', 'Most scenes', 'Recently changed']);
    const chips = [...html.matchAll(/<button[^>]*class="chip"[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(chips, [['All', 'false'], ['Seed', 'false'], ['Sketch', 'false'], ['Canon', 'true'], ['Needs review', 'false']]);
  });

  test('"Search text too" is offered only when the page can handle it', () => {
    assert.ok(!textOf(renderPage(data.so)).includes('Search text too'));
    assert.ok(textOf(renderPage(data.so, { onSearchText() {} })).includes('Search text too'));
  });
});

// ------------------------------------------------------------------------------------------------ cards

describe('card grid', () => {
  test('Maren (salt-orchard): initial, name, role, blurb, first seen, scene count, status; the card is a pressed button', () => {
    const maren = bySlug(data.so, 'maren-hollis');
    const html = renderPage(data.so, { typeKey: 'character', selectedId: maren.id });
    const c = cardHtml(html, maren.id);
    assert.ok(c.startsWith('<button'), 'the whole card is a button');
    assert.match(c, /type="button"/);
    assert.match(c, /aria-pressed="true"/);
    assert.match(c, /class="codex-avatar[^"]*"[^>]*>M</, 'avatar initial');
    const t = textOf(c);
    for (const part of ['Maren Hollis', 'Protagonist', 'Cartographer who maps coastlines for a living and avoids her own.', 'First seen Ch 1', '6 scenes', 'Canon']) {
      assert.ok(t.includes(part), `card says "${part}": ${t}`);
    }
  });

  test('Pell: seed status, role, a scene count that is not pressed', () => {
    const pell = bySlug(data.so, 'pell');
    const html = renderPage(data.so, { typeKey: 'character', selectedId: bySlug(data.so, 'maren-hollis').id });
    const c = cardHtml(html, pell.id);
    assert.match(c, /aria-pressed="false"/);
    const t = textOf(c);
    for (const part of ['Pell', 'Caretaker', 'Silent caretaker of the orchard', '3 scenes', 'Seed']) assert.ok(t.includes(part), part);
  });

  test('an entry with no role shows its type; one never linked says so; one scene is singular', () => {
    const tobin = bySlug(data.so, 'tobin-reyes');
    const c = textOf(cardHtml(renderPage(data.so, { typeKey: 'character' }), tobin.id));
    assert.ok(c.includes('Character'), 'type name stands in for the role');
    const knife = bySlug(data.so, 'grafting-knife');
    assert.ok(textOf(cardHtml(renderPage(data.so, { typeKey: 'object' }), knife.id)).includes('1 scene'));
    assert.ok(!textOf(cardHtml(renderPage(data.so, { typeKey: 'object' }), knife.id)).includes('1 scenes'));
    const brass = bySlug(data.cg, 'brass-key');
    const t = textOf(cardHtml(renderPage(data.cg, { typeKey: 'object' }), brass.id));
    assert.ok(t.includes('0 scenes'));
    assert.ok(!t.includes('First seen Ch'), 'no appearance, no first seen');
  });

  test('"First seen" comes from the earliest explicit appearance when first_appearance is absent', () => {
    const tobin = bySlug(data.so, 'tobin-reyes');
    assert.equal(tobin.first_appearance, null);
    const t = textOf(cardHtml(renderPage(data.so, { typeKey: 'character' }), tobin.id));
    assert.match(t, /First seen (Ch \d+|Prologue)/);
  });

  test('an image is shown only when the entry has a served image_url; otherwise the initial', () => {
    const maren = bySlug(data.so, 'maren-hollis');
    const withImg = renderToStaticMarkup(h(card.CodexCard, { entry: { ...maren, image_url: `/api/books/${SO}/entries/${maren.id}/image` }, chapters: data.so.chapters }));
    assert.match(withImg, /<img[^>]*src="\/api\/books\/[^"]*\/image"/);
    const without = renderToStaticMarkup(h(card.CodexCard, { entry: maren, chapters: data.so.chapters }));
    assert.ok(!without.includes('<img'));
  });

  test('cards follow the sort and filter', () => {
    const order = (props) => [...renderPage(data.so, { typeKey: 'character', ...props }).matchAll(/data-entry-id="([^"]+)"/g)].map((m) => data.so.entries.find((e) => e.id === m[1]).slug);
    assert.deepEqual(order({}), ['ilse-hollis', 'maren-hollis', 'pell', 'tobin-reyes']);
    assert.deepEqual(order({ sort: 'scenes' }), ['maren-hollis', 'pell', 'tobin-reyes', 'ilse-hollis']);
    assert.deepEqual(order({ query: 'mare' }), ['maren-hollis'], 'alias match');
    assert.deepEqual(order({ status: 'seed' }), ['pell']);
    assert.deepEqual(order({ status: 'review' }), ['pell']);
  });

  test('empty results say so instead of an empty grid', () => {
    const html = renderPage(data.so, { query: 'zzzz-nothing' });
    assert.ok(!html.includes('data-entry-id'));
    assert.ok(textOf(html).includes('No entries match'));
  });
});

// ------------------------------------------------------------------------------------------------ inspector

describe('inspector', () => {
  const resolveIn = (set) => (ref) => {
    const e = set.entries.find((x) => x.slug === ref || x.id === ref);
    return e ? { id: e.id } : null;
  };
  const renderInspector = (set, slug, extra = {}) =>
    renderToStaticMarkup(h(inspector.EntryInspector, { bookId: set.bookId, entry: bySlug(set, slug), chapters: set.chapters, types: set.types, resolve: resolveIn(set), ...extra }));

  test('Maren (salt-orchard): name, type and role, aliases, facts grid with a linked value, one heading per section', () => {
    const html = renderInspector(data.so, 'maren-hollis');
    assert.match(html, /<h2[^>]*>Maren Hollis<\/h2>/);
    const t = textOf(html);
    assert.ok(t.includes('Character · Protagonist'));
    assert.ok(t.includes('Mare'), 'alias');
    const facts = [...html.matchAll(/<dt>([^<]*)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], textOf(m[2])]);
    assert.deepEqual(facts, [['Age', '34'], ['Eyes', 'Grey'], ['Home', 'port-aldine']]);
    const port = bySlug(data.so, 'port-aldine');
    assert.ok(anchors(html).some((a) => a.text === 'port-aldine' && a.href === `/books/${SO}/codex?entry=${port.id}`), 'a [[link]] in a value opens that entry in the Codex');
    assert.ok(!html.includes('[[port-aldine]]'), 'brackets are not shown');
    const headings = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
    for (const hd of ['Overview', 'Arc', 'Open threads']) assert.ok(headings.includes(hd), hd);
    assert.ok(t.includes('Comes back to sell the estate. Ends choosing to stay.'));
    assert.ok(t.includes('Why did Ilse leave the key?'));
  });

  test('an entry without facts has no facts grid', () => {
    assert.ok(!renderInspector(data.so, 'pell').includes('codex-facts'));
  });

  test('presence by chapter: one bar per chapter and a role="img" summary naming the counts', () => {
    const html = renderInspector(data.so, 'maren-hollis');
    const label = decode(/role="img"[^>]*aria-label="([^"]*)"/.exec(html)?.[1] ?? /aria-label="([^"]*)"[^>]*role="img"/.exec(html)?.[1] ?? '');
    assert.ok(label.startsWith('Maren Hollis appears in 2 scenes in chapter 1'), label);
    assert.ok(label.includes('2 scenes in chapter 2') && label.includes('2 scenes in chapter 3'), label);
    assert.ok(!label.includes('chapter 0'), 'the prologue has no Maren scene');
    assert.equal((html.match(/class="presence-col"/g) ?? []).length, data.so.chapters.length);
    assert.ok(textOf(html).includes('Presence by chapter'));
  });

  test('PresenceBars: explicit scenes are the solid segment, mentions a separate lighter one, height follows the count', () => {
    const chapters = [{ chapter: 1, scene_ids: ['a', 'b', 'c'] }, { chapter: 2, scene_ids: ['d'] }];
    const appears = [
      { scene_id: 'a', kind: 'explicit', rel: 'pov', position: 1 },
      { scene_id: 'b', kind: 'explicit', rel: 'character', position: 2 },
      { scene_id: 'c', kind: 'inferred', rel: 'mention', position: 3 },
    ];
    const html = renderToStaticMarkup(h(bars.PresenceBars, { name: 'Maren Hollis', appearsIn: appears, chapters }));
    assert.match(html, /role="img"/);
    assert.match(html, /data-chapter="1"[^>]*data-explicit="2"[^>]*data-inferred="1"/);
    assert.match(html, /data-chapter="2"[^>]*data-explicit="0"[^>]*data-inferred="0"/);
    assert.ok(html.includes('presence-inferred') && html.includes('presence-explicit'));
    const px = (chapter) => Number(new RegExp(`data-chapter="${chapter}"[\\s\\S]*?presence-bar" style="height:(\\d+)px`).exec(html)?.[1] ?? 0);
    assert.ok(px(1) > px(2) || px(2) === 0, 'a chapter with more scenes has the taller bar');
  });

  test('codex-graph Maren: appears-in lists explicit then "mentioned" scenes, each linked into the manuscript', () => {
    const maren = bySlug(data.cg, 'maren-hollis');
    const html = renderInspector(data.cg, 'maren-hollis');
    const appears = /<ul[^>]*class="codex-appears"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    const items = [...appears.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => textOf(m[0]));
    assert.deepEqual(items, ['Landfall', 'Night Lines mentioned']);
    const links = anchors(appears);
    assert.deepEqual(links.map((a) => a.href), [`/books/${CG}?scene=${maren.appears_in.find((r) => r.kind === 'explicit').scene_id}`, `/books/${CG}?scene=${maren.appears_in.find((r) => r.kind === 'inferred').scene_id}`]);
  });

  test('codex-graph Maren: relationships both ways, each a button that selects that entry', () => {
    const html = renderInspector(data.cg, 'maren-hollis', { onSelect() {} });
    const rels = /<ul[^>]*class="codex-rels"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    const rows = [...rels.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => textOf(m[0]));
    assert.ok(rows.some((r) => r.includes('Tobin Reyes') && r.includes('childhood friend') && !r.includes('←')), `out: ${rows}`);
    assert.ok(rows.some((r) => r.includes('Port Aldine') && r.includes('home port')), `out: ${rows}`);
    assert.ok(rows.some((r) => r.includes('← carried by Brass Key')), `in: ${rows}`);
    assert.ok(rows.some((r) => r.includes('← ferry passenger Tobin Reyes')), `in: ${rows}`);
    assert.equal((rels.match(/<button/g) ?? []).length, rows.length, 'every relationship is a button');
  });

  test('an entry that nothing links to says so; Open in manuscript is absent', () => {
    const html = renderInspector(data.cg, 'brass-key');
    assert.ok(textOf(html).includes('Not linked from any scene yet'));
    assert.ok(!textOf(html).includes('Open in manuscript'));
  });

  test('a problem on the entry is listed in the inspector', () => {
    const t = textOf(renderInspector(data.cg, 'maren-hollis'));
    assert.ok(t.includes('W304'));
  });

  test('no entry selected: a prompt, no controls', () => {
    const html = renderToStaticMarkup(h(inspector.EntryInspector, { bookId: CG, entry: null }));
    assert.ok(!html.includes('<button') && !html.includes('<a '));
  });
});

// ------------------------------------------------------------------------------------------------ entry detail tabs

describe('entry detail tabs', () => {
  const renderTabs = (entry, extra = {}) =>
    renderToStaticMarkup(h(inspector.EntryInspector, { bookId: data.so.bookId, entry, chapters: data.so.chapters, types: data.so.types, research: [], ...extra }));
  const tabsOf = (html) =>
    [...html.matchAll(/<button\b([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
      attrs: m[1],
      label: textOf(m[2].replace(/<span class="entry-tab-count">[\s\S]*?<\/span>/, '')),
      id: /\bid="([^"]*)"/.exec(m[1])?.[1],
      controls: /aria-controls="([^"]*)"/.exec(m[1])?.[1],
      selected: /aria-selected="true"/.test(m[1]),
      tabindex: /tabindex="(-?\d+)"/.exec(m[1])?.[1],
    }));
  const panelsOf = (html) => [...html.matchAll(/<div\b([^>]*role="tabpanel"[^>]*)>/g)].map((m) => ({ id: /\bid="([^"]*)"/.exec(m[1])?.[1], labelledby: /aria-labelledby="([^"]*)"/.exec(m[1])?.[1], hidden: /\bhidden=""/.test(m[1]) }));
  const maren = () => bySlug(data.so, 'maren-hollis');

  test('a tablist "Entry sections" lists the tabs that apply to the entry', () => {
    const html = renderTabs(maren());
    assert.match(html, /role="tablist"[^>]*aria-label="Entry sections"|aria-label="Entry sections"[^>]*role="tablist"/);
    const expected = ['Details', 'Mentions', 'Research', 'Relations', ...((maren().problems ?? []).length > 0 ? ['Needs review'] : [])];
    assert.deepEqual(tabsOf(html).map((t) => t.label), expected);
  });

  test('Needs review carries a count when the entry has problems', () => {
    const entry = { ...maren(), problems: [{ code: 'W1', severity: 'warning', message: 'm', location: 'a' }, { code: 'W2', severity: 'warning', message: 'n', location: 'b' }] };
    const html = renderTabs(entry);
    assert.match(html, /Needs review<span class="entry-tab-count">2<\/span>/);
    assert.equal(tabsOf(html).at(-1).label, 'Needs review');
  });

  test('Details is selected by default: one aria-selected tab with tabindex 0, the others -1', () => {
    const tabs = tabsOf(renderTabs(maren()));
    assert.equal(tabs.filter((t) => t.selected).length, 1);
    assert.equal(tabs.find((t) => t.selected).label, 'Details');
    for (const t of tabs) assert.equal(t.tabindex, t.selected ? '0' : '-1', t.label);
  });

  test('every tab controls a panel that points back at it; only the selected panel is visible', () => {
    const html = renderTabs(maren());
    const tabs = tabsOf(html);
    const panels = panelsOf(html);
    assert.equal(panels.length, tabs.length);
    for (const t of tabs) {
      const p = panels.find((x) => x.id === t.controls);
      assert.ok(p, `panel for ${t.label}`);
      assert.equal(p.labelledby, t.id);
      assert.equal(p.hidden, !t.selected, t.label);
    }
    assert.ok(textOf(html).includes('Presence by chapter'), 'hidden panels stay in the markup');
  });

  test('initialTab selects another tab and hides Details', () => {
    const html = renderTabs(maren(), { initialTab: 'relations' });
    const tabs = tabsOf(html);
    assert.equal(tabs.find((t) => t.selected).label, 'Relations');
    const panels = panelsOf(html);
    assert.equal(panels.find((p) => p.id === 'entry-panel-details').hidden, true);
    assert.equal(panels.find((p) => p.id === 'entry-panel-relations').hidden, false);
  });

  test('an archived entry has no Mentions or Research tab', () => {
    const labels = tabsOf(renderTabs({ ...maren(), archived: true })).map((t) => t.label);
    assert.ok(!labels.includes('Mentions') && !labels.includes('Research'), labels.join(','));
    assert.ok(labels.includes('Details') && labels.includes('Relations'));
  });

  test('an initialTab the entry does not have falls back to Details', () => {
    const tabs = tabsOf(renderTabs({ ...maren(), archived: true }, { initialTab: 'mentions' }));
    assert.equal(tabs.find((t) => t.selected).label, 'Details');
    assert.equal(tabs.filter((t) => t.selected).length, 1);
  });

  test('the action bar sits above the tabs', () => {
    const html = renderTabs(maren(), { onEdit() {} });
    assert.ok(html.indexOf('codex-detail-bar') > -1 && html.indexOf('codex-detail-bar') < html.indexOf('entry-tabs'));
    assert.ok(html.indexOf('Edit fields') < html.indexOf('entry-tabs'));
  });
});

// ------------------------------------------------------------------------------------------------ no controls that do nothing

describe('controls', () => {
  test('without handlers the page renders no New entry / New type / Edit / Archive / Restore controls', () => {
    const t = textOf(renderPage(data.so, { typeKey: 'character' }));
    for (const label of ['New entry', 'New type', 'Edit fields', 'Edit text', 'Change slug', 'Archive…', 'Restore']) assert.ok(!t.includes(label), `${label} should not be offered`);
  });

  test('with handlers the contract buttons appear, and Restore replaces Archive on an archived entry', () => {
    const actions = { onEdit() {}, onEditText() {}, onChangeSlug() {}, onArchive() {}, onRestore() {} };
    const t = textOf(renderPage(data.so, { typeKey: 'character', onNewEntry() {}, onNewType() {}, actions: () => actions }));
    for (const label of ['New entry', 'Edit', 'Archive…']) assert.ok(t.includes(label), label);
    const maren = bySlug(data.so, 'maren-hollis');
    const entries = data.so.entries.map((e) => (e.id === maren.id ? { ...e, archived: true } : e));
    const archived = textOf(renderPage({ ...data.so, entries }, { typeKey: 'archived', selectedId: maren.id, actions: () => actions }));
    assert.ok(archived.includes('Restore…'));
    assert.ok(!archived.includes('Archive…'));
    assert.ok(!archived.includes('Edit fields'));
  });

  test('every button has a name, every link a real target, and nothing is a dead "#" link or a disabled placeholder', () => {
    const html = renderPage(data.so, { typeKey: 'character', onNewEntry() {}, onNewType() {}, onSearchText() {}, onSelect() {}, actions: () => ({ onEdit() {}, onArchive() {} }) });
    for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(textOf(m[1]) !== '' || /aria-label=/.test(m[0]), `unnamed button: ${m[0].slice(0, 80)}`);
    for (const a of anchors(html)) assert.ok(a.href && a.href !== '#' && !a.href.startsWith('javascript:'), `bad link ${a.href}`);
    assert.ok(!/<button[^>]*\sdisabled/.test(html), 'no disabled placeholder buttons');
  });

  test('roving tabindex: exactly one card is in the tab order and it is the selected one', () => {
    const maren = bySlug(data.so, 'maren-hollis');
    const html = renderPage(data.so, { typeKey: 'character', selectedId: maren.id });
    const tabbable = [...html.matchAll(/<button\b[^>]*class="codex-card"[^>]*>/g)].filter((m) => /tabindex="0"/.test(m[0]));
    assert.equal(tabbable.length, 1);
    assert.ok(tabbable[0][0].includes(`data-entry-id="${maren.id}"`));
  });
});

// ------------------------------------------------------------------------------------------------ pure logic

const E = (over) => ({ id: over.id ?? over.name, name: over.name, type: 'character', status: 'canon', aliases: [], fields: {}, archived: false, problems: [], appears_in: [], updated_at: null, ...over });
const ex = (scene, position = 1) => ({ scene_id: scene, title: scene, position, rel: 'character', kind: 'explicit' });
const inf = (scene, position = 1) => ({ scene_id: scene, title: scene, position, rel: 'mention', kind: 'inferred' });

describe('needsReview', () => {
  test('seed, any error, any warning', () => {
    assert.equal(model.needsReview(E({ name: 'a', status: 'seed' })), true);
    assert.equal(model.needsReview(E({ name: 'a', problems: [{ severity: 'warning', code: 'W304' }] })), true);
    assert.equal(model.needsReview(E({ name: 'a', status: 'sketch', problems: [{ severity: 'error', code: 'E101' }] })), true);
  });
  test('sketch or canon with no problems, or only info, does not', () => {
    assert.equal(model.needsReview(E({ name: 'a', status: 'canon' })), false);
    assert.equal(model.needsReview(E({ name: 'a', status: 'sketch' })), false);
    assert.equal(model.needsReview(E({ name: 'a', problems: [{ severity: 'info', code: 'I402' }] })), false);
    const noProblems = E({ name: 'a' });
    delete noProblems.problems;
    assert.equal(model.needsReview(noProblems), false);
  });
});

describe('blurbOf', () => {
  test('first sentence of the first section', () => {
    assert.equal(model.blurbOf([{ heading: 'Overview', text: 'A harbour pilot. She knows the channels.' }, { heading: 'Arc', text: 'Other.' }]), 'A harbour pilot.');
  });
  test('whitespace and line breaks collapse; no final punctuation keeps the whole text', () => {
    assert.equal(model.blurbOf([{ heading: 'Overview', text: 'Ferryman,\nsays   little' }]), 'Ferryman, says little');
  });
  test('a long sentence is cut to at most 120 characters', () => {
    const long = `${'word '.repeat(60).trim()}.`;
    const b = model.blurbOf([{ heading: 'Overview', text: long }]);
    assert.ok(b.length <= 120 && b.length > 100, `length ${b.length}`);
    assert.ok(b.endsWith('…'));
  });
  test('exactly 120 characters is kept whole', () => {
    const s = `${'a'.repeat(119)}.`;
    assert.equal(model.blurbOf([{ heading: 'Overview', text: s }]), s);
  });
  test('no sections, an empty first section, null: empty string', () => {
    for (const input of [[], null, undefined, [{ heading: 'Overview', text: '' }], [{ heading: 'Overview', text: '   ' }]]) assert.equal(model.blurbOf(input), '');
  });
});

describe('presenceByChapter', () => {
  const chapters = [{ chapter: 0, scene_ids: ['p'] }, { chapter: 1, scene_ids: ['a', 'b'] }, { chapter: 2, scene_ids: ['c'] }];
  test('counts explicit and mentioned scenes per chapter, zero chapters included, in chapter order', () => {
    const bars_ = model.presenceByChapter([ex('a', 2), inf('b', 3), ex('c', 4)], chapters);
    assert.deepEqual(bars_.map((b) => [b.chapter, b.explicit, b.inferred, b.total]), [[0, 0, 0, 0], [1, 1, 1, 2], [2, 1, 0, 1]]);
  });
  test('two explicit rows for one scene (pov and character) are one scene; explicit wins over a mention of the same scene', () => {
    const rows = [{ ...ex('a'), rel: 'pov' }, { ...ex('a'), rel: 'character' }, inf('a')];
    const [, one] = model.presenceByChapter(rows, chapters);
    assert.deepEqual([one.explicit, one.inferred], [1, 0]);
  });
  test('no appearances, or no chapters', () => {
    assert.ok(model.presenceByChapter([], chapters).every((b) => b.total === 0));
    assert.deepEqual(model.presenceByChapter([ex('a')], []), []);
    assert.deepEqual(model.presenceByChapter(null, null), []);
  });
  test('a scene that is in no chapter is ignored', () => {
    assert.ok(model.presenceByChapter([ex('zzz')], chapters).every((b) => b.total === 0));
  });
});

describe('presenceSummary', () => {
  test('names the entry and the scenes per chapter, singular and plural', () => {
    const s = model.presenceSummary('Maren Hollis', [{ chapter: 1, explicit: 3, inferred: 0, total: 3 }, { chapter: 2, explicit: 1, inferred: 0, total: 1 }]);
    assert.ok(s.startsWith('Maren Hollis appears in 3 scenes in chapter 1, 1 scene in chapter 2'), s);
  });
  test('an entry that appears nowhere still gets a sentence naming it', () => {
    assert.ok(model.presenceSummary('Pell', [{ chapter: 1, explicit: 0, inferred: 0, total: 0 }]).startsWith('Pell'));
  });
});

describe('firstSeen', () => {
  const chapters = [{ chapter: 0, scene_ids: ['p'] }, { chapter: 1, scene_ids: ['a'] }, { chapter: 2, scene_ids: ['c'] }];
  test('first_appearance wins over the earliest appearance', () => {
    assert.equal(model.firstSeen({ first_appearance: 'c', appears_in: [ex('a')] }, chapters).chapter, 2);
  });
  test('without first_appearance: the chapter of the earliest explicit scene; a mention does not count', () => {
    assert.equal(model.firstSeen({ first_appearance: null, appears_in: [inf('p'), ex('c', 4), ex('a', 2)] }, chapters).chapter, 1);
  });
  test('nothing to go on: null', () => {
    assert.equal(model.firstSeen({ first_appearance: null, appears_in: [inf('a')] }, chapters), null);
    assert.equal(model.firstSeen({ first_appearance: 'unknown-scene', appears_in: [] }, chapters), null);
  });
  test('Chapter 1 reads "Ch 1"', () => {
    assert.equal(model.firstSeen({ first_appearance: 'a', appears_in: [] }, chapters).label, 'Ch 1');
  });
});

describe('filterEntries', () => {
  const maren = E({ name: 'Maren Hollis', aliases: ['Mare'], fields: { Eyes: 'Grey', Age: 34 }, role: 'Pilot' });
  const pell = E({ name: 'Pell', status: 'seed' });
  const jetty = E({ name: 'The Jetty', type: 'location', status: 'sketch', problems: [{ severity: 'warning', code: 'W301' }] });
  const old = E({ name: 'Old Hand', archived: true });
  const all = [maren, pell, jetty, old];
  const names = (list) => list.map((e) => e.name);

  test('type: a type, all (without archived), archived', () => {
    assert.deepEqual(names(model.filterEntries(all, { type: 'character' })), ['Maren Hollis', 'Pell']);
    assert.deepEqual(names(model.filterEntries(all, { type: 'all' })), ['Maren Hollis', 'Pell', 'The Jetty']);
    assert.deepEqual(names(model.filterEntries(all, { type: 'archived' })), ['Old Hand']);
  });
  test('status chips; "review" uses the needs-review rule', () => {
    assert.deepEqual(names(model.filterEntries(all, { status: 'seed' })), ['Pell']);
    assert.deepEqual(names(model.filterEntries(all, { status: 'canon' })), ['Maren Hollis']);
    assert.deepEqual(names(model.filterEntries(all, { status: 'review' })), ['Pell', 'The Jetty']);
  });
  test('query matches name, alias and field values, ignoring case and accents; not other text', () => {
    assert.deepEqual(names(model.filterEntries(all, { query: 'MAREN' })), ['Maren Hollis']);
    assert.deepEqual(names(model.filterEntries(all, { query: 'mare' })), ['Maren Hollis']);
    assert.deepEqual(names(model.filterEntries(all, { query: 'grey' })), ['Maren Hollis']);
    assert.deepEqual(names(model.filterEntries(all, { query: '34' })), ['Maren Hollis'], 'numbers are searchable');
    assert.deepEqual(names(model.filterEntries([E({ name: 'Émile' })], { query: 'emile' })), ['Émile']);
    assert.deepEqual(names(model.filterEntries(all, { query: 'pilot' })), [], 'role is not searched');
    assert.deepEqual(names(model.filterEntries(all, { query: 'no such thing' })), []);
  });
  test('empty or blank query matches everything; filters combine', () => {
    assert.equal(model.filterEntries(all, { query: '' }).length, 3);
    assert.equal(model.filterEntries(all, { query: '   ' }).length, 3);
    assert.deepEqual(names(model.filterEntries(all, { type: 'character', status: 'seed', query: 'pe' })), ['Pell']);
  });
  test('full-text hits (textIds) add matches only when there is a query', () => {
    const hit = new Set([jetty.id]);
    assert.deepEqual(names(model.filterEntries(all, { query: 'tide', textIds: hit })), ['The Jetty']);
    assert.equal(model.filterEntries(all, { query: '', textIds: hit }).length, 3);
  });
  test('does not modify its input; empty list is fine', () => {
    const copy = [...all];
    model.filterEntries(all, { query: 'x' });
    assert.deepEqual(all, copy);
    assert.deepEqual(model.filterEntries([], { query: 'x' }), []);
  });
});

describe('sortEntries', () => {
  const a = E({ name: 'Alder', appears_in: [ex('s1'), inf('s2'), inf('s3')], updated_at: '2026-01-02T00:00:00.000Z' });
  const b = E({ name: 'Birch', appears_in: [ex('s1'), ex('s2')], updated_at: '2026-03-01T00:00:00.000Z' });
  const c = E({ name: 'cedar', appears_in: [], updated_at: '2026-02-01T00:00:00.000Z' });
  const d = E({ name: 'Dune', appears_in: [ex('s1')], updated_at: null });
  const names = (list) => list.map((e) => e.name);

  test('name: alphabetical, case-insensitive', () => assert.deepEqual(names(model.sortEntries([d, c, b, a], 'name')), ['Alder', 'Birch', 'cedar', 'Dune']));
  test('most scenes: explicit scenes only, ties by name', () => {
    assert.deepEqual(names(model.sortEntries([c, a, d, b], 'scenes')), ['Birch', 'Alder', 'Dune', 'cedar']);
  });
  test('recently changed: newest first, undated last', () => assert.deepEqual(names(model.sortEntries([a, b, c, d], 'recent')), ['Birch', 'cedar', 'Alder', 'Dune']));
  test('default is by name; the input array is not modified; empty is fine', () => {
    const input = [d, c, b, a];
    assert.deepEqual(names(model.sortEntries(input)), ['Alder', 'Birch', 'cedar', 'Dune']);
    assert.deepEqual(names(input), ['Dune', 'cedar', 'Birch', 'Alder']);
    assert.deepEqual(model.sortEntries([], 'scenes'), []);
  });
});

describe('page url', () => {
  test('?entry= and ?type= are read and written (shareable)', () => {
    assert.deepEqual(model.parseCodexSearch('?type=character&entry=entry_X'), { type: 'character', entry: 'entry_X' });
    assert.deepEqual(model.parseCodexSearch(''), { type: null, entry: null });
    assert.deepEqual(model.parseCodexSearch('?entry='), { type: null, entry: null });
    assert.equal(model.codexHref('book_1', { entry: 'entry_X' }), '/books/book_1/codex?entry=entry_X');
    assert.equal(model.codexHref('book_1'), '/books/book_1/codex');
  });
});

// ------------------------------------------------------------------------------------------------ tabs: ARIA and keyboard

describe('section tabs: ARIA and keyboard', () => {
  const tabsOf = (html) => {
    const tablist = /<div[^>]*role="tablist"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    return [...tablist.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
      attrs: m[1],
      text: textOf(m[2]),
      id: /\bid="([^"]*)"/.exec(m[1])?.[1],
      tabindex: /tabindex="(-?\d+)"/.exec(m[1])?.[1],
    }));
  };

  test('one tablist; every tab has role, aria-controls and a unique id', () => {
    const html = renderPage(data.so, { typeKey: 'character' });
    assert.equal((html.match(/role="tablist"(?! aria-label="Entry sections")/g) ?? []).length, 1, 'one section tablist; the entry tabs are a second, separately labelled one');
    const tabs = tabsOf(html);
    assert.equal(tabs.length, 7);
    for (const t of tabs) {
      assert.match(t.attrs, /role="tab"/);
      assert.match(t.attrs, /aria-controls="codex-tabpanel"/);
      assert.ok(t.id);
    }
    assert.equal(new Set(tabs.map((t) => t.id)).size, tabs.length);
  });

  test('exactly one tab is selected (the typeKey) and only it is in the tab order', () => {
    const tabs = tabsOf(renderPage(data.so, { typeKey: 'character' }));
    const on = tabs.filter((t) => /aria-selected="true"/.test(t.attrs));
    assert.equal(on.length, 1);
    assert.ok(on[0].text.startsWith('Characters'));
    assert.deepEqual(tabs.filter((t) => t.tabindex === '0'), on);
    assert.ok(tabs.filter((t) => t !== on[0]).every((t) => t.tabindex === '-1' && /aria-selected="false"/.test(t.attrs)));
  });

  test('the tabpanel is labelled by the selected tab and holds the cards and the Entry details', () => {
    const html = renderPage(data.so, { typeKey: 'character' });
    const panel = /<div\b[^>]*role="tabpanel"[^>]*>/.exec(html)[0];
    assert.match(panel, /id="codex-tabpanel"/);
    const selected = tabsOf(html).find((t) => /aria-selected="true"/.test(t.attrs));
    assert.ok(panel.includes(`aria-labelledby="${selected.id}"`));
    const body = html.slice(html.indexOf(panel));
    assert.ok(body.includes('data-entry-id='));
    assert.ok(body.includes('aria-label="Entry details"'));
    assert.ok(html.indexOf('role="tablist"') < html.indexOf(panel));
  });

  test('a custom type has its own tab and selecting it marks it selected', () => {
    const html = renderPage(data.cg, { typeKey: 'ship' });
    const tabs = tabsOf(html);
    const ships = tabs.find((t) => t.text.startsWith('Ships'));
    assert.ok(ships);
    assert.deepEqual(tabs.filter((t) => /aria-selected="true"/.test(t.attrs)), [ships]);
    assert.equal(ships.tabindex, '0');
  });

  test('nextTabIndex: arrows wrap, Home and End jump, other keys leave the tab alone', () => {
    const n = model.nextTabIndex;
    assert.equal(n(0, 'ArrowRight', 5), 1);
    assert.equal(n(4, 'ArrowRight', 5), 0);
    assert.equal(n(2, 'ArrowLeft', 5), 1);
    assert.equal(n(0, 'ArrowLeft', 5), 4);
    assert.equal(n(3, 'Home', 5), 0);
    assert.equal(n(1, 'End', 5), 4);
    assert.equal(n(2, 'a', 5), 2);
    assert.equal(n(2, 'ArrowDown', 5), 2);
  });
});
