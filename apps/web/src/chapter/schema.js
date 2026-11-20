// The TipTap extensions of the chapter editor: schema v1 of packages/format/src/rich.mjs (the same node and mark names and attrs), plus `sceneBreak`.
// No React and no DOM here, so the schema can be built (getSchema) and tested under `node --test`. The scene-break view is added in SceneBreakView.jsx.
//
// What is deliberately missing: input rules (the author never types Markdown syntax), nesting in lists (no sink, no Tab), headings outside 2 to 4, and
// any node or mark the converter does not know. A doc attr (lead / trail / eol) lives on each sceneBreak, because each scene is its own Markdown document.
import { Extension, Mark, Node, getSchema, mergeAttributes } from '@tiptap/core';
import { history, redo, undo } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { atSceneEnd, atSceneStart, sceneGuardPlugin } from './scene-guard.js';

export const HEADING_LEVELS = [2, 3, 4];

/** A whole HTML comment: shown as a marker, not as text. */
const isComment = (text) => typeof text === 'string' && /^<!--[\s\S]*-->$/.test(text.trim());

const BLOCKS_WITH_GAP = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'horizontalRule', 'rawBlock'];

const Doc = Node.create({
  name: 'doc',
  topNode: true,
  // a chapter: scene breaks and the blocks of each scene. The order (a break, then at least one block) is kept by the scene guard, not by the grammar,
  // so that "Enter" at the end of a scene still finds `paragraph` as the default block.
  content: '(block | sceneBreak)+',
});

const Text = Node.create({ name: 'text', group: 'inline headingInline' });

const Paragraph = Node.create({
  name: 'paragraph',
  priority: 1000,
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
});

