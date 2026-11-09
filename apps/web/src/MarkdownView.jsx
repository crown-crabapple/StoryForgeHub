import { GFM, parser as baseParser } from '@lezer/markdown';
import { createElement as h } from 'react';
import { Link } from './router.jsx';

// Read-only Markdown for written text that is not scene prose (a Codex entry's sections): paragraphs, ### headings, lists (nested, numbered, task),
// block quotes, rules, code, tables, **strong**, *emphasis*, ~~strikethrough~~ and links. Parsed with @lezer/markdown (CommonMark plus the GFM tables,
// task lists, strikethrough and autolinks) and drawn as React elements, never as HTML: raw HTML in the text shows as text. The stored text is never changed.
//
// Links follow the rules of the rest of the app: a [[slug|Label]] shows its label and opens the entry when `resolve` or `linkOf` knows it; an http(s) link
// opens in a new tab (rel="noopener noreferrer") and is never fetched; any other target is shown as its label only. Images are never loaded: their alt text shows.
// HTML comments stay visible and dimmed, as in ProseView.

const WIKILINK = {
  defineNodes: ['WikiLink'],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          const c = cx.char(i);
          if (c === 10 /* \n */ || c === 91) return -1;
          if (c === 93 /* ] */) return cx.char(i + 1) === 93 && i > pos + 2 ? cx.addElement(cx.elt('WikiLink', pos, i + 2)) : -1;
        }
        return -1;
      },
    },
  ],
};

const parser = baseParser.configure([GFM, WIKILINK]);

const SKIP = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker', 'TableDelimiter', 'CodeInfo', 'LinkLabel', 'LinkTitle', 'LinkReference']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };

/** The text of an `&...;` entity, or the entity as written when it is not one we know. @param {string} raw */
function entity(raw) {
  const name = raw.slice(1, -1);
  const num = /^#(x[0-9a-f]+|\d+)$/i.exec(name);
  if (num) {
    const code = num[1][0].toLowerCase() === 'x' ? parseInt(num[1].slice(1), 16) : parseInt(num[1], 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  }
  return ENTITIES[name] ?? raw;
}

/** The children of a syntax node, in order. */
function kids(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

/** The target of `[label](target "title")`: its URL child, or null (a reference link). */
function linkTarget(node, src) {
  const url = node.getChild('URL');
  return url ? src.slice(url.from, url.to) : null;
}

/** An http(s) URL with a host, or null. @param {string | null} raw */
function externalUrl(raw) {
  if (!raw) return null;
  const t = raw.trim().replace(/^<|>$/g, '');
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' ? u.href : null;
  } catch {
    return null;
  }
}

function makeRenderer(src, { bookHref, resolve, linkOf, headingBase }) {
  let key = 0;
  const k = () => key++;

  /** Inline content of `node` between `from` and `to`: source text in the gaps, rendered children for the rest. */
  function inline(node, from = node.from, to = node.to) {
    const out = [];
    let at = from;
    for (const c of kids(node)) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > at) out.push(src.slice(at, c.from));
      const r = inlineNode(c);
      if (r !== null) out.push(r);
      at = c.to;
    }
    if (at < to) out.push(src.slice(at, to));
    return out;
  }

  function inlineNode(n) {
    if (SKIP.has(n.name)) return null;
    const raw = src.slice(n.from, n.to);
    switch (n.name) {
      case 'Emphasis':
        return h('em', { key: k() }, inline(n));
      case 'StrongEmphasis':
        return h('strong', { key: k() }, inline(n));
      case 'Strikethrough':
        return h('del', { key: k() }, inline(n));
      case 'InlineCode': {
        const marks = n.getChildren('CodeMark');
        const inner = marks.length === 2 ? src.slice(marks[0].to, marks[1].from) : raw;
        return h('code', { key: k(), className: 'prose-code-inline' }, inner.replace(/^ (.*) $/s, '$1'));
      }
      case 'Escape':
        return raw.slice(1);
      case 'Entity':
        return entity(raw);
      case 'HardBreak':
        return h('br', { key: k() });
      case 'Comment':
      case 'HTMLTag':
      case 'ProcessingInstruction':
        return h('span', { key: k(), className: n.name === 'Comment' ? 'prose-comment' : undefined }, raw);
      case 'WikiLink':
        return wikiLink(raw.slice(2, -2));
      case 'URL': // a bare autolink (GFM)
      case 'Autolink': {
        const url = externalUrl(n.name === 'Autolink' ? raw.slice(1, -1) : raw);
        return url ? external(url, url) : raw;
      }
      case 'Link':
      case 'Image': {
        const marks = n.getChildren('LinkMark');
        const open = n.name === 'Image' ? 2 : 1;
        const labelEnd = marks.find((m) => src[m.from] === ']');
        const label = labelEnd ? inline(n, n.from + open, labelEnd.from) : raw;
        if (n.name === 'Image') return h('span', { key: k(), className: 'md-image', title: 'Images are not shown here' }, label);
        const url = externalUrl(linkTarget(n, src));
        return url ? external(url, label) : h('span', { key: k() }, label);
      }
      default:
        return kids(n).length > 0 ? h('span', { key: k() }, inline(n)) : raw;
    }
  }

  function external(href, label) {
    return h('a', { key: k(), className: 'md-link', href, target: '_blank', rel: 'noopener noreferrer' }, label);
  }

  function wikiLink(body) {
    const bar = body.indexOf('|');
    const slug = (bar === -1 ? body : body.slice(0, bar)).trim();
    const own = bar === -1 ? '' : body.slice(bar + 1).trim();
    const target = resolve?.(slug) ?? null;
    const cross = target ? null : (linkOf?.(slug) ?? null);
    const href = target ? bookHref(target.id) : (cross?.href ?? null);
    const text = own || target?.name || cross?.name || slug;
    return href
      ? h(Link, { key: k(), to: href, className: 'codex-link', title: slug }, text)
      : h('span', { key: k(), className: 'prose-link', title: slug }, text);
  }

  function blocks(node) {
    return kids(node)
      .map(block)
      .filter((b) => b !== null);
  }

  function block(n) {
    if (SKIP.has(n.name)) return null; // list and quote marks: the element drawn for the list or quote stands for them
    switch (n.name) {
      case 'Paragraph':
        return h('p', { key: k() }, inline(n));
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6':
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const level = Number(n.name.slice(-1));
        const tag = `h${Math.min(6, level - 1 + headingBase)}`;
        // the text between the opening #s (or the start) and the closing #s or the setext underline, without the spaces around it
        const marks = n.getChildren('HeaderMark');
        const atx = n.name.startsWith('ATX');
        let from = atx && marks.length > 0 ? marks[0].to : n.from;
        let to = atx ? (marks.length > 1 ? marks[marks.length - 1].from : n.to) : (marks[0]?.from ?? n.to);
        while (from < to && /\s/.test(src[from])) from++;
        while (to > from && /\s/.test(src[to - 1])) to--;
        return h(tag, { key: k(), className: 'md-heading' }, inline(n, from, to));
      }
      case 'BulletList':
        return h('ul', { key: k() }, blocks(n));
      case 'OrderedList': {
        const mark = n.firstChild?.getChild('ListMark');
        const start = mark ? parseInt(src.slice(mark.from, mark.to), 10) : 1;
        return h('ol', { key: k(), start: start !== 1 ? start : undefined }, blocks(n));
      }
      case 'ListItem':
        return h('li', { key: k() }, blocks(n));
      case 'Task': {
        const marker = n.getChild('TaskMarker');
        const done = marker ? /x/i.test(src.slice(marker.from, marker.to)) : false;
        return h(
          'p',
          { key: k(), className: 'md-task' },
          h('input', { type: 'checkbox', checked: done, disabled: true, readOnly: true, 'aria-label': done ? 'Done' : 'Not done' }),
          inline(n, marker ? marker.to : n.from),
        );
      }
      case 'Blockquote':
        return h('blockquote', { key: k() }, blocks(n));
      case 'HorizontalRule':
        return h('hr', { key: k() });
      case 'FencedCode':
      case 'CodeBlock': {
        const text = n.getChildren('CodeText').map((c) => src.slice(c.from, c.to));
        const body = n.name === 'FencedCode' ? text.join('') : src.slice(n.from, n.to).replace(/^( {4}|\t)/gm, '');
        return h('pre', { key: k(), className: 'prose-code' }, h('code', null, body));
      }
      case 'Table': {
        const head = n.getChild('TableHeader');
        const rows = n.getChildren('TableRow');
        const cells = (row, tag) => row.getChildren('TableCell').map((c) => h(tag, { key: k() }, inline(c)));
        return h(
          'div',
          { key: k(), className: 'md-table-wrap' },
          h('table', { className: 'md-table' }, head && h('thead', null, h('tr', null, cells(head, 'th'))), rows.length > 0 && h('tbody', null, rows.map((r) => h('tr', { key: k() }, cells(r, 'td'))))),
        );
      }
      case 'CommentBlock':
        return h('p', { key: k(), className: 'prose-comment' }, src.slice(n.from, n.to));
      case 'HTMLBlock':
      case 'ProcessingInstructionBlock':
        return h('p', { key: k() }, src.slice(n.from, n.to));
      case 'LinkReference':
        return null;
      default:
        return kids(n).length > 0 ? h('div', { key: k() }, blocks(n)) : h('p', { key: k() }, src.slice(n.from, n.to));
    }
  }

  return blocks;
}

/**
 * Markdown, drawn read-only (see the notes at the top of this file).
 * @param {{ source: string, resolve?: (ref: string) => { id: string, name?: string | null } | null,
 *   linkOf?: (ref: string) => { href: string, name?: string | null } | null, entryHref?: (entryId: string) => string, headingBase?: number, className?: string }} props
 *   `entryHref(id)`: where a [[link]] that `resolve` knows leads; `headingBase`: the heading level a `#` heading is drawn at (default 2), so a `###` heading
 *   is an h4, one level below the h3 of a Codex section.
 */
export function MarkdownView({ source, resolve, linkOf, entryHref, headingBase = 2, className = '' }) {
  const src = String(source ?? '');
  const tree = parser.parse(src);
  const render = makeRenderer(src, { bookHref: entryHref ?? (() => null), resolve: entryHref ? resolve : null, linkOf, headingBase });
  return <div className={`md ${className}`.trim()}>{render(tree.topNode)}</div>;
}
