import { createElement as h } from 'react';

// A schema v1 rich document (packages/format/src/rich.mjs) -> React elements, for reading. Pure: no DOM, no editor, no raw HTML.

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.{1,2}\/)/i;
const WEB_HREF = /^https?:/i;

/** One text node: its marks wrapped around it, innermost first (mention, code, strike, italic, bold, link). */
function renderText(node, key) {
  let el = node.text;
  const marks = node.marks ?? [];
  const find = (type) => marks.find((m) => m.type === type);
  const mention = find('entityMention');
  if (mention) el = h('span', { className: 'mention', title: mention.attrs?.slug }, el);
  if (find('code')) el = h('code', null, el);
  if (find('strike')) el = h('s', null, el);
  if (find('italic')) el = h('em', null, el);
  if (find('bold')) el = h('strong', null, el);
  const link = find('link');
  if (link) {
    const href = link.attrs?.href ?? '';
    if (SAFE_HREF.test(href)) {
      const web = WEB_HREF.test(href);
      el = h('a', { href, ...(web ? { target: '_blank' } : {}), rel: 'noopener noreferrer' }, el);
    }
  }
  return typeof el === 'string' ? el : { ...el, key };
}

function renderInline(nodes, opts) {
  const out = [];
  (nodes ?? []).forEach((n, i) => {
    switch (n.type) {
      case 'text':
        if (n.text) out.push(renderText(n, i));
        break;
      case 'hardBreak':
        out.push(n.attrs?.soft === false ? h('br', { key: i }) : ' ');
        break;
      case 'authorNote':
        if (opts.showNotes) out.push(h('span', { key: i, className: 'rich-note' }, n.attrs?.text ?? ''));
        break;
      case 'cite':
        out.push(h('span', { key: i, className: 'rich-cite' }, `[${n.attrs?.key ?? ''}]`));
        break;
      case 'rawInline':
        // an HTML comment (sf:anchor, an opaque comment) is markup, not prose: shown dimmed with the notes, hidden otherwise (as withoutComments did)
        if (isComment(n.attrs?.text)) {
          if (opts.showNotes) out.push(h('span', { key: i, className: 'rich-note' }, n.attrs.text));
        } else out.push(h('span', { key: i, className: 'rich-raw' }, n.attrs?.text ?? ''));
        break;
      default:
        break;
    }
  });
  return out;
}

const isComment = (text) => typeof text === 'string' && /^<!--[\s\S]*-->$/.test(text.trim());

const isBlank = (children) => children.every((c) => typeof c === 'string' && c.trim() === '');

function renderBlock(b, key, opts) {
  switch (b.type) {
    case 'paragraph': {
      const kids = renderInline(b.content, opts);
      return kids.length === 0 || isBlank(kids) ? null : h('p', { key }, ...kids);
    }
    case 'heading': {
      const level = Math.min(4, Math.max(2, b.attrs?.level ?? 2));
      return h(`h${level}`, { key }, ...renderInline(b.content, opts));
    }
    case 'blockquote':
      return h('blockquote', { key }, ...(b.content ?? []).map((c, i) => renderBlock(c, i, opts)).filter(Boolean));
    case 'bulletList':
    case 'orderedList': {
      const items = (b.content ?? []).map((item, i) =>
        h('li', { key: i }, ...(item.content ?? []).flatMap((c) => (c.type === 'paragraph' ? renderInline(c.content, opts) : [])),
      ));
      if (b.type === 'bulletList') return h('ul', { key }, ...items);
      const start = b.attrs?.start ?? 1;
      return h('ol', { key, ...(start !== 1 ? { start } : {}) }, ...items);
    }
    case 'horizontalRule':
      return h('hr', { key, className: 'read-break' });
    case 'rawBlock':
      if (isComment(b.attrs?.text)) return opts.showNotes ? h('pre', { key, className: 'rich-raw rich-note' }, b.attrs.text) : null;
      return h('pre', { key, className: 'rich-raw' }, b.attrs?.text ?? '');
    default:
      return null;
  }
}

/**
 * @param {any} doc a schema v1 document
 * @param {{ showNotes?: boolean }} [opts] showNotes: show author notes (dimmed); off by default
 * @returns {import('react').ReactElement[]} the blocks, as elements (hand them to a wrapper element)
 */
export function renderRich(doc, opts = {}) {
  return (doc?.content ?? []).map((b, i) => renderBlock(b, i, { showNotes: Boolean(opts.showNotes) })).filter(Boolean);
}
