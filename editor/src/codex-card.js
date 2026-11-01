/*
 * codex-card.js — the Codex card (UI plan Phase 1), shared by the reader page
 * and every TipTap surface that highlights mentions.
 *
 *   hover a mention ~250 ms  -> card shows (leaving it hides it again)
 *   click a mention          -> card pins (Esc or a click outside closes it)
 *
 * Content: type badge, name, aliases, key fields, a short excerpt, up to three
 * related entries, and mention counts. Actions: Open (entry page) and, only
 * when the caller allows it, Link here — the old click-to-wikilink behavior,
 * now an explicit button. Peek waits for the Phase 6 side panel.
 *
 * The card never touches the document by itself: the only write is the
 * caller's onLink, which runs on an explicit button press.
 */

const SHOW_DELAY = 250
const HIDE_DELAY = 160

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))
}
function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Field values are raw Codex markdown; show [[slug|Label]] / [[slug]] as text. */
function plainValue(v) {
  return String(v == null ? '' : v)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*|__/g, '')
}

export function entryUrl(book, db, slug) {
  return '?p=entry&book=' + encodeURIComponent(book || '') + '&db=' + encodeURIComponent(db || '') +
    '&slug=' + encodeURIComponent(slug || '')
}

/** Same longest-first, word-boundary, non-overlapping tally as the scene rail
 *  and the server's scan_mentions(). targets must be longest-first. */
export function tallyMentions(text, targets) {
  text = String(text || '').replace(/\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length))
  const used = new Uint8Array(text.length)
  const counts = {}
  for (const t of targets || []) {
    if (!t || !t.phrase || !t.slug) continue
    const re = new RegExp('(?<!\\w)' + reEscape(t.phrase) + '(?!\\w)', 'giu')
    let m
    while ((m = re.exec(text)) !== null) {
      const s = m.index, e = s + m[0].length
      if (e === s) { re.lastIndex++; continue }
      let hit = false
      for (let k = s; k < e; k++) if (used[k]) { hit = true; break }
      if (hit) continue
      used.fill(1, s, e)
      counts[t.slug] = (counts[t.slug] || 0) + 1
    }
  }
  return counts
}

/**
 * The card's inner HTML. Pure, so it is unit-tested directly.
 * opts: { book, db (map db_key -> {label,color}), meta (slug -> card data),
 *         canLink, local: {n, label} | null }
 */
export function cardHTML(slug, opts) {
  const meta = (opts.meta || {})
  const me = meta[slug]
  if (!me) return ''
  const d = (opts.db || {})[me.db] || {}
  const color = /^#[0-9a-f]{3,8}$/i.test(d.color || '') ? d.color : '#888'
  let h = '<div class="mc-h"><span class="mc-dot" style="background:' + color + '"></span>' +
    '<span class="mc-name">' + esc(me.name || slug) + '</span>' +
    (d.label ? '<span class="mc-badge" style="color:' + color + ';border-color:' + color + '55">' + esc(d.label) + '</span>' : '') +
    '</div>'
  if (me.detail && me.detail !== d.label) h += '<div class="mc-detail">' + esc(me.detail) + '</div>'
  if (me.aliases && me.aliases.length) h += '<div class="mc-aliases"><span class="mc-k">Also</span> ' + esc(me.aliases.join(', ')) + '</div>'
  if (me.fields && me.fields.length) {
    h += '<dl class="mc-fields">'
    for (const f of me.fields) h += '<dt>' + esc(f[0]) + '</dt><dd>' + esc(plainValue(f[1])) + '</dd>'
    h += '</dl>'
  }
  if (me.body) h += '<div class="mc-body">' + esc(me.body) + '</div>'
  const rel = (me.related || []).filter((r) => meta[r])
  if (rel.length) {
    h += '<div class="mc-rel"><span class="mc-k">Related</span> ' + rel.map((r) =>
      '<a href="' + esc(entryUrl(opts.book, meta[r].db, r)) + '">' + esc(meta[r].name || r) + '</a>').join(' · ') + '</div>'
  }
  const counts = []
  if (opts.local && opts.local.n != null) counts.push(opts.local.n + ' ' + esc(opts.local.label || 'here'))
  if (me.n != null) counts.push(Number(me.n) + ' in manuscript')
  if (counts.length) h += '<div class="mc-count" title="Manuscript total is from the mentions index (refreshed on reindex)">' + counts.join(' · ') + '</div>'
  h += '<div class="mc-actions"><a class="mc-open" href="' + esc(entryUrl(opts.book, me.db, slug)) + '">Open →</a>'
  if (opts.canLink) h += '<button type="button" class="mc-link" title="Turn this mention into a [[wiki-link]]">Link here</button>'
  h += '</div>'
  return h
}

/** "Link here": replace one highlighted mention with a [[slug]] node — the
 *  pre-Phase-1 click behavior, now only on an explicit button press. Refuses
 *  (no-op) if the highlight no longer matches the document. */
