/*
 * codex-card.test.mjs — UI plan Phase 1: the shared Codex card.
 *
 *   - the card renders the entry's data and escapes everything it shows
 *   - "Link here" only appears when the caller allows it (edit role)
 *   - clicking a mention in the rich editor pins the card and leaves the
 *     Markdown byte-identical (no more silent click-to-wikilink)
 *   - "Link here" is the one explicit way to mint [[slug|Text]]
 *   - the reader page's <a class="mention"> pins instead of navigating
 *
 *   cd editor && npm test
 */
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="ed"></div><div id="reader"></div></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
for (const k of ['Element', 'HTMLElement', 'Node', 'Document', 'DocumentFragment', 'Text',
                 'MutationObserver', 'DOMParser', 'XMLSerializer', 'getComputedStyle',
                 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'ClipboardEvent', 'DragEvent']) {
  if (dom.window[k] !== undefined && global[k] === undefined) global[k] = dom.window[k]
}
// jsdom has no layout; ProseMirror asks for rects when handling clicks/selection
if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => []
if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 })
dom.window.document.elementFromPoint = () => null

const META = {
  aria: { name: 'Aria <Vell>', db: 'characters', type: 'Character', detail: 'Captain & warden',
          aliases: ['The Warden', 'Vell'], fields: [['Role', '[[wall|Wall]] captain'], ['Eyes', '<b>grey</b>']],
          body: 'Keeps the "northern" watch…', related: ['wall', 'ghost'], n: 7 },
  wall: { name: 'The Wall', db: 'locations', type: 'Location', detail: '', aliases: [], fields: [], body: '', related: [], n: 0 },
}
const DB = { characters: { label: 'Character', color: '#5b54b8' }, locations: { label: 'Location', color: 'red;}x{' } }
const TARGETS = [{ phrase: 'The Warden', slug: 'aria' }, { phrase: 'The Wall', slug: 'wall' }, { phrase: 'Aria', slug: 'aria' }]

let card, Editor, codex, buildMentionExtension

before(async () => {
  card = await import('../src/codex-card.js')
  ;({ Editor } = await import('@tiptap/core'))
  codex = await import('../src/codex-md.js')
  ;({ buildMentionExtension } = await import('../src/mentions.js'))
})
beforeEach(() => card.close())

function click(el, init = {}) {
  el.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }))
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(ev)
  return ev
}
const cardEl = () => document.querySelector('.codex-card')

/* ------------------------------------------------------------ pure parts */

test('cardHTML: shows name, badge, aliases, fields, excerpt, related, counts', () => {
  const h = card.cardHTML('aria', { book: 'echo', db: DB, meta: META, canLink: false, local: { n: 2, label: 'in this chapter' } })
  assert.match(h, /Aria &lt;Vell&gt;/)
  assert.match(h, />Character</)
  assert.match(h, /Captain &amp; warden/)
  assert.match(h, /The Warden, Vell/)
  assert.match(h, /<dt>Role<\/dt><dd>Wall captain<\/dd>/, 'wiki-link syntax shown as its label')
  assert.match(h, /&lt;b&gt;grey&lt;\/b&gt;/, 'field values escaped')
  assert.match(h, /Keeps the &quot;northern&quot; watch…/)
  assert.match(h, /href="\?p=entry&amp;book=echo&amp;db=locations&amp;slug=wall">The Wall<\/a>/)
  assert.doesNotMatch(h, /ghost/, 'unknown related slugs dropped')
  assert.match(h, /2 in this chapter · 7 in manuscript/)
  assert.match(h, /href="\?p=entry&amp;book=echo&amp;db=characters&amp;slug=aria">Open/)
  assert.doesNotMatch(h, /mc-link/, 'no Link here without permission')
  assert.doesNotMatch(h, /Peek/i, 'Peek hidden until Phase 6')
})

test('cardHTML: Link here only with canLink; unsafe colors are not injected', () => {
  assert.match(card.cardHTML('aria', { book: 'echo', db: DB, meta: META, canLink: true }), /class="mc-link"/)
  const w = card.cardHTML('wall', { book: 'echo', db: DB, meta: META })
  assert.doesNotMatch(w, /red;\}x\{/)
  assert.match(w, /background:#888/)
  assert.equal(card.cardHTML('nope', { meta: META }), '')
})

test('tallyMentions: longest-first, no overlaps, ignores [[links]]', () => {
  const c = card.tallyMentions('The Warden met Aria at The Wall. [[aria]] Aria-like? Ariana no.', TARGETS)
  assert.deepEqual(c, { aria: 3, wall: 1 })
})

/* ------------------------------------------------------------ rich editor */

function makeEditor(md) {
  const mount = document.getElementById('ed')
  mount.innerHTML = ''
  const ed = new Editor({ element: mount, extensions: codex.buildCodexExtensions([buildMentionExtension(TARGETS)]) })
  ed.commands.setContent(md)
  return { ed, mount }
}

test('editor: clicking a mention pins the card and does NOT change the Markdown', () => {
  const md = 'The Warden walked the length of The Wall.\n\n***\n\nAria slept.'
  const { ed, mount } = makeEditor(md)
  let linked = 0
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo', canLink: true,
    onLink: (el, slug) => { linked++; return card.linkMention(ed, el, slug) } })
  const before = codex.serializeCodex(ed)
  assert.equal(before, md)
  const m = mount.querySelector('.cm-mention[data-slug="wall"]')
  assert.ok(m, 'mention decorated')
  click(m)
  // jsdom has no layout, so ProseMirror can't map a synthetic click to a
  // position itself; run every click prop the way its mouse handler would.
  const view = ed.view
  const pos = view.posAtDOM(m, 0)
  const $pos = view.state.doc.resolve(pos)
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'target', { value: m })
  for (let d = $pos.depth; d >= 0; d--) {
    view.someProp('handleClickOn', (f) => f(view, pos, $pos.node(d), $pos.before(d) || 0, ev, d === $pos.depth))
  }
  view.someProp('handleClick', (f) => f(view, pos, ev))
  assert.equal(codex.serializeCodex(ed), before, 'prose untouched by a click')
  assert.ok(card.isPinned())
  assert.match(cardEl().innerHTML, /The Wall/)
  assert.equal(linked, 0)
  ed.destroy()
})

