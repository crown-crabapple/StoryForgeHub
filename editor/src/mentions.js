/*
 * mentions.js — the live mention highlighter (P5), split out of main.js so the
 * test suite can run it without booting the page bundle.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/*
 * Live mention highlighting (P5): decorate recognized entry names/aliases in
 * prose text — longest-match-first, word-boundary, one highlight per span.
 * Decorations only: nothing is written to the Markdown. Clicking a highlight
 * pins the Codex card (UI plan Phase 1); turning it into a [[wiki-link]] is the
 * card's explicit "Link here" button (linkMention in codex-card.js), never a
 * bare click.
 */
const mentionKey = new PluginKey('codexMentions')

export function buildMentionExtension(targets) {
  const compiled = targets.map((t) => ({
    slug: t.slug,
    re: new RegExp('(?<!\\w)' + reEscape(t.phrase) + '(?!\\w)', 'giu'),
  }))

  return Extension.create({
    name: 'codexMentions',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: mentionKey,
        props: {
          decorations(state) {
            const decos = []
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return
              const text = node.text
              const used = new Array(text.length).fill(false)
              const overlaps = (s, e) => { for (let k = s; k < e; k++) if (used[k]) return true; return false }
              const mark = (s, e) => { for (let k = s; k < e; k++) used[k] = true }
              for (const c of compiled) {
                c.re.lastIndex = 0
                let m
                while ((m = c.re.exec(text)) !== null) {
                  const s = m.index, e = s + m[0].length
                  if (e === s) { c.re.lastIndex++; continue }
                  if (overlaps(s, e)) continue
                  mark(s, e)
                  decos.push(Decoration.inline(pos + s, pos + e, {
                    class: 'cm-mention',
                    'data-slug': c.slug,
                  }))
                }
              }
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      })]
    },
  })
}