export function linkMention(editor, el, slug) {
  const view = editor.view
  if (!el || !el.isConnected || !view.dom.contains(el)) return false
  const text = el.textContent || ''
  const from = view.posAtDOM(el, 0)
  const to = from + text.length
  if (to <= from || view.state.doc.textBetween(from, to) !== text) return false
  const wl = view.state.schema.nodes.codexWikilink
  view.dispatch(view.state.tr.replaceWith(from, to, wl.create({ target: slug })))
  view.focus()
  return true
}

/* ------------------------------------------------------------ the one card */

let card = null          // the single card element on the page
let state = null         // { owner, el, slug, pinned }
let showT = null, hideT = null
let globalsBound = false

function ensureCard(doc) {
  if (card && card.isConnected) return card
  card = doc.createElement('div')
  card.className = 'mention-card codex-card'
  card.setAttribute('role', 'dialog')
  card.style.display = 'none'
  doc.body.appendChild(card)
  card.addEventListener('mouseenter', () => clearTimeout(hideT))
  card.addEventListener('mouseleave', () => { if (state && !state.pinned) scheduleHide() })
  card.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.mc-link')
    if (!b || !state) return
    e.preventDefault()
    const { owner, el, slug } = state
    close()
    if (owner.opts.canLink && owner.opts.onLink) owner.opts.onLink(el, slug)
  })
  return card
}

function place(el) {
  const doc = el.ownerDocument, win = doc.defaultView
  const r = el.getBoundingClientRect()
  const vw = doc.documentElement.clientWidth || win.innerWidth
  const vh = doc.documentElement.clientHeight || win.innerHeight
  let top = r.bottom + 6
  if (top + card.offsetHeight > vh - 8 && r.top - card.offsetHeight - 6 > 8) top = r.top - card.offsetHeight - 6
  let left = Math.min(r.left, vw - card.offsetWidth - 12)
  card.style.top = (top + win.scrollY) + 'px'
  card.style.left = (Math.max(8, left) + win.scrollX) + 'px'
}

function show(owner, el, pinned) {
  const slug = el.getAttribute('data-slug')
  const o = owner.opts
  if (!slug || !o.meta || !o.meta[slug]) return
  clearTimeout(hideT); clearTimeout(showT)
  const c = ensureCard(el.ownerDocument)
  let local = null
  if (o.localCount) { const n = o.localCount(slug); if (n != null) local = { n, label: o.localLabel } }
  c.innerHTML = cardHTML(slug, { book: o.book, db: o.db, meta: o.meta, canLink: !!(o.canLink && o.onLink), local })
  c.classList.toggle('pinned', !!pinned)
  c.style.display = 'block'
  state = { owner, el, slug, pinned: !!pinned }
  place(el)
}

function scheduleHide() {
  clearTimeout(hideT)
  hideT = setTimeout(() => { if (state && !state.pinned) close() }, HIDE_DELAY)
}

/** Close the card (pinned or not). */
export function close() {
  clearTimeout(showT); clearTimeout(hideT)
  if (card) { card.style.display = 'none'; card.classList.remove('pinned') }
  state = null
}

export function isOpen() { return !!(card && card.style.display !== 'none' && state) }
export function isPinned() { return !!(state && state.pinned) }

function bindGlobals(doc) {
  if (globalsBound) return
  globalsBound = true
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close() })
  doc.addEventListener('mousedown', (e) => {
    if (!isOpen()) return
    const t = e.target
    if (card.contains(t)) return
    if (state && state.owner.match(t)) return     // a mention: its click handler decides
    close()
  }, true)
}

/**
 * Attach the card to every mention under root.
 * opts: {
 *   selector   — mention elements (carry data-slug), e.g. 'a.mention' / '.cm-mention'
 *   meta, db, book            — card data (window.__scene)
 *   canLink, onLink(el, slug) — show "Link here" and what it does
 *   localCount(slug), localLabel — optional "N in this chapter"
 *   followLinks — mentions are <a href>: a plain click pins instead of
 *                 navigating; Ctrl/⌘/Shift/middle click still opens the link
 * }
 */
export function attachCodexCard(root, opts) {
  if (!root || !opts || !opts.meta) return null
  const doc = root.ownerDocument
  const owner = {
    opts,
    match(t) { const el = t && t.closest && t.closest(opts.selector); return el && root.contains(el) ? el : null },
  }
  bindGlobals(doc)

  root.addEventListener('mouseover', (e) => {
    const el = owner.match(e.target); if (!el) return
    clearTimeout(hideT)
    if (state && state.pinned) return                   // a pinned card stays put
    if (state && state.el === el) return
    clearTimeout(showT)
    showT = setTimeout(() => show(owner, el, false), SHOW_DELAY)
  })
  root.addEventListener('mouseout', (e) => {
    const el = owner.match(e.target); if (!el) return
    if (e.relatedTarget && el.contains(e.relatedTarget)) return
    clearTimeout(showT)
    if (state && !state.pinned) scheduleHide()
  })
  root.addEventListener('click', (e) => {
    const el = owner.match(e.target); if (!el) return
    if (opts.followLinks) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      e.preventDefault()
    }
    show(owner, el, true)
  })
  return { close }
}