test('editor: "Link here" turns exactly that mention into [[slug|Text]]', () => {
  const { ed, mount } = makeEditor('Then The Wall fell, and Aria ran.')
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo', canLink: true,
    onLink: (el, slug) => card.linkMention(ed, el, slug) })
  click(mount.querySelector('.cm-mention[data-slug="wall"]'))
  cardEl().querySelector('.mc-link').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(codex.serializeCodex(ed), 'Then [[wall|The Wall]] fell, and Aria ran.')
  assert.equal(mount.querySelector('.cm-wikilink').textContent, 'The Wall', 'visible text unchanged')
  assert.ok(!card.isOpen(), 'card closes after linking')
  ed.destroy()
})

test('editor: Link here on an alias keeps the alias as the label', () => {
  const { ed, mount } = makeEditor('The Warden waits.')
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo', canLink: true,
    onLink: (el, slug) => card.linkMention(ed, el, slug) })
  click(mount.querySelector('.cm-mention'))
  cardEl().querySelector('.mc-link').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  const md = codex.serializeCodex(ed)
  assert.equal(md, '[[aria|The Warden]] waits.')
  ed.commands.setContent(md)
  assert.equal(codex.serializeCodex(ed), md, 'new link round-trips byte-stable')
  ed.destroy()
})

test('editor: no Link here button without canLink', () => {
  const { ed, mount } = makeEditor('Aria waits.')
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo', canLink: false,
    onLink: () => assert.fail('must not link') })
  click(mount.querySelector('.cm-mention'))
  assert.equal(cardEl().querySelector('.mc-link'), null)
  ed.destroy()
})

test('linkMention refuses a stale highlight', () => {
  const { ed, mount } = makeEditor('Aria waits.')
  const el = mount.querySelector('.cm-mention')
  ed.commands.setContent('Something else entirely.')
  assert.equal(card.linkMention(ed, el, 'aria'), false)
  assert.equal(codex.serializeCodex(ed), 'Something else entirely.')
  ed.destroy()
})

/* ------------------------------------------------------------ pin / close */

test('Esc and outside click close a pinned card', () => {
  const { ed, mount } = makeEditor('Aria waits.')
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo' })
  click(mount.querySelector('.cm-mention'))
  assert.ok(card.isPinned())
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.ok(!card.isOpen())
  click(mount.querySelector('.cm-mention'))
  assert.ok(card.isPinned())
  click(document.body)
  assert.ok(!card.isOpen())
  ed.destroy()
})

test('hover shows the card after the delay; leaving hides it', async () => {
  const { ed, mount } = makeEditor('Aria waits.')
  card.attachCodexCard(mount, { selector: '.cm-mention', meta: META, db: DB, book: 'echo' })
  const m = mount.querySelector('.cm-mention')
  m.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  assert.ok(!card.isOpen(), 'not instant')
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(card.isOpen() && !card.isPinned())
  m.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  await new Promise((r) => setTimeout(r, 220))
  assert.ok(!card.isOpen())
  ed.destroy()
})

/* ------------------------------------------------------------ reader page */

test('reader: plain click pins instead of navigating; Ctrl/⌘-click is left alone', () => {
  const root = document.getElementById('reader')
  root.innerHTML = '<p>Night on <a class="mention mention-locations" data-slug="wall" href="?p=entry&book=echo&db=locations&slug=wall">the Wall</a>.</p>'
  card.attachCodexCard(root, { selector: 'a.mention', meta: META, db: DB, book: 'echo', followLinks: true,
    localLabel: 'in this chapter', localCount: (s) => card.tallyMentions(root.textContent, TARGETS)[s] || 0 })
  const a = root.querySelector('a.mention')
  const ev = click(a)
  assert.ok(ev.defaultPrevented, 'plain click does not navigate')
  assert.ok(card.isPinned())
  assert.match(cardEl().innerHTML, /1 in this chapter · 0 in manuscript/)
  assert.equal(cardEl().querySelector('.mc-link'), null, 'reader never offers Link here')
  card.close()
  const ev2 = click(a, { ctrlKey: true })
  assert.ok(!ev2.defaultPrevented, 'modifier click still opens the entry')
})