const Heading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'headingInline*', // text, notes, cites and raw inline: no line break inside a heading
  defining: true,
  addAttributes: () => ({ level: { default: 2, rendered: false } }),
  parseHTML: () => HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${node.attrs.level}`, HTMLAttributes, 0],
});

const Blockquote = Node.create({
  name: 'blockquote',
  group: 'block',
  content: 'paragraph',
  defining: true,
  parseHTML: () => [{ tag: 'blockquote' }],
  renderHTML: ({ HTMLAttributes }) => ['blockquote', HTMLAttributes, 0],
});

const BulletList = Node.create({
  name: 'bulletList',
  group: 'block',
  content: 'listItem+',
  addAttributes: () => ({ marker: { default: '-', rendered: false } }),
  parseHTML: () => [{ tag: 'ul' }],
  renderHTML: ({ HTMLAttributes }) => ['ul', HTMLAttributes, 0],
});

const OrderedList = Node.create({
  name: 'orderedList',
  group: 'block',
  content: 'listItem+',
  addAttributes: () => ({ start: { default: 1, rendered: false }, delim: { default: '.', rendered: false } }),
  parseHTML: () => [{ tag: 'ol' }],
  renderHTML: ({ node, HTMLAttributes }) => ['ol', node.attrs.start === 1 ? HTMLAttributes : mergeAttributes(HTMLAttributes, { start: node.attrs.start }), 0],
});

const ListItem = Node.create({
  name: 'listItem',
  content: 'paragraph', // one paragraph, no nesting
  defining: true,
  parseHTML: () => [{ tag: 'li' }],
  renderHTML: ({ HTMLAttributes }) => ['li', HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) };
  },
});

const HorizontalRule = Node.create({
  name: 'horizontalRule',
  group: 'block',
  parseHTML: () => [{ tag: 'hr' }],
  renderHTML: ({ HTMLAttributes }) => ['hr', mergeAttributes(HTMLAttributes, { class: 'sf-inscene-break' })],
});

const HardBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  addAttributes: () => ({ soft: { default: true, rendered: false } }),
  parseHTML: () => [{ tag: 'br' }],
  renderHTML: ({ HTMLAttributes }) => ['br', HTMLAttributes],
  renderText: () => '\n',
});

const AuthorNote = Node.create({
  name: 'authorNote',
  group: 'inline headingInline',
  inline: true,
  atom: true,
  addAttributes: () => ({ text: { default: '', rendered: false } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', { class: 'sf-note', contenteditable: 'false', 'data-author-note': '', title: 'Author note' }, node.attrs.text],
  renderText: () => '',
});

const Cite = Node.create({
  name: 'cite',
  group: 'inline headingInline',
  inline: true,
  atom: true,
  addAttributes: () => ({ key: { default: '', rendered: false } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['span', { class: 'sf-cite', contenteditable: 'false', title: 'Citation' }, `[@${node.attrs.key}]`],
  renderText: ({ node }) => `[@${node.attrs.key}]`,
});

const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline headingInline',
  inline: true,
  atom: true,
  addAttributes: () => ({ text: { default: '', rendered: false } }),
  parseHTML: () => [],
  // an HTML comment (sf:anchor, an opaque comment) is markup, not prose: a small dimmed marker that shows the text on hover, never the <!-- --> itself
  renderHTML: ({ node }) =>
    isComment(node.attrs.text)
      ? ['span', { class: 'sf-raw-inline sf-raw-comment', contenteditable: 'false', title: node.attrs.text, 'aria-label': 'Hidden comment, kept as written' }, '◦']
      : ['span', { class: 'sf-raw-inline', contenteditable: 'false', title: 'Kept as written', 'aria-label': 'Kept as written' }, node.attrs.text],
  renderText: ({ node }) => node.attrs.text,
});

const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  draggable: false,
  addAttributes: () => ({ text: { default: '', rendered: false } }),
  parseHTML: () => [],
  renderHTML: ({ node }) =>
    isComment(node.attrs.text)
      ? ['div', { class: 'sf-raw-block sf-raw-comment', contenteditable: 'false', role: 'group', 'aria-label': 'Hidden comment, kept as written', title: node.attrs.text }, '◦ comment']
      : ['div', { class: 'sf-raw-block', contenteditable: 'false', role: 'group', 'aria-label': 'Kept as written', title: 'Kept as written' }, ['pre', {}, node.attrs.text]],
  renderText: ({ node }) => node.attrs.text,
});

/**
 * The fixed break before each scene. An atom the author cannot select, drag or delete. Its attrs: the scene it opens, its title as loaded, the scene's own
 * document attrs (lead, trail, eol: so each scene writes back exactly as it was read), and whether the scene is shown read-only (`readOnly`, with a `reason`:
 * 'mixed' line endings, 'problem' the file cannot be read, 'raw' shown raw, 'failed' not loaded).
 */
export const SceneBreak = Node.create({
  name: 'sceneBreak',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes: () => ({
    sceneId: { default: null, rendered: false },
    title: { default: '', rendered: false },
    lead: { default: '', rendered: false },
    trail: { default: '', rendered: false },
    eol: { default: 'lf', rendered: false },
    readOnly: { default: false, rendered: false },
    reason: { default: null, rendered: false },
  }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ['div', { class: 'sf-scene-break', contenteditable: 'false', 'data-scene-id': node.attrs.sceneId ?? '' }, node.attrs.title || 'Untitled scene'],
});

const delimAttr = (value) => ({ delim: { default: value, rendered: false } });

const Bold = Mark.create({
  name: 'bold',
  addAttributes: () => delimAttr('**'),
  parseHTML: () => [{ tag: 'strong' }, { tag: 'b' }],
  renderHTML: ({ HTMLAttributes }) => ['strong', HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { 'Mod-b': () => this.editor.commands.toggleMark(this.name) };
  },
});

const Italic = Mark.create({
  name: 'italic',
  addAttributes: () => delimAttr('*'),
  parseHTML: () => [{ tag: 'em' }, { tag: 'i' }],
  renderHTML: ({ HTMLAttributes }) => ['em', HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { 'Mod-i': () => this.editor.commands.toggleMark(this.name) };
  },
});

const Strike = Mark.create({
  name: 'strike',
  parseHTML: () => [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
  renderHTML: ({ HTMLAttributes }) => ['s', HTMLAttributes, 0],
});

const Code = Mark.create({
  name: 'code',
  parseHTML: () => [{ tag: 'code' }],
  renderHTML: ({ HTMLAttributes }) => ['code', HTMLAttributes, 0],
});

const Link = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes: () => ({ href: { default: '' } }),
  parseHTML: () => [{ tag: 'a[href]' }],
  renderHTML: ({ HTMLAttributes }) => ['a', mergeAttributes(HTMLAttributes, { rel: 'noopener noreferrer nofollow' }), 0],
});

const EntityMention = Mark.create({
  name: 'entityMention',
  inclusive: false,
  addAttributes: () => ({ slug: { default: '', rendered: false }, form: { default: 'bare', rendered: false }, state: { default: 'confirmed', rendered: false } }),
  parseHTML: () => [],
  renderHTML: ({ mark }) => ['span', { class: 'sf-mention', 'data-slug': mark.attrs.slug }, 0],
});

/** The exact separator before a block (schema attr `gap`). A block made by the author has none, and gets the standard blank line when written. */
const BlockGap = Extension.create({
  name: 'blockGap',
  addGlobalAttributes: () => [{ types: BLOCKS_WITH_GAP, attributes: { gap: { default: null, rendered: false, keepOnSplit: false } } }],
});

/** Undo and redo (the history is the author's own typing; nothing here loads or reloads text through it). */
const History = Extension.create({
  name: 'history',
  addProseMirrorPlugins: () => [history()],
  addKeyboardShortcuts: () => ({
    'Mod-z': ({ editor }) => undo(editor.state, editor.view.dispatch),
    'Shift-Mod-z': ({ editor }) => redo(editor.state, editor.view.dispatch),
    'Mod-y': ({ editor }) => redo(editor.state, editor.view.dispatch),
  }),
});

/** Keeps the scene breaks fixed: rejects transactions that remove or reorder one, and makes Backspace / Delete at a scene boundary do nothing. */
const SceneGuard = Extension.create({
  name: 'sceneGuard',
  priority: 10000,
  addProseMirrorPlugins: () => [sceneGuardPlugin()],
  addKeyboardShortcuts() {
    const atStart = () => this.editor.state.selection.empty && atSceneStart(this.editor.state);
    const atEnd = () => this.editor.state.selection.empty && atSceneEnd(this.editor.state);
    return {
      Backspace: atStart,
      'Mod-Backspace': atStart,
      'Shift-Backspace': atStart,
      Delete: atEnd,
      'Mod-Delete': atEnd,
      'Shift-Delete': atEnd,
    };
  },
});

/** Shift-Enter: a line break inside the paragraph. Enter inside a quote: a line break too, and a second one at the end leaves the quote. Plus the toolbar's commands. */
const ChapterCommands = Extension.create({
  name: 'chapterCommands',
  priority: 500,
  addKeyboardShortcuts() {
    const softBreak = () => this.editor.commands.insertSoftBreak();
    return {
      'Shift-Enter': () => {
        if (!this.editor.commands.insertSoftBreak()) return this.editor.isActive('heading'); // no line break in a heading: do nothing
        return true;
      },
      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.depth < 2 || $from.node($from.depth - 1).type.name !== 'blockquote') return false;
        const atEnd = $from.parentOffset === $from.parent.content.size;
        const before = $from.nodeBefore;
        if (atEnd && before?.type.name === 'hardBreak') return this.editor.commands.leaveQuote();
        return softBreak();
      },
    };
  },
  addCommands() {
    return {
      insertSoftBreak:
        () =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes.hardBreak;
          const { $from } = state.selection;
          if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return false;
          if (dispatch) tr.replaceSelectionWith(type.create({ soft: true }), false).scrollIntoView();
          return true;
        },
      // the empty last line of a quote becomes a new paragraph after it
      leaveQuote:
        () =>
        ({ state, tr, dispatch }) => {
          const { $from } = state.selection;
          const quoteDepth = $from.depth - 1;
          if (quoteDepth < 1 || $from.node(quoteDepth).type.name !== 'blockquote') return false;
          if (dispatch) {
            tr.delete($from.pos - 1, $from.pos);
            const after = tr.mapping.map($from.after(quoteDepth));
            tr.insert(after, state.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1))).scrollIntoView();
          }
          return true;
        },
      // `***` after the current block, with an empty paragraph to carry on in
      insertInSceneBreak:
        () =>
        ({ state, tr, dispatch }) => {
          const { $to } = state.selection;
          if ($to.depth < 1) return false;
          const end = $to.after(1);
          const rule = state.schema.nodes.horizontalRule.create();
          if (dispatch) {
            tr.insert(end, [rule, state.schema.nodes.paragraph.create()]);
            tr.setSelection(TextSelection.near(tr.doc.resolve(end + rule.nodeSize + 1))).scrollIntoView();
          }
          return true;
        },
      toggleHeadingLevel:
        (level) =>
        ({ commands }) =>
          commands.toggleNode('heading', 'paragraph', { level }),
      toggleQuote:
        () =>
        ({ commands, editor }) => {
          if (editor.isActive('heading')) commands.setNode('paragraph');
          return commands.toggleWrap('blockquote');
        },
      toggleBullets:
        () =>
        ({ commands, editor }) => {
          if (editor.isActive('heading') || editor.isActive('blockquote')) return false;
          return commands.toggleList('bulletList', 'listItem');
        },
      toggleNumbers:
        () =>
        ({ commands, editor }) => {
          if (editor.isActive('heading') || editor.isActive('blockquote')) return false;
          return commands.toggleList('orderedList', 'listItem');
        },
      insertAuthorNote:
        (text) =>
        ({ commands }) =>
          commands.insertContent({ type: 'authorNote', attrs: { text } }),
    };
  },
});

/** Every extension of the chapter editor, in schema order (paragraph is the first block: it is what Enter makes). The scene-break node view is attached by the caller. */
export const chapterExtensions = [
  Doc,
  Text,
  Paragraph,
  Heading,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  HorizontalRule,
  RawBlock,
  HardBreak,
  AuthorNote,
  Cite,
  RawInline,
  SceneBreak,
  Bold,
  Italic,
  Strike,
  Code,
  Link,
  EntityMention,
  BlockGap,
  History,
  SceneGuard,
  ChapterCommands,
];

/** Does this chapter document fit the schema? Null when it does, else the reason. The editor is never given a document it would quietly repair or empty. @param {any} json */
export function validateChapterDoc(json) {
  try {
    getSchema(chapterExtensions).nodeFromJSON(json).check();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
